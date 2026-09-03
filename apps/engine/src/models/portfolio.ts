import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getTradeHistory } from "../middleware/logger.js";
import { MASTER_WATCHLIST } from "../config/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORTFOLIO_PATH = path.resolve(
  __dirname,
  "../../data/portfolio.json",
);
const STATE_VERSION = 2;
const MAX_CLOSED_TRADES = 1_000;
const MAX_SEEN_EVENT_KEYS = 5_000;

type PositionFields = Record<string, unknown>;
type NumericValue = string | number | undefined;
type OrderSide = "buy" | "sell";
export type BrokerOrderEvent =
  | "new"
  | "fill"
  | "partial_fill"
  | "canceled"
  | "rejected"
  | "expired"
  | "accepted"
  | "pending_new"
  | "pending_cancel"
  | "pending_replace"
  | "replaced"
  | "done_for_day"
  | "calculated"
  | "suspended"
  | "order_replace_rejected"
  | "order_cancel_rejected";

export type BrokerPosition = PositionFields & {
  symbol: string;
  qty: string | number;
  avg_entry_price: string | number;
  current_price?: string | number;
  asset_id?: string;
};

export type BrokerOrder = PositionFields & {
  id: string;
  symbol: string;
  side: OrderSide;
  status?: string;
  client_order_id?: string;
  qty?: NumericValue;
  filled_qty?: NumericValue;
  filled_avg_price?: NumericValue;
  created_at?: string;
  submitted_at?: string;
  filled_at?: string;
  updated_at?: string;
};

export type TradeUpdate = {
  event: BrokerOrderEvent | string;
  order: BrokerOrder;
  price?: NumericValue;
  qty?: NumericValue;
  fillQty?: NumericValue;
  timestamp?: string;
  execution_id?: string;
  executionId?: string;
};

export type TradeFill = {
  executionId: string;
  orderId: string;
  side: OrderSide;
  price: number;
  quantity: number;
  filledAt: string;
};

export type LifecycleOrder = {
  id: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  status: string;
  submittedAt?: string;
  filledAt?: string;
  updatedAt: string;
  requestedQuantity?: number;
  filledQuantity: number;
  averageFillPrice?: number;
  fills: TradeFill[];
};

export type OpenTrade = {
  id: string;
  symbol: string;
  strategy: string;
  openedAt: string;
  openedOrderId?: string;
  entryFills: TradeFill[];
  exitFills: TradeFill[];
  entryQuantity: number;
  remainingQuantity: number;
  averageEntryPrice: number;
  highWaterMark: number;
  lastUpdatedAt: string;
};

export type ClosedTrade = OpenTrade & {
  closedAt: string;
  closedOrderId?: string;
  exitFills: TradeFill[];
  exitQuantity: number;
  averageExitPrice?: number;
  realizedPnl?: number;
  realizedPnlPct?: number;
  closeSource: "broker_event" | "reconciliation";
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
  trade_id?: string;
  opened_at?: string;
};

export type AccountSnapshot = {
  equity: number;
  buyingPower: number;
  cash: number;
  lastEquity: number;
  updatedAt: string;
};

export type LifecycleUpdateResult = {
  changed: boolean;
  appliedFill?: TradeFill;
  order: LifecycleOrder;
  openTrade?: OpenTrade;
  closedTrade?: ClosedTrade;
};

export type PortfolioSnapshot = {
  positions: PortfolioPosition[];
  openTrades: OpenTrade[];
  closedTrades: ClosedTrade[];
  orders: LifecycleOrder[];
  account: AccountSnapshot | null;
  lastBrokerSyncAt: string | null;
};

type PersistedPortfolioState = {
  version: number;
  positionsBySymbol: Record<string, PortfolioPosition>;
  openTradesBySymbol: Record<string, OpenTrade>;
  closedTrades: ClosedTrade[];
  ordersById: Record<string, LifecycleOrder>;
  account: AccountSnapshot | null;
  seenEventKeys: string[];
  lastBrokerSyncAt: string | null;
};

