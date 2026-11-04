import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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

// Import the controller directly, never the engine index (which starts services).
// Even an accidental request from an imported dependency must fail offline.
let networkAttempts = 0;
before(() => {
  const denied = (): never => {
    networkAttempts += 1;
    throw new Error(
      "Network is forbidden in remainder-protection regression tests",
    );
  };
  mock.method(http, "request", denied);
  mock.method(http, "get", denied);
  mock.method(https, "request", denied);
  mock.method(https, "get", denied);
  mock.method(globalThis, "fetch", denied);
});
after(() => {
  mock.restoreAll();
  assert.equal(
    networkAttempts,
    0,
    "controller tests must never attempt real network calls",
  );
});

const SYMBOL = "PROTECT";
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

type ControllerArguments = ConstructorParameters<
  typeof RemainderProtectionController
>;
type RiskPositions = ControllerArguments[1];
type ProtectionExecutor = ControllerArguments[2];
type Broadcaster = ControllerArguments[3];
type Submission = {
  symbol: string;
  clientOrderId: string;
  requestedQuantity: number | undefined;
  options: Parameters<ProtectionExecutor["submitProtectionExit"]>[3];
};

/** A broker simulation only: no Executor instance, SDK, credentials, or services. */
class MockProtectionExecutor implements ProtectionExecutor {
  readonly orders = new Map<string, ProtectionBrokerOrder>();
  readonly submissions: Submission[] = [];
  readonly lookups: string[] = [];
  readonly cancellations: string[] = [];
  readonly halfQuantityCalls: Array<{ symbol: string; total: number }> = [];
  quantity: number;
  latestPrice: ProtectionSnapshot["price"];
  fractionable = true;
  acceptThenThrow = false;
  defer = false;
  beforeSubmit?: (submission: Submission) => Promise<void>;

  constructor(
    quantity: number,
    private readonly now: () => Date,
  ) {
    this.quantity = quantity;
    this.latestPrice = {
      price: ACTIVATION,
      timestamp: this.now().toISOString(),
    };
  }

