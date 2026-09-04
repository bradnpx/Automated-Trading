import assert from "node:assert/strict";

import { MASTER_WATCHLIST } from "./config/config.js";
import { StreamPipeline } from "./pipeline.js";

async function run(): Promise<void> {
  const originalSetInterval = globalThis.setInterval;
  const scheduledCallbacks: Array<() => void> = [];
  globalThis.setInterval = ((callback: () => void) => {
    scheduledCallbacks.push(callback);
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;

  let marketConnect: (() => void) | undefined;
  let marketTrade: ((trade: Record<string, unknown>) => void) | undefined;
  let tradeConnect: (() => void) | undefined;
  let subscribedBars: string[] = [];
  let subscribedTrades: string[] = [];
  let receivedSignal: Record<string, unknown> | undefined;
  let evaluatedBar: Record<string, unknown> | undefined;
  let evaluationOptions: Record<string, unknown> | undefined;
  const markedPositions: Array<{ symbol: string; price: number }> = [];

  const marketStream = {
    onConnect(callback: () => void) {
      marketConnect = callback;
    },
    onError() {},
    onStockBar() {},
    onStockTrade(callback: (trade: Record<string, unknown>) => void) {
      marketTrade = callback;
    },
    subscribeForBars(symbols: string[]) {
      subscribedBars = symbols;
    },
    subscribeForTrades(symbols: string[]) {
      subscribedTrades = symbols;
    },
    connect() {},
  };

  const tradeStream = {
    onConnect(callback: () => void) {
      tradeConnect = callback;
    },
    onOrderUpdate() {},
    subscribe() {},
    connect() {},
  };

  const positionManager = {
    async syncPositions() {
      return [];
    },
    async syncAccount() {
      return null;
    },
    getPositionSymbols: () => [],
    updatePositionMark: (symbol: string, price: number) => {
      markedPositions.push({ symbol, price });
      return true;
    },
    hasPosition: () => false,
    checkExitConditions: () => ({ shouldExit: false, reason: "" }),
    hasPendingExit: () => false,
    canOpenPosition: () => false,
    getPositions: () => [],
  };

  const strategy = {
    hydrate() {},
    async evaluateStrategy(
      bar: Record<string, unknown>,
      options: Record<string, unknown>,
    ) {
      evaluatedBar = bar;
      evaluationOptions = options;
      return {
        symbol: "AAPL",
        action: "HOLD",
        confidence: 0,
        reason: "test",
      };
    },
  };

  const broadcaster = {
    broadcastBar() {},
    broadcastSignal(signal: Record<string, unknown>) {
      receivedSignal = signal;
    },
    broadcastPortfolio() {},
  };

  MASTER_WATCHLIST.set("AAPL", {
    symbol: "AAPL",
    strategy: "dayTradeMicroScalp",
  });

  try {
    const pipeline = new StreamPipeline(
      { data_stream_v2: marketStream, trade_ws: tradeStream },
      positionManager,
      {},
      broadcaster,
      undefined,
      new Map([["AAPL", strategy]]),
      { isKilled: false },
    );
    pipeline.initialize();

    marketConnect?.();
    tradeConnect?.();
    marketTrade?.({
      Symbol: "AAPL",
      Price: 101.25,
      Size: 10,
      Timestamp: new Date().toISOString(),
    });

    assert.deepEqual(subscribedBars, ["AAPL"]);
    assert.deepEqual(subscribedTrades, ["AAPL"]);
    assert.deepEqual(markedPositions, [{ symbol: "AAPL", price: 101.25 }]);
    assert.equal(scheduledCallbacks.length, 1);

    scheduledCallbacks[0]();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(evaluatedBar?.close, 101.25);
    assert.equal(evaluationOptions?.recordBar, false);
    assert.equal(receivedSignal, undefined);
  } finally {
    MASTER_WATCHLIST.delete("AAPL");
    globalThis.setInterval = originalSetInterval;
  }

  console.log("Second-level pipeline verification passed.");
}

void run();
