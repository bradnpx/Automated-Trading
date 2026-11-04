import { randomUUID } from "node:crypto";

import type {
  RemainderProtection,
  TradeExitReason,
  TradeLifecycle,
} from "@my-platform/types";

import type { Executor, ProtectionBrokerOrder } from "./executor.js";
import {
  LifecycleIdentityError,
  TradeLifecycleStore,
} from "./models/tradeLifecycleStore.js";
import {
  advanceProtection,
  createHalfProtection,
  latchProtectionExit,
} from "./protectionState.js";

interface PositionRiskState {
  hasPosition(symbol: string): boolean;
  markPendingExit(symbol: string): void;
  clearPendingExit(symbol: string): void;
  setRemainderProtection(symbol: string, protection: RemainderProtection): void;
  blockNewExposure(symbol: string): void;
  suppressUnsupportedHalf?(symbol: string): void;
  syncPositions(): Promise<unknown>;
}

interface ProtectionBroadcaster {
  broadcastSignal(signal: {
    symbol: string;
    action: "HOLD" | "SELL";
    confidence: number;
    reason: string;
  }): void;
}

export interface RemainderExecutionPolicy {
  extendedLimitOffset: number;
  maxPriceAgeMs: number;
  repriceIntervalMs: number;
  maxReplacements: number;
}

interface TrackedProtection {
  lifecycle: TradeLifecycle;
  state: RemainderProtection;
  durableRevision: number;
  persistence: Promise<void>;
  writeError?: string;
  running: boolean;
  retryAt: number;
}

interface FreshPrice {
  price: number;
  timestamp: string;
}

const TERMINAL = new Set([
  "filled",
  "canceled",
  "expired",
  "rejected",
  "replaced",
]);
const SHARE_EPSILON = 0.000_000_001;
const PRICE_MAX_AGE_MS = 10_000;

/** Local protection is durable risk state, not a claim of broker-held outage cover. */
export class RemainderProtectionController {
  private readonly tracked = new Map<string, TrackedProtection>();
  private readonly prices = new Map<string, FreshPrice>();
  private readonly observedFillTotals = new Map<string, number>();
  private ready = false;
  private initializationError?: string;
  private initializing = false;
  private startupRetryAt = 0;

  constructor(
    private readonly store: TradeLifecycleStore,
    private readonly positions: PositionRiskState,
    private readonly executor: Pick<
      Executor,
      | "submitProtectionExit"
      | "getProtectionOrder"
      | "getProtectionSnapshot"
      | "cancelProtectionOrder"
      | "getHalfExitQuantity"
    > &
      Partial<Pick<Executor, "getProtectionOrderById">>,
    private readonly broadcaster: ProtectionBroadcaster,
    private readonly policy?: RemainderExecutionPolicy,
    private readonly now: () => Date = () => new Date(),
    private readonly isEnabled: () => boolean = () => true,
  ) {}

  public isReady(): boolean {
    return (
      this.ready &&
      !this.initializationError &&
      this.store.getPersistenceStatus().healthy
    );
  }

  public manages(symbol: string): boolean {
    return (
      this.tracked.has(symbol) &&
      this.tracked.get(symbol)?.state.phase !== "closed"
    );
  }

  public getStatus() {
    return {
      ready: this.isReady(),
      initializationError: this.initializationError,
      persistence: this.store.getPersistenceStatus(),
      protections: Array.from(this.tracked, ([symbol, item]) => ({
        symbol,
        lifecycleId: item.lifecycle.id,
        mode: item.state.nativeOrderId ? "local-with-existing-native" : "local",
        ...structuredClone(item.state),
        inFlight: item.running,
        durableRevision: item.durableRevision,
        persistenceError: item.writeError,
        priceStale: !this.freshPrice(symbol),
      })),
    };
  }

  public async initialize(): Promise<void> {
    if (this.initializing) return;
    this.initializing = true;
    try {
      for (const lifecycle of await this.store.getOpenLifecycles()) {
        if (!lifecycle.protection || this.tracked.has(lifecycle.symbol))
          continue;
        this.track(lifecycle, lifecycle.protection);
      }
      // No entries are permitted until saved orders/quantities have been examined.
      for (const symbol of this.tracked.keys()) await this.reconcile(symbol);
      this.ready = true;
      this.initializationError = undefined;
      for (const [symbol, item] of this.tracked) {
        if (item.state.exit || !item.state.halfExit.completed)
          this.schedule(symbol);
      }
    } catch (error: unknown) {
      this.initializationError = errorMessage(error);
      this.ready = false;
      this.startupRetryAt = this.now().getTime() + 5_000;
      console.error(
        "[PROTECTION] Startup recovery requires attention:",
        this.initializationError,
      );
    } finally {
      this.initializing = false;
    }
  }

