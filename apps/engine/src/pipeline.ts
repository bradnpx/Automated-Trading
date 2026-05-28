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
      marketStream.subscribeForBars(ALL_TRACKED_SYMBOLS);
    });

    let strategy = ''
    marketStream.onStockBar(async (barData: any) => {
      try {
        const bar = this.parseBar(barData);
        console.log(`🍆onstockbar ${bar.symbol}`);

        // A. Process exits instantly before evaluating new setups
        if (await this.handleExits(bar)) return;

        // B. Broadcast real-time bar telemetry to frontend UI dashboard
        this.broadcaster.broadcastBar(bar.symbol, bar.close);

        // C. Scanner parsing & dynamic strategy lookups via Factory Engine
        await this.handleScannerAndWarmup(bar);

        // D. Process active target strategy evaluation filters
        strategy = await this.handleStrategyEntries(bar);

        // E. Optional Sandbox Test Orders
        if (bar.symbol === "F") {
          await this.runTestBuy(bar.symbol);
        }
      } catch (err) {
        console.error("❌ Stream Engine Processing Error:", err);
      }
    });

    // --- TRADE EXECUTION REFORMS (Un-nested for performance) ---
    tradeStream.onConnect(() => {
      console.log("🤝 Trade WebSocket: Connected");
      tradeStream.subscribe(["trade_updates"]);
    });

    tradeStream.onOrderUpdate(async (data: any) => {
      try {
        const { event, order, price, fillQty } = data;

        // Only process and broadcast on official fill checkpoints
        if (event === "fill" || event === "partial_fill") {
          const fillPrice = parseFloat(price || order.filled_avg_price || 0);
          const qty = parseFloat(fillQty || order.filled_qty || 0);

          if (fillPrice === 0) {
            console.warn(
              `⚠️ Warning: Fill price is 0 for ${order.symbol}.`,
              data,
            );
            return;
          }

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
                winStatus = "LOSS"
            } else {
                winStatus = "BREAKEVEN"
            }
          }

          // Persist metrics out to local analytics structures
          await logTrade({
            symbol: order.symbol,
            side: order.side.toUpperCase(),
            qty: qty.toString(),
            price: fillPrice.toString(),
            pnl: pnl,
            pnl_pct: pnlPct,
            timestamp: new Date().toISOString(),
            reason: order.side === "sell" ? "Exit" : strategy,
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
      this.posManager.markPendingExit(bar.symbol);
      await this.executor.closePosition(bar.symbol);
      this.broadcaster.broadcastSignal({
        symbol: bar.symbol,
        action: "SELL",
        confidence: 1,
        reason,
      });
      await this.posManager.syncPositions();
      return true;
    }
    return false;
  }

  private async handleScannerAndWarmup(bar: any) {
    console.log("handleScannerAndWarmup🥬");
    const { isHot, rvol } = this.scanner.processBar(bar.symbol, bar.volume, bar.close);

    if (isHot && !this.strategies.has(bar.symbol)) {
      this.broadcaster.broadcastScannerAlert(bar.symbol, rvol);

      // 1. Check your configuration dictionary to see which strategy maps to this symbol
      const targetStrategyKey = SYMBOL_STRATEGY_MAP[bar.symbol];

      // 2. Resolve the matching strategy key
      const strategyToCreate = targetStrategyKey;

      console.log(
        `🎯 Routing breakout ticker ${bar.symbol} to factory context: [${strategyToCreate}]`,
      );

      // 3. Dynamically instantiate the strategy class template via the Factory Line
      if (strategyToCreate) {
        const newStrategy = StrategyFactory.create(strategyToCreate);
        const prevLow = await getPreviousDayLow(this.alpaca, bar.symbol);
        newStrategy.hydrate([bar], prevLow);
        this.strategies.set(bar.symbol, newStrategy);
      }
    }
  }

  private async handleStrategyEntries(bar: any) {
    console.log("🐋 handleStrategyEntries");
    const strategy = this.strategies.get(bar.symbol);
    console.log(`${bar.symbol} ${strategy?.constructor.name}`);
    if (!strategy || this.engineState.isKilled) return;

    const signal = await strategy.evaluateStrategy(bar);

    // 👇 ADD THIS SAFETY GUARD HERE 👇
    if (!signal || typeof signal.action === 'undefined') {
      console.error(
        `❌ Strategy Error: ${strategy.constructor.name} for ${bar.symbol} returned an invalid or undefined signal object!`,
        { signal }
      );
      return; // Gracefully skip this bar instead of crashing the process
    }
    
    if (
      signal.action === "BUY" &&
      this.posManager.canOpenPosition(bar.symbol)
    ) {
      const account = await this.alpaca.getAccount();
      const qty =
        (parseFloat(account.equity) * TRADING_CONFIG.RISK_PER_TRADE) /
        bar.close;

      if (qty > 0) {
        this.broadcaster.broadcastSignal(signal);
        await this.executor.placeBuyOrder(bar.symbol, qty);
        await this.posManager.syncPositions();
        return strategy.constructor.name
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
