export type TradeExit = {
  orderId: string;
  orderType: string;
  reason: string;
  quantity: number;
  price: number;
  filledAt: string;
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
  exits: TradeExit[];
};

export type History = {
  groupedTrades: Trade[];
  rawLogs: LifecycleRecord[];
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
  orderId: string;
  orderType: string;
  reason?: string;
  price: number;
  quantity: number;
  filledAt: string;
};

type LifecycleRecord = {
  id: string;
  symbol: string;
  status: "open" | "partially_closed" | "closed";
  openedAt: string;
  closedAt?: string;
  profile: { strategy: string };
  entryQuantity: number;
  exitedQuantity: number;
  remainingQuantity: number;
  averageEntryPrice: number;
  averageExitPrice?: number;
  realizedPnl: number;
  realizedPnlPct: number;
  exitFills: LifecycleFill[];
};

function isLifecycleRecord(value: unknown): value is LifecycleRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Partial<LifecycleRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.symbol === "string" &&
    (record.status === "open" ||
      record.status === "partially_closed" ||
      record.status === "closed") &&
    typeof record.openedAt === "string" &&
    typeof record.profile?.strategy === "string" &&
    typeof record.entryQuantity === "number" &&
    typeof record.exitedQuantity === "number" &&
    typeof record.remainingQuantity === "number" &&
    typeof record.averageEntryPrice === "number" &&
    typeof record.realizedPnl === "number" &&
    typeof record.realizedPnlPct === "number" &&
    Array.isArray(record.exitFills)
  );
}

function toDisplayTrade(lifecycle: LifecycleRecord): Trade {
  return {
    id: lifecycle.id,
    symbol: lifecycle.symbol,
    strategy: lifecycle.profile.strategy,
    status: lifecycle.status,
    priceOpen: lifecycle.averageEntryPrice,
    ...(lifecycle.averageExitPrice !== undefined
      ? { priceClose: lifecycle.averageExitPrice }
      : {}),
    pnl: lifecycle.realizedPnl,
    pnlPct: lifecycle.realizedPnlPct,
    qty: lifecycle.entryQuantity,
    exitedQty: lifecycle.exitedQuantity,
    remainingQty: lifecycle.remainingQuantity,
    isWinner: lifecycle.realizedPnl > 0,
    openedOn: lifecycle.openedAt,
    ...(lifecycle.closedAt ? { closedOn: lifecycle.closedAt } : {}),
    exits: lifecycle.exitFills.map((fill) => ({
      orderId: fill.orderId,
      orderType: fill.orderType,
      reason: fill.reason ?? "EXIT",
      quantity: fill.quantity,
      price: fill.price,
      filledAt: fill.filledAt,
    })),
  };
}

function formatHistory(history: unknown): History {
  const rawLogs = Array.isArray(history)
    ? history.filter(isLifecycleRecord)
    : [];

  return {
    rawLogs,
    groupedTrades: rawLogs
      .map(toDisplayTrade)
      .sort(
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
