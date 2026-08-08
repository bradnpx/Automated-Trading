"use client";

/**
 * ActiveTradesDashboard
 *
 * Client-side container that:
 *  1. Polls the engine API every 5 s via useActiveTrades()
 *  2. Renders the ActiveTradesTable (live log entries)
 *  3. Renders the StrategyStatsPanel (groupTradesStat output per strategy)
 *
 * This is the only component in the active-trades feature that holds state.
 * ActiveTradesTable and StrategyStatsPanel are pure presentational components.
 */

import { useActiveTrades } from "@/hooks/useActiveTrades";
import { ActiveTradesTable } from "./ActiveTradesTable";
import { StrategyStatsPanel } from "./StrategyStatsPanel";

export function ActiveTradesDashboard() {
  const { trades, stats, isLoading, error, refresh } = useActiveTrades();

  return (
    <div className="space-y-8">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Active Trades</h1>
          <p className="mt-1 text-sm text-gray-500">
            Live buy-side positions enriched with strategy and risk metadata.
            Refreshes every 5 s.
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={isLoading}
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50 disabled:opacity-50"
        >
          {isLoading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* ── Error banner ── */}
      {error !== null && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <strong>Engine connection error:</strong> {error}
        </div>
      )}

      {/* ── Strategy Statistics ── */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-gray-800">
          Strategy Statistics
        </h2>
        {isLoading && stats.length === 0 ? (
          <p className="text-sm text-gray-400">Loading statistics…</p>
        ) : (
          <StrategyStatsPanel stats={stats} />
        )}
      </section>

      {/* ── Active Trade Log ── */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-gray-800">
          Active Trade Log
        </h2>
        {isLoading && trades.length === 0 ? (
          <p className="text-sm text-gray-400">Loading trades…</p>
        ) : (
          <ActiveTradesTable trades={trades} />
        )}
      </section>
    </div>
  );
}
