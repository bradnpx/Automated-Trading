import type {
  TradeExitReason,
  TradeLifecycle,
  TradeLifecycleProfile,
  TradeRecord,
} from "@my-platform/types";

import {
  TRADE_LOG_SYNC_INTERVAL_HOURS,
  TRAILING_STOP_LOSS_ENABLED,
} from "../config/config.js";
import { TradeJournal } from "../middleware/logger.js";
import {
  type LifecycleFillInput,
  TradeLifecycleStore,
} from "../models/tradeLifecycleStore.js";

const FULL_SYNC_LOOKBACK = "2016-01-01T00:00:00.000Z";
const SYNC_BATCH_SIZE = 500;

interface AlpacaFilledOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type?: string;
  order_type?: string;
  filled_qty?: string;
  filled_avg_price?: string;
  filled_at?: string;
  submitted_at?: string;
}

interface AlpacaOrderClient {
  getOrders(query: {
    status: string;
    direction: string;
    after: string;
    until: undefined;
    limit: number;
    nested: boolean;
    symbols: string[];
  }): Promise<unknown>;
}

interface TradeLogSyncDependencies {
  now?: () => Date;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

interface SyncSummary {
  syncedAt: string;
  fetchedOrders: number;
  reconciledOrders: number;
}

export class TradeLogSyncService {
  private readonly now: () => Date;
  private readonly setTimeoutFn: typeof globalThis.setTimeout;
  private readonly clearTimeoutFn: typeof globalThis.clearTimeout;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private schedulerActive = false;
  private inFlight: Promise<SyncSummary | undefined> | undefined;

  constructor(
    private readonly alpaca: AlpacaOrderClient,
    private readonly lifecycleStore: TradeLifecycleStore,
    private readonly journal: TradeJournal,
    private readonly intervalHours = TRADE_LOG_SYNC_INTERVAL_HOURS,
    dependencies: TradeLogSyncDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.setTimeoutFn = dependencies.setTimeout ?? globalThis.setTimeout;
    this.clearTimeoutFn = dependencies.clearTimeout ?? globalThis.clearTimeout;
  }

  public start(): void {
    if (this.schedulerActive) return;
    this.schedulerActive = true;
    void this.scheduleNext();
  }

  public stop(): void {
    this.schedulerActive = false;
    if (this.timer) this.clearTimeoutFn(this.timer);
    this.timer = undefined;
  }

  public async syncIfDue(): Promise<SyncSummary | undefined> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.runIfDue();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async runIfDue(): Promise<SyncSummary | undefined> {
    const lastSyncedAt = await this.lifecycleStore.getLastTradeLogSyncAt();
    if (!isDue(lastSyncedAt, this.now(), this.intervalHours)) return undefined;

    const snapshotStartedAt = this.now().toISOString();
    const orders = await this.getFilledOrders();
    const localRecords = await this.journal.getTradeHistory();
    const fills = orders
      .map((order) => toLifecycleFill(order, localRecords))
      .filter((fill): fill is LifecycleFillInput => fill !== undefined);

    const reconciliation = await this.lifecycleStore.reconcileBrokerFills(
      fills,
      snapshotStartedAt,
    );
    const journalRecords = fills.map((fill) =>
      toTradeRecord(
        fill,
        localRecords,
        reconciliation.lifecycleByOrderId.get(fill.orderId),
        snapshotStartedAt,
      ),
    );
    await this.journal.reconcileBrokerRecords(
      journalRecords,
      snapshotStartedAt,
    );
    await this.lifecycleStore.markTradeLogSynced(snapshotStartedAt);

    const summary = {
      syncedAt: snapshotStartedAt,
      fetchedOrders: orders.length,
      reconciledOrders: fills.length,
    };
    console.log(
      `✅ [TRADE LOG SYNC] Reconciled ${summary.reconciledOrders} filled Alpaca orders at ${summary.syncedAt}.`,
    );
    return summary;
  }

