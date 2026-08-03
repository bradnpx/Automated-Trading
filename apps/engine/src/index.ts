// src/index.ts
// Application entry point.
// Composes all subsystems and starts the trading engine.

import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

// Engine modules
import { PositionManager } from "./positionManager.js";
import { Executor } from "./executor.js";
import { Broadcaster } from "./broadcaster.js";
import { MASTER_WATCHLIST, syncTrackingCaches } from "./config/config.js";
import { Scanner, bootstrapMarketSession } from "./scanner.js";
import { startApiService } from "./api.js";
import { StreamPipeline } from "./pipeline.js";
import { startBackgroundTasks } from "./tasks.js";
import { warmupStrategies, checkAccountHealth } from "./utils/market.js";
import { executeDynamicScannerSweep } from "./utils/scannerTask.js";
import { createAlpacaClient } from "./services/alpaca.js";
import type { IStrategy } from "./strategies/IStrategy.js";

// Load environment variables before any module that reads process.env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

async function main(): Promise<void> {
  // ─── Initialization ────────────────────────────────────────────────────────
  const alpaca = createAlpacaClient();
  const posManager = new PositionManager(alpaca);
  const executor = new Executor(alpaca);
  const broadcaster = new Broadcaster(4000);
  const scanner = new Scanner();
  const strategies = new Map<string, IStrategy>();
  const engineState = { isKilled: false };

  await checkAccountHealth(alpaca);
  await posManager.syncPositions();

  // ─── Bootstrap market session ──────────────────────────────────────────────
  console.log("🔍[BOOTSTRAP] Executing primary gainer discovery sweep...");
  try {
    const initialScannerSymbols = await bootstrapMarketSession();
    for (const symbol of initialScannerSymbols) {
      if (!MASTER_WATCHLIST.has(symbol)) {
        MASTER_WATCHLIST.set(symbol, {
          symbol,
          strategy: "dayTradeMicroScalp",
          stopLossPct: 2,
          takeProfitPct: 2.2,
        });
      }
    }
    syncTrackingCaches();
  } catch (err) {
    console.error(
      "⚠️ Initial gainer sweep failed, falling back to manual env:",
      err,
    );
  }

  await warmupStrategies(alpaca, strategies);

  // ─── Start independent subsystems ─────────────────────────────────────────
  startApiService({ posManager, executor, broadcaster, engineState });
  startBackgroundTasks(alpaca, posManager, broadcaster, executor);

  const pipeline = new StreamPipeline(
    alpaca,
    posManager,
    executor,
    broadcaster,
    scanner,
    strategies,
    engineState,
  );
  pipeline.initialize();

  // ─── Recurring scanner sweep ───────────────────────────────────────────────
  await executeDynamicScannerSweep(alpaca, strategies, pipeline);

  const SCAN_INTERVAL_MS = 60 * 1_000;
  setInterval(async () => {
    if (!engineState.isKilled) {
      await executeDynamicScannerSweep(alpaca, strategies, pipeline);
    }
  }, SCAN_INTERVAL_MS);

  console.log("⚡ Automated Trading Application fully operational.");
}

main();
