import { AccountPayload } from "@my-platform/types";

const PORTFOLIO_BROADCAST_INTERVAL_MS = 1_000;

/**
 * Broadcasts already-local state for the dashboard. Broker synchronization occurs
 * at boot, after a trade-stream reconnect, and after broker order events.
 */
export function startBackgroundTasks(
  posManager: {
    getPositions: () => unknown[];
    getAccount: () => {
      equity: number;
      buyingPower: number;
      cash: number;
      lastEquity: number;
    } | null;
  },
  broadcaster: {
    broadcastPortfolio: (positions: unknown[]) => void;
    broadcastAccount: (account: AccountPayload) => void;
  },
) {
  setInterval(() => {
    broadcaster.broadcastPortfolio(posManager.getPositions());

    const account = posManager.getAccount();
    if (!account) return;
    broadcaster.broadcastAccount({
      equity: account.equity,
      buying_power: account.buyingPower,
      cash: account.cash,
      day_pl: account.equity - account.lastEquity,
      day_pl_pct:
        account.lastEquity === 0
          ? 0
          : account.equity / account.lastEquity - 1,
    });
  }, PORTFOLIO_BROADCAST_INTERVAL_MS);
}
