import { Bar, TradeSignal } from '@my-platform/types';
import { RSI, VWAP } from 'technicalindicators';

export class BiotechMomentumStrategy {
  private history: Bar[] = [];
  private readonly lookback = 14;

  public hydrate(bars: Bar[]) {
    this.history = [...bars];
    console.log(`Loaded ${this.history.length} historical bars for warmup.`);
  }

  /**
   * Processes a new bar and returns a signal
   */
  public update(bar: Bar): TradeSignal {
    this.history.push(bar);
    if (this.history.length > 100) this.history.shift(); // Keep memory lean

    // 1. Calculate Indicators
    const prices = this.history.map(b => b.close);
    const volumes = this.history.map(b => b.volume);
    
    // Simple RSI calculation
    const rsiValues = RSI.calculate({ values: prices, period: this.lookback });
    const currentRSI = rsiValues[rsiValues.length - 1];

    // VWAP Confirmation
    // (Note: Real VWAP requires intraday cumulative data, 
    // but we'll use a rolling session-based mock here)
    const currentVWAP = this.calculateRollingVWAP();

    // 2. Logic: The "Biotech Breakout"
    // Rule: Price > VWAP (Bullish) AND RSI < 70 (Not yet overbought)
    const isBullish = bar.close > currentVWAP && currentRSI < 70;
    const action = isBullish ? 'BUY' : 'HOLD';

    return {
      symbol: bar.symbol,
      action,
      confidence: isBullish ? 0.8 : 0,
      reason: `Price ($${bar.close}) > VWAP ($${currentVWAP.toFixed(2)}) with RSI at ${currentRSI?.toFixed(1)}`,
    };
  }

  private calculateRollingVWAP(): number {
    const recent = this.history.slice(-20);
    const totalTypicalPriceVolume = recent.reduce((sum, b) => sum + (b.close * b.volume), 0);
    const totalVolume = recent.reduce((sum, b) => sum + b.volume, 0);
    return totalTypicalPriceVolume / totalVolume;
  }
}