import assert from "node:assert/strict";

import { MASTER_WATCHLIST, TRAILING_STOP_LOSS_ENABLED } from "./config.js";

assert.equal(
  TRAILING_STOP_LOSS_ENABLED,
  true,
  "TRAILING_STOP_LOSS=true must enable the global trailing-stop behavior",
);

assert.equal(MASTER_WATCHLIST.size, 0);
console.log("Trailing-stop environment configuration verification passed.");
