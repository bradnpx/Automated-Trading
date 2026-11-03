import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { after, before, mock, test, type TestContext } from "node:test";

import type {
  Bar,
  RemainderProtection,
  TradeLifecycleProfile,
} from "@my-platform/types";
import { MASTER_WATCHLIST } from "./config/config.js";
import type {
  ProtectionBrokerOrder,
  ProtectionExecutionResult,
  ProtectionSnapshot,
} from "./executor.js";
import { Portfolio } from "./models/portfolio.js";
import { TradeLifecycleStore } from "./models/tradeLifecycleStore.js";
import { StreamPipeline } from "./pipeline.js";
import { RemainderProtectionController } from "./remainderProtection.js";

// Real StreamPipeline + real risk controller, but fake streams and broker only.
// The engine index is never imported. No services, real intervals or orders run.
// Test cleanup removes private files, never manufactures forced closing fills.
const SYMBOL = "AAPL";
const ENTRY = 335;
const ACTIVATION = 342.83;
const FIXED_NOW = "2026-11-03T15:00:30.000Z";
const PROFILE: TradeLifecycleProfile = {
  strategy: "bullFlagMomentum",
  takeProfitPct: 2,
  stopLossPct: 2,
  trailingStopLoss: true,
};
type ControllerArguments = ConstructorParameters<
  typeof RemainderProtectionController
>;
type ProtectionExecutor = ControllerArguments[2];
type PositionRiskState = ControllerArguments[1];
type MarketTrade = {
  Symbol?: string;
  Price?: number;
  Size?: number;
  Timestamp?: string;
};
type Signal = {
  symbol: string;
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  reason: string;
};
type Strategy = { evaluateStrategy(bar: Bar): Promise<Signal> };

class FakeMarketStream {
  connected?: () => void;
  stockTrade?: (trade: MarketTrade) => void;
  stockBar?: (bar: unknown) => void;
  readonly subscribedBars: string[] = [];
  readonly subscribedTrades: string[] = [];
  onConnect(callback: () => void): void {
    this.connected = callback;
  }
  onError(_callback: (error: unknown) => void): void {}
  onStockTrade(callback: (trade: MarketTrade) => void): void {
    this.stockTrade = callback;
  }
  onStockBar(callback: (bar: unknown) => void): void {
    this.stockBar = callback;
  }
  subscribeForBars(symbols: string[]): void {
    this.subscribedBars.push(...symbols);
  }
  subscribeForTrades(symbols: string[]): void {
    this.subscribedTrades.push(...symbols);
  }
  connect(): void {}
  emit(trade: MarketTrade): void {
    assert.ok(this.stockTrade);
    this.stockTrade(trade);
  }
  emitBar(bar: unknown): void {
    assert.ok(this.stockBar);
    this.stockBar(bar);
  }
}

class MockProtectionExecutor implements ProtectionExecutor {
  readonly orders = new Map<string, ProtectionBrokerOrder>();
  readonly submissions: Array<{
    symbol: string;
    clientOrderId: string;
    requestedQuantity?: number;
  }> = [];
  quantity = 10;
  latestPrice: ProtectionSnapshot["price"];
  beforeSubmit?: () => Promise<void>;
  constructor(private readonly now: () => Date) {
    this.latestPrice = { price: ACTIVATION, timestamp: now().toISOString() };
  }
  async getHalfExitQuantity(_symbol: string, total: number): Promise<number> {
    return total / 2;
  }
  async getProtectionOrder(
    clientOrderId: string,
  ): Promise<ProtectionBrokerOrder | undefined> {
    const order = this.orders.get(clientOrderId);
    return order && structuredClone(order);
  }
  async getProtectionSnapshot(symbol: string): Promise<ProtectionSnapshot> {
    assert.equal(symbol, SYMBOL);
    return {
      position:
        this.quantity > 0
          ? {
              qty: this.quantity,
              availableQuantity: this.quantity,
              entryPrice: ENTRY,
            }
          : undefined,
      orders: [...this.orders.values()]
        .filter((order) => order.status !== "filled")
        .map((order) => structuredClone(order)),
      price: this.latestPrice && structuredClone(this.latestPrice),
    };
  }
  async cancelProtectionOrder(orderId: string): Promise<void> {
    const order = [...this.orders.values()].find(
      (candidate) => candidate.id === orderId,
    );
    assert.ok(order);
    order.status = "canceled";
  }
  async submitProtectionExit(
    symbol: string,
    clientOrderId: string,
    requestedQuantity?: number,
  ): Promise<ProtectionExecutionResult> {
    await this.beforeSubmit?.();
    this.submissions.push({ symbol, clientOrderId, requestedQuantity });
    const order: ProtectionBrokerOrder = {
      id: `pipeline-protection-${this.submissions.length}`,
      symbol,
      client_order_id: clientOrderId,
      side: "sell",
      type: "market",
      status: "new",
      qty: String(requestedQuantity ?? this.quantity),
      filled_qty: "0",
      submitted_at: this.now().toISOString(),
    };
    this.orders.set(clientOrderId, order);
    return { kind: "submitted", order: structuredClone(order) };
  }
}

