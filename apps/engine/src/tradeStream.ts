import Alpaca from "@alpacahq/alpaca-trade-api";
import { PositionManager } from "./positions.js";
import { Broadcaster } from "./broadcaster.js";
import { logTrade, getTradeHistory } from "./logger.js";

const alpaca = new Alpaca();
const posManager = new PositionManager(alpaca);
const broadcaster = new Broadcaster(4000);

const tradeStream = alpaca.trade_ws;
// Setup Trade Stream
tradeStream.onConnect(() => {
  console.log("🤝 Trade WebSocket: Connected");
});

// Listen for execution fills
tradeStream.onOrderUpdate(async (data: any) => {
  console.log("DEBUG: Raw Trade Update Keys:", Object.keys(data));
  if (data.order)
    console.log("DEBUG: Order Object Keys:", Object.keys(data.order));

  const { event, order, price, fillQty } = data;

  // Only log when we get a 'fill' (or 'partial_fill')
  if (event === "fill" || event === "partial_fill") {
    const fillPrice = parseFloat(price || order.filled_avg_price || 0);
    const qty = parseFloat(fillQty || order.filled_qty || 0);

    if (fillPrice === 0) {
      console.warn(
        `⚠️ Warning: Fill price is 0 for ${order.symbol}. Check raw data:`,
        data,
      );
      return;
    }

    console.log(`✅ EXECUTION: ${order.symbol} filled @ $${fillPrice}`);

    // Calculate PnL relative to your position manager's average entry
    const pos = posManager
      .getPositions()
      .find((p) => p.symbol === order.symbol);
    const entry = pos ? parseFloat(pos.avg_entry_price) : 0;

    let pnl = 0;
    let pnlPct = 0;

    if (order.side === "sell" && entry > 0) {
      pnl = (fillPrice - entry) * qty;
      pnlPct = (fillPrice - entry) / entry;
    }

    // LOG THE TRADE
    await logTrade({
      symbol: order.symbol,
      side: order.side.toUpperCase(),
      qty: qty.toString(),
      price: fillPrice.toString(),
      pnl: pnl,
      pnl_pct: pnlPct,
      timestamp: new Date().toISOString(),
      reason: order.side === "sell" ? "Exit" : "Entry",
    });

    // Update the dashboard UI
    await posManager.syncPositions();
    broadcaster.broadcastPortfolio(posManager.getPositions());
  }
});

// tradeStream.onOrderUpdate(async (data: any) => {
//   console.log("DEBUG: Raw Trade Update Keys:", Object.keys(data));
//   if (data.order)
//     console.log("DEBUG: Order Object Keys:", Object.keys(data.order));
//   // ...
//   const { event, order, price } = data;

//   if (event === "fill" || event === "partial_fill") {
//     const executionPrice = parseFloat(price || order.filled_avg_price || 0);

//     if (executionPrice === 0) {
//       console.warn(
//         `⚠️ Warning: Received a fill for ${order.symbol} but price is still 0/null.`,
//       );
//       console.log(
//         "Full Data Payload for debugging:",
//         JSON.stringify(data, null, 2),
//       );
//       return;
//     }

//     const qty = parseFloat(order.filled_qty || data.qty);
//     console.log(`✅ REAL FILL: ${order.symbol} @ $${executionPrice}`);

//     await logTrade({
//       symbol: order.symbol,
//       side: order.side.toUpperCase(),
//       qty: qty.toString(),
//       price: executionPrice.toString(),
//       pnl: 0,
//       pnl_pct: 0,
//       timestamp: new Date().toISOString(),
//       reason: order.side === "sell" ? "Exit" : "Entry",
//     });
//   }
// })
tradeStream.connect();
