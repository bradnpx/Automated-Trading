import { Bar, TradeSignal } from "@my-platform/types";
import { EvaluateStrategy, StrategyCriterion } from "./evaluateStrategy.js";
import { IStrategy, StrategyEvaluationOptions } from "./IStrategy.js";

/**
 * RSI mean-reversion: buy oversold, sell overbought.
 *
 * A counter-trend baseline. Wilder's RSI is computed per symbol on closes. When RSI drops
 * below `lower` the symbol is "in" (oversold → expected bounce); it stays in until RSI
 * exceeds `upper` (overbought → take profit). Equal weight across all "in" symbols.
 */
export class RSIReversion implements IStrategy {
  private evaluator: EvaluateStrategy;
  private lower: number;
  private upper: number;
  private _in: boolean = false;

  private criteria: StrategyCriterion[] = [
    "isRsiBelowLower" as StrategyCriterion,
  ];

  constructor(period: number = 14, lower: number = 30.0, upper: number = 70.0) {
    if (!(0.0 < lower && lower < upper && upper < 100.0)) {
      throw new Error("require 0 < lower < upper < 100");
    }
    this.lower = lower;
    this.upper = upper;
    this.evaluator = new EvaluateStrategy({
      rsiPeriod: period,
      rsiLower: lower,
      rsiUpper: upper,
    });
  }

  public hydrate(bars: Bar[], prevLow?: number): void {
    this.evaluator.hydrate(bars);
  }

  public async evaluateStrategy(
    bar: Bar,
    options: StrategyEvaluationOptions = {},
  ): Promise<TradeSignal> {
    try {
      // Evaluate metrics, RSI is cached inside the evaluator context
      const verification = await this.evaluator.evaluate(
        bar,
        [],
        0,
        undefined,
        options,
      );
      const rsi = verification.metrics.rsi;

      if (rsi < this.lower) {
        this._in = true;
      } else if (rsi > this.upper) {
        this._in = false;
      }

      if (this._in) {
        return {
          symbol: bar.symbol,
          action: "BUY",
          confidence: 1.0,
          reason: "rsi_in",
        };
      } else if (!this._in && rsi > this.upper) {
        return {
          symbol: bar.symbol,
          action: "SELL",
          confidence: 1.0,
          reason: "rsi_out",
        };
      }

      return {
        symbol: bar.symbol,
        action: "HOLD",
        confidence: 0,
        reason: "rsi_flat",
      };
    } catch (error) {
      console.error(
        `Error processing RSIReversion loop for ${bar.symbol}:`,
        error,
      );
      return {
        symbol: bar.symbol,
        action: "HOLD",
        confidence: 0,
        reason: "Internal strategy execution failure.",
      };
    }
  }
}
