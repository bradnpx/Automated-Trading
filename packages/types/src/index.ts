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
  PREMARKET_MODE: "premarket_mode",
  PREMARKET_ORDER_PROPOSAL: "premarket_order_proposal",
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

export type PremarketMode = "evaluation_only" | "manual_review";

export interface PremarketModePayload {
  mode: PremarketMode;
  updatedAt: string;
}

/**
 * A non-submitting order proposal for user review. This payload is not an
 * Alpaca order request and must never be treated as evidence of an order.
 */
export interface PremarketOrderProposal {
  symbol: string;
  strategy: string;
  reason: string;
  referencePrice: number;
  limitPrice: number;
  quantity: number;
  riskPct: number;
  timeInForce: "day";
  extendedHours: true;
  generatedAt: string;
}

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
