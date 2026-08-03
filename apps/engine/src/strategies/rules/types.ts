// strategies/rules/types.ts
// Shared type contracts for the rule evaluation system.
// All rule implementations must satisfy ICriterionRule.
// RuleContext is the single argument passed to every rule's evaluate() method.

import { Bar } from "@my-platform/types";

/** Shape of the data returned by the premarket change helper. */
export interface PremarketData {
  percentageChange: number;
  premarketVolume: number;
}

export interface RuleContext {
  bar: Bar;
  history: Bar[];
  prevLow: number;
  metrics: {
    readonly rsi: number;
    readonly rvol: number;
    readonly vwapClose: number;
    readonly vwapTypical: number;
  };
  /** Lazily fetches premarket data; result is memoized within the evaluate() call. */
  getPremarket: () => Promise<PremarketData | null>;
}

export interface ICriterionRule {
  evaluate(context: RuleContext): boolean | Promise<boolean>;
  /** Optional hook to clear per-instance state counters between signals. */
  reset?(): void;
}
