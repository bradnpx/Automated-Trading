import { z } from "zod";

export const SOCKET_EVENTS = {
  BAR: "market_bar",
  SIGNAL: "trade_signal",
  UPDATE: "trade_update",
  ERROR: "engine_error",
  STATUS: "engine_status",
  ACCOUNT: 'account_update'
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