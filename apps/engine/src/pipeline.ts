// src/pipeline.ts
import { BarSchema, Bar } from "@my-platform/types";
import {
  MASTER_WATCHLIST,
  STRATEGY_RISK_MAP,
  TRADING_CONFIG,
  syncTrackingCaches,
} from "./config/config.js";
import { logTrade } from "./middleware/logger.js";
import { getPreviousDayLow } from "./utils/market.js";
import {
  StrategyFactory,
  StrategyIdentifier,
} from "./strategies/StrategyFactory.js";
import { resolve } from "path";

export class StreamPipeline {
  private static isGlobalInitialized = false;
  private static ranTestBuy = false;

  constructor(
    private alpaca: any,
    private posManager: any,
    private executor: any,
    private broadcaster: any,
    private scanner: any,
    private strategies: Map<string, any>,
    private engineState: { isKilled: boolean },
  ) {}

  public initialize() {
    // Idempotent guard protects shared alpaca instances from stacking events
    if (StreamPipeline.isGlobalInitialized) {
      console.log(
        "⚠️ StreamPipeline.initialize() bypassed: Listeners are already configured.",
      );
      return;
    }

    StreamPipeline.isGlobalInitialized = true;

    const marketStream = this.alpaca.data_stream_v2;
    const tradeStream = this.alpaca.trade_ws;

    // --- MARKET DATA STREAM SUBSCRIPTIONS ---
    marketStream.onConnect(() => {
      const activeSymbols = Array.from(MASTER_WATCHLIST.keys());
      if (activeSymbols.length > 0) {
        console.log(
          `📡 [STREAM] WebSocket link open. Registering subscriptions for ${activeSymbols.join(", ")}`,
        );
        marketStream.subscribeForBars(activeSymbols);
      }
    });

    marketStream.onError((err: any) => {
      console.error("❌ [STREAM] WebSocket encountered an error:", err);
    });

    marketStream.onStockBar(async (barData: any) => {
      try {
        const bar = this.parseBar(barData);

        // Process exits instantly before evaluating new setups
        if (await this.handleExits(bar)) return;

        // Broadcast real-time bar telemetry to frontend UI dashboard
        this.broadcaster.broadcastBar(bar.symbol, bar.close);

        // Scanner parsing & dynamic strategy lookups via Factory Engine
        await this.handleScannerAndWarmup(bar);

        // Process active target strategy evaluation filters
        await this.handleStrategyEntries(bar);

        // Optional Sandbox Test Orders
        if (bar.symbol === "F") {
          await this.runTestBuy(bar.symbol);
        }
      } catch (err) {
        console.error("❌ Stream Engine Processing Error:", err);
      }
    });

    /**
     * Connect Trade Stream
     */
    tradeStream.onConnect(() => {
      console.log("🤝 Trade WebSocket: Connected");
      tradeStream.subscribe(["trade_updates"]);
    });

    /**
     * Placing Orders
     */
    tradeStream.onOrderUpdate(async (data: any) => {
      try {
        const { event, order, price, fillQty } = data;

        // Clear the pending exit lock as soon as the broker confirms the order
        // is no longer active — whether it filled, was canceled, rejected, or expired.
        if (
          event === "canceled" ||
          event === "rejected" ||
          event === "expired"
        ) {
          console.warn(
            `🔓 Order [${event}] for ${order.symbol}. Releasing pending exit lock.`,
          );
          this.posManager.clearPendingExit(order.symbol);
          await this.posManager.syncPositions();
          this.broadcaster.broadcastPortfolio(this.posManager.getPositions());
          return;
        }

        if (event === "fill" || event === "partial_fill") {
          let fillPrice = parseFloat(price || 0);
          let qty = parseFloat(fillQty || 0);

          // Fallback: use cumulative fields only on the final fill event
          if (fillPrice === 0 || qty === 0) {
            if (event === "fill") {
              fillPrice = parseFloat(order.filled_avg_price || 0);
              qty = parseFloat(order.filled_qty || 0);
            } else {
              // Drop partial_fills with zeroed root data
              return;
            }
          }

          // Guard against ghost streaming updates
          if (fillPrice === 0 || qty === 0) return;

          console.log(`✅ EXECUTION: ${order.symbol} filled @ $${fillPrice}`);

          // On a confirmed sell fill, the position is closed — clear the lock immediately.
          if (order.side === "sell") {
            this.posManager.clearPendingExit(order.symbol);
          }

          // Compute PnL relative to entry tracking state
          const pos = this.posManager
            .getPositions()
            .find((p: any) => p.symbol === order.symbol);
          const entry = pos ? parseFloat(pos.avg_entry_price) : 0;

          let pnl = 0;
          let pnlPct = 0;
          let winStatus: "WIN" | "LOSS" | "BREAKEVEN" | "OPENING" = "OPENING";

          if (order.side === "sell" && entry > 0) {
            pnl = (fillPrice - entry) * qty;
            pnlPct = (fillPrice - entry) / entry;

            if (pnl > 0) winStatus = "WIN";
            else if (pnl < 0) winStatus = "LOSS";
            else winStatus = "BREAKEVEN";
          }

          await logTrade({
            symbol: order.symbol,
            side: order.side.toUpperCase(),
            qty: qty.toString(),
            price: fillPrice.toString(),
            pnl: pnl,
            pnl_pct: pnlPct,
            timestamp: new Date().toISOString(),
            reason:
              order.side === "sell"
                ? "Exit"
                : MASTER_WATCHLIST.get(order.symbol)?.strategy ||
                  "UnknownStrategy",
            win_status: winStatus,
          });

          await this.posManager.syncPositions();
          this.broadcaster.broadcastPortfolio(this.posManager.getPositions());
        }
      } catch (err) {
        console.error("❌ Error handling trade order update in pipeline:", err);
      }
    });

    marketStream.connect();
    tradeStream.connect();
  }

