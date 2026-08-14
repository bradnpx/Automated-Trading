import { Bar, TradeSignal } from "@my-platform/types";
import { EvaluateStrategy, StrategyCriterion } from "./evaluateStrategy.js";
import { IStrategy } from "./IStrategy.js";

/**
 * SMA crossover: long when the fast simple moving average is above the slow one.
 * 
 * A trend-following baseline. Per symbol, "in" when `SMA(fast) > SMA(slow)`; the engine
 * then holds an equal-weight book across all symbols currently "in", and cash otherwise.
 * Warmup: the strategy emits no signal until it has at least `slow` bars of history.
 */
export class SMACross implements IStrategy {
  private evaluator: EvaluateStrategy;
  private fast: number;
  private slow: number;
  private _in: boolean = false;

  private criteria: StrategyCriterion[] = [
    "isSmaCross",
    "isSmaCrossDown",
  ];

  constructor(fast: number = 20, slow: number = 50) {
    if (fast >= slow) {
      throw new Error("fast window must be smaller than slow window");
    }
    this.fast = fast;
    this.slow = slow;
    this.evaluator = new EvaluateStrategy({
      smaFastPeriod: fast,
      smaSlowPeriod: slow,
    });
  }

  public hydrate(bars: Bar[], prevLow?: number): void {
    this.evaluator.hydrate(bars);
  }

  public async evaluateStrategy(bar: Bar): Promise<TradeSignal> {
    try {
      const verification = await this.evaluator.evaluate(bar, this.criteria);

      if (verification.report.isSmaCross) {
        this._in = true;
        return {
          symbol: bar.symbol,
          action: "BUY",
          confidence: 1.0,
          reason: "sma_in",
        };
      } else if (verification.report.isSmaCrossDown) {
        this._in = false;
         return {
          symbol: bar.symbol,
          action: "SELL",
          confidence: 1.0,
          reason: "sma_out",
        };
      }

      return {
        symbol: bar.symbol,
        action: "HOLD",
        confidence: 0,
        reason: "sma_flat",
      };
    } catch (error) {
      console.error(`Error processing SMACross loop for ${bar.symbol}:`, error);
      return {
        symbol: bar.symbol,
        action: "HOLD",
        confidence: 0,
        reason: "Internal strategy execution failure.",
      };
    }
  }
}
