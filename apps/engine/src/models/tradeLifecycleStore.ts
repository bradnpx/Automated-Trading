import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TradeExitReason,
  TradeLifecycle,
  TradeLifecycleExitIntent,
  TradeLifecycleFill,
  TradeLifecycleProfile,
} from "@my-platform/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LIFECYCLE_PATH = path.resolve(
  __dirname,
  "../../data/trade-lifecycles.json",
);
const LIFECYCLE_STORE_VERSION = 1;
const QUANTITY_EPSILON = 0.000_001;

interface PersistedTradeLifecycleStore {
  version: number;
  lifecycles: TradeLifecycle[];
}

export interface LifecycleFillInput {
  executionId: string;
  orderId: string;
  orderType: string;
  side: "buy" | "sell";
  symbol: string;
  price: number;
  quantity: number;
  filledAt: string;
  profile: TradeLifecycleProfile;
  reason?: TradeExitReason;
}

export interface LifecycleFillResult {
  lifecycle?: TradeLifecycle;
  recorded: boolean;
}

export class TradeLifecycleStore {
  private readonly filepath: string;
  private lifecycles = new Map<string, TradeLifecycle>();
  private initialized = false;
  private persistenceQueue: Promise<void> = Promise.resolve();

  constructor(
    filepath = process.env.TRADE_LIFECYCLE_PATH ?? DEFAULT_LIFECYCLE_PATH,
  ) {
    this.filepath = filepath;
  }

  public async init(): Promise<void> {
    if (this.initialized) return;

    try {
      const contents = await readFile(this.filepath, "utf8");
      this.loadPersistedState(JSON.parse(contents));
    } catch (error) {
      if (isMissingFileError(error)) {
        this.lifecycles.clear();
      } else {
        console.error(
          "❌ [LIFECYCLE] Failed to restore local trade lifecycle ledger:",
          error,
        );
        this.lifecycles.clear();
      }
    }

    this.initialized = true;
  }

  public async recordFill(
    input: LifecycleFillInput,
  ): Promise<LifecycleFillResult> {
    await this.init();
    validateFillInput(input);

    return this.mutate(async () => {
      if (this.hasExecution(input.executionId)) {
        const lifecycle = this.findLifecycleByExecution(input.executionId);
        return {
          ...(lifecycle ? { lifecycle: cloneLifecycle(lifecycle) } : {}),
          recorded: false,
        };
      }

      if (input.side === "buy") {
        const lifecycle = this.findOpenLifecycleBySymbol(input.symbol);
        const nextLifecycle = lifecycle ?? this.createLifecycle(input);
        nextLifecycle.entryFills.push(toLifecycleFill(input));
        this.recalculateLifecycle(nextLifecycle, input.filledAt);
        this.lifecycles.set(nextLifecycle.id, nextLifecycle);
        return { lifecycle: cloneLifecycle(nextLifecycle), recorded: true };
      }

      const lifecycle = this.findOpenLifecycleBySymbol(input.symbol);
      if (!lifecycle) {
        console.warn(
          `⚠️ [LIFECYCLE] Skipping unmatched sell fill for ${input.symbol} (${input.orderId}).`,
        );
        return { recorded: false };
      }

      lifecycle.exitFills.push(toLifecycleFill(input));
      this.recalculateLifecycle(lifecycle, input.filledAt);
      return { lifecycle: cloneLifecycle(lifecycle), recorded: true };
    });
  }

  public async recordExitIntent(
    symbol: string,
    intent: TradeLifecycleExitIntent,
  ): Promise<TradeLifecycle | undefined> {
    await this.init();

    return this.mutate(async () => {
      const lifecycle = this.findOpenLifecycleBySymbol(symbol);
      if (!lifecycle) return undefined;

      lifecycle.pendingExit = { ...intent };
      lifecycle.updatedAt = intent.submittedAt;
      return cloneLifecycle(lifecycle);
    });
  }

