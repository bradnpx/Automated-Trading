import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

export interface MasterWatchlistItem {
  symbol: string;
  strategy: string;
  takeProfitPct?: number;
  stopLossPct?: number;
  totalRisk?: number;
  expiration?: number;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

const defaultRisk = process.env.RISK_PER_TRADE || 0.05;
export const POLYGON_API = process.env.POLYGON_API_KEY;
export const MASTER_WATCHLIST = new Map<string, MasterWatchlistItem>();
export const ALL_TRACKED_SYMBOLS: string[] = [];
export const GLOBAL_WATCHLIST: string[] = [];
export const SYMBOL_STRATEGY_MAP = MASTER_WATCHLIST;
export const STRATEGY_RISK_MAP: Record<
  string,
  { takeProfitPct: number; stopLossPct: number }
> = {};

export function syncTrackingCaches(): void {
  ALL_TRACKED_SYMBOLS.length = 0;
  ALL_TRACKED_SYMBOLS.push(...MASTER_WATCHLIST.keys());

  GLOBAL_WATCHLIST.length = 0;
  GLOBAL_WATCHLIST.push(...ALL_TRACKED_SYMBOLS);

  for (const key of Object.keys(STRATEGY_RISK_MAP)) {
    delete STRATEGY_RISK_MAP[key];
  }
  for (const [symbol, item] of MASTER_WATCHLIST.entries()) {
    if (item.takeProfitPct !== undefined && item.stopLossPct !== undefined) {
      STRATEGY_RISK_MAP[symbol] = {
        takeProfitPct: item.takeProfitPct,
        stopLossPct: item.stopLossPct,
      };
    }
  }
}

function loadManualStrategiesFromEnv(): void {
  const keys = Object.keys(process.env).filter((key) =>
    key.match(/^STRATEGY_(\d+)_WATCHLIST$/),
  );

  console.log(
    `🔍 [CONFIG] Found ${keys.length} manual strategy watchlists in .env`,
  );

  for (const key of keys) {
    const match = key.match(/^(STRATEGY_\d+)_WATCHLIST$/);
    if (!match) continue;
    const prefix = match[1];

    const tickersRaw = process.env[key];
    if (!tickersRaw) continue;

    const tickers = tickersRaw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const strategyName = process.env[`${prefix}_NAME`] || "defaultStrategy";

    const totalRisk: number = Number(process.env[`${prefix}_RISK_PER_TRADE`]);
    const takeProfit = process.env[`${prefix}_TAKE_PROFIT`]
      ? parseFloat(process.env[`${prefix}_TAKE_PROFIT`]!)
      : 2.2;
    const stopLoss = process.env[`${prefix}_STOP_LOSS`]
    ? parseFloat(process.env[`${prefix}_STOP_LOSS`]!)
    : 2.0;
    const expiration = Number(process.env[`${prefix}_EXPIRATION`]);

    for (const symbol of tickers) {
      MASTER_WATCHLIST.set(symbol, {
        symbol,
        strategy: strategyName,
        takeProfitPct: takeProfit,
        stopLossPct: stopLoss,
        totalRisk: totalRisk,
        expiration: expiration,
      });
      console.log(
        `📌 [CONFIG] Loaded manual ticker ${symbol} to Master Watchlist [Strategy: ${strategyName}]`,
      );
    }
  }
}

loadManualStrategiesFromEnv();
syncTrackingCaches();

console.log(
  `🚀 Master Watchlist initialized with ${MASTER_WATCHLIST.size} synchronized tickers.`,
);

export const TRADING_CONFIG = {
  RISK_PER_TRADE: Number(defaultRisk), // 5% of total equity
  PORT_WS_BROADCASTER: 4000,
  PORT_KILL_SWITCH_API: 4001,
};