// Portfolio mark ordering is production code, not a fake that implements the
// desired timestamp behavior. Only broker positions/execution are simulated.
class RiskPositions implements PositionRiskState {
  portfolio?: Portfolio;
  readonly pending = new Set<string>();
  readonly pendingBuys = new Set<string>();
  readonly states = new Map<string, RemainderProtection>();
  readonly marks: Array<{
    symbol: string;
    price: number;
    timestamp: string;
    accepted: boolean;
  }> = [];
  readonly events: string[] = [];
  readonly blocked = new Set<string>();
  allowBuy = false;
  hasPosition(symbol: string): boolean {
    return this.portfolio?.hasPosition(symbol) ?? false;
  }
  getPositionSymbols(): string[] {
    return this.portfolio?.getSymbols() ?? [];
  }
  getPositions() {
    return this.portfolio?.getPositions() ?? [];
  }
  updatePositionMark(
    symbol: string,
    price: number,
    timestamp: string,
  ): boolean {
    this.events.push(`mark:${symbol}:${price}`);
    const accepted =
      this.portfolio?.updateMark(symbol, price, timestamp) ?? false;
    this.marks.push({ symbol, price, timestamp, accepted });
    return accepted;
  }
  hasPendingExit(symbol: string): boolean {
    return this.pending.has(symbol) || Boolean(this.states.get(symbol)?.exit);
  }
  markPendingExit(symbol: string): void {
    this.pending.add(symbol);
  }
  clearPendingExit(symbol: string): void {
    this.pending.delete(symbol);
  }
  setRemainderProtection(symbol: string, state: RemainderProtection): void {
    this.states.set(symbol, structuredClone(state));
  }
  blockNewExposure(symbol: string): void {
    this.blocked.add(symbol);
  }
  async syncPositions(): Promise<unknown> {
    return this.getPositions();
  }
  checkExitConditions() {
    return { shouldExit: false, action: "none", reason: "" };
  }
  canOpenPosition(symbol: string): boolean {
    return (
      this.allowBuy &&
      !this.hasPosition(symbol) &&
      !this.pendingBuys.has(symbol)
    );
  }
  markPendingBuy(symbol: string): void {
    this.pendingBuys.add(symbol);
  }
  clearPendingBuy(symbol: string): void {
    this.pendingBuys.delete(symbol);
  }
  async getOrFetchEquity(): Promise<number> {
    return 10_000;
  }
  reset(): void {
    this.pending.clear();
    this.pendingBuys.clear();
    this.states.clear();
    this.marks.length = 0;
    this.events.length = 0;
    this.blocked.clear();
    this.allowBuy = false;
  }
}

// Exactly ONE pipeline initialization in this file. Narrow private-field cast
// resets only the per-case dependencies/live cache; never weaken types with any
// or repeatedly reset/re-register the static listener initializer.
type PipelineTestState = {
  liveBars: Map<string, unknown>;
  secondLevelEvaluationInFlight: boolean;
  protection?: RemainderProtectionController;
  lifecycleStore?: TradeLifecycleStore;
};
const market = new FakeMarketStream();
const positions = new RiskPositions();
const engineState = { isKilled: false };
const strategies = new Map<string, Strategy>();
const buys: Array<{ symbol: string; quantity: number }> = [];
const legacyCloses: string[] = [];
const broadcasts: Array<{ symbol: string; price: number }> = [];
const secondCallbacks: Array<() => void> = [];
const savedWatchlist = new Map(MASTER_WATCHLIST);
let directory: string;
let pipeline: StreamPipeline;
let networkAttempts = 0;
let counter = 0;

