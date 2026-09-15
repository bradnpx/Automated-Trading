import express from "express";
import cors from "cors";
import { PositionManager } from "./positionManager.js";
import { Executor } from "./executor.js";
import { Broadcaster } from "./broadcaster.js";
import { getTradeHistory, fetchTradeHistory } from "./middleware/logger.js";
import { MASTER_WATCHLIST } from "./config/config.js";
import { PremarketMode } from "@my-platform/types";

interface ApiConfig {
  posManager: PositionManager;
  executor: Executor;
  broadcaster: Broadcaster;
  engineState: { isKilled: boolean; premarketMode?: PremarketMode };
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
    res.json(JSON.stringify(Object.fromEntries(MASTER_WATCHLIST)));
  });

  // GET: Current premarket display/review mode. This never changes order routing.
  app.get("/premarket-mode", (_req, res) => {
    res.json({
      mode: engineState.premarketMode ?? "evaluation_only",
      updatedAt: new Date().toISOString(),
    });
  });

  // POST: Switch between evaluation-only and non-submitting manual-review proposals.
  app.post("/premarket-mode", (req, res) => {
    const mode = req.body?.mode;
    if (mode !== "evaluation_only" && mode !== "manual_review") {
      return res.status(400).json({
        error: "mode must be either evaluation_only or manual_review",
      });
    }

    engineState.premarketMode = mode;
    broadcaster.broadcastPremarketMode(mode);
    res.status(200).json({ mode, updatedAt: new Date().toISOString() });
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
