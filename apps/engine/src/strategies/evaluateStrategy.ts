// src/strategies/evaluateStrategy.ts
import { Bar } from "@my-platform/types";
import { RSI } from "technicalindicators";
import { getPremarketChange } from "../functions/getPremarketChange.js";
import getTradingSession from "../functions/getTradingSession.js";
import checkForBounce from "../functions/checkForBounce.js";

export type StrategyCriterion =
  | "isAlive"
  | "isInSession"
  | "isPremarket"
  | "isInPriceRange"
  | "isAboveTen"
  | "isSurgingVolume"
  | "isBullish"
  | "isBounced"
  // --- New Core Strategy Criteria ---
  | "isRsiBelow70"
  | "isAboveRollingVWAP"
  | "isBelowRollingVWAPWithDistance"
  | "isRollingVolumeSurge"
  | "isMorningSession"
  | "isPdlSweptAndReclaimed"
  | "isBullishFollowthrough"
  // suggested by gpt
  | "isHighRVOL"
  | "isWithinOpeningWindow"
  | "isHoldingVWAP"
  | "isPremarketGapper"
  | "isNotExtended"
  | "isStrongBullCandle";

export class EvaluateStrategy {
  private history: Bar[] = [];

  // Stateful sweep metrics needed for liquidity hunt tracking
  private barsSinceSweep = 999;
  private pendingSweep = false;

  public hydrate(bars: Bar[]) {
    this.history = [...bars];
  }

  /**
   * Resets internal liquidity tracking state hooks after an execution order fills
   */
  public resetSweepState() {
    this.pendingSweep = false;
    this.barsSinceSweep = 999;
  }

