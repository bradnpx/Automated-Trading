import { Bar, TradeSignal } from "@my-platform/types";
import { EvaluateStrategy, StrategyCriterion } from "./evaluateStrategy.js";
import { IStrategy } from "./IStrategy.js";

export class DayTradeMicroScalp implements IStrategy {
  private evaluator = new EvaluateStrategy();

  // Updated criteria: we removed overly restrictive/broken checks like isLowFloat, isPennyStock,
  // and isHighRVOL (which fail due to scanner hydration issues) and focus on pure price action.
  private criteria: StrategyCriterion[] = [
    "isBullish",
    "isHoldingVWAP",
    "isNotExtended",
  ];

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
          ? `CONFIRMED: Bullish candle holding VWAP ($${metrics.vwap.toFixed(2)}) and not extended.`
          : `WAITING: Criteria validation triggers unfulfilled.`,
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
