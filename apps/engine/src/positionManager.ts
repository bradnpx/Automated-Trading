import { MASTER_WATCHLIST } from "./config/config.js";
import { StockBlacklist } from "./functions/getStockBlacklist.js";
import {
  AccountSnapshot,
  BrokerPosition,
  ClosedTrade,
  LifecycleUpdateResult,
  OpenTrade,
  Portfolio,
  PortfolioPosition,
  PortfolioSnapshot,
  TradeUpdate,
} from "./models/portfolio.js";

const BROKER_RECONCILIATION_DEBOUNCE_MS = 250;

type BrokerClient = {
  getPositions: () => Promise<BrokerPosition[]>;
  getOrders: (options: Record<string, unknown>) => Promise<Array<{ symbol: string }>>;
  getAccount: () => Promise<{
    equity: string | number;
    buying_power: string | number;
    cash: string | number;
    last_equity: string | number;
  }>;
};

export class PositionManager {
  private readonly DEFAULT_STOP_LOSS_PCT = 2;
  private readonly DEFAULT_TAKE_PROFIT_PCT = 4;
  private readonly alpaca: BrokerClient;
  private readonly portfolio = new Portfolio();
  private readonly blacklist = new StockBlacklist();

  /** Symbols with an exit order currently in flight at the broker. */
  private pendingExits = new Set<string>();
  /** Symbols with a buy order currently in flight at the broker. */
  private pendingBuys = new Set<string>();
  private reconciliationTimer: NodeJS.Timeout | undefined;
  private reconciliationInFlight = false;

  constructor(alpaca: BrokerClient) {
    this.alpaca = alpaca;
  }

  public async init(): Promise<this> {
    await this.portfolio.initialize();
    this.syncBlacklist();
    return this;
  }

  /**
   * Reconciles broker-authoritative positions and open-order locks. It is called at
   * boot, after broker lifecycle events (coalesced), and after a stream reconnect.
   */
  public async syncPositions(): Promise<PortfolioPosition[]> {
    if (this.reconciliationInFlight) return this.getPositions();
    this.reconciliationInFlight = true;

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
        if (positionGone || noActiveOrder) this.pendingExits.delete(symbol);
      }

      this.syncBlacklist();
      return positions;
    } catch (error) {
      console.error(
        "❌ [STATE] Error during broker position synchronization:",
        error,
      );
      return this.getPositions();
    } finally {
      this.reconciliationInFlight = false;
    }
  }

  /** Coalesces rapid partial-fill updates into one broker reconciliation. */
  public requestBrokerReconciliation(
    delayMs = BROKER_RECONCILIATION_DEBOUNCE_MS,
  ): void {
    if (this.reconciliationTimer) return;

    this.reconciliationTimer = setTimeout(() => {
      this.reconciliationTimer = undefined;
      void Promise.all([this.syncPositions(), this.syncAccount()]);
    }, delayMs);
  }

  /** Applies a trade update to local lifecycle state without making a REST request. */
  public async applyTradeUpdate(
    update: TradeUpdate,
    strategyHint?: string,
  ): Promise<LifecycleUpdateResult | undefined> {
    const result = await this.portfolio.applyTradeUpdate(update, strategyHint);
    if (result?.changed) this.syncBlacklist();
    return result;
  }

  /** Applies a stream-derived mark and recalculates portfolio P&L in memory. */
  public updatePositionMark(
    symbol: string,
    price: number,
    timestamp?: string,
  ): boolean {
    return this.portfolio.updateMark(symbol, price, timestamp);
  }

  /** Refreshes the shared account snapshot only when explicitly requested. */
  public async syncAccount(): Promise<AccountSnapshot | null> {
    try {
      const account = await this.alpaca.getAccount();
      this.portfolio.setAccount(account);
      return this.portfolio.getAccount();
    } catch (error) {
      console.error("❌ [STATE] Failed to synchronize account:", error);
      return this.portfolio.getAccount();
    }
  }

  public getAccount(): AccountSnapshot | null {
    return this.portfolio.getAccount();
  }

  public getPositions(): PortfolioPosition[] {
    return this.portfolio.getPositions();
  }

  public getPositionSymbols(): string[] {
    return this.portfolio.getSymbols();
  }

  public getOpenTrade(symbol: string): OpenTrade | undefined {
    return this.portfolio.getOpenTrade(symbol);
  }

  public getOpenTrades(): OpenTrade[] {
    return this.portfolio.getOpenTrades();
  }

  public getClosedTrades(): ClosedTrade[] {
    return this.portfolio.getClosedTrades();
  }

  /** Exposes the complete local lifecycle snapshot for diagnostics and API views. */
  public getPortfolioSnapshot(): PortfolioSnapshot {
    return this.portfolio.getSnapshot();
  }

  public hasPosition(symbol: string): boolean {
    return this.portfolio.hasPosition(symbol);
  }

  public hasPendingExit(symbol: string): boolean {
    return this.pendingExits.has(symbol);
  }

  public canOpenPosition(symbol: string): boolean {
    if (this.blacklist.getSymbols().includes(symbol)) return false;
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

  /** Retrieves current equity only when an entry requires a fresh sizing input. */
  public async getOrFetchEquity(): Promise<number> {
    const current = this.portfolio.getAccount();
    const updatedAt = current ? Date.parse(current.updatedAt) : Number.NaN;
    const isFresh = Number.isFinite(updatedAt) && Date.now() - updatedAt < 30_000;
    if (current && isFresh) return current.equity;

    const refreshed = await this.syncAccount();
    if (refreshed) return refreshed.equity;
    throw new Error("Account equity is unavailable for position sizing.");
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

  private syncBlacklist(): void {
    this.blacklist.sync(this.portfolio.getTradedSymbolsOn());
  }
}
