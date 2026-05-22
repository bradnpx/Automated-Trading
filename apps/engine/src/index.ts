// src/index.ts
import Alpaca from "@alpacahq/alpaca-trade-api";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

// Custom Engine Modules
import { PositionManager } from "./positions.js";
import { Executor } from "./executor.js";
import { Broadcaster } from "./broadcaster.js";
import { Scanner } from "./scanner.js";
import { startApiService } from "./api.js";
import { StreamPipeline } from "./pipeline.js";
import { startBackgroundTasks } from "./tasks.js";
import { warmupStrategies, checkAccountHealth } from "./utils/market.js";

// 1. ENVIRONMENT LOAD
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

async function main() {
  // 2. INITIALIZATION LAYER
  const alpaca = new Alpaca();
  const posManager = new PositionManager(alpaca);
  const executor = new Executor(alpaca);
  const broadcaster = new Broadcaster(4000);
  const scanner = new Scanner();
  const strategies = new Map<string, any>();
  const engineState = { isKilled: false };

  // 3. BOOTSTRAP LIFECYCLE HOOKS
  await checkAccountHealth(alpaca);
  await posManager.syncPositions();
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
    engineState
  );
  pipeline.initialize();

  console.log("⚡ Automated Trading Application fully operational.");
}

main();
