export type TradeOrder = {
  id: string;
  lifecycleId?: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  filledAt: string;
  orderId?: string;
  executionId?: string;
  orderType?: string;
  reason: string;
  strategy?: string;
  source: "ledger" | "journal";
  sequence: number;
};

export type Trade = {
  id: string;
  symbol: string;
  strategy: string;
  status: "open" | "partially_closed" | "closed";
  priceOpen: number;
  priceClose?: number;
  pnl: number;
  pnlPct: number;
  qty: number;
  exitedQty: number;
  remainingQty: number;
  isWinner: boolean;
  openedOn: string;
  closedOn?: string;
  orders: TradeOrder[];
};

export type History = {
  groupedTrades: Trade[];
  rawLogs: TradeOrder[];
};

export type TradeStats = {
  tradesPerDay: number;
  tradesToday: number;
  totalTrades: number;
  dailyPnL: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
};

type LifecycleFill = {
  executionId: string;
  orderId: string;
  orderType: string;
  side: "buy" | "sell";
  price: number;
  quantity: number;
  filledAt: string;
  reason?: string;
};

type LifecycleRecord = {
  id: string;
  symbol: string;
  profile: { strategy: string };
  entryFills: LifecycleFill[];
  exitFills: LifecycleFill[];
};

type JournalRecord = {
  symbol: string;
  side: "buy" | "sell";
  qty: string;
  price: string;
  timestamp: string;
  reason?: string;
  strategy?: string;
  lifecycle_id?: string;
  order_id?: string;
  execution_id?: string;
  order_type?: string;
};

type HistoryPayload = {
  lifecycles: unknown[];
  records: unknown[];
};

const QUANTITY_EPSILON = 0.000_001;

export function formatHistory(history: unknown): History {
  const payload = normalizeHistoryPayload(history);
  const ledgerOrders = payload.lifecycles.flatMap((lifecycle, lifecycleIndex) =>
    toLedgerOrders(lifecycle, lifecycleIndex),
  );
  const journalOrders = payload.records.flatMap((record, recordIndex) =>
    toJournalOrder(record, recordIndex),
  );
  const rawLogs = dedupeOrders([...ledgerOrders, ...journalOrders]);

  return {
    rawLogs,
    groupedTrades: groupOrders(rawLogs, payload.lifecycles).sort(
      (left, right) => Date.parse(right.openedOn) - Date.parse(left.openedOn),
    ),
  };
}