before(async () => {
  const denied = (): never => {
    networkAttempts += 1;
    throw new Error("Network is forbidden in pipeline protection tests");
  };
  mock.method(http, "request", denied);
  mock.method(http, "get", denied);
  mock.method(https, "request", denied);
  mock.method(https, "get", denied);
  mock.method(globalThis, "fetch", denied);
  mock.method(
    globalThis,
    "setInterval",
    (callback: () => void, delay?: number) => {
      assert.equal(delay, 1_000);
      secondCallbacks.push(callback);
      return 0 as unknown as ReturnType<typeof setInterval>;
    },
  );
  directory = await mkdtemp(
    path.join(os.tmpdir(), "protection-pipeline-test-"),
  );
  const tradeStream = {
    onConnect(_callback: () => void) {},
    onOrderUpdate(_callback: (data: unknown) => void) {},
    subscribe(_channels: string[]) {},
    connect() {},
  };
  pipeline = new StreamPipeline(
    { data_stream_v2: market, trade_ws: tradeStream },
    positions,
    {
      async placeBuyOrder(symbol: string, quantity: number) {
        buys.push({ symbol, quantity });
        return { id: "fake-buy" };
      },
      async closePosition(symbol: string) {
        legacyCloses.push(symbol);
        return { id: "forbidden-legacy-close" };
      },
    },
    {
      broadcastBar(symbol: string, price: number) {
        broadcasts.push({ symbol, price });
      },
      broadcastSignal(_signal: Signal) {},
      broadcastStrategyEvaluation() {},
      broadcastPortfolio() {},
    },
    undefined,
    strategies,
    engineState,
  );
  pipeline.initialize();
  assert.equal(secondCallbacks.length, 1);
});
after(async () => {
  mock.restoreAll();
  MASTER_WATCHLIST.clear();
  for (const [symbol, item] of savedWatchlist)
    MASTER_WATCHLIST.set(symbol, item);
  await rm(directory, { recursive: true, force: true });
  assert.equal(
    networkAttempts,
    0,
    "pipeline tests must never attempt real network calls",
  );
});

