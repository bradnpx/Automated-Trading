// types/dashboard.ts
// Shared TypeScript interfaces for the dashboard UI.
// These mirror the shapes emitted by the engine's Socket.IO events.
// Import from "@/types/dashboard" throughout the app.

export interface Position {
  symbol: string;
  qty: string;
  side: "long" | "short";
  avg_entry_price: string;
  current_price: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  market_value: string;
}

export interface AccountState {
  equity: number;
  buying_power: number;
  cash: number;
  day_pl: number;
  day_pl_pct: number;
}

export interface TradeSignal {
  symbol: string;
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  reason: string;
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

export type EngineStatus = "ACTIVE" | "KILLED";
