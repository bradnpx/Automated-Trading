import { Bar } from "@my-platform/types";
import { RSI } from "technicalindicators";
import { getEasternTimeParts } from "../functions/getTradingSession.js";
import {
  resolveStrategyParameters,
  StrategyParameterOverrides,
  StrategyParameters,
} from "./strategyConfig.js";
import { getPremarketChange } from "../functions/getPremarketChange.js";
import { ICriterionRule, RuleContext } from "./rules/types.js";
import {
  createRulesRegistry,
  PdlSweptAndReclaimedRule,
} from "./rules/registry.js";

export type StrategyCriterion =
  | "isAlive"
  | "isAboveRollingVWAP"
  | "isAboveTen"
  | "isBelowRollingVWAPWithDistance"
  | "isBounced"
  | "isBullish"
  | "isBullishFollowthrough"
  | "isHighRVOL"
  | "isHoldingVWAP"
  | "isInPriceRange"
  | "isInSession"
  | "isLowFloat"
  | "isNotExtended"
  | "isPdlSweptAndReclaimed"
  | "isPennyStock"
  | "isPremarket"
  | "isPremarketGapper"
  | "isRollingVolumeSurge"
  | "isRsiBelow70"
  | "isStrongBullCandle"
  | "isSurgingVolume"
  | "isWithinOpeningWindow"
  | "isWithinTightOpeningWindow"
  | "isDonchianBreakout"
  | "isDonchianBreakdown"
  | "isRsiBelowLower"
  | "isSmaCross"
  | "isSmaCrossDown"
  | "isVixElevated"
  | "isGapDay"
  | "isExtendedFromVWAP"
  | "isExtremeTick"
  | "isVWAPReversionSignal";

export class EvaluateStrategy {
  private history: Bar[] = [];
  private rulesRegistry: Map<StrategyCriterion, ICriterionRule>;
  private parameters: StrategyParameters;

  constructor(parameters: StrategyParameterOverrides = {}) {
    // Each instance maintains separate sandbox states for its internal rules.
    this.rulesRegistry = createRulesRegistry();
    this.parameters = resolveStrategyParameters(parameters);
  }

  public hydrate(bars: Bar[]) {
    this.history = [...bars];
  }

  public resetSweepState() {
    for (const rule of this.rulesRegistry.values()) {
      if (rule.reset) rule.reset();
    }
  }