  async getHalfExitQuantity(symbol: string, total: number): Promise<number> {
    this.halfQuantityCalls.push({ symbol, total });
    return this.fractionable ? total / 2 : Math.floor(total / 2);
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

  async cancelProtectionOrder(orderId: string): Promise<void> {
    this.cancellations.push(orderId);
    const order = [...this.orders.values()].find(
      (candidate) => candidate.id === orderId,
    );
    assert.ok(order, "cancellation must identify a known simulated order");
    order.status = "canceled";
  }

  async submitProtectionExit(
    symbol: string,
    clientOrderId: string,
    requestedQuantity?: number,
    options?: Submission["options"],
  ): Promise<ProtectionExecutionResult> {
    const submission = { symbol, clientOrderId, requestedQuantity, options };
    await this.beforeSubmit?.(submission);
    this.submissions.push(submission);
    if (this.defer)
      return { kind: "deferred", reason: "Simulated closed session" };
    // Simulate the executor contract: cancel reservations before a remainder close.
    for (const order of this.orders.values()) {
      if (
        !TERMINAL.has(order.status) &&
        order.client_order_id !== clientOrderId
      ) {
        await this.cancelProtectionOrder(order.id);
      }
    }
    const order: ProtectionBrokerOrder = {
      id: `simulated-${this.submissions.length}`,
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
    if (this.acceptThenThrow) {
      this.acceptThenThrow = false;
      throw new Error("Simulated timeout after broker acceptance");
    }
    return { kind: "submitted", order: structuredClone(order) };
  }

  fill(
    clientOrderId: string,
    cumulative: number,
    status = "filled",
    price = ACTIVATION,
  ): ProtectionBrokerOrder {
    const order = this.orders.get(clientOrderId);
    assert.ok(order, "fill must identify a known simulated order");
    const previous = Number(order.filled_qty ?? 0);
    assert.ok(
      cumulative >= previous,
      "simulated broker cumulative fill cannot decrease",
    );
    this.quantity -= cumulative - previous;
    Object.assign(order, {
      filled_qty: String(cumulative),
      filled_avg_price: String(price),
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

async function fixture(t: TestContext, quantity = 20) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "remainder-protection-test-"),
  );
  // All data/log locations are private to this fixture; no production ledger is used.
  const ledgerPath = path.join(directory, "ledger", "trade-lifecycles.json");
  const logPath = path.join(directory, "trade-log.json");
  let clock = Date.parse(FIXED_NOW);
  const now = (): Date => new Date(clock);
  const executor = new MockProtectionExecutor(quantity, now);
  const positions = new MockPositions(executor);
  const alerts: Parameters<Broadcaster["broadcastSignal"]>[0][] = [];
  const broadcaster: Broadcaster = {
    broadcastSignal: (signal) => {
      alerts.push(structuredClone(signal));
    },
  };
  const store = new TradeLifecycleStore(ledgerPath);
  const controller = new RemainderProtectionController(
    store,
    positions,
    executor,
    broadcaster,
    undefined,
    now,
  );
  await store.recordFill({
    executionId: "entry-execution",
    orderId: "entry-order",
    orderType: "market",
    side: "buy",
    symbol: SYMBOL,
    price: ENTRY,
    quantity,
    filledAt: FIXED_NOW,
    profile: PROFILE,
  });
  // Do not fake a closing fill to clean up; tests retain the actual open risk state.
  t.after(async () => {
    await drain(controller, true);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    ledgerPath,
    logPath,
    store,
    controller,
    executor,
    positions,
    alerts,
    broadcaster,
    now,
    advance(ms = 6_000): void {
      clock += ms;
      if (executor.latestPrice)
        executor.latestPrice.timestamp = now().toISOString();
    },
    price(value: number): void {
      clock += 1;
      executor.latestPrice = { price: value, timestamp: now().toISOString() };
      assert.equal(
        controller.onPrice(SYMBOL, value, now().toISOString()),
        true,
      );
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function state(controller: RemainderProtectionController): RemainderProtection {
  const protection = controller
    .getStatus()
    .protections.find((item) => item.symbol === SYMBOL);
  assert.ok(protection, "controller must retain the managed risk state");
  return structuredClone(protection);
}

async function persisted(f: Fixture): Promise<RemainderProtection> {
  // A NEW store forces an actual disk read rather than inspecting in-memory state.
  const freshStore = new TradeLifecycleStore(f.ledgerPath);
  const lifecycle = await freshStore.getOpenLifecycle(SYMBOL);
  assert.ok(lifecycle?.protection, "protection must be durable on disk");
  return lifecycle.protection;
}

function near(actual: number, expected: number): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-8,
    `expected ${actual} to equal ${expected}`,
  );
}

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Bounded settling of this controller's finite async work, not a service/poller. */
async function drain(
  controller: RemainderProtectionController,
  allowWriteError = false,
): Promise<void> {
  let previous = "";
  let stable = 0;
  for (let turn = 0; turn < 100; turn += 1) {
    try {
      await controller.flush();
    } catch (error) {
      if (!allowWriteError) throw error;
    }
    await pause(5);
    const current = JSON.stringify(controller.getStatus());
    stable = current === previous ? stable + 1 : 0;
    previous = current;
    if (
      stable >= 3 &&
      !controller.getStatus().protections.some((item) => item.inFlight)
    )
      return;
  }
  throw new Error(
    "Controller async work did not settle within bounded test turns",
  );
}

async function seedProtected(
  f: Fixture,
  override: Partial<RemainderProtection> = {},
): Promise<void> {
  const target = f.executor.quantity / 2;
  await f.store.recordFill({
    executionId: "confirmed-half-execution",
    orderId: "confirmed-half-order",
    orderType: "market",
    side: "sell",
    symbol: SYMBOL,
    price: ACTIVATION,
    quantity: target,
    filledAt: FIXED_NOW,
    profile: PROFILE,
    reason: "TAKE_PROFIT_HALF",
  });
  f.executor.quantity -= target;
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
      targetQuantity: target,
      filledQuantity: target,
      completed: true,
    },
    activatedAt: FIXED_NOW,
    activationSource: "trade",
    lastPriceAt: FIXED_NOW,
    ...override,
  };
  await f.store.saveProtection(SYMBOL, protection);
  f.executor.orders.set(protection.halfExit.clientOrderId, {
    id: protection.halfExit.orderId!,
    symbol: SYMBOL,
    client_order_id: protection.halfExit.clientOrderId,
    side: "sell",
    type: "market",
    status: "filled",
    qty: String(target),
    filled_qty: String(target),
    filled_avg_price: String(ACTIVATION),
    filled_at: FIXED_NOW,
  });
}

async function beginHalf(f: Fixture): Promise<string> {
  await f.controller.initialize();
  f.price(ACTIVATION);
  await f.controller.startHalfExit(SYMBOL, ENTRY, f.executor.quantity);
  await drain(f.controller);
  return state(f.controller).halfExit.clientOrderId;
}

async function completeHalf(f: Fixture): Promise<string> {
  const clientId = await beginHalf(f);
  const target = state(f.controller).halfExit.targetQuantity;
  f.controller.observeOrder(SYMBOL, f.executor.fill(clientId, target));
  await drain(f.controller);
  return clientId;
}

test("fresh startup becomes ready without adopting unprotected lifecycle or submitting orders", async (t) => {
  const f = await fixture(t);
  await f.controller.initialize();
  assert.equal(f.controller.isReady(), true);
  assert.equal(f.controller.manages(SYMBOL), false);
  assert.deepEqual(f.controller.getStatus().protections, []);
  assert.equal(f.executor.submissions.length, 0);
});

test("half sale persists a stable ID before submission and acceptance is not a fill", async (t) => {
  const f = await fixture(t);
  let persistedClientId: string | undefined;
  f.executor.beforeSubmit = async (submission) => {
    const durable = await persisted(f);
    persistedClientId = durable.halfExit.clientOrderId;
    assert.equal(submission.clientOrderId, persistedClientId);
    assert.equal(durable.halfExit.completed, false);
    assert.equal(durable.halfExit.filledQuantity, 0);
  };
  const clientId = await beginHalf(f);
  assert.equal(clientId, persistedClientId);
  await f.controller.startHalfExit(SYMBOL, ENTRY, 20);
  assert.equal(f.executor.submissions.length, 1);
  assert.equal(f.executor.submissions[0].requestedQuantity, 10);
  assert.equal(state(f.controller).halfExit.completed, false);
  assert.equal((await f.store.getOpenLifecycle(SYMBOL))?.remainingQuantity, 20);
  assert.equal(f.positions.pending.has(SYMBOL), true);
  assert.equal((await persisted(f)).halfExit.clientOrderId, clientId);
});

test("confirmed cumulative target completes half exactly once and duplicate updates do not double-record fills", async (t) => {
  const f = await fixture(t);
  const clientId = await completeHalf(f);
  const complete = state(f.controller);
  assert.equal(complete.halfExit.completed, true);
  assert.equal(complete.phase, "protected-remainder");
  near(complete.trailingDistance!, ACTIVATION - ENTRY);
  near(complete.highWaterMark, ACTIVATION);
  near(complete.effectiveStop, ENTRY);
  const repeated = await f.executor.getProtectionOrder(clientId);
  assert.ok(repeated);
  f.controller.observeOrder(SYMBOL, repeated);
  f.controller.observeOrder(SYMBOL, repeated);
  f.advance();
  await f.controller.tick();
  await drain(f.controller);
  const lifecycle = await f.store.getOpenLifecycle(SYMBOL);
  assert.equal(lifecycle?.exitFills.length, 1);
  assert.equal(lifecycle?.exitedQuantity, 10);
  assert.equal(lifecycle?.remainingQuantity, 10);
  assert.equal(lifecycle?.exitFills[0].reason, "TAKE_PROFIT_HALF");
  near(state(f.controller).trailingDistance!, complete.trailingDistance!);
  assert.equal(f.executor.submissions.length, 1);
});

test("broker lookup alone confirms actual integer half target using cumulative fields", async (t) => {
  const f = await fixture(t, 5);
  f.executor.fractionable = false;
  const clientId = await beginHalf(f);
  assert.equal(state(f.controller).halfExit.targetQuantity, 2);
  f.executor.fill(clientId, 1, "partially_filled");
  f.advance();
  await f.controller.tick();
  await drain(f.controller);
  assert.equal(state(f.controller).halfExit.completed, false);
  assert.equal((await f.store.getOpenLifecycle(SYMBOL))?.remainingQuantity, 4);
  f.executor.fill(clientId, 2);
  f.advance();
  await f.controller.tick();
  await drain(f.controller);
  assert.equal(state(f.controller).halfExit.completed, true);
  const lifecycle = await f.store.getOpenLifecycle(SYMBOL);
  assert.equal(lifecycle?.exitedQuantity, 2);
  assert.equal(lifecycle?.remainingQuantity, 3);
  assert.equal(
    lifecycle?.exitFills.reduce((sum, fill) => sum + fill.quantity, 0),
    2,
  );
  assert.equal(f.executor.submissions.length, 1);
});

test("terminal half order with less than target must not disable original stop protection", async (t) => {
  const f = await fixture(t);
  const clientId = await beginHalf(f);
  f.controller.observeOrder(SYMBOL, f.executor.fill(clientId, 3, "filled"));
  await drain(f.controller);
  assert.equal(
    state(f.controller).halfExit.completed,
    false,
    "completed requires the entire planned cumulative half target",
  );
});

test("same-revision lower state cannot loosen floor after NEW store and controller restart", async (t) => {
  const f = await fixture(t);
  await seedProtected(f, { highWaterMark: 355, effectiveStop: 347.17 });
  const before = await persisted(f);
  await f.store.saveProtection(SYMBOL, {
    ...before,
    highWaterMark: ACTIVATION,
    effectiveStop: ENTRY,
  });
  f.executor.latestPrice = { price: 350, timestamp: f.now().toISOString() };
  const restartedStore = new TradeLifecycleStore(f.ledgerPath);
  const restartedPositions = new MockPositions(f.executor);
  const restarted = new RemainderProtectionController(
    restartedStore,
    restartedPositions,
    f.executor,
    f.broadcaster,
    undefined,
    f.now,
  );
  await restarted.initialize();
  await drain(restarted);
  assert.equal(restarted.isReady(), true);
  near(state(restarted).highWaterMark, 355);
  near(state(restarted).effectiveStop, 347.17);
  near(state(restarted).trailingDistance!, ACTIVATION - ENTRY);
  assert.equal(state(restarted).halfExit.completed, true);
  assert.equal(f.executor.submissions.length, 0);
  const fromDisk = await persisted(f);
  near(fromDisk.effectiveStop, 347.17);
  near(fromDisk.highWaterMark, 355);
});

test("355 high raises stop to 347.17; 347 breach followed synchronously by 350 recovery still submits once", async (t) => {
  const f = await fixture(t);
  await seedProtected(f);
  await f.controller.initialize();
  f.price(355);
  await f.controller.flush();
  near(state(f.controller).effectiveStop, 347.17);
  f.executor.beforeSubmit = async (submission) => {
    const durable = await persisted(f);
    assert.equal(durable.exit?.clientOrderId, submission.clientOrderId);
    near(durable.effectiveStop, 347.17);
  };
  f.price(347);
  const breachedId = state(f.controller).exit?.clientOrderId;
  assert.ok(breachedId, "breach must latch before asynchronous broker work");
  f.price(350);
  assert.equal(state(f.controller).exit?.clientOrderId, breachedId);
  assert.equal(state(f.controller).exit?.reason, "TRAILING_STOP_LOSS");
  await drain(f.controller);
  f.advance();
  await f.controller.tick();
  await drain(f.controller);
  assert.equal(f.executor.submissions.length, 1);
  assert.equal(f.executor.submissions[0].clientOrderId, breachedId);
  assert.equal(
    f.executor.submissions[0].requestedQuantity,
    10,
    "cap the full exit to attributed remaining shares",
  );
  near((await persisted(f)).effectiveStop, 347.17);
});

test("exact entry floor is not breached but lower price latches entry-price backstop", async (t) => {
  const f = await fixture(t);
  await seedProtected(f);
  await f.controller.initialize();
  f.price(ENTRY);
  await drain(f.controller);
  assert.equal(state(f.controller).exit, undefined);
  f.price(ENTRY - 0.01);
  assert.equal(state(f.controller).exit?.reason, "ENTRY_PRICE_BACKSTOP");
  await drain(f.controller);
  assert.equal(f.executor.submissions.length, 1);
  near(state(f.controller).effectiveStop, ENTRY);
});

test("protection remains managed when symbol is absent from mutable watchlist", async (t) => {
  const f = await fixture(t);
  const watchlist = new Map([[SYMBOL, PROFILE]]);
  await seedProtected(f);
  await f.controller.initialize();
  watchlist.delete(SYMBOL);
  assert.equal(watchlist.has(SYMBOL), false);
  assert.equal(f.controller.manages(SYMBOL), true);
  f.price(ENTRY - 1);
  await drain(f.controller);
  assert.equal(f.executor.submissions.length, 1);
  assert.equal(
    f.controller.manages(SYMBOL),
    true,
    "accepted close is not proof the position is closed",
  );
});

test("fractional remainder uses local protection without a native trailing-stop request", async (t) => {
  const f = await fixture(t, 5.5);
  await completeHalf(f);
  near(state(f.controller).halfExit.targetQuantity, 2.75);
  near((await f.store.getOpenLifecycle(SYMBOL))!.remainingQuantity, 2.75);
  assert.equal(f.controller.getStatus().protections[0].mode, "local");
  assert.equal(state(f.controller).nativeOrderId, undefined);
  assert.ok(
    [...f.executor.orders.values()].every(
      (order) => order.type !== "trailing_stop",
    ),
  );
  f.price(ENTRY - 0.01);
  await drain(f.controller);
  assert.equal(f.executor.submissions.length, 2);
  assert.equal(
    f.executor.submissions[1].requestedQuantity,
    2.75,
    "cap the full exit to the fractional remainder",
  );
  const remainder = await f.executor.getProtectionOrder(
    state(f.controller).exit!.clientOrderId,
  );
  assert.equal(Number(remainder?.qty), 2.75);
});

test("partial half plus adverse original stop closes actual remainder through one shared exit intent", async (t) => {
  const f = await fixture(t);
  const halfId = await beginHalf(f);
  f.controller.observeOrder(
    SYMBOL,
    f.executor.fill(halfId, 3, "partially_filled"),
  );
  await drain(f.controller);
  assert.equal(state(f.controller).halfExit.completed, false);
  assert.equal((await f.store.getOpenLifecycle(SYMBOL))?.remainingQuantity, 17);
  f.price(ENTRY * (1 - PROFILE.stopLossPct / 100) - 0.01);
  assert.equal(state(f.controller).exit?.reason, "STOP_LOSS");
  const intentId = state(f.controller).exit!.clientOrderId;
  await drain(f.controller);
  assert.equal(f.executor.submissions.length, 2);
  const order = await f.executor.getProtectionOrder(intentId);
  assert.equal(Number(order?.qty), 17);
  assert.equal(
    (await f.executor.getProtectionOrder(halfId))?.status,
    "canceled",
  );
  assert.equal(state(f.controller).exit?.clientOrderId, intentId);
  assert.equal(state(f.controller).halfExit.completed, false);
});

for (const terminalStatus of ["canceled", "expired"] as const) {
  test(`${terminalStatus} remainder keeps durable floor and reason, then retries only after confirmed terminal lookup`, async (t) => {
    const f = await fixture(t);
    await seedProtected(f, { highWaterMark: 355, effectiveStop: 347.17 });
    f.executor.latestPrice = { price: 350, timestamp: f.now().toISOString() };
    await f.controller.initialize();
    await f.controller.requestExit(SYMBOL, "MANUAL_CLOSE");
    await drain(f.controller);
    const firstIntent = state(f.controller).exit!;
    const order = f.executor.orders.get(firstIntent.clientOrderId)!;
    order.status = terminalStatus;
    f.controller.observeOrder(SYMBOL, structuredClone(order));
    assert.equal(state(f.controller).exit?.reason, "MANUAL_CLOSE");
    near(state(f.controller).effectiveStop, 347.17);
    await drain(f.controller);
    const retryIntent = state(f.controller).exit!;
    assert.notEqual(
      retryIntent.clientOrderId,
      firstIntent.clientOrderId,
      "a terminal broker order requires a new attempt ID",
    );
    assert.equal(retryIntent.reason, firstIntent.reason);
    assert.equal(f.executor.submissions.length, 2);
    assert.ok(f.executor.lookups.includes(firstIntent.clientOrderId));
    f.controller.observeOrder(SYMBOL, structuredClone(order));
    f.advance();
    await f.controller.tick();
    await drain(f.controller);
    assert.equal(
      state(f.controller).exit?.clientOrderId,
      retryIntent.clientOrderId,
    );
    assert.equal(
      f.executor.submissions.length,
      2,
      "duplicate terminal update cannot create another retry",
    );
    near((await persisted(f)).effectiveStop, 347.17);
    assert.equal((await persisted(f)).halfExit.completed, true);
  });
}

test("stale native ID v1 migration preserves unknown trail and entry floor without inventing calibration", async (t) => {
  const f = await fixture(t);
  await seedProtected(f);
  const [legacy] = await f.store.getLifecycles();
  delete legacy.protection;
  legacy.trailingStopOrderId = "absent-native-order";
  legacy.pendingExit = {
    orderId: "absent-native-order",
    reason: "TRAILING_STOP_LOSS",
    submittedAt: FIXED_NOW,
  };
  await writeFile(
    f.ledgerPath,
    JSON.stringify({ version: 1, lifecycles: [legacy] }),
  );
  f.executor.latestPrice = { price: 350, timestamp: f.now().toISOString() };
  const recoveredStore = new TradeLifecycleStore(f.ledgerPath);
  const recovered = new RemainderProtectionController(
    recoveredStore,
    new MockPositions(f.executor),
    f.executor,
    f.broadcaster,
    undefined,
    f.now,
  );
  await recovered.initialize();
  await drain(recovered);
  const migrated = state(recovered);
  assert.equal(migrated.nativeOrderId, undefined);
  assert.equal(migrated.halfExit.completed, true);
  assert.equal(
    migrated.trailingDistance,
    null,
    "a stale native ID cannot establish a historical trailing distance",
  );
  assert.equal(migrated.phase, "recovery-required");
  near(migrated.effectiveStop, ENTRY);
  near(migrated.highWaterMark, ENTRY);
  assert.equal(f.executor.submissions.length, 0);
  assert.ok(
    (await readFile(`${f.ledgerPath}.v1.bak`, "utf8")).includes(
      "absent-native-order",
    ),
  );
});

for (const leg of ["half", "remainder"] as const) {
  test(`ambiguous accepted-then-thrown ${leg} submission is found by stable ID instead of submitted twice`, async (t) => {
    const f = await fixture(t);
    if (leg === "remainder") {
      await seedProtected(f);
      await f.controller.initialize();
    }
    f.executor.acceptThenThrow = true;
    if (leg === "half") await beginHalf(f);
    else await f.controller.requestExit(SYMBOL, "MANUAL_CLOSE");
    await drain(f.controller);
    const intentId =
      leg === "half"
        ? state(f.controller).halfExit.clientOrderId
        : state(f.controller).exit!.clientOrderId;
    assert.equal(f.executor.submissions.length, 1);
    assert.ok(
      f.executor.orders.has(intentId),
      "broker accepted the timed-out submission",
    );
    assert.match(
      state(f.controller).lastError ?? "",
      /timeout after broker acceptance/,
    );
    f.advance(31_000);
    await f.controller.tick();
    await drain(f.controller);
    assert.equal(f.executor.submissions.length, 1);
    assert.ok(f.executor.lookups.filter((id) => id === intentId).length >= 2);
    const durable = await persisted(f);
    assert.equal(
      leg === "half"
        ? durable.halfExit.clientOrderId
        : durable.exit?.clientOrderId,
      intentId,
    );
  });
}

test("real disk write error retains in-memory risk, blocks exposure, and prevents unpersisted exit submission", async (t) => {
  const f = await fixture(t);
  await seedProtected(f);
  await f.controller.initialize();
  await drain(f.controller);
  const ledgerDirectory = path.dirname(f.ledgerPath);
  const savedDirectory = `${ledgerDirectory}.durable-backup`;
  await rename(ledgerDirectory, savedDirectory);
  await writeFile(
    ledgerDirectory,
    "File prevents mkdir: injected real filesystem failure\n",
  );
  try {
    f.price(ENTRY - 0.01);
    assert.equal(state(f.controller).exit?.reason, "ENTRY_PRICE_BACKSTOP");
    await drain(f.controller, true);
    await assert.rejects(f.controller.flush(), /EEXIST|ENOTDIR/);
    assert.equal(f.store.getPersistenceStatus().healthy, false);
    assert.equal(f.controller.isReady(), false);
    assert.equal(f.positions.blocked.has(SYMBOL), true);
    assert.equal(f.controller.manages(SYMBOL), true);
    near(state(f.controller).effectiveStop, ENTRY);
    assert.equal(f.executor.submissions.length, 0);
    assert.ok(
      f.alerts.some((alert) => alert.reason.includes("PERSISTENCE_FAILED")),
    );
    const durableStore = new TradeLifecycleStore(
      path.join(savedDirectory, path.basename(f.ledgerPath)),
    );
    assert.equal(
      (await durableStore.getOpenLifecycle(SYMBOL))?.protection?.exit,
      undefined,
      "failed intent must not appear in last durable ledger",
    );
  } finally {
    await rm(ledgerDirectory, { force: true });
    await rename(savedDirectory, ledgerDirectory);
  }
});

test("saved breach recovery and manual close share the existing live order and durable intent", async (t) => {
  const f = await fixture(t);
  await seedProtected(f);
  await f.controller.initialize();
  f.price(ENTRY - 1);
  await drain(f.controller);
  const original = state(f.controller).exit!;
  assert.equal(f.executor.submissions.length, 1);
  const recoveredStore = new TradeLifecycleStore(f.ledgerPath);
  const recovered = new RemainderProtectionController(
    recoveredStore,
    new MockPositions(f.executor),
    f.executor,
    f.broadcaster,
    undefined,
    f.now,
  );
  await recovered.initialize();
  await drain(recovered);
  await recovered.requestExit(SYMBOL, "MANUAL_CLOSE");
  await drain(recovered);
  assert.equal(state(recovered).exit?.clientOrderId, original.clientOrderId);
  assert.equal(state(recovered).exit?.reason, "ENTRY_PRICE_BACKSTOP");
  assert.equal(f.executor.submissions.length, 1);
  assert.equal(
    (await persisted(f)).exit?.clientOrderId,
    original.clientOrderId,
  );
});

test("manual close blocks ambiguous increased broker quantity instead of selling unrelated scale-in shares", async (t) => {
  const f = await fixture(t);
  await seedProtected(f);
  await f.controller.initialize();
  f.executor.quantity += 1; // Broker says 11; lifecycle can attribute only 10.
  await f.controller.requestExit(SYMBOL, "MANUAL_CLOSE");
  await drain(f.controller);
  assert.equal(f.executor.submissions.length, 0);
  assert.equal(f.positions.blocked.has(SYMBOL), true);
  assert.match(
    state(f.controller).lastError ?? "",
    /Unattributed\/scale-in quantity/,
  );
  assert.equal(state(f.controller).exit?.reason, "MANUAL_CLOSE");
  near((await persisted(f)).effectiveStop, ENTRY);
  assert.equal(
    (await persisted(f)).exit?.clientOrderId,
    state(f.controller).exit?.clientOrderId,
  );
});

test("stale, invalid, future, and out-of-order prices cannot loosen or trigger protection", async (t) => {
  const f = await fixture(t);
  await seedProtected(f);
  await f.controller.initialize();
  const initial = state(f.controller);
  assert.equal(
    f.controller.onPrice(
      SYMBOL,
      ENTRY - 1,
      new Date(f.now().getTime() - 10_001).toISOString(),
    ),
    false,
  );
  assert.equal(
    f.controller.onPrice(
      SYMBOL,
      ENTRY - 1,
      new Date(f.now().getTime() + 1_001).toISOString(),
    ),
    false,
  );
  assert.equal(
    f.controller.onPrice(SYMBOL, Number.NaN, f.now().toISOString()),
    false,
  );
  assert.equal(f.controller.onPrice(SYMBOL, 0, f.now().toISOString()), false);
  assert.equal(
    f.controller.onPrice(SYMBOL, ENTRY - 1, "invalid-timestamp"),
    false,
  );
  f.price(355);
  assert.equal(f.controller.onPrice(SYMBOL, ENTRY - 1, FIXED_NOW), false);
  await drain(f.controller);
  assert.equal(state(f.controller).exit, undefined);
  assert.equal(f.executor.submissions.length, 0);
  near(state(f.controller).highWaterMark, 355);
  assert.ok(state(f.controller).effectiveStop >= initial.effectiveStop);
});

test("saved floor remains managed and alerts when no fresh broker price is available", async (t) => {
  const f = await fixture(t);
  await seedProtected(f, { highWaterMark: 355, effectiveStop: 347.17 });
  f.executor.latestPrice = undefined;
  await f.controller.initialize();
  await drain(f.controller);
  assert.equal(f.controller.isReady(), true);
  assert.equal(f.controller.manages(SYMBOL), true);
  assert.equal(f.controller.getStatus().protections[0].priceStale, true);
  near(state(f.controller).effectiveStop, 347.17);
  assert.equal(f.executor.submissions.length, 0);
  assert.ok(
    f.alerts.some((alert) => alert.reason.includes("PRICE_STALE_OR_MISSING")),
  );
});

test("actual remainder cumulative fills are recorded before broker-zero closure, with duplicates remaining idempotent", async (t) => {
  const f = await fixture(t);
  await seedProtected(f);
  await f.controller.initialize();
  await f.controller.requestExit(SYMBOL, "MANUAL_CLOSE");
  await drain(f.controller);
  const exitId = state(f.controller).exit!.clientOrderId;
  f.executor.fill(exitId, 4, "partially_filled", 350);
  f.advance();
  await f.controller.tick();
  await drain(f.controller);
  assert.equal((await f.store.getOpenLifecycle(SYMBOL))?.exitedQuantity, 14);
  assert.equal((await f.store.getOpenLifecycle(SYMBOL))?.remainingQuantity, 6);
  const filled = f.executor.fill(exitId, 10, "filled", 350);
  f.advance();
  await f.controller.tick();
  await drain(f.controller);
  const [closed] = await new TradeLifecycleStore(f.ledgerPath).getLifecycles();
  assert.equal(closed.status, "closed");
  assert.equal(
    closed.exitedQuantity,
    20,
    "zero broker position cannot replace recording the final confirmed cumulative fill",
  );
  assert.equal(closed.remainingQuantity, 0);
  assert.equal(
    closed.exitFills
      .filter((fill) => fill.orderId === filled.id)
      .reduce((sum, fill) => sum + fill.quantity, 0),
    10,
  );
  assert.ok(
    closed.exitFills
      .filter((fill) => fill.orderId === filled.id)
      .every((fill) => fill.reason === "MANUAL_CLOSE"),
  );
  assert.equal(f.controller.manages(SYMBOL), false);
  assert.equal(f.positions.pending.has(SYMBOL), false);
  f.controller.observeOrder(SYMBOL, filled);
  f.controller.observeOrder(SYMBOL, filled);
  await drain(f.controller);
  assert.equal(f.executor.submissions.length, 1);
  assert.equal((await f.store.getLifecycles())[0].exitedQuantity, 20);
});

test("a new uncalibrated half completion activates on its first positive fresh ticker without REST pricing", async (t) => {
  const f = await fixture(t);
  const halfId = await beginHalf(f);
  f.advance(20_000);
  f.executor.latestPrice = undefined;
  f.controller.observeOrder(SYMBOL, f.executor.fill(halfId, 10));
  await drain(f.controller);
  assert.equal(state(f.controller).halfExit.completed, true);
  assert.equal(state(f.controller).trailingDistance, null);
  assert.equal(state(f.controller).activatedAt, undefined);
  f.price(ENTRY + 12);
  f.executor.latestPrice = undefined;
  await f.controller.flush();
  near(state(f.controller).trailingDistance!, 12);
  near(state(f.controller).highWaterMark, ENTRY + 12);
  near(state(f.controller).effectiveStop, ENTRY);
  assert.equal(state(f.controller).phase, "protected-remainder");
  assert.equal(state(f.controller).activationSource, "trade");
});

test("completion exactly at entry does not falsely claim activation or prevent a later positive calibration", async (t) => {
  const f = await fixture(t);
  const halfId = await beginHalf(f);
  f.price(ENTRY);
  f.controller.observeOrder(
    SYMBOL,
    f.executor.fill(halfId, 10, "filled", ENTRY),
  );
  await drain(f.controller);
  assert.equal(state(f.controller).trailingDistance, null);
  assert.equal(state(f.controller).activatedAt, undefined);
  assert.equal(state(f.controller).activationSource, undefined);
  f.price(ENTRY + 10);
  await f.controller.flush();
  near(state(f.controller).trailingDistance!, 10);
  assert.equal(state(f.controller).phase, "protected-remainder");
});

test("old protected state cannot transplant into a newly reopened lifecycle for the same symbol", async (t) => {
  const f = await fixture(t);
  await seedProtected(f);
  await f.controller.initialize();
  const oldId = (await f.store.getOpenLifecycle(SYMBOL))!.id;
  await f.store.recordFill({
    executionId: "real-old-remainder-close",
    orderId: "old-close-order",
    orderType: "market",
    side: "sell",
    symbol: SYMBOL,
    price: ENTRY,
    quantity: 10,
    filledAt: f.now().toISOString(),
    profile: PROFILE,
    reason: "MANUAL_CLOSE",
  });
  await f.store.recordFill({
    executionId: "new-entry-after-closed",
    orderId: "new-entry-order",
    orderType: "market",
    side: "buy",
    symbol: SYMBOL,
    price: 200,
    quantity: 4,
    filledAt: f.now().toISOString(),
    profile: PROFILE,
  });
  f.executor.quantity = 4;
  f.price(210);
  await drain(f.controller);
  const reopened = await new TradeLifecycleStore(f.ledgerPath).getOpenLifecycle(
    SYMBOL,
  );
  assert.notEqual(reopened?.id, oldId);
  assert.equal(
    reopened?.protection,
    undefined,
    "stale original protection must not be written to another lifecycle",
  );
  assert.equal(state(f.controller).phase, "closed");
  assert.equal(
    f.executor.submissions.length,
    0,
    "old entry floor must never sell the new holding",
  );
});

test("explicit mocked extended policy caps repricing at three replacements, then retains one intent for regular-session execution", async (t) => {
  const f = await fixture(t);
  await seedProtected(f);
  let regularSession = false;
  const originalSubmit = f.executor.submitProtectionExit.bind(f.executor);
  t.mock.method(
    f.executor,
    "submitProtectionExit",
    async (
      symbol: string,
      clientId: string,
      quantity?: number,
      options?: Submission["options"],
    ): Promise<ProtectionExecutionResult> => {
      if (!options && !regularSession)
        return {
          kind: "deferred",
          reason: "Mock waiting for the next regular session",
        };
      const result = await originalSubmit(symbol, clientId, quantity, options);
      if (
        result.kind === "submitted" ||
        result.kind === "working" ||
        result.kind === "terminal"
      ) {
        result.order.type = regularSession ? "market" : "limit";
        const saved = f.executor.orders.get(clientId);
        assert.ok(saved);
        saved.type = result.order.type;
      }
      return result;
    },
  );
  const controller = new RemainderProtectionController(
    f.store,
    f.positions,
    f.executor,
    f.broadcaster,
    {
      extendedLimitOffset: 0.02,
      maxPriceAgeMs: 10_000,
      repriceIntervalMs: 30_000,
      maxReplacements: 3,
    },
    f.now,
  );
  await controller.initialize();
  f.advance(1);
  f.executor.latestPrice = {
    price: ENTRY - 1,
    timestamp: f.now().toISOString(),
  };
  controller.onPrice(SYMBOL, ENTRY - 1, f.now().toISOString());
  await drain(controller);
  assert.equal(f.executor.submissions.length, 1);
  for (let replacement = 1; replacement <= 3; replacement += 1) {
    f.advance(31_000);
    await controller.tick();
    await drain(controller);
    assert.equal(f.executor.submissions.length, 1 + replacement);
    assert.equal(state(controller).exit?.replacements, replacement);
  }
  f.advance(31_000);
  await controller.tick();
  await drain(controller);
  assert.equal(
    f.executor.submissions.length,
    4,
    "do not submit an unlimited fourth extended replacement",
  );
  assert.equal(state(controller).phase, "remainder-exit-pending");
  const queuedId = state(controller).exit!.clientOrderId;
  assert.equal(state(controller).halfExit.completed, true);
  near(state(controller).effectiveStop, ENTRY);
  regularSession = true;
  f.advance(6_000);
  await controller.tick();
  await drain(controller);
  assert.equal(f.executor.submissions.length, 5);
  assert.equal(
    f.executor.submissions[4].clientOrderId,
    queuedId,
    "reuse the durable queued intent",
  );
  assert.equal(f.executor.orders.get(queuedId)?.type, "market");
  assert.equal(f.executor.submissions[4].requestedQuantity, 10);
});

test("a migrated in-flight legacy half order is adopted and completes without a second half-sale", async (t) => {
  const f = await fixture(t);
  await f.store.recordFill({
    executionId: "legacy-partial-two",
    orderId: "legacy-half-order",
    orderType: "limit",
    side: "sell",
    symbol: SYMBOL,
    price: ACTIVATION,
    quantity: 2,
    filledAt: FIXED_NOW,
    profile: PROFILE,
    reason: "TAKE_PROFIT_HALF",
  });
  await f.store.recordExitIntent(SYMBOL, {
    orderId: "legacy-half-order",
    reason: "TAKE_PROFIT_HALF",
    submittedAt: FIXED_NOW,
  });
  const oldRecords = await f.store.getLifecycles();
  await writeFile(
    f.ledgerPath,
    `${JSON.stringify({ version: 1, lifecycles: oldRecords })}\n`,
    "utf8",
  );
  f.executor.quantity = 18;
  f.executor.orders.set("legacy-real-client", {
    id: "legacy-half-order",
    client_order_id: "legacy-real-client",
    symbol: SYMBOL,
    side: "sell",
    type: "limit",
    status: "partially_filled",
    qty: "10",
    filled_qty: "2",
    filled_avg_price: String(ACTIVATION),
    submitted_at: FIXED_NOW,
  });
  const executor = Object.assign(f.executor, {
    async getProtectionOrderById(
      id: string,
    ): Promise<ProtectionBrokerOrder | undefined> {
      const order = [...f.executor.orders.values()].find(
        (candidate) => candidate.id === id,
      );
      return order && structuredClone(order);
    },
  });
  const store = new TradeLifecycleStore(f.ledgerPath);
  const controller = new RemainderProtectionController(
    store,
    f.positions,
    executor,
    f.broadcaster,
    undefined,
    f.now,
  );
  await controller.initialize();
  await drain(controller);
  assert.equal(state(controller).halfExit.completed, false);
  assert.equal(state(controller).halfExit.clientOrderId, "legacy-real-client");
  assert.equal(state(controller).halfExit.filledQuantity, 2);
  assert.equal(
    f.executor.submissions.length,
    0,
    "existing working half must be adopted, not duplicated",
  );
  controller.observeOrder(SYMBOL, f.executor.fill("legacy-real-client", 10));
  await drain(controller);
  assert.equal(state(controller).halfExit.completed, true);
  assert.equal(state(controller).halfExit.filledQuantity, 10);
  assert.equal(state(controller).phase, "protected-remainder");
  near(state(controller).trailingDistance!, ACTIVATION - ENTRY);
  assert.equal((await store.getOpenLifecycle(SYMBOL))?.remainingQuantity, 10);
  assert.equal(f.executor.submissions.length, 0);
  const disk = await new TradeLifecycleStore(f.ledgerPath).getOpenLifecycle(
    SYMBOL,
  );
  assert.equal(disk?.protection?.halfExit.completed, true);
});
