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
  tradeLogs: any[];
};

export type History = {
  stats: [];
  groupedTrades: any[];
  rawLogs: any[];
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

function logTrades(history): History {
  const rawLogs = Array.isArray(history) ? history : [];
  const groupedTrades = groupTrades(rawLogs);
  const stats = getStats(rawLogs, groupedTrades);
  return {
    stats,
    groupedTrades,
    rawLogs,
  };
}

function getStats(history, groupedTrades) {
  console.log("getStats");

  let winCount = 0;
  let pnl = 0;
  const tradesPerDay = new Map();

  for (const g of groupedTrades) {
    try {
      winCount += g.isWinner ? 1 : 0;
      pnl += g.pnl
      
      const date = g.openedOn.substring(0, 10);
      if (!tradesPerDay.has(date)) {
        tradesPerDay.set(date, 0)
      }
      tradesPerDay.set(date, tradesPerDay.get(date) + 1);
      
    } catch (error) {
      console.error(error);
    }
  }

  const [todayKey, todayValue] = tradesPerDay.entries().next().value; 
  const tradeCount = groupedTrades.length;
  const avgTrades = tradeCount / Array.from(tradesPerDay).length;

  return {
    tradesPerDay: Math.floor(avgTrades),
    tradesToday: todayValue,
    totalTrades: tradeCount,
    dailyPnL: pnl / tradeCount,
    winRate: winCount,
    avgWin: 0,
    avgLoss: 0,
  };
}

function groupTrades(history) {
  const set = new Map();
  for (const h of history) {
    const tradeKey = `${h.symbol}:${h.qty}`;
    if (!set.has(tradeKey)) {
      set.set(tradeKey, []);
    }
    set.get(tradeKey)!.push(h);
  }

  return tradeGroupStats(Array.from(set.values()));
}

function tradeGroupStats(tradeGroups) {
  const analyzedGroups = [];
  for (const t of tradeGroups) {
    if (!t.length || t.length !== 2) {
      continue;
    }
    const pnl = Number(t[1].filled_avg_price) - Number(t[0].filled_avg_price);
    const pnlPct = pnl / Number(t[0].filled_avg_price);
    const isWinner = pnl > 0;
    const stats: Trade = {
      symbol: t[0].symbol,
      strategy: "test",
      priceOpen: t[0].filled_avg_price,
      priceClose: t[1].filled_avg_price,
      pnl: pnl,
      pnlPct: pnlPct,
      qty: t[0].qty,
      isWinner: isWinner,
      openedOn: t[0].filled_at,
      closedOn: t[1].filled_at,
      tradeLogs: t,
    };

    analyzedGroups.push(stats);
  }
  return analyzedGroups;
}

export async function fetchTradeHistory() {
  try {
    const response = await fetch("http://localhost:4001/history");
    if (response.ok) {
      const history = await response.json();
      return logTrades(history);
    }
  } catch (err) {
    console.log(`History fetch FAILED: ${err}`);
  }
}
