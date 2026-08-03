// hooks/useEngineActions.ts
// TanStack Query mutation hooks for engine control actions.
// Each mutation handles optimistic state, error toasts, and cache invalidation.
//
// Usage:
//   const { mutate: panic, isPending } = usePanic();
//   const { mutate: reset } = useReset();
//   const { mutate: close } = useClosePosition();

"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { engineClient } from "@/lib/engine-client";
import { TRADE_HISTORY_QUERY_KEY } from "./useTradeHistory";

/** Emergency kill switch — cancels all orders and closes all positions. */
export function usePanic() {
  return useMutation({
    mutationFn: () => engineClient.panic(),
    onError: (err: Error) => {
      console.error("[PANIC] Failed:", err.message);
    },
  });
}

/** Resume the engine after a kill. */
export function useReset() {
  return useMutation({
    mutationFn: () => engineClient.reset(),
    onError: (err: Error) => {
      console.error("[RESET] Failed:", err.message);
    },
  });
}

/** Manually close a single position and invalidate trade history cache. */
export function useClosePosition() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (symbol: string) => engineClient.closePosition(symbol),
    onSuccess: () => {
      // Invalidate history so the table refreshes after a manual close
      queryClient.invalidateQueries({ queryKey: TRADE_HISTORY_QUERY_KEY });
    },
    onError: (err: Error) => {
      console.error("[CLOSE] Failed:", err.message);
    },
  });
}
