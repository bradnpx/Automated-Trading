import { Bar, TradeSignal } from '@my-platform/types';

export class PDLSweepVWAPReclaim {
  private history: Bar[] = [];
  private prevLow: number = 0; // State: Previous Day Low
  private barsSinceSweep: number = 0; // State: ta.barssince counter

  // Settings from your Pine Script
  private readonly VWAP_DISTANCE = 8.0; 
  private readonly LOOKBACK_PERIOD = 20;

  /**
   * We need to pass the Previous Day Low during hydration
   */
  public hydrate(bars: Bar[], prevLow: number) {
    this.history = [...bars];
    this.prevLow = prevLow;
    console.log(`Loaded strategy for ${bars[0]?.symbol}. PDL: ${this.prevLow}`);
  }

  public update(bar: Bar): TradeSignal {
    const prevBar = this.history[this.history.length - 1];
    this.history.push(bar);
    if (this.history.length > 100) this.history.shift();

    if (!prevBar || this.prevLow === 0) {
        return { symbol: bar.symbol, action: 'HOLD', confidence: 0, reason: 'Waiting for PDL/History' };
    }

    // 1. VWAP Calculation
    const currentVWAP = this.calculateRollingVWAP();

    // 2. Translate Pine Script Logic
    
    // inSession: 09:30 - 10:30 EST
    const date = new Date(bar.timestamp);
    const hour = date.getHours(); // Note: Ensure engine is set to NY Time/UTC accordingly
    const min = date.getMinutes();
    const inSession = (hour === 9 && min >= 30) || (hour === 10 && min <= 30);

    // belowVWAP: (vwap - close) >= 8
    const isBelowVWAP = (currentVWAP - bar.close) >= this.VWAP_DISTANCE;

    // Sweep & Reclaim: low < PDL and close > PDL
    const hasSwept = bar.low < this.prevLow;
    const hasReclaimed = bar.close > this.prevLow;

    // Bullish Candle: close > open and close > close[1]
    const isBullishCandle = bar.close > bar.open && bar.close > prevBar.close;

    // ta.barssince(low < prevLow) > 20
    if (hasSwept) {
        this.barsSinceSweep = 0; // Reset counter on sweep
    } else {
        this.barsSinceSweep++;
    }
    const isFirstTouch = this.barsSinceSweep > this.LOOKBACK_PERIOD;

    // 3. FINAL SIGNAL
    const isLongSetup = inSession && isBelowVWAP && hasSwept && hasReclaimed && isBullishCandle && isFirstTouch;

    return {
      symbol: bar.symbol,
      action: isLongSetup ? 'BUY' : 'HOLD',
      confidence: isLongSetup ? 1.0 : 0,
      reason: isLongSetup 
        ? `PDL Sweep & Reclaim! Dist: ${(currentVWAP - bar.close).toFixed(2)} pts below VWAP.`
        : `Monitoring: RVWAP ${currentVWAP.toFixed(2)} | PDL ${this.prevLow}`,
    };
  }

  private calculateRollingVWAP(): number {
    const recent = this.history.slice(-20);
    const totalTypicalPriceVolume = recent.reduce((sum, b) => sum + (b.close * b.volume), 0);
    const totalVolume = recent.reduce((sum, b) => sum + b.volume, 0);
    return totalVolume === 0 ? 0 : totalTypicalPriceVolume / totalVolume;
  }
}