import { z } from "zod";

export const SOCKET_EVENTS = {
  BAR: "market_bar",
  SIGNAL: "trade_signal",
  UPDATE: "trade_update",
  ERROR: "engine_error",
  STATUS: "engine_status",
  ACCOUNT: "account_update",
  SCANNER: "scanner_alert",
  HEALTH: "system_health",
  ACTIVE_TRADES: "active_trades_update",
} as const;

export const OrderSchema = z.object({
  id: z.string().uuid(),
  symbol: z.string(),
  qty: z.number().positive(),
  side: z.enum(["buy", "sell"]),
  status: z.enum(["new", "filled", "canceled"]),
});

export type Order = z.infer<typeof OrderSchema>;

export const BarSchema = z.object({
  symbol: z.string(),
  // Use z.preprocess or z.coerce to handle both Strings and Date objects
  timestamp: z.union([z.string(), z.date()]),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
  vwap: z.number().optional(),
});

export type Bar = z.infer<typeof BarSchema>;

export const TradeSignalSchema = z.object({
  symbol: z.string(),
  action: z.enum(["BUY", "SELL", "HOLD"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export type TradeSignal = z.infer<typeof TradeSignalSchema>;

export interface SocketBarPayload {
  symbol: string;
  price: number;
  timestamp: Date | string;
}

export interface AccountPayload {
  equity: number;
  buying_power: number;
  cash: number;
  day_pl: number;
  day_pl_pct: number;
}

export interface TradeRecord {
  symbol: string;
  side: "buy" | "sell";
  qty: string;
  price: string;
  pnl?: number;
  pnl_pct?: number;
  timestamp: string;
  reason: string;
  win_status: "WIN" | "LOSS" | "BREAKEVEN" | "OPENING";
}

export interface HealthStatus {
  latency: number;
  alpacaStream: "CONNECTED" | "DISCONNECTED";
  polygonStream?: "CONNECTED" | "DISCONNECTED";
  memoryUsage: string;
  uptime: string;
  timestamp: string;
}

export interface WinRateReport {
  winRate: number;
  totalCompletedTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  netRealizedPnL: number;
}

export interface WatchlistStock {
  name?: string;
  symbol: string;
  strategy: string;
  currentPosition?: number;
  takeProfitPct?: number;
  stopLossPct?: number;
}

// ---------------------------------------------------------------------------
// Active Trade Logging
// ---------------------------------------------------------------------------

/**
 * Preserves the full Alpaca order object schema and augments it with the
 * engine-specific fields that are only known at order-placement time.
 */
export interface ActiveTradeLog {
  // ── Alpaca order fields (preserved verbatim from the broker response) ──
  id: string;
  client_order_id: string;
  created_at: string;
  updated_at: string;
  submitted_at: string;
  filled_at: string | null;
  expired_at: string | null;
  canceled_at: string | null;
  failed_at: string | null;
  replaced_at: string | null;
  replaced_by: string | null;
  replaces: string | null;
  asset_id: string;
  symbol: string;
  asset_class: string;
  notional: string | null;
  qty: string;
  filled_qty: string;
  filled_avg_price: string | null;
  order_class: string;
  order_type: string;
  type: string;
  side: "buy" | "sell";
  time_in_force: string;
  limit_price: string | null;
  stop_price: string | null;
  status: string;
  extended_hours: boolean;
  legs: unknown[] | null;
  trail_percent: string | null;
  trail_price: string | null;
  hwm: string | null;
  subtag: string | null;
  source: string | null;

  // ── Engine-specific augmentation ──
  /** The strategy identifier that triggered this buy. */
  strategy: string;
  /** Take-profit threshold (%) configured for this trade. */
  takeProfitPct: number;
  /** Stop-loss threshold (%) configured for this trade. */
  stopLossPct: number;
  /** ISO timestamp recorded by the engine at log time. */
  logged_at: string;
}

/**
 * Per-strategy aggregation produced by groupTradesStat.
 */
export interface StrategyTradeStats {
  strategy: string;
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number;
  netRealizedPnL: number;
  avgTakeProfitPct: number;
  avgStopLossPct: number;
}