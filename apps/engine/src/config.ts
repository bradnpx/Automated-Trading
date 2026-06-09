import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { StrategyIdentifier } from "./strategies/StrategyFactory";
import { bootstrapMarketSession } from "./scanner";

interface StrategyConfig {
  id: string;
  name: string;
  watchlist: string[];
  takeProfitPct?: number;
  stopLossPct?: number;
}

export interface MasterWatchlistItem {
  symbol: string;
  strategy: string;
  takeProfitPct?: number;
  stopLossPct?: number;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

export const POLYGON_API = process.env.POLYGON_API_KEY;


function parseStrategiesFromEnv(): StrategyConfig[] {
  try {
    const raw = process.env.STRATEGIES;
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    // Type-guard filtering ensures runtime schema compliance
    return parsed.filter(
      (strat: any): strat is StrategyConfig =>
        !!strat.id && !!strat.name && Array.isArray(strat.watchlist),
    );
  } catch (error) {
    console.error("❌ Failed to parse strategies from env:", error);
    return [];
  }
}

export const MASTER_WATCHLIST = new Map<string, MasterWatchlistItem>();
export const ACTIVE_STRATEGIES = parseStrategiesFromEnv();

for (const strategy of ACTIVE_STRATEGIES) {
  for (const symbol of strategy.watchlist) {
    MASTER_WATCHLIST.set(symbol, {
      symbol,
      strategy: strategy.id || strategy.name,
      takeProfitPct: strategy.takeProfitPct,
      stopLossPct: strategy.stopLossPct,
    });
  }
}

/**
 * Feed dynamic scanner results into watchlist
 */
try {
  const scannerSymbols = await bootstrapMarketSession();
  for (const symbol of scannerSymbols) {
    MASTER_WATCHLIST.set(symbol, {
      symbol,
      strategy: "dayTradeMicroScalp",
      stopLossPct: 2,
      takeProfitPct: 2.2,
    });
  }
} catch (error) {
  console.error("❌ Failed to bootstrap market session scanner symbols:", error);
}


// ==========================================
// 4. BACKWARD COMPATIBILITY LAYER
// ==========================================
// Dynamically derived lists guarantee data integrity across all app interfaces.

/**
 * Flattened array tracking every active symbol across all rules engines.
 * Use this directly for your WebSocket data stream subscriptions.
 */
export const ALL_TRACKED_SYMBOLS: string[] = Array.from(MASTER_WATCHLIST.keys());
export const GLOBAL_WATCHLIST: string[] = ALL_TRACKED_SYMBOLS;

/**
 * Alias targeting modules that expect SYMBOL_STRATEGY_MAP dictionary format.
 */
export const SYMBOL_STRATEGY_MAP = MASTER_WATCHLIST;

/**
 * Derived lookup dictionary mapping individual symbols to risk boundaries.
 */
export const STRATEGY_RISK_MAP: Record<
  string,
  { takeProfitPct: number; stopLossPct: number }
> = {};

for (const [symbol, item] of MASTER_WATCHLIST.entries()) {
  if (item.takeProfitPct !== undefined && item.stopLossPct !== undefined) {
    STRATEGY_RISK_MAP[symbol] = {
      takeProfitPct: item.takeProfitPct,
      stopLossPct: item.stopLossPct,
    };
  }
}

console.log(`🚀 Master Watchlist initialized with ${MASTER_WATCHLIST.size} synchronized tickers.`);

export const TRADING_CONFIG = {
  RISK_PER_TRADE: 0.05, // 5% of total equity
  PORT_WS_BROADCASTER: 4000,
  PORT_KILL_SWITCH_API: 4001,
};
