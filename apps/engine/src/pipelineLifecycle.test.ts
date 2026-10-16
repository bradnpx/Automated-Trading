import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { StreamPipeline } from "./pipeline.js";
import { TradeLifecycleStore } from "./models/tradeLifecycleStore.js";

async function run(): Promise<void> {
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = (() =>
    0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;

  try {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "pipeline-lifecycle-test-"),
    );
    const lifecycleStore = new TradeLifecycleStore(
      path.join(temporaryDirectory, "trade-lifecycles.json"),
    );
    let orderUpdate: ((data: Record<string, unknown>) => void) | undefined;

    const marketStream = {
      onConnect() {},
      onError() {},
      onStockBar() {},
      onStockTrade() {},
      subscribeForBars() {},
      subscribeForTrades() {},
      connect() {},
    };
    const tradeStream = {
      onConnect() {},
      onOrderUpdate(callback: (data: Record<string, unknown>) => void) {
        orderUpdate = callback;
      },
      subscribe() {},
      connect() {},
    };
    const profile = {
      strategy: "bullFlagMomentum",
      takeProfitPct: 5,
      stopLossPct: 2,
      trailingStopLoss: true,
    };
    const positionManager = {
      getPositionSymbols: () => [],
      getPositions: () => [{ symbol: "TEST", avg_entry_price: "10" }],
      updatePositionMark: () => true,
      hasPosition: () => false,
      checkExitConditions: () => ({
        shouldExit: false,
        action: "none",
        reason: "",
      }),
      hasPendingExit: () => false,
      canOpenPosition: () => false,
      captureEntryProfile: () => profile,
      getExitProfile: () => profile,
      clearPendingExit() {},
      clearPendingBuy() {},
      cancelPendingTrailingStop() {},
      deactivateTrailingStop() {},
      getPendingTrailingStopEntryPrice: () => undefined,
      syncPositions: async () => [],
    };
    const broadcaster = {
      broadcastBar() {},
      broadcastSignal() {},
      broadcastStrategyEvaluation() {},
      broadcastPortfolio() {},
    };

    const pipeline = new StreamPipeline(
      { data_stream_v2: marketStream, trade_ws: tradeStream },
      positionManager,
      {},
      broadcaster,
      undefined,
      new Map(),
      { isKilled: false },
      lifecycleStore,
    );
    pipeline.initialize();

    const onOrderUpdate = orderUpdate;
    assert.ok(onOrderUpdate);
    onOrderUpdate({
      event: "fill",
      execution_id: "entry-execution",
      timestamp: "2026-09-24T14:00:00.000Z",
      price: "10",
      qty: "100",
      order: {
        id: "entry-order",
        symbol: "TEST",
        side: "buy",
        type: "market",
        filled_at: "2026-09-24T14:00:00.000Z",
      },
    });
    await settle();

    await lifecycleStore.recordExitIntent("TEST", {
      orderId: "take-profit-order",
      reason: "TAKE_PROFIT_HALF",
      submittedAt: "2026-09-24T14:01:00.000Z",
    });
    onOrderUpdate({
      event: "fill",
      execution_id: "take-profit-execution",
      timestamp: "2026-09-24T14:01:00.000Z",
      price: "11",
      qty: "50",
      order: {
        id: "take-profit-order",
        symbol: "TEST",
        side: "sell",
        type: "limit",
        filled_at: "2026-09-24T14:01:00.000Z",
      },
    });
    await settle();

    const [lifecycle] = await lifecycleStore.getLifecycles();
    assert.equal(lifecycle.status, "partially_closed");
    assert.equal(lifecycle.entryQuantity, 100);
    assert.equal(lifecycle.exitedQuantity, 50);
    assert.equal(lifecycle.remainingQuantity, 50);
    assert.equal(lifecycle.exitFills[0].reason, "TAKE_PROFIT_HALF");
    console.log("Pipeline lifecycle fill verification passed.");
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

void run().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : "Unknown error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
