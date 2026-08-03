// strategies/rules/registry.ts
// Defines all trading rules used by the strategy evaluation engine.
//
// StatelessRules: pure functions with no per-symbol counters.
//   These are registered into a module-level singleton in evaluateStrategy.ts
//   so they are allocated once per process.
//
// PdlSweptAndReclaimedRule: stateful rule that tracks sweep/reclaim state.
//   Instantiated once per EvaluateStrategy instance to keep counters isolated.

import getTradingSession from "../../functions/getTradingSession.js";
import checkForBounce from "../../functions/checkForBounce.js";
import { ICriterionRule, RuleContext } from "./types.js";
import { StrategyCriterion } from "../evaluateStrategy.js";
import { getPublicFreeFloat } from "../../functions/getFloat.js";

export const StatelessRules: Partial<
  Record<StrategyCriterion, (ctx: RuleContext) => boolean | Promise<boolean>>
> = {
  isAlive: () => true,

  isAboveTen: async ({ getPremarket }) => {
    const data = await getPremarket();
    return data ? data.percentageChange >= 10 : false;
  },

  isAboveRollingVWAP: ({ bar, metrics }) => bar.close > metrics.vwapClose,

  isBelowRollingVWAPWithDistance: ({ bar, metrics }) =>
    metrics.vwapTypical - bar.close >= 0.5,

  isBounced: ({ bar, history }) => {
    const priorBar = history[history.length - 2];
    return priorBar
      ? checkForBounce({ sourceBar: priorBar, targetBar: bar })
      : false;
  },

  isBullish: ({ bar }) => bar.close > bar.open,

  isBullishFollowthrough: ({ bar, history }) => {
    const priorBar = history[history.length - 2];
    return (
      bar.close > bar.open && (priorBar ? bar.close > priorBar.close : true)
    );
  },

  isHoldingVWAP: ({ bar, metrics }) =>
    bar.low > metrics.vwapTypical * (1 - 0.0025),

  isHighRVOL: ({ metrics }) => metrics.rvol >= 5,

  isInSession: () => getTradingSession() === "market",

  isInPriceRange: ({ bar }) => bar.close >= 2 && bar.close <= 20,

  isLowFloat: async ({ bar }) => {
    const float = await getPublicFreeFloat(bar.symbol);
    return float !== null && float < 25_000_000;
  },

  isNotExtended: ({ bar, metrics }) =>
    (bar.close - metrics.vwapTypical) / metrics.vwapTypical <= 0.04,

  isPennyStock: ({ bar }) => bar.close >= 1 && bar.close <= 10,

  isPremarket: () => getTradingSession() === "premarket",

  isPremarketGapper: async ({ getPremarket }) => {
    const data = await getPremarket();
    return data ? data.percentageChange >= 5 : false;
  },

  isRollingVolumeSurge: ({ metrics }) => metrics.rvol >= 4.0,

  isRsiBelow70: ({ metrics }) => metrics.rsi < 70,

  isStrongBullCandle: ({ bar }) => {
    const body = Math.abs(bar.close - bar.open);
    const range = bar.high - bar.low;
    return bar.close > bar.open && range > 0 && body / range >= 0.6;
  },

  isSurgingVolume: async ({ getPremarket }) => {
    const data = await getPremarket();
    return data ? data.premarketVolume >= 500 : false;
  },

  isWithinOpeningWindow: ({ bar }) => {
    // Derive Eastern hour/minute via Intl so DST is handled automatically.
    const date = new Date(bar.timestamp);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(date);
    const nyHour = parseInt(
      parts.find((p) => p.type === "hour")?.value ?? "0",
      10,
    );
    const min = parseInt(
      parts.find((p) => p.type === "minute")?.value ?? "0",
      10,
    );
    return (nyHour === 9 && min >= 45) || (nyHour === 10 && min <= 30);
  },

  isWithinTightOpeningWindow: ({ bar }) => {
    const date = new Date(bar.timestamp);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(date);
    const nyHour = parseInt(
      parts.find((p) => p.type === "hour")?.value ?? "0",
      10,
    );
    const min = parseInt(
      parts.find((p) => p.type === "minute")?.value ?? "0",
      10,
    );
    return nyHour === 9 && min >= 35 && min <= 55;
  },
};

// ─── Stateful Rule ────────────────────────────────────────────────────────────

export class PdlSweptAndReclaimedRule implements ICriterionRule {
  public pendingSweep = false;
  private barsSinceSweep = 999;

  public evaluate({ bar, prevLow }: RuleContext): boolean {
    if (prevLow <= 0) return false;

    const sweepOccurred = bar.low < prevLow;
    if (sweepOccurred) {
      this.pendingSweep = true;
      this.barsSinceSweep = 0;
    } else {
      this.barsSinceSweep++;
    }

    const isFirstTouch = this.barsSinceSweep <= 20;
    const isReclaimed = this.pendingSweep && bar.close > prevLow;

    return isFirstTouch && isReclaimed;
  }

  public reset(): void {
    this.pendingSweep = false;
    this.barsSinceSweep = 999;
  }
}
