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
  STRATEGY_EVALUATION: "strategy_evaluation",
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

export interface CriterionStatus {
  criterion: string;
  passed: boolean;
}

export interface StrategyEvaluationPayload {
  symbol: string;
  strategy: string;
  criteria: CriterionStatus[];
  timestamp: string;
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
  lifecycle_id?: string;
  order_id?: string;
  execution_id?: string;
  order_type?: string;
  strategy?: string;
  take_profit_pct?: number;
  stop_loss_pct?: number;
  trailing_stop_loss?: boolean;
  pnl?: number;
  pnl_pct?: number;
  timestamp: string;
  reason: string;
  win_status: "WIN" | "LOSS" | "BREAKEVEN" | "OPENING";
}

export type TradeLifecycleStatus = "open" | "partially_closed" | "closed";

export type TradeExitReason =
  | "TAKE_PROFIT"
  | "TAKE_PROFIT_HALF"
  | "TRAILING_STOP_LOSS"
  | "STOP_LOSS"
  | "STRATEGY_SELL"
  | "MANUAL_CLOSE"
  | "TRAILING_STOP_SETUP_FAILED"
  | "EXIT";

export interface TradeLifecycleFill {
  executionId: string;
  orderId: string;
  orderType: string;
  side: "buy" | "sell";
  price: number;
  quantity: number;
  filledAt: string;
  reason?: TradeExitReason;
}

export interface TradeLifecycleProfile {
  strategy: string;
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopLoss: boolean;
}

export interface TradeLifecycleExitIntent {
  orderId: string;
  reason: TradeExitReason;
  submittedAt: string;
}

export interface TradeLifecycle {
  id: string;
  symbol: string;
  status: TradeLifecycleStatus;
  openedAt: string;
  updatedAt: string;
  closedAt?: string;
  profile: TradeLifecycleProfile;
  entryFills: TradeLifecycleFill[];
  exitFills: TradeLifecycleFill[];
  entryQuantity: number;
  exitedQuantity: number;
  remainingQuantity: number;
  averageEntryPrice: number;
  averageExitPrice?: number;
  realizedPnl: number;
  realizedPnlPct: number;
  pendingExit?: TradeLifecycleExitIntent;
  trailingStopOrderId?: string;
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
