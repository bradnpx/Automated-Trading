import express from "express";
import cors from "cors";
import { PositionManager } from "./positionManager.js";
import { Executor } from "./executor.js";
import { Broadcaster } from "./broadcaster.js";
import { getTradeHistory, fetchTradeHistory } from "./middleware/logger.js";
import { getActiveTrades, groupTradesStat } from "./middleware/activeTradeLogger.js";
import { MASTER_WATCHLIST } from "./config/config.js";

interface ApiConfig {
  posManager: PositionManager;
  executor: Executor;
  broadcaster: Broadcaster;
  engineState: { isKilled: boolean };
}

export function startApiService({
  posManager,
  executor,
  broadcaster,
  engineState,
}: ApiConfig) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // GET: Fetch Trade History
  app.get("/history", async (req, res) => {
    try {
      const history = await fetchTradeHistory();
      res.json(history);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch history" });
    }
  });

  // GET: Watchlist
  app.get("/watchlist", async (req, res) => {
    return MASTER_WATCHLIST;
  });

  // GET: Active trade log — all currently open buy-side trades enriched with
  // strategy and risk metadata.
  app.get("/active-trades", async (_req, res) => {
    try {
      const trades = await getActiveTrades();
      res.json(trades);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch active trades" });
    }
  });

  // GET: Per-strategy aggregated statistics derived from the active-trade log.
  app.get("/active-trades/stats", async (_req, res) => {
    try {
      const trades = await getActiveTrades();
      const stats = groupTradesStat(trades);
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: "Failed to compute strategy stats" });
    }
  });

  // POST: Reset Engine Kill Switch
  app.post("/reset", async (req, res) => {
    engineState.isKilled = false;
    broadcaster.broadcastStatus("ACTIVE");
    await posManager.syncPositions();

    console.log("♻️  RESET INITIATED: Restoring engine functionality...");
    res.status(200).json({ message: "Engine Resumed" });
  });

  // POST: Emergency Panic Kill Switch
  app.post("/panic", async (req, res) => {
    engineState.isKilled = true;
    broadcaster.broadcastStatus("KILLED");
    const result = await executor.killEverything();

    if (result.success) {
      res.status(200).json({ message: "Engine Neutered Successfully" });
    } else {
      res.status(500).json({ error: "Panic failed partially" });
    }
  });

  // POST: Manual Close Position
  app.post("/close", async (req, res) => {
    const { symbol } = req.body;

    if (!symbol) {
      return res.status(400).json({ error: "Symbol is required" });
    }

    // Respect the pending-exit lock so a manual close cannot race with an
    // automated exit that is already in-flight for the same symbol.
    if (posManager.hasPendingExit(symbol)) {
      return res
        .status(409)
        .json({ error: `Close already in progress for ${symbol}` });
    }

    posManager.markPendingExit(symbol);

    try {
      await executor.closePosition(symbol);

      broadcaster.broadcastSignal({
        symbol,
        action: "SELL",
        confidence: 1,
        reason: "Manual close from dashboard",
      });

      console.log(`🔴 Manually closed position: ${symbol}`);
      // Lock is cleared by onOrderUpdate on fill confirmation.
      await posManager.syncPositions();
      res.status(200).json({ message: `Position closed: ${symbol}` });
    } catch (err) {
      // Release the lock so the position can be retried.
      posManager.clearPendingExit(symbol);
      console.error(`❌ Failed to close ${symbol}:`, err);
      res.status(500).json({ error: `Failed to close position: ${symbol}` });
    }
  });

  app.listen(4001, () => console.log("🚨 Kill Switch API live on port 4001"));

  return app;
}
