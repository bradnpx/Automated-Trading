// services/polygon.ts
// Centralized Polygon.io REST client factory.
// All modules that need Polygon data should import `getPolygonClient()`
// from here rather than constructing their own instances.

import { restClient } from "@polygon.io/client-js";
import { POLYGON_API } from "../config/config.js";

let _client: ReturnType<typeof restClient> | null = null;

/**
 * Returns a singleton Polygon REST client.
 * Throws at call-time (not import-time) if the API key is missing, so that
 * the engine can boot and log a clear error rather than crashing silently.
 */
export function getPolygonClient(): ReturnType<typeof restClient> {
  if (_client) return _client;

  if (!POLYGON_API) {
    throw new Error(
      "Polygon API key is not configured. Set POLYGON_API_KEY in your .env file.",
    );
  }

  _client = restClient(POLYGON_API);
  return _client;
}
