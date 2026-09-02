import { Bar, TradeSignal } from "@my-platform/types";

export interface StrategyEvaluationOptions {
  /** False evaluates the current live mark without adding a synthetic bar to indicator history. */
  recordBar?: boolean;
}

export interface IStrategy {
  hydrate(bars: Bar[], prevLow?: number): void;
  evaluateStrategy(
    bar: Bar,
    options?: StrategyEvaluationOptions,
  ): Promise<TradeSignal> | TradeSignal;
}
