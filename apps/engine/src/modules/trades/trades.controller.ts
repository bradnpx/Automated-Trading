// modules/trades/trades.controller.ts
// Handles HTTP request routing for the trades domain.
// All business logic is delegated to TradesService — this file is
// concerned only with parsing requests and formatting responses.

import { Router, Request, Response } from "express";
import { TradesService, ConflictError } from "./trades.service.js";
import { ClosePositionBodySchema } from "./trades.schema.js";

export function createTradesRouter(service: TradesService): Router {
  const router = Router();

  // GET /history — Fetch trade history (most recent first)
  router.get("/history", async (_req: Request, res: Response) => {
    try {
      const trades = await service.getHistory();
      res.json(trades);
    } catch {
      res.status(500).json({ error: "Failed to fetch history" });
    }
  });

  // POST /reset — Resume the engine after a kill
  router.post("/reset", async (_req: Request, res: Response) => {
    try {
      await service.resetEngine();
      res.status(200).json({ message: "Engine Resumed" });
    } catch {
      res.status(500).json({ error: "Reset failed" });
    }
  });

  // POST /panic — Emergency kill switch: cancel all orders, close all positions
  router.post("/panic", async (_req: Request, res: Response) => {
    try {
      const result = await service.panicKill();
      if (result.success) {
        res.status(200).json({ message: "Engine Neutered Successfully" });
      } else {
        res.status(500).json({ error: "Panic failed partially" });
      }
    } catch {
      res.status(500).json({ error: "Panic failed" });
    }
  });

  // POST /close — Manually close a single position by symbol
  router.post("/close", async (req: Request, res: Response) => {
    const parsed = ClosePositionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
      return;
    }

    const { symbol } = parsed.data;

    try {
      await service.closePosition(symbol);
      res.status(200).json({ message: `Position closed: ${symbol}` });
    } catch (err) {
      if (err instanceof ConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      console.error(`❌ Failed to close ${symbol}:`, err);
      res.status(500).json({ error: `Failed to close position: ${symbol}` });
    }
  });

  return router;
}
