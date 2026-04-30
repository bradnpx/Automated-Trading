import Alpaca from "@alpacahq/alpaca-trade-api";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { BarSchema } from "@my-platform/types";
import { BiotechMomentumStrategy } from "./strategy.js";
import { PositionManager } from "./positions.js";
import { Executor } from "./executor.js";
import { Broadcaster } from "./broadcaster.js";
import express from "express";
import cors from "cors";

declare module "express";
declare module "cors";

// 1. ENVIRONMENT CONFIGURATION
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// 2. INITIALIZATION
const alpaca = new Alpaca();
const posManager = new PositionManager(alpaca);
const executor = new Executor(alpaca);
const strategies = new Map<string, BiotechMomentumStrategy>();
const broadcaster = new Broadcaster(4000);
const RISK_PER_TRADE = 0.05; // 5% of total equity per position

const marketStream = alpaca.data_stream_v2;
// const tradeStream = alpaca.websockets;
// const tradeStream = alpaca.trade_updates_v2;

// KILL SWITCH FUNCTIONALITY
// Safety flag for Kill switch
let isKilled = false;
const app = express();
app.use(cors());
app.use(express.json());

app.post("/reset", async (req, res) => {
  isKilled = false;
  broadcaster.broadcastStatus("ACTIVE");
  await posManager.syncPositions();

  console.log("♻️  RESET INITIATED: Restoring engine functionality...");

  res.status(200).json({ message: "Engine Resumed" });
});

app.post("/panic", async (req, res) => {
  isKilled = true;
  broadcaster.broadcastStatus("KILLED");
  const result = await executor.killEverything();

  if (result.success) {
    res.status(200).json({ message: "Engine Neutered Successfully" });
  } else {
    res.status(500).json({ error: "Panic failed partially" });
  }
});

app.listen(4001, () => console.log("🚨 Kill Switch API live on port 4001"));

const WATCHLIST = ["MRNA", "BNTX", "VRTX"];

