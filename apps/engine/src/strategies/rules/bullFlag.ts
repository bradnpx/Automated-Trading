import { Bar } from "@my-platform/types";

import { StrategyParameters } from "../strategyConfig";

export interface BullFlagSetup {
  flag: readonly Bar[];
  flagAverageVolume: number;
  flagResistance: number;
  flagSupport: number;
  pole: readonly Bar[];
  poleAverageVolume: number;
  poleHigh: number;
  poleLow: number;
}

/**
 * Finds the most recent completed bull-flag setup. The caller decides whether
 * the newest bar belongs to the consolidation, is a confirmed breakout, or is
 * a failed breakout. This makes the same OHLCV history usable at minute and
 * live synthetic-bar evaluation frequencies.
 */
export function findBullFlagSetup(
  history: readonly Bar[],
  parameters: StrategyParameters,
): BullFlagSetup | null {
  const maximumFlagBars = Math.min(
    parameters.bullFlagMaxConsolidationBars,
    history.length - parameters.bullFlagPoleBars,
  );

  for (
    let flagBarCount = maximumFlagBars;
    flagBarCount >= parameters.bullFlagMinConsolidationBars;
    flagBarCount -= 1
  ) {
    const setup = buildBullFlagSetup(history, flagBarCount, parameters);
    if (setup) return setup;
  }

  return null;
}

/** Returns true while a tight, unbroken flag is consolidating near its pole high. */
export function isBullFlagForming(
  history: readonly Bar[],
  parameters: StrategyParameters,
): boolean {
  const setup = findBullFlagSetup(history, parameters);
  if (!setup || setup.flag.length < 2) return false;

  const currentBar = setup.flag[setup.flag.length - 1];
  const priorResistance = maximum(
    setup.flag.slice(0, -1).map((candidate) => candidate.high),
  );

  return (
    currentBar.close <=
    priorResistance * (1 + parameters.bullFlagBreakoutBufferPct)
  );
}

/** Returns true only when the current bar confirms a volume-backed flag breakout. */
export function isBullFlagBreakout(
  history: readonly Bar[],
  parameters: StrategyParameters,
): boolean {
  if (history.length < 2) return false;

  const breakoutBar = history[history.length - 1];
  const setup = findBullFlagSetup(history.slice(0, -1), parameters);

  return setup ? isConfirmedBreakout(breakoutBar, setup, parameters) : false;
}

/**
 * Returns true when a previously confirmed breakout closes materially back
 * below flag resistance on a bearish bar. A routine retest that holds the
 * breakout level is intentionally not classified as a fakeout.
 */
export function isBullFlagFakeout(
  history: readonly Bar[],
  parameters: StrategyParameters,
): boolean {
  if (history.length < 3) return false;

  const fakeoutBar = history[history.length - 1];
  const breakoutBar = history[history.length - 2];
  const setup = findBullFlagSetup(history.slice(0, -2), parameters);
  if (!setup || !isConfirmedBreakout(breakoutBar, setup, parameters)) {
    return false;
  }

  const failureThreshold =
    setup.flagResistance *
    (1 - parameters.bullFlagFakeoutCloseBelowResistancePct);

  return (
    fakeoutBar.close < fakeoutBar.open && fakeoutBar.close < failureThreshold
  );
}

function buildBullFlagSetup(
  history: readonly Bar[],
  flagBarCount: number,
  parameters: StrategyParameters,
): BullFlagSetup | null {
  const poleStartIndex =
    history.length - flagBarCount - parameters.bullFlagPoleBars;
  if (poleStartIndex < 0) return null;

  const pole = history.slice(
    poleStartIndex,
    poleStartIndex + parameters.bullFlagPoleBars,
  );
  const flag = history.slice(-flagBarCount);
  const poleStart = pole[0];
  const poleEnd = pole[pole.length - 1];
  if (!poleStart || !poleEnd || flag.length === 0 || poleStart.open <= 0) {
    return null;
  }

  const poleHigh = maximum(pole.map((candidate) => candidate.high));
  const poleLow = minimum(pole.map((candidate) => candidate.low));
  const flagResistance = maximum(flag.map((candidate) => candidate.high));
  const flagSupport = minimum(flag.map((candidate) => candidate.low));
  const poleHeight = poleHigh - poleStart.open;
  const poleGainPct = (poleEnd.close - poleStart.open) / poleStart.open;
  const bullishPoleBars = pole.filter(
    (candidate) => candidate.close > candidate.open,
  ).length;

  if (
    poleHeight <= 0 ||
    poleGainPct < parameters.bullFlagMinPoleGainPct ||
    bullishPoleBars < parameters.bullFlagMinBullishPoleBars
  ) {
    return null;
  }

  const flagRetracementPct = (poleHigh - flagSupport) / poleHeight;
  const flagRangePct = (flagResistance - flagSupport) / poleEnd.close;
  if (
    flagRetracementPct <= 0 ||
    flagRetracementPct > parameters.bullFlagMaxRetracementPct ||
    flagRangePct > parameters.bullFlagMaxConsolidationRangePct ||
    flagResistance > poleHigh * (1 + parameters.bullFlagBreakoutBufferPct)
  ) {
    return null;
  }

  const poleAverageVolume = average(pole.map((candidate) => candidate.volume));
  const flagAverageVolume = average(flag.map((candidate) => candidate.volume));
  if (
    flagAverageVolume <= 0 ||
    poleAverageVolume <
      flagAverageVolume * parameters.bullFlagMinPoleToFlagVolumeRatio
  ) {
    return null;
  }

  return {
    flag,
    flagAverageVolume,
    flagResistance,
    flagSupport,
    pole,
    poleAverageVolume,
    poleHigh,
    poleLow,
  };
}

function isConfirmedBreakout(
  breakoutBar: Bar,
  setup: BullFlagSetup,
  parameters: StrategyParameters,
): boolean {
  const breakoutThreshold =
    setup.flagResistance * (1 + parameters.bullFlagBreakoutBufferPct);

  return (
    breakoutBar.close > breakoutBar.open &&
    breakoutBar.close > breakoutThreshold &&
    breakoutBar.volume >=
      setup.flagAverageVolume * parameters.bullFlagBreakoutVolumeMultiplier
  );
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maximum(values: readonly number[]): number {
  return Math.max(...values);
}

function minimum(values: readonly number[]): number {
  return Math.min(...values);
}
