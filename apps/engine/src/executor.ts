import getTradingSession, {
  getEasternTimeParts,
} from "./functions/getTradingSession";

export interface ExecutorBrokerOrder {
  id: string;
  symbol?: string;
  client_order_id?: string;
  side?: string;
  type?: string;
  status?: string;
  qty?: string | number;
  filled_qty?: string | number;
  filled_avg_price?: string | number | null;
  filled_at?: string | null;
  submitted_at?: string | null;
  limit_price?: string | number | null;
  hwm?: string | number | null;
  stop_price?: string | number | null;
  trail_price?: string | number | null;
}

export interface ProtectionBrokerOrder extends ExecutorBrokerOrder {
  symbol: string;
  status: string;
}

export type ProtectionExecutionResult =
  | { kind: "working" | "submitted" | "terminal"; order: ProtectionBrokerOrder }
  | { kind: "closed" }
  | { kind: "deferred"; reason: string };

export interface ProtectionExitOptions {
  /** Fractional discount from the latest trade (for example, 0.01 is 1%). */
  extendedLimitOffset: number;
  maxPriceAgeMs: number;
  now?: Date;
}

export interface ProtectionExpectedExposure {
  quantity: number;
  entryPrice: number;
}

export interface ProtectionSnapshot {
  position?: { qty: number; availableQuantity: number; entryPrice: number };
  orders: ProtectionBrokerOrder[];
  price?: { price: number; timestamp: string };
}

export interface ExecutorOrderRequest {
  symbol: string;
  qty: number;
  side: "buy" | "sell";
  type: "market" | "limit" | "trailing_stop";
  time_in_force: "day" | "gtc";
  extended_hours?: boolean;
  limit_price?: number;
  trail_price?: number;
  client_order_id?: string;
}

interface OpenOrdersQuery {
  status: "open";
  until: undefined;
  after: undefined;
  limit: number;
  direction: undefined;
  nested: undefined;
  symbols: string[];
}

/** SDK responses are untrusted until explicitly narrowed below. */
export interface ExecutorBroker {
  createOrder(order: ExecutorOrderRequest): Promise<unknown>;
  getPosition(symbol: string): Promise<unknown>;
  getOrders?(query: OpenOrdersQuery): Promise<unknown>;
  getOrder?(id: string): Promise<unknown>;
  getOrderByClientOrderId?(clientOrderId: string): Promise<unknown>;
  // Alpaca JS 3.1.3 uses this alias in its implementation and declarations.
  getOrderByClientId?(clientOrderId: string): Promise<unknown>;
  cancelOrder?(id: string): Promise<unknown>;
  getLatestTrade?(symbol: string): Promise<unknown>;
  getLatestBars?(symbols: string[]): Promise<unknown>;
  getAsset?(symbol: string): Promise<unknown>;
  getClock?(): Promise<unknown>;
  getCalendar?(query: { start: string; end: string }): Promise<unknown>;
  cancelAllOrders?(): Promise<unknown>;
  closeAllPositions?(): Promise<unknown>;
}

const TERMINAL_STATUSES = new Set([
  "filled",
  "canceled",
  "cancelled",
  "expired",
  "rejected",
  "replaced",
]);
const CANCEL_POLL_ATTEMPTS = 20;
const CANCEL_POLL_INTERVAL_MS = 100;

export function isTerminalProtectionOrder(
  order: ProtectionBrokerOrder,
): boolean {
  return TERMINAL_STATUSES.has(order.status.toLowerCase());
}

export function toProtectionBrokerOrder(value: unknown): ProtectionBrokerOrder {
  const order = toBrokerOrder(value);
  if (!order.symbol || !order.status) {
    throw new Error("Broker order is missing symbol or status");
  }
  return { ...order, symbol: order.symbol, status: order.status };
}

export class Executor {
  private readonly submissionLocks = new Map<string, Promise<void>>();
  private readonly knownTerminalOrders = new Map<
    string,
    ProtectionBrokerOrder
  >();
  private submissionGuard: () => boolean = () => true;

  constructor(private readonly alpaca: ExecutorBroker) {}

  setSubmissionGuard(guard: () => boolean): void {
    this.submissionGuard = guard;
  }

