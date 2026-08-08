/**
 * sessionBootstrap.ts
 *
 * Runs once at engine startup to reconcile the active-trade log against the
 * live positions currently held at the broker.
 *
 * Why this is needed
 * ──────────────────
 * The engine may restart mid-session while Alpaca still holds open positions.
 * Without this step, the log would be empty and the dashboard would show no
 * active trades until the next buy signal fires.
 *
 * What it does
 * ────────────
 * 1. Fetches all currently open/partially-filled orders from Alpaca.
 * 2. For each order that is not already in the log (deduplication by id),
 *    it synthesises a log entry, pulling strategy/risk data from the
 *    MASTER_WATCHLIST where available and falling back to sensible defaults.
 * 3. Logs a summary so operators can confirm the reconciliation result.
 */

import Alpaca from "@alpacahq/alpaca-trade-api";
import { getActiveTrades, logActiveTrade } from "./activeTradeLogger.js";
import { MASTER_WATCHLIST } from "../config/config.js";

/**
 * Polls Alpaca for all open buy-side orders and seeds the active-trade log
 * with any entries that are not already present.
 *
 * @param alpaca  Initialised Alpaca SDK client.
 */
export async function bootstrapActiveTrades(alpaca: Alpaca): Promise<void> {
  console.log("🔄 [SESSION] Polling Alpaca for active trades to seed log...");

  try {
    // Fetch all open orders (includes partially filled)
    const openOrders = await alpaca.getOrders({
      status: "open",
      direction: "desc",
      limit: 500,
      until: undefined,
      after: undefined,
      nested: false,
      symbols: [],
    });

    const buySideOrders = openOrders.filter(
      (o: Record<string, unknown>) => o["side"] === "buy",
    );

    if (buySideOrders.length === 0) {
      console.log("ℹ️  [SESSION] No open buy orders found at session start.");
      return;
    }

    // Load existing log to avoid duplicates
    const existingTrades = await getActiveTrades();
    const existingIds = new Set(existingTrades.map((t) => t.id));

    let seeded = 0;
    for (const order of buySideOrders) {
      const orderId = String(order["id"] ?? "");
      if (existingIds.has(orderId)) continue;

      const symbol = String(order["symbol"] ?? "");
      const watchlistEntry = MASTER_WATCHLIST.get(symbol);

      const meta = {
        strategy: watchlistEntry?.strategy ?? "unknown",
        takeProfitPct: watchlistEntry?.takeProfitPct ?? 2.2,
        stopLossPct: watchlistEntry?.stopLossPct ?? 2.0,
      };

      await logActiveTrade(order as Record<string, unknown>, meta);
      seeded++;
    }

    console.log(
      `✅ [SESSION] Active trade bootstrap complete. Seeded ${seeded} new entr${seeded === 1 ? "y" : "ies"} from ${buySideOrders.length} open order${buySideOrders.length === 1 ? "" : "s"}.`,
    );
  } catch (err) {
    console.error(
      "❌ [SESSION] Failed to bootstrap active trades from Alpaca:",
      err,
    );
  }
}
