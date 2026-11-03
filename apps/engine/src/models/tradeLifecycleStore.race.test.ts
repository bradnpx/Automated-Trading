import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  advanceProtection,
  createHalfProtection,
  latchProtectionExit,
} from "../protectionState.js";
import { TradeLifecycleStore } from "./tradeLifecycleStore.js";

async function run(): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "protection-race-test-"),
  );
  const filepath = path.join(directory, "ledger.json");
  const store = new TradeLifecycleStore(filepath);
  const timestamp = "2026-11-03T15:00:00.000Z";
  await store.recordFill({
    executionId: "entry",
    orderId: "entry-order",
    orderType: "market",
    side: "buy",
    symbol: "TEST",
    price: 100,
    quantity: 10,
    filledAt: timestamp,
    profile: {
      strategy: "test",
      takeProfitPct: 5,
      stopLossPct: 2,
      trailingStopLoss: true,
    },
  });
  const half = createHalfProtection(100, 5, "half-client", timestamp);
  half.halfExit = { ...half.halfExit, completed: true, filledQuantity: 5 };
  const active = advanceProtection(half, 105, timestamp);
  await store.saveProtection("TEST", { ...active, revision: 20 });
  // The controller latched synchronously while a ledger fill raised its revision.
  const staleLatch = latchProtectionExit(
    active,
    "exit-client",
    "TRAILING_STOP_LOSS",
    timestamp,
  );
  const latched = (await store.saveProtection("TEST", staleLatch)).protection!;
  assert.equal(latched.revision, 21);
  assert.equal(latched.exit?.clientOrderId, "exit-client");
  assert.equal(latched.highWaterMark, 105);
  assert.equal(latched.effectiveStop, 100);
  assert.deepEqual(
    (await new TradeLifecycleStore(filepath).getOpenLifecycle("TEST"))
      ?.protection,
    latched,
  );

  const working = {
    ...latched,
    revision: latched.revision + 1,
    phase: "remainder-exit-working" as const,
    exit: {
      ...latched.exit!,
      orderId: "broker-order",
      status: "working" as const,
    },
  };
  await store.saveProtection("TEST", working);
  const retry = {
    ...working,
    revision: working.revision + 1,
    phase: "remainder-exit-pending" as const,
    exit: {
      ...working.exit,
      clientOrderId: "replacement-client",
      orderId: undefined,
      status: "pending" as const,
      replacements: 1,
    },
  };
  const saved = (await store.saveProtection("TEST", retry)).protection!;
  assert.equal(saved.phase, "remainder-exit-pending");
  assert.equal(saved.exit?.status, "pending");
  assert.equal(saved.exit?.clientOrderId, "replacement-client");
  assert.equal(saved.exit?.orderId, undefined);
  assert.equal(saved.halfExit.completed, true);
  console.log(
    "Protection store race verification passed (stale breach latch and working-to-pending ID rotation).",
  );
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : "Unknown failure"}\n`,
  );
  process.exitCode = 1;
});