  private parseBar(barData: any) {
    return BarSchema.parse({
      symbol: barData.Symbol ?? barData.symbol,
      timestamp: barData.Timestamp ?? barData.timestamp,
      open: barData.OpenPrice ?? barData.Open ?? barData.open ?? barData.o ?? 0,
      high: barData.HighPrice ?? barData.High ?? barData.high ?? barData.h ?? 0,
      low: barData.LowPrice ?? barData.Low ?? barData.low ?? barData.l ?? 0,
      close:
        barData.ClosePrice ?? barData.Close ?? barData.close ?? barData.c ?? 0,
      volume: barData.Volume ?? barData.volume ?? barData.v ?? 0,
    });
  }

  /**
   * Checks whether the incoming bar's symbol has an open position that has
   * breached its exit thresholds, and if so, fires a close order.
   *
   * Lock lifecycle:
   *   markPendingExit()  — set before the close call so no other path can
   *                        race in and fire a duplicate order.
   *   clearPendingExit() — cleared immediately if the call throws, OR by
   *                        onOrderUpdate when the broker confirms the fill /
   *                        cancel. syncPositions() acts as a final fallback.
   */
  private async handleExits(bar: any): Promise<boolean> {
    if (!this.posManager.hasPosition(bar.symbol)) return false;

    const riskProfile = STRATEGY_RISK_MAP[bar.symbol];
    if (!riskProfile) return false;

    const { shouldExit, reason } = this.posManager.checkExitConditions(
      bar.symbol,
      bar.close,
    );

    if (!shouldExit) return false;

    console.log(`🚨 Exit condition met for ${bar.symbol}: ${reason}`);

    // Acquire the lock before any async work so concurrent bar events for the
    // same symbol cannot slip through while the close call is in-flight.
    this.posManager.markPendingExit(bar.symbol);

    try {
      await this.executor.closePosition(bar.symbol);

      // Executor resolved — the order is submitted. The lock will be cleared
      // by onOrderUpdate once the broker confirms the fill or cancellation.
      // We do NOT clear it here so that any bar arriving before the fill
      // confirmation is still blocked by the guard in checkExitConditions.
      this.broadcaster.broadcastSignal({
        symbol: bar.symbol,
        action: "SELL",
        confidence: 1,
        reason,
      });
    } catch (executionError) {
      // The close call itself failed (network error, Alpaca rejection, etc.).
      // Release the lock immediately so the next bar can retry.
      console.error(
        `❌ [PIPELINE] closePosition failed for ${bar.symbol}. Releasing lock for retry.`,
        executionError,
      );
      this.posManager.clearPendingExit(bar.symbol);
    }

    return true;
  }

