// src/api.ts
// Express application factory.
// Wires together middleware, domain routers, and the global error handler.
// Business logic lives in modules/trades — this file is pure composition.

import express, { Application } from "express";
import cors from "cors";
import { PositionManager } from "./positionManager.js";
import { Executor } from "./executor.js";
import { Broadcaster } from "./broadcaster.js";
import { requestLogger } from "./middleware/logger.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { createTradesRouter, TradesService } from "./modules/trades/index.js";
import type { EngineState } from "./modules/trades/trades.types.js";

interface ApiConfig {
  posManager: PositionManager;
  executor: Executor;
  broadcaster: Broadcaster;
  engineState: EngineState;
}

export function startApiService({
  posManager,
  executor,
  broadcaster,
  engineState,
}: ApiConfig): Application {
  const app = express();

  // ─── Global Middleware ──────────────────────────────────────────────────────
  app.use(cors());
  app.use(express.json());
  app.use(requestLogger);

  // ─── Domain Routers ─────────────────────────────────────────────────────────
  const tradesService = new TradesService(
    posManager,
    executor,
    broadcaster,
    engineState,
  );
  app.use("/", createTradesRouter(tradesService));

  // ─── Global Error Handler (must be last) ────────────────────────────────────
  app.use(errorHandler);

  app.listen(4001, () =>
    console.log("🚨 Kill Switch API live on port 4001"),
  );

  return app;
}
