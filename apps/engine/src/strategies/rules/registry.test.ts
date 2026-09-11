import assert from "node:assert/strict";

import { Bar } from "@my-platform/types";

import { DEFAULT_STRATEGY_PARAMETERS } from "../strategyConfig.js";
import { StatelessRules } from "./registry.js";
import { RuleContext } from "./types.js";

function createContext(
  close: number,
  premarketHigh: number | null,
): RuleContext {
  const bar: Bar = {
    symbol: "AAPL",
    timestamp: "2026-09-10T14:00:00.000Z",
    open: close,
    high: close,
    low: close,
    close,
    volume: 100,
  };

  return {
    bar,
    history: [bar],
    prevLow: 0,
    parameters: DEFAULT_STRATEGY_PARAMETERS,
    metrics: {
      rsi: 50,
      rvol: 1,
      vwapClose: close,
      vwapTypical: close,
    },
    getPremarket: async () =>
      premarketHigh === null
        ? null
        : {
            premarketHigh,
            premarketVolume: 0,
            percentageChange: 0,
            volumePercentageChange: 0,
            latestPrice: close,
          },
  };
}

async function run(): Promise<void> {
  const rule = StatelessRules.isNotDownFromPremarket;
  if (!rule) throw new Error("isNotDownFromPremarket rule is not registered");

  assert.equal(
    await rule(createContext(90.01, 100)),
    true,
    "a close less than 10% below the premarket high should pass",
  );
  assert.equal(
    await rule(createContext(90, 100)),
    false,
    "a close exactly 10% below the premarket high should fail",
  );
  assert.equal(
    await rule(createContext(85, 100)),
    false,
    "a close more than 10% below the premarket high should fail",
  );
  assert.equal(
    await rule(createContext(100, null)),
    false,
    "missing premarket data should fail closed",
  );

  console.log("Premarket drawdown rule verification passed.");
}

void run();
