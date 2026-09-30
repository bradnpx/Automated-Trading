import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Portfolio } from "./portfolio.js";

async function run(): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "portfolio-lifecycle-test-"),
  );
  const filepath = path.join(temporaryDirectory, "portfolio.json");
  const portfolio = new Portfolio(filepath);
  await portfolio.initialize();

  const firstFillAt = "2026-09-03T14:30:00.000Z";
  const secondFillAt = "2026-09-03T14:30:01.000Z";
  await portfolio.applyTradeUpdate(
    {
      event: "partial_fill",
      execution_id: "buy-fill-1",
      timestamp: firstFillAt,
      price: "100",
      qty: "4",
      order: {
        id: "buy-order-1",
        symbol: "AAPL",
        side: "buy",
        status: "partially_filled",
        qty: "10",
        filled_qty: "4",
      },
    },
    "dayTradeMicroScalp",
  );
  await portfolio.applyTradeUpdate(
    {
      event: "fill",
      execution_id: "buy-fill-2",
      timestamp: secondFillAt,
      price: "102",
      qty: "6",
      order: {
        id: "buy-order-1",
        symbol: "AAPL",
        side: "buy",
        status: "filled",
        qty: "10",
        filled_qty: "10",
        filled_at: secondFillAt,
      },
    },
    "dayTradeMicroScalp",
  );

  const duplicate = await portfolio.applyTradeUpdate({
    event: "fill",
    execution_id: "buy-fill-2",
    timestamp: secondFillAt,
    price: "102",
    qty: "6",
    order: {
      id: "buy-order-1",
      symbol: "AAPL",
      side: "buy",
      status: "filled",
      qty: "10",
      filled_qty: "10",
      filled_at: secondFillAt,
    },
  });
  assert.equal(duplicate?.changed, false);

  await portfolio.syncTrades([
    {
      symbol: "AAPL",
      asset_id: "asset-aapl",
      qty: "10",
      avg_entry_price: "101.2",
      current_price: "101.5",
    },
  ]);
  assert.equal(
    portfolio.updateMark("AAPL", 104, new Date(Date.now() + 1_000).toISOString()),
    true,
  );

  const openTrade = portfolio.getOpenTrade("AAPL");
  assert.ok(openTrade);
  assert.equal(openTrade.openedAt, firstFillAt);
  assert.equal(openTrade.strategy, "dayTradeMicroScalp");
  assert.equal(openTrade.entryQuantity, 10);
  assert.equal(openTrade.remainingQuantity, 10);
  assert.equal(openTrade.averageEntryPrice, 101.2);
  assert.equal(openTrade.highWaterMark, 104);

  const firstExitAt = "2026-09-03T14:31:00.000Z";
  await portfolio.applyTradeUpdate({
    event: "partial_fill",
    execution_id: "sell-fill-1",
    timestamp: firstExitAt,
    price: "106",
    qty: "5",
    order: {
      id: "sell-order-1",
      symbol: "AAPL",
      side: "sell",
      status: "partially_filled",
      qty: "10",
      filled_qty: "5",
    },
  });
  assert.equal(portfolio.getOpenTrade("AAPL")?.remainingQuantity, 5);

  const finalExitAt = "2026-09-03T14:31:02.000Z";
  await portfolio.applyTradeUpdate({
    event: "fill",
    execution_id: "sell-fill-2",
    timestamp: finalExitAt,
    price: "108",
    qty: "5",
    order: {
      id: "sell-order-1",
      symbol: "AAPL",
      side: "sell",
      status: "filled",
      qty: "10",
      filled_qty: "10",
      filled_at: finalExitAt,
    },
  });

  assert.equal(portfolio.getOpenTrade("AAPL"), undefined);
  const [closedTrade] = portfolio.getClosedTrades();
  assert.ok(closedTrade);
  assert.equal(closedTrade.openedAt, firstFillAt);
  assert.equal(closedTrade.closedAt, finalExitAt);
  assert.equal(closedTrade.exitQuantity, 10);
  assert.equal(closedTrade.averageExitPrice, 107);
  assert.equal(closedTrade.realizedPnl, 58);
  assert.equal(closedTrade.closeSource, "broker_event");

  await portfolio.syncTrades([]);
  assert.equal(portfolio.getClosedTrades().length, 1);

  const persisted = JSON.parse(await readFile(filepath, "utf8"));
  assert.equal(persisted.version, 2);
  assert.equal(persisted.closedTrades.length, 1);

  const restoredPortfolio = new Portfolio(filepath);
  await restoredPortfolio.initialize();
  assert.equal(restoredPortfolio.getClosedTrades().length, 1);
  assert.equal(restoredPortfolio.getOrders().length, 2);

  console.log("Portfolio lifecycle verification passed.");
}

void run();