type LegacyTradeLog = {
  symbol?: unknown;
  side?: unknown;
  timestamp?: unknown;
  price?: unknown;
  qty?: unknown;
  reason?: unknown;
};

function toFiniteNumber(value: NumericValue, fallback = 0): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveNumber(value: NumericValue, fallback = 0): number {
  const numeric = toFiniteNumber(value, fallback);
  return numeric > 0 ? numeric : fallback;
}

function toIsoTimestamp(value: unknown, fallback = new Date().toISOString()): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
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

function cloneFill(fill: TradeFill): TradeFill {
  return { ...fill };
}

function cloneOrder(order: LifecycleOrder): LifecycleOrder {
  return { ...order, fills: order.fills.map(cloneFill) };
}

function cloneOpenTrade(trade: OpenTrade): OpenTrade {
  return { ...trade, entryFills: trade.entryFills.map(cloneFill) };
}

function cloneClosedTrade(trade: ClosedTrade): ClosedTrade {
  return {
    ...trade,
    entryFills: trade.entryFills.map(cloneFill),
    exitFills: trade.exitFills.map(cloneFill),
  };
}

/**
 * Holds the broker-authoritative open-position snapshot and a durable local trade
 * lifecycle. Broker position/order data wins during reconciliation; application
 * metadata (strategy and lifecycle timestamps) is retained across restarts.
 */
export class Portfolio {
  private readonly filepath: string;
  private readonly restoration: Promise<void>;
  private readonly initialization: Promise<void>;
  private positionsBySymbol = new Map<string, PortfolioPosition>();
  private openTradesBySymbol = new Map<string, OpenTrade>();
  private closedTrades: ClosedTrade[] = [];
  private ordersById = new Map<string, LifecycleOrder>();
  private strategyBySymbol = new Map<string, string>();
  private legacyEntriesBySymbol = new Map<string, LegacyTradeLog>();
  private legacyTradeEvents: Array<{ symbol: string; timestamp: string }> = [];
  private seenEventKeys = new Set<string>();
  private account: AccountSnapshot | null = null;
  private lastBrokerSyncAt: string | null = null;
  private persistenceQueue: Promise<void> = Promise.resolve();

  constructor(
    filepath = process.env.PORTFOLIO_STATE_PATH ?? DEFAULT_PORTFOLIO_PATH,
  ) {
    this.filepath = filepath;
    this.restoration = this.restoreStateFromLocal();
    this.initialization = this.restoration.then(() =>
      this.restoreStrategyIndexFromTradeLogs(),
    );
  }

  /** Restores local state and derives historical strategy attribution from app logs. */
  public async initialize(): Promise<void> {
    await this.initialization;
  }

  /**
   * Replaces broker position data while retaining lifecycle metadata and fresh stream
   * marks. Missing broker positions are archived as reconciliation closures only when
   * the stream did not already record a broker-confirmed fill.
   */
  public async syncTrades(
    positions: BrokerPosition[],
    syncedAt = new Date().toISOString(),
  ): Promise<PortfolioPosition[]> {
    await this.initialize();

    const nextPositions = new Map<string, PortfolioPosition>();
    const observedSymbols = new Set<string>();

    for (const brokerPosition of positions) {
      if (!isBrokerPosition(brokerPosition)) continue;

      const symbol = brokerPosition.symbol;
      observedSymbols.add(symbol);
      let trade = this.openTradesBySymbol.get(symbol);
      if (!trade) {
        trade = this.createRecoveredOpenTrade(brokerPosition, syncedAt);
        this.openTradesBySymbol.set(symbol, trade);
      }

      const existingPosition = this.positionsBySymbol.get(symbol);
      const brokerMark = toFiniteNumber(brokerPosition.current_price);
      const retainedMark =
        existingPosition && this.hasFreshMark(existingPosition.marked_at)
          ? toFiniteNumber(existingPosition.current_price, brokerMark)
          : brokerMark;
      const mark = retainedMark > 0 ? retainedMark : brokerMark;

      nextPositions.set(
        symbol,
        this.withMark(brokerPosition, mark, existingPosition?.marked_at, trade),
      );
    }

    for (const [symbol, openTrade] of this.openTradesBySymbol) {
      if (observedSymbols.has(symbol)) continue;
      this.archiveReconciledClosure(openTrade, syncedAt);
      this.openTradesBySymbol.delete(symbol);
    }

    this.positionsBySymbol = nextPositions;
    this.lastBrokerSyncAt = toIsoTimestamp(syncedAt);
    await this.persist();
    return this.getPositions();
  }