  /** Places a market order to enter a position; existing buy policy is unchanged. */
  async placeBuyOrder(symbol: string, qty: number, price?: number) {
    const session = getTradingSession();
    const isExtendedHours = session !== "market";
    try {
      const order = toBrokerOrder(
        await this.alpaca.createOrder({
          symbol,
          qty,
          side: "buy",
          type: isExtendedHours ? "limit" : "market",
          time_in_force: "day",
          extended_hours: isExtendedHours,
        }),
      );
      console.log(
        `💰 [EXEC] BUY PLACED: ${symbol} | Qty: ${qty.toFixed(4)} | ID: ${order.id}`,
      );
      return order;
    } catch (err: unknown) {
      if (brokerErrorMessage(err).includes("fractionable")) {
        console.error(
          `🔁 [EXEC] Fractional Buy Order Failed for ${symbol}, rounding up and retrying...`,
        );
        const rounded = Math.ceil(qty);
        try {
          const order = toBrokerOrder(
            await this.alpaca.createOrder({
              symbol,
              qty: rounded,
              side: "buy",
              type: "market",
              time_in_force: "day",
              extended_hours: isExtendedHours,
            }),
          );
          console.log(
            `💰 [EXEC] BUY PLACED: ${symbol} | Qty: ${qty.toFixed(4)} | ID: ${order.id}`,
          );
          return order;
        } catch (retryError: unknown) {
          console.error(
            `❌ [EXEC] Buy Order Failed for ${symbol}:`,
            brokerErrorMessage(retryError),
          );
        }
      } else {
        console.error(
          `❌ [EXEC] Buy Order Failed for ${symbol}:`,
          brokerErrorMessage(err),
        );
      }
    }
  }

  /** Retains legacy order policy while coordinating with protective submissions. */
  async closePosition(symbol: string, requestedQuantity?: number) {
    return this.withSubmissionLock(symbol, async () => {
      try {
        const orders = await this.getOpenOrders(symbol);
        for (const order of orders) {
          if (this.alpaca.getOrder) {
            await this.cancelProtectionOrder(order.id);
          } else {
            // Compatibility for older broker adapters without order lookup.
            if (!this.alpaca.cancelOrder)
              throw new Error("Broker cancellation is unavailable");
            try {
              await this.alpaca.cancelOrder(order.id);
            } catch (error: unknown) {
              if (brokerErrorStatus(error) !== 422) throw error;
            }
          }
        }
        if (orders.length > 0 && !this.alpaca.getOrder) {
          await sleep(1000);
        }

        let rawPosition: unknown;
        try {
          rawPosition = await this.alpaca.getPosition(symbol);
        } catch (error: unknown) {
          if (brokerErrorStatus(error) === 404) {
            console.log(
              `✅ [EXEC] No active position found for ${symbol}, nothing to close.`,
            );
            return;
          }
          throw error;
        }
        const position = requireRecord(rawPosition, "position");
        const positionQuantity = numericField(
          position.qty,
          "position quantity",
        );
        const quantity = requestedQuantity ?? positionQuantity;
        if (
          !Number.isFinite(quantity) ||
          quantity <= 0 ||
          quantity > positionQuantity
        ) {
          throw new Error(`Invalid sell quantity for ${symbol}: ${quantity}`);
        }
        const currentPrice = await this.getLegacyBarPrice(symbol);
        if (!this.submissionGuard())
          throw new Error("Exit submissions disabled by broker safety guard");
        const response = toBrokerOrder(
          await this.alpaca.createOrder({
            symbol,
            qty: quantity,
            side: "sell",
            type: "limit",
            limit_price: Number((currentPrice * 0.98).toFixed(2)),
            time_in_force: "day",
            extended_hours: true,
          }),
        );
        console.log(`📉 [EXEC] CLOSING POSITION: ${symbol}...`);
        return response;
      } catch (error: unknown) {
        console.error(`❌ [EXEC] Close Position Failed for ${symbol}:`, error);
        throw error;
      }
    });
  }

  async getProtectionOrder(
    clientOrderId: string,
  ): Promise<ProtectionBrokerOrder | undefined> {
    const lookup =
      this.alpaca.getOrderByClientOrderId ?? this.alpaca.getOrderByClientId;
    if (!lookup) throw new Error("Broker client-order lookup is unavailable");
    let raw: unknown;
    try {
      raw = await lookup.call(this.alpaca, clientOrderId);
    } catch (error: unknown) {
      if (brokerErrorStatus(error) === 404) return undefined;
      throw error;
    }
    const order = toProtectionBrokerOrder(raw);
    if (order.client_order_id && order.client_order_id !== clientOrderId) {
      throw new Error("Broker returned a different client order identifier");
    }
    if (isTerminalProtectionOrder(order))
      this.knownTerminalOrders.set(clientOrderId, order);
    return order;
  }

