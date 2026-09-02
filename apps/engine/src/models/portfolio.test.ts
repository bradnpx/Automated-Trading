import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Portfolio } from "./portfolio.js";

async function run(): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "portfolio-test-"),
  );
  const portfolio = new Portfolio(
    path.join(temporaryDirectory, "portfolio.json"),
  );

  await portfolio.syncTrades([
    {
      symbol: "AAPL",
      asset_id: "asset-aapl",
      qty: "10",
      avg_entry_price: "100",
      current_price: "100",
    },
  ]);

  const freshMarkTimestamp = new Date().toISOString();
  assert.equal(portfolio.updateMark("AAPL", 102.5, freshMarkTimestamp), true);
  assert.equal(
    portfolio.updateMark("MISSING", 102.5, freshMarkTimestamp),
    false,
  );

  const afterStreamMark = portfolio.getPosition("AAPL");
  assert.ok(afterStreamMark);
  assert.equal(afterStreamMark.current_price, "102.5");
  assert.equal(afterStreamMark.market_value, "1025");
  assert.equal(afterStreamMark.unrealized_pl, "25");
  assert.equal(afterStreamMark.unrealized_plpc, "0.025");

  await portfolio.syncTrades([
    {
      symbol: "AAPL",
      asset_id: "asset-aapl",
      qty: "10",
      avg_entry_price: "100",
      current_price: "100.5",
    },
  ]);

  const afterBrokerReconciliation = portfolio.getPosition("AAPL");
  assert.ok(afterBrokerReconciliation);
  assert.equal(
    afterBrokerReconciliation.current_price,
    "102.5",
    "A fresh stream mark must not be replaced by an older broker mark.",
  );

  await portfolio.syncTrades([]);
  assert.equal(portfolio.getPositions().length, 0);

  console.log("Portfolio synchronization verification passed.");
}

void run();
