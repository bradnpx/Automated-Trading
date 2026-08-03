// modules/trades/trades.types.ts
// Strict TypeScript interfaces for the trades domain.
// All API route handlers and services must use these types — never `any`.

import { TradeRecord } from "@my-platform/types";

export interface OpenPosition {
  symbol: string;
  qty: string;
  side: "long" | "short";
  avg_entry_price: string;
  current_price: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  market_value: string;
}

export interface ClosePositionRequest {
  symbol: string;
}

export interface ClosePositionResponse {
  message: string;
}

export interface PanicResponse {
  message: string;
}

export interface ResetResponse {
  message: string;
}

export interface TradeHistoryResponse {
  trades: TradeRecord[];
}

export interface ApiErrorResponse {
  error: string;
}

export interface EngineState {
  isKilled: boolean;
}