  async getProtectionOrderById(
    orderId: string,
  ): Promise<ProtectionBrokerOrder | undefined> {
    if (!this.alpaca.getOrder)
      throw new Error("Broker order lookup is unavailable");
    let raw: unknown;
    try {
      raw = await this.alpaca.getOrder(orderId);
    } catch (error: unknown) {
      if (brokerErrorStatus(error) === 404) return undefined;
      throw error;
    }
    const order = toProtectionBrokerOrder(raw);
    if (order.id !== orderId)
      throw new Error("Broker returned a different order identifier");
    if (order.client_order_id && isTerminalProtectionOrder(order)) {
      this.knownTerminalOrders.set(order.client_order_id, order);
    }
    return order;
  }

  async getProtectionSnapshot(symbol: string): Promise<ProtectionSnapshot> {
    // A failed order list is never interpreted as an empty list.
    const orders = await this.getOpenOrders(symbol);
    const position = await this.getLongPosition(symbol);
    if (!position) return { position: undefined, orders, price: undefined };
    try {
      const price = await this.getLatestProtectionPrice(symbol);
      return { position, orders, price };
    } catch {
      // Missing pricing keeps the local floor/recovery path active. Exposure
      // lookups above still fail closed; pricing must not block reconciliation.
      return { position, orders, price: undefined };
    }
  }

  /** A cancel response is not evidence of released shares. Poll broker state. */
  async cancelProtectionOrder(orderId: string): Promise<void> {
    if (!this.alpaca.cancelOrder || !this.alpaca.getOrder) {
      throw new Error("Confirmed broker cancellation is unavailable");
    }
    let cancelError: unknown;
    try {
      await this.alpaca.cancelOrder(orderId);
    } catch (error: unknown) {
      // A fill can win the race with cancellation, even when cancel rejects.
      cancelError = error;
    }
    for (let attempt = 0; attempt < CANCEL_POLL_ATTEMPTS; attempt += 1) {
      const order = toProtectionBrokerOrder(
        await this.alpaca.getOrder(orderId),
      );
      if (order.id !== orderId)
        throw new Error(
          "Broker returned a different order during cancellation",
        );
      if (isTerminalProtectionOrder(order)) {
        if (order.client_order_id)
          this.knownTerminalOrders.set(order.client_order_id, order);
        return;
      }
      if (attempt + 1 < CANCEL_POLL_ATTEMPTS)
        await sleep(CANCEL_POLL_INTERVAL_MS);
    }
    throw new Error(
      `Cancellation not confirmed for order ${orderId}${cancelError ? `: ${brokerErrorMessage(cancelError)}` : ""}`,
    );
  }

  async getHalfExitQuantity(symbol: string, totalQty: number): Promise<number> {
    if (!Number.isFinite(totalQty) || totalQty <= 0) {
      throw new Error(`Invalid half-exit quantity for ${symbol}: ${totalQty}`);
    }
    if (!this.alpaca.getAsset)
      throw new Error("Broker asset lookup is unavailable");
    const asset = requireRecord(await this.alpaca.getAsset(symbol), "asset");
    if (typeof asset.fractionable !== "boolean")
      throw new Error(`Unknown fractionability for ${symbol}`);
    const quantity = asset.fractionable
      ? floorQuantity(totalQty / 2)
      : Math.floor(totalQty / 2);
    const remaining = floorQuantity(totalQty - quantity);
    if (
      !(quantity > 0) ||
      !(remaining > 0) ||
      (!asset.fractionable && (!Number.isInteger(totalQty) || remaining < 1))
    ) {
      throw new Error(
        `Cannot split ${symbol} quantity ${totalQty} into two supported nonzero halves`,
      );
    }
    return quantity;
  }

