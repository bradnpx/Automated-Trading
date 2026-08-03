// services/alpaca.ts
// Centralized Alpaca SDK client factory.
// Import `createAlpacaClient` wherever the broker SDK is needed instead of
// instantiating `new Alpaca()` inline across multiple files.

import Alpaca from "@alpacahq/alpaca-trade-api";

/**
 * Returns a configured Alpaca client instance.
 * Credentials are read from the environment variables that the Alpaca SDK
 * expects by convention (APCA_API_KEY_ID, APCA_API_SECRET_KEY, etc.).
 */
export function createAlpacaClient(): Alpaca {
  return new Alpaca();
}
