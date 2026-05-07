import Alpaca from "@alpacahq/alpaca-trade-api";
import path from "path";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { BarSchema } from "@my-platform/types";
import { BiotechMomentumStrategy } from "./strategy.js";
import { PDLSweepVWAPReclaim } from "./strategies/pdl-vwap.js";
import { PositionManager } from "./positions.js";
import { Executor } from "./executor.js";
import { Broadcaster } from "./broadcaster.js";
import { logTrade, getTradeHistory } from "./logger.js";
import { Scanner } from "./scanner.js";

declare module "express";
declare module "cors";

// 1. ENVIRONMENT CONFIGURATION
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// 2. INITIALIZATION
const alpaca = new Alpaca();
const posManager = new PositionManager(alpaca);
const executor = new Executor(alpaca);
// const strategies = new Map<string, BiotechMomentumStrategy>();
const strategies = new Map<string, PDLSweepVWAPReclaim>();
const broadcaster = new Broadcaster(4000);
const RISK_PER_TRADE = 0.05; // 5% of total equity per position
let isMarketConnected = false;
let isTradeConnected = false;

const marketStream = alpaca.data_stream_v2;
// const tradeStream = alpaca.websockets;
// const tradeStream = alpaca.trade_updates_v2;

// test flags
let ranTestBuy: boolean = false;

// KILL SWITCH FUNCTIONALITY
// Safety flag for Kill switch
let isKilled = false;
const app = express();
app.use(cors());
app.use(express.json());

/**
 * App Signals
 */