  async submitProtectionExit(
    symbol: string,
    clientOrderId: string,
    requestedQuantity?: number,
    options?: ProtectionExitOptions,
    expected?: ProtectionExpectedExposure,
  ): Promise<ProtectionExecutionResult> {
    return this.withSubmissionLock(symbol, async () => {
      if (!symbol || !clientOrderId)
        throw new Error(
          "Protection exits require a symbol and stable client order ID",
        );
      if (
        requestedQuantity !== undefined &&
        (!Number.isFinite(requestedQuantity) || requestedQuantity <= 0)
      ) {
        throw new Error(
          `Invalid protection sell quantity for ${symbol}: ${requestedQuantity}`,
        );
      }
      if (
        expected &&
        (!Number.isFinite(expected.quantity) ||
          expected.quantity < 0 ||
          !Number.isFinite(expected.entryPrice) ||
          expected.entryPrice <= 0)
      ) {
        throw new Error("Invalid expected protection exposure");
      }
      // Query before any cancellation or submission, including on every retry.
      const existing =
        (await this.getProtectionOrder(clientOrderId)) ??
        this.knownTerminalOrders.get(clientOrderId);
      if (existing) return this.existingProtectionResult(symbol, existing);

      let session = await this.getProtectionSession();
      if (session === "closed")
        return {
          kind: "deferred",
          reason: "No executable broker trading session",
        };
      if (session === "extended" && !options) {
        return {
          kind: "deferred",
          reason: "Extended-hours limit policy has not been approved",
        };
      }
      if (options) validateExitOptions(options);

      const orders = await this.getOpenOrders(symbol);
      const listedExisting = orders.find(
        (order) => order.client_order_id === clientOrderId,
      );
      if (listedExisting)
        return this.existingProtectionResult(symbol, listedExisting);
      for (const order of orders) {
        if (!isTerminalProtectionOrder(order))
          await this.cancelProtectionOrder(order.id);
      }
      // Fills during cancellation alter exposure. Never use the pre-cancel quantity.
      const position = await this.getLongPosition(symbol);
      if (!position || position.qty === 0) return { kind: "closed" };
      validateExpectedExposure(position, expected);
      // Cancellation polling can cross a session boundary.
      session = await this.getProtectionSession();
      if (session === "closed")
        return {
          kind: "deferred",
          reason: "No executable broker trading session",
        };
      if (session === "extended" && !options) {
        return {
          kind: "deferred",
          reason: "Extended-hours limit policy has not been approved",
        };
      }
      const quantity = floorQuantity(
        Math.min(
          requestedQuantity ?? position.qty,
          position.qty,
          position.availableQuantity,
        ),
      );
      if (!(quantity > 0))
        return {
          kind: "deferred",
          reason: "No supported available share quantity",
        };

      const request: ExecutorOrderRequest = {
        symbol,
        qty: quantity,
        side: "sell",
        type: "market",
        time_in_force: "day",
        client_order_id: clientOrderId,
      };
      if (session === "extended") {
        // Options are required above; no default offset is silently introduced.
        if (!options)
          return {
            kind: "deferred",
            reason: "Extended-hours limit policy has not been approved",
          };
        const price = await this.getLatestProtectionPrice(symbol);
        const now = options.now ?? new Date();
        if (!price)
          return { kind: "deferred", reason: "No valid latest trade price" };
        const age = now.getTime() - Date.parse(price.timestamp);
        if (age < 0 || age > options.maxPriceAgeMs) {
          return {
            kind: "deferred",
            reason: "Latest trade price is stale or future-dated",
          };
        }
        const limit = floorLimitPrice(
          price.price * (1 - options.extendedLimitOffset),
        );
        if (!(limit > 0))
          return {
            kind: "deferred",
            reason: "Invalid extended-hours limit price",
          };
        request.type = "limit";
        request.limit_price = limit;
        request.extended_hours = true;
      }
      // Recheck the stable ID after asynchronous reconciliation and before submit.
      const reconciled = await this.getProtectionOrder(clientOrderId);
      if (reconciled) return this.existingProtectionResult(symbol, reconciled);
      // Session, price and ID lookups can race external fills. Refresh last and
      // only reduce the prepared sell; released shares must never increase it.
      const finalPosition = await this.getLongPosition(symbol);
      if (!finalPosition || finalPosition.qty === 0) return { kind: "closed" };
      validateExpectedExposure(finalPosition, expected);
      request.qty = floorQuantity(
        Math.min(
          request.qty,
          finalPosition.qty,
          finalPosition.availableQuantity,
        ),
      );
      if (!(request.qty > 0))
        return {
          kind: "deferred",
          reason: "No supported available share quantity",
        };
      try {
        if (!this.submissionGuard())
          return {
            kind: "deferred",
            reason: "Exit submissions disabled by broker safety guard",
          };
        const order = toProtectionBrokerOrder(
          await this.alpaca.createOrder(request),
        );
        this.validateProtectionOrder(symbol, order);
        if (order.client_order_id && order.client_order_id !== clientOrderId) {
          throw new Error(
            "Submitted broker order has a different client order identifier",
          );
        }
        if (isTerminalProtectionOrder(order))
          this.knownTerminalOrders.set(clientOrderId, order);
        return { kind: "submitted", order };
      } catch (error: unknown) {
        // A timeout/duplicate rejection may hide an accepted order; never blindly retry.
        const accepted = await this.getProtectionOrder(clientOrderId);
        if (accepted) return this.existingProtectionResult(symbol, accepted);
        throw error;
      }
    });
  }

