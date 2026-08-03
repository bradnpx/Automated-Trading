// lib/api-response.ts
// Standardized API response helpers for Next.js Server Actions and API routes.
// All async server-side operations should be wrapped with `withApiHandler` to
// ensure consistent error formatting across the dashboard.

import { NextResponse } from "next/server";

export interface ApiSuccess<T> {
  data: T;
  error: null;
}

export interface ApiError {
  data: null;
  error: string;
}

export type ApiResult<T> = ApiSuccess<T> | ApiError;

/**
 * Wraps a Next.js Route Handler in a try/catch and returns a consistent
 * JSON response shape: `{ data, error }`.
 *
 * Usage:
 *   export const GET = withApiHandler(async () => {
 *     const data = await fetchSomething();
 *     return data;
 *   });
 */
export function withApiHandler<T>(
  handler: () => Promise<T>,
): () => Promise<NextResponse<ApiResult<T>>> {
  return async () => {
    try {
      const data = await handler();
      return NextResponse.json({ data, error: null });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "An unexpected error occurred";
      console.error("[API Error]", message);
      return NextResponse.json({ data: null, error: message }, { status: 500 });
    }
  };
}

/**
 * Wraps a Server Action in a try/catch and returns a consistent result shape.
 *
 * Usage:
 *   const result = await withServerAction(() => closePosition(symbol));
 */
export async function withServerAction<T>(
  action: () => Promise<T>,
): Promise<ApiResult<T>> {
  try {
    const data = await action();
    return { data, error: null };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "An unexpected error occurred";
    return { data: null, error: message };
  }
}
