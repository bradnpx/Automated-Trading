import { Bar, TradeSignal } from "@my-platform/types";
import {
  StrategyIdentifier,
} from "../../engine/src/strategies/StrategyFactory.js";
import {
  StrategyParameterOverrides,
} from "../../engine/src/strategies/strategyConfig.js";
import { StrategyCriterion } from "@/apps/engine/src/strategies/evaluateStrategy.js";

export type IntrabarFillPriority = "stop-first" | "target-first";
export type PositionSizingMethod = "risk-to-stop" | "equity-fraction";
export type ExitReason =
  | "strategy-sell"
  | "stop-loss"
  | "take-profit"
  | "end-of-data";

export interface BacktestConfig {
  strategyId: StrategyIdentifier;
  strategyParameters?: StrategyParameterOverrides;
  initialCash: number;
  riskPerTrade: number;
  positionSizingMethod: PositionSizingMethod;
  maxPositionPct: number;
  stopLossPct: number | null;
  takeProfitPct: number | null;
  slippageBps: number;
  commissionPerOrder: number;
  intrabarFillPriority: IntrabarFillPriority;
  closeOpenPositionsAtEnd: boolean;
}

export interface ResolvedBacktestConfig
  extends Omit<BacktestConfig, "strategyParameters"> {
  strategyParameters: StrategyParameterOverrides;
}

export interface BacktestOrder {
  orderId: string;
  symbol: string;
  side: "buy" | "sell";
  reason: string;
  submittedAt: string;
  status: "filled" | "rejected";
  quantity?: number;
  fillPrice?: number;
  rejectionReason?: string;
}

export interface OpenPosition {
  symbol: string;
  quantity: number;
  entryPrice: number;
  entryTimestamp: string;
  entryCommission: number;
  stopPrice: number | null;
  targetPrice: number | null;
  strategyId: StrategyIdentifier;
  entrySignal: TradeSignal;
}

export interface SimulatedTrade {
  tradeId: string;
  symbol: string;
  strategyId: StrategyIdentifier;
  entryTimestamp: string;
  exitTimestamp: string;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  grossPnl: number;
  netPnl: number;
  returnPct: number;
  entryCommission: number;
  exitCommission: number;
  exitReason: ExitReason;
  entrySignalReason: string;
}

export interface EquityPoint {
  timestamp: string;
  equity: number;
  cash: number;
  openPositionCount: number;
}

export interface BacktestMetrics {
  closedTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRatePct: number;
  totalNetPnl: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  averageWin: number;
  averageLoss: number;
  expectancy: number;
  maxDrawdownPct: number;
  turnover: number;
  exposurePct: number;
}

export interface BacktestResult {
  config: ResolvedBacktestConfig;
  criteria: StrategyCriterion[] | string;
  firstTimestamp: string;
  lastTimestamp: string;
  initialCash: number;
  endingEquity: number;
  trades: SimulatedTrade[];
  orders: BacktestOrder[];
  rejectedSignals: TradeSignal[];
  equityCurve: EquityPoint[];
  metrics: BacktestMetrics;
}

export interface HistoricalDataSet {
  bars: Bar[];
  source: string;
}
