import { Bar, BarSchema } from "@my-platform/types";

import {
  MASTER_WATCHLIST,
  TRADING_CONFIG,
  syncTrackingCaches,
} from "./config/config.js";
import { logTrade } from "./middleware/logger.js";
import type { StrategyEvaluationOptions } from "./strategies/IStrategy.js";

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
      this.posManager.updatePositionMark(bar.symbol, bar.close);
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
    const timestamp = this.toIsoTimestamp(
      tradeData.Timestamp ?? tradeData.timestamp ?? tradeData.t,
    );

    if (!symbol || !price) return;

    this.updateLiveBar(symbol, price, size, timestamp);
    this.posManager.updatePositionMark(symbol, price);
    this.broadcaster.broadcastBar(symbol, price);
  }

  private async processOrderUpdate(data: any): Promise<void> {
    try {
      const { event, order, price, fillQty } = data;
      if (!order?.symbol) return;

      if (event === "canceled" || event === "rejected" || event === "expired") {
        this.posManager.clearPendingExit(order.symbol);
        this.posManager.clearPendingBuy(order.symbol);
        await this.posManager.syncPositions();
        this.subscribeToSymbols(this.posManager.getPositionSymbols());
        this.broadcaster.broadcastPortfolio(this.posManager.getPositions());
        return;
      }

      if (event !== "fill" && event !== "partial_fill") return;

      let fillPrice = Number(price || 0);
      let quantity = Number(fillQty || 0);
      if ((fillPrice === 0 || quantity === 0) && event === "fill") {
        fillPrice = Number(order.filled_avg_price || 0);
        quantity = Number(order.filled_qty || 0);
      }
      if (fillPrice === 0 || quantity === 0) return;

      console.log(`✅ EXECUTION: ${order.symbol} filled @ $${fillPrice}`);
      if (order.side === "sell") {
        this.posManager.clearPendingExit(order.symbol);
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

      await logTrade({
        symbol: order.symbol,
        side: order.side.toUpperCase(),
        qty: quantity.toString(),
        price: fillPrice.toString(),
        pnl,
        pnl_pct: pnlPct,
        timestamp: new Date().toISOString(),
        reason:
          order.side === "sell"
            ? "Exit"
            : (MASTER_WATCHLIST.get(order.symbol)?.strategy ??
              "UnknownStrategy"),
        win_status: winStatus,
      });

      await this.posManager.syncPositions();
      this.subscribeToSymbols(this.posManager.getPositionSymbols());
      this.broadcaster.broadcastPortfolio(this.posManager.getPositions());
    } catch (error) {
      console.error("❌ Error handling trade order update in pipeline:", error);
    }
  }

  private startSecondLevelEvaluationLoop(): void {
    setInterval(() => {
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
        if (!MASTER_WATCHLIST.has(symbol)) continue;

        if (await this.handleExits(symbol, liveBar.close)) continue;
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

    const { shouldExit, reason } = this.posManager.checkExitConditions(
      symbol,
      currentPrice,
    );
    if (!shouldExit) return false;

    console.log(`🚨 Exit condition met for ${symbol}: ${reason}`);
    this.posManager.markPendingExit(symbol);

    try {
      await this.executor.closePosition(symbol);
      this.broadcaster.broadcastSignal({
        symbol,
        action: "SELL",
        confidence: 1,
        reason,
      });
    } catch (error) {
      console.error(
        `❌ [PIPELINE] closePosition failed for ${symbol}. Releasing lock for retry.`,
        error,
      );
      this.posManager.clearPendingExit(symbol);
    }

    return true;
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
        stopLossPct: 5,
        takeProfitPct: 5,
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

    const signal = await strategy.evaluateStrategy(bar, options);
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
        await this.executor.closePosition(bar.symbol);
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
      if (quantity <= 0) {
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

    const quantity = 1;
    console.log(`🧪 TEST: Forcing a test buy for ${symbol}...`);
    await this.executor.placeBuyOrder(symbol, quantity);
    await this.posManager.syncPositions();
    StreamPipeline.ranTestBuy = true;
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
