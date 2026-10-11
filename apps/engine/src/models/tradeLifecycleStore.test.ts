import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  LifecycleFillInput,
  TradeLifecycleStore,
} from "./tradeLifecycleStore.js";

const profile = {
  strategy: "bullFlagMomentum",
  takeProfitPct: 5,
  stopLossPct: 2,
  trailingStopLoss: true,
};

async function run(): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "lifecycle-store-test-"),
  );
  const storePath = path.join(directory, "trade-lifecycles.json");
  const store = new TradeLifecycleStore(storePath);

  await store.recordFill(fill("execution-buy", "order-buy", "buy", 100, 10));
  await store.recordExitIntent("TEST", {
    orderId: "order-take-profit",
    reason: "TAKE_PROFIT_HALF",
    submittedAt: "2026-09-24T14:01:00.000Z",
  });
  await store.recordFill(
    fill("execution-take-profit", "order-take-profit", "sell", 50, 11, "limit"),
  );

  const restartedStore = new TradeLifecycleStore(storePath);
  const [recoveredLifecycle] = await restartedStore.getOpenLifecycles();
  assert.ok(recoveredLifecycle);
  assert.equal(recoveredLifecycle.status, "partially_closed");
  assert.equal(recoveredLifecycle.remainingQuantity, 50);
  assert.equal(recoveredLifecycle.exitFills.length, 1);

  await store.activateTrailingStop(
    "TEST",
    "order-trailing-stop",
    "2026-09-24T14:02:00.000Z",
  );
  await store.recordFill(
    fill(
      "execution-trailing-stop",
      "order-trailing-stop",
      "sell",
      50,
      10.5,
      "trailing_stop",
    ),
  );
  await store.recordFill(
    fill(
      "execution-trailing-stop",
      "order-trailing-stop",
      "sell",
      50,
      10.5,
      "trailing_stop",
    ),
  );

  const reloadedStore = new TradeLifecycleStore(storePath);
  const lifecycles = await reloadedStore.getLifecycles();
  assert.equal(lifecycles.length, 1);

  const lifecycle = lifecycles[0];
  assert.equal(lifecycle.status, "closed");
  assert.equal(lifecycle.entryQuantity, 100);
  assert.equal(lifecycle.exitedQuantity, 100);
  assert.equal(lifecycle.remainingQuantity, 0);
  assert.equal(lifecycle.entryFills.length, 1);
  assert.equal(lifecycle.exitFills.length, 2);
  assert.equal(lifecycle.averageEntryPrice, 10);
  assert.equal(lifecycle.averageExitPrice, 10.75);
  assert.equal(lifecycle.realizedPnl, 75);
  assert.equal(lifecycle.exitFills[0].reason, "TAKE_PROFIT_HALF");
  assert.equal(lifecycle.exitFills[1].reason, "TRAILING_STOP_LOSS");

  const persisted = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.lifecycles.length, 1);
  console.log("Trade lifecycle persistence verification passed.");
}

function fill(
  executionId: string,
  orderId: string,
  side: "buy" | "sell",
  quantity: number,
  price: number,
  orderType = "market",
): LifecycleFillInput {
  return {
    executionId,
    orderId,
    orderType,
    side,
    symbol: "TEST",
    price,
    quantity,
    filledAt: `2026-09-24T14:0${side === "buy" ? "0" : "3"}:00.000Z`,
    profile,
    ...(side === "sell" && orderType === "trailing_stop"
      ? { reason: "TRAILING_STOP_LOSS" as const }
      : side === "sell"
        ? { reason: "TAKE_PROFIT_HALF" as const }
        : {}),
  };
}

void run().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : "Unknown error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
