import assert from "node:assert/strict";

import { getStats } from "./fetchTradeHistory.js";

const trades = [
  {
    id: "trade:entry-1",
    symbol: "TEST",
    strategy: "bullFlagMomentum",
    status: "closed" as const,
    priceOpen: 10,
    priceClose: 10.75,
    pnl: 75,
    pnlPct: 0.075,
    qty: 100,
    exitedQty: 100,
    remainingQty: 0,
    isWinner: true,
    openedOn: "2026-09-24T14:00:00.000Z",
    closedOn: "2026-09-24T14:05:00.000Z",
    exits: [
      {
        orderId: "order-take-profit",
        orderType: "limit",
        reason: "TAKE_PROFIT_HALF",
        quantity: 50,
        price: 11,
        filledAt: "2026-09-24T14:02:00.000Z",
      },
      {
        orderId: "order-trailing-stop",
        orderType: "trailing_stop",
        reason: "TRAILING_STOP_LOSS",
        quantity: 50,
        price: 10.5,
        filledAt: "2026-09-24T14:05:00.000Z",
      },
    ],
  },
];

const stats = getStats(trades, "none", 0);
assert.equal(stats.totalTrades, 1);
assert.equal(stats.winRate, 1);
assert.equal(stats.dailyPnL, 75);
assert.equal(trades[0].exits.length, 2);
console.log("Dashboard lifecycle aggregation verification passed.");
