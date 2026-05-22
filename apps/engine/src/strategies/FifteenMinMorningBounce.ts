import { Bar, TradeSignal } from "@my-platform/types";
import { EvaluateStrategy, StrategyCriterion } from "./evaluateStrategy";
import { IStrategy } from "./IStrategy";

export class FifteenMinMorningBounce implements IStrategy {
  private history: Bar[] = [];
  private criteria: StrategyCriterion[] = [
    "isInSession",
    "isFifteenMinutes",
    "isBounced",
  ];

  public hydrate(bars: Bar[], prevLow?: number) {
    this.history = [...bars];
    this.prevLow = prevLow || 0;
  }

  public async evaluateStrategy(bar: Bar): TradeSignal {
    const strategy = new EvaluateStrategy();

    const check = await strategy.evaluate(bar, this.criteria);
  }
}