const pause = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 5));
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (predicate()) return;
    await pause();
  }
  assert.fail("Finite fake stream/actor work did not settle");
}
async function drain(controller: RemainderProtectionController): Promise<void> {
  let previous = "";
  let stable = 0;
  for (let turn = 0; turn < 100; turn += 1) {
    await controller.flush();
    await pause();
    const current = JSON.stringify(controller.getStatus());
    stable = current === previous ? stable + 1 : 0;
    previous = current;
    if (
      stable >= 3 &&
      !controller.getStatus().protections.some((item) => item.inFlight) &&
      !(pipeline as unknown as PipelineTestState).secondLevelEvaluationInFlight
    )
      return;
  }
  assert.fail("Finite controller/pipeline work did not settle");
}
function state(controller: RemainderProtectionController): RemainderProtection {
  const current = controller
    .getStatus()
    .protections.find((item) => item.symbol === SYMBOL);
  assert.ok(current);
  return structuredClone(current);
}
function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(t: TestContext, seed = true, initialize = true) {
  engineState.isKilled = false;
  MASTER_WATCHLIST.clear();
  strategies.clear();
  positions.reset();
  buys.length = 0;
  legacyCloses.length = 0;
  broadcasts.length = 0;
  const internal = pipeline as unknown as PipelineTestState;
  internal.liveBars.clear();
  internal.secondLevelEvaluationInFlight = false;
  const caseDirectory = path.join(directory, `case-${counter++}`);
  const ledgerPath = path.join(caseDirectory, "ledger.json");
  const store = new TradeLifecycleStore(ledgerPath);
  let clock = Date.parse(FIXED_NOW);
  const now = (): Date => new Date(clock);
  const executor = new MockProtectionExecutor(now);
  const portfolio = new Portfolio(path.join(caseDirectory, "portfolio.json"));
  positions.portfolio = portfolio;
  await portfolio.syncTrades(
    seed
      ? [
          {
            symbol: SYMBOL,
            qty: "10",
            avg_entry_price: String(ENTRY),
            current_price: String(ACTIVATION),
          },
        ]
      : [],
  );
  await portfolio.saveTradesToLocal();
  const controller = new RemainderProtectionController(
    store,
    positions,
    executor,
    { broadcastSignal() {} },
    undefined,
    now,
    () => !engineState.isKilled,
  );
  internal.protection = controller;
  internal.lifecycleStore = store;
  if (seed) {
    await store.recordFill({
      executionId: "entry",
      orderId: "entry-order",
      orderType: "market",
      side: "buy",
      symbol: SYMBOL,
      price: ENTRY,
      quantity: 20,
      filledAt: FIXED_NOW,
      profile: PROFILE,
    });
    await store.recordFill({
      executionId: "half",
      orderId: "half-order",
      orderType: "market",
      side: "sell",
      symbol: SYMBOL,
      price: ACTIVATION,
      quantity: 10,
      filledAt: FIXED_NOW,
      profile: PROFILE,
      reason: "TAKE_PROFIT_HALF",
    });
    await store.saveProtection(SYMBOL, {
      version: 1,
      phase: "protected-remainder",
      revision: 10,
      entryPrice: ENTRY,
      trailingDistance: ACTIVATION - ENTRY,
      highWaterMark: ACTIVATION,
      effectiveStop: ENTRY,
      halfExit: {
        clientOrderId: "half-client",
        orderId: "half-order",
        targetQuantity: 10,
        filledQuantity: 10,
        orderFilledQuantity: 10,
        completed: true,
      },
      activatedAt: FIXED_NOW,
      activationSource: "trade",
      lastPriceAt: FIXED_NOW,
    });
    executor.orders.set("half-client", {
      id: "half-order",
      symbol: SYMBOL,
      client_order_id: "half-client",
      side: "sell",
      type: "market",
      status: "filled",
      qty: "10",
      filled_qty: "10",
      filled_avg_price: String(ACTIVATION),
      filled_at: FIXED_NOW,
    });
  }
  if (initialize) await controller.initialize();
  t.after(async () => {
    engineState.isKilled = true;
    await drain(controller);
    await portfolio.saveTradesToLocal();
    // No forced lifecycle closures/cleanup trades: preserve observed risk state.
    await rm(caseDirectory, { recursive: true, force: true });
  });
  return {
    controller,
    executor,
    portfolio,
    store,
    ledgerPath,
    now,
    emit(price: number, symbol = SYMBOL): void {
      clock += 1;
      if (symbol === SYMBOL)
        executor.latestPrice = { price, timestamp: now().toISOString() };
      market.emit({
        Symbol: symbol,
        Price: price,
        Size: 1,
        Timestamp: now().toISOString(),
      });
    },
  };
}

test("every ticker reaches onPrice synchronously before the one-second callback, including unwatched open AAPL", async (t) => {
  const f = await fixture(t);
  assert.equal(MASTER_WATCHLIST.has(SYMBOL), false);
  assert.equal(positions.hasPosition(SYMBOL), true);
  market.connected?.();
  assert.ok(market.subscribedBars.includes(SYMBOL));
  assert.ok(market.subscribedTrades.includes(SYMBOL));
  const realOnPrice = f.controller.onPrice.bind(f.controller);
  const onPrice = t.mock.method(
    f.controller,
    "onPrice",
    (symbol: string, price: number, timestamp: string) => {
      positions.events.push(`risk:${symbol}:${price}`);
      return realOnPrice(symbol, price, timestamp);
    },
  );
  const tick = t.mock.method(f.controller, "tick");
  f.emit(355);
  f.emit(347);
  const breachedId = state(f.controller).exit?.clientOrderId;
  assert.ok(
    breachedId,
    "the breach must latch inside the stream callback, not on the timer",
  );
  f.emit(350);
  f.emit(101, "MSFT");
  assert.equal(onPrice.mock.callCount(), 4);
  assert.equal(tick.mock.callCount(), 0);
  assert.deepEqual(positions.events, [
    "risk:AAPL:355",
    "mark:AAPL:355",
    "risk:AAPL:347",
    "mark:AAPL:347",
    "risk:AAPL:350",
    "mark:AAPL:350",
    "risk:MSFT:101",
    "mark:MSFT:101",
  ]);
  assert.equal(state(f.controller).exit?.clientOrderId, breachedId);
  assert.equal(state(f.controller).exit?.reason, "TRAILING_STOP_LOSS");
  secondCallbacks[0]!();
  await drain(f.controller);
  assert.equal(tick.mock.callCount(), 1);
  assert.equal(f.executor.submissions.length, 1);
  assert.equal(f.executor.submissions[0]?.clientOrderId, breachedId);
  assert.equal(legacyCloses.length, 0);
  assert.equal(
    (await new TradeLifecycleStore(f.ledgerPath).getOpenLifecycle(SYMBOL))
      ?.remainingQuantity,
    10,
  );
});

