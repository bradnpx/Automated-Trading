import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { after, before, mock, test, type TestContext } from "node:test";

import type {
  RemainderProtection,
  TradeLifecycleProfile,
} from "@my-platform/types";
import type {
  ProtectionBrokerOrder,
  ProtectionExecutionResult,
  ProtectionSnapshot,
} from "./executor.js";
import { TradeLifecycleStore } from "./models/tradeLifecycleStore.js";
import { RemainderProtectionController } from "./remainderProtection.js";

// Scoped copy of the remainderProtection.test.ts broker fixture. No engine index,
// SDK, services, real orders, or production ledger is used. Cleanup never sells
// risk or force-closes a lifecycle to make an assertion pass.
let networkAttempts = 0;
before(() => {
  const denied = (): never => {
    networkAttempts += 1;
    throw new Error("Network is forbidden in remainder recovery tests");
  };
  mock.method(http, "request", denied);
  mock.method(http, "get", denied);
  mock.method(https, "request", denied);
  mock.method(https, "get", denied);
  mock.method(globalThis, "fetch", denied);
});
after(() => {
  mock.restoreAll();
  assert.equal(networkAttempts, 0, "tests must never attempt network calls");
});

const SYMBOL = "RECOVERY";
const ENTRY = 335;
const ACTIVATION = 342.83;
const FIXED_NOW = "2026-11-03T15:00:00.000Z";
const PROFILE: TradeLifecycleProfile = {
  strategy: "bullFlagMomentum",
  takeProfitPct: 2,
  stopLossPct: 2,
  trailingStopLoss: true,
};
const TERMINAL = new Set([
  "filled",
  "canceled",
  "expired",
  "rejected",
  "replaced",
]);
type Arguments = ConstructorParameters<typeof RemainderProtectionController>;
type RiskPositions = Arguments[1];
type ProtectionExecutor = Arguments[2];
type Submission = {
  symbol: string;
  clientOrderId: string;
  requestedQuantity?: number;
};

class MockProtectionExecutor implements ProtectionExecutor {
  readonly orders = new Map<string, ProtectionBrokerOrder>();
  readonly submissions: Submission[] = [];
  readonly nativeLookups: string[] = [];
  readonly lookups: string[] = [];
  quantity = 20;
  latestPrice: ProtectionSnapshot["price"];

  constructor(private readonly now: () => Date) {
    this.latestPrice = { price: ACTIVATION, timestamp: now().toISOString() };
  }
  async getHalfExitQuantity(_symbol: string, total: number): Promise<number> {
    return total / 2;
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
        .filter((order) => !TERMINAL.has(order.status))
        .map((order) => structuredClone(order)),
      price: this.latestPrice && structuredClone(this.latestPrice),
    };
  }
  async getProtectionOrder(
    clientOrderId: string,
  ): Promise<ProtectionBrokerOrder | undefined> {
    this.lookups.push(clientOrderId);
    const order = this.orders.get(clientOrderId);
    return order && structuredClone(order);
  }
  async getProtectionOrderById(
    orderId: string,
  ): Promise<ProtectionBrokerOrder | undefined> {
    this.nativeLookups.push(orderId);
    const order = [...this.orders.values()].find(
      (candidate) => candidate.id === orderId,
    );
    return order && structuredClone(order);
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
    assert.equal(symbol, SYMBOL);
    this.submissions.push({ symbol, clientOrderId, requestedQuantity });
    const order: ProtectionBrokerOrder = {
      id: `recovery-order-${this.submissions.length}`,
      symbol,
      client_order_id: clientOrderId,
      side: "sell",
      type: "market",
      status: "new",
      qty: String(requestedQuantity ?? this.quantity),
      filled_qty: "0",
      filled_avg_price: null,
      submitted_at: this.now().toISOString(),
    };
    this.orders.set(clientOrderId, order);
    return { kind: "submitted", order: structuredClone(order) };
  }
  fill(
    clientOrderId: string,
    cumulative: number,
    status = "filled",
  ): ProtectionBrokerOrder {
    const order = this.orders.get(clientOrderId);
    assert.ok(order);
    const previous = Number(order.filled_qty ?? 0);
    assert.ok(cumulative >= previous);
    this.quantity -= cumulative - previous;
    Object.assign(order, {
      filled_qty: String(cumulative),
      filled_avg_price: String(ACTIVATION),
      status,
      filled_at: this.now().toISOString(),
    });
    return structuredClone(order);
  }
}

