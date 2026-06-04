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
  isInSession: () => getTradingSession() === "market",
  isInPriceRange: ({ bar }) => bar.close >= 2 && bar.close <= 20,
  isLowFloat: async ({ bar, metrics }) => {
    const float = await getPublicFreeFloat(bar.symbol)
      return float !== null && float < 25000000
  },
  isNotExtended: ({ bar, metrics }) =>
    (bar.close - metrics.vwapTypical) / metrics.vwapTypical <= 0.04,
  isPennyStock: ({bar}) => bar.close >= 1 && bar.close <= 10,
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
    const date = new Date(bar.timestamp);
    const nyHour = date.getUTCHours() - 4; // Eastern Standard Time conversion
    const min = date.getUTCMinutes();
    return (nyHour === 9 && min >= 45) || (nyHour === 10 && min <= 30);
  },
  isWithinTightOpeningWindow: ({ bar }) => {
    const date = new Date(bar.timestamp);
    const nyHour = date.getUTCHours() - 4; // Eastern Standard Time conversion
    const min = date.getUTCMinutes();
    return (nyHour === 9 && min >= 35) || (nyHour === 9 && min <= 55);
  },
};

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
