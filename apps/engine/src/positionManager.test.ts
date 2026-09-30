import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MASTER_WATCHLIST } from "./config/config.js";
import { PositionManager } from "./positionManager.js";

async function run(): Promise<void> {
  await testTrailingTakeProfitSellsHalf();
  await testDefaultTakeProfitSellsAll();
  console.log("Position exit verification passed.");
}

async function testTrailingTakeProfitSellsHalf(): Promise<void> {
  const manager = await createPositionManager();
  MASTER_WATCHLIST.set("TEST", {
    symbol: "TEST",
    strategy: "testStrategy",
    stopLossPct: 2,
    takeProfitPct: 5,
    trailingStopLoss: true,
  });

  try {
    const decision = manager.checkExitConditions("TEST", 105);
    assert.equal(decision.shouldExit, true);
    assert.equal(decision.action, "take-profit-half");
    assert.equal(decision.entryPrice, 100);
    assert.equal(decision.quantity, 10);

    manager.beginTrailingStop("TEST", 100);
    const protectedDecision = manager.checkExitConditions("TEST", 110);
    assert.equal(protectedDecision.shouldExit, false);
    assert.equal(protectedDecision.action, "none");
  } finally {
    MASTER_WATCHLIST.delete("TEST");
  }
}

async function testDefaultTakeProfitSellsAll(): Promise<void> {
  const manager = await createPositionManager();
  MASTER_WATCHLIST.set("TEST", {
    symbol: "TEST",
    strategy: "testStrategy",
    stopLossPct: 2,
    takeProfitPct: 5,
  });

  try {
    const decision = manager.checkExitConditions("TEST", 105);
    assert.equal(decision.shouldExit, true);
    assert.equal(decision.action, "close-position");
  } finally {
    MASTER_WATCHLIST.delete("TEST");
  }
}

async function createPositionManager(): Promise<PositionManager> {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "position-manager-test-"),
  );
  process.env.PORTFOLIO_STATE_PATH = path.join(
    temporaryDirectory,
    "portfolio.json",
  );
  const manager = new PositionManager({
    async getPositions() {
      return [
        {
          symbol: "TEST",
          qty: "10",
          avg_entry_price: "100",
          current_price: "100",
        },
      ];
    },
    async getOrders() {
      return [];
    },
  } as never);

  await manager.syncPositions();
  return manager;
}

void run().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : "Unknown error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
