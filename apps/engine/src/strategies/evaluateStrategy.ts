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
import type { StrategyEvaluationOptions } from "./IStrategy.js";

export type StrategyCriterion =
  | "isAlive"
  | "isAboveRollingVWAP"
  | "isAboveTen"
  | "isBelowRollingVWAPWithDistance"
  | "isBounced"
  | "isBullFlagForming"
  | "isBullFlagBreakout"
  | "isBullFlagFakeout"
  | "isBullish"
  | "isBullishFollowthrough"
  | "isElevatedRVOL"
  | "isHoldingVWAP"
  | "isInPriceRange"
  | "isInSession"
  | "isLowFloat"
  | "isNotDownFromPremarket"
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
  | "isSmaCrossDown";

export class EvaluateStrategy {
  private history: Bar[] = [];
  private rulesRegistry: Map<StrategyCriterion, ICriterionRule>;
  private parameters: StrategyParameters;

  constructor(parameters: StrategyParameterOverrides = {}) {
    this.rulesRegistry = createRulesRegistry();
    this.parameters = resolveStrategyParameters(parameters);
  }

  public hydrate(bars: Bar[]): void {
    this.history = [...bars];
  }

  public resetSweepState(): void {
    for (const rule of this.rulesRegistry.values()) {
      if (rule.reset) rule.reset();
    }
  }

  /**
   * A completed minute bar is retained for indicators. A second-level synthetic
   * bar is evaluated against that history but is never persisted into it.
   */
  public async evaluate(
    bar: Bar,
    criteriaToTest: StrategyCriterion[],
    prevLow = 0,
    internals?: { vix: number | null; tick: number | null },
    options: StrategyEvaluationOptions = {},
  ): Promise<{
    meetsCriteria: boolean;
    criteria?: StrategyCriterion[];
    report: Record<string, boolean>;
    metrics: { rsi: number; vwap: number; rvol: number; pendingSweep: boolean };
  }> {
    if (options.recordBar !== false) {
      this.history.push(bar);
      if (this.history.length > 1000) this.history.shift();
    }
    const evaluationHistory =
      options.recordBar === false
        ? [...this.history, bar].slice(-1000)
        : this.history;

    const report: Record<string, boolean> = {};
    let premarketCache: Awaited<ReturnType<typeof getPremarketChange>> = null;
    let hasLoadedPremarket = false;

    const getPremarket = async () => {
      if (!hasLoadedPremarket) {
        premarketCache = await getPremarketChange(
          bar.symbol,
          bar.close,
          bar.volume,
        );
        hasLoadedPremarket = true;
      }
      return premarketCache;
    };

    let rsiCache: number | null = null;
    let rvolCache: number | null = null;
    let vwapCloseCache: number | null = null;
    let vwapTypicalCache: number | null = null;

    const context: RuleContext = {
      bar,
      history: evaluationHistory,
      prevLow,
      parameters: this.parameters,
      internals,
      getPremarket,
      metrics: {
        get rsi() {
          if (rsiCache !== null) return rsiCache;
          const prices = context.history.map((candidate) => candidate.close);
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
              ? recentVolumeBars.reduce(
                  (sum, candidate) => sum + candidate.volume,
                  0,
                ) / recentVolumeBars.length
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
      },
    };

    for (const criterion of criteriaToTest) {
      const rule = this.rulesRegistry.get(criterion);
      if (rule) {
        report[criterion] = await rule.evaluate(context);
      } else {
        console.warn(`Warning: Criterion "${criterion}" is not supported.`);
        report[criterion] = false;
      }
    }

    const pdlRule = this.rulesRegistry.get(
      "isPdlSweptAndReclaimed",
    ) as PdlSweptAndReclaimedRule;

    const criteriaHits = Object.entries(report)
      .map(([, value]) => (value ? "✅" : "❌"))
      .join(" ");

    if (options.consoleLogCriteria === true) {
      console.log(`Evaluating strategy for ${bar.symbol}: ${criteriaHits}`);
    }

    return {
      meetsCriteria: criteriaToTest.every((key) => report[key] === true),
      report,
      criteria: criteriaToTest,
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

  for (const bar of sessionBars) {
    const price =
      type === "typical" ? (bar.high + bar.low + bar.close) / 3 : bar.close;
    totalTypicalPriceVolume += price * bar.volume;
    totalVolume += bar.volume;
  }

  return totalVolume === 0 ? 0 : totalTypicalPriceVolume / totalVolume;
}
