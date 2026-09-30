import express from "express";
import cors from "cors";
import { PositionManager } from "./positionManager.js";
import { Executor } from "./executor.js";
import { Broadcaster } from "./broadcaster.js";
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

  // GET: Fetch completed trades from the local lifecycle store.
  app.get("/history", (req, res) => {
    res.json(posManager.getClosedTrades());
  });

  // GET: Inspect the complete in-process portfolio lifecycle snapshot.
  app.get("/portfolio-state", (req, res) => {
    res.json(posManager.getPortfolioSnapshot());
  });

  // GET: Watchlist
  app.get("/watchlist", async (req, res) => {
    res.json(JSON.stringify(Object.fromEntries(MASTER_WATCHLIST)));
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
      // The trade-update stream clears the lock and reconciles broker state once
      // Alpaca confirms the order lifecycle event.
      res.status(200).json({ message: `Position close submitted for ${symbol}` });
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
