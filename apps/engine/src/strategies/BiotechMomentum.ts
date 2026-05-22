import { Bar, TradeSignal } from "@my-platform/types";
import { RSI, VWAP } from "technicalindicators";
import { IStrategy } from "./IStrategy";

export class BiotechMomentumStrategy implements IStrategy {
  private history: Bar[] = [];
  private readonly lookback = 14;
  private readonly VOLUME_MULTIPLIER = 2.0;

  public hydrate(bars: Bar[]) {
    this.history = [...bars];
    console.log(`Loaded ${this.history.length} historical bars for warmup.`);
  }

  /**
   * Processes a new bar and returns a signal
   */
  public evaluateStrategy(bar: Bar): TradeSignal {
    this.history.push(bar);
    if (this.history.length > 100) this.history.shift(); // Keep memory lean

    if (this.history.length < this.lookback) {
      return {
        symbol: bar.symbol,
        action: "HOLD",
        confidence: 0,
        reason: "Warming up...",
      };
    }
    // 1. Calculate Indicators
    const prices = this.history.map((b) => b.close);
    const volumes = this.history.map((b) => b.volume);

    // Simple RSI calculation
    const rsiValues = RSI.calculate({ values: prices, period: this.lookback });
    const currentRSI = rsiValues[rsiValues.length - 1];

    // VWAP Confirmation
    // (Note: Real VWAP requires intraday cumulative data,
    // but we'll use a rolling session-based mock here)
    const currentVWAP = this.calculateRollingVWAP();

    // Calculate Volume Surge (RVOL)
    // We look at the last 20 bars to determine Average volume
    const recentBars = this.history.slice(-21, -1); // -1 exclude current bar
    const avgVolume =
      recentBars.reduce((sum, b) => sum + b.volume, 0) / recentBars.length;
    const rvol = bar.volume / avgVolume;

    const isTrending = bar.close > currentVWAP;
    const hasRoom = currentRSI < 70;
    const isSurging = rvol >= this.VOLUME_MULTIPLIER;

    const isBullish = isTrending && hasRoom && isSurging;
    const action = isBullish ? "BUY" : "HOLD";

    // Dynamic Confidence
    // Scale confidence based on RVOL (a 5x surge is more 'confident' than a 2x surge)
    const confidence = isBullish ? Math.min(0.5 + rvol / 10, 1) : 0;

    return {
      symbol: bar.symbol,
      action,
      confidence: confidence,
      reason: isBullish
        ? `TRIPLE CONFIRMED: Price ($${bar.close}) > VWAP, RSI at ${currentRSI.toFixed(1)}, and RVOL at ${rvol.toFixed(2)}x`
        : `WAITING: ${!isTrending ? "Price < VWAP" : !hasRoom ? "Overbought (RSI > 70)" : "Low Volume Surge"}`,
    };
  }

  private calculateRollingVWAP(): number {
    const recent = this.history.slice(-20);
    const totalTypicalPriceVolume = recent.reduce(
      (sum, b) => sum + b.close * b.volume,
      0,
    );
    const totalVolume = recent.reduce((sum, b) => sum + b.volume, 0);
    return totalVolume === 0 ? 0 : totalTypicalPriceVolume / totalVolume;
  }
}
