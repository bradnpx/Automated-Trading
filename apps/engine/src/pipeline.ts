import { Bar, BarSchema } from "@my-platform/types";

import {
  MASTER_WATCHLIST,
  TRADING_CONFIG,
  syncTrackingCaches,
} from "./config/config.js";
import { logTrade } from "./middleware/logger.js";
import { TradeLifecycleStore } from "./models/tradeLifecycleStore.js";
import type { ProtectionBrokerOrder } from "./executor.js";
import { RemainderProtectionController } from "./remainderProtection.js";
import type { StrategyCriteriaEvaluation, StrategyEvaluationOptions } from "./strategies/IStrategy.js";

type MarketTrade = {
  Symbol?: string;
  symbol?: string;
  Price?: number;
  price?: number;
  p?: number;
  Size?: number;
  size?: number;
  s?: number;
  Timestamp?: string;
  timestamp?: string;
  t?: string;
};

type LiveBar = Bar & {
  bucketTimestamp: string;
};

const SECOND_LEVEL_EVALUATION_INTERVAL_MS = 1_000;

/**
 * Combines completed one-minute bars (the persistent technical-indicator history)
 * with live trade ticks (second-level portfolio marks and evaluation candidates).
 */
export class StreamPipeline {
  private static isGlobalInitialized = false;
  private static ranTestBuy = false;

  private readonly subscribedSymbols = new Set<string>();
  private readonly liveBars = new Map<string, LiveBar>();
  private secondLevelEvaluationInFlight = false;

  constructor(
    private alpaca: any,
    private posManager: any,
    private executor: any,
    private broadcaster: any,
    private scanner: any,
    private strategies: Map<string, any>,
    private engineState: { isKilled: boolean },
    private lifecycleStore?: TradeLifecycleStore,
    private protection?: RemainderProtectionController,
  ) {}

  public initialize(): void {
    if (StreamPipeline.isGlobalInitialized) {
      console.log(
        "⚠️ StreamPipeline.initialize() bypassed: Listeners are already configured.",
      );
      return;
    }

    StreamPipeline.isGlobalInitialized = true;
    const marketStream = this.alpaca.data_stream_v2;
    const tradeStream = this.alpaca.trade_ws;

    marketStream.onConnect(() => {
      this.subscribeToSymbols(this.getTrackedSymbols());
    });

    marketStream.onError((error: unknown) => {
      console.error("❌ [STREAM] WebSocket encountered an error:", error);
    });

    // Completed bars remain the only data appended to strategy indicator history.
    marketStream.onStockBar((barData: unknown) => {
      void this.processCompletedBar(barData);
    });

    // Each market trade updates an in-progress minute candle and the portfolio's
    // latest mark. Strategy execution is throttled separately to one evaluation/sec.
    marketStream.onStockTrade((tradeData: MarketTrade) => {
      this.processMarketTrade(tradeData);
    });

    tradeStream.onConnect(() => {
      console.log("🤝 Trade WebSocket: Connected");
      tradeStream.subscribe(["trade_updates"]);
    });

    tradeStream.onOrderUpdate((data: any) => {
      void this.processOrderUpdate(data);
    });

    marketStream.connect();
    tradeStream.connect();
    this.startSecondLevelEvaluationLoop();
  }

  private async processCompletedBar(barData: unknown): Promise<void> {
    try {
      const bar = this.parseBar(barData);
      this.posManager.updatePositionMark(bar.symbol, bar.close, new Date(bar.timestamp).toISOString());
      this.broadcaster.broadcastBar(bar.symbol, bar.close);

      // Exit conditions always precede entry logic for a completed bar.
      if (await this.handleExits(bar.symbol, bar.close)) return;

      await this.handleScannerAndWarmup(bar);
      await this.handleStrategyEntries(bar, { recordBar: true });

      if (bar.symbol === "F") {
        await this.runTestBuy(bar.symbol);
      }
    } catch (error) {
      console.error("❌ [STREAM] Completed bar processing error:", error);
    }
  }

