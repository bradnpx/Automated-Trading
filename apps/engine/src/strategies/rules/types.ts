import { Bar } from "@my-platform/types";
import { StrategyParameters } from "../strategyConfig";

export interface RuleContext {
    bar: Bar;
    history: Bar[];
    prevLow: number;
    parameters: StrategyParameters;
    metrics: {
        readonly rsi: number;
        readonly rvol: number;
        readonly vwapClose: number;
        readonly vwapTypical: number;
        readonly sessionVWAP: number;
        readonly gapPct: number;
        readonly vwapExtensionPct: number;
        readonly vix: number | null;
        readonly tick: number | null;
    }
    getPremarket: () => Promise<any>;
}

export interface ICriterionRule {
    evaluate(context: RuleContext): boolean | Promise<boolean>;
    reset?(): void; //optional hook to clear localized state counters
}