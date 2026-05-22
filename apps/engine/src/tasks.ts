// src/tasks.ts
export function startBackgroundTasks(
  alpaca: any,
  posManager: any,
  broadcaster: any,
  executor: any,
) {
  // Sync positions and update dashboard metrics
  setInterval(async () => {
    try {
      await posManager.syncPositions();
      const account = await alpaca.getAccount();
      broadcaster.broadcastPortfolio(posManager.getPositions());
      broadcaster.broadcastAccount({
        equity: parseFloat(account.equity),
        buying_power: parseFloat(account.buying_power),
        cash: parseFloat(account.cash),
        day_pl: parseFloat(account.equity) - parseFloat(account.last_equity),
        day_pl_pct:
          parseFloat(account.equity) / parseFloat(account.last_equity) - 1,
      });
    } catch (err) {
      console.error("Task Engine Sync Error:", err);
    }
  }, 1000);

  // Check positions for exit conditions periodically
  setInterval(async () => {
    try {
      await posManager.syncPositions();
      for (const pos of posManager.getPositions()) {
        const { shouldExit, reason } = posManager.checkExitConditions(
          pos.symbol,
          parseFloat(pos.current_price),
        );
        if (shouldExit) {
          posManager.markPendingExit(pos.symbol);
          await executor.closePosition(pos.symbol);
        }
      }
    } catch (err) {
      console.error("Task Engine Exit Monitor Error:", err);
    }
  }, 2000);
}
