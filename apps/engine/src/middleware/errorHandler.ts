// middleware/errorHandler.ts
// Global Express error-handling middleware.
// Must be registered LAST in the Express app (after all routes) so that
// errors thrown or passed via `next(err)` anywhere in the stack are caught
// here and formatted into a consistent JSON response.

import { Request, Response, NextFunction } from "express";

interface HttpError extends Error {
  status?: number;
  statusCode?: number;
}

/**
 * Catches all unhandled errors propagated via `next(err)` or thrown inside
 * async route handlers (when wrapped with an async error boundary).
 *
 * Response shape:
 *   { error: string, ...(stack in development) }
 */
export function errorHandler(
  err: HttpError,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  const status = err.status ?? err.statusCode ?? 500;
  const message = err.message || "Internal Server Error";

  console.error(`❌ [ERROR] ${status} — ${message}`, err.stack ?? "");

  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  });
}
