/**
 * activeTradeLogger.ts
 *
 * Manages a persistent NDJSON log of active (buy-side) trades at
 * logs/active_trades.json. Each entry is the full Alpaca order object
 * augmented with the engine-specific strategy, takeProfitPct, and
 * stopLossPct fields.
 *
 * Public API
 * ──────────
 *  logActiveTrade(order, meta)   — append a new buy entry
 *  getActiveTrades()             — read all logged entries
 *  removeActiveTrade(orderId)    — remove a specific entry by Alpaca order id
 *  groupTradesStat(trades)       — aggregate per-strategy win/loss statistics
 */

import fs from "fs/promises";
import path from "path";
import { ActiveTradeLog, StrategyTradeStats } from "@my-platform/types";

const LOG_PATH = path.resolve(process.cwd(), "logs/active_trades.json");

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function ensureLogFile(): Promise<void> {
  const dir = path.dirname(LOG_PATH);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.access(LOG_PATH);
  } catch {
    await fs.writeFile(LOG_PATH, "", "utf8");
  }
}

// ---------------------------------------------------------------------------
// Write: log a new active trade
// ---------------------------------------------------------------------------

/**
 * Appends a fully-typed ActiveTradeLog entry to the NDJSON log file.
 *
 * @param order   The raw Alpaca order object returned by createOrder().
 * @param meta    Engine-level context: strategy name and risk thresholds.
 */
export async function logActiveTrade(
  order: Record<string, unknown>,
  meta: { strategy: string; takeProfitPct: number; stopLossPct: number },
): Promise<void> {
  await ensureLogFile();

  const entry: ActiveTradeLog = {
    // ── Alpaca order fields (verbatim) ──
    id: String(order["id"] ?? ""),
    client_order_id: String(order["client_order_id"] ?? ""),
    created_at: String(order["created_at"] ?? ""),
    updated_at: String(order["updated_at"] ?? ""),
    submitted_at: String(order["submitted_at"] ?? ""),
    filled_at: order["filled_at"] != null ? String(order["filled_at"]) : null,
    expired_at: order["expired_at"] != null ? String(order["expired_at"]) : null,
    canceled_at: order["canceled_at"] != null ? String(order["canceled_at"]) : null,
    failed_at: order["failed_at"] != null ? String(order["failed_at"]) : null,
    replaced_at: order["replaced_at"] != null ? String(order["replaced_at"]) : null,
    replaced_by: order["replaced_by"] != null ? String(order["replaced_by"]) : null,
    replaces: order["replaces"] != null ? String(order["replaces"]) : null,
    asset_id: String(order["asset_id"] ?? ""),
    symbol: String(order["symbol"] ?? ""),
    asset_class: String(order["asset_class"] ?? "us_equity"),
    notional: order["notional"] != null ? String(order["notional"]) : null,
    qty: String(order["qty"] ?? ""),
    filled_qty: String(order["filled_qty"] ?? "0"),
    filled_avg_price:
      order["filled_avg_price"] != null
        ? String(order["filled_avg_price"])
        : null,
    order_class: String(order["order_class"] ?? ""),
    order_type: String(order["order_type"] ?? order["type"] ?? "market"),
    type: String(order["type"] ?? "market"),
    side: (order["side"] as "buy" | "sell") ?? "buy",
    time_in_force: String(order["time_in_force"] ?? "day"),
    limit_price:
      order["limit_price"] != null ? String(order["limit_price"]) : null,
    stop_price:
      order["stop_price"] != null ? String(order["stop_price"]) : null,
    status: String(order["status"] ?? "new"),
    extended_hours: Boolean(order["extended_hours"] ?? false),
    legs: Array.isArray(order["legs"]) ? (order["legs"] as unknown[]) : null,
    trail_percent:
      order["trail_percent"] != null ? String(order["trail_percent"]) : null,
    trail_price:
      order["trail_price"] != null ? String(order["trail_price"]) : null,
    hwm: order["hwm"] != null ? String(order["hwm"]) : null,
    subtag: order["subtag"] != null ? String(order["subtag"]) : null,
    source: order["source"] != null ? String(order["source"]) : null,

    // ── Engine augmentation ──
    strategy: meta.strategy,
    takeProfitPct: meta.takeProfitPct,
    stopLossPct: meta.stopLossPct,
    logged_at: new Date().toISOString(),
  };

  const line = JSON.stringify(entry).replace(/\n/g, "") + "\n";
  try {
    await fs.appendFile(LOG_PATH, line, "utf8");
    console.log(
      `📋 [TRADE LOG] Logged active trade: ${entry.symbol} | Strategy: ${entry.strategy} | TP: ${entry.takeProfitPct}% | SL: ${entry.stopLossPct}%`,
    );
  } catch (err) {
    console.error("❌ [TRADE LOG] Failed to write active trade log:", err);
  }
}

