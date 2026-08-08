"use client";

/**
 * useActiveTrades.ts
 *
 * Client-side polling hook that keeps the active-trade log and per-strategy
 * statistics in sync with the engine API.
 *
 * Uses the native fetch + React state pattern (no external dependencies) so
 * the hook works in the existing web app without adding new packages.
 * Swap the internals for TanStack Query if that is added to the project.
 */

import { useState, useEffect, useCallback } from "react";
import type { ActiveTradeLog, StrategyTradeStats } from "@my-platform/types";

const ENGINE_BASE_URL =
  process.env.NEXT_PUBLIC_ENGINE_API_URL ?? "http://localhost:4001";

const POLL_INTERVAL_MS = 5_000;

interface UseActiveTradesResult {
  trades: ActiveTradeLog[];
  stats: StrategyTradeStats[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useActiveTrades(): UseActiveTradesResult {
  const [trades, setTrades] = useState<ActiveTradeLog[]>([]);
  const [stats, setStats] = useState<StrategyTradeStats[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [tradesRes, statsRes] = await Promise.all([
        fetch(`${ENGINE_BASE_URL}/active-trades`, { cache: "no-store" }),
        fetch(`${ENGINE_BASE_URL}/active-trades/stats`, { cache: "no-store" }),
      ]);

      if (!tradesRes.ok || !statsRes.ok) {
        throw new Error(
          `Engine API error: trades=${tradesRes.status} stats=${statsRes.status}`,
        );
      }

      const [tradesData, statsData] = await Promise.all([
        tradesRes.json() as Promise<ActiveTradeLog[]>,
        statsRes.json() as Promise<StrategyTradeStats[]>,
      ]);

      setTrades(tradesData);
      setStats(statsData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial fetch + polling
  useEffect(() => {
    void fetchAll();
    const id = setInterval(() => void fetchAll(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchAll]);

  return { trades, stats, isLoading, error, refresh: fetchAll };
}
