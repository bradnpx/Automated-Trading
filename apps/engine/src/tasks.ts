// src/tasks.ts

export function startBackgroundTasks(
  alpaca: any,
  posManager: any,
  broadcaster: any,
  executor: any,
) {
  /**
   * Reconciles local memory with the broker's truth to catch any missed WebSocket events.
   */
  setInterval(async () => {
    try {
      console.log(
        "🔄 [TASKS] Running slow fallback position synchronization...",
      );
      await posManager.syncPositions();
    } catch (err) {
      console.error("❌ Task Engine Safety Sync Error:", err);
    }
  }, 30000);

  /**
   * Broadcasts the local memory data.
   */
  setInterval(async () => {
    try {
      // 1. Pull positions completely out of the local memory cache map
      const localPositions = posManager.getPositions();
      broadcaster.broadcastPortfolio(localPositions);

      // 2. Use the throttled/cached equity helper method implemented in Step 1/2
      const currentEquity = await posManager.getOrFetchEquity();

      // If your position manager doesn't cache account metadata yet, you can use high-interval lookups
      const account = await alpaca.getAccount();

      broadcaster.broadcastAccount({
        equity: parseFloat(account.equity),
        buying_power: parseFloat(account.buying_power),
        cash: parseFloat(account.cash),
        day_pl: parseFloat(account.equity) - parseFloat(account.last_equity),
        day_pl_pct:
          parseFloat(account.equity) / parseFloat(account.last_equity) - 1,
      });
    } catch (err) {
      console.error("❌ Task Engine Dashboard Broadcast Error:", err);
    }
  }, 2000);

  /**
   * Scans for stop-losses or take-profits entirely within local memory.
   * This needs to be scanned more often to reduce risk to sale slippage
   */
  setInterval(async () => {
    try {
      for (const pos of posManager.getPositions()) {
        const { shouldExit, reason } = posManager.checkExitConditions(
          pos.symbol,
          parseFloat(pos.current_price),
        );

        if (shouldExit) {
          console.log(
            `🚨 [TASKS] Exit condition triggered for ${pos.symbol}: ${reason}`,
          );

          posManager.markPendingExit(pos.symbol);

          try {
            await executor.closePosition(pos.symbol);
          } catch (err) {
            console.error(
              `❌ [TASKS] Alpaca rejected close request for ${pos.symbol}. Releasing lock.`,
            );
            posManager.clearPendingExit(pos.symbol)
          }
        }
      }
    } catch (err) {
      console.error("❌ Task Engine Exit Check Error:", err);
    }
  }, 1000);
}
