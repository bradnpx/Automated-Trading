import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rmdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RemainderProtection, TradeLifecycle } from "@my-platform/types";

import {
  advanceProtection,
  createHalfProtection,
  isProtectionBreached,
  latchProtectionExit,
} from "../protectionState.js";
import {
  LifecycleIdentityError,
  TradeLifecycleStore,
  type LifecycleFillInput,
} from "./tradeLifecycleStore.js";

const profile = {
  strategy: "bullFlagMomentum",
  takeProfitPct: 5,
  stopLossPct: 2,
  trailingStopLoss: true,
};
const time = (seconds: number) =>
  new Date(Date.UTC(2026, 10, 3, 15, 0, seconds)).toISOString();

function fill(
  executionId: string,
  side: "buy" | "sell",
  quantity: number,
  overrides: Partial<LifecycleFillInput> = {},
): LifecycleFillInput {
  return {
    executionId,
    orderId: `${side}-order`,
    orderType: "market",
    side,
    symbol: "TEST",
    price: side === "buy" ? 341.97 : 349.8,
    quantity,
    filledAt: time(side === "buy" ? 0 : 1),
    profile: { ...profile },
    ...overrides,
  };
}

async function fixture(quantity = 10) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "protection-store-test-"),
  );
  const filepath = path.join(directory, "ledger.json");
  const store = new TradeLifecycleStore(filepath);
  await store.recordFill(fill("entry", "buy", quantity));
  return { directory, filepath, store };
}

function active(): RemainderProtection {
  const state = createHalfProtection(341.97, 5, "half-client", time(0));
  state.halfExit = {
    ...state.halfExit,
    orderId: "half-order",
    filledQuantity: 5,
    orderFilledQuantity: 5,
    completed: true,
  };
  return advanceProtection(state, 349.8, time(2));
}

async function snapshot(
  filepath: string,
): Promise<{ version: number; lifecycles: TradeLifecycle[] }> {
  const parsed: unknown = JSON.parse(await readFile(filepath, "utf8"));
  assert.ok(
    typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      "lifecycles" in parsed,
  );
  assert.ok(
    typeof parsed.version === "number" && Array.isArray(parsed.lifecycles),
  );
  return parsed as { version: number; lifecycles: TradeLifecycle[] };
}

let passed = 0;
async function test(
  name: string,
  operation: () => Promise<void>,
): Promise<void> {
  await operation();
  passed += 1;
  console.log(`PASS ${name}`);
}

