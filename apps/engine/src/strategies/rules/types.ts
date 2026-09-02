import { Bar } from "@my-platform/types";
import { StrategyParameters } from "../strategyConfig";

export interface RuleContext {
  bar: Bar;
  history: Bar[];
  prevLow: number;
  parameters: StrategyParameters;
  internals?: {
    vix: number | null;
    tick: number | null;
  };
  metrics: {
    readonly rsi: number;
    readonly rvol: number;
    readonly vwapClose: number;
    readonly vwapTypical: number;
  };
  getPremarket: () => Promise<any>;
}

export interface ICriterionRule {
  evaluate(context: RuleContext): boolean | Promise<boolean>;
  reset?(): void; //optional hook to clear localized state counters
}