  /** Called synchronously before any asynchronous work so a recovered tick cannot erase a breach. */
  public onPrice(symbol: string, price: number, timestamp: string): boolean {
    const time = Date.parse(timestamp);
    const previous = this.prices.get(symbol);
    const age = this.now().getTime() - time;
    if (
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(time) ||
      age > PRICE_MAX_AGE_MS ||
      age < -1_000 ||
      (previous && time < Date.parse(previous.timestamp))
    )
      return false;
    this.prices.set(symbol, { price, timestamp });
    const item = this.tracked.get(symbol);
    if (!item || item.state.phase === "closed") return true;
    const alreadyLatched = Boolean(item.state.exit);
    let next = item.state;
    if (next.halfExit.completed) {
      next = advanceProtection(next, price, timestamp);
      if (price < next.effectiveStop && !next.exit) {
        next = latchProtectionExit(
          next,
          newClientId(),
          price < next.entryPrice
            ? "ENTRY_PRICE_BACKSTOP"
            : "TRAILING_STOP_LOSS",
          this.now().toISOString(),
        );
      }
    } else if (
      !next.exit &&
      price <=
        next.entryPrice *
          (1 - Math.abs(item.lifecycle.profile.stopLossPct) / 100)
    ) {
      // An unfilled/partial half-sale must not disable the original loss guard.
      next = latchProtectionExit(
        next,
        newClientId(),
        "STOP_LOSS",
        this.now().toISOString(),
      );
    }
    if (next.revision !== item.state.revision) this.update(symbol, next);
    else item.state = next;
    if (!alreadyLatched && next.exit) item.retryAt = 0;
    if (next.exit && this.now().getTime() >= item.retryAt)
      this.schedule(symbol);
    return true;
  }

  public async startHalfExit(
    symbol: string,
    entryPrice: number,
    totalQuantity: number,
  ): Promise<void> {
    if (this.manages(symbol)) return;
    const lifecycle = await this.store.getOpenLifecycle(symbol);
    if (!lifecycle || !lifecycle.profile.trailingStopLoss)
      throw new Error(`Missing trailing lifecycle for ${symbol}`);
    let target: number;
    try {
      target = await this.executor.getHalfExitQuantity(symbol, totalQuantity);
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (message.startsWith("Cannot split")) {
        this.positions.suppressUnsupportedHalf?.(symbol);
        this.positions.blockNewExposure(symbol);
        this.alert(
          symbol,
          `UNSUPPORTED_HALF_EXIT: ${message}; original loss guard remains active`,
        );
      }
      throw error;
    }
    const state = createHalfProtection(
      entryPrice,
      target,
      newClientId(),
      this.now().toISOString(),
    );
    this.track(lifecycle, state);
    this.positions.markPendingExit(symbol);
    this.queueSave(symbol);
    await this.flush(symbol);
    await this.drive(symbol);
  }

  /** Route strategy/manual closes for a protected lifecycle through the same durable intent. */
  public async requestExit(
    symbol: string,
    reason: TradeExitReason,
  ): Promise<void> {
    const item = this.tracked.get(symbol);
    if (!item) throw new Error(`No protected lifecycle for ${symbol}`);
    if (!item.state.exit)
      this.update(
        symbol,
        latchProtectionExit(
          item.state,
          newClientId(),
          reason,
          this.now().toISOString(),
        ),
      );
    this.positions.markPendingExit(symbol);
    await this.flush(symbol);
    await this.drive(symbol);
  }

