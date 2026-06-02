import Alpaca from "@alpacahq/alpaca-trade-api";
import { Bar } from "@my-platform/types";
import { STRATEGY_RISK_MAP, SYMBOL_STRATEGY_MAP } from "./config";

export class PositionManager {
  private alpaca: Alpaca;
  private positions: Map<string, any> = new Map();
  private highWaterMarks: Map<string, number> = new Map();
  private DEFAULT_STOP_LOSS_PCT = 0.02;
  private DEFAULT_TAKE_PROFIT_PCT = 0.04;
  private TRAILING_STOP_PCT = 0.015;

  /**
   * Tracks pending exits to prevent double-sell orders that fail
   */
  private pendingExits: Set<string> = new Set();

  constructor(alpaca: Alpaca) {
    this.alpaca = alpaca;
  }

  /**
   * Syncs the local cache with the broker's actual holdings and clears stale locks
   */
  async syncPositions() {
    try {
      // 1. Fetch live open positions and active open orders simultaneously
      const [currentPositions, openOrders] = await Promise.all([
        this.alpaca.getPositions(),
        this.alpaca.getOrders({ status: "open" }), // Fetches all active in-flight orders
      ]);

      // 2. Rebuild the live open position cache
      this.positions.clear();
      currentPositions.forEach((pos: any) => {
        this.positions.set(pos.symbol, pos);
      });

      // 3. Collect all symbols that currently have active orders in-flight
      const symbolsWithActiveOrders = new Set<string>(
        openOrders.map((order: any) => order.symbol),
      );

      // 4. SMART SELF-HEALING REGISTRY CLEANUP:
      for (const symbol of this.pendingExits) {
        // Condition A: If we no longer hold the position, release the lock
        const positionDefinitivelyClosed = !this.positions.has(symbol);

        // Condition B: If we hold the position but there is NO open order in-flight at Alpaca,
        // the previous exit attempt failed/errored out. Release the lock so we can retry!
        const hasNoActiveOrdersAtBroker = !symbolsWithActiveOrders.has(symbol);

        if (positionDefinitivelyClosed || hasNoActiveOrdersAtBroker) {
          console.log(
            `🔄 [STATE] Auto-cleared stuck pending exit for: ${symbol}`,
          );
          this.pendingExits.delete(symbol);
        }
      }
    } catch (err) {
      console.error("❌ [STATE] Error during syncPositions collection:", err);
    }
  }

  getPositions() {
    return [...this.positions.values()].map((pos) => ({ ...pos }));
  }

  hasPosition(symbol: string): boolean {
    return this.positions.has(symbol);
  }

  canOpenPosition(symbol: string): boolean {
    return !this.positions.has(symbol);
  }

  markPendingExit(symbol: string) {
    this.pendingExits.add(symbol);
  }

  getPendingExits() {
    return this.pendingExits;
  }

  clearPendingExit(symbol: string) {
    this.pendingExits.delete(symbol);
  }

  /**
   * Evaluate Stop-loss and Take-profit
   */
  checkExitConditions(symbol: string, currentPrice: number) {
    if (this.pendingExits.has(symbol)) {
      console.log(
        `checkExitConditions: ${symbol} already exists in PendingExits`,
      );
      return { shouldExit: false, reason: "" };
    }

    const pos = this.positions.get(symbol);
    if (!pos) return { shouldExit: false, reason: "" };

    const entryPrice = parseFloat(pos.avg_entry_price);
    const pnlPct = (currentPrice - entryPrice) / entryPrice;

    const currentHWM = this.highWaterMarks.get(symbol) || entryPrice;
    if (currentPrice > currentHWM) {
      this.highWaterMarks.set(symbol, currentPrice);
      console.log(`📈 [${symbol}] New Peak: $${currentPrice.toFixed(2)}`);
    }

    const strategyId = SYMBOL_STRATEGY_MAP[symbol];
    const customRisk = strategyId ? STRATEGY_RISK_MAP[strategyId] : null;

    const activeStopLoss = customRisk
      ? customRisk.stopLossPct
      : this.DEFAULT_STOP_LOSS_PCT;
    const activeTakeProfit = customRisk
      ? customRisk.takeProfitPct
      : this.DEFAULT_TAKE_PROFIT_PCT;

    // Stop-loss check
    if (pnlPct <= -activeStopLoss) {
      return {
        shouldExit: true,
        reason: `STOP_LOSS: ${(pnlPct * 100).toFixed(2)}%`,
      };
    }

    // Take-profit check
    if (pnlPct >= activeTakeProfit) {
      return {
        shouldExit: true,
        reason: `TAKE_PROFIT: +${(pnlPct * 100).toFixed(2)}%`,
      };
    }

    return { shouldExit: false, reason: "" };
  }

  shouldEmergencyExit(bar: Bar): { exit: boolean; reason: string } {
    const pos = this.positions.get(bar.symbol);
    if (!pos) return { exit: false, reason: "" };

    const entryPrice = parseFloat(pos.avg_entry_price);
    const currentPrice = bar.close;
    const plPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

    if (plPercent <= -2.0) {
      return {
        exit: true,
        reason: `Stop loss triggered: ${plPercent.toFixed(2)}%`,
      };
    }

    if (plPercent >= 5.0) {
      return {
        exit: true,
        reason: `Take profit reached: ${plPercent.toFixed(2)}%`,
      };
    }

    return { exit: false, reason: "" };
  }
}
