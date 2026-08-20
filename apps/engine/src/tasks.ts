
export function startBackgroundTasks(
  alpaca: any,
  posManager: any,
  broadcaster: any,
  executor: any,
) {
  // ─── 1. SLOW POSITION SYNC (every 30s) ───────────────────────────────────
  // Reconciles local memory with the broker's truth to catch any missed
  // WebSocket events. The primary sync is driven by onOrderUpdate fills;
  // this is a safety-net fallback only.
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

  // ─── 2. DASHBOARD BROADCAST (every 2s) ───────────────────────────────────
  // Broadcasts the latest local position cache and account state to the
  // dashboard. Uses the cached equity helper to avoid hitting getAccount()
  // on every tick.
  setInterval(async () => {
    try {
      const localPositions = posManager.getPositions();
      broadcaster.broadcastPortfolio(localPositions);

      const account = await alpaca.getAccount();
      broadcaster.broadcastAccount({
        equity: parseFloat(account.equity),
        buying_power: parseFloat(account.buying_power),
        cash: parseFloat(account.cash),
        day_pl: parseFloat(account.equity) - parseFloat(account.last_equity),
        day_pl_pct:
          parseFloat(account.equity) / parseFloat(account.last_equity) - 1,
      });

      // Fetch and broadcast market internals (VIX/TICK)
      const { internalsService } = await import("./modules/internals/internals.service.js");
      await internalsService.getCharts();
      broadcaster.broadcastInternals(internalsService.getSnapshot());

    } catch (err) {
      console.error("❌ Task Engine Dashboard Broadcast Error:", err);
    }
  }, 2000);

  // ─── 3. FALLBACK EXIT MONITOR (every 1s) ─────────────────────────────────
  // Secondary safety net: catches any positions whose exit was missed by the
  // stream pipeline (e.g. during a brief WebSocket gap). Uses current_price
  // from the last broker sync rather than a live bar.
  //
  // All qualifying exits are fired in parallel via Promise.all so that one
  // slow close call does not block others from executing.
  setInterval(async () => {
    try {
      const positions = posManager.getPositions();

      const exitTasks = positions
        .filter((pos: any) => {
          const { shouldExit } = posManager.checkExitConditions(
            pos.symbol,
            parseFloat(pos.current_price),
          );
          return shouldExit;
        })
        .map(async (pos: any) => {
          // Re-check inside the map in case another path already acquired the
          // lock between the filter pass and now (tight but possible race).
          if (posManager.hasPendingExit(pos.symbol)) return;

          posManager.markPendingExit(pos.symbol);
          console.log(
            `🚨 [TASKS] Exit condition triggered for ${pos.symbol}. Closing...`,
          );

          try {
            await executor.closePosition(pos.symbol);
            // Lock is cleared by onOrderUpdate on fill/cancel confirmation.
          } catch (err) {
            console.error(
              `❌ [TASKS] Fallback close failed for ${pos.symbol}. Releasing lock.`,
              err,
            );
            posManager.clearPendingExit(pos.symbol);
          }
        });

      await Promise.all(exitTasks);
    } catch (err) {
      console.error("❌ Task Engine Exit Check Error:", err);
    }
  }, 1000);
}
