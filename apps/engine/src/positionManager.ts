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

  constructor(alpaca: Alpaca) {
    this.alpaca = alpaca;
  }

  /**
   * Syncs the local cache with the broker's actual holdings
   */
  async syncPositions() {
    const currentPositions = await this.alpaca.getPositions();
    this.positions.clear();
    currentPositions.forEach((pos: any) => {
      this.positions.set(pos.symbol, pos);
    });

    for (const symbol of this.pendingExits) {
      if (!this.positions.has(symbol)) {
        this.pendingExits.delete(symbol)
      }
    }
    // console.log(`✅ Synced ${this.positions.size} open positions.`);
  }

  /**
   * Get open positions
   * @returns positions.values
   */
  getPositions() {
    // return this.positions.values();
    return [...this.positions.values()].map((pos) => ({ ...pos }));
  }

  /**
   * Check if we currently hold a specific ticker
   */
  hasPosition(symbol: string): boolean {
    return this.positions.has(symbol);
  }

  /**
   * Checks if we are allowed to buy more of a specific ticker
   */
  canOpenPosition(symbol: string): boolean {
    // Basic Rule: No "double dipping" on the same ticker
    return !this.positions.has(symbol);
  }

  /**
   * Checks for pending exits to prevent double-sell orders that fail
   */
  private pendingExits: Set<string> = new Set();

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
      console.log(`checkExitConditions: ${symbol} already exists in PendingExits`)
      return {shouldExit: false, reason: ""}
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

    const peak = this.highWaterMarks.get(symbol)!;
    const dropFromPeak = (peak - currentPrice) / peak;
    const totalPnl = (currentPrice - entryPrice) / entryPrice;

    // Stop-loss and Take-profit checks
    const strategyId = SYMBOL_STRATEGY_MAP[symbol];
    const customRisk = strategyId ? STRATEGY_RISK_MAP[strategyId]: null;

    const activeStopLoss = customRisk ? customRisk.stopLossPct : this.DEFAULT_STOP_LOSS_PCT;
    const activeTakeProfit = customRisk ? customRisk.takeProfitPct : this.DEFAULT_TAKE_PROFIT_PCT;
    // Stop-loss check
    if (pnlPct <= -activeStopLoss) {
      return {
        shouldExit: true,
        reason: `STOP_LOSS: ${(pnlPct * 100).toFixed(2)}%`,
      };
    }

    // Take-profit check
    if (pnlPct >= activeStopLoss) {
      return {
        shouldExit: true,
        reason: `TAKE_PROFIT: +${(pnlPct * 100).toFixed(2)}%`,
      };
    }

    return { shouldExit: false, reason: "" };
  }

  /**
   * Simple Risk Logic: Check if we should exit based on current price
   */
  shouldEmergencyExit(bar: Bar): { exit: boolean; reason: string } {
    const pos = this.positions.get(bar.symbol);
    if (!pos) return { exit: false, reason: "" };

    const entryPrice = parseFloat(pos.avg_entry_price);
    const currentPrice = bar.close;
    const plPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

    // Hard-coded Stop Loss: 2%
    if (plPercent <= -2.0) {
      return {
        exit: true,
        reason: `Stop loss triggered: ${plPercent.toFixed(2)}%`,
      };
    }

    // Hard-coded Take Profit: 5%
    if (plPercent >= 5.0) {
      return {
        exit: true,
        reason: `Take profit reached: ${plPercent.toFixed(2)}%`,
      };
    }

    return { exit: false, reason: "" };
  }
}
