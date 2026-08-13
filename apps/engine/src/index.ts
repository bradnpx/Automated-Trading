// src/index.ts
import Alpaca from "@alpacahq/alpaca-trade-api";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

// Custom Engine Modules
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
import { fetchTradeHistory } from "./middleware/logger.js";
import { StockBlacklist } from "./functions/getStockBlacklist.js";

// ENVIRONMENT LOAD
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

async function main() {
  // INITIALIZATION LAYER
  const alpaca = new Alpaca();
  const blacklist = await StockBlacklist.getInstance(30000);
  const posManager = new PositionManager(alpaca);
  await posManager.init();
  const executor = new Executor(alpaca);
  const broadcaster = new Broadcaster(4000);
  const scanner = new Scanner();
  const strategies = new Map<string, any>();
  const engineState = { isKilled: false };

  await checkAccountHealth(alpaca);
  await posManager.syncPositions();

  console.log("🔍[BOOTSTRAP] Executing primary gainer discovery sweep...");
  try {
    const initialScannerSymbols = await bootstrapMarketSession();
    for (const symbol of initialScannerSymbols) {
      if (!MASTER_WATCHLIST.has(symbol)) {
        MASTER_WATCHLIST.set(symbol, {
          symbol,
          strategy: "dayTradeMicroScalp",
          stopLossPct: 5,
          takeProfitPct: 5,
        });
      }
    }
    syncTrackingCaches();
  } catch (err) {
    console.error(
      "⚠️ Initial gainer sweep failed, falling back to manual env: ",
      err,
    );
  }

  await warmupStrategies(alpaca, strategies);

  // 4. START INDEPENDENT SUBSYSTEMS
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

  await executeDynamicScannerSweep(alpaca, strategies, pipeline);

  const SCAN_INTERVAL_MS = 60 * 1000;
  setInterval(async () => {
    if (!engineState.isKilled) {
      await executeDynamicScannerSweep(alpaca, strategies, pipeline);
    }
  }, SCAN_INTERVAL_MS);

  console.log("⚡ Automated Trading Application fully operational.");
}

main();
