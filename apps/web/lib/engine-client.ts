// lib/engine-client.ts
// Typed HTTP client for the trading engine's REST API (port 4001).
// All dashboard Server Actions and API routes should use these helpers
// rather than calling fetch() directly, to keep the base URL and error
// handling in one place.

const ENGINE_BASE_URL =
  process.env.NEXT_PUBLIC_ENGINE_URL ?? "http://localhost:4001";

async function engineFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${ENGINE_BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Engine API error: ${res.status}`,
    );
  }

  return res.json() as Promise<T>;
}

import type { TradeRecord } from "@/types/dashboard";

export const engineClient = {
  /** Fetch trade history (most recent first). */
  getHistory: () => engineFetch<TradeRecord[]>("/history"),

  /** Resume the engine after a kill. */
  reset: () =>
    engineFetch<{ message: string }>("/reset", { method: "POST" }),

  /** Emergency kill: cancel all orders and close all positions. */
  panic: () =>
    engineFetch<{ message: string }>("/panic", { method: "POST" }),

  /** Manually close a single position by symbol. */
  closePosition: (symbol: string) =>
    engineFetch<{ message: string }>("/close", {
      method: "POST",
      body: JSON.stringify({ symbol }),
    }),
};