  /** Updates the local mark and derived P&L without a broker REST request. */
  public updateMark(
    symbol: string,
    price: number,
    markedAt = new Date().toISOString(),
  ): boolean {
    if (!symbol || !Number.isFinite(price) || price <= 0) return false;

    const position = this.positionsBySymbol.get(symbol);
    if (!position || this.isOlderTimestamp(markedAt, position.marked_at)) {
      return false;
    }

    const trade = this.openTradesBySymbol.get(symbol);
    if (trade && price > trade.highWaterMark) {
      this.openTradesBySymbol.set(symbol, {
        ...trade,
        highWaterMark: price,
        lastUpdatedAt: toIsoTimestamp(markedAt),
      });
    }

    this.positionsBySymbol.set(
      symbol,
      this.withMark(position, price, markedAt, trade),
    );
    return true;
  }

  /**
   * Records a single broker order event. Fill events update order, open-trade, and
   * closed-trade state atomically in the local snapshot and are idempotent by event.
   */
  public async applyTradeUpdate(
    update: TradeUpdate,
    strategyHint?: string,
  ): Promise<LifecycleUpdateResult | undefined> {
    await this.initialize();
    const order = update.order;
    if (!order?.id || !order.symbol || (order.side !== "buy" && order.side !== "sell")) {
      return undefined;
    }

    const event = String(update.event);
    const eventTimestamp = this.getEventTimestamp(update);
    const eventKey = this.getEventKey(update, eventTimestamp);
    const priorOrder = this.ordersById.get(order.id);
    const lifecycleOrder = this.createOrUpdateOrder(
      priorOrder,
      order,
      eventTimestamp,
    );
    this.ordersById.set(order.id, lifecycleOrder);

    if (this.seenEventKeys.has(eventKey)) {
      return { changed: false, order: cloneOrder(lifecycleOrder) };
    }
    this.rememberEvent(eventKey);

    let appliedFill: TradeFill | undefined;
    let openTrade: OpenTrade | undefined;
    let closedTrade: ClosedTrade | undefined;

    if (event === "fill" || event === "partial_fill") {
      const fill = this.createFill(update, lifecycleOrder, eventTimestamp);
      if (fill) {
        lifecycleOrder.fills.push(fill);
        lifecycleOrder.filledQuantity = lifecycleOrder.fills.reduce(
          (total, candidate) => total + candidate.quantity,
          0,
        );
        lifecycleOrder.averageFillPrice = this.getWeightedAverage(
          lifecycleOrder.fills,
        );
        lifecycleOrder.filledAt = fill.filledAt;
        lifecycleOrder.status = event === "fill" ? "filled" : "partially_filled";
        appliedFill = fill;

        if (fill.side === "buy") {
          openTrade = this.applyEntryFill(order.symbol, fill, strategyHint);
        } else {
          const result = this.applyExitFill(order.symbol, fill);
          openTrade = result.openTrade;
          closedTrade = result.closedTrade;
        }
      }
    }

    this.ordersById.set(order.id, lifecycleOrder);
    await this.persist();

    return {
      changed: true,
      appliedFill: appliedFill ? cloneFill(appliedFill) : undefined,
      order: cloneOrder(lifecycleOrder),
      openTrade: openTrade ? cloneOpenTrade(openTrade) : undefined,
      closedTrade: closedTrade ? cloneClosedTrade(closedTrade) : undefined,
    };
  }