test("stream rejects invalid, missing, stale, future, and out-of-order trades without marks or exit intents", async (t) => {
  const f = await fixture(t);
  f.emit(355);
  await drain(f.controller);
  const before = state(f.controller);
  const marks = positions.marks.length;
  const broadcastCount = broadcasts.length;
  const rejected: MarketTrade[] = [
    { Symbol: SYMBOL, Price: Number.NaN, Timestamp: f.now().toISOString() },
    { Symbol: SYMBOL, Price: 0, Timestamp: f.now().toISOString() },
    { Symbol: SYMBOL, Price: -1, Timestamp: f.now().toISOString() },
    { Symbol: SYMBOL, Price: ENTRY - 1 },
    { Symbol: SYMBOL, Price: ENTRY - 1, Timestamp: "invalid" },
    {
      Symbol: SYMBOL,
      Price: ENTRY - 1,
      Timestamp: new Date(f.now().getTime() - 10_001).toISOString(),
    },
    {
      Symbol: SYMBOL,
      Price: ENTRY - 1,
      Timestamp: new Date(f.now().getTime() + 1_001).toISOString(),
    },
    { Symbol: SYMBOL, Price: ENTRY - 1, Timestamp: FIXED_NOW },
  ];
  for (const trade of rejected) market.emit(trade);
  assert.equal(positions.marks.length, marks);
  assert.equal(broadcasts.length, broadcastCount);
  assert.equal(state(f.controller).exit, undefined);
  assert.equal(state(f.controller).lastPriceAt, before.lastPriceAt);
  assert.equal(state(f.controller).effectiveStop, before.effectiveStop);
  assert.equal(state(f.controller).highWaterMark, before.highWaterMark);
  assert.equal(f.portfolio.getPosition(SYMBOL)?.current_price, "355");
  secondCallbacks[0]!();
  await drain(f.controller);
  assert.equal(f.executor.submissions.length, 0);
});

test("a completed minute cannot overwrite a newer trade mark or loosen the real controller floor", async (t) => {
  const f = await fixture(t);
  f.emit(355);
  await drain(f.controller);
  const latest = f.portfolio.getPosition(SYMBOL);
  const before = state(f.controller);
  market.emitBar({
    Symbol: SYMBOL,
    Timestamp: "2026-11-03T15:00:00.000Z",
    OpenPrice: 342,
    HighPrice: 343,
    LowPrice: 341,
    ClosePrice: 342,
    Volume: 50,
  });
  await waitUntil(() => positions.marks.length === 2);
  await drain(f.controller);
  const completedAttempt = positions.marks[1];
  assert.equal(completedAttempt?.timestamp, "2026-11-03T15:00:00.000Z");
  assert.equal(completedAttempt?.accepted, false);
  assert.equal(f.portfolio.getPosition(SYMBOL)?.current_price, "355");
  assert.equal(f.portfolio.getPosition(SYMBOL)?.marked_at, latest?.marked_at);
  assert.equal(state(f.controller).highWaterMark, before.highWaterMark);
  assert.equal(state(f.controller).effectiveStop, before.effectiveStop);
  assert.equal(state(f.controller).exit, undefined);
  assert.equal(f.executor.submissions.length, 0);
});