  /** Stream orders are observations, never evidence that a submission is already a fill. */
  public observeOrder(symbol: string, order: ProtectionBrokerOrder): void {
    const item = this.tracked.get(symbol);
    if (!item) return;
    const state = item.state;
    const cumulative = Number(order.filled_qty ?? 0);
    const fillsAdvanced =
      Number.isFinite(cumulative) &&
      cumulative > (this.observedFillTotals.get(order.id) ?? 0);
    if (Number.isFinite(cumulative) && cumulative >= 0)
      this.observedFillTotals.set(
        order.id,
        Math.max(cumulative, this.observedFillTotals.get(order.id) ?? 0),
      );
    const matchesHalf =
      order.id === state.halfExit.orderId ||
      order.client_order_id === state.halfExit.clientOrderId;
    const matchesExit =
      state.exit &&
      (order.id === state.exit.orderId ||
        order.client_order_id === state.exit.clientOrderId);
    let next = state;
    if (matchesHalf) {
      const filled = Number(order.filled_qty ?? 0);
      if (!Number.isFinite(filled) || filled < 0) return;
      const adoptLegacyClient =
        next.halfExit.clientOrderId.startsWith("legacy-half:") &&
        Boolean(order.client_order_id);
      if (
        order.id !== next.halfExit.orderId ||
        filled > (next.halfExit.orderFilledQuantity ?? 0) ||
        adoptLegacyClient
      ) {
        next = {
          ...next,
          revision: next.revision + 1,
          halfExit: {
            ...next.halfExit,
            orderId: order.id,
            clientOrderId:
              adoptLegacyClient && order.client_order_id
                ? order.client_order_id
                : next.halfExit.clientOrderId,
            filledQuantity:
              next.halfExit.filledQuantity +
              Math.max(0, filled - (next.halfExit.orderFilledQuantity ?? 0)),
            orderFilledQuantity: Math.max(
              next.halfExit.orderFilledQuantity ?? 0,
              filled,
            ),
          },
        };
      }
      if (
        !next.halfExit.completed &&
        next.halfExit.filledQuantity + SHARE_EPSILON >=
          next.halfExit.targetQuantity
      ) {
        next = this.completeHalf(symbol, next);
      } else if (
        !next.halfExit.completed &&
        TERMINAL.has(order.status) &&
        order.status !== "filled" &&
        !next.exit &&
        next.phase !== "recovery-required"
      ) {
        next = {
          ...next,
          revision: next.revision + 1,
          phase: "recovery-required",
          lastError: `Half-exit ${order.status}; confirmed ${filled} shares`,
        };
      }
    }
    if (matchesExit && next.exit) {
      const phase = TERMINAL.has(order.status)
        ? "remainder-exit-pending"
        : "remainder-exit-working";
      const status = TERMINAL.has(order.status) ? "pending" : "working";
      if (
        next.exit.orderId !== order.id ||
        next.phase !== phase ||
        next.exit.status !== status
      ) {
        next = {
          ...next,
          revision: next.revision + 1,
          phase,
          exit: { ...next.exit, orderId: order.id, status },
        };
      }
    }
    if (order.id === next.nativeOrderId && TERMINAL.has(order.status)) {
      next = {
        ...next,
        revision: next.revision + 1,
        nativeOrderId: undefined,
        lastError: `Native protection ${order.status}; local floor retained`,
      };
    }
    if (next !== state || fillsAdvanced) {
      if (next !== state) this.update(symbol, next);
      if (TERMINAL.has(order.status) || fillsAdvanced) item.retryAt = 0;
      if (this.ready) this.schedule(symbol);
    }
  }

  public async tick(): Promise<void> {
    if (!this.ready && this.now().getTime() >= this.startupRetryAt) {
      await this.initialize();
    }
    for (const [symbol, item] of this.tracked) {
      if (item.state.phase !== "closed" && this.now().getTime() >= item.retryAt)
        this.schedule(symbol);
    }
  }

  public async flush(symbol?: string): Promise<void> {
    if (symbol) await this.tracked.get(symbol)?.persistence;
    else
      await Promise.all(
        Array.from(this.tracked.values(), (item) => item.persistence),
      );
    const failed = symbol
      ? this.tracked.get(symbol)?.writeError
      : Array.from(this.tracked.values()).find((item) => item.writeError)
          ?.writeError;
    if (failed) throw new Error(failed);
  }

