import assert from "node:assert/strict";

import { formatHistory, getStats } from "./fetchTradeHistory.js";

const lifecyclePayload = {
  lifecycles: [
    {
      id: "trade:aapl-entry",
      symbol: "AAPL",
      profile: { strategy: "bullFlagMomentum" },
      entryFills: [
        {
          executionId: "aapl-buy-execution",
          orderId: "aapl-buy-order",
          orderType: "market",
          side: "buy",
          price: 100,
          quantity: 10,
          filledAt: "2026-10-08T13:00:00.000Z",
        },
      ],
      exitFills: [
        {
          executionId: "aapl-take-profit-execution",
          orderId: "aapl-take-profit-order",
          orderType: "limit",
          side: "sell",
          price: 110,
          quantity: 5,
          filledAt: "2026-10-08T13:05:00.000Z",
          reason: "TAKE_PROFIT_HALF",
        },
        {
          executionId: "aapl-trailing-stop-execution",
          orderId: "aapl-trailing-stop-order",
          orderType: "trailing_stop",
          side: "sell",
          price: 105,
          quantity: 5,
          filledAt: "2026-10-08T13:10:00.000Z",
          reason: "TRAILING_STOP_LOSS",
        },
      ],
    },
  ],
  records: [
    {
      symbol: "AAPL",
      side: "buy",
      qty: "10",
      price: "100",
      timestamp: "2026-10-08T13:00:00.000Z",
      lifecycle_id: "trade:aapl-entry",
      order_id: "aapl-buy-order",
      execution_id: "aapl-buy-execution",
      order_type: "market",
      strategy: "bullFlagMomentum",
      reason: "bullFlagMomentum",
    },
    {
      symbol: "AAPL",
      side: "sell",
      qty: "5",
      price: "110",
      timestamp: "2026-10-08T13:05:00.000Z",
      lifecycle_id: "trade:aapl-entry",
      order_id: "aapl-take-profit-order",
      execution_id: "aapl-take-profit-execution",
      order_type: "limit",
      reason: "TAKE_PROFIT_HALF",
    },
    {
      symbol: "AAPL",
      side: "sell",
      qty: "5",
      price: "105",
      timestamp: "2026-10-08T13:10:00.000Z",
      lifecycle_id: "trade:aapl-entry",
      order_id: "aapl-trailing-stop-order",
      execution_id: "aapl-trailing-stop-execution",
      order_type: "trailing_stop",
      reason: "TRAILING_STOP_LOSS",
    },
  ],
};

const legacyPayload = {
  lifecycles: [],
  records: [
    {
      symbol: "AAPL",
      side: "buy",
      qty: "4",
      price: "100",
      timestamp: "2026-10-08T14:00:00.000Z",
      order_id: "legacy-entry-1",
      strategy: "dayTradeMicroScalp",
      reason: "dayTradeMicroScalp",
    },
    {
      symbol: "AAPL",
      side: "sell",
      qty: "2",
      price: "102",
      timestamp: "2026-10-08T14:01:00.000Z",
      order_id: "legacy-exit-1a",
      reason: "TAKE_PROFIT_HALF",
    },
    {
      symbol: "AAPL",
      side: "sell",
      qty: "2",
      price: "103",
      timestamp: "2026-10-08T14:02:00.000Z",
      order_id: "legacy-exit-1b",
      reason: "TRAILING_STOP_LOSS",
    },
    {
      symbol: "AAPL",
      side: "buy",
      qty: "3",
      price: "120",
      timestamp: "2026-10-08T14:03:00.000Z",
      order_id: "legacy-entry-2",
      strategy: "dayTradeMicroScalp",
      reason: "dayTradeMicroScalp",
    },
  ],
};

const linkedHistory = formatHistory(lifecyclePayload);
assert.equal(linkedHistory.groupedTrades.length, 1);
const [linkedTrade] = linkedHistory.groupedTrades;
assert.equal(linkedTrade.status, "closed");
assert.equal(linkedTrade.qty, 10);
assert.equal(linkedTrade.exitedQty, 10);
assert.equal(linkedTrade.pnl, 75);
assert.equal(linkedTrade.orders.length, 3);
assert.equal(
  linkedTrade.orders.filter((order) => order.side === "sell").length,
  2,
);

const legacyHistory = formatHistory(legacyPayload);
assert.equal(legacyHistory.groupedTrades.length, 2);
const [latestLegacyTrade, firstLegacyTrade] = legacyHistory.groupedTrades;
assert.equal(firstLegacyTrade.status, "closed");
assert.equal(firstLegacyTrade.qty, 4);
assert.equal(firstLegacyTrade.exitedQty, 4);
assert.equal(firstLegacyTrade.pnl, 10);
assert.equal(firstLegacyTrade.orders.length, 3);
assert.equal(latestLegacyTrade.status, "open");
assert.equal(latestLegacyTrade.qty, 3);
assert.equal(latestLegacyTrade.exitedQty, 0);
assert.equal(latestLegacyTrade.orders.length, 1);

const stats = getStats(linkedHistory.groupedTrades, "none", 0);
assert.equal(stats.totalTrades, 1);
assert.equal(stats.winRate, 1);
assert.equal(stats.dailyPnL, 75);
console.log("Dashboard ledger reconciliation verification passed.");