  private async scheduleNext(minimumDelay = 0): Promise<void> {
    try {
      const lastSyncedAt = await this.lifecycleStore.getLastTradeLogSyncAt();
      if (!this.schedulerActive) return;

      const dueDelay = millisecondsUntilDue(
        lastSyncedAt,
        this.now(),
        this.intervalHours,
      );
      this.timer = this.setTimeoutFn(
        () => {
          this.timer = undefined;
          void this.runScheduledSync();
        },
        Math.max(minimumDelay, dueDelay),
      );
    } catch (error) {
      console.error(
        "❌ [TRADE LOG SYNC] Failed to schedule reconciliation:",
        error,
      );
    }
  }

  private async runScheduledSync(): Promise<void> {
    let failed = false;
    try {
      await this.syncIfDue();
    } catch (error) {
      failed = true;
      console.error("❌ [TRADE LOG SYNC] Reconciliation failed:", error);
    } finally {
      if (this.schedulerActive) {
        await this.scheduleNext(
          failed ? hoursToMilliseconds(this.intervalHours) : 0,
        );
      }
    }
  }

  private async getFilledOrders(): Promise<AlpacaFilledOrder[]> {
    const ordersById = new Map<string, AlpacaFilledOrder>();
    let after = FULL_SYNC_LOOKBACK;

    while (true) {
      const response = await this.alpaca.getOrders({
        status: "closed",
        direction: "asc",
        after,
        until: undefined,
        limit: SYNC_BATCH_SIZE,
        nested: false,
        symbols: [],
      });

      if (!Array.isArray(response)) {
        throw new Error("Alpaca trade-log sync returned an invalid order list");
      }

      const batch = response.filter(isFilledOrder);
      for (const order of batch) ordersById.set(order.id, order);
      if (response.length < SYNC_BATCH_SIZE) break;

      const cursor =
        response.at(-1)?.submitted_at ?? response.at(-1)?.filled_at;
      if (!cursor || !Number.isFinite(Date.parse(cursor))) {
        throw new Error(
          "Alpaca trade-log sync could not advance its order cursor",
        );
      }

      if (cursor <= after) {
        throw new Error(
          "Alpaca trade-log sync received a non-advancing order cursor",
        );
      }
      after = cursor;
    }

    return Array.from(ordersById.values()).sort(
      (left, right) =>
        Date.parse(left.filled_at ?? "") - Date.parse(right.filled_at ?? ""),
    );
  }
}

function toLifecycleFill(
  order: AlpacaFilledOrder,
  localRecords: TradeRecord[],
): LifecycleFillInput | undefined {
  const quantity = Number(order.filled_qty);
  const price = Number(order.filled_avg_price);
  const filledAt = order.filled_at;
  if (!(quantity > 0) || !(price > 0) || !filledAt) return undefined;

  const localRecord = findLocalRecord(localRecords, order.id);
  return {
    executionId: localRecord?.execution_id ?? `alpaca-order:${order.id}`,
    orderId: order.id,
    orderType:
      order.type ?? order.order_type ?? localRecord?.order_type ?? "market",
    side: order.side,
    symbol: order.symbol,
    price,
    quantity,
    filledAt,
    profile: profileFromRecord(localRecord),
    ...(reasonFromRecord(localRecord)
      ? { reason: reasonFromRecord(localRecord) }
      : {}),
  };
}

function toTradeRecord(
  fill: LifecycleFillInput,
  localRecords: TradeRecord[],
  lifecycle: TradeLifecycle | undefined,
  syncedAt: string,
): TradeRecord {
  const existing = findLocalRecord(localRecords, fill.orderId);
  const profile = lifecycle?.profile ?? fill.profile;
  const isSell = fill.side === "sell";
  const reason = existing?.reason ?? (isSell ? "EXIT" : profile.strategy);
  const pnl =
    isSell && lifecycle
      ? (fill.price - lifecycle.averageEntryPrice) * fill.quantity
      : 0;
  const pnlPct =
    isSell && lifecycle && lifecycle.averageEntryPrice > 0
      ? (fill.price - lifecycle.averageEntryPrice) / lifecycle.averageEntryPrice
      : 0;
  const winStatus = !isSell
    ? "OPENING"
    : pnl > 0
      ? "WIN"
      : pnl < 0
        ? "LOSS"
        : "BREAKEVEN";

  return {
    symbol: fill.symbol,
    side: fill.side,
    qty: fill.quantity.toString(),
    price: fill.price.toString(),
    ...(lifecycle ? { lifecycle_id: lifecycle.id } : {}),
    order_id: fill.orderId,
    execution_id: fill.executionId,
    order_type: fill.orderType,
    strategy: existing?.strategy ?? profile.strategy,
    take_profit_pct: existing?.take_profit_pct ?? profile.takeProfitPct,
    stop_loss_pct: existing?.stop_loss_pct ?? profile.stopLossPct,
    trailing_stop_loss:
      existing?.trailing_stop_loss ?? profile.trailingStopLoss,
    pnl,
    pnl_pct: pnlPct,
    timestamp: fill.filledAt || syncedAt,
    reason,
    win_status: winStatus,
  };
}

function profileFromRecord(
  record: TradeRecord | undefined,
): TradeLifecycleProfile {
  return {
    strategy: record?.strategy ?? "UnknownStrategy",
    takeProfitPct: record?.take_profit_pct ?? 0,
    stopLossPct: record?.stop_loss_pct ?? 0,
    trailingStopLoss: record?.trailing_stop_loss ?? TRAILING_STOP_LOSS_ENABLED,
  };
}

function reasonFromRecord(
  record: TradeRecord | undefined,
): TradeExitReason | undefined {
  if (!record || record.side !== "sell") return undefined;
  return isTradeExitReason(record.reason) ? record.reason : undefined;
}

function findLocalRecord(
  records: TradeRecord[],
  orderId: string,
): TradeRecord | undefined {
  return records.find((record) => record.order_id === orderId);
}

function isFilledOrder(value: unknown): value is AlpacaFilledOrder {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const order = value as Partial<AlpacaFilledOrder>;
  return (
    typeof order.id === "string" &&
    typeof order.symbol === "string" &&
    (order.side === "buy" || order.side === "sell") &&
    typeof order.filled_qty === "string" &&
    typeof order.filled_avg_price === "string" &&
    typeof order.filled_at === "string"
  );
}

function isTradeExitReason(value: string): value is TradeExitReason {
  return [
    "TAKE_PROFIT",
    "TAKE_PROFIT_HALF",
    "TRAILING_STOP_LOSS",
    "STOP_LOSS",
    "STRATEGY_SELL",
    "MANUAL_CLOSE",
    "TRAILING_STOP_SETUP_FAILED",
    "EXIT",
  ].includes(value);
}

function isDue(
  lastSyncedAt: string | undefined,
  now: Date,
  intervalHours: number,
): boolean {
  if (!lastSyncedAt) return true;
  const lastSyncedAtMs = Date.parse(lastSyncedAt);
  if (!Number.isFinite(lastSyncedAtMs)) return true;
  return now.getTime() - lastSyncedAtMs >= hoursToMilliseconds(intervalHours);
}

function millisecondsUntilDue(
  lastSyncedAt: string | undefined,
  now: Date,
  intervalHours: number,
): number {
  if (!lastSyncedAt) return 0;
  const lastSyncedAtMs = Date.parse(lastSyncedAt);
  if (!Number.isFinite(lastSyncedAtMs)) return 0;
  return Math.max(
    0,
    lastSyncedAtMs + hoursToMilliseconds(intervalHours) - now.getTime(),
  );
}

function hoursToMilliseconds(hours: number): number {
  return hours * 60 * 60 * 1000;
}
