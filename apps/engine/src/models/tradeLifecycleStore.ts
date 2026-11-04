import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  RemainderProtection,
  TradeExitReason,
  TradeLifecycle,
  TradeLifecycleExitIntent,
  TradeLifecycleFill,
  TradeLifecycleProfile,
} from "@my-platform/types";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LIFECYCLE_PATH = path.resolve(
  __dirname,
  "../../data/trade-lifecycles.json",
);
const LIFECYCLE_STORE_VERSION = 2;
const QUANTITY_EPSILON = 1e-9;

const timestampSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)));
const positiveSchema = z.number().finite().positive();
const nonnegativeSchema = z.number().finite().nonnegative();
const reasonSchema = z.enum([
  "TAKE_PROFIT",
  "TAKE_PROFIT_HALF",
  "TRAILING_STOP_LOSS",
  "ENTRY_PRICE_BACKSTOP",
  "STOP_LOSS",
  "STRATEGY_SELL",
  "MANUAL_CLOSE",
  "TRAILING_STOP_SETUP_FAILED",
  "EXIT",
]);
const protectionSchema = z
  .object({
    version: z.literal(1),
    phase: z.enum([
      "half-exit-working",
      "protected-remainder",
      "remainder-exit-pending",
      "remainder-exit-working",
      "recovery-required",
      "closed",
    ]),
    revision: z.number().int().nonnegative(),
    entryPrice: positiveSchema,
    trailingDistance: positiveSchema.nullable(),
    highWaterMark: positiveSchema,
    effectiveStop: positiveSchema,
    halfExit: z
      .object({
        clientOrderId: z.string().min(1),
        orderId: z.string().min(1).optional(),
        targetQuantity: positiveSchema,
        filledQuantity: nonnegativeSchema,
        orderFilledQuantity: nonnegativeSchema.optional(),
        completed: z.boolean(),
      })
      .passthrough(),
    calibrationRequired: z.boolean().optional(),
    legacyHalfOrder: z.boolean().optional(),
    lastPriceAt: timestampSchema.optional(),
    activatedAt: timestampSchema.optional(),
    activationSource: z.enum(["trade", "broker"]).optional(),
    nativeOrderId: z.string().min(1).optional(),
    lastError: z.string().optional(),
    exit: z
      .object({
        clientOrderId: z.string().min(1),
        orderId: z.string().min(1).optional(),
        reason: reasonSchema,
        attempt: z.number().int().nonnegative(),
        nextRetryAt: timestampSchema.optional(),
        submittedAt: timestampSchema.optional(),
        status: z.enum(["pending", "working", "unknown"]),
        replacements: z.number().int().nonnegative(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .superRefine((state, context) => {
    if (
      state.highWaterMark < state.entryPrice ||
      state.effectiveStop < state.entryPrice
    ) {
      context.addIssue({
        code: "custom",
        message: "Protection cannot be below the original entry floor",
      });
    }
    if (
      state.phase === "protected-remainder" &&
      (!state.halfExit.completed || state.trailingDistance === null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Active protection requires a completed half exit and fixed distance",
      });
    }
    if (
      (state.phase === "remainder-exit-pending" ||
        state.phase === "remainder-exit-working") &&
      !state.exit
    ) {
      context.addIssue({
        code: "custom",
        message: "Remainder exit phase requires a latched intent",
      });
    }
  });
const fillSchema = z
  .object({
    executionId: z.string().min(1),
    orderId: z.string().min(1),
    orderType: z.string(),
    side: z.enum(["buy", "sell"]),
    price: positiveSchema,
    quantity: positiveSchema,
    filledAt: timestampSchema,
    reason: reasonSchema.optional(),
  })
  .passthrough();
const lifecycleSchema = z
  .object({
    id: z.string().min(1),
    symbol: z.string().min(1),
    status: z.enum(["open", "partially_closed", "closed"]),
    openedAt: timestampSchema,
    updatedAt: timestampSchema,
    closedAt: timestampSchema.optional(),
    profile: z
      .object({
        strategy: z.string(),
        takeProfitPct: z.number().finite(),
        stopLossPct: z.number().finite(),
        trailingStopLoss: z.boolean(),
      })
      .passthrough(),
    entryFills: z.array(fillSchema),
    exitFills: z.array(fillSchema),
    entryQuantity: nonnegativeSchema,
    exitedQuantity: nonnegativeSchema,
    remainingQuantity: nonnegativeSchema,
    averageEntryPrice: nonnegativeSchema,
    averageExitPrice: nonnegativeSchema.optional(),
    realizedPnl: z.number().finite(),
    realizedPnlPct: z.number().finite(),
    pendingExit: z
      .object({
        orderId: z.string().min(1),
        reason: reasonSchema,
        submittedAt: timestampSchema,
      })
      .passthrough()
      .optional(),
    trailingStopOrderId: z.string().min(1).optional(),
    protection: protectionSchema.optional(),
  })
  .passthrough();
const storeSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  lifecycles: z.array(lifecycleSchema),
});

export interface LifecycleFillInput {
  executionId: string;
  orderId: string;
  orderType: string;
  side: "buy" | "sell";
  symbol: string;
  price: number;
  quantity: number;
  /** Broker order snapshot total; only its excess over recorded fills is added. */
  cumulativeQuantity?: number;
  /** Price is the cumulative broker average, rather than this delta's price. */
  cumulativePrice?: boolean;
  filledAt: string;
  profile: TradeLifecycleProfile;
  reason?: TradeExitReason;
}

export interface LifecycleFillResult {
  lifecycle?: TradeLifecycle;
  recorded: boolean;
}

export class LifecycleIdentityError extends Error {
  constructor(
    public readonly symbol: string,
    public readonly expectedLifecycleId: string,
    public readonly actualLifecycleId: string | undefined,
  ) {
    super(
      `Lifecycle identity changed for ${symbol}: expected ${expectedLifecycleId}, actual ${actualLifecycleId ?? "no open lifecycle"}`,
    );
    this.name = "LifecycleIdentityError";
  }
}

export class TradeLifecycleStore {
  private readonly filepath: string;
  private lifecycles = new Map<string, TradeLifecycle>();
  private initialized = false;
  private initialization?: Promise<void>;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private persistenceStatus: { healthy: boolean; lastError?: string } = {
    healthy: true,
  };

  constructor(
    filepath = process.env.TRADE_LIFECYCLE_PATH ?? DEFAULT_LIFECYCLE_PATH,
  ) {
    this.filepath = filepath;
  }

  public async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.initialization) {
      this.initialization = this.restore().catch((error: unknown) => {
        this.persistenceStatus = {
          healthy: false,
          lastError: errorMessage(error),
        };
        this.initialization = undefined;
        throw error;
      });
    }
    await this.initialization;
  }

  public getPersistenceStatus(): { healthy: boolean; lastError?: string } {
    return { ...this.persistenceStatus };
  }

  public async recordFill(
    input: LifecycleFillInput,
  ): Promise<LifecycleFillResult> {
    const fill = structuredClone(input);
    validateFillInput(fill);
    await this.init();
    return this.mutate(() => {
      const duplicate = this.findLifecycleByExecution(fill.executionId);
      if (duplicate)
        return { lifecycle: cloneLifecycle(duplicate), recorded: false };
      const byOrder = this.findLifecycleByFillOrder(fill.orderId, fill.side);
      const existing = byOrder ?? this.findOpenLifecycleBySymbol(fill.symbol);
      if (existing && existing.symbol !== fill.symbol)
        throw new Error("Fill order symbol does not match its lifecycle");
      const recordedQuantity = existing
        ? sumQuantity(
            (fill.side === "buy"
              ? existing.entryFills
              : existing.exitFills
            ).filter((item) => item.orderId === fill.orderId),
          )
        : 0;
      const quantity =
        fill.cumulativeQuantity === undefined
          ? fill.quantity
          : Math.max(0, fill.cumulativeQuantity - recordedQuantity);
      if (!(quantity > 0))
        return {
          ...(existing ? { lifecycle: cloneLifecycle(existing) } : {}),
          recorded: false,
        };
      if (fill.side === "sell" && !existing) return { recorded: false };
      const next = existing
        ? cloneLifecycle(existing)
        : this.createLifecycle(fill);
      const previousValue = existing
        ? (fill.side === "buy" ? existing.entryFills : existing.exitFills)
            .filter((item) => item.orderId === fill.orderId)
            .reduce((total, item) => total + item.quantity * item.price, 0)
        : 0;
      const deltaPrice =
        fill.cumulativePrice && fill.cumulativeQuantity !== undefined
          ? (fill.cumulativeQuantity * fill.price - previousValue) / quantity
          : fill.price;
      if (!Number.isFinite(deltaPrice) || !(deltaPrice > 0))
        throw new Error(
          "Cumulative fill average implies an invalid incremental price",
        );
      const reason =
        fill.reason ??
        (fill.side === "sell"
          ? this.reasonForOrder(next, fill.orderId, fill.orderType)
          : undefined);
      const confirmedFill: TradeLifecycleFill = {
        executionId: fill.executionId,
        orderId: fill.orderId,
        orderType: fill.orderType,
        side: fill.side,
        price: deltaPrice,
        quantity,
        filledAt: fill.filledAt,
        ...(reason ? { reason } : {}),
      };
      if (fill.side === "buy")
        next.entryFills = [...next.entryFills, confirmedFill];
      else next.exitFills = [...next.exitFills, confirmedFill];
      if (
        next.protection &&
        fill.side === "sell" &&
        next.protection.halfExit.orderId === fill.orderId
      ) {
        const total = sumQuantity(
          next.exitFills.filter((item) => item.orderId === fill.orderId),
        );
        const half = next.protection.halfExit;
        const observedTotal = half.orderFilledQuantity ?? recordedQuantity;
        const addedQuantity = Math.max(0, total - observedTotal);
        const completed =
          half.completed ||
          half.filledQuantity + addedQuantity + QUANTITY_EPSILON >=
            half.targetQuantity;
        if (addedQuantity > 0 || completed !== half.completed)
          next.protection.revision += 1;
        half.filledQuantity += addedQuantity;
        half.orderFilledQuantity = Math.max(observedTotal, total);
        half.completed = completed;
      }
      this.recalculateLifecycle(next, fill.filledAt);
      this.lifecycles.set(next.id, next);
      return { lifecycle: cloneLifecycle(next), recorded: true };
    });
  }

  public async recordExitIntent(
    symbol: string,
    intent: TradeLifecycleExitIntent,
  ): Promise<TradeLifecycle | undefined> {
    const snapshot = structuredClone(intent);
    await this.init();
    return this.mutate(() => {
      const lifecycle = this.findOpenLifecycleBySymbol(symbol);
      if (!lifecycle) return undefined;
      const next = {
        ...cloneLifecycle(lifecycle),
        pendingExit: snapshot,
        updatedAt: snapshot.submittedAt,
      };
      this.lifecycles.set(next.id, next);
      return cloneLifecycle(next);
    });
  }

  public async activateTrailingStop(
    symbol: string,
    orderId: string,
    activatedAt = new Date().toISOString(),
  ): Promise<TradeLifecycle | undefined> {
    await this.init();
    return this.mutate(() => {
      const lifecycle = this.findOpenLifecycleBySymbol(symbol);
      if (!lifecycle) return undefined;
      const next = cloneLifecycle(lifecycle);
      next.trailingStopOrderId = orderId;
      next.pendingExit = {
        orderId,
        reason: "TRAILING_STOP_LOSS",
        submittedAt: activatedAt,
      };
      next.updatedAt = activatedAt;
      this.lifecycles.set(next.id, next);
      return cloneLifecycle(next);
    });
  }

  public async clearExitIntent(orderId: string): Promise<void> {
    await this.init();
    await this.mutate(() => {
      const lifecycle = this.findOpenLifecycleByOrderId(orderId);
      if (!lifecycle) return;
      const next = cloneLifecycle(lifecycle);
      if (next.pendingExit?.orderId === orderId) delete next.pendingExit;
      if (next.trailingStopOrderId === orderId) delete next.trailingStopOrderId;
      if (next.protection?.nativeOrderId === orderId) {
        delete next.protection.nativeOrderId;
        next.protection.revision += 1;
      }
      // Terminal order events never clear a completed half exit or latched exit.
      next.updatedAt = new Date().toISOString();
      this.lifecycles.set(next.id, next);
    });
  }

  public async getLifecycles(): Promise<TradeLifecycle[]> {
    await this.init();
    return Array.from(this.lifecycles.values(), cloneLifecycle).sort(
      (left, right) => Date.parse(right.openedAt) - Date.parse(left.openedAt),
    );
  }

  public async getOpenLifecycles(): Promise<TradeLifecycle[]> {
    return (await this.getLifecycles()).filter(
      (lifecycle) => lifecycle.status !== "closed",
    );
  }

  public async getOpenLifecycle(
    symbol: string,
  ): Promise<TradeLifecycle | undefined> {
    await this.init();
    const lifecycle = this.findOpenLifecycleBySymbol(symbol);
    return lifecycle ? cloneLifecycle(lifecycle) : undefined;
  }

  public async saveProtection(
    symbol: string,
    state: RemainderProtection,
    expectedLifecycleId?: string,
  ): Promise<TradeLifecycle> {
    const snapshot = structuredClone(state);
    protectionSchema.parse(snapshot);
    await this.init();
    return this.mutate(() => {
      const lifecycle = this.findOpenLifecycleBySymbol(symbol);
      if (
        expectedLifecycleId !== undefined &&
        lifecycle?.id !== expectedLifecycleId
      )
        throw new LifecycleIdentityError(
          symbol,
          expectedLifecycleId,
          lifecycle?.id,
        );
      if (!lifecycle) throw new Error(`No open lifecycle for ${symbol}`);
      const next = cloneLifecycle(lifecycle);
      next.protection = mergeProtection(next.protection, snapshot);
      next.updatedAt = new Date().toISOString();
      this.lifecycles.set(next.id, next);
      return cloneLifecycle(next);
    });
  }

  public async markBrokerClosed(
    symbol: string,
    expectedLifecycleId?: string,
  ): Promise<void> {
    await this.init();
    await this.mutate(() => {
      const lifecycle = this.findOpenLifecycleBySymbol(symbol);
      if (
        expectedLifecycleId !== undefined &&
        lifecycle?.id !== expectedLifecycleId
      )
        throw new LifecycleIdentityError(
          symbol,
          expectedLifecycleId,
          lifecycle?.id,
        );
      if (!lifecycle) return;
      const next = cloneLifecycle(lifecycle);
      this.closeLifecycle(next, new Date().toISOString());
      this.lifecycles.set(next.id, next);
    });
  }

  public async getExitReason(
    orderId: string,
    orderType: string,
  ): Promise<TradeExitReason> {
    await this.init();
    const lifecycle = this.findOpenLifecycleByOrderId(orderId);
    return lifecycle
      ? this.reasonForOrder(lifecycle, orderId, orderType)
      : orderType === "trailing_stop"
        ? "TRAILING_STOP_LOSS"
        : "EXIT";
  }

  private async restore(): Promise<void> {
    let contents: string;
    try {
      contents = await readFile(this.filepath, "utf8");
    } catch (error: unknown) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
      this.initialized = true;
      return;
    }
    const value: unknown = JSON.parse(contents);
    const parsed = storeSchema.parse(value);
    const records: TradeLifecycle[] = parsed.lifecycles;
    const ids = new Set<string>();
    const executions = new Set<string>();
    const openSymbols = new Set<string>();
    for (const lifecycle of records) {
      if (ids.has(lifecycle.id))
        throw new Error(`Duplicate lifecycle identity: ${lifecycle.id}`);
      ids.add(lifecycle.id);
      if (lifecycle.status !== "closed") {
        if (openSymbols.has(lifecycle.symbol))
          throw new Error(`Ambiguous open lifecycle for ${lifecycle.symbol}`);
        openSymbols.add(lifecycle.symbol);
      }
      for (const fill of [...lifecycle.entryFills, ...lifecycle.exitFills]) {
        if (executions.has(fill.executionId))
          throw new Error(`Duplicate execution identity: ${fill.executionId}`);
        executions.add(fill.executionId);
      }
    }
    const migrated = records.map((lifecycle) =>
      parsed.version === 1
        ? migrateV1Lifecycle(lifecycle)
        : cloneLifecycle(lifecycle),
    );
    if (parsed.version === 1) await this.backupV1(contents);
    this.lifecycles = new Map(
      migrated.map((lifecycle) => [lifecycle.id, lifecycle]),
    );
    if (parsed.version === 1) await this.persist();
    this.persistenceStatus = { healthy: true };
    this.initialized = true;
  }

  private async backupV1(contents: string): Promise<void> {
    const backupPath = `${this.filepath}.v1.bak`;
    let file;
    try {
      file = await open(backupPath, "wx", 0o600);
    } catch (error: unknown) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      if ((await readFile(backupPath, "utf8")) !== contents)
        throw new Error(
          "Existing v1 ledger backup differs; refusing to overwrite it",
        );
      return;
    }
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await syncDirectory(path.dirname(this.filepath));
  }

  private async mutate<T>(operation: () => T): Promise<T> {
    const task = this.persistenceQueue.then(async () => {
      const result = operation();
      // Mutations remain in memory on failure. Even a duplicate retries the
      // entire snapshot, so the same protection revision can become durable.
      await this.persist();
      return result;
    });
    this.persistenceQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private createLifecycle(input: LifecycleFillInput): TradeLifecycle {
    return {
      id: `trade:${input.executionId}`,
      symbol: input.symbol,
      status: "open",
      openedAt: input.filledAt,
      updatedAt: input.filledAt,
      profile: structuredClone(input.profile),
      entryFills: [],
      exitFills: [],
      entryQuantity: 0,
      exitedQuantity: 0,
      remainingQuantity: 0,
      averageEntryPrice: 0,
      realizedPnl: 0,
      realizedPnlPct: 0,
    };
  }

  private recalculateLifecycle(
    lifecycle: TradeLifecycle,
    updatedAt: string,
  ): void {
    const wasClosed = lifecycle.status === "closed";
    const entryQuantity = sumQuantity(lifecycle.entryFills);
    const exitedQuantity = sumQuantity(lifecycle.exitFills);
    const averageEntryPrice = weightedAveragePrice(lifecycle.entryFills) ?? 0;
    const averageExitPrice = weightedAveragePrice(lifecycle.exitFills);
    const remainingQuantity = Math.max(0, entryQuantity - exitedQuantity);
    const realizedPnl = lifecycle.exitFills.reduce(
      (total, fill) => total + (fill.price - averageEntryPrice) * fill.quantity,
      0,
    );
    const exitedBasis = averageEntryPrice * exitedQuantity;
    Object.assign(lifecycle, {
      entryQuantity,
      exitedQuantity,
      remainingQuantity,
      averageEntryPrice,
      realizedPnl,
      realizedPnlPct: exitedBasis > 0 ? realizedPnl / exitedBasis : 0,
      updatedAt:
        Date.parse(updatedAt) >= Date.parse(lifecycle.updatedAt)
          ? updatedAt
          : lifecycle.updatedAt,
    });
    if (averageExitPrice !== undefined)
      lifecycle.averageExitPrice = averageExitPrice;
    if (
      (remainingQuantity <= QUANTITY_EPSILON && entryQuantity > 0) ||
      (wasClosed && lifecycle.entryQuantity > 0)
    ) {
      this.closeLifecycle(lifecycle, lifecycle.updatedAt);
    } else {
      lifecycle.status = exitedQuantity > 0 ? "partially_closed" : "open";
    }
  }

  private closeLifecycle(lifecycle: TradeLifecycle, timestamp: string): void {
    lifecycle.status = "closed";
    lifecycle.remainingQuantity = 0;
    lifecycle.closedAt = timestamp;
    lifecycle.updatedAt = timestamp;
    delete lifecycle.pendingExit;
    delete lifecycle.trailingStopOrderId;
    if (lifecycle.protection && lifecycle.protection.phase !== "closed") {
      lifecycle.protection.phase = "closed";
      lifecycle.protection.revision += 1;
      delete lifecycle.protection.exit;
      delete lifecycle.protection.nativeOrderId;
    }
  }

  private findOpenLifecycleBySymbol(
    symbol: string,
  ): TradeLifecycle | undefined {
    return Array.from(this.lifecycles.values()).find(
      (lifecycle) =>
        lifecycle.symbol === symbol && lifecycle.status !== "closed",
    );
  }

  private findOpenLifecycleByOrderId(
    orderId: string,
  ): TradeLifecycle | undefined {
    return Array.from(this.lifecycles.values()).find(
      (lifecycle) =>
        lifecycle.status !== "closed" &&
        (lifecycle.pendingExit?.orderId === orderId ||
          lifecycle.trailingStopOrderId === orderId ||
          lifecycle.protection?.halfExit.orderId === orderId ||
          lifecycle.protection?.exit?.orderId === orderId ||
          lifecycle.protection?.nativeOrderId === orderId),
    );
  }

  private findLifecycleByFillOrder(
    orderId: string,
    side: "buy" | "sell",
  ): TradeLifecycle | undefined {
    return Array.from(this.lifecycles.values()).find((lifecycle) =>
      (side === "buy" ? lifecycle.entryFills : lifecycle.exitFills).some(
        (fill) => fill.orderId === orderId,
      ),
    );
  }

  private findLifecycleByExecution(
    executionId: string,
  ): TradeLifecycle | undefined {
    return Array.from(this.lifecycles.values()).find((lifecycle) =>
      [...lifecycle.entryFills, ...lifecycle.exitFills].some(
        (fill) => fill.executionId === executionId,
      ),
    );
  }

  private reasonForOrder(
    lifecycle: TradeLifecycle,
    orderId: string,
    orderType: string,
  ): TradeExitReason {
    if (lifecycle.protection?.exit?.orderId === orderId)
      return lifecycle.protection.exit.reason;
    if (lifecycle.protection?.halfExit.orderId === orderId)
      return "TAKE_PROFIT_HALF";
    if (lifecycle.pendingExit?.orderId === orderId)
      return lifecycle.pendingExit.reason;
    return orderType === "trailing_stop" ? "TRAILING_STOP_LOSS" : "EXIT";
  }

  private async persist(): Promise<void> {
    const temporaryPath = `${this.filepath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(this.filepath), { recursive: true });
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(
          `${JSON.stringify({ version: LIFECYCLE_STORE_VERSION, lifecycles: Array.from(this.lifecycles.values()) }, null, 2)}\n`,
          "utf8",
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.filepath);
      await syncDirectory(path.dirname(this.filepath));
      this.persistenceStatus = { healthy: true };
    } catch (error: unknown) {
      this.persistenceStatus = {
        healthy: false,
        lastError: errorMessage(error),
      };
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

function mergeProtection(
  previous: RemainderProtection | undefined,
  incoming: RemainderProtection,
): RemainderProtection {
  const next = structuredClone(incoming);
  if (!previous) return next;
  if (next.revision < previous.revision) {
    const retained = structuredClone(previous);
    // A superseded price/order snapshot is harmless, but an independently
    // latched breach must never be lost merely because fill accounting raced it.
    if (next.exit && !retained.exit) {
      retained.exit = structuredClone(next.exit);
      retained.phase =
        next.exit.status === "working"
          ? "remainder-exit-working"
          : "remainder-exit-pending";
      retained.revision += 1;
    }
    return retained;
  }
  if (
    next.entryPrice !== previous.entryPrice ||
    next.halfExit.targetQuantity !== previous.halfExit.targetQuantity
  ) {
    throw new Error(
      "Cannot replace the original protection entry or half-exit target",
    );
  }
  if (
    previous.trailingDistance !== null &&
    next.trailingDistance !== previous.trailingDistance
  ) {
    throw new Error("Cannot recalibrate an established trailing distance");
  }
  next.highWaterMark = Math.max(previous.highWaterMark, next.highWaterMark);
  next.effectiveStop = Math.max(
    previous.effectiveStop,
    next.effectiveStop,
    next.entryPrice,
    next.trailingDistance === null
      ? next.entryPrice
      : next.highWaterMark - next.trailingDistance,
  );
  next.halfExit.filledQuantity = Math.max(
    previous.halfExit.filledQuantity,
    next.halfExit.filledQuantity,
  );
  next.halfExit.completed ||= previous.halfExit.completed;
  if (next.halfExit.clientOrderId === previous.halfExit.clientOrderId) {
    if (!next.halfExit.orderId && previous.halfExit.orderId)
      next.halfExit.orderId = previous.halfExit.orderId;
    if (previous.halfExit.orderFilledQuantity !== undefined)
      next.halfExit.orderFilledQuantity = Math.max(
        previous.halfExit.orderFilledQuantity,
        next.halfExit.orderFilledQuantity ?? 0,
      );
  }
  if (previous.calibrationRequired && next.trailingDistance === null)
    next.calibrationRequired = true;
  if (
    previous.lastPriceAt &&
    (!next.lastPriceAt ||
      Date.parse(next.lastPriceAt) < Date.parse(previous.lastPriceAt))
  )
    next.lastPriceAt = previous.lastPriceAt;
  if (previous.activatedAt) next.activatedAt = previous.activatedAt;
  if (previous.activationSource)
    next.activationSource = previous.activationSource;
  if (previous.exit && next.phase !== "closed") {
    if (!next.exit) {
      next.exit = structuredClone(previous.exit);
      next.phase = previous.phase;
    } else if (
      next.phase !== "remainder-exit-working" &&
      next.phase !== "remainder-exit-pending"
    ) {
      next.phase =
        next.exit.status === "working"
          ? "remainder-exit-working"
          : "remainder-exit-pending";
    }
  } else if (
    previous.halfExit.completed &&
    next.phase === "half-exit-working"
  ) {
    next.phase = previous.phase;
  }
  if (JSON.stringify(next) !== JSON.stringify(previous))
    next.revision = Math.max(next.revision, previous.revision + 1);
  return next;
}

function migrateV1Lifecycle(lifecycle: TradeLifecycle): TradeLifecycle {
  const next = cloneLifecycle(lifecycle);
  if (
    next.protection ||
    next.status === "closed" ||
    !(next.averageEntryPrice > 0)
  )
    return next;
  const halfFills = next.exitFills.filter(
    (fill) =>
      fill.reason === "TAKE_PROFIT_HALF" ||
      (next.pendingExit?.reason === "TAKE_PROFIT_HALF" &&
        next.pendingExit.orderId === fill.orderId),
  );
  const confirmedHalfQuantity = sumQuantity(halfFills);
  const targetQuantity =
    next.entryQuantity > 0 ? next.entryQuantity / 2 : next.remainingQuantity;
  const pendingHalf =
    next.pendingExit?.reason === "TAKE_PROFIT_HALF"
      ? next.pendingExit
      : undefined;
  const completed =
    Boolean(next.trailingStopOrderId) ||
    confirmedHalfQuantity + QUANTITY_EPSILON >= targetQuantity;
  if (!(targetQuantity > 0) || (!completed && !pendingHalf)) return next;
  const orderId = pendingHalf?.orderId ?? halfFills[0]?.orderId;
  next.protection = {
    version: 1,
    phase: completed ? "recovery-required" : "half-exit-working",
    revision: 1,
    calibrationRequired: completed,
    legacyHalfOrder: true,
    entryPrice: next.averageEntryPrice,
    trailingDistance: null,
    // These are the known entry floor only; historical highs are unknown.
    highWaterMark: next.averageEntryPrice,
    effectiveStop: next.averageEntryPrice,
    halfExit: {
      clientOrderId: `legacy-half:${next.id}`,
      ...(orderId
        ? {
            orderId,
            orderFilledQuantity: sumQuantity(
              next.exitFills.filter((fill) => fill.orderId === orderId),
            ),
          }
        : {}),
      targetQuantity,
      filledQuantity: confirmedHalfQuantity,
      completed,
    },
    ...(next.trailingStopOrderId
      ? { nativeOrderId: next.trailingStopOrderId }
      : {}),
    ...(completed
      ? {
          lastError:
            "Legacy half exit requires explicit calibration; historical trailing distance and high-water mark are unknown",
        }
      : {}),
  };
  return next;
}

function validateFillInput(input: LifecycleFillInput): void {
  if (!input.executionId || !input.orderId || !input.symbol)
    throw new Error(
      "Lifecycle fills require execution, order, and symbol identifiers",
    );
  if (
    !Number.isFinite(input.price) ||
    !(input.price > 0) ||
    !Number.isFinite(input.quantity) ||
    !(input.quantity > 0)
  )
    throw new Error(
      "Lifecycle fills require positive finite price and quantity",
    );
  if (
    input.cumulativeQuantity !== undefined &&
    (!Number.isFinite(input.cumulativeQuantity) || input.cumulativeQuantity < 0)
  )
    throw new Error("Cumulative fill quantity must be finite and nonnegative");
  if (input.cumulativePrice && input.cumulativeQuantity === undefined)
    throw new Error("Cumulative average price requires cumulative quantity");
  if (!Number.isFinite(Date.parse(input.filledAt)))
    throw new Error(
      `Lifecycle fill has an invalid timestamp: ${input.filledAt}`,
    );
}

function sumQuantity(fills: TradeLifecycleFill[]): number {
  return fills.reduce((total, fill) => total + fill.quantity, 0);
}

function weightedAveragePrice(fills: TradeLifecycleFill[]): number | undefined {
  const quantity = sumQuantity(fills);
  return quantity > 0
    ? fills.reduce((total, fill) => total + fill.price * fill.quantity, 0) /
        quantity
    : undefined;
}

function cloneLifecycle(lifecycle: TradeLifecycle): TradeLifecycle {
  return structuredClone(lifecycle);
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const file = await open(directory, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error: unknown) {
    if (
      !["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR", "ENOSYS"].some((code) =>
        hasErrorCode(error, code),
      )
    )
      throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Unknown lifecycle persistence failure";
}
