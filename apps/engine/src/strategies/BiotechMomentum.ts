// src/strategies/BiotechMomentum.ts
import { Bar, TradeSignal } from "@my-platform/types";
import { EvaluateStrategy, StrategyCriterion } from "./evaluateStrategy.js";
import { IStrategy } from "./IStrategy.js";

export class BiotechMomentumStrategy implements IStrategy {
  private evaluator = new EvaluateStrategy();

  // Declarative strategy configuration manifest
  private criteria: StrategyCriterion[] = [
    "isRsiBelow70",
    "isAboveRollingVWAP",
    "isRollingVolumeSurge",
  ];

  public hydrate(bars: Bar[], prevLow?: number) {
    // Pipe lookback historical bars straight into rules parser context memory
    this.evaluator.hydrate(bars);
    console.log(
      `Loaded ${bars.length} historical bars for Biotech Momentum context.`,
    );
  }

  public async evaluateStrategy(bar: Bar): Promise<TradeSignal> {
    try {
      const verification = await this.evaluator.evaluate(bar, this.criteria);
      const { meetsCriteria, metrics } = verification;

      const action = meetsCriteria ? "BUY" : "HOLD";
      // Access centralized indicator tracking safely to compute scalable confidence levels
      const confidence = meetsCriteria
        ? Math.min(0.5 + metrics.rvol / 10, 1)
        : 0;

      return {
        symbol: bar.symbol,
        action,
        confidence,
        reason: meetsCriteria
          ? `TRIPLE CONFIRMED: Price ($${bar.close}) > VWAP, RSI at ${metrics.rsi.toFixed(1)}, and RVOL at ${metrics.rvol.toFixed(2)}x`
          : `WAITING: Criteria validation triggers unfulfilled.`,
      };
    } catch (error) {
      console.error(
        `Error processing BiotechMomentum Strategy block for ${bar.symbol}:`,
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