app.get("/history", async (req, res) => {
  try {
    const history = await getTradeHistory();
    res.json(history.reverse());
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

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

app.post("/close", async (req, res) => {
  const { symbol } = req.body;

  if (!symbol) {
    return res.status(400).json({ error: "Symbol is required" });
  }

  try {
    await executor.closePosition(symbol);

    broadcaster.broadcastSignal({
      symbol,
      action: "SELL",
      confidence: 1,
      reason: "Manual close from dashboard",
    });

    console.log(`🔴 Manually closed position: ${symbol}`);
    if (res.status(200)) {
      res.status(200).json({ message: `Position closed: ${symbol}` });
      await posManager.syncPositions();
    } else {
      res.status(500).json({ error: `Failed to close position: ${symbol}` });
    }
  } catch (err) {
    console.error(`❌ Failed to close ${symbol}:`, err);
    res.status(500).json({ error: `Failed to close position: ${symbol}` });
  }
});

app.listen(4001, () => console.log("🚨 Kill Switch API live on port 4001"));

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

async function sendSellSignal(symbol: string) {
  console.log(`🚨 EXIT SIGNAL [${symbol}]: User manually closed position`);
  await executor.closePosition(symbol);

  // Broadcast and Log the exit
  broadcaster.broadcastSignal({
    symbol: symbol,
    action: "SELL",
    confidence: 1,
    reason: `Auto-Exit: User manually closed position`,
  });

  await posManager.syncPositions();
  return; // Stop processing this bar once we sell
}

const scanner = new Scanner();
const WATCHLIST = ["SPY", "PTON", "VRTX"];
const SCAN_LIST = [
  "SPY",
  "SPXL",
  "IPHA",
  "PBYI",
  "WKEY",
  "SERV",
  "GBTG",
  "PTON",
  "NTLA",
];

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

    // const strategy = new BiotechMomentumStrategy();
    const strategy = new PDLSweepVWAPReclaim();
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

async function checkPositionsForExits() {
  if (posManager.getPendingExits().size === 0) {
    return;
  }

  console.log("Pending Exits: ", posManager.getPendingExits());

  try {
    await posManager.syncPositions();
    const positions = posManager.getPositions();

    for (const pos of positions) {
      const currentPrice = parseFloat(pos.current_price);
      const { shouldExit, reason } = posManager.checkExitConditions(
        pos.symbol,
        currentPrice,
      );

      if (shouldExit) {
        posManager.markPendingExit(pos.symbol);
        console.log(`🚨 EXIT SIGNAL [${pos.symbol}]: ${reason}`);

        try {
          await executor.closePosition(pos.symbol);
          broadcaster.broadcastSignal({
            symbol: pos.symbol,
            action: "SELL",
            confidence: 1,
            reason: `Auto-exit: ${reason}`,
          });
        } catch (err) {
          console.error(
            `⚠️ Exit attempt failed for ${pos.symbol}, will retry next cycle`,
          );
        }
      }
    }
    broadcaster.broadcastPortfolio(posManager.getPositions());
  } catch (err) {
    console.error("Failed to sync/check exits: ", err);
  }
}

// 4. THE MAIN DATA PIPELINE
function setupStreamHandlers() {
  marketStream.onConnect(() => {
    console.log("📡 Connected to Alpaca Real-Time Stream");
    marketStream.subscribeForBars(SCAN_LIST);
  });

  //   marketStream.onAuthenticated(() => {
  //     isMarketConnected = true;
  //     console.log("✅ Market Stream Authenticated");
  //   });

  marketStream.onStockBar(async (barData: any) => {
    try {
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

      // A. CHECK EXITS (This must happen first)
      if (posManager.hasPosition(bar.symbol)) {
        const { shouldExit, reason } = posManager.checkExitConditions(
          bar.symbol,
          bar.close,
        );

        if (shouldExit) {
          posManager.markPendingExit(bar.symbol);
          console.log(`🚨 EXIT SIGNAL [${bar.symbol}]: ${reason}`);
          await executor.closePosition(bar.symbol);

          // Broadcast and Log the exit
          broadcaster.broadcastSignal({
            symbol: bar.symbol,
            action: "SELL",
            confidence: 1,
            reason: `Auto-Exit: ${reason}`,
          });

          await posManager.syncPositions();
          return; // Stop processing this bar once we sell
        }
      }

      // B. UPDATE UI & SCANNER
      console.log(`📈 [${bar.symbol}] $${bar.close}`);
      broadcaster.broadcastBar(bar.symbol, bar.close);

      const { isHot, rvol } = scanner.processBar(bar.symbol, bar.volume);
      if (isHot && !strategies.has(bar.symbol)) {
        console.log(
          `🔥 SCANNER: ${bar.symbol} is surging! RVOL: ${rvol.toFixed(2)}x`,
        );
        broadcaster.broadcastScannerAlert(bar.symbol, rvol);

        // const newStrategy = new BiotechMomentumStrategy();
        const newStrategy = new PDLSweepVWAPReclaim();
        newStrategy.hydrate([bar]);
        strategies.set(bar.symbol, newStrategy);
      }

      // C. STRATEGY PROCESSING
      const strategy = strategies.get(bar.symbol);
      if (!strategy) return;

      const signal = strategy.update(bar);

      // D. EXECUTION GATEKEEPING
      if (
        signal.action === "BUY" &&
        !isKilled &&
        posManager.canOpenPosition(bar.symbol)
      ) {
        const account = await alpaca.getAccount();
        const equity = parseFloat(account.equity);
        const qty = (equity * RISK_PER_TRADE) / bar.close;

        if (qty > 0) {
          console.log(`🚀 BUY SIGNAL: ${bar.symbol} - ${signal.reason}`);
          broadcaster.broadcastSignal(signal);
          await executor.placeBuyOrder(bar.symbol, qty);
          await posManager.syncPositions();
        }
      }

      // ⚠️ COMMENT TO FIX STOPLOSS: Do not force buy MRNA here or it will override your Stop Loss!
      if (bar.symbol === "PTON" && !ranTestBuy) {
        // const account = await alpaca.getAccount();
        const qty = 1;
        // const qty = (parseFloat(account.equity) * RISK_PER_TRADE) / bar.close;

        console.log(`🧪 TEST: Forcing a test buy for ${bar.symbol}...`);
        await executor.placeBuyOrder(bar.symbol, parseFloat(qty.toFixed(4)));
        await posManager.syncPositions();
        ranTestBuy = true;
      }
    } catch (err) {
      console.error(
        "❌ Stream Error:",
        err instanceof Error ? err.message : err,
      );
    }
  });

  marketStream.onError((err: any) => console.error("Stream Error:", err));
}

// 5. EXECUTION ENTRY POINT (KEEP THIS!)
async function main() {
  await checkAccountHealth();
  await posManager.syncPositions();
  await warmupStrategies();

  // Call the REAL setupStreamHandlers defined above
  setupStreamHandlers();

  // System Health Broadcast
  setInterval(() => {
    broadcaster.broadcastHealth(isMarketConnected && isTradeConnected);
  }, 5000);

  // Portfolio & Account Sync
  setInterval(async () => {
    try {
      await posManager.syncPositions();
      const account = await alpaca.getAccount();
      const positions = posManager.getPositions(); // Use the getter
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
  }, 1000);

  setInterval(checkPositionsForExits, 2000);

  marketStream.connect();
}

main();
