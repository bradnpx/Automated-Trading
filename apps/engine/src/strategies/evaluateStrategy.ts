import { Bar } from "@my-platform/types";
import { getPremarketChange } from "../functions/getPremarketChange.js";
import getTradingSession from "../functions/getTradingSession.js";
import checkForBounce from "../functions/checkForBounce.js";

export type StrategyCriterion =
  | "isInSession"
  | "isPremarket"
  | "isInPriceRange"
  | "isAboveTen"
  | "isSurgingVolume"
  | "isBullish"
  | "isFifteenMinutes"
  | "isBounced";

export class EvaluateStrategy {
  private history: Bar[] = [];

  public hydrate(bars: Bar[]) {
    this.history = [...bars];
  }

  public async evaluate(
    bar: Bar,
    criteriaToTest: StrategyCriterion[],
  ): Promise<{ meetsCriteria: boolean; report: Record<string, boolean> }> {
    // Maintain rolling memory state
    this.history.push(bar);
    if (this.history.length > 200) this.history.shift();

    // Guard debugging logs to prevent "undefined reading" runtime crashes during startup
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

    // Evaluate each requested rule dynamically
    for (const criterion of criteriaToTest) {
      switch (criterion) {
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
          // Since "bar" was pushed at line 20, length - 1 is the CURRENT bar.
          // The actual true prior bar data resides safely at index footprint length - 2.
          const priorBar = this.history[this.history.length - 2];

          report["isBounced"] = priorBar
            ? checkForBounce({ sourceBar: priorBar, targetBar: bar })
            : false;
          break;
        }

        default:
          console.warn(`Warning: Criterion "${criterion}" is not supported.`);
      }
    }

    // Determine if every single rule passed to this array returned true
    const meetsCriteria = criteriaToTest.every((key) => report[key] === true);

    return {
      meetsCriteria,
      report,
    };
  }
}