  public setAccount(account: {
    equity: NumericValue;
    buying_power: NumericValue;
    cash: NumericValue;
    last_equity: NumericValue;
  }, updatedAt = new Date().toISOString()): void {
    this.account = {
      equity: toFiniteNumber(account.equity),
      buyingPower: toFiniteNumber(account.buying_power),
      cash: toFiniteNumber(account.cash),
      lastEquity: toFiniteNumber(account.last_equity),
      updatedAt: toIsoTimestamp(updatedAt),
    };
    void this.persist();
  }

  public getAccount(): AccountSnapshot | null {
    return this.account ? { ...this.account } : null;
  }

  public getPositions(): PortfolioPosition[] {
    return Array.from(this.positionsBySymbol.values(), (position) => ({
      ...position,
    }));
  }

  public getPosition(symbol: string): PortfolioPosition | undefined {
    const position = this.positionsBySymbol.get(symbol);
    return position ? { ...position } : undefined;
  }

  public getOpenTrade(symbol: string): OpenTrade | undefined {
    const trade = this.openTradesBySymbol.get(symbol);
    return trade ? cloneOpenTrade(trade) : undefined;
  }

  public getOpenTrades(): OpenTrade[] {
    return Array.from(this.openTradesBySymbol.values(), cloneOpenTrade);
  }

  public getClosedTrades(): ClosedTrade[] {
    return this.closedTrades.map(cloneClosedTrade);
  }

  public getOrders(): LifecycleOrder[] {
    return Array.from(this.ordersById.values(), cloneOrder);
  }

  public getSnapshot(): PortfolioSnapshot {
    return {
      positions: this.getPositions(),
      openTrades: this.getOpenTrades(),
      closedTrades: this.getClosedTrades(),
      orders: this.getOrders(),
      account: this.getAccount(),
      lastBrokerSyncAt: this.lastBrokerSyncAt,
    };
  }

  public getSymbols(): string[] {
    return Array.from(this.positionsBySymbol.keys());
  }

  public hasPosition(symbol: string): boolean {
    return this.positionsBySymbol.has(symbol);
  }

  /** Returns symbols with a trade event on a UTC calendar day, without broker calls. */
  public getTradedSymbolsOn(date = new Date().toISOString().slice(0, 10)): string[] {
    const symbols = new Set<string>();
    const collect = (fills: TradeFill[], symbol: string) => {
      if (fills.some((fill) => fill.filledAt.slice(0, 10) === date)) {
        symbols.add(symbol);
      }
    };

    for (const trade of this.openTradesBySymbol.values()) {
      collect(trade.entryFills, trade.symbol);
    }
    for (const trade of this.closedTrades) {
      collect(trade.entryFills, trade.symbol);
      collect(trade.exitFills, trade.symbol);
    }
    for (const event of this.legacyTradeEvents) {
      if (event.timestamp.slice(0, 10) === date) symbols.add(event.symbol);
    }
    return Array.from(symbols);
  }

  /** Writes broker-sync and lifecycle changes serially so the local snapshot stays valid. */
  public async saveTradesToLocal(): Promise<void> {
    await this.persist();
  }

  private async restoreStrategyIndexFromTradeLogs(): Promise<void> {
    const history = (await getTradeHistory()) as LegacyTradeLog[];
    for (const record of history) {
      if (typeof record.symbol !== "string") continue;
      const timestamp = toIsoTimestamp(record.timestamp, "");
      if (timestamp) {
        this.legacyTradeEvents.push({ symbol: record.symbol, timestamp });
      }
      if (
        String(record.side).toLowerCase() !== "buy" ||
        typeof record.reason !== "string" ||
        record.reason === "Exit"
      ) {
        continue;
      }

      const existing = this.legacyEntriesBySymbol.get(record.symbol);
      if (
        !existing ||
        Date.parse(toIsoTimestamp(record.timestamp, "")) >=
          Date.parse(toIsoTimestamp(existing.timestamp, ""))
      ) {
        this.strategyBySymbol.set(record.symbol, record.reason);
        this.legacyEntriesBySymbol.set(record.symbol, record);
      }
    }
  }

