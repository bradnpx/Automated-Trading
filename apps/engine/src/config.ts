import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { StrategyIdentifier } from "./strategies/StrategyFactory";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

interface StrategyConfig {
  id: string;
  name: string;
  watchlist: string[];
  takeProfitPct?: number;
  stopLossPct?: number;
}

function parseStrategiesFromEnv(): StrategyConfig[] {
  const strategiesMap: Record<string, Partial<StrategyConfig>> = {};

  // 1. Loop through all environment keys currently loaded
  console.log("Loading Strategies from .env");
  Object.keys(process.env).forEach((key) => {
    // console.log(process.env, key)
    // This regex looks for patterns like STRATEGY_001_NAME, capturing the index and suffix
    const match = key.match(/^STRATEGY_(\d+)_(NAME|ID|WATCHLIST)$/);

    if (match) {
      const [, index, property] = match;
      const value = process.env[key];

      if (!value) return;

      // Initialize the placeholder object for this index group if it doesn't exist
      if (!strategiesMap[index]) {
        strategiesMap[index] = {};
      }

      // 2. Assign properties and clean data formats
      if (property === "NAME") {
        strategiesMap[index].name = value;
      } else if (property === "ID") {
        strategiesMap[index].id = value;
      } else if (property === "WATCHLIST") {
        // Split comma-separated tickers and trim potential whitespace
        strategiesMap[index].watchlist = value.split(",").map((s) => s.trim());
      } else if (property === "PNL") {
        const [tpRaw, slRaw] = [
          Number(value.split("/")[0]),
          Number(value.split("/")[1]),
        ];

        if (!isNaN(tpRaw)) {
          strategiesMap[index].takeProfitPct = tpRaw / 100
        }
        if (!isNaN(slRaw)) {
          strategiesMap[index].stopLossPct = slRaw / 100
        }
      }
    }
  });

  // 3. Convert the grouped index object into a clean array
  // Filter ensures partial/incomplete .env setups don't pass broken objects into your engine
  return Object.values(strategiesMap).filter(
    (strat): strat is StrategyConfig =>
      !!strat.id && !!strat.name && Array.isArray(strat.watchlist),
  );
}

export const ACTIVE_STRATEGIES = parseStrategiesFromEnv();

/**
 * Dynamically generates a flat list of all active tickers to subscribe to.
 * Result: ['SPX', 'SPXL', 'SPXS', 'SPY', 'AAPL', ...]
 */
export const GLOBAL_WATCHLIST: string[] = Array.from(
  new Set(ACTIVE_STRATEGIES.flatMap((strat) => strat.watchlist)),
);

export const SYMBOL_STRATEGY_MAP: Record<string, StrategyIdentifier> = {};
export const STRATEGY_RISK_MAP: Record<string, { takeProfitPct: number; stopLossPct: number }> = {};
export const ALL_TRACKED_SYMBOLS: string[] = [];

for (const strategy of ACTIVE_STRATEGIES) {
  for (const symbol of strategy.watchlist) {
    SYMBOL_STRATEGY_MAP[symbol] = strategy.id as StrategyIdentifier;
    if (strategy.takeProfitPct !== undefined && strategy.stopLossPct !== undefined) {
      STRATEGY_RISK_MAP[strategy.id] = {
        takeProfitPct: strategy.takeProfitPct,
        stopLossPct: strategy.stopLossPct
      };
    }
    if (!ALL_TRACKED_SYMBOLS.includes(symbol)) {
      ALL_TRACKED_SYMBOLS.push(symbol);
    }
  }
}

export const TRADING_CONFIG = {
  RISK_PER_TRADE: 0.05, // 5% of total equity
  PORT_WS_BROADCASTER: 4000,
  PORT_KILL_SWITCH_API: 4001,
};
