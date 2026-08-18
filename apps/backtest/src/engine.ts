import { Bar, TradeSignal } from "@my-platform/types";

import {
  StrategyFactory,
} from "../../engine/src/strategies/StrategyFactory.js";
import getTradingSession, {
  getEasternTimeParts,
} from "../../engine/src/functions/getTradingSession.js";
import { resolveBacktestConfig } from "./config.js";
import {
  BacktestConfig,
  BacktestOrder,
  BacktestResult,
  EquityPoint,
  ExitReason,
  OpenPosition,
  ResolvedBacktestConfig,
  SimulatedTrade,
} from "./types.js";
import { calculateMetrics } from "./metrics.js";

export interface BacktestProgress {
  completedBars: number;
  totalBars: number;
  percentComplete: number;
}

export interface BacktestRunOptions {
  onProgress?: (progress: BacktestProgress) => void;
}

interface RunningState {
  cash: number;
  positions: Map<string, OpenPosition>;
  latestPriceBySymbol: Map<string, number>;
  orders: BacktestOrder[];
  trades: SimulatedTrade[];
  rejectedSignals: TradeSignal[];
  equityCurve: EquityPoint[];
  orderSequence: number;
  tradeSequence: number;
  exposedBars: number;
  processedBars: number;
  turnoverNotional: number;
}

export class BacktestEngine {
  public async run(
    bars: Bar[],
    config: BacktestConfig,
    options: BacktestRunOptions = {},
  ): Promise<BacktestResult> {
    if (bars.length === 0) {
      throw new Error("Cannot run a backtest without historical bars");
    }

    const resolvedConfig = resolveBacktestConfig(config);
    const sortedBars = [...bars].sort(
      (left, right) => toMilliseconds(left.timestamp) - toMilliseconds(right.timestamp),
    );
    const strategyBySymbol = new Map<string, ReturnType<typeof StrategyFactory.create>>();
    const priorDayLowBySymbol = buildPriorDayLowIndex(sortedBars);
    const state: RunningState = {
      cash: resolvedConfig.initialCash,
      positions: new Map<string, OpenPosition>(),
      latestPriceBySymbol: new Map<string, number>(),
      orders: [],
      trades: [],
      rejectedSignals: [],
      equityCurve: [],
      orderSequence: 0,
      tradeSequence: 0,
      exposedBars: 0,
      processedBars: 0,
      turnoverNotional: 0,
    };

    const progressInterval = Math.max(1, Math.ceil(sortedBars.length / 100));

    for (const [barIndex, bar] of sortedBars.entries()) {
      this.validateChronologicalBar(bar, state.latestPriceBySymbol);
      state.latestPriceBySymbol.set(bar.symbol, bar.close);
      state.processedBars += 1;

      const bracketExit = this.getBracketExit(bar, state.positions.get(bar.symbol), resolvedConfig);
      if (bracketExit) {
        this.closePosition(
          bar,
          bracketExit.price,
          bracketExit.reason,
          state,
          resolvedConfig,
        );
      }

      const strategy = this.getStrategy(
        bar.symbol,
        strategyBySymbol,
        priorDayLowBySymbol,
        sortedBars,
        resolvedConfig,
      );
      const signal = await strategy.evaluateStrategy(bar);

      if (signal.action === "SELL") {
        if (state.positions.has(bar.symbol)) {
          this.closePosition(
            bar,
            bar.close,
            "strategy-sell",
            state,
            resolvedConfig,
            signal.reason,
          );
        } else {
          this.rejectSignal(
            signal,
            "No open position to close",
            bar.timestamp,
            state,
          );
        }
      } else if (signal.action === "BUY") {
        if (state.positions.has(bar.symbol)) {
          this.rejectSignal(
            signal,
            "Position already open",
            bar.timestamp,
            state,
          );
        } else {
          this.openPosition(bar, signal, state, resolvedConfig);
        }
      }

      if (state.positions.size > 0) {
        state.exposedBars += 1;
      }
      state.equityCurve.push(this.captureEquityPoint(bar, state));
      this.reportProgress(barIndex, sortedBars.length, progressInterval, options);
    }

    if (resolvedConfig.closeOpenPositionsAtEnd) {
      const finalBarBySymbol = new Map<string, Bar>();
      for (const bar of sortedBars) {
        finalBarBySymbol.set(bar.symbol, bar);
      }

      for (const [symbol] of state.positions) {
        const finalBar = finalBarBySymbol.get(symbol);
        if (!finalBar) {
          throw new Error(`Missing final bar for open position ${symbol}`);
        }
        this.closePosition(
          finalBar,
          finalBar.close,
          "end-of-data",
          state,
          resolvedConfig,
        );
      }
    }

    const finalBar = sortedBars[sortedBars.length - 1];
    state.equityCurve[state.equityCurve.length - 1] = this.captureEquityPoint(
      finalBar,
      state,
    );
    const endingEquity = this.calculateEquity(state);
    const metrics = calculateMetrics({
      trades: state.trades,
      equityCurve: state.equityCurve,
      initialCash: resolvedConfig.initialCash,
      turnoverNotional: state.turnoverNotional,
      exposedBars: state.exposedBars,
      processedBars: state.processedBars,
    });

    return {
      config: resolvedConfig,
      firstTimestamp: toIsoString(sortedBars[0].timestamp),
      lastTimestamp: toIsoString(finalBar.timestamp),
      initialCash: resolvedConfig.initialCash,
      endingEquity,
      trades: state.trades,
      orders: state.orders,
      rejectedSignals: state.rejectedSignals,
      equityCurve: state.equityCurve,
      metrics,
    };
  }

