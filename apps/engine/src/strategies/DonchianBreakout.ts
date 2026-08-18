import { Bar, TradeSignal } from "@my-platform/types";
import { EvaluateStrategy, StrategyCriterion } from "./evaluateStrategy.js";
import { IStrategy } from "./IStrategy.js";

/**
 * Donchian channel breakout: long when price breaks above the prior N-bar high.
 * 
 * The classic turtle-style trend filter. "In" when this bar's close exceeds the highest high
 * of the previous `period` bars (excluding today, to avoid a trivial self-trigger); "out"
 * when it breaks below the prior `period`-bar low. Equal weight across "in" symbols.
 */
export class DonchianBreakout implements IStrategy {
  private evaluator: EvaluateStrategy;
  private period: number;

  private criteria: StrategyCriterion[] = [
    "isDonchianBreakout",
    "isDonchianBreakdown",
  ];

  constructor(period: number = 20) {
    if (period < 2) {
      throw new Error("period must be >= 2");
    }
    this.period = period;
    this.evaluator = new EvaluateStrategy({ donchianPeriod: period });
  }

  public hydrate(bars: Bar[], prevLow?: number): void {
    this.evaluator.hydrate(bars);
  }

  public async evaluateStrategy(bar: Bar): Promise<TradeSignal> {
    try {
      const verification = await this.evaluator.evaluate(bar, this.criteria);

      if (verification.report.isDonchianBreakout) {
        return {
          symbol: bar.symbol,
          action: "BUY",
          confidence: 1.0,
          reason: "donchian_in",
        };
      } else if (verification.report.isDonchianBreakdown) {
         return {
          symbol: bar.symbol,
          action: "SELL",
          confidence: 1.0,
          reason: "donchian_out",
        };
      }

      return {
        symbol: bar.symbol,
        action: "HOLD",
        confidence: 0,
        reason: "donchian_flat",
      };
    } catch (error) {
      console.error(`Error processing DonchianBreakout loop for ${bar.symbol}:`, error);
      return {
        symbol: bar.symbol,
        action: "HOLD",
        confidence: 0,
        reason: "Internal strategy execution failure.",
      };
    }
  }
}
