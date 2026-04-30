import Alpaca from "@alpacahq/alpaca-trade-api";
import { Bar } from "@my-platform/types";

export class PositionManager {
  private alpaca: Alpaca;
  private positions: Map<string, any> = new Map();

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
    console.log(`✅ Synced ${this.positions.size} open positions.`);
  }

  /**
   * Get open positions
   * @returns positions.values
   */
  getPositions() {
    return this.positions.values()
  }

  /**
   * Checks if we are allowed to buy more of a specific ticker
   */
  canOpenPosition(symbol: string): boolean {
    // Basic Rule: No "double dipping" on the same ticker
    return !this.positions.has(symbol);
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
