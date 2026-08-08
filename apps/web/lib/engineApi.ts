/**
 * engineApi.ts
 *
 * Typed fetch helpers for the engine's REST API (port 4001).
 * All functions are safe to call from both Server Components and Client
 * Components — they perform plain fetch() calls with no browser-only APIs.
 */

import type { ActiveTradeLog, StrategyTradeStats } from "@my-platform/types";

const ENGINE_BASE_URL =
  process.env.NEXT_PUBLIC_ENGINE_API_URL ?? "http://localhost:4001";

// ---------------------------------------------------------------------------
// Active trades
// ---------------------------------------------------------------------------

/**
 * Fetches every entry currently in the active-trade log.
 * Returns an empty array on error so the UI degrades gracefully.
 */
export async function fetchActiveTrades(): Promise<ActiveTradeLog[]> {
  try {
    const res = await fetch(`${ENGINE_BASE_URL}/active-trades`, {
      // Always fetch fresh data — this is a live trading dashboard.
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(
        `[engineApi] GET /active-trades failed: ${res.status} ${res.statusText}`,
      );
      return [];
    }
    return (await res.json()) as ActiveTradeLog[];
  } catch (err) {
    console.error("[engineApi] fetchActiveTrades network error:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Strategy stats
// ---------------------------------------------------------------------------

/**
 * Fetches per-strategy aggregated statistics from the engine.
 * Returns an empty array on error.
 */
export async function fetchStrategyStats(): Promise<StrategyTradeStats[]> {
  try {
    const res = await fetch(`${ENGINE_BASE_URL}/active-trades/stats`, {
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(
        `[engineApi] GET /active-trades/stats failed: ${res.status} ${res.statusText}`,
      );
      return [];
    }
    return (await res.json()) as StrategyTradeStats[];
  } catch (err) {
    console.error("[engineApi] fetchStrategyStats network error:", err);
    return [];
  }
}