  /** Native trailing stops do not support fractional shares. */
  async placeBreakEvenTrailingStop(symbol: string, entryPrice: number) {
    if (!Number.isFinite(entryPrice) || !(entryPrice > 0)) {
      throw new Error(
        `Cannot set a break-even trailing stop for ${symbol} without a valid entry price.`,
      );
    }
    try {
      const position = requireRecord(
        await this.alpaca.getPosition(symbol),
        "position",
      );
      const quantity = numericField(position.qty, "position quantity");
      if (!(quantity > 0))
        throw new Error(`No active position available for ${symbol}`);
      if (!Number.isInteger(quantity)) {
        throw new Error(
          `Fractional quantity ${quantity} for ${symbol} cannot use a native trailing_stop; use local protection`,
        );
      }
      const currentPrice = await this.getLegacyBarPrice(symbol);
      if (!(currentPrice > entryPrice)) {
        throw new Error(
          `Cannot establish a break-even trailing stop for ${symbol} at $${currentPrice}.`,
        );
      }
      const trailPrice = roundToPriceIncrement(currentPrice - entryPrice);
      if (!(trailPrice > 0))
        throw new Error(`Invalid trailing price for ${symbol}: ${trailPrice}`);
      const order = toBrokerOrder(
        await this.alpaca.createOrder({
          symbol,
          qty: quantity,
          side: "sell",
          type: "trailing_stop",
          trail_price: trailPrice,
          time_in_force: "gtc",
        }),
      );
      console.log(
        `🛡️ [EXEC] TRAILING STOP PLACED: ${symbol} | Qty: ${quantity} | Initial stop: $${entryPrice.toFixed(2)} | ID: ${order.id}`,
      );
      return order;
    } catch (error: unknown) {
      console.error(
        `❌ [EXEC] Trailing Stop Placement Failed for ${symbol}:`,
        error,
      );
      throw error;
    }
  }

  async killEverything() {
    try {
      console.log("☢️  PANIC INITIATED: Clearing all orders and positions...");
      if (!this.alpaca.cancelAllOrders || !this.alpaca.closeAllPositions)
        throw new Error("Broker panic APIs are unavailable");
      await this.alpaca.cancelAllOrders();
      console.log("🛑 All open orders canceled.");
      await this.alpaca.closeAllPositions();
      console.log("📉 All positions closed.");
      return { success: true };
    } catch (error: unknown) {
      console.error("❌ PANIC FAILED:", error);
      return { success: false, error };
    }
  }

