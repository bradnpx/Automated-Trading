import assert from "node:assert/strict";

import { Bar } from "@my-platform/types";

import { BullFlagMomentum } from "./BullFlagMomentum.js";
import { EvaluateStrategy } from "./evaluateStrategy.js";
import {
  findBullFlagSetup,
  isBullFlagBreakout,
  isBullFlagFakeout,
  isBullFlagForming,
} from "./rules/bullFlag.js";
import { resolveStrategyParameters } from "./strategyConfig.js";

function createBar(
  minute: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
): Bar {
  return {
    symbol: "AAPL",
    timestamp: `2026-09-02T13:${minute.toString().padStart(2, "0")}:00.000Z`,
    open,
    high,
    low,
    close,
    volume,
  };
}

function createBullFlag(): Bar[] {
  return [
    createBar(0, 10, 10.5, 9.9, 10.4, 1_000),
    createBar(1, 10.4, 11.2, 10.3, 11.1, 1_500),
    createBar(2, 11.1, 12, 11, 11.9, 1_800),
    createBar(3, 11.9, 12, 11.6, 11.7, 800),
    createBar(4, 11.7, 11.9, 11.5, 11.6, 700),
  ];
}

async function run(): Promise<void> {
  const parameters = resolveStrategyParameters();
  const formingBars = createBullFlag();
  const breakoutBar = createBar(5, 11.7, 12.4, 11.65, 12.3, 1_500);
  const fakeoutBar = createBar(6, 12.1, 12.15, 11.8, 11.9, 1_100);

  const setup = findBullFlagSetup(formingBars, parameters);
  assert.ok(setup, "a valid pole and light-volume pullback must form a setup");
  assert.equal(isBullFlagForming(formingBars, parameters), true);
  assert.equal(
    isBullFlagBreakout([...formingBars, breakoutBar], parameters),
    true,
    "a close through resistance on expanded volume must confirm a breakout",
  );
  assert.equal(
    isBullFlagFakeout([...formingBars, breakoutBar, fakeoutBar], parameters),
    true,
    "a bearish close materially below confirmed breakout resistance must flag a fakeout",
  );

  const deepRetracement = createBullFlag();
  deepRetracement[deepRetracement.length - 1] = createBar(
    4,
    11.7,
    11.9,
    10.8,
    10.9,
    700,
  );
  assert.equal(
    findBullFlagSetup(deepRetracement, parameters),
    null,
    "a flag retracing more than half of its pole must be rejected",
  );

  const lowVolumeBreakout = createBar(5, 11.7, 12.4, 11.65, 12.3, 1_000);
  assert.equal(
    isBullFlagBreakout([...formingBars, lowVolumeBreakout], parameters),
    false,
    "a price-only breakout without required volume expansion must be rejected",
  );

  assert.throws(
    () => resolveStrategyParameters({ bullFlagMaxRetracementPct: 0.51 }),
    /retracement may not exceed 50%/,
  );

  const evaluator = new EvaluateStrategy();
  evaluator.hydrate(formingBars);
  const breakoutResult = await evaluator.evaluate(
    breakoutBar,
    ["isBullFlagBreakout"],
    0,
    undefined,
    { recordBar: false },
  );
  assert.equal(breakoutResult.meetsCriteria, true);

  const strategy = new BullFlagMomentum();
  strategy.hydrate(formingBars);
  const entrySignal = await strategy.evaluateStrategy(breakoutBar, {
    recordBar: false,
  });
  assert.equal(entrySignal.action, "BUY");
  assert.equal(entrySignal.reason, "bull_flag_breakout");

  const exitStrategy = new BullFlagMomentum();
  exitStrategy.hydrate([...formingBars, breakoutBar]);
  const exitSignal = await exitStrategy.evaluateStrategy(fakeoutBar, {
    recordBar: false,
  });
  assert.equal(exitSignal.action, "SELL");
  assert.equal(exitSignal.reason, "bull_flag_fakeout");

  console.log("Bull flag criteria verification passed.");
}

void run();
