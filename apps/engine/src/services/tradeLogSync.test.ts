import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TradeJournal } from "../middleware/logger.js";
import { TradeLifecycleStore } from "../models/tradeLifecycleStore.js";
import { TradeLogSyncService } from "./tradeLogSync.js";

const profile = {
  strategy: "bullFlagMomentum",
  takeProfitPct: 5,
  stopLossPct: 2,
  trailingStopLoss: true,
};

async function run(): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "trade-log-sync-test-"),
  );
  const lifecycleStore = new TradeLifecycleStore(
    path.join(directory, "trade-lifecycles.json"),
  );
  const journal = new TradeJournal(path.join(directory, "trades.json"));
  const syncTime = new Date("2026-10-16T15:00:00.000Z");
  let getOrdersCalls = 0;

  await lifecycleStore.recordFill({
    executionId: "local-entry-execution",
    orderId: "alpaca-entry-order",
    orderType: "market",
    side: "buy",
    symbol: "AAPL",
    price: 99,
    quantity: 5,
    filledAt: "2026-10-16T14:00:00.000Z",
    profile,
  });
  await lifecycleStore.recordExitIntent("AAPL", {
    orderId: "alpaca-exit-order",
    reason: "TAKE_PROFIT_HALF",
    submittedAt: "2026-10-16T14:04:00.000Z",
  });
  await lifecycleStore.recordFill({
    executionId: "local-exit-execution",
    orderId: "alpaca-exit-order",
    orderType: "limit",
    side: "sell",
    symbol: "AAPL",
    price: 108,
    quantity: 5,
    filledAt: "2026-10-16T14:05:00.000Z",
    profile,
    reason: "TAKE_PROFIT_HALF",
  });
  await journal.logTrade({
    symbol: "AAPL",
    side: "buy",
    qty: "5",
    price: "99",
    lifecycle_id: "trade:local-entry-execution",
    order_id: "alpaca-entry-order",
    execution_id: "local-entry-execution",
    order_type: "market",
    strategy: profile.strategy,
    take_profit_pct: profile.takeProfitPct,
    stop_loss_pct: profile.stopLossPct,
    trailing_stop_loss: profile.trailingStopLoss,
    pnl: 0,
    pnl_pct: 0,
    timestamp: "2026-10-16T14:00:00.000Z",
    reason: profile.strategy,
    win_status: "OPENING",
  });
  await journal.logTrade({
    symbol: "AAPL",
    side: "sell",
    qty: "5",
    price: "108",
    lifecycle_id: "trade:local-entry-execution",
    order_id: "alpaca-exit-order",
    execution_id: "local-exit-execution",
    order_type: "limit",
    strategy: profile.strategy,
    take_profit_pct: profile.takeProfitPct,
    stop_loss_pct: profile.stopLossPct,
    trailing_stop_loss: profile.trailingStopLoss,
    pnl: 45,
    pnl_pct: 0.09,
    timestamp: "2026-10-16T14:05:00.000Z",
    reason: "TAKE_PROFIT_HALF",
    win_status: "WIN",
  });
  await lifecycleStore.recordFill({
    executionId: "stale-execution",
    orderId: "stale-broker-order",
    orderType: "market",
    side: "buy",
    symbol: "MSFT",
    price: 300,
    quantity: 1,
    filledAt: "2026-10-16T13:00:00.000Z",
    profile,
  });
  await journal.logTrade({
    symbol: "MSFT",
    side: "buy",
    qty: "1",
    price: "300",
    lifecycle_id: "trade:stale-execution",
    order_id: "stale-broker-order",
    execution_id: "stale-execution",
    order_type: "market",
    strategy: profile.strategy,
    take_profit_pct: profile.takeProfitPct,
    stop_loss_pct: profile.stopLossPct,
    trailing_stop_loss: profile.trailingStopLoss,
    pnl: 0,
    pnl_pct: 0,
    timestamp: "2026-10-16T13:00:00.000Z",
    reason: profile.strategy,
    win_status: "OPENING",
  });

  const alpaca = {
    async getOrders() {
      getOrdersCalls += 1;
      return [
        {
          id: "alpaca-entry-order",
          symbol: "AAPL",
          side: "buy",
          type: "market",
          filled_qty: "10",
          filled_avg_price: "100",
          filled_at: "2026-10-16T14:00:00.000Z",
          submitted_at: "2026-10-16T13:59:59.000Z",
        },
        {
          id: "alpaca-exit-order",
          symbol: "AAPL",
          side: "sell",
          type: "limit",
          filled_qty: "5",
          filled_avg_price: "110",
          filled_at: "2026-10-16T14:05:00.000Z",
          submitted_at: "2026-10-16T14:04:00.000Z",
        },
        {
          id: "alpaca-trailing-order",
          symbol: "AAPL",
          side: "sell",
          type: "trailing_stop",
          filled_qty: "5",
          filled_avg_price: "105",
          filled_at: "2026-10-16T14:10:00.000Z",
          submitted_at: "2026-10-16T14:06:00.000Z",
        },
      ];
    },
  };

  const service = new TradeLogSyncService(alpaca, lifecycleStore, journal, 24, {
    now: () => syncTime,
  });
  const summary = await service.syncIfDue();

  assert.deepEqual(summary, {
    syncedAt: syncTime.toISOString(),
    fetchedOrders: 3,
    reconciledOrders: 3,
  });
  assert.equal(getOrdersCalls, 1);

  const lifecycles = await lifecycleStore.getLifecycles();
  assert.equal(lifecycles.length, 1);
  const [lifecycle] = lifecycles;
  assert.ok(lifecycle);
  assert.equal(lifecycle.status, "closed");
  assert.equal(lifecycle.entryQuantity, 10);
  assert.equal(lifecycle.exitedQuantity, 10);
  assert.equal(lifecycle.averageEntryPrice, 100);
  assert.equal(lifecycle.averageExitPrice, 107.5);
  assert.equal(lifecycle.realizedPnl, 75);
  assert.equal(lifecycle.profile.strategy, profile.strategy);
  assert.equal(
    lifecycle.exitFills.find((fill) => fill.orderId === "alpaca-exit-order")
      ?.reason,
    "TAKE_PROFIT_HALF",
  );
  assert.equal(
    await lifecycleStore.getLastTradeLogSyncAt(),
    syncTime.toISOString(),
  );

  const journalRecords = await journal.getTradeHistory();
  assert.equal(journalRecords.length, 3);
  assert.ok(journalRecords.every((record) => record.symbol === "AAPL"));
  assert.equal(journalRecords[0].qty, "10");
  assert.equal(journalRecords[0].price, "100");
  assert.equal(journalRecords[0].strategy, profile.strategy);
  assert.equal(journalRecords[1].order_id, "alpaca-exit-order");
  assert.equal(journalRecords[1].lifecycle_id, lifecycle.id);
  assert.equal(journalRecords[1].pnl, 50);
  assert.equal(journalRecords[1].win_status, "WIN");
  assert.equal(journalRecords[1].reason, "TAKE_PROFIT_HALF");
  assert.equal(journalRecords[2].order_id, "alpaca-trailing-order");
  assert.equal(journalRecords[2].pnl, 25);

  const reloadedStore = new TradeLifecycleStore(
    path.join(directory, "trade-lifecycles.json"),
  );
  assert.equal(
    await reloadedStore.getLastTradeLogSyncAt(),
    syncTime.toISOString(),
  );
  assert.equal(await service.syncIfDue(), undefined);
  assert.equal(getOrdersCalls, 1);

  const dueService = new TradeLogSyncService(
    alpaca,
    lifecycleStore,
    journal,
    24,
    { now: () => new Date("2026-10-17T15:00:00.000Z") },
  );
  await dueService.syncIfDue();
  assert.equal(getOrdersCalls, 2);
  assert.equal((await lifecycleStore.getLifecycles()).length, 1);
  assert.equal((await journal.getTradeHistory()).length, 3);

  let scheduledDelay: number | undefined;
  const scheduledService = new TradeLogSyncService(
    alpaca,
    lifecycleStore,
    journal,
    24,
    {
      now: () => new Date("2026-10-17T15:00:00.000Z"),
      setTimeout: ((_callback: () => void, delay?: number) => {
        scheduledDelay = delay;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeout: (() => undefined) as typeof clearTimeout,
    },
  );
  scheduledService.start();
  await settle();
  scheduledService.stop();
  assert.equal(scheduledDelay, 24 * 60 * 60 * 1000);

  console.log("Deferred trade-log sync verification passed.");
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

void run().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : "Unknown error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
