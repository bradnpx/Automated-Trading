import { Bar, TradeSignal } from "@my-platform/types";
import { EvaluateStrategy, StrategyCriterion } from "./evaluateStrategy.js";
import { IStrategy } from "./IStrategy.js";
import { internalsService } from "../modules/internals/internals.service.js";

export class VixVWAPReversion implements IStrategy {
  private evaluator = new EvaluateStrategy();
  private lastSignalTime = 0;
  private readonly cooldownMs = 15 * 60 * 1000;

  private criteria: StrategyCriterion[] = [
    "isInSession",
    "isVixElevated",
    "isGapDay",
    "isExtendedFromVWAP",
    "isExtremeTick",
    "isVWAPReversionSignal",
  ];

  public hydrate(bars: Bar[], prevLow?: number) {
    this.evaluator.hydrate(bars);
    console.log(`🔥 Loaded ${bars.length} bars for VIX VWAP Reversion.`);
  }

  public async evaluateStrategy(bar: Bar): Promise<TradeSignal> {
    try {
      const timestamp = new Date(bar.timestamp).getTime();

      if (timestamp - this.lastSignalTime < this.cooldownMs) {
        return this.hold(bar, "VIX reversion cooldown active.");
      }

      // We rely on the background task keeping internalsService up to date.
      // If we need the absolute latest, we can call it here, but typically we want to avoid blocking the fast path.
      const snapshot = internalsService.getSnapshot();
      
      const verification = await this.evaluator.evaluate(
        bar,
        this.criteria,
        0,
        { vix: snapshot.vix, tick: snapshot.tick }
      );

      const { meetsCriteria, metrics, report } = verification;

      if (!meetsCriteria) {
        return this.hold(bar, `Waiting for setup. Failed criteria: ${Object.keys(report).filter(k => !report[k]).join(", ")}`);
      }

      this.lastSignalTime = timestamp;
      
      // Determine direction from metrics if possible, or fallback.
      // Since our criteria passed, we know one of the reversals is true.
      // A negative gap and negative extension means LONG.
      const isLong = (snapshot.tick ?? 0) <= -1000;

      if (isLong) {
        console.log(`🟢 VIX VWAP LONG: ${bar.symbol}`);
        return {
          symbol: bar.symbol,
          action: "BUY",
          confidence: 0.8,
          reason: `VIX fade LONG | VIX ${snapshot.vix?.toFixed(1)} | TICK ${snapshot.tick?.toFixed(0)}`,
        };
      } else {
        console.log(`🔴 VIX VWAP SHORT: ${bar.symbol}`);
        return {
          symbol: bar.symbol,
          action: "SELL",
          confidence: 0.8,
          reason: `VIX fade SHORT | VIX ${snapshot.vix?.toFixed(1)} | TICK ${snapshot.tick?.toFixed(0)}`,
        };
      }

    } catch (error) {
      console.error(`❌ VIX VWAP Reversion error for ${bar.symbol}:`, error);
      return this.hold(bar, "VIX strategy execution failure.");
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