  public async evaluate(
    bar: Bar,
    criteriaToTest: StrategyCriterion[],
    prevLow: number = 0,
    marketContext?: { vix: number | null; tick: number | null },
  ): Promise<{
    meetsCriteria: boolean;
    report: Record<string, boolean>;
    metrics: { rsi: number; vwap: number; rvol: number; pendingSweep: boolean };
  }> {
    this.history.push(bar);
    if (this.history.length > 1000) this.history.shift();

    const report: Record<string, boolean> = {};
    let premarketCache: any = null;

    const getPremarket = async () => {
      if (!premarketCache)
        premarketCache = await getPremarketChange(bar.symbol);
      return premarketCache;
    };

    // --- Dynamic Evaluation Execution Context with Lazy Metrics ---
    // Metrics calculations are cached inside execution scope only if explicitly evaluated
    let rsiCache: number | null = null;
    let rvolCache: number | null = null;
    let vwapCloseCache: number | null = null;
    let vwapTypicalCache: number | null = null;
    let sessionVWAPCache: number | null = null;
    let gapPctCache: number | null = null;
    let vwapExtensionPctCache: number | null = null;
    let vixCache: number | null = null;
    let tickCache: number | null = null;

    const context: RuleContext = {
      bar,
      history: this.history,
      prevLow,
      parameters: this.parameters,
      getPremarket,
      metrics: {
        get rsi() {
          if (rsiCache !== null) return rsiCache;
          const prices = context.history.map((b) => b.close);
          const rsiValues = RSI.calculate({
            values: prices,
            period: context.parameters.rsiPeriod,
          });
          rsiCache =
            rsiValues && rsiValues.length > 0
              ? rsiValues[rsiValues.length - 1]
              : 50;
          return rsiCache;
        },
        get rvol() {
          if (rvolCache !== null) return rvolCache;
          const recentVolumeBars = context.history.slice(-21, -1);
          const avgVolume =
            recentVolumeBars.length > 0
              ? recentVolumeBars.reduce((sum, b) => sum + b.volume, 0) /
                recentVolumeBars.length
              : bar.volume;
          rvolCache = avgVolume > 0 ? bar.volume / avgVolume : 1;
          return rvolCache;
        },
        get vwapClose() {
          if (vwapCloseCache !== null) return vwapCloseCache;
          vwapCloseCache = calculateSessionVWAP(context.history, "close");
          return vwapCloseCache;
        },
        get vwapTypical() {
          if (vwapTypicalCache !== null) return vwapTypicalCache;
          vwapTypicalCache = calculateSessionVWAP(context.history, "typical");
          return vwapTypicalCache;
        },
        get sessionVWAP() {
          if (sessionVWAPCache !== null) return sessionVWAPCache;
          sessionVWAPCache = calculateSessionVWAP(context.history, "typical");
          return sessionVWAPCache;
        },
        get gapPct() {
          if (gapPctCache !== null) return gapPctCache;
          const sessionOpen = context.history.filter(b => getEasternTimeParts(b.timestamp).dateKey === getEasternTimeParts(bar.timestamp).dateKey)[0]?.open;
          const prevClose = context.history.filter(b => getEasternTimeParts(b.timestamp).dateKey !== getEasternTimeParts(bar.timestamp).dateKey).pop()?.close;
          if (sessionOpen && prevClose) {
            gapPctCache = ((sessionOpen - prevClose) / prevClose) * 100;
          } else {
            gapPctCache = 0;
          }
          return gapPctCache;
        },
        get vwapExtensionPct() {
          if (vwapExtensionPctCache !== null) return vwapExtensionPctCache;
          const sv = this.sessionVWAP;
          vwapExtensionPctCache = sv > 0 ? ((bar.close - sv) / sv) * 100 : 0;
          return vwapExtensionPctCache;
        },
        get vix() {
          if (vixCache !== null) return vixCache;
          vixCache = marketContext?.vix ?? null;
          return vixCache;
        },
        get tick() {
          if (tickCache !== null) return tickCache;
          tickCache = marketContext?.tick ?? null;
          return tickCache;
        }
      },
    };

    // Process evaluation pipeline dynamically without switch statements
    for (const criterion of criteriaToTest) {
      const rule = this.rulesRegistry.get(criterion);
      if (rule) {
        report[criterion] = await rule.evaluate(context);
      } else {
        console.warn(`Warning: Criterion "${criterion}" is not supported.`);
        report[criterion] = false;
      }
      console.log(
        `${bar.symbol} - ${criterion}: ${report[criterion] ? "✅" : "❌"}`,
      );
    }

    const meetsCriteria = criteriaToTest.every((key) => report[key] === true);
    const pdlRule = this.rulesRegistry.get(
      "isPdlSweptAndReclaimed",
    ) as PdlSweptAndReclaimedRule;

    return {
      meetsCriteria,
      report,
      metrics: {
        rsi: context.metrics.rsi,
        vwap: criteriaToTest.includes("isBelowRollingVWAPWithDistance")
          ? context.metrics.vwapTypical
          : context.metrics.vwapClose,
        rvol: context.metrics.rvol,
        pendingSweep: pdlRule ? pdlRule.pendingSweep : false,
      },
    };
  }
}

// --- Core Helper Functions ---
function calculateSessionVWAP(
  history: Bar[],
  type: "close" | "typical",
): number {
  const latestBar = history[history.length - 1];
  if (!latestBar) return 0;

  const currentSessionDate = getEasternTimeParts(latestBar.timestamp).dateKey;
  const sessionBars = history.filter(
    (candidate) =>
      getEasternTimeParts(candidate.timestamp).dateKey === currentSessionDate,
  );
  if (sessionBars.length === 0) return 0;

  let totalTypicalPriceVolume = 0;
  let totalVolume = 0;

  for (const b of sessionBars) {
    const price = type === "typical" ? (b.high + b.low + b.close) / 3 : b.close;
    totalTypicalPriceVolume += price * b.volume;
    totalVolume += b.volume;
  }

  return totalVolume === 0 ? 0 : totalTypicalPriceVolume / totalVolume;
}
