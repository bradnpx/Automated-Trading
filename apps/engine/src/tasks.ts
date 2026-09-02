const BROKER_RECONCILIATION_INTERVAL_MS = 30_000;
const PORTFOLIO_BROADCAST_INTERVAL_MS = 1_000;
const ACCOUNT_REFRESH_INTERVAL_MS = 2_000;

export function startBackgroundTasks(
  alpaca: any,
  posManager: any,
  broadcaster: any,
) {
  // Broker reconciliation is intentionally slower than market marking. Alpaca's
  // trade-update stream handles fills immediately; this catches missed events.
  setInterval(() => {
    void posManager.syncPositions();
  }, BROKER_RECONCILIATION_INTERVAL_MS);

  // Portfolio marks are updated by the market trade stream and broadcast on a
  // predictable one-second cadence for the dashboard.
  setInterval(() => {
    broadcaster.broadcastPortfolio(posManager.getPositions());
  }, PORTFOLIO_BROADCAST_INTERVAL_MS);

  // Keep account summary behavior separate so a slow account request never blocks
  // the one-second portfolio feed.
  let accountRefreshInFlight = false;
  setInterval(() => {
    if (accountRefreshInFlight) return;
    accountRefreshInFlight = true;

    void alpaca
      .getAccount()
      .then((account: any) => {
        const equity = Number(account.equity);
        const lastEquity = Number(account.last_equity);
        broadcaster.broadcastAccount({
          equity,
          buying_power: Number(account.buying_power),
          cash: Number(account.cash),
          day_pl: equity - lastEquity,
          day_pl_pct: lastEquity === 0 ? 0 : equity / lastEquity - 1,
        });
      })
      .catch((error: unknown) => {
        console.error("❌ [TASKS] Account refresh failed:", error);
      })
      .finally(() => {
        accountRefreshInFlight = false;
      });
  }, ACCOUNT_REFRESH_INTERVAL_MS);
}
