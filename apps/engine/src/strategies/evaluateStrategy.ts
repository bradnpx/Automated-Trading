// strategies/evaluateStrategy.ts
// Core strategy evaluation engine.
//
// Performance optimizations applied in this refactor:
//   1. Stateless rules are shared via a module-level singleton registry so
//      they are allocated once per process rather than once per strategy
//      instance. Stateful rules (e.g. PdlSweptAndReclaimedRule) are still
//      instantiated per-EvaluateStrategy so their counters remain isolated.
//   2. Incremental VWAP: instead of slicing and iterating the full history
//      array on every tick, we maintain running sums that are updated in O(1)
//      as bars are added and evicted from the rolling window.
//   3. The premarket cache is typed (no more `any`).

import { Bar } from "@my-platform/types";
import { RSI } from "technicalindicators";
import { getPremarketChange } from "../functions/getPremarketChange.js";
import { ICriterionRule, RuleContext } from "./rules/types.js";
import {
  StatelessRules,
  PdlSweptAndReclaimedRule,
} from "./rules/registry.js";

// ─── Types ────────────────────────────────────────────────────────────────────

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
  | "isWithinTightOpeningWindow";

interface PremarketData {
  percentageChange: number;
  premarketVolume: number;
}

interface EvaluationResult {
  meetsCriteria: boolean;
  report: Record<string, boolean>;
  metrics: { rsi: number; vwap: number; rvol: number; pendingSweep: boolean };
}

// ─── Module-level singleton for stateless rules ───────────────────────────────
// Stateless rules carry no per-symbol counters, so they can safely be shared
// across all EvaluateStrategy instances. This avoids re-allocating the same
// function references on every `new EvaluateStrategy()` call.
const SHARED_STATELESS_REGISTRY = new Map<StrategyCriterion, ICriterionRule>();
for (const [criterion, evalFn] of Object.entries(StatelessRules)) {
  SHARED_STATELESS_REGISTRY.set(criterion as StrategyCriterion, {
    evaluate: evalFn,
  });
}

// ─── Incremental VWAP accumulator ────────────────────────────────────────────
// Maintains a fixed-size rolling window of the last VWAP_WINDOW bars and
// keeps running price*volume and volume sums so that each new bar is an O(1)
// update instead of an O(n) slice+reduce.
const VWAP_WINDOW = 20;

class IncrementalVWAP {
  private window: Bar[] = [];
  private sumPV = 0; // Σ(price × volume)
  private sumV = 0;  // Σ(volume)
  private readonly type: "close" | "typical";

  constructor(type: "close" | "typical") {
    this.type = type;
  }

  private price(b: Bar): number {
    return this.type === "typical" ? (b.high + b.low + b.close) / 3 : b.close;
  }

  push(bar: Bar): void {
    const p = this.price(bar);
    this.sumPV += p * bar.volume;
    this.sumV += bar.volume;
    this.window.push(bar);

    if (this.window.length > VWAP_WINDOW) {
      const evicted = this.window.shift()!;
      const ep = this.price(evicted);
      this.sumPV -= ep * evicted.volume;
      this.sumV -= evicted.volume;
    }
  }

  get value(): number {
    return this.sumV === 0 ? 0 : this.sumPV / this.sumV;
  }

  reset(): void {
    this.window = [];
    this.sumPV = 0;
    this.sumV = 0;
  }
}

// ─── EvaluateStrategy ─────────────────────────────────────────────────────────

export class EvaluateStrategy {
  private history: Bar[] = [];

  // Stateful rules are per-instance so their counters stay isolated per symbol.
  private pdlRule = new PdlSweptAndReclaimedRule();

  // Incremental VWAP accumulators — updated once per bar, read in O(1).
  private vwapClose = new IncrementalVWAP("close");
  private vwapTypical = new IncrementalVWAP("typical");

  /** Pre-load historical bars to warm up indicators before live trading. */
  public hydrate(bars: Bar[]): void {
    this.history = [];
    this.vwapClose.reset();
    this.vwapTypical.reset();

    for (const bar of bars) {
      this.history.push(bar);
      this.vwapClose.push(bar);
      this.vwapTypical.push(bar);
    }
  }

  /** Reset all stateful rule counters (e.g. after a confirmed signal fires). */
  public resetSweepState(): void {
    this.pdlRule.reset?.();
  }

  public async evaluate(
    bar: Bar,
    criteriaToTest: StrategyCriterion[],
    prevLow = 0,
  ): Promise<EvaluationResult> {
    // Append bar to rolling history (capped at 200 bars)
    this.history.push(bar);
    if (this.history.length > 200) this.history.shift();

    // Update incremental VWAP accumulators in O(1)
    this.vwapClose.push(bar);
    this.vwapTypical.push(bar);

    // Typed premarket cache — fetched at most once per evaluate() call
    let premarketCache: PremarketData | null = null;
    const getPremarket = async (): Promise<PremarketData | null> => {
      if (!premarketCache) {
        premarketCache = await getPremarketChange(bar.symbol);
      }
      return premarketCache;
    };

    // Lazy metric caches — computed at most once per evaluate() call
    let rsiCache: number | null = null;
    let rvolCache: number | null = null;

    // Capture VWAP values once so the getters are pure reads
    const vwapCloseValue = this.vwapClose.value;
    const vwapTypicalValue = this.vwapTypical.value;

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
            rsiValues.length > 0 ? rsiValues[rsiValues.length - 1]! : 50;
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
        // VWAP values come from the incremental accumulators — no array work here
        get vwapClose() {
          return vwapCloseValue;
        },
        get vwapTypical() {
          return vwapTypicalValue;
        },
      },
    };

    const report: Record<string, boolean> = {};

    for (const criterion of criteriaToTest) {
      // Prefer the per-instance stateful rule (pdlRule) if applicable,
      // otherwise fall back to the shared stateless registry.
      const rule: ICriterionRule | undefined =
        criterion === "isPdlSweptAndReclaimed"
          ? this.pdlRule
          : SHARED_STATELESS_REGISTRY.get(criterion);

      if (rule) {
        report[criterion] = await rule.evaluate(context);
      } else {
        console.warn(`Warning: Criterion "${criterion}" is not registered.`);
        report[criterion] = false;
      }

      console.log(
        `${bar.symbol} - ${criterion}: ${report[criterion] ? "✅" : "❌"}`,
      );
    }

    const meetsCriteria = criteriaToTest.every((key) => report[key] === true);

    return {
      meetsCriteria,
      report,
      metrics: {
        rsi: context.metrics.rsi,
        vwap: criteriaToTest.includes("isBelowRollingVWAPWithDistance")
          ? vwapTypicalValue
          : vwapCloseValue,
        rvol: context.metrics.rvol,
        pendingSweep: this.pdlRule.pendingSweep,
      },
    };
  }
}