  private reportProgress(
    barIndex: number,
    totalBars: number,
    progressInterval: number,
    options: BacktestRunOptions,
  ): void {
    const completedBars = barIndex + 1;
    const isFinalBar = completedBars === totalBars;
    if (
      !options.onProgress ||
      (!isFinalBar && completedBars % progressInterval !== 0)
    ) {
      return;
    }

    options.onProgress({
      completedBars,
      totalBars,
      percentComplete: (completedBars / totalBars) * 100,
    });
  }

  private getStrategy(
    symbol: string,
    strategyBySymbol: Map<string, ReturnType<typeof StrategyFactory.create>>,
    priorDayLowBySymbol: Map<string, Map<string, number>>,
    bars: Bar[],
    config: ResolvedBacktestConfig,
  ): ReturnType<typeof StrategyFactory.create> {
    const existing = strategyBySymbol.get(symbol);
    if (existing) {
      return existing;
    }

    const strategy = StrategyFactory.create(
      config.strategyId,
      config.strategyParameters,
    );
    const firstBarIndex = bars.findIndex((bar) => bar.symbol === symbol);
    const historicalBars = bars.slice(0, Math.max(firstBarIndex, 0)).filter(
      (bar) => bar.symbol === symbol,
    );
    const firstBar = bars[firstBarIndex];
    const priorDayLow = firstBar
      ? priorDayLowBySymbol.get(symbol)?.get(getEasternTimeParts(firstBar.timestamp).dateKey)
      : undefined;

    strategy.hydrate(historicalBars, priorDayLow);
    strategyBySymbol.set(symbol, strategy);
    return strategy;
  }

  private validateChronologicalBar(
    bar: Bar,
    latestPriceBySymbol: Map<string, number>,
  ): void {
    if (latestPriceBySymbol.has(bar.symbol) && !(bar.volume >= 0)) {
      throw new Error(`Invalid negative volume for ${bar.symbol}`);
    }
  }

  private getBracketExit(
    bar: Bar,
    position: OpenPosition | undefined,
    config: ResolvedBacktestConfig,
  ): { price: number; reason: ExitReason } | null {
    if (!position) {
      return null;
    }

    const hitStop =
      position.stopPrice !== null && bar.low <= position.stopPrice;
    const hitTarget =
      position.targetPrice !== null && bar.high >= position.targetPrice;

    if (
      hitStop &&
      hitTarget &&
      position.stopPrice !== null &&
      position.targetPrice !== null
    ) {
      return config.intrabarFillPriority === "stop-first"
        ? { price: position.stopPrice, reason: "stop-loss" }
        : { price: position.targetPrice, reason: "take-profit" };
    }

    if (hitStop && position.stopPrice !== null) {
      return { price: position.stopPrice, reason: "stop-loss" };
    }

    if (hitTarget && position.targetPrice !== null) {
      return { price: position.targetPrice, reason: "take-profit" };
    }

    return null;
  }

