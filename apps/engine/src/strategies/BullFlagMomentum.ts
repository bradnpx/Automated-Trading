import { Bar, TradeSignal } from "@my-platform/types";

import { EvaluateStrategy, StrategyCriterion } from "./evaluateStrategy.js";
import { IStrategy, StrategyEvaluationOptions } from "./IStrategy.js";
import { StrategyParameterOverrides } from "./strategyConfig.js";

/**
 * Enters a confirmed, volume-backed bull-flag breakout and exits a confirmed
 * breakout that promptly fails below flag resistance.
 *
 * The evaluator receives completed Alpaca OHLCV bars during hydration and live
 * synthetic bars from the existing stream pipeline for timely confirmation.
 */
export class BullFlagMomentum implements IStrategy {
  private readonly evaluator: EvaluateStrategy;

  private readonly criteria: StrategyCriterion[] = [
    "isBullFlagForming",
    "isBullFlagBreakout",
    "isBullFlagFakeout",
  ];

  constructor(parameters: StrategyParameterOverrides = {}) {
    this.evaluator = new EvaluateStrategy(parameters);
  }

  public hydrate(bars: Bar[], prevLow?: number): void {
    this.evaluator.hydrate(bars);
    console.log(
      `Loaded ${bars.length} historical bars for BullFlagMomentum context.`,
    );
  }

  public async evaluateStrategy(
    bar: Bar,
    options: StrategyEvaluationOptions = {},
  ): Promise<TradeSignal> {
    try {
      const verification = await this.evaluator.evaluate(
        bar,
        this.criteria,
        0,
        undefined,
        options,
      );

      if (verification.report.isBullFlagFakeout) {
        return {
          symbol: bar.symbol,
          action: "SELL",
          confidence: 1,
          reason: "bull_flag_fakeout",
        };
      }

      if (verification.report.isBullFlagBreakout) {
        return {
          symbol: bar.symbol,
          action: "BUY",
          confidence: Math.min(0.6 + verification.metrics.rvol / 10, 1),
          reason: "bull_flag_breakout",
        };
      }

      return {
        symbol: bar.symbol,
        action: "HOLD",
        confidence: 0,
        reason: verification.report.isBullFlagForming
          ? "bull_flag_forming"
          : "bull_flag_waiting",
      };
    } catch (error) {
      console.error(
        `Error processing BullFlagMomentum strategy for ${bar.symbol}:`,
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
