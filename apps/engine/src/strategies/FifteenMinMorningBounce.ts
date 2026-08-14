import { Bar, TradeSignal } from "@my-platform/types";
import { EvaluateStrategy, StrategyCriterion } from "./evaluateStrategy";
import { IStrategy } from "./IStrategy";

export class FifteenMinMorningBounce implements IStrategy {
  private evaluator = new EvaluateStrategy();
  private prevLow: number = 0;

  // Morning PDL liquidity-sweep reclaim during the defined opening window.
  private criteria: StrategyCriterion[] = [
    "isInSession",
    "isWithinOpeningWindow",
    "isPdlSweptAndReclaimed",
    "isBullishFollowthrough",
  ];

  public hydrate(bars: Bar[], prevLow?: number) {
    this.prevLow = prevLow || 0;
    this.evaluator.hydrate(bars);
  }

  public async evaluateStrategy(bar: Bar): Promise<TradeSignal> {
    try {
      if (!this.prevLow) {
        return this.hold(
          bar,
          "Aborting execution: Missing verified Previous Day Low metric.",
        );
      }

      // Execute dynamic parsing framework using local previous support lookups
      const verification = await this.evaluator.evaluate(
        bar,
        this.criteria,
        this.prevLow,
      );
      const { meetsCriteria, metrics } = verification;

      if (meetsCriteria) {
        // Clear state boundaries within structural evaluator instance so it doesn't double-trigger
        this.evaluator.resetSweepState();

        console.log("💲 Strategy Execution Pattern: Match Found");
        return {
          symbol: bar.symbol,
          action: "BUY",
          confidence: 1,
          reason: `Morning PDL reclaim after sweep | PDL ${this.prevLow.toFixed(2)}`,
        };
      }

      return this.hold(
        bar,
        `PDL ${this.prevLow.toFixed(2)} | sweep pending:${metrics.pendingSweep}`,
      );
    } catch (error) {
      console.error(
        `Error inside Liquidity Sweep Strategy block for ${bar.symbol}:`,
        error,
      );
      return this.hold(bar, "Internal tracking verification error.");
    }
  }

  private hold(bar: Bar, reason: string): TradeSignal {
    return {
      symbol: bar.symbol,
      action: "HOLD",
      confidence: 0,
      reason,
    };
  }
}