  private openPosition(
    bar: Bar,
    signal: TradeSignal,
    state: RunningState,
    config: ResolvedBacktestConfig,
  ): void {
    const fillPrice = applySlippage(bar.close, "buy", config.slippageBps);
    const equity = this.calculateEquity(state);
    const quantity = calculateQuantity(fillPrice, equity, state.cash, config);

    if (!(quantity > 0)) {
      this.rejectSignal(
        signal,
        "Insufficient cash or invalid position size",
        bar.timestamp,
        state,
      );
      return;
    }

    const notional = quantity * fillPrice;
    const totalCost = notional + config.commissionPerOrder;
    if (totalCost > state.cash) {
      this.rejectSignal(
        signal,
        "Insufficient cash after commission",
        bar.timestamp,
        state,
      );
      return;
    }

    state.cash -= totalCost;
    state.turnoverNotional += notional;
    state.positions.set(bar.symbol, {
      symbol: bar.symbol,
      quantity,
      entryPrice: fillPrice,
      entryTimestamp: toIsoString(bar.timestamp),
      entryCommission: config.commissionPerOrder,
      stopPrice:
        config.stopLossPct === null
          ? null
          : fillPrice * (1 - config.stopLossPct),
      targetPrice:
        config.takeProfitPct === null
          ? null
          : fillPrice * (1 + config.takeProfitPct),
      strategyId: config.strategyId,
      entrySignal: signal,
    });
    state.orders.push({
      orderId: this.nextOrderId(state),
      symbol: bar.symbol,
      side: "buy",
      reason: signal.reason,
      submittedAt: toIsoString(bar.timestamp),
      status: "filled",
      quantity,
      fillPrice,
    });
  }

  private closePosition(
    bar: Bar,
    unadjustedExitPrice: number,
    exitReason: ExitReason,
    state: RunningState,
    config: ResolvedBacktestConfig,
    strategyReason?: string,
  ): void {
    const position = state.positions.get(bar.symbol);
    if (!position) {
      return;
    }

    const exitPrice = applySlippage(
      unadjustedExitPrice,
      "sell",
      config.slippageBps,
    );
    const proceeds = position.quantity * exitPrice;
    const grossPnl = (exitPrice - position.entryPrice) * position.quantity;
    const netPnl = grossPnl - position.entryCommission - config.commissionPerOrder;

    state.cash += proceeds - config.commissionPerOrder;
    state.turnoverNotional += proceeds;
    state.positions.delete(bar.symbol);
    state.orders.push({
      orderId: this.nextOrderId(state),
      symbol: bar.symbol,
      side: "sell",
      reason: strategyReason ?? exitReason,
      submittedAt: toIsoString(bar.timestamp),
      status: "filled",
      quantity: position.quantity,
      fillPrice: exitPrice,
    });
    state.trades.push({
      tradeId: this.nextTradeId(state),
      symbol: position.symbol,
      strategyId: position.strategyId,
      entryTimestamp: position.entryTimestamp,
      exitTimestamp: toIsoString(bar.timestamp),
      quantity: position.quantity,
      entryPrice: position.entryPrice,
      exitPrice,
      grossPnl,
      netPnl,
      returnPct: netPnl / (position.entryPrice * position.quantity),
      entryCommission: position.entryCommission,
      exitCommission: config.commissionPerOrder,
      exitReason,
      entrySignalReason: position.entrySignal.reason,
    });
  }

