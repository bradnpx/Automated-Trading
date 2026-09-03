export type Trade = {
  symbol: string;
  strategy: string;
  priceOpen: number;
  priceClose: number;
  pnl: number;
  pnlPct: number;
  qty: number;
  isWinner: boolean;
  openedOn: string;
  closedOn: string;
  tradeLogs: unknown[];
};

export type History = {
  stats: TradeStats[];
  groupedTrades: Trade[];
  rawLogs: unknown[];
};

export type TradeStats = {
  tradesPerDay: number;
  tradesToday: number | string;
  totalTrades: number;
  dailyPnL: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
};

type LifecycleFill = {
  price: number;
  quantity: number;
  filledAt: string;
};

type LifecycleClosedTrade = {
  id: string;
  symbol: string;
  strategy: string;
  openedAt: string;
  closedAt: string;
  entryQuantity: number;
  exitQuantity: number;
  averageEntryPrice: number;
  averageExitPrice?: number;
  realizedPnl?: number;
  realizedPnlPct?: number;
  entryFills: LifecycleFill[];
  exitFills: LifecycleFill[];
};

function isLifecycleClosedTrade(value: unknown): value is LifecycleClosedTrade {
  if (!value || typeof value !== "object") return false;
  const trade = value as Partial<LifecycleClosedTrade>;
  return (
    typeof trade.id === "string" &&
    typeof trade.symbol === "string" &&
    typeof trade.strategy === "string" &&
    typeof trade.openedAt === "string" &&
    typeof trade.closedAt === "string" &&
    typeof trade.averageEntryPrice === "number" &&
    Array.isArray(trade.entryFills) &&
    Array.isArray(trade.exitFills)
  );
}

function toDisplayTrade(trade: LifecycleClosedTrade): Trade {
  const quantity = trade.exitQuantity || trade.entryQuantity;
  const priceOpen = trade.averageEntryPrice;
  const priceClose = trade.averageExitPrice ?? priceOpen;
  const totalPnl = trade.realizedPnl ?? (priceClose - priceOpen) * quantity;
  const pnl = quantity > 0 ? totalPnl / quantity : 0;
  const pnlPct =
    trade.realizedPnlPct ?? (priceOpen === 0 ? 0 : (priceClose - priceOpen) / priceOpen);

  return {
    symbol: trade.symbol,
    strategy: trade.strategy,
    priceOpen,
    priceClose,
    pnl,
    pnlPct,
    qty: quantity,
    isWinner: totalPnl > 0,
    openedOn: trade.openedAt,
    closedOn: trade.closedAt,
    tradeLogs: [...trade.entryFills, ...trade.exitFills],
  };
}

function formatHistory(history: unknown): History {
  const rawLogs = Array.isArray(history) ? history : [];
  const groupedTrades = rawLogs
    .filter(isLifecycleClosedTrade)
    .map(toDisplayTrade);

  return { stats: [], groupedTrades, rawLogs };
}

export function getStats(
  rawLogs: unknown[],
  groupedTrades: Trade[],
  strategy: string,
  limit: number,
) {
  void rawLogs;
  let winCount = 0;
  let totalPnl = 0;
  let count = 0;
  const tradesPerDay = new Map<string, number>();

  for (const trade of groupedTrades) {
    if (limit > 0 && count >= limit) break;
    if (strategy !== "none" && trade.strategy !== strategy) continue;

    winCount += trade.isWinner ? 1 : 0;
    totalPnl += trade.pnl * trade.qty;
    const date = trade.openedOn.substring(0, 10);
    tradesPerDay.set(date, (tradesPerDay.get(date) ?? 0) + 1);
    count += 1;
  }

  const today = new Date().toISOString().slice(0, 10);
  const averageTrades =
    tradesPerDay.size === 0 ? 0 : count / tradesPerDay.size;

  return {
    tradesPerDay: Math.floor(averageTrades),
    tradesToday: tradesPerDay.get(today) ?? 0,
    totalTrades: count,
    dailyPnL: count === 0 ? 0 : totalPnl / count,
    winRate: count === 0 ? 0 : winCount / count,
    avgWin: 0,
    avgLoss: 0,
  };
}

export async function fetchTradeHistory(): Promise<History> {
  try {
    const response = await fetch("http://localhost:4001/history");
    if (response.ok) return formatHistory(await response.json());
  } catch (error) {
    console.error("History fetch failed:", error);
  }
  return { stats: [], groupedTrades: [], rawLogs: [] };
}

export async function fetchWatchlist(): Promise<Record<string, unknown>> {
  try {
    const response = await fetch("http://localhost:4001/watchlist", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return {};
    const watchlist = await response.json();
    return typeof watchlist === "string" ? JSON.parse(watchlist) : watchlist;
  } catch (error) {
    console.error("Watchlist fetch failed:", error);
    return {};
  }
}