  private async restoreStateFromLocal(): Promise<void> {
    if (!existsSync(this.filepath)) return;

    try {
      const parsed: unknown = JSON.parse(await readFile(this.filepath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Portfolio state must be an object.");
      }

      if (this.isCurrentState(parsed)) {
        this.positionsBySymbol = this.toPositionMap(parsed.positionsBySymbol);
        this.openTradesBySymbol = this.toOpenTradeMap(parsed.openTradesBySymbol);
        this.closedTrades = Array.isArray(parsed.closedTrades)
          ? parsed.closedTrades.filter((trade) => this.isClosedTrade(trade))
          : [];
        this.ordersById = this.toOrderMap(parsed.ordersById);
        this.account = this.isAccountSnapshot(parsed.account) ? parsed.account : null;
        this.seenEventKeys = new Set(
          Array.isArray(parsed.seenEventKeys)
            ? parsed.seenEventKeys.filter((key): key is string => typeof key === "string")
            : [],
        );
        this.lastBrokerSyncAt =
          typeof parsed.lastBrokerSyncAt === "string"
            ? parsed.lastBrokerSyncAt
            : null;
        return;
      }

      // Version-one files were position objects keyed by symbol. Preserve them as
      // recovery-only positions until the first live broker synchronization.
      this.positionsBySymbol = this.toPositionMap(parsed as Record<string, unknown>);
    } catch (error) {
      console.error("❌ [PORTFOLIO] Failed to restore local portfolio state:", error);
    }
  }

  private isCurrentState(value: object): value is PersistedPortfolioState {
    return (value as Partial<PersistedPortfolioState>).version === STATE_VERSION;
  }

  private toPositionMap(value: unknown): Map<string, PortfolioPosition> {
    const result = new Map<string, PortfolioPosition>();
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;

    for (const [symbol, position] of Object.entries(value)) {
      if (!isBrokerPosition(position) || position.symbol !== symbol) continue;
      const mark = toFiniteNumber(position.current_price);
      const markedAt =
        typeof position.marked_at === "string"
          ? position.marked_at
          : new Date().toISOString();
      result.set(symbol, this.withMark(position, mark, markedAt));
    }
    return result;
  }

  private toOpenTradeMap(value: unknown): Map<string, OpenTrade> {
    const result = new Map<string, OpenTrade>();
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;

    for (const [symbol, trade] of Object.entries(value)) {
      if (this.isOpenTrade(trade) && trade.symbol === symbol) {
        result.set(symbol, trade);
      }
    }
    return result;
  }

  private toOrderMap(value: unknown): Map<string, LifecycleOrder> {
    const result = new Map<string, LifecycleOrder>();
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;

    for (const [id, order] of Object.entries(value)) {
      if (this.isLifecycleOrder(order) && order.id === id) result.set(id, order);
    }
    return result;
  }

  private isLifecycleOrder(value: unknown): value is LifecycleOrder {
    if (!value || typeof value !== "object") return false;
    const order = value as Partial<LifecycleOrder>;
    return (
      typeof order.id === "string" &&
      typeof order.symbol === "string" &&
      (order.side === "buy" || order.side === "sell") &&
      Array.isArray(order.fills)
    );
  }

  private isOpenTrade(value: unknown): value is OpenTrade {
    if (!value || typeof value !== "object") return false;
    const trade = value as Partial<OpenTrade>;
    return (
      typeof trade.id === "string" &&
      typeof trade.symbol === "string" &&
      typeof trade.strategy === "string" &&
      typeof trade.openedAt === "string" &&
      Array.isArray(trade.entryFills) &&
      typeof trade.remainingQuantity === "number"
    );
  }

  private isClosedTrade(value: unknown): value is ClosedTrade {
    return (
      this.isOpenTrade(value) &&
      typeof (value as Partial<ClosedTrade>).closedAt === "string" &&
      Array.isArray((value as Partial<ClosedTrade>).exitFills)
    );
  }

  private isAccountSnapshot(value: unknown): value is AccountSnapshot {
    if (!value || typeof value !== "object") return false;
    const account = value as Partial<AccountSnapshot>;
    return (
      typeof account.equity === "number" &&
      typeof account.buyingPower === "number" &&
      typeof account.cash === "number" &&
      typeof account.lastEquity === "number" &&
      typeof account.updatedAt === "string"
    );
  }

  private createOrUpdateOrder(
    existing: LifecycleOrder | undefined,
    brokerOrder: BrokerOrder,
    eventTimestamp: string,
  ): LifecycleOrder {
    const next: LifecycleOrder = existing
      ? { ...existing, fills: existing.fills.map(cloneFill) }
      : {
          id: brokerOrder.id,
          symbol: brokerOrder.symbol,
          side: brokerOrder.side,
          status: brokerOrder.status ?? "unknown",
          updatedAt: eventTimestamp,
          filledQuantity: 0,
          fills: [],
        };

    next.clientOrderId = brokerOrder.client_order_id ?? next.clientOrderId;
    next.status = brokerOrder.status ?? next.status;
    next.submittedAt = brokerOrder.submitted_at ?? next.submittedAt;
    next.filledAt = brokerOrder.filled_at ?? next.filledAt;
    next.updatedAt = toIsoTimestamp(brokerOrder.updated_at, eventTimestamp);
    next.requestedQuantity = toPositiveNumber(
      brokerOrder.qty,
      next.requestedQuantity ?? 0,
    );
    return next;
  }

  private createFill(
    update: TradeUpdate,
    order: LifecycleOrder,
    eventTimestamp: string,
  ): TradeFill | undefined {
    const directQuantity = toPositiveNumber(update.fillQty ?? update.qty);
    const cumulativeQuantity = toPositiveNumber(update.order.filled_qty);
    const alreadyRecorded = order.fills.reduce(
      (total, fill) => total + fill.quantity,
      0,
    );
    const quantity =
      directQuantity > 0
        ? directQuantity
        : Math.max(cumulativeQuantity - alreadyRecorded, 0);
    const price = toPositiveNumber(update.price ?? update.order.filled_avg_price);
    if (!quantity || !price) return undefined;

    return {
      executionId:
        update.execution_id ??
        update.executionId ??
        `${order.id}:${eventTimestamp}:${quantity}:${price}`,
      orderId: order.id,
      side: order.side,
      price,
      quantity,
      filledAt: eventTimestamp,
    };
  }

  private applyEntryFill(
    symbol: string,
    fill: TradeFill,
    strategyHint?: string,
  ): OpenTrade {
    const current = this.openTradesBySymbol.get(symbol);
    const priorQuantity = current?.entryQuantity ?? 0;
    const entryQuantity = priorQuantity + fill.quantity;
    const averageEntryPrice = current
      ? (current.averageEntryPrice * priorQuantity + fill.price * fill.quantity) /
        entryQuantity
      : fill.price;
    const timestamp = fill.filledAt;
    const strategy =
      current?.strategy ??
      strategyHint ??
      this.strategyBySymbol.get(symbol) ??
      "UnknownStrategy";
    const trade: OpenTrade = {
      id: current?.id ?? `trade:${symbol}:${timestamp}`,
      symbol,
      strategy,
      openedAt: current?.openedAt ?? timestamp,
      openedOrderId: current?.openedOrderId ?? fill.orderId,
      entryFills: [...(current?.entryFills ?? []), fill],
      exitFills: current?.exitFills ?? [],
      entryQuantity,
      remainingQuantity: (current?.remainingQuantity ?? 0) + fill.quantity,
      averageEntryPrice,
      highWaterMark: Math.max(current?.highWaterMark ?? 0, fill.price),
      lastUpdatedAt: timestamp,
    };
    this.openTradesBySymbol.set(symbol, trade);
    this.strategyBySymbol.set(symbol, strategy);
    return trade;
  }

  private applyExitFill(
    symbol: string,
    fill: TradeFill,
  ): {
    openTrade?: OpenTrade;
    closedTrade?: ClosedTrade;
  } {
    let current = this.openTradesBySymbol.get(symbol);
    if (!current) {
      const position = this.positionsBySymbol.get(symbol);
      if (!position) return {};
      current = this.createRecoveredOpenTrade(position, fill.filledAt);
    }

    const exitQuantity = Math.min(fill.quantity, current.remainingQuantity);
    const remainingQuantity = Math.max(current.remainingQuantity - exitQuantity, 0);
    const exitFill = { ...fill, quantity: exitQuantity };
    const exitFills = [...current.exitFills, exitFill];

    if (remainingQuantity > 0) {
      const updated: OpenTrade = {
        ...current,
        exitFills,
        remainingQuantity,
        lastUpdatedAt: fill.filledAt,
      };
      this.openTradesBySymbol.set(symbol, updated);
      return { openTrade: updated };
    }

    const averageExitPrice = this.getWeightedAverage(exitFills);
    const proceeds = exitFills.reduce(
      (total, candidate) => total + candidate.price * candidate.quantity,
      0,
    );
    const basis = current.entryFills.length
      ? current.entryFills.reduce(
          (total, candidate) => total + candidate.price * candidate.quantity,
          0,
        )
      : current.averageEntryPrice * current.entryQuantity;
    const realizedPnl = proceeds - basis;
    const closedTrade: ClosedTrade = {
      ...current,
      remainingQuantity: 0,
      lastUpdatedAt: fill.filledAt,
      closedAt: fill.filledAt,
      closedOrderId: fill.orderId,
      exitFills,
      exitQuantity: exitFills.reduce((total, candidate) => total + candidate.quantity, 0),
      averageExitPrice,
      realizedPnl,
      realizedPnlPct: basis === 0 ? undefined : realizedPnl / basis,
      closeSource: "broker_event",
    };
    this.openTradesBySymbol.delete(symbol);
    this.addClosedTrade(closedTrade);
    return { closedTrade };
  }

  private createRecoveredOpenTrade(
    position: BrokerPosition,
    recoveredAt: string,
  ): OpenTrade {
    const legacyEntry = this.findLegacyEntry(position.symbol);
    const legacyEntryPrice =
      typeof legacyEntry?.price === "string" || typeof legacyEntry?.price === "number"
        ? legacyEntry.price
        : undefined;
    const entryPrice = toPositiveNumber(
      legacyEntryPrice,
      toPositiveNumber(position.avg_entry_price),
    );
    const quantity = toPositiveNumber(position.qty);
    const openedAt = toIsoTimestamp(legacyEntry?.timestamp, recoveredAt);
    const strategy =
      typeof legacyEntry?.reason === "string" && legacyEntry.reason !== "Exit"
        ? legacyEntry.reason
        : this.strategyBySymbol.get(position.symbol) ?? "UnknownStrategy";
    const entryFills = entryPrice > 0 && quantity > 0
      ? [
          {
            executionId: `recovered:${position.symbol}:${openedAt}`,
            orderId: "recovered",
            side: "buy" as const,
            price: entryPrice,
            quantity,
            filledAt: openedAt,
          },
        ]
      : [];

    return {
      id: `recovered:${position.symbol}:${openedAt}`,
      symbol: position.symbol,
      strategy,
      openedAt,
      entryFills,
      exitFills: [],
      entryQuantity: quantity,
      remainingQuantity: quantity,
      averageEntryPrice: toPositiveNumber(position.avg_entry_price, entryPrice),
      highWaterMark: toPositiveNumber(position.current_price, entryPrice),
      lastUpdatedAt: toIsoTimestamp(recoveredAt),
    };
  }

  private findLegacyEntry(symbol: string): LegacyTradeLog | undefined {
    return this.legacyEntriesBySymbol.get(symbol);
  }

  private archiveReconciledClosure(openTrade: OpenTrade, closedAt: string): void {
    const closedTrade: ClosedTrade = {
      ...openTrade,
      remainingQuantity: 0,
      lastUpdatedAt: toIsoTimestamp(closedAt),
      closedAt: toIsoTimestamp(closedAt),
      exitFills: [],
      exitQuantity: 0,
      closeSource: "reconciliation",
    };
    this.addClosedTrade(closedTrade);
  }

  private addClosedTrade(trade: ClosedTrade): void {
    if (this.closedTrades.some((candidate) => candidate.id === trade.id)) return;
    this.closedTrades = [trade, ...this.closedTrades].slice(0, MAX_CLOSED_TRADES);
  }

  private getEventTimestamp(update: TradeUpdate): string {
    return toIsoTimestamp(
      update.timestamp ??
        update.order.filled_at ??
        update.order.updated_at ??
        update.order.submitted_at ??
        update.order.created_at,
    );
  }

  private getEventKey(update: TradeUpdate, timestamp: string): string {
    const executionId = update.execution_id ?? update.executionId;
    if (executionId) return `execution:${executionId}`;
    return [
      update.order.id,
      update.event,
      timestamp,
      update.fillQty ?? update.qty ?? update.order.filled_qty ?? "",
      update.price ?? update.order.filled_avg_price ?? "",
    ].join(":");
  }

  private rememberEvent(eventKey: string): void {
    this.seenEventKeys.add(eventKey);
    while (this.seenEventKeys.size > MAX_SEEN_EVENT_KEYS) {
      const oldest = this.seenEventKeys.values().next().value as string | undefined;
      if (!oldest) break;
      this.seenEventKeys.delete(oldest);
    }
  }

  private getWeightedAverage(fills: TradeFill[]): number | undefined {
    const quantity = fills.reduce((total, fill) => total + fill.quantity, 0);
    if (quantity === 0) return undefined;
    return (
      fills.reduce((total, fill) => total + fill.price * fill.quantity, 0) /
      quantity
    );
  }

  private isOlderTimestamp(incoming: string, existing: string): boolean {
    const incomingTime = Date.parse(incoming);
    const existingTime = Date.parse(existing);
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
    lifecycleTrade?: OpenTrade,
  ): PortfolioPosition {
    const quantity = toFiniteNumber(position.qty);
    const entryPrice = toFiniteNumber(position.avg_entry_price);
    const currentPrice = mark > 0 ? mark : toFiniteNumber(position.current_price);
    const marketValue = currentPrice * quantity;
    const unrealizedPl = (currentPrice - entryPrice) * quantity;
    const costBasis = Math.abs(entryPrice * quantity);
    const strategyConfig = MASTER_WATCHLIST.get(position.symbol);
    const trade = lifecycleTrade ?? this.openTradesBySymbol.get(position.symbol);

    return {
      ...position,
      current_price: currentPrice.toString(),
      market_value: marketValue.toString(),
      unrealized_pl: unrealizedPl.toString(),
      unrealized_plpc: (costBasis === 0 ? 0 : unrealizedPl / costBasis).toString(),
      ...(strategyConfig
        ? {
            strategy: trade?.strategy ?? strategyConfig.strategy,
            takeProfitPct: strategyConfig.takeProfitPct,
            stopLossPct: strategyConfig.stopLossPct,
            totalRisk: strategyConfig.totalRisk,
            expiration: strategyConfig.expiration,
          }
        : trade
          ? { strategy: trade.strategy }
          : {}),
      ...(trade
        ? {
            trade_id: trade.id,
            opened_at: trade.openedAt,
          }
        : {}),
      marked_at: toIsoTimestamp(markedAt),
    };
  }

  private async persist(): Promise<void> {
    const state = this.createPersistedState();
    this.persistenceQueue = this.persistenceQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          await mkdir(path.dirname(this.filepath), { recursive: true });
          await writeFile(this.filepath, JSON.stringify(state, null, 2), "utf8");
        } catch (error) {
          console.error("❌ [PORTFOLIO] Failed to write local portfolio state:", error);
        }
      });
    await this.persistenceQueue;
  }

  private createPersistedState(): PersistedPortfolioState {
    return {
      version: STATE_VERSION,
      positionsBySymbol: Object.fromEntries(this.positionsBySymbol),
      openTradesBySymbol: Object.fromEntries(this.openTradesBySymbol),
      closedTrades: this.closedTrades,
      ordersById: Object.fromEntries(this.ordersById),
      account: this.account,
      seenEventKeys: Array.from(this.seenEventKeys),
      lastBrokerSyncAt: this.lastBrokerSyncAt,
    };
  }
}
