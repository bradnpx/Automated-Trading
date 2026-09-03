import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MASTER_WATCHLIST } from "../config/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORTFOLIO_PATH = path.resolve(
  __dirname,
  "../../data/portfolio.json",
);

type PositionFields = Record<string, unknown>;

export type BrokerPosition = PositionFields & {
  symbol: string;
  qty: string | number;
  avg_entry_price: string | number;
  current_price?: string | number;
  asset_id?: string;
};

export type PortfolioPosition = BrokerPosition & {
  current_price: string;
  market_value: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  strategy?: string;
  takeProfitPct?: number;
  stopLossPct?: number;
  totalRisk?: number;
  expiration?: number;
  marked_at: string;
};

function toFiniteNumber(
  value: string | number | undefined,
  fallback = 0,
): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function isBrokerPosition(value: unknown): value is BrokerPosition {
  if (!value || typeof value !== "object") return false;

  const position = value as Partial<BrokerPosition>;
  return (
    typeof position.symbol === "string" &&
    (typeof position.qty === "string" || typeof position.qty === "number") &&
    (typeof position.avg_entry_price === "string" ||
      typeof position.avg_entry_price === "number")
  );
}

/**
 * Holds the broker-authoritative open-position snapshot and overlays stream-derived
 * marks between broker reconciliations. The local JSON snapshot is recovery-only;
 * Alpaca's position endpoint remains the source of truth for quantities and orders.
 */
export class Portfolio {
  private readonly filepath: string;
  private readonly restoration: Promise<void>;
  private openTrades = new Map<string, PortfolioPosition>();

  constructor(
    filepath = process.env.PORTFOLIO_STATE_PATH ?? DEFAULT_PORTFOLIO_PATH,
  ) {
    this.filepath = filepath;
    this.restoration = this.restoreTradesFromLocal();
  }

  /**
   * Replaces the position set with a fresh broker snapshot while retaining a newer
   * stream mark for each still-open symbol.
   */
  public async syncTrades(
    positions: BrokerPosition[],
  ): Promise<PortfolioPosition[]> {
    await this.restoration;

    const nextPositions = new Map<string, PortfolioPosition>();
    for (const brokerPosition of positions) {
      if (!isBrokerPosition(brokerPosition)) continue;

      const existing = this.openTrades.get(brokerPosition.symbol);
      const brokerMark = toFiniteNumber(brokerPosition.current_price);
      const retainedMark =
        existing && this.hasFreshMark(existing.marked_at)
          ? toFiniteNumber(existing.current_price, brokerMark)
          : brokerMark;
      const mark = retainedMark > 0 ? retainedMark : brokerMark;

      nextPositions.set(
        brokerPosition.symbol,
        this.withMark(brokerPosition, mark, existing?.marked_at),
      );
    }

    this.openTrades = nextPositions;
    void this.saveTradesToLocal();
    return this.getPositions();
  }

  /** Updates price and derived P&L fields without waiting for another REST sync. */
  public updateMark(
    symbol: string,
    price: number,
    markedAt = new Date().toISOString(),
  ): boolean {
    if (!symbol || !Number.isFinite(price) || price <= 0) return false;

    const position = this.openTrades.get(symbol);
    if (!position || this.isOlderMark(markedAt, position.marked_at))
      return false;

    this.openTrades.set(symbol, this.withMark(position, price, markedAt));
    return true;
  }

  public getPositions(): PortfolioPosition[] {
    return Array.from(this.openTrades.values(), (position) => ({
      ...position,
    }));
  }

  public getPosition(symbol: string): PortfolioPosition | undefined {
    const position = this.openTrades.get(symbol);
    return position ? { ...position } : undefined;
  }

  public hasPosition(symbol: string): boolean {
    return this.openTrades.has(symbol);
  }

  public getSymbols(): string[] {
    return Array.from(this.openTrades.keys());
  }

  /** Persists only broker synchronization snapshots, never every market-data tick. */
  public async saveTradesToLocal(): Promise<void> {
    try {
      await mkdir(path.dirname(this.filepath), { recursive: true });
      const snapshot = Object.fromEntries(this.openTrades);
      await writeFile(this.filepath, JSON.stringify(snapshot, null, 2), "utf8");
    } catch (error) {
      console.error(
        "❌ [PORTFOLIO] Failed to write local portfolio snapshot:",
        error,
      );
    }
  }

  /**
   * Loads a prior local snapshot for recovery visibility only. The first broker
   * synchronization replaces it, preventing stale quantities from being traded.
   */
  private async restoreTradesFromLocal(): Promise<void> {
    if (!existsSync(this.filepath)) return;

    try {
      const fileContents = await readFile(this.filepath, "utf8");
      const parsed: unknown = JSON.parse(fileContents);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(
          "Portfolio snapshot must be an object keyed by symbol.",
        );
      }

      const restored = new Map<string, PortfolioPosition>();
      for (const [symbol, value] of Object.entries(parsed)) {
        if (!isBrokerPosition(value) || value.symbol !== symbol) continue;

        const mark = toFiniteNumber(value.current_price);
        const markedAt =
          typeof value.marked_at === "string" ? value.marked_at : undefined;
        restored.set(symbol, this.withMark(value, mark, markedAt));
      }
      this.openTrades = restored;
    } catch (error) {
      console.error(
        "❌ [PORTFOLIO] Failed to restore local portfolio snapshot:",
        error,
      );
    }
  }

  private isOlderMark(
    incomingTimestamp: string,
    existingTimestamp: string,
  ): boolean {
    const incomingTime = Date.parse(incomingTimestamp);
    const existingTime = Date.parse(existingTimestamp);
    return (
      Number.isFinite(incomingTime) &&
      Number.isFinite(existingTime) &&
      incomingTime < existingTime
    );
  }

  private hasFreshMark(timestamp: string): boolean {
    const markedAt = Date.parse(timestamp);
    return Number.isFinite(markedAt) && Date.now() - markedAt <= 5_000;
  }

  private withMark(
    position: BrokerPosition,
    mark: number,
    markedAt = new Date().toISOString(),
  ): PortfolioPosition {
    const quantity = toFiniteNumber(position.qty);
    const entryPrice = toFiniteNumber(position.avg_entry_price);
    const currentPrice =
      mark > 0 ? mark : toFiniteNumber(position.current_price);
    const marketValue = currentPrice * quantity;
    const unrealizedPl = (currentPrice - entryPrice) * quantity;
    const costBasis = Math.abs(entryPrice * quantity);
    const strategyConfig = MASTER_WATCHLIST.get(position.symbol);

    return {
      ...position,
      current_price: currentPrice.toString(),
      market_value: marketValue.toString(),
      unrealized_pl: unrealizedPl.toString(),
      unrealized_plpc: (costBasis === 0
        ? 0
        : unrealizedPl / costBasis
      ).toString(),
      ...(strategyConfig
        ? {
            strategy: strategyConfig.strategy,
            takeProfitPct: strategyConfig.takeProfitPct,
            stopLossPct: strategyConfig.stopLossPct,
            totalRisk: strategyConfig.totalRisk,
            expiration: strategyConfig.expiration,
          }
        : {}),
      marked_at: markedAt,
    };
  }
}