  private processMarketTrade(tradeData: MarketTrade): void {
    const symbol = tradeData.Symbol ?? tradeData.symbol;
    const price = this.toPositiveNumber(
      tradeData.Price ?? tradeData.price ?? tradeData.p,
    );
    const size = this.toPositiveNumber(
      tradeData.Size ?? tradeData.size ?? tradeData.s,
      0,
    );
    const rawTimestamp = tradeData.Timestamp ?? tradeData.timestamp ?? tradeData.t;
    if (!rawTimestamp || !Number.isFinite(Date.parse(rawTimestamp))) return;
    const timestamp = new Date(rawTimestamp).toISOString();

    if (!symbol || !price) return;
    if (this.protection && !this.protection.onPrice(symbol, price, timestamp)) return;
    const previous = this.liveBars.get(symbol);
    if (previous && Date.parse(timestamp) < new Date(previous.timestamp).getTime()) return;

    this.updateLiveBar(symbol, price, size, timestamp);
    this.posManager.updatePositionMark(symbol, price, timestamp);
    this.broadcaster.broadcastBar(symbol, price);
  }

  private async processOrderUpdate(data: any): Promise<void> {
    try {
      const { event, order, price, fillQty } = data;
      if (!order?.symbol) return;
      if (order.id && this.protection) {
        const observed: ProtectionBrokerOrder = {
          id: String(order.id), symbol: String(order.symbol),
          status: event === "fill" ? "filled" : event === "partial_fill" ? "partially_filled" : String(order.status ?? event),
          client_order_id: order.client_order_id,
          side: order.side, type: order.type ?? order.order_type,
          qty: order.qty, filled_qty: order.filled_qty,
          filled_avg_price: order.filled_avg_price,
          filled_at: order.filled_at, submitted_at: order.submitted_at,
        };
        // Latch completed half-out/failure state before ledger or log I/O.
        this.protection.observeOrder(order.symbol, observed);
      }

      if (event === "canceled" || event === "rejected" || event === "expired") {
        await this.lifecycleStore?.clearExitIntent(order.id);
        this.posManager.clearPendingExit(order.symbol);
        this.posManager.clearPendingBuy(order.symbol);
        if (order.type === "trailing_stop") {
          this.posManager.deactivateTrailingStop(order.symbol);
        } else {
          this.posManager.cancelPendingTrailingStop(order.symbol);
        }
        await this.posManager.syncPositions();
        this.subscribeToSymbols(this.posManager.getPositionSymbols());
        this.broadcaster.broadcastPortfolio(this.posManager.getPositions());
        return;
      }

      if (event !== "fill" && event !== "partial_fill") return;

      let fillPrice = Number(price || 0);
      let quantity = Number(data.qty || fillQty || 0);
      if ((fillPrice === 0 || quantity === 0) && event === "fill") {
        fillPrice = Number(order.filled_avg_price || 0);
        quantity = Number(order.filled_qty || 0);
      }
      if (fillPrice === 0 || quantity === 0) return;

      console.log(`✅ EXECUTION: ${order.symbol} filled @ $${fillPrice}`);
      if (order.side === "sell") {
        this.posManager.clearPendingExit(order.symbol);
        if (order.type === "trailing_stop") {
          this.posManager.deactivateTrailingStop(order.symbol);
        }
      }
      if (order.side === "buy" && event === "fill") {
        this.posManager.clearPendingBuy(order.symbol);
      }

      const position = this.posManager
        .getPositions()
        .find(
          (candidate: { symbol: string }) => candidate.symbol === order.symbol,
        );
      const entry = position ? Number(position.avg_entry_price) : 0;
      const pnl =
        order.side === "sell" && entry > 0 ? (fillPrice - entry) * quantity : 0;
      const pnlPct =
        order.side === "sell" && entry > 0 ? (fillPrice - entry) / entry : 0;
      const winStatus =
        order.side !== "sell"
          ? "OPENING"
          : pnl > 0
            ? "WIN"
            : pnl < 0
              ? "LOSS"
              : "BREAKEVEN";
      const profile =
        order.side === "buy"
          ? this.posManager.captureEntryProfile(order.symbol)
          : this.posManager.getExitProfile(order.symbol);
      const orderType = order.type ?? order.order_type ?? "market";
      const exitReason =
        order.side === "sell"
          ? await this.lifecycleStore?.getExitReason(order.id, orderType)
          : undefined;
      const timestamp =
        data.timestamp ?? order.filled_at ?? new Date().toISOString();
      const executionId =
        data.execution_id ??
        `${order.id}:${event}:${timestamp}:${fillPrice}:${quantity}`;

      let lifecycleId: string | undefined;
      let shouldLogFill = true;
      try {
        const lifecycleResult = await this.lifecycleStore?.recordFill({
          executionId,
          orderId: order.id,
          orderType,
          side: order.side,
          symbol: order.symbol,
          price: Number(order.filled_qty) > 0 && Number(order.filled_avg_price) > 0 ? Number(order.filled_avg_price) : fillPrice,
          quantity,
          ...(Number.isFinite(Number(order.filled_qty)) && Number(order.filled_qty) > 0
            ? { cumulativeQuantity: Number(order.filled_qty), cumulativePrice: Number(order.filled_avg_price) > 0 }
            : {}),
          filledAt: timestamp,
          profile,
          ...(exitReason ? { reason: exitReason } : {}),
        });
        lifecycleId = lifecycleResult?.lifecycle?.id;
        shouldLogFill = lifecycleResult?.recorded ?? true;
      } catch (error) {
        console.error(
          `❌ [LIFECYCLE] Failed to persist ${order.symbol} fill; execution processing will continue:`,
          error,
        );
      }

      if (shouldLogFill) {
        await logTrade({
          symbol: order.symbol,
          side: order.side,
          qty: quantity.toString(),
          price: fillPrice.toString(),
          lifecycle_id: lifecycleId,
          order_id: order.id,
          execution_id: executionId,
          order_type: orderType,
          strategy: profile.strategy,
          take_profit_pct: profile.takeProfitPct,
          stop_loss_pct: profile.stopLossPct,
          trailing_stop_loss: profile.trailingStopLoss,
          pnl,
          pnl_pct: pnlPct,
          timestamp,
          reason:
            order.side === "buy" ? profile.strategy : (exitReason ?? "EXIT"),
          win_status: winStatus,
        });
      }

      if (event === "fill" && order.side === "sell") {
        await this.lifecycleStore?.clearExitIntent(order.id);
      }

      await this.posManager.syncPositions();
      this.subscribeToSymbols(this.posManager.getPositionSymbols());
      this.broadcaster.broadcastPortfolio(this.posManager.getPositions());
    } catch (error) {
      console.error("❌ Error handling trade order update in pipeline:", error);
    }
  }