test("strategy SELL, manual controlled close and tick breach share one actor intent in both race orderings", async (t) => {
  for (const ordering of ["tick-first", "strategy-first"] as const) {
    const f = await fixture(t);
    MASTER_WATCHLIST.set(SYMBOL, {
      symbol: SYMBOL,
      strategy: PROFILE.strategy,
    });
    const strategyGate = gate();
    const brokerGate = gate();
    // Always release gates on failure; no hanging actor work or cleanup orders.
    t.after(() => {
      strategyGate.release();
      brokerGate.release();
    });
    let evaluationEntered = false;
    let submissionEntered = false;
    strategies.set(SYMBOL, {
      async evaluateStrategy() {
        evaluationEntered = true;
        if (ordering === "tick-first") await strategyGate.promise;
        return {
          symbol: SYMBOL,
          action: "SELL",
          confidence: 1,
          reason: "controlled fake strategy",
        };
      },
    });
    f.executor.beforeSubmit = async () => {
      submissionEntered = true;
      await brokerGate.promise;
    };
    f.emit(ACTIVATION);
    secondCallbacks[0]!();
    await waitUntil(() => evaluationEntered);
    if (ordering === "strategy-first") await waitUntil(() => submissionEntered);
    f.emit(ENTRY - 1);
    const firstIntent = state(f.controller).exit;
    assert.ok(firstIntent);
    assert.equal(
      firstIntent.reason,
      ordering === "tick-first" ? "ENTRY_PRICE_BACKSTOP" : "STRATEGY_SELL",
    );
    const manual = f.controller.requestExit(SYMBOL, "MANUAL_CLOSE");
    f.emit(ACTIVATION);
    secondCallbacks[0]!(); // In-flight evaluation/actor must not permit a second exit.
    strategyGate.release();
    await waitUntil(() => submissionEntered);
    assert.equal(
      state(f.controller).exit?.clientOrderId,
      firstIntent.clientOrderId,
    );
    brokerGate.release();
    await manual;
    await drain(f.controller);
    assert.equal(f.executor.submissions.length, 1, ordering);
    assert.equal(
      f.executor.submissions[0]?.clientOrderId,
      firstIntent.clientOrderId,
    );
    assert.equal(f.executor.submissions[0]?.requestedQuantity, 10);
    assert.equal(
      legacyCloses.length,
      0,
      "protected SELL must never bypass the controller with closePosition",
    );
    const durable = await new TradeLifecycleStore(
      f.ledgerPath,
    ).getOpenLifecycle(SYMBOL);
    assert.equal(
      durable?.protection?.exit?.clientOrderId,
      firstIntent.clientOrderId,
    );
    assert.equal(durable?.protection?.exit?.reason, firstIntent.reason);
    assert.equal(
      durable?.remainingQuantity,
      10,
      "acceptance/recovered prices are not closing fills",
    );
  }
});

test("startup READY=false blocks both strategy BUY and the forced F completed-bar test buy", async (t) => {
  const f = await fixture(t, false, false);
  assert.equal(f.controller.isReady(), false);
  positions.allowBuy = true;
  const evaluations: string[] = [];
  for (const symbol of [SYMBOL, "F"]) {
    MASTER_WATCHLIST.set(symbol, { symbol, strategy: PROFILE.strategy });
    strategies.set(symbol, {
      async evaluateStrategy() {
        evaluations.push(symbol);
        return {
          symbol,
          action: "BUY",
          confidence: 1,
          reason: "fake startup BUY",
        };
      },
    });
  }
  const spy = t.mock.method(positions, "markPendingBuy");
  market.emitBar({
    Symbol: SYMBOL,
    Timestamp: FIXED_NOW,
    OpenPrice: 100,
    HighPrice: 101,
    LowPrice: 99,
    ClosePrice: 100,
    Volume: 10,
  });
  market.emitBar({
    Symbol: "F",
    Timestamp: FIXED_NOW,
    OpenPrice: 10,
    HighPrice: 11,
    LowPrice: 9,
    ClosePrice: 10,
    Volume: 10,
  });
  await waitUntil(() => positions.marks.length === 2);
  await drain(f.controller);
  assert.equal(f.controller.isReady(), false);
  assert.deepEqual(evaluations.sort(), [SYMBOL, "F"]);
  assert.equal(spy.mock.callCount(), 0);
  assert.deepEqual(
    buys,
    [],
    "neither strategy entry nor runTestBuy(F) may bypass startup recovery readiness",
  );
  assert.deepEqual(legacyCloses, []);
  assert.equal(f.executor.submissions.length, 0);
  assert.deepEqual(await f.store.getLifecycles(), []);
});
