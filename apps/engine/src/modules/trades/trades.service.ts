// modules/trades/trades.service.ts
// Business logic and data transformations for the trades domain.
// The controller delegates all non-routing work here, keeping HTTP
// concerns strictly out of this layer.

import { TradeRecord } from "@my-platform/types";
import { getTradeHistory } from "../../middleware/logger.js";
import { PositionManager } from "../../positionManager.js";
import { Executor } from "../../executor.js";
import { Broadcaster } from "../../broadcaster.js";
import { EngineState } from "./trades.types.js";

export class TradesService {
  constructor(
    private readonly posManager: PositionManager,
    private readonly executor: Executor,
    private readonly broadcaster: Broadcaster,
    private readonly engineState: EngineState,
  ) {}

  async getHistory(): Promise<TradeRecord[]> {
    const history = await getTradeHistory();
    return history.reverse();
  }

  async resetEngine(): Promise<void> {
    this.engineState.isKilled = false;
    this.broadcaster.broadcastStatus("ACTIVE");
    await this.posManager.syncPositions();
    console.log("♻️  RESET INITIATED: Restoring engine functionality...");
  }

  async panicKill(): Promise<{ success: boolean; error?: unknown }> {
    this.engineState.isKilled = true;
    this.broadcaster.broadcastStatus("KILLED");
    return this.executor.killEverything();
  }

  async closePosition(symbol: string): Promise<void> {
    if (this.posManager.hasPendingExit(symbol)) {
      throw new ConflictError(`Close already in progress for ${symbol}`);
    }

    this.posManager.markPendingExit(symbol);

    try {
      await this.executor.closePosition(symbol);
      this.broadcaster.broadcastSignal({
        symbol,
        action: "SELL",
        confidence: 1,
        reason: "Manual close from dashboard",
      });
      console.log(`🔴 Manually closed position: ${symbol}`);
      // Lock is cleared by onOrderUpdate on fill confirmation.
      await this.posManager.syncPositions();
    } catch (err) {
      // Release the lock so the position can be retried.
      this.posManager.clearPendingExit(symbol);
      throw err;
    }
  }
}

/** Thrown when an operation conflicts with in-flight state (HTTP 409). */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