  public async activateTrailingStop(
    symbol: string,
    orderId: string,
    activatedAt = new Date().toISOString(),
  ): Promise<TradeLifecycle | undefined> {
    await this.init();

    return this.mutate(async () => {
      const lifecycle = this.findOpenLifecycleBySymbol(symbol);
      if (!lifecycle) return undefined;

      lifecycle.trailingStopOrderId = orderId;
      lifecycle.pendingExit = {
        orderId,
        reason: "TRAILING_STOP_LOSS",
        submittedAt: activatedAt,
      };
      lifecycle.updatedAt = activatedAt;
      return cloneLifecycle(lifecycle);
    });
  }

  public async clearExitIntent(orderId: string): Promise<void> {
    await this.init();

    await this.mutate(async () => {
      const lifecycle = this.findOpenLifecycleByOrderId(orderId);
      if (!lifecycle) return;

      if (lifecycle.pendingExit?.orderId === orderId) {
        delete lifecycle.pendingExit;
      }
      if (lifecycle.trailingStopOrderId === orderId) {
        delete lifecycle.trailingStopOrderId;
      }
      lifecycle.updatedAt = new Date().toISOString();
    });
  }

  public async getLifecycles(): Promise<TradeLifecycle[]> {
    await this.init();
    return Array.from(this.lifecycles.values(), cloneLifecycle).sort(
      (left, right) => Date.parse(right.openedAt) - Date.parse(left.openedAt),
    );
  }

  public async getOpenLifecycles(): Promise<TradeLifecycle[]> {
    const lifecycles = await this.getLifecycles();
    return lifecycles.filter((lifecycle) => lifecycle.status !== "closed");
  }

  public async getExitReason(
    orderId: string,
    orderType: string,
  ): Promise<TradeExitReason> {
    await this.init();
    const lifecycle = this.findOpenLifecycleByOrderId(orderId);
    if (lifecycle?.pendingExit?.orderId === orderId) {
      return lifecycle.pendingExit.reason;
    }
    return orderType === "trailing_stop" ? "TRAILING_STOP_LOSS" : "EXIT";
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    let result: T | undefined;
    const persistOperation = async () => {
      result = await operation();
      await this.persist();
    };

    this.persistenceQueue = this.persistenceQueue.then(
      persistOperation,
      persistOperation,
    );
    await this.persistenceQueue;
    return result as T;
  }