  private rejectSignal(
    signal: TradeSignal,
    reason: string,
    timestamp: Date | string,
    state: RunningState,
  ): void {
    state.rejectedSignals.push(signal);
    state.orders.push({
      orderId: this.nextOrderId(state),
      symbol: signal.symbol,
      side: signal.action === "SELL" ? "sell" : "buy",
      reason: signal.reason,
      submittedAt: toIsoString(timestamp),
      status: "rejected",
      rejectionReason: reason,
    });
  }

  private captureEquityPoint(bar: Bar, state: RunningState): EquityPoint {
    return {
      timestamp: toIsoString(bar.timestamp),
      equity: this.calculateEquity(state),
      cash: state.cash,
      openPositionCount: state.positions.size,
    };
  }

  private calculateEquity(state: RunningState): number {
    let equity = state.cash;
    for (const position of state.positions.values()) {
      const latestPrice = state.latestPriceBySymbol.get(position.symbol);
      if (latestPrice !== undefined) {
        equity += position.quantity * latestPrice;
      }
    }
    return equity;
  }

  private nextOrderId(state: RunningState): string {
    state.orderSequence += 1;
    return `order-${state.orderSequence}`;
  }

  private nextTradeId(state: RunningState): string {
    state.tradeSequence += 1;
    return `trade-${state.tradeSequence}`;
  }
}

function calculateQuantity(
  entryPrice: number,
  equity: number,
  availableCash: number,
  config: ResolvedBacktestConfig,
): number {
  const maxNotional = Math.min(equity * config.maxPositionPct, availableCash - config.commissionPerOrder);
  if (!(maxNotional > 0)) {
    return 0;
  }

  const quantityByCap = maxNotional / entryPrice;
  const quantity =
    config.positionSizingMethod === "equity-fraction"
      ? (equity * config.riskPerTrade) / entryPrice
      : (equity * config.riskPerTrade) /
        (entryPrice * requiredStopLossPct(config.stopLossPct));

  return Math.max(0, Math.min(quantity, quantityByCap));
}

function requiredStopLossPct(stopLossPct: number | null): number {
  if (stopLossPct === null) {
    throw new Error("risk-to-stop sizing requires a stopLossPct");
  }

  return stopLossPct;
}

function buildPriorDayLowIndex(bars: Bar[]): Map<string, Map<string, number>> {
  const lowBySymbolAndDate = new Map<string, Map<string, number>>();

  for (const bar of bars) {
    if (getTradingSession(bar.timestamp) !== "market") {
      continue;
    }

    const dateKey = getEasternTimeParts(bar.timestamp).dateKey;
    const symbolLows = lowBySymbolAndDate.get(bar.symbol) ?? new Map<string, number>();
    const existingLow = symbolLows.get(dateKey);
    symbolLows.set(dateKey, existingLow === undefined ? bar.low : Math.min(existingLow, bar.low));
    lowBySymbolAndDate.set(bar.symbol, symbolLows);
  }

  const priorDayLowBySymbol = new Map<string, Map<string, number>>();
  for (const [symbol, lowByDate] of lowBySymbolAndDate) {
    const dates = [...lowByDate.keys()].sort();
    const priorLowByDate = new Map<string, number>();

    for (let index = 1; index < dates.length; index += 1) {
      const priorDate = dates[index - 1];
      const date = dates[index];
      const priorLow = lowByDate.get(priorDate);
      if (priorLow !== undefined) {
        priorLowByDate.set(date, priorLow);
      }
    }
    priorDayLowBySymbol.set(symbol, priorLowByDate);
  }

  return priorDayLowBySymbol;
}

function applySlippage(
  price: number,
  side: "buy" | "sell",
  slippageBps: number,
): number {
  const multiplier = slippageBps / 10_000;
  return side === "buy" ? price * (1 + multiplier) : price * (1 - multiplier);
}

function toMilliseconds(timestamp: Date | string): number {
  const milliseconds = timestamp instanceof Date
    ? timestamp.getTime()
    : new Date(timestamp).getTime();

  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid timestamp: ${String(timestamp)}`);
  }

  return milliseconds;
}

function toIsoString(timestamp: Date | string): string {
  return timestamp instanceof Date
    ? timestamp.toISOString()
    : new Date(timestamp).toISOString();
}
