// modules/trades/index.ts
export { createTradesRouter } from "./trades.controller.js";
export { TradesService, ConflictError } from "./trades.service.js";
export type { EngineState, OpenPosition, ClosePositionRequest } from "./trades.types.js";
