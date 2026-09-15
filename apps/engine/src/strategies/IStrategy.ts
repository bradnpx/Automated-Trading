import { Bar, TradeSignal } from "@my-platform/types";

export interface StrategyCriteriaEvaluation {
  criteria: string[];
  report: Record<string, boolean>;
}

export interface StrategyEvaluationOptions {
  /** False evaluates the current live mark without adding a synthetic bar to indicator history. */
  recordBar?: boolean;
  consoleLogCriteria?: boolean;
  onCriteriaEvaluated?: (evaluation: StrategyCriteriaEvaluation) => void;
}

export interface IStrategy {
  hydrate(bars: Bar[], prevLow?: number): void;
  evaluateStrategy(
    bar: Bar,
    options?: StrategyEvaluationOptions,
  ): Promise<TradeSignal> | TradeSignal;
}