  private startSecondLevelEvaluationLoop(): void {
    setInterval(() => {
      if (!this.engineState.isKilled) void this.protection?.tick();
      void this.evaluateLiveBars();
    }, SECOND_LEVEL_EVALUATION_INTERVAL_MS);
  }

  /**
   * Evaluates each currently traded symbol at most once per second. The live candle
   * is deliberately non-persistent so one-minute historical indicators preserve
   * their original timeframe and cannot be polluted by synthetic tick bars.
   */
  private async evaluateLiveBars(): Promise<void> {
    if (this.engineState.isKilled || this.secondLevelEvaluationInFlight) return;
    this.secondLevelEvaluationInFlight = true;

    try {
      for (const [symbol, liveBar] of this.liveBars) {
        if (await this.handleExits(symbol, liveBar.close)) continue;
        if (!MASTER_WATCHLIST.has(symbol)) continue;
        await this.handleStrategyEntries(liveBar, { recordBar: false });
      }
    } catch (error) {
      console.error(
        "❌ [STREAM] Second-level strategy evaluation error:",
        error,
      );
    } finally {
      this.secondLevelEvaluationInFlight = false;
    }
  }

  private async handleExits(
    symbol: string,
    currentPrice: number,
  ): Promise<boolean> {
    if (!this.posManager.hasPosition(symbol)) return false;
    if (this.protection?.manages(symbol)) {
      return this.posManager.hasPendingExit(symbol);
    }

    const decision = this.posManager.checkExitConditions(symbol, currentPrice);
    if (!decision.shouldExit) return false;

    console.log(`🚨 Exit condition met for ${symbol}: ${decision.reason}`);
    this.posManager.markPendingExit(symbol);

    try {
      if (decision.action === "take-profit-half") {
        const quantity = decision.quantity ?? 0;
        const entryPrice = decision.entryPrice ?? 0;
        if (!(quantity > 0) || !(entryPrice > 0) || !this.protection) {
          throw new Error(`Invalid half-out values for ${symbol}`);
        }
        await this.protection.startHalfExit(symbol, entryPrice, quantity);
      } else {
        const order = await this.executor.closePosition(symbol);
        await this.recordExitIntent(
          symbol,
          order?.id,
          decision.reason.startsWith("STOP_LOSS") ? "STOP_LOSS" : "TAKE_PROFIT",
        );
      }
      this.broadcaster.broadcastSignal({
        symbol,
        action: "SELL",
        confidence: 1,
        reason: decision.reason,
      });
    } catch (error) {
      console.error(
        `❌ [PIPELINE] closePosition failed for ${symbol}. Releasing lock for retry.`,
        error,
      );
      if (!this.protection?.manages(symbol)) this.posManager.clearPendingExit(symbol);
    }

    return true;
  }