  private track(lifecycle: TradeLifecycle, state: RemainderProtection): void {
    this.tracked.set(lifecycle.symbol, {
      lifecycle: structuredClone(lifecycle),
      state: structuredClone(state),
      durableRevision: lifecycle.protection?.revision ?? 0,
      persistence: Promise.resolve(),
      running: false,
      retryAt:
        state.exit?.nextRetryAt &&
        Number.isFinite(Date.parse(state.exit.nextRetryAt))
          ? Date.parse(state.exit.nextRetryAt)
          : 0,
    });
    this.positions.setRemainderProtection(lifecycle.symbol, state);
    for (const fill of lifecycle.exitFills) {
      this.observedFillTotals.set(
        fill.orderId,
        (this.observedFillTotals.get(fill.orderId) ?? 0) + fill.quantity,
      );
    }
    if (state.exit || !state.halfExit.completed)
      this.positions.markPendingExit(lifecycle.symbol);
  }

  private update(symbol: string, state: RemainderProtection): void {
    const item = this.tracked.get(symbol);
    if (!item) return;
    item.state = state;
    this.positions.setRemainderProtection(symbol, state);
    if (state.exit) this.positions.markPendingExit(symbol);
    this.queueSave(symbol);
  }

  private queueSave(symbol: string): void {
    const item = this.tracked.get(symbol);
    if (!item) return;
    const snapshot = structuredClone(item.state);
    item.persistence = item.persistence
      .catch(() => undefined)
      .then(async () => {
        // recordFill/markBrokerClosed have already committed the terminal lifecycle.
        if (item.state.phase === "closed") return;
        try {
          const latest = await this.store.getOpenLifecycle(symbol);
          if (!latest || latest.id !== item.lifecycle.id) {
            this.closeInMemory(symbol);
            return;
          }
          const persisted = await this.store.saveProtection(
            symbol,
            {
              ...snapshot,
              trailingDistance:
                latest?.protection?.trailingDistance ??
                snapshot.trailingDistance,
              revision: Math.max(
                snapshot.revision,
                (latest?.protection?.revision ?? 0) + 1,
              ),
            },
            item.lifecycle.id,
          );
          if (persisted.protection) {
            const saved = persisted.protection;
            item.durableRevision = Math.max(
              item.durableRevision,
              saved.revision,
            );
            item.state = {
              ...item.state,
              revision: Math.max(item.state.revision, saved.revision),
              highWaterMark: Math.max(
                item.state.highWaterMark,
                saved.highWaterMark,
              ),
              effectiveStop: Math.max(
                item.state.effectiveStop,
                saved.effectiveStop,
              ),
              halfExit: {
                ...item.state.halfExit,
                completed:
                  item.state.halfExit.completed || saved.halfExit.completed,
              },
              exit: item.state.exit ?? saved.exit,
            };
            this.positions.setRemainderProtection(symbol, item.state);
          }
          item.writeError = undefined;
        } catch (error: unknown) {
          if (error instanceof LifecycleIdentityError) {
            this.closeInMemory(symbol);
            return;
          }
          if (this.isClosed(symbol)) {
            item.writeError = undefined;
            return;
          }
          item.writeError = errorMessage(error);
          this.positions.blockNewExposure(symbol);
          this.alert(symbol, `PERSISTENCE_FAILED: ${item.writeError}`);
        }
      });
  }

  private completeHalf(
    symbol: string,
    state: RemainderProtection,
  ): RemainderProtection {
    const price = this.freshPrice(symbol);
    const activation = price?.price;
    let next: RemainderProtection = {
      ...state,
      revision: state.revision + 1,
      halfExit: { ...state.halfExit, completed: true },
      phase: state.exit
        ? "remainder-exit-pending"
        : activation && activation > state.entryPrice
          ? "protected-remainder"
          : "recovery-required",
      highWaterMark: Math.max(
        state.highWaterMark,
        activation ?? state.entryPrice,
      ),
      trailingDistance:
        activation && activation > state.entryPrice
          ? activation - state.entryPrice
          : null,
      effectiveStop: Math.max(state.effectiveStop, state.entryPrice),
      activatedAt:
        activation && activation > state.entryPrice
          ? price?.timestamp
          : undefined,
      activationSource:
        activation && activation > state.entryPrice ? "trade" : undefined,
      lastPriceAt: price?.timestamp,
      calibrationRequired: false,
      lastError:
        activation && activation > state.entryPrice
          ? undefined
          : "Entry floor active; fresh positive trailing calibration unavailable",
    };
    if (activation && activation < next.effectiveStop && !next.exit)
      next = latchProtectionExit(
        next,
        newClientId(),
        "ENTRY_PRICE_BACKSTOP",
        this.now().toISOString(),
      );
    return next;
  }

