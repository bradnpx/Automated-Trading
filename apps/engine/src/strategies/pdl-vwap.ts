import { Bar, TradeSignal } from "@my-platform/types";

export class PDLSweepVWAPReclaim {
  private history: Bar[] = [];
  private prevLow: number = 0;

  // State tracking
  private barsSinceSweep: number = 999;
  private pendingSweep: boolean = false;

  private readonly VWAP_DISTANCE = 0.5; // Adjust per asset (stocks ≠ futures)
  private readonly LOOKBACK_PERIOD = 20;

  public hydrate(bars: Bar[], prevLow?: number) {
    this.history = [...bars];
    this.prevLow = prevLow || 0;
  }

  public update(bar: Bar): TradeSignal {
    const prevBar = this.history[this.history.length - 1];
    this.history.push(bar);
    if (this.history.length > 200) this.history.shift();

    if (!prevBar || !this.prevLow) {
      return this.hold(bar, "Waiting for data");
    }

    // ✅ 1. VWAP
    const currentVWAP = this.calculateVWAP();

    // ✅ 2. Time filter (NY session)
    const date = new Date(bar.timestamp);
    const nyHour = date.getUTCHours() - 4; // crude NY conversion (adjust DST properly in prod)
    const min = date.getUTCMinutes();

    const inSession =
      (nyHour === 9 && min >= 30) || (nyHour === 10 && min <= 30);

    // ✅ 3. VWAP condition
    const isBelowVWAP = currentVWAP - bar.close >= this.VWAP_DISTANCE;

    // ✅ 4. Sweep detection
    const sweepOccurred = bar.low < this.prevLow;

    if (sweepOccurred) {
      this.pendingSweep = true;
      this.barsSinceSweep = 0;
    } else {
      this.barsSinceSweep++;
    }

    // ✅ 5. First touch logic
    const isFirstTouch = this.barsSinceSweep > this.LOOKBACK_PERIOD;

    // ✅ 6. Reclaim logic (can happen AFTER sweep)
    const reclaim = this.pendingSweep && bar.close > this.prevLow;

    // ✅ 7. Bullish confirmation
    const isBullish = bar.close > bar.open && bar.close > prevBar.close;

    // ✅ 8. Final setup
    const isLongSetup =
      inSession && isBelowVWAP && isFirstTouch && reclaim && isBullish;

    if (isLongSetup) {
      this.pendingSweep = false; // reset state after trade

      return {
        symbol: bar.symbol,
        action: "BUY",
        confidence: 1,
        reason: `PDL reclaim after sweep | VWAP dist ${(currentVWAP - bar.close).toFixed(2)}`,
      };
    }

    return this.hold(
      bar,
      `VWAP ${currentVWAP.toFixed(2)} | PDL ${this.prevLow} | sweep:${this.pendingSweep}`,
    );
  }

  private hold(bar: Bar, reason: string): TradeSignal {
    return {
      symbol: bar.symbol,
      action: "HOLD",
      confidence: 0,
      reason,
    };
  }

  // ✅ Proper VWAP
  private calculateVWAP(): number {
    const recent = this.history.slice(-20);

    let pv = 0;
    let vol = 0;

    for (const b of recent) {
      const typical = (b.high + b.low + b.close) / 3;
      pv += typical * b.volume;
      vol += b.volume;
    }

    return vol === 0 ? 0 : pv / vol;
  }
}
