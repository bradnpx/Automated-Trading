import Alpaca from "@alpacahq/alpaca-trade-api";

import {
  MASTER_WATCHLIST,
  TRAILING_STOP_LOSS_ENABLED,
} from "./config/config.js";
import { StockBlacklist } from "./functions/getStockBlacklist.js";
import { getTradeHistory } from "./middleware/logger.js";
import {
  BrokerPosition,
  Portfolio,
  PortfolioPosition,
} from "./models/portfolio.js";
import { TradeLifecycle } from "@my-platform/types";

export type PositionExitAction = "none" | "close-position" | "take-profit-half";

export interface PositionExitProfile {
  strategy: string;
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopLoss: boolean;
}

export interface PositionExitDecision {
  shouldExit: boolean;
  action: PositionExitAction;
  reason: string;
  profile?: PositionExitProfile;
  entryPrice?: number;
  quantity?: number;
}

type LoggedTrade = Record<string, unknown>;

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
  /** Symbols with a broker-managed trailing sell order protecting the remainder. */
  private trailingStopSymbols = new Set<string>();
  /** Symbols whose take-profit half exit has filled and is awaiting a trailing order. */
  private pendingTrailingStopEntries = new Map<string, number>();
  /** Entry metadata reconstructed from the application's trade logs when needed. */
  private entryProfiles = new Map<string, PositionExitProfile>();

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
    await this.restoreEntryProfilesFromTradeLog();
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
      const currentPositionSymbols = new Set(
        positions.map((position) => position.symbol),
      );
      this.trailingStopSymbols = new Set(
        openOrders
          .filter(
            (order: { symbol: string; side?: string; type?: string }) =>
              currentPositionSymbols.has(order.symbol) &&
              order.side === "sell" &&
              order.type === "trailing_stop",
          )
          .map((order: { symbol: string }) => order.symbol),
      );

      for (const symbol of this.pendingBuys) {
        if (!openOrderSymbols.has(symbol)) this.pendingBuys.delete(symbol);
      }

      for (const symbol of this.pendingExits) {
        const positionGone = !this.portfolio.hasPosition(symbol);
        const noActiveOrder = !openOrderSymbols.has(symbol);
        if (
          positionGone ||
          (noActiveOrder && !this.pendingTrailingStopEntries.has(symbol))
        ) {
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
    return (
      this.pendingExits.has(symbol) ||
      this.pendingTrailingStopEntries.has(symbol)
    );
  }

  public canOpenPosition(symbol: string): boolean {
    const blacklistedSymbols = this.blacklist?.getSymbols() ?? [];
    if (blacklistedSymbols.includes(symbol)) {
      // console.log(
      //   `⛔ [RISK] Buy signal blocked for ${symbol} (traded yesterday/blacklisted)`,
      // );
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

  public activateTrailingStop(symbol: string): void {
    this.trailingStopSymbols.add(symbol);
  }

  public deactivateTrailingStop(symbol: string): void {
    this.trailingStopSymbols.delete(symbol);
  }

  public hasActiveTrailingStop(symbol: string): boolean {
    return this.trailingStopSymbols.has(symbol);
  }

  public beginTrailingStop(symbol: string, entryPrice: number): void {
    this.pendingTrailingStopEntries.set(symbol, entryPrice);
  }

  public getPendingTrailingStopEntryPrice(symbol: string): number | undefined {
    return this.pendingTrailingStopEntries.get(symbol);
  }

  public cancelPendingTrailingStop(symbol: string): void {
    this.pendingTrailingStopEntries.delete(symbol);
  }

  /** Restores locally persisted half-out/trailing state after an engine restart. */
  public restoreLifecycleState(lifecycles: TradeLifecycle[]): void {
    for (const lifecycle of lifecycles) {
      if (lifecycle.status === "closed") continue;

      this.entryProfiles.set(lifecycle.symbol, {
        strategy: lifecycle.profile.strategy,
        stopLossPct: lifecycle.profile.stopLossPct,
        takeProfitPct: lifecycle.profile.takeProfitPct,
        trailingStopLoss: lifecycle.profile.trailingStopLoss,
      });

      if (lifecycle.trailingStopOrderId) {
        this.trailingStopSymbols.add(lifecycle.symbol);
        continue;
      }

      if (lifecycle.status === "partially_closed") {
        this.pendingTrailingStopEntries.set(
          lifecycle.symbol,
          lifecycle.averageEntryPrice,
        );
      }
    }
  }

  public getPendingTrailingStopSymbols(): string[] {
    return Array.from(this.pendingTrailingStopEntries.keys());
  }

  public captureEntryProfile(symbol: string): PositionExitProfile {
    const configured = MASTER_WATCHLIST.get(symbol);
    const profile: PositionExitProfile = {
      strategy: configured?.strategy ?? "UnknownStrategy",
      stopLossPct: configured?.stopLossPct ?? this.DEFAULT_STOP_LOSS_PCT,
      takeProfitPct: configured?.takeProfitPct ?? this.DEFAULT_TAKE_PROFIT_PCT,
      trailingStopLoss:
        configured?.trailingStopLoss ?? TRAILING_STOP_LOSS_ENABLED,
    };
    this.entryProfiles.set(symbol, profile);
    return profile;
  }

  public getExitProfile(symbol: string): PositionExitProfile {
    const loggedProfile = this.entryProfiles.get(symbol);
    if (loggedProfile) {
      return loggedProfile;
    }

    const configured = MASTER_WATCHLIST.get(symbol);
    if (configured) {
      return {
        strategy: configured.strategy,
        stopLossPct: configured.stopLossPct ?? this.DEFAULT_STOP_LOSS_PCT,
        takeProfitPct: configured.takeProfitPct ?? this.DEFAULT_TAKE_PROFIT_PCT,
        trailingStopLoss:
          configured.trailingStopLoss ?? TRAILING_STOP_LOSS_ENABLED,
      };
    }

    return {
      strategy: "UnknownStrategy",
      stopLossPct: this.DEFAULT_STOP_LOSS_PCT,
      takeProfitPct: this.DEFAULT_TAKE_PROFIT_PCT,
      trailingStopLoss: TRAILING_STOP_LOSS_ENABLED,
    };
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
  ): PositionExitDecision {
    if (this.pendingExits.has(symbol)) {
      return { shouldExit: false, action: "none", reason: "" };
    }

    const position = this.portfolio.getPosition(symbol);
    if (!position || !Number.isFinite(currentPrice) || currentPrice <= 0) {
      return { shouldExit: false, action: "none", reason: "" };
    }

    const entryPrice = Number(position.avg_entry_price);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      return { shouldExit: false, action: "none", reason: "" };
    }

    const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
    const profile = this.getExitProfile(symbol);

    if (
      this.trailingStopSymbols.has(symbol) ||
      this.pendingTrailingStopEntries.has(symbol)
    ) {
      return { shouldExit: false, action: "none", reason: "", profile };
    }

    if (pnlPct <= -Math.abs(profile.stopLossPct)) {
      return {
        shouldExit: true,
        action: "close-position",
        reason: `STOP_LOSS: ${pnlPct.toFixed(2)}%`,
        profile,
        entryPrice,
        quantity: Number(position.qty),
      };
    }

    if (pnlPct >= Math.abs(profile.takeProfitPct)) {
      return {
        shouldExit: true,
        action: profile.trailingStopLoss
          ? "take-profit-half"
          : "close-position",
        reason: profile.trailingStopLoss
          ? `TAKE_PROFIT_HALF: +${pnlPct.toFixed(2)}%`
          : `TAKE_PROFIT: +${pnlPct.toFixed(2)}%`,
        profile,
        entryPrice,
        quantity: Number(position.qty),
      };
    }

    return { shouldExit: false, action: "none", reason: "", profile };
  }

  private async restoreEntryProfilesFromTradeLog(): Promise<void> {
    const history = await getTradeHistory();

    for (const record of history) {
      if (
        !isLoggedTrade(record) ||
        readString(record.side)?.toLowerCase() !== "buy"
      ) {
        continue;
      }

      const symbol = readString(record.symbol);
      const strategy =
        readString(record.strategy) ?? readLegacyStrategy(record);
      if (!symbol || !strategy) continue;

      this.entryProfiles.set(symbol, {
        strategy,
        stopLossPct:
          readPositiveNumber(record.stop_loss_pct) ??
          this.DEFAULT_STOP_LOSS_PCT,
        takeProfitPct:
          readPositiveNumber(record.take_profit_pct) ??
          this.DEFAULT_TAKE_PROFIT_PCT,
        trailingStopLoss:
          typeof record.trailing_stop_loss === "boolean"
            ? record.trailing_stop_loss
            : TRAILING_STOP_LOSS_ENABLED,
      });
    }
  }
}

function isLoggedTrade(value: unknown): value is LoggedTrade {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function readLegacyStrategy(record: LoggedTrade): string | undefined {
  const reason = readString(record.reason);
  return reason && !reason.startsWith("Exit") ? reason : undefined;
}
