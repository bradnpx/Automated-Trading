import { Bar } from "@my-platform/types";
import { getPremarketChange } from "../functions/getPremarketChange";
import getTradingSession from "../functions/getTradingSession";

// Define a strict TypeScript union of all testable criteria
export type StrategyCriterion =
  | "isInSession"
  | "isInPriceRange"
  | "isAboveTen"
  | "isSurgingVolume"
  | "isBullish";

export class EvaluateStrategy {
  private history: Bar[] = [];

  public hydrate(bars: Bar[]) {
    this.history = [...bars];
  }

  /**
   * Evaluates a candlestick bar against a specific, dynamic list of rules.
   * @param bar The current market bar data
   * @param criteriaToTest Array of specific rule keys you want to enforce right now
   */
  public async evaluate(
    bar: Bar,
    criteriaToTest: StrategyCriterion[],
  ): Promise<{ meetsCriteria: boolean; report: Record<string, boolean> }> {
    // Maintain rolling memory state
    this.history.push(bar);
    if (this.history.length > 200) this.history.shift();

    const report: Record<string, boolean> = {};

    // Cache layer to ensure we call Polygon at most ONCE per bar execution,
    // and ONLY if an async rule actually demands it.
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
          report["isInSession"] =
            session === "premarket" || session === "market";
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
