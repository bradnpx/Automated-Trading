// modules/trades/trades.schema.ts
// Zod validation schemas for all trades-domain HTTP request bodies.
// Import these in the controller to validate incoming payloads before
// passing them to the service layer.

import { z } from "zod";

export const ClosePositionBodySchema = z.object({
  symbol: z
    .string({ required_error: "symbol is required" })
    .min(1, "symbol must not be empty")
    .max(10, "symbol too long")
    .toUpperCase(),
});

export type ClosePositionBody = z.infer<typeof ClosePositionBodySchema>;
