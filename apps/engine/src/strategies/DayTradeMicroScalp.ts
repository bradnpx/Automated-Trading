import { Bar, TradeSignal } from "@my-platform/types";
import { EvaluateStrategy, StrategyCriterion } from "./evaluateStrategy.js";
import { IStrategy } from "./IStrategy.js";
import { StrategyParameterOverrides } from "./strategyConfig.js";

export class DayTradeMicroScalp implements IStrategy {
  private evaluator: EvaluateStrategy;

  // Favor confirmed opening momentum over every bullish VWAP hold. These checks use
  // only hydrated bar history, not external float or scanner metadata.
  private criteria: StrategyCriterion[] = [
    "isInPriceRange",
    "isWithinOpeningWindow",
    "isHoldingVWAP",
    "isStrongBullCandle",
    "isBullishFollowthrough",
    "isRsiBelow70",
    "isMicroScalpRelativeVolume",
    "isMicroScalpNotExtended",
  ];

  constructor(parameters: StrategyParameterOverrides = {}) {
    this.evaluator = new EvaluateStrategy(parameters);
  }

  public hydrate(bars: Bar[], prevLow?: number) {
    this.evaluator.hydrate(bars);
    console.log(
      `Loaded ${bars.length} historical bars for DayTradeMicroScalp context.`,
    );
  }

  public async evaluateStrategy(bar: Bar): Promise<TradeSignal> {
    try {
      const verification = await this.evaluator.evaluate(bar, this.criteria);
      const { meetsCriteria, metrics } = verification;

      const action = meetsCriteria ? "BUY" : "HOLD";
      const confidence = meetsCriteria
        ? Math.min(0.5 + metrics.rvol / 10, 1)
        : 0;

      return {
        symbol: bar.symbol,
        action,
        confidence,
        reason: meetsCriteria
          ? `CONFIRMED: Opening momentum holds VWAP ($${metrics.vwap.toFixed(2)}) with ${metrics.rvol.toFixed(2)}x relative volume.`
          : `WAITING: Opening momentum and liquidity filters are not all confirmed.`,
      };
    } catch (error) {
      console.error(
        `Error processing DayTradeMicroScalp Strategy block for ${bar.symbol}:`,
        error,
      );
      return {
        symbol: bar.symbol,
        action: "HOLD",
        confidence: 0,
        reason: "Internal tracking validation error.",
      };
    }
  }
}
