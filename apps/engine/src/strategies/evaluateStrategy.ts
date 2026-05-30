import { Bar } from "@my-platform/types";
import { RSI } from "technicalindicators";
import { getPremarketChange } from "../functions/getPremarketChange.js";
import { ICriterionRule, RuleContext } from "./rules/types.js";
import {
  createRulesRegistry,
  PdlSweptAndReclaimedRule,
} from "./rules/registry.js";

export type StrategyCriterion =
  | "isAlive"
  | "isInSession"
  | "isPremarket"
  | "isInPriceRange"
  | "isAboveTen"
  | "isSurgingVolume"
  | "isBounced"
  | "isRsiBelow70"
  | "isAboveRollingVWAP"
  | "isBelowRollingVWAPWithDistance"
  | "isRollingVolumeSurge"
  | "isPdlSweptAndReclaimed"
  | "isBullishFollowthrough"
  | "isHighRVOL"
  | "isWithinOpeningWindow"
  | "isHoldingVWAP"
  | "isPremarketGapper"
  | "isNotExtended"
  | "isStrongBullCandle";

export class EvaluateStrategy {
  private history: Bar[] = [];
  private rulesRegistry: Map<StrategyCriterion, ICriterionRule>;

  constructor() {
    // Each instance maintains separate sandbox states for its internal rules
    this.rulesRegistry = createRulesRegistry();
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
  ): Promise<{
    meetsCriteria: boolean;
    report: Record<string, boolean>;
    metrics: { rsi: number; vwap: number; rvol: number; pendingSweep: boolean };
  }> {
    this.history.push(bar);
    if (this.history.length > 200) this.history.shift();

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

    const context: RuleContext = {
      bar,
      history: this.history,
      prevLow,
      getPremarket,
      metrics: {
        get rsi() {
          if (rsiCache !== null) return rsiCache;
          const prices = context.history.map((b) => b.close);
          const rsiValues = RSI.calculate({ values: prices, period: 14 });
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
          vwapCloseCache = calculateRollingVWAP(context.history, "close");
          return vwapCloseCache;
        },
        get vwapTypical() {
          if (vwapTypicalCache !== null) return vwapTypicalCache;
          vwapTypicalCache = calculateRollingVWAP(context.history, "typical");
          return vwapTypicalCache;
        },
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
function calculateRollingVWAP(
  history: Bar[],
  type: "close" | "typical",
): number {
  const recent = history.slice(-20);
  if (recent.length === 0) return 0;

  let totalTypicalPriceVolume = 0;
  let totalVolume = 0;

  for (const b of recent) {
    const price = type === "typical" ? (b.high + b.low + b.close) / 3 : b.close;
    totalTypicalPriceVolume += price * b.volume;
    totalVolume += b.volume;
  }

  return totalVolume === 0 ? 0 : totalTypicalPriceVolume / totalVolume;
}
