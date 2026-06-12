import Alpaca from "@alpacahq/alpaca-trade-api";
import { Bar } from "@my-platform/types";
import { STRATEGY_RISK_MAP, MASTER_WATCHLIST } from "./config/config";

export class PositionManager {
  private DEFAULT_STOP_LOSS_PCT = 0.02;
  private DEFAULT_TAKE_PROFIT_PCT = 0.04;
  private TRAILING_STOP_PCT = 0.015;

  private alpaca: Alpaca;
  private positions: Map<string, any> = new Map();
  private highWaterMarks: Map<string, number> = new Map();

  /**
   * Tracks symbols that have an exit order actively in-flight at the broker.
   * A symbol is added here the moment closePosition() is called and removed
   * as soon as the broker confirms the fill (via onOrderUpdate) or the call
   * errors out. syncPositions() acts as a safety-net fallback only.
   */
  private pendingExits: Set<string> = new Set();
  private pendingBuys: Set<string> = new Set();

  // Equity cache — avoids hitting getAccount() on every BUY signal evaluation
  private cachedEquity: number | null = null;
  private equityCacheTime: number = 0;
  private readonly EQUITY_CACHE_TTL = 30000;

  constructor(alpaca: Alpaca) {
    this.alpaca = alpaca;
  }

  /**
   * Syncs the local cache with the broker's actual holdings.
   * Also acts as a fallback self-healer: if a symbol is in pendingExits
   * but the position is already gone AND there are no open orders for it,
   * the lock is stale and gets cleared here.
   */
  async syncPositions() {
    try {
      const [currentPositions, openOrders] = await Promise.all([
        this.alpaca.getPositions(),
        this.alpaca.getOrders({ status: "open" }),
      ]);

      this.positions.clear();
      currentPositions.forEach((pos: any) => {
        this.positions.set(pos.symbol, pos);
      });

      const openOrderSymbols = new Set<string>(
        openOrders.map((order: any) => order.symbol),
      );

      // Clear stale pendingBuys where the order is no longer active
      for (const symbol of this.pendingBuys) {
        if (!openOrderSymbols.has(symbol)) {
          this.pendingBuys.delete(symbol);
        }
      }

      // Fallback cleanup: clear any exit lock where the position is gone AND
      // no order is in-flight. The primary clear happens immediately after the
      // close call resolves or in onOrderUpdate, so this should rarely fire.
      for (const symbol of this.pendingExits) {
        const positionGone = !this.positions.has(symbol);
        const noActiveOrder = !openOrderSymbols.has(symbol);

        if (positionGone || noActiveOrder) {
          console.log(
            `🔄 [STATE] Fallback-cleared stale pending exit for: ${symbol}`,
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

  hasPendingExit(symbol: string): boolean {
    return this.pendingExits.has(symbol);
  }

  canOpenPosition(symbol: string): boolean {
    return !this.pendingBuys.has(symbol) && !this.positions.has(symbol);
  }

  setPendingBuy(symbol: string) {
    this.pendingBuys.add(symbol);
  }

  clearPendingBuy(symbol: string) {
    this.pendingBuys.delete(symbol);
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
   * Returns cached account equity, fetching from the broker only when the
   * cache is stale (TTL: 30s). Avoids a live getAccount() call on every
   * BUY signal evaluation in the pipeline.
   */
  async getOrFetchEquity(): Promise<number> {
    const now = Date.now();
    if (
      this.cachedEquity !== null &&
      now - this.equityCacheTime < this.EQUITY_CACHE_TTL
    ) {
      return this.cachedEquity;
    }

    try {
      const account = await this.alpaca.getAccount();
      this.cachedEquity = parseFloat(account.equity);
      this.equityCacheTime = now;
      return this.cachedEquity;
    } catch (err) {
      console.error("❌ [POS] Failed to fetch account equity:", err);
      if (this.cachedEquity !== null) return this.cachedEquity;
      throw err;
    }
  }

  /**
   * Evaluate Stop-loss and Take-profit thresholds.
   * Returns shouldExit: false immediately if an exit is already in-flight,
   * preventing duplicate close attempts from any caller.
   */
  checkExitConditions(symbol: string, currentPrice: number) {
    if (this.pendingExits.has(symbol)) {
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

    const strategy = MASTER_WATCHLIST.get(symbol);
    const customRisk = strategy
      ? {
          takeProfitPct:
            MASTER_WATCHLIST.get(symbol).takeProfitPct ||
            this.DEFAULT_TAKE_PROFIT_PCT,
          stopLossPct:
            -MASTER_WATCHLIST.get(symbol).stopLossPct ||
            -this.DEFAULT_STOP_LOSS_PCT,
        }
      : { takeProfitPct: 4, stopLossPct: -2 };

    if (pnlPct <= customRisk.stopLossPct) {
      return {
        shouldExit: true,
        reason: `STOP_LOSS: ${(pnlPct * 100).toFixed(2)}%`,
      };
    }

    if (pnlPct >= customRisk.takeProfitPct) {
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
