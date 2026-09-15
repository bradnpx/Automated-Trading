import assert from "node:assert/strict";

import { MASTER_WATCHLIST } from "./config/config.js";
import { StreamPipeline } from "./pipeline.js";

const FIXED_PREMARKET_TIME = new Date("2026-09-14T13:29:30.000Z");

async function run(): Promise<void> {
  const originalSetInterval = globalThis.setInterval;
  const originalDate = globalThis.Date;
  const scheduledCallbacks: Array<() => void> = [];
  globalThis.setInterval = ((callback: () => void) => {
    scheduledCallbacks.push(callback);
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;

  class FixedDate extends originalDate {
    constructor(value?: string | number | Date) {
      super(value ?? FIXED_PREMARKET_TIME);
    }

    static now(): number {
      return FIXED_PREMARKET_TIME.getTime();
    }
  }
  globalThis.Date = FixedDate as unknown as DateConstructor;

  let evaluations = 0;
  let receivedOptions: Record<string, unknown> | undefined;
  let submittedOrders = 0;
  let receivedProposal: Record<string, unknown> | undefined;

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
    onOrderUpdate() {},
    subscribe() {},
    connect() {},
  };
  const positionManager = {
    getPositionSymbols: () => [],
    updatePositionMark: () => true,
    hasPosition: () => false,
    checkExitConditions: () => ({ shouldExit: false, reason: "" }),
    hasPendingExit: () => false,
    canOpenPosition: () => true,
    getOrFetchEquity: () => 1_000,
    getPositions: () => [],
  };
  const strategy = {
    hydrate() {},
    async evaluateStrategy(
      _bar: Record<string, unknown>,
      options: Record<string, unknown>,
    ) {
      evaluations += 1;
      receivedOptions = options;
      return {
        symbol: "SCAN",
        action: "BUY",
        confidence: 1,
        reason: "test signal",
      };
    },
  };

  MASTER_WATCHLIST.set("SCAN", {
    symbol: "SCAN",
    strategy: "dayTradeMicroScalp",
    source: "scanner",
    totalRisk: 0.05,
  });

  try {
    const engineState: {
      isKilled: boolean;
      premarketMode?: "evaluation_only" | "manual_review";
    } = { isKilled: false };
    const pipeline = new StreamPipeline(
      {
        data_stream_v2: marketStream,
        trade_ws: tradeStream,
        async getLatestBars() {
          return new Map([
            [
              "SCAN",
              {
                OpenPrice: 4.95,
                HighPrice: 5.25,
                LowPrice: 4.9,
                ClosePrice: 5.2,
                Volume: 42_000,
                Timestamp: FIXED_PREMARKET_TIME.toISOString(),
              },
            ],
          ]);
        },
      },
      positionManager,
      {
        async placeBuyOrder() {
          submittedOrders += 1;
        },
      },
      {
        broadcastBar() {},
        broadcastSignal() {},
        broadcastPremarketOrderProposal(proposal: Record<string, unknown>) {
          receivedProposal = proposal;
        },
        broadcastPortfolio() {},
      },
      undefined,
      new Map([["SCAN", strategy]]),
      engineState,
    );

    pipeline.initialize();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(evaluations, 1);
    assert.deepEqual(receivedOptions, {
      recordBar: false,
      consoleLogCriteria: true,
    });
    assert.equal(submittedOrders, 0);
    assert.equal(
      receivedProposal,
      undefined,
      "Evaluation-only mode must never emit a manual-review proposal.",
    );
    assert.equal(scheduledCallbacks.length, 2);

    engineState.premarketMode = "manual_review";
    scheduledCallbacks[1]();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(evaluations, 2);
    assert.equal(submittedOrders, 0);
    assert.deepEqual(receivedProposal, {
      symbol: "SCAN",
      strategy: "dayTradeMicroScalp",
      reason: "test signal",
      referencePrice: 5.2,
      limitPrice: 5.23,
      quantity: 9,
      riskPct: 0.05,
      timeInForce: "day",
      extendedHours: true,
      generatedAt: FIXED_PREMARKET_TIME.toISOString(),
    });
  } finally {
    MASTER_WATCHLIST.delete("SCAN");
    globalThis.setInterval = originalSetInterval;
    globalThis.Date = originalDate;
  }

  console.log("Premarket scanner fallback verification passed.");
}

void run();