  public async evaluate(
    bar: Bar,
    criteriaToTest: StrategyCriterion[],
    prevLow: number = 0,
  ): Promise<{
    meetsCriteria: boolean;
    report: Record<string, boolean>;
    metrics: { rsi: number; vwap: number; rvol: number; pendingSweep: boolean };
  }> {
    // Maintain rolling memory state footprint
    this.history.push(bar);
    if (this.history.length > 200) this.history.shift();

    if (this.history.length >= 3) {
      console.log("DEBUG Bar Memory Check - Head/Tail snapshots:", {
        earliest: this.history[0].timestamp,
        current: this.history[this.history.length - 1].timestamp,
      });
    }

    const report: Record<string, boolean> = {};
    let premarketCache: any = null;

    const getPremarket = async () => {
      if (!premarketCache) {
        premarketCache = await getPremarketChange(bar.symbol);
      }
      return premarketCache;
    };

    // --- Compute Strategy Metrics Upfront ---
    const prices = this.history.map((b) => b.close);

    // 1. RSI
    const rsiValues = RSI.calculate({ values: prices, period: 14 });
    const currentRSI =
      rsiValues && rsiValues.length > 0 ? rsiValues[rsiValues.length - 1] : 50;

    // 2. Volume Surge Ratio (RVOL)
    const recentVolumeBars = this.history.slice(-21, -1); // Exclude current bar
    const avgVolume =
      recentVolumeBars.length > 0
        ? recentVolumeBars.reduce((sum, b) => sum + b.volume, 0) /
          recentVolumeBars.length
        : bar.volume;
    const rvol = avgVolume > 0 ? bar.volume / avgVolume : 1;

    // 3. Rolling VWAP variants (Supports Close-based and Typical-based logic)
    const vwapClose = this.calculateRollingVWAP("close");
    const vwapTypical = this.calculateRollingVWAP("typical");

    // Evaluate each rule against telemetry state maps
    for (const criterion of criteriaToTest) {
      switch (criterion) {
        case "isAlive":
          report["isAlive"] = true;
          break;

        case "isInSession": {
          const session = getTradingSession();
          report["isInSession"] = session === "market";
          break;
        }

        case "isPremarket": {
          const session = getTradingSession();
          report["isPremarket"] = session === "premarket";
          break;
        }

        case "isInPriceRange":
          report["isInPriceRange"] = bar.close >= 2 && bar.close <= 20;
          break;

        case "isBullish":
          report["isBullish"] = bar.close > bar.open;
          break;

        case "isAboveTen": {
          const data = await getPremarket();
          report["isAboveTen"] = data ? data.percentageChange >= 10 : false;
          break;
        }

        case "isSurgingVolume": {
          const data = await getPremarket();
          report["isSurgingVolume"] = data
            ? data.premarketVolume >= 500
            : false;
          break;
        }

        case "isBounced": {
          const priorBar = this.history[this.history.length - 2];
          report["isBounced"] = priorBar
            ? checkForBounce({ sourceBar: priorBar, targetBar: bar })
            : false;
          break;
        }

        // --- NEW STRATEGY CRITERIA IMPLEMENTATIONS ---
        case "isRsiBelow70":
          report["isRsiBelow70"] = currentRSI < 70;
          break;

        case "isAboveRollingVWAP":
          report["isAboveRollingVWAP"] = bar.close > vwapClose;
          break;

        case "isBelowRollingVWAPWithDistance":
          report["isBelowRollingVWAPWithDistance"] =
            vwapTypical - bar.close >= 0.5; // Requires 50c breathing room
          break;

        case "isRollingVolumeSurge":
          report["isRollingVolumeSurge"] = rvol >= 2.0; // 2x volume anomaly trigger
          break;

        case "isMorningSession": {
          const date = new Date(bar.timestamp);
          const nyHour = date.getUTCHours() - 4; // Crude standard NY offset
          const min = date.getUTCMinutes();
          report["isMorningSession"] =
            (nyHour === 9 && min >= 45) || (nyHour === 10 && min <= 30);
          break;
        }

        case "isWithinOpeningWindow": {
          const date = new Date(bar.timestamp);
          const nyHour = date.getUTCHours() - 4; // Crude standard NY offset
          const min = date.getUTCMinutes();
          report["isWithinOpeningWindow"] =
            (nyHour === 9 && min >= 45) || (nyHour === 10 && min <= 30);
          break;
        }

        case "isPdlSweptAndReclaimed": {
          if (prevLow > 0) {
            const sweepOccurred = bar.low < prevLow;
            if (sweepOccurred) {
              this.pendingSweep = true;
              this.barsSinceSweep = 0;
            } else {
              this.barsSinceSweep++;
            }
            const isFirstTouch = this.barsSinceSweep > 20; // Lookback window gap protection
            const isReclaimed = this.pendingSweep && bar.close > prevLow;

            report["isPdlSweptAndReclaimed"] = isFirstTouch && isReclaimed;
          } else {
            report["isPdlSweptAndReclaimed"] = false;
          }
          break;
        }

        case "isHighRVOL": {
          report["isHighRVOL"] = rvol >= 5;
          break;
        }

        case "isStrongBullCandle": {
          const body = Math.abs(bar.close - bar.open);
          const range = bar.high - bar.low;

          report["isStrongBullCandle"] =
            bar.close > bar.open && range > 0 && body / range >= 0.6;

          break;
        }

        case "isHoldingVWAP": {
          const tolerance = 0.0025;

          report["isHoldingVWAP"] = bar.low > vwapTypical * (1 - tolerance);

          break;
        }

        case "isNotExtended": {
          const extension = (bar.close - vwapTypical) / vwapTypical;

          report["isNotExtended"] = extension <= 0.03;

          break;
        }

        case "isBullishFollowthrough": {
          const priorBar = this.history[this.history.length - 2];
          report["isBullishFollowthrough"] =
            bar.close > bar.open &&
            (priorBar ? bar.close > priorBar.close : true);
          break;
        }

        default:
          console.warn(`Warning: Criterion "${criterion}" is not supported.`);
      }

      console.log(
        `${bar.symbol} - ${criterion}: ${report[criterion] ? "✅" : "❌"}`,
      );
    }

    const meetsCriteria = criteriaToTest.every((key) => report[key] === true);

    return {
      meetsCriteria,
      report,
      metrics: {
        rsi: currentRSI,
        vwap: criteriaToTest.includes("isBelowRollingVWAPWithDistance")
          ? vwapTypical
          : vwapClose,
        rvol: rvol,
        pendingSweep: this.pendingSweep,
      },
    };
  }

  private calculateRollingVWAP(type: "close" | "typical"): number {
    const recent = this.history.slice(-20);
    if (recent.length === 0) return 0;

    let totalTypicalPriceVolume = 0;
    let totalVolume = 0;

    for (const b of recent) {
      const price =
        type === "typical" ? (b.high + b.low + b.close) / 3 : b.close;
      totalTypicalPriceVolume += price * b.volume;
      totalVolume += b.volume;
    }

    return totalVolume === 0 ? 0 : totalTypicalPriceVolume / totalVolume;
  }
}
