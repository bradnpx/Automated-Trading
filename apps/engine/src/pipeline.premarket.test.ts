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
  });

  try {
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
        broadcastPortfolio() {},
      },
      undefined,
      new Map([["SCAN", strategy]]),
      { isKilled: false },
    );

    pipeline.initialize();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(evaluations, 1);
    assert.deepEqual(receivedOptions, {
      recordBar: false,
      consoleLogCriteria: true,
    });
    assert.equal(submittedOrders, 0);
    assert.equal(scheduledCallbacks.length, 2);
  } finally {
    MASTER_WATCHLIST.delete("SCAN");
    globalThis.setInterval = originalSetInterval;
    globalThis.Date = originalDate;
  }

  console.log("Premarket scanner fallback verification passed.");
}

void run();
