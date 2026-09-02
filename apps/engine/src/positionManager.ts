import Alpaca from "@alpacahq/alpaca-trade-api";

import { MASTER_WATCHLIST } from "./config/config.js";
import { StockBlacklist } from "./functions/getStockBlacklist.js";
import {
  BrokerPosition,
  Portfolio,
  PortfolioPosition,
} from "./models/portfolio.js";

export class PositionManager {
  private readonly DEFAULT_STOP_LOSS_PCT = 2;
  private readonly DEFAULT_TAKE_PROFIT_PCT = 4;
  private readonly alpaca: Alpaca;
  private readonly portfolio = new Portfolio();
  private blacklist: StockBlacklist | undefined;

  /** Symbols with an exit order currently in flight at the broker. */
  private pendingExits = new Set<string>();
  /** Symbols with a buy order currently in flight at the broker. */
  private pendingBuys = new Set<string>();

  /** Avoids fetching account equity for every second-level strategy evaluation. */
  private cachedEquity: number | null = null;
  private equityCacheTime = 0;
  private readonly EQUITY_CACHE_TTL = 30_000;

  constructor(alpaca: Alpaca) {
    this.alpaca = alpaca;
  }

  public async init(): Promise<this> {
    if (!this.blacklist) {
      this.blacklist = await StockBlacklist.getInstance(30_000);
    }
    return this;
  }

  /**
   * Reconciles quantity and order state with Alpaca. Stream marks are retained by
   * Portfolio when they are newer than the broker snapshot's current_price.
   */
  public async syncPositions(): Promise<PortfolioPosition[]> {
    try {
      const [currentPositions, openOrders] = await Promise.all([
        this.alpaca.getPositions(),
        this.alpaca.getOrders({
          status: "open",
          until: undefined,
          after: undefined,
          limit: undefined,
          direction: undefined,
          nested: undefined,
          symbols: undefined,
        }),
      ]);

      const positions = await this.portfolio.syncTrades(
        currentPositions as BrokerPosition[],
      );
      const openOrderSymbols = new Set<string>(
        openOrders.map((order: { symbol: string }) => order.symbol),
      );

      for (const symbol of this.pendingBuys) {
        if (!openOrderSymbols.has(symbol)) this.pendingBuys.delete(symbol);
      }

      for (const symbol of this.pendingExits) {
        const positionGone = !this.portfolio.hasPosition(symbol);
        const noActiveOrder = !openOrderSymbols.has(symbol);
        if (positionGone || noActiveOrder) {
          console.log(`🔄 [STATE] Cleared stale pending exit for: ${symbol}`);
          this.pendingExits.delete(symbol);
        }
      }

      return positions;
    } catch (error) {
      console.error(
        "❌ [STATE] Error during broker position synchronization:",
        error,
      );
      return this.getPositions();
    }
  }

  /** Applies a stream-derived mark and recalculates portfolio P&L in memory. */
  public updatePositionMark(
    symbol: string,
    price: number,
    timestamp?: string,
  ): boolean {
    return this.portfolio.updateMark(symbol, price, timestamp);
  }

  public getPositions(): PortfolioPosition[] {
    return this.portfolio.getPositions();
  }

  public getPositionSymbols(): string[] {
    return this.portfolio.getSymbols();
  }

  public hasPosition(symbol: string): boolean {
    return this.portfolio.hasPosition(symbol);
  }

  public hasPendingExit(symbol: string): boolean {
    return this.pendingExits.has(symbol);
  }

  public canOpenPosition(symbol: string): boolean {
    const blacklistedSymbols = this.blacklist?.getSymbols() ?? [];
    if (blacklistedSymbols.includes(symbol)) {
      console.log(
        `⛔ [RISK] Buy signal blocked for ${symbol} (traded yesterday/blacklisted)`,
      );
      return false;
    }

    return !this.pendingBuys.has(symbol) && !this.portfolio.hasPosition(symbol);
  }

  public markPendingBuy(symbol: string): void {
    this.pendingBuys.add(symbol);
  }

  public clearPendingBuy(symbol: string): void {
    this.pendingBuys.delete(symbol);
  }

  public markPendingExit(symbol: string): void {
    this.pendingExits.add(symbol);
  }

  public clearPendingExit(symbol: string): void {
    this.pendingExits.delete(symbol);
  }

  public async getOrFetchEquity(): Promise<number> {
    const now = Date.now();
    if (
      this.cachedEquity !== null &&
      now - this.equityCacheTime < this.EQUITY_CACHE_TTL
    ) {
      return this.cachedEquity;
    }

    try {
      const account = await this.alpaca.getAccount();
      this.cachedEquity = Number(account.equity);
      this.equityCacheTime = now;
      return this.cachedEquity;
    } catch (error) {
      console.error("❌ [POS] Failed to fetch account equity:", error);
      if (this.cachedEquity !== null) return this.cachedEquity;
      throw error;
    }
  }

  /**
   * Evaluates position-level stop-loss and take-profit thresholds using a mark
   * supplied by the real-time trade stream. Thresholds are percentage points.
   */
  public checkExitConditions(
    symbol: string,
    currentPrice: number,
  ): {
    shouldExit: boolean;
    reason: string;
  } {
    if (this.pendingExits.has(symbol)) {
      return { shouldExit: false, reason: "" };
    }

    const position = this.portfolio.getPosition(symbol);
    if (!position || !Number.isFinite(currentPrice) || currentPrice <= 0) {
      return { shouldExit: false, reason: "" };
    }

    const entryPrice = Number(position.avg_entry_price);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      return { shouldExit: false, reason: "" };
    }

    const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
    const strategy = MASTER_WATCHLIST.get(symbol);
    const stopLossPct = strategy?.stopLossPct ?? this.DEFAULT_STOP_LOSS_PCT;
    const takeProfitPct =
      strategy?.takeProfitPct ?? this.DEFAULT_TAKE_PROFIT_PCT;

    if (pnlPct <= -Math.abs(stopLossPct)) {
      return {
        shouldExit: true,
        reason: `STOP_LOSS: ${pnlPct.toFixed(2)}%`,
      };
    }

    if (pnlPct >= Math.abs(takeProfitPct)) {
      return {
        shouldExit: true,
        reason: `TAKE_PROFIT: +${pnlPct.toFixed(2)}%`,
      };
    }

    return { shouldExit: false, reason: "" };
  }
}
