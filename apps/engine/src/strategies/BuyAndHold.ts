import { Bar, TradeSignal } from "@my-platform/types";
import { IStrategy } from "./IStrategy.js";

/**
 * Buy-and-hold baseline: equal-weight target across all symbols, set once, held forever.
 * 
 * The benchmark every other strategy must justify its existence against. After the initial
 * allocation it emits no further signals (target weight unchanged), so turnover is just the
 * one rebalance. It's also the acceptance test for the whole pipeline.
 */
export class BuyAndHold implements IStrategy {
  private _allocated = false;

  public hydrate(bars: Bar[], prevLow?: number): void {
    // Buy and hold doesn't need historical data to make its decision
  }

  public evaluateStrategy(bar: Bar): TradeSignal {
    if (!this._allocated) {
      this._allocated = true;
      return {
        symbol: bar.symbol,
        action: "BUY",
        confidence: 1.0,
        reason: "buyandhold init"
      };
    }

    return {
      symbol: bar.symbol,
      action: "HOLD",
      confidence: 0,
      reason: "already allocated"
    };
  }
}