async function run(): Promise<void> {
  await test("actual disk restart preserves raised stop, fixed distance, latched recovery, and working exit", async () => {
    const { store, filepath } = await fixture();
    const raised = advanceProtection(active(), 355, time(3));
    await store.saveProtection("TEST", raised);
    const restarted = new TradeLifecycleStore(filepath);
    const recovered = (await restarted.getOpenLifecycle("TEST"))?.protection;
    assert.ok(recovered);
    assert.deepEqual(recovered, raised);
    const lower = advanceProtection(recovered, 350, time(4));
    assert.equal(lower.highWaterMark, 355);
    assert.equal(lower.effectiveStop, raised.effectiveStop);
    assert.equal(lower.trailingDistance, raised.trailingDistance);
    assert.equal(isProtectionBreached(lower, 347), true);
    const exit = latchProtectionExit(
      lower,
      "stable-exit",
      "TRAILING_STOP_LOSS",
      time(5),
    );
    await restarted.saveProtection("TEST", exit);
    const restartAfterBreach = new TradeLifecycleStore(filepath);
    const breachState = (await restartAfterBreach.getOpenLifecycle("TEST"))
      ?.protection;
    assert.ok(breachState);
    const priceRecovered = advanceProtection(breachState, 354, time(6));
    assert.equal(priceRecovered.exit?.clientOrderId, "stable-exit");
    const working: RemainderProtection = {
      ...priceRecovered,
      revision: priceRecovered.revision + 1,
      phase: "remainder-exit-working",
      exit: {
        ...exit.exit!,
        status: "working",
        orderId: "broker-exit",
        submittedAt: time(6),
      },
    };
    await restartAfterBreach.saveProtection("TEST", working);
    assert.equal(
      (await new TradeLifecycleStore(filepath).getOpenLifecycle("TEST"))
        ?.protection?.exit?.orderId,
      "broker-exit",
    );
    await restartAfterBreach.markBrokerClosed("TEST");
    assert.equal(
      await new TradeLifecycleStore(filepath).getOpenLifecycle("TEST"),
      undefined,
    );
    const closed = (await restartAfterBreach.getLifecycles())[0];
    assert.equal(closed.protection?.phase, "closed");
    assert.equal(closed.protection?.halfExit.completed, true);
    assert.equal(closed.protection?.exit, undefined);
    assert.equal(
      closed.exitFills.length,
      0,
      "Broker closure must not invent execution fills",
    );
  });

  await test("queued close/reopen rejects stale identity writes atomically and leaves the new disk ledger unprotected", async () => {
    const { store, filepath } = await fixture();
    const old = (await store.getOpenLifecycle("TEST"))!;
    const state = active();
    await store.saveProtection("TEST", state, old.id);
    // All four calls enter the real mutation queue without waiting for the
    // close/reopen to finish. The ID must be checked inside that queue.
    const results = await Promise.allSettled([
      store.markBrokerClosed("TEST", old.id),
      store.recordFill(
        fill("new-entry", "buy", 10, {
          orderId: "new-entry-order",
          filledAt: time(10),
        }),
      ),
      store.saveProtection("TEST", state, old.id),
      store.markBrokerClosed("TEST", old.id),
    ]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "fulfilled");
    for (const result of results.slice(2)) {
      assert.equal(result.status, "rejected");
      if (result.status !== "rejected")
        throw new Error("Stale write succeeded");
      assert.ok(result.reason instanceof LifecycleIdentityError);
      assert.equal(result.reason.expectedLifecycleId, old.id);
      assert.equal(result.reason.actualLifecycleId, "trade:new-entry");
    }
    const current = (await store.getOpenLifecycle("TEST"))!;
    assert.equal(current.id, "trade:new-entry");
    assert.equal(current.status, "open");
    assert.equal(current.remainingQuantity, 10);
    assert.equal(current.protection, undefined);
    const restarted = new TradeLifecycleStore(filepath);
    assert.deepEqual(await restarted.getOpenLifecycle("TEST"), current);
    const ledger = await snapshot(filepath);
    assert.equal(ledger.lifecycles.length, 2);
    assert.equal(
      ledger.lifecycles.find((item) => item.id === old.id)?.status,
      "closed",
    );
    assert.equal(
      ledger.lifecycles.find((item) => item.id === current.id)?.protection,
      undefined,
    );
    const unchangedDisk = await readFile(filepath, "utf8");
    await assert.rejects(
      store.saveProtection("TEST", state, old.id),
      LifecycleIdentityError,
    );
    await assert.rejects(
      store.markBrokerClosed("TEST", old.id),
      LifecycleIdentityError,
    );
    assert.equal(await readFile(filepath, "utf8"), unchangedDisk);
    await store.markBrokerClosed("TEST", current.id);
    await assert.rejects(
      store.saveProtection("TEST", state, current.id),
      (error: unknown) =>
        error instanceof LifecycleIdentityError &&
        error.actualLifecycleId === undefined,
    );
    await assert.rejects(
      store.markBrokerClosed("TEST", current.id),
      LifecycleIdentityError,
    );
    await store.markBrokerClosed("TEST"); // Original optional-argument no-op remains supported.
  });

  await test("deep clones isolate caller input, returned lifecycle, nested half state, exit, fills, and profile", async () => {
    const { store } = await fixture();
    const state = latchProtectionExit(active(), "exit", "EXIT", time(4));
    const saved = await store.saveProtection("TEST", state);
    state.halfExit.filledQuantity = 999;
    state.exit!.attempt = 999;
    saved.protection!.halfExit.clientOrderId = "mutated";
    saved.protection!.exit!.clientOrderId = "mutated";
    saved.entryFills[0].quantity = 999;
    saved.profile.strategy = "mutated";
    const lifecycle = (await store.getLifecycles())[0];
    assert.equal(lifecycle.entryFills[0].quantity, 10);
    assert.equal(lifecycle.profile.strategy, profile.strategy);
    assert.equal(lifecycle.protection?.halfExit.clientOrderId, "half-client");
    assert.equal(lifecycle.protection?.halfExit.filledQuantity, 5);
    assert.equal(lifecycle.protection?.exit?.attempt, 0);
    const incoming = fill("later-entry", "buy", 1, { orderId: "scale-in" });
    const promise = store.recordFill(incoming);
    incoming.profile.strategy = "mutated";
    incoming.quantity = 999;
    const recorded = await promise;
    assert.equal(recorded.lifecycle?.entryQuantity, 11);
    assert.equal(
      recorded.lifecycle?.protection?.entryPrice,
      341.97,
      "Scale-ins cannot reset the original floor",
    );
  });

  await test("queued concurrent and stale updates never regress high, stop, revision, completion, or latched intent", async () => {
    const { store, filepath } = await fixture();
    const initial = active();
    await store.saveProtection("TEST", initial);
    const high = { ...advanceProtection(initial, 355, time(3)), revision: 10 };
    const stale = { ...initial, revision: 9, highWaterMark: 999 };
    await Promise.all([
      store.saveProtection("TEST", high),
      store.saveProtection("TEST", stale),
    ]);
    const sameRevisionHigher = { ...high, highWaterMark: 356 };
    await store.saveProtection("TEST", sameRevisionHigher);
    let current = (await store.getOpenLifecycle("TEST"))?.protection;
    assert.ok(current);
    assert.equal(current.highWaterMark, 356);
    assert.equal(current.revision, 11);
    const regressing: RemainderProtection = {
      ...initial,
      revision: 12,
      phase: "recovery-required",
      highWaterMark: 342,
      effectiveStop: 341.97,
      halfExit: {
        ...initial.halfExit,
        completed: false,
        filledQuantity: 1,
        orderFilledQuantity: 1,
      },
    };
    const merged = (await store.saveProtection("TEST", regressing)).protection!;
    assert.equal(merged.highWaterMark, current.highWaterMark);
    assert.equal(merged.effectiveStop, current.effectiveStop);
    assert.equal(merged.halfExit.completed, true);
    assert.equal(merged.halfExit.filledQuantity, 5);
    const latched = latchProtectionExit(merged, "stable", "EXIT", time(4));
    await store.saveProtection("TEST", latched);
    const omission = {
      ...latched,
      revision: latched.revision + 1,
      phase: "protected-remainder" as const,
      exit: undefined,
    };
    await store.saveProtection("TEST", omission);
    current = (await store.getOpenLifecycle("TEST"))?.protection;
    assert.equal(current?.exit?.clientOrderId, "stable");
    const duplicate = await store.saveProtection("TEST", current!);
    assert.equal(duplicate.protection?.revision, current?.revision);
    assert.deepEqual(
      (await new TradeLifecycleStore(filepath).getOpenLifecycle("TEST"))
        ?.protection,
      current,
    );
    await assert.rejects(
      store.saveProtection("MISSING", initial),
      /No open lifecycle/,
    );
    await assert.rejects(
      store.saveProtection("TEST", {
        ...current!,
        revision: current!.revision + 1,
        trailingDistance: 1,
      }),
      /recalibrate/,
    );
  });

  await test("write/rename failure retains in-memory risk, old disk snapshot, degraded status, and same-revision retry", async () => {
    const { store, filepath } = await fixture();
    await store.saveProtection("TEST", active());
    const original = await readFile(filepath, "utf8");
    const preserved = `${filepath}.preserved`;
    await rename(filepath, preserved);
    await mkdir(filepath);
    const raised = advanceProtection(active(), 355, time(3));
    await assert.rejects(store.saveProtection("TEST", raised));
    assert.equal(store.getPersistenceStatus().healthy, false);
    assert.ok(store.getPersistenceStatus().lastError);
    const status = store.getPersistenceStatus();
    status.healthy = true;
    assert.equal(store.getPersistenceStatus().healthy, false);
    assert.equal(
      (await store.getOpenLifecycle("TEST"))?.protection?.highWaterMark,
      355,
    );
    assert.equal(await readFile(preserved, "utf8"), original);
    await rmdir(filepath);
    await rename(preserved, filepath);
    await store.saveProtection("TEST", raised);
    assert.deepEqual(store.getPersistenceStatus(), { healthy: true });
    assert.deepEqual(
      (await new TradeLifecycleStore(filepath).getOpenLifecycle("TEST"))
        ?.protection,
      raised,
    );
    // A stray/interrupted temporary write must not replace the committed ledger.
    await writeFile(`${filepath}.tmp`, "{interrupted");
    assert.deepEqual(
      (await new TradeLifecycleStore(filepath).getOpenLifecycle("TEST"))
        ?.protection,
      raised,
    );
  });

  await test("corrupt JSON, invalid records/protection, unsupported versions, and unreadable ledgers throw without erasure", async () => {
    const { filepath, directory } = await fixture();
    const good = await snapshot(filepath);
    const badProtection = {
      ...good.lifecycles[0],
      protection: { ...active(), effectiveStop: 1 },
    };
    for (const invalid of [
      "{not-json",
      JSON.stringify({ version: 99, lifecycles: [] }),
      JSON.stringify({
        ...good,
        lifecycles: [...good.lifecycles, { id: "broken" }],
      }),
      JSON.stringify({ ...good, lifecycles: [badProtection] }),
      JSON.stringify({
        ...good,
        lifecycles: [good.lifecycles[0], good.lifecycles[0]],
      }),
    ]) {
      await writeFile(filepath, invalid);
      const broken = new TradeLifecycleStore(filepath);
      await assert.rejects(broken.init());
      assert.equal(broken.getPersistenceStatus().healthy, false);
      await assert.rejects(broken.recordFill(fill("another", "buy", 1)));
      assert.equal(await readFile(filepath, "utf8"), invalid);
    }
    const unreadable = new TradeLifecycleStore(directory);
    await assert.rejects(unreadable.init());
    assert.equal(unreadable.getPersistenceStatus().healthy, false);
    const missing = new TradeLifecycleStore(
      path.join(directory, "missing.json"),
    );
    assert.deepEqual(await missing.getLifecycles(), []);
  });

  await test("v1 confirmed half migration backs up exact contents, requires calibration, and does not invent highs", async () => {
    const { store, filepath } = await fixture();
    await store.recordFill(
      fill("half-fill", "sell", 5, {
        orderId: "half-order",
        reason: "TAKE_PROFIT_HALF",
      }),
    );
    const prior = await snapshot(filepath);
    const contents = `${JSON.stringify({ ...prior, version: 1 }, null, 2)}\n`;
    await writeFile(filepath, contents);
    const migrated = new TradeLifecycleStore(filepath);
    const lifecycle = await migrated.getOpenLifecycle("TEST");
    const protection = lifecycle?.protection;
    assert.ok(protection);
    assert.equal(await readFile(`${filepath}.v1.bak`, "utf8"), contents);
    assert.equal((await snapshot(filepath)).version, 2);
    assert.equal(protection.phase, "recovery-required");
    assert.equal(protection.calibrationRequired, true);
    assert.equal(protection.trailingDistance, null);
    assert.equal(protection.highWaterMark, 341.97);
    assert.equal(protection.effectiveStop, 341.97);
    assert.equal(protection.halfExit.completed, true);
    assert.equal(protection.halfExit.filledQuantity, 5);
    assert.equal(protection.halfExit.orderFilledQuantity, 5);
    assert.equal(protection.activatedAt, undefined);
    assert.equal(
      advanceProtection(protection, 355, time(5)).trailingDistance,
      null,
    );
    const fresh = await new TradeLifecycleStore(filepath).getOpenLifecycle(
      "TEST",
    );
    assert.deepEqual(fresh?.protection, protection);
  });

  await test("v1 pending half orders preserve 0/5 and 2/5 confirmed fills and complete into local protection without another half", async () => {
    for (const quantity of [0, 2]) {
      const { store, filepath } = await fixture();
      await store.recordExitIntent("TEST", {
        orderId: "legacy-broker-half",
        reason: "TAKE_PROFIT_HALF",
        submittedAt: time(1),
      });
      if (quantity > 0)
        await store.recordFill(
          fill("legacy-partial", "sell", quantity, {
            orderId: "legacy-broker-half",
          }),
        );
      const prior = await snapshot(filepath);
      await writeFile(filepath, JSON.stringify({ ...prior, version: 1 }));
      const migrated = new TradeLifecycleStore(filepath);
      let lifecycle = (await migrated.getOpenLifecycle("TEST"))!;
      let protection = lifecycle.protection!;
      assert.ok(protection);
      assert.equal(
        lifecycle.status,
        quantity === 0 ? "open" : "partially_closed",
      );
      assert.equal(protection.phase, "half-exit-working");
      assert.equal(protection.calibrationRequired, false);
      assert.equal(protection.legacyHalfOrder, true);
      assert.ok(protection.halfExit.clientOrderId.startsWith("legacy-half:"));
      assert.equal(protection.halfExit.orderId, "legacy-broker-half");
      assert.equal(protection.halfExit.targetQuantity, 5);
      assert.equal(protection.halfExit.filledQuantity, quantity);
      assert.equal(protection.halfExit.orderFilledQuantity, quantity);
      assert.equal(protection.halfExit.completed, false);
      assert.equal(protection.trailingDistance, null);
      assert.equal(protection.activatedAt, undefined);
      assert.equal(protection.effectiveStop, lifecycle.averageEntryPrice);
      assert.deepEqual(
        (await new TradeLifecycleStore(filepath).getOpenLifecycle("TEST"))
          ?.protection,
        protection,
      );
      // A cumulative broker observation attributes only the new fills to the
      // saved legacy broker order. It must not start a second five-share sale.
      await migrated.recordFill(
        fill("legacy-complete", "sell", 5, {
          orderId: "legacy-broker-half",
          cumulativeQuantity: 5,
          filledAt: time(2),
        }),
      );
      lifecycle = (await migrated.getOpenLifecycle("TEST"))!;
      protection = lifecycle.protection!;
      assert.equal(lifecycle.remainingQuantity, 5);
      assert.equal(protection.halfExit.filledQuantity, 5);
      assert.equal(protection.halfExit.orderFilledQuantity, 5);
      assert.equal(protection.halfExit.completed, true);
      assert.equal(protection.calibrationRequired, false);
      const localProtection = advanceProtection(protection, 349.8, time(3));
      assert.equal(localProtection.phase, "protected-remainder");
      assert.ok(localProtection.trailingDistance! > 0);
      assert.equal(localProtection.halfExit.orderId, "legacy-broker-half");
      assert.equal(localProtection.halfExit.targetQuantity, 5);
      await migrated.saveProtection("TEST", localProtection, lifecycle.id);
      assert.deepEqual(
        (await new TradeLifecycleStore(filepath).getOpenLifecycle("TEST"))
          ?.protection,
        localProtection,
      );
    }
  });

  await test("v1 ordinary partial sales and incomplete half fills are not inferred to be completed half-outs", async () => {
    for (const [quantity, reason] of [
      [5, "MANUAL_CLOSE"],
      [5, "EXIT"],
      [1, "TAKE_PROFIT_HALF"],
    ] as const) {
      const { store, filepath } = await fixture();
      await store.recordFill(fill("partial", "sell", quantity, { reason }));
      const prior = await snapshot(filepath);
      await writeFile(filepath, JSON.stringify({ ...prior, version: 1 }));
      const recovered = await new TradeLifecycleStore(
        filepath,
      ).getOpenLifecycle("TEST");
      assert.equal(recovered?.status, "partially_closed");
      assert.equal(recovered?.protection, undefined);
    }
  });

  await test("v1 native order evidence migrates conservatively and migration backup failure preserves v1", async () => {
    const { store, filepath } = await fixture();
    await store.recordFill(
      fill("manual-partial", "sell", 5, { reason: "EXIT" }),
    );
    await store.activateTrailingStop("TEST", "native-id", time(2));
    const prior = await snapshot(filepath);
    const original = JSON.stringify({ ...prior, version: 1 });
    await writeFile(filepath, original);
    await mkdir(`${filepath}.v1.bak`);
    const failed = new TradeLifecycleStore(filepath);
    await assert.rejects(failed.init());
    assert.equal(await readFile(filepath, "utf8"), original);
    assert.equal(failed.getPersistenceStatus().healthy, false);
    await rmdir(`${filepath}.v1.bak`);
    const migrated = await new TradeLifecycleStore(filepath).getOpenLifecycle(
      "TEST",
    );
    assert.equal(migrated?.protection?.nativeOrderId, "native-id");
    assert.equal(migrated?.protection?.halfExit.completed, true);
    assert.equal(
      migrated?.protection?.halfExit.filledQuantity,
      0,
      "Migration cannot invent fills",
    );
    assert.equal(migrated?.protection?.calibrationRequired, true);
  });

  await test("snapshot cumulative fills add only nonduplicated delta and retain execution-ID dedup", async () => {
    const { store, filepath } = await fixture();
    await store.recordFill(
      fill("stream-1", "sell", 2, {
        orderId: "partial-order",
        reason: "TAKE_PROFIT_HALF",
      }),
    );
    await store.recordFill(
      fill("snapshot-1", "sell", 3, {
        orderId: "partial-order",
        cumulativeQuantity: 3,
        reason: "TAKE_PROFIT_HALF",
      }),
    );
    assert.equal((await store.getOpenLifecycle("TEST"))?.exitedQuantity, 3);
    assert.equal(
      (await store.getOpenLifecycle("TEST"))?.exitFills[1].quantity,
      1,
    );
    const duplicateTotal = await store.recordFill(
      fill("snapshot-duplicate", "sell", 3, {
        orderId: "partial-order",
        cumulativeQuantity: 3,
      }),
    );
    assert.equal(duplicateTotal.recorded, false);
    const older = await store.recordFill(
      fill("snapshot-old", "sell", 2, {
        orderId: "partial-order",
        cumulativeQuantity: 2,
      }),
    );
    assert.equal(older.recorded, false);
    const executionDuplicate = await store.recordFill(
      fill("stream-1", "sell", 5, {
        orderId: "partial-order",
        cumulativeQuantity: 5,
      }),
    );
    assert.equal(executionDuplicate.recorded, false);
    await store.recordFill(
      fill("snapshot-2", "sell", 5, {
        orderId: "partial-order",
        cumulativeQuantity: 5,
      }),
    );
    const recovered = await new TradeLifecycleStore(filepath).getOpenLifecycle(
      "TEST",
    );
    assert.equal(recovered?.remainingQuantity, 5);
    assert.equal(recovered?.exitedQuantity, 5);
    assert.equal(recovered?.exitFills.length, 3);
    await assert.rejects(store.recordFill(fill("bad", "sell", Infinity)));
    await assert.rejects(
      store.recordFill(fill("bad", "sell", 1, { cumulativeQuantity: NaN })),
    );
  });

  await test("changing cumulative broker averages preserve exact order proceeds and entry cost basis", async () => {
    const { store, filepath } = await fixture();
    await store.recordFill(
      fill("price-stream", "sell", 2, { price: 350, orderId: "price-order" }),
    );
    await store.recordFill(
      fill("price-snapshot", "sell", 5, {
        price: 352,
        orderId: "price-order",
        cumulativeQuantity: 5,
        cumulativePrice: true,
      }),
    );
    const sold = await new TradeLifecycleStore(filepath).getOpenLifecycle(
      "TEST",
    );
    assert.ok(sold);
    assert.equal(sold.exitedQuantity, 5);
    assert.equal(sold.averageExitPrice, 352);
    const proceeds = sold.exitFills.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );
    assert.equal(proceeds, 5 * 352);
    assert.ok(
      Math.abs(sold.realizedPnl - (5 * 352 - 5 * sold.averageEntryPrice)) <
        1e-9,
    );
    await assert.rejects(
      store.recordFill(
        fill("missing-total", "sell", 1, { cumulativePrice: true }),
      ),
      /requires cumulative quantity/,
    );
    await assert.rejects(
      store.recordFill(
        fill("invalid-delta-price", "sell", 6, {
          price: 1,
          orderId: "price-order",
          cumulativeQuantity: 6,
          cumulativePrice: true,
        }),
      ),
      /invalid incremental price/,
    );
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "cumulative-entry-test-"),
    );
    const bought = new TradeLifecycleStore(path.join(directory, "ledger.json"));
    await bought.recordFill(fill("buy-1", "buy", 2, { price: 100 }));
    await bought.recordFill(
      fill("buy-2", "buy", 5, {
        price: 102,
        cumulativeQuantity: 5,
        cumulativePrice: true,
      }),
    );
    assert.equal(
      (await bought.getOpenLifecycle("TEST"))?.averageEntryPrice,
      102,
    );
  });

  await test("half fills accumulate across legitimate replacement IDs without double-counting controller observations", async () => {
    const { store, filepath } = await fixture();
    let state = createHalfProtection(341.97, 5, "half-client-1", time(0));
    state.halfExit.orderId = "half-order-1";
    await store.saveProtection("TEST", state);
    await store.recordFill(
      fill("half-1", "sell", 2, {
        orderId: "half-order-1",
        cumulativeQuantity: 2,
      }),
    );
    state = (await store.getOpenLifecycle("TEST"))!.protection!;
    assert.equal(state.halfExit.filledQuantity, 2);
    assert.equal(state.halfExit.orderFilledQuantity, 2);
    const rotated: RemainderProtection = {
      ...state,
      revision: state.revision + 1,
      halfExit: {
        ...state.halfExit,
        clientOrderId: "half-client-2",
        orderId: "half-order-2",
        orderFilledQuantity: 0,
      },
    };
    await store.saveProtection("TEST", rotated);
    await store.recordFill(
      fill("half-2", "sell", 1, {
        orderId: "half-order-2",
        cumulativeQuantity: 1,
      }),
    );
    state = (await store.getOpenLifecycle("TEST"))!.protection!;
    assert.equal(state.halfExit.filledQuantity, 3);
    // The controller has already observed the next two shares before ledger reconciliation.
    const observed = {
      ...state,
      revision: state.revision + 1,
      halfExit: {
        ...state.halfExit,
        filledQuantity: 5,
        orderFilledQuantity: 3,
        completed: true,
      },
    };
    await store.saveProtection("TEST", observed);
    await store.recordFill(
      fill("half-3", "sell", 3, {
        orderId: "half-order-2",
        cumulativeQuantity: 3,
      }),
    );
    state = (await store.getOpenLifecycle("TEST"))!.protection!;
    assert.equal(state.halfExit.filledQuantity, 5);
    assert.equal(state.halfExit.completed, true);
    assert.equal((await store.getOpenLifecycle("TEST"))?.exitedQuantity, 5);
    const protectedState = advanceProtection(
      { ...state, phase: "half-exit-working" },
      349.8,
      time(5),
    );
    const exit = latchProtectionExit(
      protectedState,
      "exit-client",
      "ENTRY_PRICE_BACKSTOP",
      time(6),
    );
    exit.exit!.orderId = "exit-order";
    await store.saveProtection("TEST", exit);
    await store.clearExitIntent("exit-order");
    assert.equal(
      (await store.getOpenLifecycle("TEST"))?.protection?.exit?.clientOrderId,
      "exit-client",
    );
    assert.equal(
      (await store.getOpenLifecycle("TEST"))?.protection?.halfExit.completed,
      true,
    );
    const replacement = {
      ...exit,
      revision: exit.revision + 1,
      exit: {
        ...exit.exit!,
        clientOrderId: "replacement-exit",
        orderId: undefined,
        replacements: 1,
      },
    };
    await store.saveProtection("TEST", replacement);
    assert.equal(
      (await store.getOpenLifecycle("TEST"))?.protection?.exit?.orderId,
      undefined,
    );
    assert.equal(
      (await new TradeLifecycleStore(filepath).getOpenLifecycle("TEST"))
        ?.protection?.exit?.clientOrderId,
      "replacement-exit",
    );
  });

  await test("fractional dust above 1e-9 remains open while <=1e-9 residual closes", async () => {
    const largeDust = await fixture(1);
    await largeDust.store.recordFill(fill("sell-dust", "sell", 0.9999995));
    assert.equal(
      (await largeDust.store.getOpenLifecycle("TEST"))?.status,
      "partially_closed",
    );
    assert.ok(
      (await largeDust.store.getOpenLifecycle("TEST"))!.remainingQuantity >
        1e-9,
    );
    const tinyDust = await fixture(1);
    await tinyDust.store.recordFill(
      fill("sell-tiny-dust", "sell", 0.9999999995),
    );
    assert.equal(await tinyDust.store.getOpenLifecycle("TEST"), undefined);
    assert.equal(
      (await new TradeLifecycleStore(tinyDust.filepath).getLifecycles())[0]
        .status,
      "closed",
    );
  });

  console.log(
    `Trade lifecycle protection verification passed (${passed} focused actual-disk scenarios).`,
  );
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : "Unknown failure"}\n`,
  );
  process.exitCode = 1;
});