export function getStats(
  groupedTrades: Trade[],
  strategy: string,
  limit: number,
): TradeStats {
  const completedTrades = groupedTrades.filter(
    (trade) =>
      trade.status === "closed" &&
      (strategy === "none" || trade.strategy === strategy),
  );
  const limitedTrades =
    limit > 0 ? completedTrades.slice(0, limit) : completedTrades;
  const tradesPerDay = new Map<string, number>();
  let totalPnl = 0;
  let wins = 0;
  let totalWin = 0;
  let losses = 0;
  let totalLoss = 0;

  for (const trade of limitedTrades) {
    totalPnl += trade.pnl;
    const day = (trade.closedOn ?? trade.openedOn).slice(0, 10);
    tradesPerDay.set(day, (tradesPerDay.get(day) ?? 0) + 1);

    if (trade.pnl > 0) {
      wins += 1;
      totalWin += trade.pnl;
    } else if (trade.pnl < 0) {
      losses += 1;
      totalLoss += trade.pnl;
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const count = limitedTrades.length;
  return {
    tradesPerDay:
      tradesPerDay.size === 0 ? 0 : Math.floor(count / tradesPerDay.size),
    tradesToday: tradesPerDay.get(today) ?? 0,
    totalTrades: count,
    dailyPnL: count === 0 ? 0 : totalPnl / count,
    winRate: count === 0 ? 0 : wins / count,
    avgWin: wins === 0 ? 0 : totalWin / wins,
    avgLoss: losses === 0 ? 0 : totalLoss / losses,
  };
}

export async function fetchTradeHistory(): Promise<History> {
  try {
    const response = await fetch("http://localhost:4001/history");
    if (response.ok) {
      return formatHistory(await response.json());
    }
  } catch (error) {
    console.error("History fetch failed:", error);
  }

  return { groupedTrades: [], rawLogs: [] };
}

function normalizeHistoryPayload(history: unknown): HistoryPayload {
  if (isHistoryPayload(history)) {
    return {
      lifecycles: history.lifecycles.filter(isLifecycleRecord),
      records: history.records.filter(isJournalRecord),
    };
  }

  // Supports the lifecycle-array response emitted by older engine builds.
  return Array.isArray(history)
    ? { lifecycles: history.filter(isLifecycleRecord), records: [] }
    : { lifecycles: [], records: [] };
}

function groupOrders(orders: TradeOrder[], lifecycles: unknown[]): Trade[] {
  const strategyByLifecycle = new Map(
    lifecycles
      .filter(isLifecycleRecord)
      .map((lifecycle) => [lifecycle.id, lifecycle.profile.strategy]),
  );
  const lifecycleGroups = new Map<string, TradeOrder[]>();
  const unlinkedOrders: TradeOrder[] = [];

  for (const order of orders) {
    if (order.lifecycleId) {
      const lifecycleOrders = lifecycleGroups.get(order.lifecycleId) ?? [];
      lifecycleOrders.push(order);
      lifecycleGroups.set(order.lifecycleId, lifecycleOrders);
    } else {
      unlinkedOrders.push(order);
    }
  }

  const linkedTrades = Array.from(lifecycleGroups, ([id, lifecycleOrders]) =>
    toTrade(
      id,
      lifecycleOrders,
      strategyByLifecycle.get(id) ?? getEntryStrategy(lifecycleOrders),
    ),
  );

  return [
    ...linkedTrades,
    ...groupUnlinkedOrders(unlinkedOrders).map((group, index) =>
      toTrade(
        `journal:${group.symbol}:${group.openedAt}:${index}`,
        group.orders,
        getEntryStrategy(group.orders),
      ),
    ),
  ];
}

function groupUnlinkedOrders(orders: TradeOrder[]): Array<{
  symbol: string;
  openedAt: string;
  orders: TradeOrder[];
}> {
  const groupedBySymbol = new Map<string, TradeOrder[]>();
  for (const order of orders) {
    const symbolOrders = groupedBySymbol.get(order.symbol) ?? [];
    symbolOrders.push(order);
    groupedBySymbol.set(order.symbol, symbolOrders);
  }

  const groups: Array<{
    symbol: string;
    openedAt: string;
    orders: TradeOrder[];
  }> = [];
  for (const [symbol, symbolOrders] of groupedBySymbol) {
    const sortedOrders = sortOrders(symbolOrders);
    let currentGroup: TradeOrder[] = [];
    let currentBuyOrderId: string | undefined;

    for (const order of sortedOrders) {
      if (order.side === "buy") {
        const continuesEntry =
          currentGroup.length > 0 &&
          currentBuyOrderId !== undefined &&
          currentBuyOrderId === order.orderId;

        if (!continuesEntry && currentGroup.length > 0) {
          groups.push({
            symbol,
            openedAt: currentGroup[0].filledAt,
            orders: currentGroup,
          });
          currentGroup = [];
        }

        currentGroup.push(order);
        currentBuyOrderId = order.orderId;
        continue;
      }

      if (currentGroup.length === 0) continue;
      currentGroup.push(order);

      if (
        sumQuantities(currentGroup, "sell") + QUANTITY_EPSILON >=
        sumQuantities(currentGroup, "buy")
      ) {
        groups.push({
          symbol,
          openedAt: currentGroup[0].filledAt,
          orders: currentGroup,
        });
        currentGroup = [];
        currentBuyOrderId = undefined;
      }
    }

    if (currentGroup.length > 0) {
      groups.push({
        symbol,
        openedAt: currentGroup[0].filledAt,
        orders: currentGroup,
      });
    }
  }

  return groups;
}

function toTrade(
  id: string,
  sourceOrders: TradeOrder[],
  strategy: string,
): Trade {
  const orders = sortOrders(sourceOrders);
  const entryOrders = orders.filter((order) => order.side === "buy");
  const exitOrders = orders.filter((order) => order.side === "sell");
  const qty = sumQuantities(entryOrders);
  const exitedQty = sumQuantities(exitOrders);
  const remainingQty = Math.max(0, qty - exitedQty);
  const priceOpen = weightedAveragePrice(entryOrders) ?? 0;
  const priceClose = weightedAveragePrice(exitOrders);
  const pnl = exitOrders.reduce(
    (total, order) => total + (order.price - priceOpen) * order.quantity,
    0,
  );
  const exitedBasis = priceOpen * exitedQty;
  const status =
    exitedQty + QUANTITY_EPSILON >= qty && qty > 0
      ? "closed"
      : exitedQty > 0
        ? "partially_closed"
        : "open";

  return {
    id,
    symbol: orders[0]?.symbol ?? "UNKNOWN",
    strategy,
    status,
    priceOpen,
    ...(priceClose === undefined ? {} : { priceClose }),
    pnl,
    pnlPct: exitedBasis > 0 ? pnl / exitedBasis : 0,
    qty,
    exitedQty,
    remainingQty,
    isWinner: pnl > 0,
    openedOn: entryOrders[0]?.filledAt ?? orders[0]?.filledAt ?? "",
    ...(status === "closed" && exitOrders.length > 0
      ? { closedOn: exitOrders.at(-1)?.filledAt }
      : {}),
    orders,
  };
}

function toLedgerOrders(
  lifecycle: unknown,
  lifecycleIndex: number,
): TradeOrder[] {
  if (!isLifecycleRecord(lifecycle)) return [];

  return [...lifecycle.entryFills, ...lifecycle.exitFills].map(
    (fill, fillIndex) => ({
      id: fill.executionId,
      lifecycleId: lifecycle.id,
      symbol: lifecycle.symbol,
      side: fill.side,
      quantity: fill.quantity,
      price: fill.price,
      filledAt: fill.filledAt,
      orderId: fill.orderId,
      executionId: fill.executionId,
      orderType: fill.orderType,
      reason:
        fill.reason ??
        (fill.side === "buy" ? lifecycle.profile.strategy : "EXIT"),
      strategy: lifecycle.profile.strategy,
      source: "ledger",
      sequence: lifecycleIndex * 1_000 + fillIndex,
    }),
  );
}

function toJournalOrder(record: unknown, sequence: number): TradeOrder[] {
  if (!isJournalRecord(record)) return [];

  const quantity = Number(record.qty);
  const price = Number(record.price);
  if (
    !(quantity > 0) ||
    !(price > 0) ||
    !Number.isFinite(Date.parse(record.timestamp))
  ) {
    return [];
  }

  return [
    {
      id:
        record.execution_id ??
        record.order_id ??
        `journal:${record.symbol}:${record.side}:${record.timestamp}:${sequence}`,
      ...(record.lifecycle_id ? { lifecycleId: record.lifecycle_id } : {}),
      symbol: record.symbol,
      side: record.side,
      quantity,
      price,
      filledAt: record.timestamp,
      ...(record.order_id ? { orderId: record.order_id } : {}),
      ...(record.execution_id ? { executionId: record.execution_id } : {}),
      ...(record.order_type ? { orderType: record.order_type } : {}),
      reason: record.reason ?? (record.side === "buy" ? "ENTRY" : "EXIT"),
      ...(record.strategy ? { strategy: record.strategy } : {}),
      source: "journal",
      sequence,
    },
  ];
}

function dedupeOrders(orders: TradeOrder[]): TradeOrder[] {
  const byIdentity = new Map<string, TradeOrder>();
  for (const order of orders) {
    const identity =
      order.executionId !== undefined
        ? `execution:${order.executionId}`
        : [
            order.symbol,
            order.side,
            order.orderId ?? "",
            order.filledAt,
            order.quantity,
            order.price,
          ].join(":");
    const existing = byIdentity.get(identity);
    if (!existing || order.source === "journal") {
      byIdentity.set(identity, {
        ...existing,
        ...order,
        strategy: order.strategy ?? existing?.strategy,
        reason: order.reason || existing?.reason || "EXIT",
      });
    }
  }
  return sortOrders(Array.from(byIdentity.values()));
}

function sortOrders(orders: TradeOrder[]): TradeOrder[] {
  return [...orders].sort(
    (left, right) =>
      Date.parse(left.filledAt) - Date.parse(right.filledAt) ||
      left.sequence - right.sequence ||
      (left.side === "buy" ? -1 : 1),
  );
}

function sumQuantities(orders: TradeOrder[], side?: "buy" | "sell"): number {
  return orders
    .filter((order) => side === undefined || order.side === side)
    .reduce((total, order) => total + order.quantity, 0);
}

function weightedAveragePrice(orders: TradeOrder[]): number | undefined {
  const quantity = sumQuantities(orders);
  if (!(quantity > 0)) return undefined;
  return (
    orders.reduce((total, order) => total + order.price * order.quantity, 0) /
    quantity
  );
}

function getEntryStrategy(orders: TradeOrder[]): string {
  return (
    orders.find((order) => order.side === "buy")?.strategy ??
    orders.find((order) => order.strategy)?.strategy ??
    "UnknownStrategy"
  );
}

function isHistoryPayload(value: unknown): value is {
  lifecycles: unknown[];
  records: unknown[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Partial<HistoryPayload>;
  return Array.isArray(payload.lifecycles) && Array.isArray(payload.records);
}

function isLifecycleRecord(value: unknown): value is LifecycleRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const lifecycle = value as Partial<LifecycleRecord>;
  return (
    typeof lifecycle.id === "string" &&
    typeof lifecycle.symbol === "string" &&
    typeof lifecycle.profile?.strategy === "string" &&
    Array.isArray(lifecycle.entryFills) &&
    lifecycle.entryFills.every(isLifecycleFill) &&
    Array.isArray(lifecycle.exitFills) &&
    lifecycle.exitFills.every(isLifecycleFill)
  );
}

function isLifecycleFill(value: unknown): value is LifecycleFill {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fill = value as Partial<LifecycleFill>;
  return (
    typeof fill.executionId === "string" &&
    typeof fill.orderId === "string" &&
    typeof fill.orderType === "string" &&
    (fill.side === "buy" || fill.side === "sell") &&
    typeof fill.price === "number" &&
    typeof fill.quantity === "number" &&
    typeof fill.filledAt === "string"
  );
}

function isJournalRecord(value: unknown): value is JournalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<JournalRecord>;
  return (
    typeof record.symbol === "string" &&
    (record.side === "buy" || record.side === "sell") &&
    typeof record.qty === "string" &&
    typeof record.price === "string" &&
    typeof record.timestamp === "string"
  );
}