  private async withSubmissionLock<T>(
    symbol: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.submissionLocks.get(symbol) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.submissionLocks.set(symbol, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.submissionLocks.get(symbol) === current)
        this.submissionLocks.delete(symbol);
    }
  }

  private validateProtectionOrder(
    symbol: string,
    order: ProtectionBrokerOrder,
  ): void {
    if (
      order.symbol !== symbol ||
      (order.side !== undefined && order.side !== "sell")
    ) {
      throw new Error(
        `Protection order does not match a long exit for ${symbol}`,
      );
    }
  }

  private existingProtectionResult(
    symbol: string,
    order: ProtectionBrokerOrder,
  ): ProtectionExecutionResult {
    this.validateProtectionOrder(symbol, order);
    return {
      kind: isTerminalProtectionOrder(order) ? "terminal" : "working",
      order,
    };
  }

  private async getOpenOrders(
    symbol: string,
  ): Promise<ProtectionBrokerOrder[]> {
    if (!this.alpaca.getOrders)
      throw new Error("Broker order listing is unavailable");
    const raw = await this.alpaca.getOrders({
      status: "open",
      until: undefined,
      after: undefined,
      limit: 500,
      direction: undefined,
      nested: undefined,
      symbols: [symbol],
    });
    if (!Array.isArray(raw)) throw new Error("Invalid broker order list");
    // A full page may hide additional reservations; fail closed instead of guessing.
    if (raw.length >= 500)
      throw new Error("Broker order list may be truncated");
    return raw
      .map((value: unknown) => toProtectionBrokerOrder(value))
      .filter((order) => order.symbol === symbol);
  }

  private async getLongPosition(
    symbol: string,
  ): Promise<ProtectionSnapshot["position"]> {
    let raw: unknown;
    try {
      raw = await this.alpaca.getPosition(symbol);
    } catch (error: unknown) {
      if (brokerErrorStatus(error) === 404) return undefined;
      throw error;
    }
    const position = requireRecord(raw, "position");
    const qty = numericField(position.qty, "position quantity");
    if (qty < 0 || (position.side !== undefined && position.side !== "long")) {
      throw new Error(
        `Protection exits support long positions only: ${symbol}`,
      );
    }
    const available = numericField(
      position.qty_available,
      "available position quantity",
    );
    if (available < 0)
      throw new Error(`Invalid available quantity for ${symbol}`);
    const entryPrice = numericField(
      position.avg_entry_price,
      "position entry price",
    );
    if (!(entryPrice > 0)) throw new Error(`Invalid entry price for ${symbol}`);
    return { qty, availableQuantity: Math.min(qty, available), entryPrice };
  }

  private async getLatestProtectionPrice(
    symbol: string,
  ): Promise<ProtectionSnapshot["price"]> {
    if (!this.alpaca.getLatestTrade) return undefined;
    const trade = requireRecord(
      await this.alpaca.getLatestTrade(symbol),
      "latest trade",
    );
    const rawPrice = trade.Price ?? trade.price ?? trade.p;
    const timestamp = trade.Timestamp ?? trade.timestamp ?? trade.t;
    if (
      (typeof rawPrice !== "number" && typeof rawPrice !== "string") ||
      typeof timestamp !== "string"
    )
      return undefined;
    const price = Number(rawPrice);
    if (
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(Date.parse(timestamp))
    )
      return undefined;
    return { price, timestamp };
  }

  private async getProtectionSession(): Promise<
    "regular" | "extended" | "closed"
  > {
    if (!this.alpaca.getClock || !this.alpaca.getCalendar)
      throw new Error("Broker clock/calendar lookup is unavailable");
    const clock = requireRecord(await this.alpaca.getClock(), "clock");
    if (
      typeof clock.timestamp !== "string" ||
      typeof clock.is_open !== "boolean" ||
      !Number.isFinite(Date.parse(clock.timestamp))
    ) {
      throw new Error("Invalid broker clock");
    }
    const { dateKey, hour, minute } = getEasternTimeParts(clock.timestamp);
    const calendar = await this.alpaca.getCalendar({
      start: dateKey,
      end: dateKey,
    });
    if (!Array.isArray(calendar)) throw new Error("Invalid broker calendar");
    const day: unknown = calendar.find(
      (value: unknown) => isRecord(value) && value.date === dateKey,
    );
    if (!isRecord(day)) return "closed"; // Includes weekends and market holidays.
    const open = calendarMinutes(day.open);
    const close = calendarMinutes(day.close);
    if (open === undefined || close === undefined || close <= open)
      throw new Error("Invalid broker calendar hours");
    const minutes = hour * 60 + minute;
    if (clock.is_open && minutes >= open && minutes < close) return "regular";
    if (
      !clock.is_open &&
      ((minutes >= 4 * 60 && minutes < open) ||
        (minutes >= close && minutes < 20 * 60))
    ) {
      return "extended";
    }
    return "closed";
  }

  private async getLegacyBarPrice(symbol: string): Promise<number> {
    if (!this.alpaca.getLatestBars)
      throw new Error("Broker bar lookup is unavailable");
    const bars = await this.alpaca.getLatestBars([symbol]);
    if (!(bars instanceof Map))
      throw new Error(`Unable to fetch real-time pricing data for ${symbol}`);
    const bar: unknown = bars.get(symbol);
    if (!isRecord(bar))
      throw new Error(`Unable to fetch real-time pricing data for ${symbol}`);
    return numericField(bar.ClosePrice, "bar price");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid broker ${label}`);
  return value;
}

function toBrokerOrder(value: unknown): ExecutorBrokerOrder {
  const raw = requireRecord(value, "order");
  if (typeof raw.id !== "string" || !raw.id)
    throw new Error("Broker order is missing ID");
  const order: ExecutorBrokerOrder = { id: raw.id };
  for (const key of [
    "symbol",
    "client_order_id",
    "side",
    "type",
    "status",
  ] as const) {
    const field = raw[key];
    if (field !== undefined && typeof field !== "string")
      throw new Error(`Invalid broker order ${key}`);
    if (typeof field === "string") order[key] = field;
  }
  for (const key of [
    "qty",
    "filled_qty",
    "filled_avg_price",
    "limit_price",
    "hwm",
    "stop_price",
    "trail_price",
  ] as const) {
    const field = raw[key];
    if (field === undefined) continue;
    if (field === null) {
      if (key === "qty" || key === "filled_qty")
        throw new Error(`Invalid broker order ${key}`);
      order[key] = null;
    } else if (
      (typeof field === "number" || typeof field === "string") &&
      Number.isFinite(Number(field)) &&
      String(field).trim() !== ""
    ) {
      order[key] = field;
    } else {
      throw new Error(`Invalid broker order ${key}`);
    }
  }
  for (const key of ["filled_at", "submitted_at"] as const) {
    const field = raw[key];
    if (field !== undefined && field !== null && typeof field !== "string")
      throw new Error(`Invalid broker order ${key}`);
    if (field !== undefined) order[key] = field;
  }
  return order;
}

function numericField(value: unknown, label: string): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    String(value).trim() === ""
  )
    throw new Error(`Invalid ${label}`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid ${label}`);
  return number;
}

function brokerErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error) || !isRecord(error.response)) return undefined;
  return typeof error.response.status === "number"
    ? error.response.status
    : undefined;
}

function brokerErrorMessage(error: unknown): string {
  if (
    isRecord(error) &&
    isRecord(error.response) &&
    isRecord(error.response.data) &&
    typeof error.response.data.message === "string"
  ) {
    return error.response.data.message;
  }
  return error instanceof Error ? error.message : "Unknown broker error";
}

/** Truncate decimal precision without an epsilon that could round a sell upward. */
function floorQuantity(quantity: number): number {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  if (Number.isInteger(quantity)) return quantity;
  const [coefficient = "0", exponentText = "0"] = quantity
    .toString()
    .toLowerCase()
    .split("e");
  const [whole = "0", fraction = ""] = coefficient.split(".");
  const digits = whole + fraction;
  const decimalIndex = whole.length + Number(exponentText);
  const expanded =
    decimalIndex <= 0
      ? `0.${"0".repeat(-decimalIndex)}${digits}`
      : `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  const [integerPart = "0", decimalPart = ""] = expanded.split(".");
  return Number(`${integerPart}.${decimalPart.slice(0, 9)}`);
}

function calendarMinutes(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{2}:\d{2}(?::\d{2})?$/.test(value))
    return undefined;
  const [hour = "0", minute = "0"] = value.split(":");
  const h = Number(hour);
  const m = Number(minute);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59 ? h * 60 + m : undefined;
}

function validateExpectedExposure(
  position: NonNullable<ProtectionSnapshot["position"]>,
  expected?: ProtectionExpectedExposure,
): void {
  if (
    expected &&
    (position.qty > expected.quantity + 1e-9 ||
      Math.abs(position.entryPrice - expected.entryPrice) >
        Math.max(0.01, expected.entryPrice * 1e-6))
  ) {
    throw new Error("Attribution changed during cancellation");
  }
}

function validateExitOptions(options: ProtectionExitOptions): void {
  if (
    !Number.isFinite(options.extendedLimitOffset) ||
    options.extendedLimitOffset < 0 ||
    options.extendedLimitOffset >= 1
  ) {
    throw new Error(
      "Extended-hours offset must be a finite discount in [0, 1)",
    );
  }
  if (
    !Number.isFinite(options.maxPriceAgeMs) ||
    options.maxPriceAgeMs < 0 ||
    (options.now && !Number.isFinite(options.now.getTime()))
  ) {
    throw new Error("Invalid maximum price age or current timestamp");
  }
}

function floorLimitPrice(price: number): number {
  const scale = price >= 1 ? 100 : 10_000;
  return Math.floor(price * scale) / scale;
}

function roundToPriceIncrement(price: number): number {
  return Number(price.toFixed(price >= 1 ? 2 : 4));
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