  private freshPrice(symbol: string): FreshPrice | undefined {
    const price = this.prices.get(symbol);
    if (!price) return undefined;
    const age = this.now().getTime() - Date.parse(price.timestamp);
    return age >= -1_000 && age <= PRICE_MAX_AGE_MS ? price : undefined;
  }

  private schedule(symbol: string): void {
    if (!this.ready || !this.isEnabled()) return;
    void this.drive(symbol).catch((error: unknown) =>
      this.alert(symbol, `RECOVERY_FAILED: ${errorMessage(error)}`),
    );
  }

  private async drive(symbol: string): Promise<void> {
    const item = this.tracked.get(symbol);
    if (
      !item ||
      item.running ||
      item.state.phase === "closed" ||
      !this.isEnabled() ||
      this.now().getTime() < item.retryAt
    )
      return;
    item.running = true;
    try {
      // Retry a failed durable revision, but never submit an unpersisted new intent.
      if (item.writeError) this.queueSave(symbol);
      await this.flush(symbol);
      await this.reconcile(symbol);
      if (this.isClosed(symbol)) return;
      const state = item.state;
      if (state.exit) await this.driveRemainderExit(symbol);
      else if (!state.halfExit.completed) await this.driveHalfExit(symbol);
      else item.retryAt = this.now().getTime() + 5_000;
    } catch (error: unknown) {
      if (error instanceof LifecycleIdentityError) {
        this.closeInMemory(symbol);
        return;
      }
      const message = errorMessage(error);
      const latest = item.state;
      const attempts = latest.exit ? latest.exit.attempt + 1 : 1;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempts, 5));
      item.retryAt = this.now().getTime() + delay;
      this.update(symbol, {
        ...latest,
        revision: latest.revision + 1,
        lastError: message,
        ...(latest.exit
          ? {
              exit: {
                ...latest.exit,
                attempt: attempts,
                status: "unknown",
                nextRetryAt: new Date(item.retryAt).toISOString(),
              },
            }
          : {}),
      });
      this.alert(symbol, `EXIT_OR_RECOVERY_FAILED: ${message}`);
    } finally {
      item.running = false;
      if (item.state.exit && this.now().getTime() >= item.retryAt)
        this.schedule(symbol);
    }
  }

  private async reconcile(symbol: string): Promise<void> {
    const item = this.tracked.get(symbol);
    if (!item || item.state.phase === "closed") return;
    const identity = await this.store.getOpenLifecycle(symbol);
    if (!identity || identity.id !== item.lifecycle.id) {
      this.closeInMemory(symbol);
      return;
    }
    let snapshot = await this.executor.getProtectionSnapshot(symbol);
    if (item.state.nativeOrderId && this.executor.getProtectionOrderById) {
      const nativeOrder = await this.executor.getProtectionOrderById(
        item.state.nativeOrderId,
      );
      if (nativeOrder) await this.recordBrokerOrder(symbol, nativeOrder);
    }
    // Reconcile cumulative fills before comparing broker quantity to the ledger.
    for (const clientId of [
      item.state.halfExit.clientOrderId,
      item.state.exit?.clientOrderId,
    ]) {
      if (!clientId) continue;
      const legacyHalf =
        clientId.startsWith("legacy-half:") &&
        clientId === item.state.halfExit.clientOrderId;
      const order = legacyHalf
        ? item.state.halfExit.orderId && this.executor.getProtectionOrderById
          ? await this.executor.getProtectionOrderById(
              item.state.halfExit.orderId,
            )
          : undefined
        : await this.executor.getProtectionOrder(clientId);
      if (order) await this.recordBrokerOrder(symbol, order);
    }
    if (this.isClosed(symbol)) return;
    // Fill reconciliation can change quantity between the REST snapshot and order lookup.
    snapshot = await this.executor.getProtectionSnapshot(symbol);
    if (!snapshot.position) {
      await this.store.markBrokerClosed(symbol, item.lifecycle.id);
      this.closeInMemory(symbol);
      return;
    }
    const lifecycle = await this.store.getOpenLifecycle(symbol);
    if (lifecycle && lifecycle.id !== item.lifecycle.id) {
      this.closeInMemory(symbol);
      return;
    }
    if (lifecycle) item.lifecycle = lifecycle;
    if (
      !lifecycle ||
      snapshot.position.qty > lifecycle.remainingQuantity + SHARE_EPSILON
    ) {
      this.positions.blockNewExposure(symbol);
      throw new Error(
        `Unattributed/scale-in quantity for ${symbol}; reconcile lifecycle before automatic sale`,
      );
    }
    if (snapshot.position.qty < lifecycle.remainingQuantity - SHARE_EPSILON) {
      this.positions.blockNewExposure(symbol);
      throw new Error(
        `Unmatched external exit for ${symbol}; inspect lifecycle fills before automatic sale`,
      );
    }
    if (
      Math.abs(snapshot.position.entryPrice - lifecycle.averageEntryPrice) >
      Math.max(0.01, lifecycle.averageEntryPrice * 0.000_001)
    ) {
      this.positions.blockNewExposure(symbol);
      throw new Error(
        `Entry basis changed for ${symbol}; position identity requires review`,
      );
    }
    if (item.state.nativeOrderId) {
      const native = snapshot.orders.find(
        (order) => order.id === item.state.nativeOrderId,
      );
      if (!native)
        this.update(symbol, {
          ...item.state,
          revision: item.state.revision + 1,
          nativeOrderId: undefined,
          lastError: "Saved native order absent; local entry floor retained",
        });
      else {
        const stop = Number(native.stop_price);
        const high = Number(native.hwm);
        const distance = Number(native.trail_price);
        const verifiedDistance =
          Number.isFinite(distance) && distance > 0 ? distance : null;
        if (
          Number.isFinite(stop) &&
          stop > 0 &&
          Number.isFinite(high) &&
          high > 0 &&
          (stop > item.state.effectiveStop ||
            high > item.state.highWaterMark ||
            (item.state.trailingDistance === null && verifiedDistance !== null))
        ) {
          this.update(symbol, {
            ...item.state,
            revision: item.state.revision + 1,
            highWaterMark: Math.max(item.state.highWaterMark, high),
            effectiveStop: Math.max(
              item.state.effectiveStop,
              item.state.entryPrice,
              stop,
            ),
            trailingDistance: item.state.trailingDistance ?? verifiedDistance,
            calibrationRequired:
              item.state.trailingDistance === null && verifiedDistance === null,
            phase: item.state.exit
              ? item.state.phase
              : item.state.trailingDistance !== null ||
                  verifiedDistance !== null
                ? "protected-remainder"
                : "recovery-required",
            lastError:
              verifiedDistance === null && item.state.trailingDistance === null
                ? "Verified broker stop retained; fixed trailing distance remains unknown"
                : undefined,
          });
        }
      }
    }
    if (snapshot.price) {
      this.onPrice(symbol, snapshot.price.price, snapshot.price.timestamp);
      // Fresh post-fill activation is allowed for a NEW half-sale, never legacy migration.
      if (
        item.state.halfExit.completed &&
        item.state.trailingDistance === null &&
        !item.state.activatedAt &&
        !item.state.calibrationRequired
      ) {
        const price = this.freshPrice(symbol);
        if (price && price.price > item.state.entryPrice && !item.state.exit) {
          this.update(symbol, {
            ...item.state,
            revision: item.state.revision + 1,
            phase: "protected-remainder",
            trailingDistance: price.price - item.state.entryPrice,
            highWaterMark: Math.max(item.state.highWaterMark, price.price),
            activatedAt: price.timestamp,
            activationSource: "broker",
            lastError: undefined,
          });
        }
      }
    } else
      this.alert(
        symbol,
        "PRICE_STALE_OR_MISSING: saved entry floor retained; waiting for a fresh trade",
      );
    await this.flush(symbol);
  }

  private async recordBrokerOrder(
    symbol: string,
    order: ProtectionBrokerOrder,
  ): Promise<void> {
    const item = this.tracked.get(symbol);
    if (!item) return;
    this.observeOrder(symbol, order);
    const cumulative = Number(order.filled_qty ?? 0);
    const price = Number(order.filled_avg_price ?? 0);
    if (cumulative > 0 && price > 0) {
      const reason =
        order.client_order_id === item.state.halfExit.clientOrderId ||
        order.id === item.state.halfExit.orderId
          ? "TAKE_PROFIT_HALF"
          : (item.state.exit?.reason ?? "TRAILING_STOP_LOSS");
      const recorded = await this.store.recordFill({
        executionId: `reconciled:${order.id}:${cumulative}`,
        orderId: order.id,
        orderType: order.type ?? "market",
        side: "sell",
        symbol,
        price,
        quantity: cumulative,
        cumulativeQuantity: cumulative,
        cumulativePrice: true,
        filledAt: order.filled_at ?? this.now().toISOString(),
        profile: item.lifecycle.profile,
        reason,
      });
      if (recorded.lifecycle?.status === "closed") this.closeInMemory(symbol);
    }
  }

  private async driveHalfExit(symbol: string): Promise<void> {
    const item = this.tracked.get(symbol);
    if (!item) return;
    const half = item.state.halfExit;
    const legacy = half.clientOrderId.startsWith("legacy-half:");
    const existing =
      legacy && half.orderId && this.executor.getProtectionOrderById
        ? await this.executor.getProtectionOrderById(half.orderId)
        : legacy
          ? undefined
          : await this.executor.getProtectionOrder(half.clientOrderId);
    if (existing) {
      await this.recordBrokerOrder(symbol, existing);
      if (item.state.halfExit.completed || item.state.exit) return;
      if (!TERMINAL.has(existing.status)) {
        item.retryAt = this.now().getTime() + 5_000;
        return;
      }
      this.update(symbol, {
        ...item.state,
        revision: item.state.revision + 1,
        halfExit: {
          ...item.state.halfExit,
          clientOrderId: newClientId(),
          orderId: undefined,
          orderFilledQuantity: 0,
        },
        phase: "half-exit-working",
      });
      await this.flush(symbol);
    }
    if (item.state.halfExit.clientOrderId.startsWith("legacy-half:")) {
      if (!this.executor.getProtectionOrderById)
        throw new Error("Legacy half-order verification unavailable");
      this.update(symbol, {
        ...item.state,
        revision: item.state.revision + 1,
        halfExit: {
          ...item.state.halfExit,
          clientOrderId: newClientId(),
          orderId: undefined,
          orderFilledQuantity: 0,
        },
      });
      await this.flush(symbol);
    }
    const remaining =
      item.state.halfExit.targetQuantity - item.state.halfExit.filledQuantity;
    if (!(remaining > SHARE_EPSILON)) return;
    const result = await this.executor.submitProtectionExit(
      symbol,
      item.state.halfExit.clientOrderId,
      remaining,
      this.policy
        ? {
            extendedLimitOffset: this.policy.extendedLimitOffset,
            maxPriceAgeMs: this.policy.maxPriceAgeMs,
            now: this.now(),
          }
        : undefined,
      {
        quantity: item.lifecycle.remainingQuantity,
        entryPrice: item.lifecycle.averageEntryPrice,
      },
    );
    if (result.kind === "closed") {
      await this.reconcile(symbol);
      return;
    }
    if (result.kind === "deferred") {
      item.retryAt = this.now().getTime() + 5_000;
      this.alert(symbol, result.reason);
      return;
    }
    await this.recordBrokerOrder(symbol, result.order);
    if (
      TERMINAL.has(result.order.status) &&
      !item.state.halfExit.completed &&
      !item.state.exit
    ) {
      throw new Error(
        `Half-exit order ${result.order.status}; confirmed quantity and original stop retained`,
      );
    }
    if (!item.state.halfExit.completed) this.positions.markPendingExit(symbol);
    else if (!item.state.exit) this.positions.clearPendingExit(symbol);
    await this.flush(symbol);
    item.retryAt = item.state.exit ? 0 : this.now().getTime() + 5_000;
  }

  private async driveRemainderExit(symbol: string): Promise<void> {
    const item = this.tracked.get(symbol);
    if (!item?.state.exit) return;
    const exit = item.state.exit;
    const existing = await this.executor.getProtectionOrder(exit.clientOrderId);
    if (existing) {
      await this.recordBrokerOrder(symbol, existing);
      if (item.state.phase === "closed") return;
      if (!TERMINAL.has(existing.status)) {
        const age =
          this.now().getTime() -
          Date.parse(
            existing.submitted_at ??
              item.state.exit?.submittedAt ??
              this.now().toISOString(),
          );
        if (
          existing.type === "limit" &&
          this.policy &&
          age >= this.policy.repriceIntervalMs
        ) {
          if (exit.replacements >= this.policy.maxReplacements) {
            await this.executor.cancelProtectionOrder(existing.id);
            this.alert(
              symbol,
              "EXTENDED_REPRICE_LIMIT: exit queued until regular session",
            );
          } else await this.executor.cancelProtectionOrder(existing.id);
          // Terminal lookup and updated cumulative fill are required before rotating ID.
          const canceled = await this.executor.getProtectionOrder(
            exit.clientOrderId,
          );
          if (!canceled || !TERMINAL.has(canceled.status))
            throw new Error("Cancellation not confirmed");
          await this.recordBrokerOrder(symbol, canceled);
          this.rotateExit(symbol, true);
          await this.flush(symbol);
        } else {
          item.retryAt = this.now().getTime() + 5_000;
          return;
        }
      } else {
        this.rotateExit(symbol, false);
        await this.flush(symbol);
      }
    }
    await this.reconcile(symbol);
    if (item.state.phase === "closed" || !item.state.exit) return;
    const current = item.state.exit;
    const options =
      this.policy && current.replacements <= this.policy.maxReplacements
        ? {
            extendedLimitOffset: this.policy.extendedLimitOffset,
            maxPriceAgeMs: this.policy.maxPriceAgeMs,
            now: this.now(),
          }
        : undefined;
    const result = await this.executor.submitProtectionExit(
      symbol,
      current.clientOrderId,
      item.lifecycle.remainingQuantity,
      options,
      {
        quantity: item.lifecycle.remainingQuantity,
        entryPrice: item.lifecycle.averageEntryPrice,
      },
    );
    if (result.kind === "closed") {
      await this.reconcile(symbol);
      return;
    }
    if (result.kind === "deferred") {
      item.retryAt = this.now().getTime() + 5_000;
      this.alert(symbol, result.reason);
      return;
    }
    await this.recordBrokerOrder(symbol, result.order);
    if (TERMINAL.has(result.order.status)) {
      await this.reconcile(symbol);
      if (!this.isClosed(symbol))
        throw new Error(
          `Remainder exit ${result.order.status}; unsold shares retain the latched intent`,
        );
      return;
    }
    if (item.state.exit && !this.isClosed(symbol))
      this.update(symbol, {
        ...item.state,
        revision: item.state.revision + 1,
        phase: "remainder-exit-working",
        exit: {
          ...item.state.exit,
          orderId: result.order.id,
          status: "working",
          submittedAt: result.order.submitted_at ?? this.now().toISOString(),
        },
        lastError: undefined,
      });
    await this.flush(symbol);
    item.retryAt = this.now().getTime() + 5_000;
  }

  private rotateExit(symbol: string, replacement: boolean): void {
    const item = this.tracked.get(symbol);
    if (!item?.state.exit) return;
    this.update(symbol, {
      ...item.state,
      revision: item.state.revision + 1,
      phase: "remainder-exit-pending",
      exit: {
        ...item.state.exit,
        clientOrderId: newClientId(),
        orderId: undefined,
        status: "pending",
        replacements: item.state.exit.replacements + (replacement ? 1 : 0),
        submittedAt: undefined,
      },
    });
  }

  private closeInMemory(symbol: string): void {
    const item = this.tracked.get(symbol);
    if (!item) return;
    item.state = {
      ...item.state,
      phase: "closed",
      exit: undefined,
      nativeOrderId: undefined,
    };
    item.writeError = undefined;
    this.positions.setRemainderProtection(symbol, item.state);
    this.positions.clearPendingExit(symbol);
  }

  private isClosed(symbol: string): boolean {
    return this.tracked.get(symbol)?.state.phase === "closed";
  }

  private alert(symbol: string, reason: string): void {
    console.error(`[PROTECTION] ${symbol}: ${reason}`);
    this.broadcaster.broadcastSignal({
      symbol,
      action: "HOLD",
      confidence: 0,
      reason,
    });
  }
}

function newClientId(): string {
  return `protect-${randomUUID()}`;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