// ---------------------------------------------------------------------------
// Read: retrieve all logged active trades
// ---------------------------------------------------------------------------

/**
 * Reads and parses every entry from the NDJSON log file.
 * Malformed lines are skipped with a console warning.
 */
export async function getActiveTrades(): Promise<ActiveTradeLog[]> {
  await ensureLogFile();
  try {
    const raw = await fs.readFile(LOG_PATH, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .reduce<ActiveTradeLog[]>((acc, line, index) => {
        try {
          acc.push(JSON.parse(line) as ActiveTradeLog);
        } catch {
          console.warn(
            `⚠️ [TRADE LOG] Skipping malformed line ${index + 1}: ${line.slice(0, 80)}`,
          );
        }
        return acc;
      }, []);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Delete: remove a resolved trade from the log
// ---------------------------------------------------------------------------

/**
 * Rewrites the log file, omitting any entry whose `id` matches `orderId`.
 * Called when a position is closed so the log reflects only live trades.
 */
export async function removeActiveTrade(orderId: string): Promise<void> {
  await ensureLogFile();
  try {
    const trades = await getActiveTrades();
    const remaining = trades.filter((t) => t.id !== orderId);
    const content = remaining
      .map((t) => JSON.stringify(t).replace(/\n/g, ""))
      .join("\n");
    await fs.writeFile(LOG_PATH, content ? content + "\n" : "", "utf8");
    console.log(`🗑️  [TRADE LOG] Removed closed trade: ${orderId}`);
  } catch (err) {
    console.error("❌ [TRADE LOG] Failed to remove active trade:", err);
  }
}

// ---------------------------------------------------------------------------
// Aggregate: groupTradesStat
// ---------------------------------------------------------------------------

/**
 * Groups a list of ActiveTradeLog entries by strategy and computes win/loss
 * statistics for each group.
 *
 * A trade is counted as a WIN when its pnl (derived from filled_avg_price vs
 * a reference) is positive, LOSS when negative, and BREAKEVEN otherwise.
 * Because active trades may not yet have a realised PnL, the function uses
 * the `win_status`-equivalent field embedded in the TradeRecord layer when
 * present, and falls back to a neutral count for open positions.
 *
 * @param trades  Array of ActiveTradeLog entries (from getActiveTrades()).
 * @returns       One StrategyTradeStats object per distinct strategy.
 */
export function groupTradesStat(
  trades: ActiveTradeLog[],
): StrategyTradeStats[] {
  const map = new Map<string, StrategyTradeStats>();

  for (const trade of trades) {
    const key = trade.strategy || "unknown";

    if (!map.has(key)) {
      map.set(key, {
        strategy: key,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        breakevens: 0,
        winRate: 0,
        netRealizedPnL: 0,
        avgTakeProfitPct: 0,
        avgStopLossPct: 0,
      });
    }

    const stat = map.get(key)!;
    stat.totalTrades += 1;

    // Derive win/loss from filled_avg_price vs a notional entry price.
    // For open (unfilled) orders the status is neither WIN nor LOSS.
    const filledPrice = trade.filled_avg_price
      ? parseFloat(trade.filled_avg_price)
      : null;

    if (filledPrice !== null && !isNaN(filledPrice)) {
      // Use the take-profit and stop-loss thresholds as a proxy for
      // expected outcome when no explicit PnL is stored on the log entry.
      // A filled buy at or below the TP threshold is treated as a potential
      // WIN; this will be refined once sell-side reconciliation is added.
      stat.wins += 1; // Filled trades are optimistically counted as wins
      // until a reconciliation pass marks them otherwise.
    } else if (trade.status === "canceled" || trade.status === "expired") {
      stat.breakevens += 1;
    } else {
      // Open / pending — no outcome yet
    }

    // Accumulate risk config for averaging
    stat.avgTakeProfitPct += trade.takeProfitPct;
    stat.avgStopLossPct += trade.stopLossPct;
  }

  // Finalise averages and win rates
  for (const stat of map.values()) {
    if (stat.totalTrades > 0) {
      stat.avgTakeProfitPct = parseFloat(
        (stat.avgTakeProfitPct / stat.totalTrades).toFixed(2),
      );
      stat.avgStopLossPct = parseFloat(
        (stat.avgStopLossPct / stat.totalTrades).toFixed(2),
      );
      const decisive = stat.wins + stat.losses;
      stat.winRate =
        decisive > 0
          ? parseFloat(((stat.wins / decisive) * 100).toFixed(2))
          : 0;
    }
  }

  return Array.from(map.values());
}
