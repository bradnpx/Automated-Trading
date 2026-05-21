import express from "express";
import cors from "cors";
import { PositionManager } from "./positions.js";
import { Executor } from "./executor.js";
import { Broadcaster } from "./broadcaster.js";
import { getTradeHistory } from "./logger.js";

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
      const history = await getTradeHistory();
      res.json(history.reverse());
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch history" });
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

    try {
      await executor.closePosition(symbol);

      broadcaster.broadcastSignal({
        symbol,
        action: "SELL",
        confidence: 1,
        reason: "Manual close from dashboard",
      });

      console.log(`🔴 Manually closed position: ${symbol}`);
      await posManager.syncPositions();
      res.status(200).json({ message: `Position closed: ${symbol}` });
    } catch (err) {
      console.error(`❌ Failed to close ${symbol}:`, err);
      res.status(500).json({ error: `Failed to close position: ${symbol}` });
    }
  });

  app.listen(4001, () => console.log("🚨 Kill Switch API live on port 4001"));

  return app;
}