// 3. LIFECYCLE METHODS
async function checkAccountHealth() {
  console.log("--- 🚀 Initializing Trading Engine Health Check ---");
  try {
    const account = await alpaca.getAccount();
    console.log(
      `Status: ${account.status} | Buying Power: $${account.buying_power} | Equity: $${account.equity}`,
    );

    if (account.trading_blocked) {
      console.warn("⚠️ WARNING: Account is blocked from trading.");
      process.exit(1);
    }
  } catch (error) {
    console.error(
      "❌ Failed to connect to Alpaca API:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
}

async function warmupStrategies() {
  for (const symbol of WATCHLIST) {
    console.log(`🔥 Warming up strategy for ${symbol}...`);

    // Fetch last 100 minutes of data for indicators
    const bars = await alpaca.getBarsV2(symbol, {
      start: new Date(Date.now() - 1000 * 60 * 200).toISOString(), // ~3 hours ago
      end: new Date(Date.now() - 1000 * 60 * 16).toISOString(), // 16 mins ago (Required for Free Tier)
      timeframe: alpaca.newTimeframe(1, alpaca.timeframeUnit.MIN),
      feed: "iex", // Explicitly use the free IEX feed
    });

    const strategy = new BiotechMomentumStrategy();
    const historicalBars = [];

    for await (const b of bars) {
      historicalBars.push(
        BarSchema.parse({
          symbol: symbol,
          timestamp: b.Timestamp ?? b.timestamp,
          open: b.OpenPrice ?? b.Open ?? b.open,
          high: b.HighPrice ?? b.High ?? b.high,
          low: b.LowPrice ?? b.Low ?? b.low,
          close: b.ClosePrice ?? b.Close ?? b.close,
          volume: b.Volume ?? b.volume,
        }),
      );
    }

    strategy.hydrate(historicalBars);
    strategies.set(symbol, strategy);
  }
}

// 4. THE MAIN DATA PIPELINE
function setupStreamHandlers() {
  marketStream.onConnect(() => {
    console.log("📡 Connected to Alpaca Real-Time Stream");
    marketStream.subscribeForBars(WATCHLIST);
    // marketStream.subscribeForTradeUpdates();
  });

  //   TODO: fix Race conditions
  marketStream.onStockBar(async (barData: any) => {
    try {
      // 1. UNIVERSAL MAPPING (Handles Stream, REST, and different SDK versions)
      const bar = BarSchema.parse({
        symbol: barData.Symbol ?? barData.symbol,
        timestamp: barData.Timestamp ?? barData.timestamp,
        open:
          barData.OpenPrice ?? barData.Open ?? barData.open ?? barData.o ?? 0,
        high:
          barData.HighPrice ?? barData.High ?? barData.high ?? barData.h ?? 0,
        low: barData.LowPrice ?? barData.Low ?? barData.low ?? barData.l ?? 0,
        close:
          barData.ClosePrice ??
          barData.Close ??
          barData.close ??
          barData.c ??
          0,
        volume: barData.Volume ?? barData.volume ?? barData.v ?? 0,
      });

      console.log(`📈 [${bar.symbol}] $${bar.close}`);
      broadcaster.broadcastBar(bar.symbol, bar.close);

      // B. Risk Management (Emergency Exits)
      const { exit, reason } = posManager.shouldEmergencyExit(bar);
      if (exit) {
        console.log(`🚨 EXIT SIGNAL: ${bar.symbol} - ${reason}`);
        await executor.closePosition(bar.symbol);
        await posManager.syncPositions();
        return;
      }

      // C. Strategy Processing
      const strategy = strategies.get(bar.symbol);
      if (!strategy) return;
      const signal = strategy.update(bar);

      // D. Execution Gatekeeping
      if (signal.action === "BUY") {
        if (isKilled) {
          console.warn("🚫 Trade blocked: Engine is in KILL MODE.");
          return;
        }

        if (posManager.canOpenPosition(bar.symbol)) {
          const account = await alpaca.getAccount();
          const equity = parseFloat(account.equity);

          const targetAllocationUsd = equity * RISK_PER_TRADE;

          const qty = targetAllocationUsd / bar.close;

          if (targetAllocationUsd < 1) {
            console.warn(`⚠️ Allocation too small for ${bar.symbol}`);
            return;
          }

          console.log(`🚀 BUY SIGNAL: ${bar.symbol} - ${signal.reason}`);
          console.log(
            `⚖️  SIZING: Allocating $${targetAllocationUsd.toFixed(2)} (${qty.toFixed(4)} shares)`,
          );

          broadcaster.broadcastSignal(signal);

          await executor.placeBuyOrder(bar.symbol, 1);
          await posManager.syncPositions();
        }
      }

      // E. TEMPORARY TEST (Keep inside 'try' so 'bar' is defined)
      if (bar.symbol === "MRNA") {
        const account = await alpaca.getAccount()
        const qty = (parseFloat(account.equity) * RISK_PER_TRADE) / bar.close;

        console.log("🧪 TEST: Forcing a test buy for MRNA...");
        await executor.placeBuyOrder(bar.symbol, parseFloat(qty.toFixed(4)));
        await posManager.syncPositions();
      }
    } catch (err) {
      console.error(
        "❌ Stream Error:",
        err instanceof Error ? err.message : err,
      );
    }
    // <--- NOTHING SHOULD BE HERE (This is the end of the onStockBar function)
  });

  //   marketStream.onTradeUpdate(async (update: any) => {
  //     const { event, order, position_qty } = update;

  //     switch (event) {
  //       case "fill":
  //         console.log(
  //           `✅ ORDER FILLED: ${order.symbol} | Qty: ${order.qty} @ $${order.filled_avg_price}`,
  //         );
  //         await posManager.syncPositions();
  //         break;
  //       case "canceled":
  //         console.log(`❌ ORDER CANCELED: ${order.symbol}`);
  //         break;
  //       case "rejected":
  //         console.log(`⚠️ ORDER REJECTED: ${order.symbol}`);
  //         break;
  //     }
  //   });

  marketStream.onError((err: any) => console.error("Stream Error:", err));
}

// 5. EXECUTION ENTRY POINT (KEEP THIS!)
async function main() {
  await checkAccountHealth();
  await posManager.syncPositions();
  await warmupStrategies();

  setupStreamHandlers();

  setInterval(async () => {
    await posManager.syncPositions();
    broadcaster.broadcastPortfolio(Array.from(posManager.getPositions()));
  }, 500);

  setInterval(async () => {
    try {
      const [account, positions] = await Promise.all([
        alpaca.getAccount(),
        posManager
          .syncPositions()
          .then(() => Array.from(posManager.getPositions())),
      ]);

      broadcaster.broadcastPortfolio(positions);

      broadcaster.broadcastAccount({
        equity: parseFloat(account.equity),
        buying_power: parseFloat(account.buying_power),
        cash: parseFloat(account.cash),
        day_pl: parseFloat(account.equity) - parseFloat(account.last_equity),
        day_pl_pct:
          parseFloat(account.equity) / parseFloat(account.last_equity) - 1,
      });
    } catch (err) {
      console.error("Failed to sync account data: ", err);
    }
  }, 5000);

  marketStream.connect();
}

main();
