import assert from "node:assert/strict";

import {
  MASTER_WATCHLIST,
  TRADE_LOG_SYNC_INTERVAL_HOURS,
  TRAILING_STOP_LOSS_ENABLED,
} from "./config.js";

assert.equal(
  TRAILING_STOP_LOSS_ENABLED,
  true,
  "TRAILING_STOP_LOSS=true must enable the global trailing-stop behavior",
);

assert.equal(MASTER_WATCHLIST.size, 0);
assert.equal(
  TRADE_LOG_SYNC_INTERVAL_HOURS,
  24,
  "The trade-log sync interval defaults to 24 hours",
);
console.log("Trailing-stop environment configuration verification passed.");
