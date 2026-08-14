import assert from "node:assert/strict";

import { Bar } from "@my-platform/types";

import getTradingSession from "../../../engine/src/functions/getTradingSession.js";
import { DonchianBreakout } from "../../../engine/src/strategies/DonchianBreakout.js";
import { BacktestEngine } from "../engine.js";
import { BacktestConfig } from "../types.js";

async function run(): Promise<void> {
  await testTimestampBasedSession();
  await testDonchianUsesPriorBars();
  await testTargetExitAndAttribution();
  await testEndOfDataLiquidationWithoutBracket();
  process.stdout.write("Backtest regression tests passed.\n");
}

async function testTimestampBasedSession(): Promise<void> {
  assert.equal(
    getTradingSession("2026-08-12T14:00:00.000Z"),
    "market",
    "10:00 ET should be recognized as regular market time",
  );
  assert.equal(
    getTradingSession("2026-08-12T12:00:00.000Z"),
    "premarket",
    "08:00 ET should be recognized as premarket",
  );
}

async function testDonchianUsesPriorBars(): Promise<void> {
  const strategy = new DonchianBreakout(20);
  const history = Array.from({ length: 20 }, (_, index) =>
    createBar({
      timestamp: timestampAt(index),
      open: 10,
      high: 10.2,
      low: 9.8,
      close: 10,
    }),
  );
  strategy.hydrate(history);

  const signal = await strategy.evaluateStrategy(
    createBar({
      timestamp: timestampAt(20),
      open: 10,
      high: 11.2,
      low: 9.9,
      close: 11,
    }),
  );

  assert.equal(signal.action, "BUY", "A close above prior highs must trigger Donchian entry");
}

async function testTargetExitAndAttribution(): Promise<void> {
  const result = await new BacktestEngine().run(
    [
      createBar({ timestamp: timestampAt(0), open: 10, high: 10, low: 10, close: 10 }),
      createBar({ timestamp: timestampAt(1), open: 10, high: 11.5, low: 10, close: 10.5 }),
    ],
    baseConfig({ stopLossPct: 0.02, takeProfitPct: 0.1 }),
  );

  assert.equal(result.trades.length, 1, "Buy-and-hold should open and close one trade");
  assert.equal(result.trades[0].exitReason, "take-profit");
  assert.equal(result.orders.filter((order) => order.status === "filled").length, 2);
  assert.equal(result.metrics.wins, 1);
}

async function testEndOfDataLiquidationWithoutBracket(): Promise<void> {
  const result = await new BacktestEngine().run(
    [
      createBar({ timestamp: timestampAt(0), open: 10, high: 10, low: 10, close: 10 }),
      createBar({ timestamp: timestampAt(1), open: 12, high: 12, low: 12, close: 12 }),
    ],
    baseConfig({
      stopLossPct: null,
      takeProfitPct: null,
      positionSizingMethod: "equity-fraction",
    }),
  );

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitReason, "end-of-data");
  assert.equal(result.endingEquity, 1_200);
}

function baseConfig(overrides: Partial<BacktestConfig>): BacktestConfig {
  return {
    strategyId: "buyAndHold",
    initialCash: 1_000,
    riskPerTrade: 1,
    positionSizingMethod: "risk-to-stop",
    maxPositionPct: 1,
    stopLossPct: 0.02,
    takeProfitPct: 0.022,
    slippageBps: 0,
    commissionPerOrder: 0,
    intrabarFillPriority: "stop-first",
    closeOpenPositionsAtEnd: true,
    ...overrides,
  };
}

function createBar(
  overrides: Partial<Bar> & Pick<Bar, "timestamp" | "open" | "high" | "low" | "close">,
): Bar {
  return {
    symbol: "TEST",
    volume: 100_000,
    ...overrides,
  };
}

function timestampAt(minutesAfterOpen: number): string {
  return new Date(Date.UTC(2026, 7, 12, 13, 30 + minutesAfterOpen)).toISOString();
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : "Unknown test failure";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