  public async resumePendingTrailingStops(): Promise<void> {
    await this.protection?.initialize();
  }

  private async handleScannerAndWarmup(bar: Bar): Promise<void> {
    if (!this.scanner) return;

    const scan = this.scanner.processBar(bar.symbol, bar.volume, [
      bar.open,
      bar.close,
    ]);
    if (scan.isHot && scan.isTradable && !MASTER_WATCHLIST.has(bar.symbol)) {
      MASTER_WATCHLIST.set(bar.symbol, {
        symbol: bar.symbol,
        strategy: "dayTradeMicroScalp",
        stopLossPct: 1.5,
        takeProfitPct: 2.5,
        totalRisk: 0.01,
      });
      syncTrackingCaches();
    }
  }

  private async handleStrategyEntries(
    bar: Bar,
    options: StrategyEvaluationOptions,
  ): Promise<void> {
    const strategy = this.strategies.get(bar.symbol);
    if (!strategy || this.engineState.isKilled) return;

    const watchlistItem = MASTER_WATCHLIST.get(bar.symbol);
    const signal = await strategy.evaluateStrategy(bar, {
      ...options,
      onCriteriaEvaluated: (evaluation: StrategyCriteriaEvaluation) => {
        options.onCriteriaEvaluated?.(evaluation);
        this.broadcaster.broadcastStrategyEvaluation({
          symbol: bar.symbol,
          strategy: watchlistItem?.strategy ?? strategy.constructor.name,
          criteria: evaluation.criteria.map((criterion) => ({
            criterion,
            passed: evaluation.report[criterion] === true,
          })),
          timestamp: new Date().toISOString(),
        });
      },
    });
    if (!signal || typeof signal.action === "undefined") {
      console.error(
        `❌ Strategy Error: ${strategy.constructor.name} for ${bar.symbol} returned an invalid signal!`,
        { signal },
      );
      return;
    }

    if (
      signal.action === "SELL" &&
      this.posManager.hasPosition(bar.symbol) &&
      !this.posManager.hasPendingExit(bar.symbol)
    ) {
      this.posManager.markPendingExit(bar.symbol);
      try {
        if (this.protection?.manages(bar.symbol)) {
          await this.protection.requestExit(bar.symbol, "STRATEGY_SELL");
        } else {
          const order = await this.executor.closePosition(bar.symbol);
          await this.recordExitIntent(bar.symbol, order?.id, "STRATEGY_SELL");
        }
        this.broadcaster.broadcastSignal(signal);
      } catch (error) {
        console.error(
          `❌ Strategy exit execution error for ${bar.symbol}:`,
          error,
        );
        this.posManager.clearPendingExit(bar.symbol);
      }
      return;
    }

    if (
      signal.action !== "BUY" ||
      (this.protection && !this.protection.isReady()) ||
      !this.posManager.canOpenPosition(bar.symbol)
    ) {
      return;
    }

    this.posManager.markPendingBuy(bar.symbol);
    try {
      const risk =
        MASTER_WATCHLIST.get(bar.symbol)?.totalRisk ??
        TRADING_CONFIG.RISK_PER_TRADE;
      const equity = await this.posManager.getOrFetchEquity();
      const quantity = (equity * risk) / bar.close;
      if (quantity <= 0 || this.engineState.isKilled || (this.protection && !this.protection.isReady())) {
        this.posManager.clearPendingBuy(bar.symbol);
        return;
      }

      this.broadcaster.broadcastSignal(signal);
      const order = await this.executor.placeBuyOrder(bar.symbol, quantity);
      if (!order) {
        this.posManager.clearPendingBuy(bar.symbol);
        return;
      }

      await this.posManager.syncPositions();
    } catch (error) {
      console.error(`❌ Execution error for ${bar.symbol}:`, error);
      this.posManager.clearPendingBuy(bar.symbol);
    }
  }