  private createLifecycle(input: LifecycleFillInput): TradeLifecycle {
    const lifecycleId = `trade:${input.executionId}`;
    return {
      id: lifecycleId,
      symbol: input.symbol,
      status: "open",
      openedAt: input.filledAt,
      updatedAt: input.filledAt,
      profile: { ...input.profile },
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

    lifecycle.entryQuantity = entryQuantity;
    lifecycle.exitedQuantity = exitedQuantity;
    lifecycle.remainingQuantity = remainingQuantity;
    lifecycle.averageEntryPrice = averageEntryPrice;
    lifecycle.realizedPnl = realizedPnl;
    lifecycle.realizedPnlPct = exitedBasis > 0 ? realizedPnl / exitedBasis : 0;
    lifecycle.updatedAt = updatedAt;

    if (averageExitPrice !== undefined) {
      lifecycle.averageExitPrice = averageExitPrice;
    }

    if (remainingQuantity <= QUANTITY_EPSILON && entryQuantity > 0) {
      lifecycle.status = "closed";
      lifecycle.remainingQuantity = 0;
      lifecycle.closedAt = updatedAt;
      delete lifecycle.pendingExit;
      delete lifecycle.trailingStopOrderId;
    } else if (exitedQuantity > 0) {
      lifecycle.status = "partially_closed";
    } else {
      lifecycle.status = "open";
    }
  }

  private findOpenLifecycleBySymbol(
    symbol: string,
  ): TradeLifecycle | undefined {
    return Array.from(this.lifecycles.values())
      .filter(
        (lifecycle) =>
          lifecycle.symbol === symbol && lifecycle.status !== "closed",
      )
      .sort(
        (left, right) => Date.parse(right.openedAt) - Date.parse(left.openedAt),
      )[0];
  }

  private findOpenLifecycleByOrderId(
    orderId: string,
  ): TradeLifecycle | undefined {
    return Array.from(this.lifecycles.values()).find(
      (lifecycle) =>
        lifecycle.status !== "closed" &&
        (lifecycle.pendingExit?.orderId === orderId ||
          lifecycle.trailingStopOrderId === orderId),
    );
  }

  private hasExecution(executionId: string): boolean {
    return this.findLifecycleByExecution(executionId) !== undefined;
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

  private async persist(): Promise<void> {
    const state: PersistedTradeLifecycleStore = {
      version: LIFECYCLE_STORE_VERSION,
      lifecycles: Array.from(this.lifecycles.values()),
    };
    const temporaryPath = `${this.filepath}.tmp`;

    await mkdir(path.dirname(this.filepath), { recursive: true });
    await writeFile(
      temporaryPath,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, this.filepath);
  }

  private loadPersistedState(value: unknown): void {
    if (!isPersistedStore(value)) {
      throw new Error("Invalid lifecycle store schema");
    }
    if (value.version !== LIFECYCLE_STORE_VERSION) {
      throw new Error(`Unsupported lifecycle store version: ${value.version}`);
    }

    this.lifecycles = new Map(
      value.lifecycles
        .filter(isLifecycle)
        .map((lifecycle) => [lifecycle.id, cloneLifecycle(lifecycle)]),
    );
  }
}

function toLifecycleFill(input: LifecycleFillInput): TradeLifecycleFill {
  return {
    executionId: input.executionId,
    orderId: input.orderId,
    orderType: input.orderType,
    side: input.side,
    price: input.price,
    quantity: input.quantity,
    filledAt: input.filledAt,
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

function validateFillInput(input: LifecycleFillInput): void {
  if (!input.executionId || !input.orderId || !input.symbol) {
    throw new Error(
      "Lifecycle fills require execution, order, and symbol identifiers",
    );
  }
  if (!(input.price > 0) || !(input.quantity > 0)) {
    throw new Error("Lifecycle fills require positive price and quantity");
  }
  if (!Number.isFinite(Date.parse(input.filledAt))) {
    throw new Error(
      `Lifecycle fill has an invalid timestamp: ${input.filledAt}`,
    );
  }
}

function sumQuantity(fills: TradeLifecycleFill[]): number {
  return fills.reduce((total, fill) => total + fill.quantity, 0);
}

function weightedAveragePrice(fills: TradeLifecycleFill[]): number | undefined {
  const quantity = sumQuantity(fills);
  if (!(quantity > 0)) return undefined;

  return (
    fills.reduce((total, fill) => total + fill.price * fill.quantity, 0) /
    quantity
  );
}

function cloneLifecycle(lifecycle: TradeLifecycle): TradeLifecycle {
  return {
    ...lifecycle,
    profile: { ...lifecycle.profile },
    entryFills: lifecycle.entryFills.map((fill) => ({ ...fill })),
    exitFills: lifecycle.exitFills.map((fill) => ({ ...fill })),
    ...(lifecycle.pendingExit
      ? { pendingExit: { ...lifecycle.pendingExit } }
      : {}),
  };
}

function isPersistedStore(
  value: unknown,
): value is PersistedTradeLifecycleStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const store = value as Partial<PersistedTradeLifecycleStore>;
  return typeof store.version === "number" && Array.isArray(store.lifecycles);
}

function isLifecycle(value: unknown): value is TradeLifecycle {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const lifecycle = value as Partial<TradeLifecycle>;
  return (
    typeof lifecycle.id === "string" &&
    typeof lifecycle.symbol === "string" &&
    typeof lifecycle.status === "string" &&
    typeof lifecycle.openedAt === "string" &&
    typeof lifecycle.updatedAt === "string" &&
    lifecycle.profile !== undefined &&
    Array.isArray(lifecycle.entryFills) &&
    Array.isArray(lifecycle.exitFills)
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