  private async handleScannerAndWarmup(bar: Bar): Promise<void> {
    if (!this.scanner) return;

    const scan = this.scanner.processBar(bar.symbol, bar.volume, bar.close);

    // CHANGED: Cross-references against MASTER_WATCHLIST to prevent duplicates
    if (scan.isHot && scan.isTradable && !MASTER_WATCHLIST.has(bar.symbol)) {
      // CHANGED: Seed the dynamic token right into the Master Watchlist Map
      MASTER_WATCHLIST.set(bar.symbol, {
        symbol: bar.symbol,
        strategy: "dayTradeMicroScalp",
        stopLossPct: 2.0,
        takeProfitPct: 2.2,
      });

      // CHANGED: Forces flat compatibility caches to update in-place immediately
      syncTrackingCaches();

      // Strategy hydration logic runs here...
    }
  }

  private async handleStrategyEntries(bar: any) {
    const strategy = this.strategies.get(bar.symbol);
    if (!strategy || this.engineState.isKilled) return;

    console.log(`${bar.symbol} ${strategy.constructor.name}`);
    const signal = await strategy.evaluateStrategy(bar);

    if (!signal || typeof signal.action === "undefined") {
      console.error(
        `❌ Strategy Error: ${strategy.constructor.name} for ${bar.symbol} returned an invalid signal!`,
        { signal },
      );
      return;
    }

    if (
      signal.action === "BUY" &&
      this.posManager.canOpenPosition(bar.symbol)
    ) {
      try {
        const equity = await this.posManager.getOrFetchEquity();
        const qty = (equity * TRADING_CONFIG.RISK_PER_TRADE) / bar.close;
        if (qty > 0) {
          this.broadcaster.broadcastSignal(signal);

          // Resolve strategy metadata from the watchlist so the executor can
          // attach it to the active-trade log entry.
          const watchlistEntry = MASTER_WATCHLIST.get(bar.symbol);
          const tradeMeta = {
            strategy: watchlistEntry?.strategy ?? strategy.constructor.name,
            takeProfitPct: watchlistEntry?.takeProfitPct ?? 2.2,
            stopLossPct: watchlistEntry?.stopLossPct ?? 2.0,
          };

          await this.executor.placeBuyOrder(bar.symbol, qty, tradeMeta);
          await this.posManager
            .syncPositions()
            .catch((err: any) =>
              console.error("❌Background sync failed: ", err),
            );
        } else {
          this.posManager.clearPendingBuy(bar.symbol);
        }
      } catch (err) {
        console.error(`❌Execution Error for ${bar.symbol}: `, err);
        this.posManager.clearPendingBuy(bar.symbol);
      }
    }
  }

  private async runTestBuy(symbol: string) {
    if (!StreamPipeline.ranTestBuy) {
      const qty = 1;
      console.log(`🧪 TEST: Forcing a test buy for ${symbol}...`);
      await this.executor.placeBuyOrder(symbol, parseFloat(qty.toFixed(4)), {
        strategy: "testBuy",
        takeProfitPct: 2.2,
        stopLossPct: 2.0,
      });
      await this.posManager.syncPositions();
      StreamPipeline.ranTestBuy = true;
    }
  }

  public subscribeToNewSymbols(symbols: string[]): void {
    if (!symbols || symbols.length === 0) return;
    console.log(
      `📡[STREAM]Extending WebSocket subscriptions for ${symbols.join(", ")}`,
    );

    try {
      // this.alpaca.data_stream_v2.subscribeBars(symbols)
      this.alpaca.data_stream_v2.subscribeForBars(symbols);
    } catch (err) {
      console.error("❌[STREAM] Failed to inject symbol streams: ", err);
    }
  }
}
