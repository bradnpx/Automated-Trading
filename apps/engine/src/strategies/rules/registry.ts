import { Bar } from "@my-platform/types";
import { RSI } from "technicalindicators";
import getTradingSession from "../../functions/getTradingSession";
import checkForBounce from "../../functions/checkForBounce";
import { ICriterionRule, RuleContext } from "./types";
import { StrategyCriterion } from "../evaluateStrategy";
import { getPremarketChange } from "../../functions/getPremarketChange";
import { getPublicFreeFloat } from "../../functions/getFloat";

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
  isInSession: ({ bar }) => getTradingSession(bar.timestamp) === "market",
  isInPriceRange: ({ bar }) => bar.close >= 2 && bar.close <= 20,
  isLowFloat: async ({ bar, metrics }) => {
    const float = await getPublicFreeFloat(bar.symbol);
    return float !== null && float < 25000000;
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
    // Fix: derive Eastern hour/minute from the bar's timestamp using Intl so that
    // DST is handled correctly. The previous UTC-4 hardcode was wrong during EST (winter).
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
  isDonchianBreakout: ({ bar, history, parameters }) => {
    const period = parameters.donchianPeriod;
    const priorBars = history.slice(-(period + 1), -1);
    if (priorBars.length < period) return false;

    const upper = Math.max(...priorBars.map((candidate) => candidate.high));
    return bar.close > upper;
  },
  isDonchianBreakdown: ({ bar, history, parameters }) => {
    const period = parameters.donchianPeriod;
    const priorBars = history.slice(-(period + 1), -1);
    if (priorBars.length < period) return false;

    const lower = Math.min(...priorBars.map((candidate) => candidate.low));
    return bar.close < lower;
  },
  isRsiBelowLower: ({ metrics, parameters }) => {
    return metrics.rsi < parameters.rsiLower;
  },
  isSmaCross: ({ history, parameters }) => {
    const fastPeriod = parameters.smaFastPeriod;
    const slowPeriod = parameters.smaSlowPeriod;
    const priorBars = history.slice(-(slowPeriod + 1), -1);
    if (priorBars.length < slowPeriod) return false;

    const currentFast = averageClose(history.slice(-fastPeriod));
    const currentSlow = averageClose(history.slice(-slowPeriod));
    const priorFast = averageClose(priorBars.slice(-fastPeriod));
    const priorSlow = averageClose(priorBars.slice(-slowPeriod));

    return priorFast <= priorSlow && currentFast > currentSlow;
  },
  isSmaCrossDown: ({ history, parameters }) => {
    const fastPeriod = parameters.smaFastPeriod;
    const slowPeriod = parameters.smaSlowPeriod;
    const priorBars = history.slice(-(slowPeriod + 1), -1);
    if (priorBars.length < slowPeriod) return false;

    const currentFast = averageClose(history.slice(-fastPeriod));
    const currentSlow = averageClose(history.slice(-slowPeriod));
    const priorFast = averageClose(priorBars.slice(-fastPeriod));
    const priorSlow = averageClose(priorBars.slice(-slowPeriod));

    return priorFast >= priorSlow && currentFast < currentSlow;
  },
  
  isVixElevated: ({ metrics }) => {
    return metrics.vix !== null && metrics.vix >= 20;
  },

  isGapDay: ({ metrics }) => {
    return Math.abs(metrics.gapPct) >= 0.75;
  },

  isExtendedFromVWAP: ({ metrics }) => {
    let requiredExtension = 1.0;
    const vix = metrics.vix ?? 20;
    if (vix >= 40) requiredExtension = 2.5;
    else if (vix >= 30) requiredExtension = 1.75;
    else if (vix >= 20) requiredExtension = 1.25;

    return Math.abs(metrics.vwapExtensionPct) >= requiredExtension;
  },

  isExtremeTick: ({ metrics }) => {
    return metrics.tick !== null && (metrics.tick <= -1000 || metrics.tick >= 1000);
  },

  isVWAPReversionSignal: ({ bar, history, metrics }) => {
    const previousBar = history[history.length - 2];
    if (!previousBar) return false;

    const movingTowardVWAP = Math.abs(bar.close - metrics.sessionVWAP) < Math.abs(previousBar.close - metrics.sessionVWAP);
    
    // Simplification for stateless rule, using bar open/close as proxy for EMA if not available in metrics
    const bullishReversal = previousBar.close <= previousBar.open && bar.close > bar.open;
    const bearishReversal = previousBar.close >= previousBar.open && bar.close < bar.open;

    const longReversal = metrics.gapPct <= -0.75 && metrics.vwapExtensionPct < 0 && metrics.tick !== null && metrics.tick <= -1000 && bullishReversal && movingTowardVWAP;
    const shortReversal = metrics.gapPct >= 0.75 && metrics.vwapExtensionPct > 0 && metrics.tick !== null && metrics.tick >= 1000 && bearishReversal && movingTowardVWAP;

    return longReversal || shortReversal;
  }
};

function averageClose(bars: Bar[]): number {
  return bars.reduce((sum, bar) => sum + bar.close, 0) / bars.length;
}

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

export function createRulesRegistry(): Map<StrategyCriterion, ICriterionRule> {
  const registry = new Map<StrategyCriterion, ICriterionRule>();

  for (const [criterion, evalFn] of Object.entries(StatelessRules)) {
    registry.set(criterion as StrategyCriterion, { evaluate: evalFn });
  }

  registry.set("isPdlSweptAndReclaimed", new PdlSweptAndReclaimedRule());

  return registry;
}
