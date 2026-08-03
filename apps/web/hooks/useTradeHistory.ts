// hooks/useTradeHistory.ts
// TanStack Query hook for fetching trade history from the engine REST API.
// Provides automatic background refetching, loading, and error states.
//
// Usage in a Client Component:
//   const { data, isLoading, error } = useTradeHistory();

"use client";

import { useQuery } from "@tanstack/react-query";
import { engineClient } from "@/lib/engine-client";
import type { TradeRecord } from "@/types/dashboard";

export const TRADE_HISTORY_QUERY_KEY = ["trade-history"] as const;

export function useTradeHistory() {
  return useQuery<TradeRecord[], Error>({
    queryKey: TRADE_HISTORY_QUERY_KEY,
    queryFn: () => engineClient.getHistory(),
    // Refetch every 30 seconds so the table stays reasonably fresh
    // without hammering the engine on every render.
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}
