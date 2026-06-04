// src/pipeline.ts
import { BarSchema } from "@my-platform/types";
import {
  TRADING_CONFIG,
  SYMBOL_STRATEGY_MAP,
  ALL_TRACKED_SYMBOLS,
} from "./config.js";
import { logTrade } from "./logger.js";
import { getPreviousDayLow } from "./utils/market.js";
import { StrategyFactory } from "./strategies/StrategyFactory.js";
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
    // 1. Idempotent guard protects shared alpaca instances from stacking events
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
      console.log("📡 Stream Pipeline: Connected to Market Data");
      console.log(ALL_TRACKED_SYMBOLS);
      marketStream.subscribeForBars(ALL_TRACKED_SYMBOLS);
    });

    marketStream.onStockBar(async (barData: any) => {
      try {
        const bar = this.parseBar(barData);
        // console.log(`🍆 onstockbar ${bar.symbol}`);

        // A. Process exits instantly before evaluating new setups
        if (await this.handleExits(bar)) return;

        // B. Broadcast real-time bar telemetry to frontend UI dashboard
        this.broadcaster.broadcastBar(bar.symbol, bar.close);

        // C. Scanner parsing & dynamic strategy lookups via Factory Engine
        await this.handleScannerAndWarmup(bar);

        // D. Process active target strategy evaluation filters
        await this.handleStrategyEntries(bar);

        // E. Optional Sandbox Test Orders
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

        if (
          event === "canceled" ||
          event === "rejected" ||
          event === "expired"
        ) {
          console.warn(
            `🔓 Order update [${event}] received for ${order.symbol}. Releasing pending exit lock.`,
          );
          this.posManager.clearPendingExit(order.symbol);
          await this.posManager.syncPositions();
          this.broadcaster.broadcastPortfolio(this.posManager.getPositions());
          return;
        }

        // Only process and broadcast on official fill checkpoints
        if (event === "fill" || event === "partial_fill") {
          let fillPrice = parseFloat(price || 0);
          let qty = parseFloat(fillQty || 0);

          // Fallback guard: If root variables are empty, fall back onto cumulative aggregates ONLY if it's the final fill checkpoint
          if (fillPrice === 0 || qty === 0) {
            if (event === "fill") {
              fillPrice = parseFloat(order.filled_avg_price || 0);
              qty = parseFloat(order.filled_qty || 0);
            } else {
              // Drop partial_fills with zeroed root data to prevent duplicating cumulative fields
              return;
            }
          }

          // Ultimate safety guard against ghost streaming updates
          if (fillPrice === 0 || qty === 0) return;

          console.log(`✅ EXECUTION: ${order.symbol} filled @ $${fillPrice}`);

          // Compute absolute PnL relative to entry tracking states
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

            if (pnl > 0) {
              winStatus = "WIN";
            } else if (pnl < 0) {
              winStatus = "LOSS";
            } else {
              winStatus = "BREAKEVEN";
            }
          }

          const matchedStrategyId =
            SYMBOL_STRATEGY_MAP[order.symbol] || "UnknownStrategy";

          // Persist metrics out to local analytics structures
          await logTrade({
            symbol: order.symbol,
            side: order.side.toUpperCase(),
            qty: qty.toString(),
            price: fillPrice.toString(),
            pnl: pnl,
            pnl_pct: pnlPct,
            timestamp: new Date().toISOString(),
            reason: order.side === "sell" ? "Exit" : matchedStrategyId,
            win_status: winStatus,
          });

          // Propagate fresh data maps up to the web dashboard UI
          await this.posManager.syncPositions();
          this.broadcaster.broadcastPortfolio(this.posManager.getPositions());
        }
      } catch (err) {
        console.error("❌ Error handling trade order update in pipeline:", err);
      }
    });

    // Spin up stream client listeners
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

  private async handleExits(bar: any): Promise<boolean> {
    if (!this.posManager.hasPosition(bar.symbol)) return false;

    const { shouldExit, reason } = this.posManager.checkExitConditions(
      bar.symbol,
      bar.close,
    );

    if (shouldExit) {
      console.log(`🚨 Exit condition met for ${bar.symbol}: ${reason}`);
      try {
        this.posManager.markPendingExit(bar.symbol);

        await this.executor.closePosition(bar.symbol);
      } catch (executionError) {
        console.error(
          `❌ [PIPELINE] Execution failed for ${bar.symbol}. Releasing pending lock.`,
        );

        this.posManager.clearPendingExit(bar.symbol);
      }

      // FIX 3: Isolated Try/Catch guarantees lock cleanup if API execution errors out
      try {
        const openOrders = await this.alpaca.getOrders({ status: "open" });
        const matchingOrders = openOrders.filter(
          (o: any) => o.symbol === bar.symbol,
        );

        if (matchingOrders.length > 0) {
          console.log(
            `🧹 Canceling ${matchingOrders.length} active orders for ${bar.symbol}...`,
          );
          await Promise.all(
            matchingOrders.map((order: any) =>
              this.alpaca.cancelOrder(order.id),
            ),
          );

          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        const position = await this.alpaca.getPosition(bar.symbol);
        const qtyToClose = Math.floor(Math.abs(parseFloat(position.qty)));

        if (qtyToClose > 0) {
          console.log(
            `⚖️ Routing explicit manual liquidation for ${qtyToClose} whole shares of ${bar.symbol}`,
          );
          const side = position.side === "long" ? "sell" : "buy";

          try {
            await this.alpaca.createOrder({
              Symbol: bar.symbol,
              qty: qtyToClose,
              side: side,
              type: "market",
              time_in_force: "day",
              extended_hours: true,
            });
            this.broadcaster.broadcastSignal({
              symbol: bar.symbol,
              action: "SELL",
              confidence: 1,
              reason,
            });
          } catch (error: any) {
            if (error.response) {
              console.error("Alpaca Rejected request:", error.response.status);
              console.error(
                "Error Details:",
                JSON.stringify(error.response.data),
              );
            } else {
              console.error("Error:", error.message);
            }
          }
        } else {
          console.warn(
            `⚠️ Available whole share quantity for ${bar.symbol} is 0. Releasing exit lock.`,
          );
          this.posManager.clearPendingExit(bar.symbol);
        }
      } catch (err) {
        console.error(
          `❌ Critical: Failed to execute closePosition for ${bar.symbol}. Releasing lock.`,
          err,
        );
        this.posManager.clearPendingExit(bar.symbol);
      }

      await this.posManager.syncPositions();
      return true;
    }
    return false;
  }

  private async handleScannerAndWarmup(bar: any) {
    // console.log("handleScannerAndWarmup🥬");
    const { isHot, rvol } = this.scanner.processBar(
      bar.symbol,
      bar.volume,
      bar.close,
    );

    if (isHot && !this.strategies.has(bar.symbol)) {
      this.broadcaster.broadcastScannerAlert(bar.symbol, rvol);

      const targetStrategyKey = SYMBOL_STRATEGY_MAP[bar.symbol];
      const strategyToCreate = targetStrategyKey;

      console.log(
        `🎯 Routing breakout ticker ${bar.symbol} to factory context: [${strategyToCreate}]`,
      );

      if (strategyToCreate) {
        const newStrategy = StrategyFactory.create(strategyToCreate);
        const prevLow = await getPreviousDayLow(this.alpaca, bar.symbol);
        newStrategy.hydrate([bar], prevLow);
        this.strategies.set(bar.symbol, newStrategy);
      }
    }
  }

  private async handleStrategyEntries(bar: any) {
    // console.log("🐋 handleStrategyEntries");
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
          await this.executor.placeBuyOrder(bar.symbol, qty);
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
      await this.executor.placeBuyOrder(symbol, parseFloat(qty.toFixed(4)));
      await this.posManager.syncPositions();
      StreamPipeline.ranTestBuy = true;
    }
  }
}
