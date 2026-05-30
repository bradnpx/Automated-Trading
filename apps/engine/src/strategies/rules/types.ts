import { Bar } from "@my-platform/types";

export interface RuleContext {
    bar: Bar;
    history: Bar[];
    prevLow: number;
    metrics: {
        readonly rsi: number;
        readonly rvol: number;
        readonly vwapClose: number;
        readonly vwapTypical: number;
    }
    getPremarket: () => Promise<any>;
}

export interface ICriterionRule {
    evaluate(context: RuleContext): boolean | Promise<boolean>;
    reset?(): void; //optional hook to clear localized state counters
}