  private async runTestBuy(symbol: string): Promise<void> {
    if (StreamPipeline.ranTestBuy) return;
    if (this.engineState.isKilled || (this.protection && !this.protection.isReady())) return;

    const quantity = 1;
    console.log(`🧪 TEST: Forcing a test buy for ${symbol}...`);
    await this.executor.placeBuyOrder(symbol, quantity);
    await this.posManager.syncPositions();
    StreamPipeline.ranTestBuy = true;
  }

  private async recordExitIntent(
    symbol: string,
    orderId: string | undefined,
    reason:
      | "TAKE_PROFIT"
      | "TAKE_PROFIT_HALF"
      | "STOP_LOSS"
      | "STRATEGY_SELL"
      | "TRAILING_STOP_SETUP_FAILED",
  ): Promise<void> {
    if (!orderId) return;

    await this.lifecycleStore?.recordExitIntent(symbol, {
      orderId,
      reason,
      submittedAt: new Date().toISOString(),
    });
  }

  public subscribeToNewSymbols(symbols: string[]): void {
    this.subscribeToSymbols(symbols);
  }

  private subscribeToSymbols(symbols: string[]): void {
    const newSymbols = symbols.filter(
      (symbol) => symbol && !this.subscribedSymbols.has(symbol),
    );
    if (newSymbols.length === 0) return;

    console.log(
      `📡 [STREAM] Subscribing to minute bars and trades for ${newSymbols.join(", ")}`,
    );
    this.alpaca.data_stream_v2.subscribeForBars(newSymbols);
    this.alpaca.data_stream_v2.subscribeForTrades(newSymbols);
    newSymbols.forEach((symbol) => this.subscribedSymbols.add(symbol));
  }

  private getTrackedSymbols(): string[] {
    return Array.from(
      new Set([
        ...MASTER_WATCHLIST.keys(),
        ...this.posManager.getPositionSymbols(),
      ]),
    );
  }

  private updateLiveBar(
    symbol: string,
    price: number,
    size: number,
    timestamp: string,
  ): void {
    const bucketTimestamp = this.getMinuteBucket(timestamp);
    const existing = this.liveBars.get(symbol);

    if (!existing || existing.bucketTimestamp !== bucketTimestamp) {
      this.liveBars.set(symbol, {
        symbol,
        timestamp,
        bucketTimestamp,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: size,
      });
      return;
    }

    this.liveBars.set(symbol, {
      ...existing,
      timestamp,
      high: Math.max(existing.high, price),
      low: Math.min(existing.low, price),
      close: price,
      volume: existing.volume + size,
    });
  }

  private parseBar(barData: unknown): Bar {
    const data = barData as Record<string, unknown>;
    return BarSchema.parse({
      symbol: data.Symbol ?? data.symbol,
      timestamp: data.Timestamp ?? data.timestamp,
      open: data.OpenPrice ?? data.Open ?? data.open ?? data.o ?? 0,
      high: data.HighPrice ?? data.High ?? data.high ?? data.h ?? 0,
      low: data.LowPrice ?? data.Low ?? data.low ?? data.l ?? 0,
      close: data.ClosePrice ?? data.Close ?? data.close ?? data.c ?? 0,
      volume: data.Volume ?? data.volume ?? data.v ?? 0,
      vwap: data.VWAP ?? data.vwap ?? data.vw,
    });
  }

  private toPositiveNumber(value: unknown, fallback?: number): number {
    const numeric = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : (fallback ?? 0);
  }

  private toIsoTimestamp(value: unknown): string {
    const date = value ? new Date(String(value)) : new Date();
    return Number.isNaN(date.getTime())
      ? new Date().toISOString()
      : date.toISOString();
  }

  private getMinuteBucket(timestamp: string): string {
    const date = new Date(timestamp);
    date.setUTCSeconds(0, 0);
    return date.toISOString();
  }
}
