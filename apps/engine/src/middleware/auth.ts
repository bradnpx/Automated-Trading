// middleware/auth.ts
// JWT / session validation middleware.
// Attach this to any Express route that requires authentication.
// Currently a passthrough stub — replace with real JWT verification
// (e.g. jsonwebtoken) before exposing the API to untrusted networks.

import { Request, Response, NextFunction } from "express";

/**
 * Validates the Authorization header and attaches the decoded payload to
 * `req.user`. Returns 401 if the token is missing or invalid.
 *
 * TODO: Replace the stub with real JWT verification:
 *   import jwt from "jsonwebtoken";
 *   const payload = jwt.verify(token, process.env.JWT_SECRET!);
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    // In development (local) mode, skip auth so the engine can be tested
    // without a token. Remove this bypass before deploying to production.
    if (process.env.NODE_ENV !== "production") {
      return next();
    }
    res.status(401).json({ error: "Unauthorized: missing Bearer token" });
    return;
  }

  // TODO: verify token and attach decoded payload to req
  next();
}
