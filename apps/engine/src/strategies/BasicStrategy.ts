import { Bar, TradeSignal } from "@my-platform/types";
import { EvaluateStrategy, StrategyCriterion } from "./evaluateStrategy.js";
import { IStrategy } from "./IStrategy.js";

export class BasicStrategy implements IStrategy {
  // Initialize a long-lived evaluator context to preserve lookback history arrays
  private evaluator = new EvaluateStrategy();
  private prevLow: number = 0;

  // Set the precise criteria manifest this specific strategy is responsible for verifying
  private criteria: StrategyCriterion[] = [
    "isBullish",
  ];

  public hydrate(bars: Bar[], prevLow?: number) {
    this.prevLow = prevLow || 0;

    // Forward the initial system pre-warm bars directly into your rules engine
    this.evaluator.hydrate(bars);
  }

  // Changed return layout from 'TradeSignal' to 'Promise<TradeSignal>' to satisfy async rules
  public async evaluateStrategy(bar: Bar): Promise<TradeSignal> {
    try {
      // Execute rule checking suite dynamically against your defined checklist
      const verification = await this.evaluator.evaluate(bar, this.criteria);

      if (verification.meetsCriteria) {
        return {
          symbol: bar.symbol,
          action: "BUY",
          confidence: 1,
          reason: `Basic strategy rules validated successfully.`,
        };
      }

      // Default fallback state if criteria triggers fail to lock
      return {
        symbol: bar.symbol,
        action: "HOLD",
        confidence: 0,
        reason: "Awaiting validation criteria triggers.",
      };
    } catch (error) {
      console.error(
        `Error processing BasicStrategy loop for ${bar.symbol}:`,
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