class MockPositions implements RiskPositions {
  readonly pending = new Set<string>();
  readonly blocked = new Set<string>();
  readonly states = new Map<string, RemainderProtection>();
  constructor(private readonly executor: MockProtectionExecutor) {}
  hasPosition(symbol: string): boolean {
    return symbol === SYMBOL && this.executor.quantity > 0;
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
    return [];
  }
}

const pause = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 5));
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
      !controller.getStatus().protections.some((item) => item.inFlight)
    )
      return;
  }
  throw new Error("Finite controller work failed to settle");
}
function state(controller: RemainderProtectionController): RemainderProtection {
  const current = controller
    .getStatus()
    .protections.find((item) => item.symbol === SYMBOL);
  assert.ok(current);
  return structuredClone(current);
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "remainder-recovery-test-"),
  );
  const ledgerPath = path.join(directory, "ledger.json");
  let clock = Date.parse(FIXED_NOW);
  let enabled = true;
  const now = (): Date => new Date(clock);
  const executor = new MockProtectionExecutor(now);
  const store = new TradeLifecycleStore(ledgerPath);
  const controllers: RemainderProtectionController[] = [];
  const alerts: string[] = [];
  const positions = new MockPositions(executor);
  const controller = makeController(store, positions);
  function makeController(
    currentStore: TradeLifecycleStore,
    currentPositions = new MockPositions(executor),
  ) {
    const created = new RemainderProtectionController(
      currentStore,
      currentPositions,
      executor,
      {
        broadcastSignal: (signal) => {
          alerts.push(signal.reason);
        },
      },
      undefined,
      now,
      () => enabled,
    );
    controllers.push(created);
    return created;
  }
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
  t.after(async () => {
    enabled = false;
    for (const current of controllers) await drain(current);
    // Delete only private test files; do not manufacture terminal broker fills.
    await rm(directory, { recursive: true, force: true });
  });
  return {
    ledgerPath,
    executor,
    store,
    controller,
    positions,
    alerts,
    now,
    makeController,
    setEnabled(value: boolean): void {
      enabled = value;
    },
    advance(ms = 6_000): void {
      clock += ms;
      if (executor.latestPrice)
        executor.latestPrice.timestamp = now().toISOString();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function seedProtected(
  f: Fixture,
  override: Partial<RemainderProtection> = {},
): Promise<void> {
  await f.store.recordFill({
    executionId: "confirmed-half",
    orderId: "confirmed-half-order",
    orderType: "market",
    side: "sell",
    symbol: SYMBOL,
    price: ACTIVATION,
    quantity: 10,
    filledAt: FIXED_NOW,
    profile: PROFILE,
    reason: "TAKE_PROFIT_HALF",
  });
  f.executor.quantity = 10;
  const protection: RemainderProtection = {
    version: 1,
    phase: "protected-remainder",
    revision: 10,
    entryPrice: ENTRY,
    trailingDistance: ACTIVATION - ENTRY,
    highWaterMark: ACTIVATION,
    effectiveStop: ENTRY,
    halfExit: {
      clientOrderId: "confirmed-half-client",
      orderId: "confirmed-half-order",
      targetQuantity: 10,
      filledQuantity: 10,
      orderFilledQuantity: 10,
      completed: true,
    },
    activatedAt: FIXED_NOW,
    activationSource: "trade",
    lastPriceAt: FIXED_NOW,
    ...override,
  };
  await f.store.saveProtection(SYMBOL, protection);
  f.executor.orders.set(protection.halfExit.clientOrderId, {
    id: "confirmed-half-order",
    symbol: SYMBOL,
    client_order_id: protection.halfExit.clientOrderId,
    side: "sell",
    type: "market",
    status: "filled",
    qty: "10",
    filled_qty: "10",
    filled_avg_price: String(ACTIVATION),
    filled_at: FIXED_NOW,
  });
}

test("canceled half with five confirmed shares rotates ID and completes aggregate ten exactly once", async (t) => {
  const f = await fixture(t);
  await f.controller.initialize();
  assert.equal(f.controller.onPrice(SYMBOL, ACTIVATION, FIXED_NOW), true);
  await f.controller.startHalfExit(SYMBOL, ENTRY, 20);
  await drain(f.controller);
  const firstId = state(f.controller).halfExit.clientOrderId;
  const first = f.executor.fill(firstId, 5, "canceled");
  f.controller.observeOrder(SYMBOL, first);
  await drain(f.controller);
  const rotated = state(f.controller).halfExit;
  assert.notEqual(rotated.clientOrderId, firstId);
  assert.equal(rotated.completed, false);
  assert.equal(rotated.filledQuantity, 5);
  assert.deepEqual(
    f.executor.submissions.map((submission) => submission.requestedQuantity),
    [10, 5],
  );
  const final = f.executor.fill(rotated.clientOrderId, 5);
  f.controller.observeOrder(SYMBOL, final);
  await drain(f.controller);
  const completed = state(f.controller);
  assert.equal(completed.halfExit.completed, true);
  assert.equal(completed.halfExit.filledQuantity, 10);
  assert.equal(completed.halfExit.orderFilledQuantity, 5);
  const activation = completed.activatedAt;
  const distance = completed.trailingDistance;
  // Replayed updates from BOTH generations must not turn ten into fifteen.
  f.controller.observeOrder(SYMBOL, first);
  f.controller.observeOrder(SYMBOL, final);
  f.controller.observeOrder(SYMBOL, final);
  f.advance();
  await f.controller.tick();
  await drain(f.controller);
  const lifecycle = await new TradeLifecycleStore(
    f.ledgerPath,
  ).getOpenLifecycle(SYMBOL);
  assert.equal(lifecycle?.status, "partially_closed");
  assert.equal(lifecycle?.exitedQuantity, 10);
  assert.equal(lifecycle?.remainingQuantity, 10);
  assert.equal(
    lifecycle?.exitFills.reduce((sum, fill) => sum + fill.quantity, 0),
    10,
  );
  assert.equal(lifecycle?.exitFills.length, 2);
  assert.ok(
    lifecycle?.exitFills.every((fill) => fill.reason === "TAKE_PROFIT_HALF"),
  );
  assert.equal(state(f.controller).halfExit.filledQuantity, 10);
  assert.equal(state(f.controller).activatedAt, activation);
  assert.equal(state(f.controller).trailingDistance, distance);
  assert.equal(f.executor.submissions.length, 2);
});

test("disk restart honors saved nextRetryAt despite fresh ticks and repeated controlled close requests", async (t) => {
  const f = await fixture(t);
  const nextRetryAt = new Date(f.now().getTime() + 30_000).toISOString();
  await seedProtected(f, {
    phase: "remainder-exit-pending",
    exit: {
      clientOrderId: "saved-backoff-client",
      reason: "MANUAL_CLOSE",
      attempt: 3,
      status: "unknown",
      replacements: 0,
      nextRetryAt,
    },
  });
  const restartedStore = new TradeLifecycleStore(f.ledgerPath);
  const restarted = f.makeController(restartedStore);
  await restarted.initialize();
  await drain(restarted);
  assert.equal(restarted.isReady(), true);
  assert.equal(
    f.executor.submissions.length,
    0,
    "startup must restore the future durable backoff, not submit immediately",
  );
  assert.equal(
    restarted.onPrice(SYMBOL, ENTRY - 1, f.now().toISOString()),
    true,
  );
  await restarted.requestExit(SYMBOL, "STRATEGY_SELL");
  f.advance(29_999);
  await restarted.tick();
  await drain(restarted);
  assert.equal(
    f.executor.submissions.length,
    0,
    "ticks/manual callers must honor the restored retry deadline",
  );
  assert.equal(state(restarted).exit?.reason, "MANUAL_CLOSE");
  assert.equal(state(restarted).exit?.nextRetryAt, nextRetryAt);
  f.advance(1);
  await restarted.tick();
  await drain(restarted);
  assert.equal(f.executor.submissions.length, 1);
  assert.equal(f.executor.submissions[0].clientOrderId, "saved-backoff-client");
  assert.equal(
    (await new TradeLifecycleStore(f.ledgerPath).getOpenLifecycle(SYMBOL))
      ?.remainingQuantity,
    10,
  );
});

test("missed native final fill is looked up by order ID and recorded before zero-position closure", async (t) => {
  const f = await fixture(t);
  await seedProtected(f, { nativeOrderId: "native-final-order" });
  f.executor.orders.set("native-client", {
    id: "native-final-order",
    symbol: SYMBOL,
    client_order_id: "native-client",
    side: "sell",
    type: "trailing_stop",
    status: "new",
    qty: "10",
    filled_qty: "0",
  });
  f.executor.fill("native-client", 10); // REST sees the fill; no stream event was delivered.
  const restartedStore = new TradeLifecycleStore(f.ledgerPath);
  const forcedClosure = t.mock.method(restartedStore, "markBrokerClosed");
  const restarted = f.makeController(restartedStore);
  await restarted.initialize();
  await drain(restarted);
  const [closed] = await new TradeLifecycleStore(f.ledgerPath).getLifecycles();
  assert.ok(f.executor.nativeLookups.includes("native-final-order"));
  assert.equal(
    forcedClosure.mock.callCount(),
    0,
    "confirmed fills, not synthetic broker-zero closure, must close this ledger",
  );
  assert.equal(closed.status, "closed");
  assert.equal(closed.exitedQuantity, 20);
  assert.equal(closed.remainingQuantity, 0);
  assert.equal(
    closed.exitFills
      .filter((fill) => fill.orderId === "native-final-order")
      .reduce((sum, fill) => sum + fill.quantity, 0),
    10,
  );
  assert.equal(
    closed.exitFills.find((fill) => fill.orderId === "native-final-order")
      ?.reason,
    "TRAILING_STOP_LOSS",
  );
  assert.equal(restarted.manages(SYMBOL), false);
  assert.equal(f.executor.submissions.length, 0);
  await restarted.tick();
  await drain(restarted);
  assert.equal((await restartedStore.getLifecycles())[0].exitedQuantity, 20);
});

test("legacy native percent trail cannot invent a fixed dollar distance or historical calibration", async (t) => {
  const f = await fixture(t);
  await seedProtected(f, {
    phase: "recovery-required",
    trailingDistance: null,
    highWaterMark: ENTRY,
    effectiveStop: ENTRY,
    calibrationRequired: true,
    activatedAt: undefined,
    activationSource: undefined,
    nativeOrderId: "native-percent-order",
  });
  const native: ProtectionBrokerOrder & { trail_percent: string } = {
    id: "native-percent-order",
    symbol: SYMBOL,
    client_order_id: "native-percent-client",
    side: "sell",
    type: "trailing_stop",
    status: "new",
    qty: "10",
    filled_qty: "0",
    trail_percent: "2",
    hwm: "355",
    stop_price: "347.9",
  };
  f.executor.orders.set("native-percent-client", native);
  f.executor.latestPrice = { price: 350, timestamp: f.now().toISOString() };
  await f.controller.initialize();
  await drain(f.controller);
  const recovered = state(f.controller);
  assert.equal(f.controller.isReady(), true);
  assert.equal(recovered.nativeOrderId, native.id);
  assert.equal(recovered.calibrationRequired, true);
  assert.equal(recovered.trailingDistance, null);
  assert.equal(recovered.activatedAt, undefined);
  assert.equal(
    recovered.highWaterMark,
    355,
    "retain the verified broker high without converting its percent trail to a fixed distance",
  );
  assert.equal(
    recovered.effectiveStop,
    347.9,
    "a verified broker stop can strengthen the floor even when fixed-distance calibration is unknown",
  );
  assert.equal(recovered.phase, "recovery-required");
  assert.equal(f.executor.submissions.length, 0);
  assert.equal(
    (await new TradeLifecycleStore(f.ledgerPath).getOpenLifecycle(SYMBOL))
      ?.protection?.trailingDistance,
    null,
  );
});

test("after panic disables protection, repeated price breaches and manual/strategy exits submit no orders", async (t) => {
  const f = await fixture(t);
  await seedProtected(f);
  await f.controller.initialize();
  f.setEnabled(false); // Same safety guard as engineState.isKilled; no actual panic API.
  assert.equal(
    f.controller.onPrice(SYMBOL, ENTRY - 1, f.now().toISOString()),
    true,
  );
  const latchedId = state(f.controller).exit?.clientOrderId;
  assert.ok(latchedId);
  await Promise.all([
    f.controller.requestExit(SYMBOL, "MANUAL_CLOSE"),
    f.controller.requestExit(SYMBOL, "STRATEGY_SELL"),
    f.controller.requestExit(SYMBOL, "MANUAL_CLOSE"),
  ]);
  f.advance(31_000);
  assert.equal(
    f.controller.onPrice(SYMBOL, ENTRY - 2, f.now().toISOString()),
    true,
  );
  await f.controller.tick();
  await drain(f.controller);
  assert.equal(f.executor.submissions.length, 0);
  assert.equal(state(f.controller).exit?.clientOrderId, latchedId);
  assert.equal(
    f.controller.manages(SYMBOL),
    true,
    "panic guard is not proof a broker filled the exit",
  );
  const durable = await new TradeLifecycleStore(f.ledgerPath).getOpenLifecycle(
    SYMBOL,
  );
  assert.equal(durable?.remainingQuantity, 10);
  assert.equal(durable?.protection?.exit?.clientOrderId, latchedId);
});
