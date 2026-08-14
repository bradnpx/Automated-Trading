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
  groupedTrades: Trade[];
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

function getStrategy(symbol, watchlist) {
  // console.log(watchlist[symbol]?.strategy)
  return watchlist[symbol]?.strategy || "dayTradeMicroScalp";
}

function logTrades(history, watchlist): History {
  const rawLogs = Array.isArray(history) ? history : [];
  const groupedTrades = groupTrades(rawLogs, watchlist);
  return {
    groupedTrades,
    rawLogs,
  };
}

export function getStats(rawLogs, groupedTrades, strategy, limit) {
  let winCount = 0;
  let avgLoss = 0;
  let avgWin = 0;
  let totalPnl = 0;
  let count = 0;
  const tradesPerDay = new Map();

  for (const g of groupedTrades) {
    if (limit > 0 && count > limit) {
      console.log(count, limit)
      break
    }
    if (strategy !== 'none' && g.strategy !== strategy) {
      continue
    }
    
    try {
      winCount += g.isWinner ? 1 : 0;
      totalPnl += g.pnl * g.qty;

      const date = g.openedOn.substring(0, 10);
      if (!tradesPerDay.has(date)) {
        tradesPerDay.set(date, 0);
      }
      tradesPerDay.set(date, tradesPerDay.get(date) + 1);
      count++
    } catch (error) {
      console.error(error);
    }
  }

  const todayEntry = Array.from(tradesPerDay)[0];
  const todayValue = todayEntry ? todayEntry[1] : undefined;
  const tradeCount = count;
  const avgTrades = tradeCount / Array.from(tradesPerDay).length;
  
  // console.log(tradeCount, totalPnl, totalPnl / tradeCount)
  return {
    tradesPerDay: Math.floor(avgTrades),
    tradesToday: todayValue || '?',
    totalTrades: tradeCount,
    dailyPnL: totalPnl / tradeCount,
    winRate: winCount,
    avgWin: 0,
    avgLoss: 0,
  };
}

function groupTrades(history, watchlist) {
  const set = new Map();
  for (const h of history) {
    const tradeKey = `${h.symbol}:${h.qty}`;
    if (!set.has(tradeKey)) {
      set.set(tradeKey, []);
    }
    set.get(tradeKey)!.push(h);
  }

  return tradeGroupStats(Array.from(set.values()), watchlist);
}

function tradeGroupStats(tradeGroups, watchlist) {
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
      strategy: getStrategy(t[0].symbol, watchlist),
      priceOpen: t[0].filled_avg_price,
      priceClose: t[1].filled_avg_price,
      pnl: pnl,
      pnlPct: pnlPct,
      qty: t[0].qty,
      isWinner: isWinner,
      openedOn: t[1].filled_at,
      closedOn: t[0].filled_at,
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
      const watchlist = await fetchWatchlist();
      return logTrades(history, watchlist);
    }
  } catch (err) {
    console.log(`History fetch FAILED: ${err}`);
  }
}

export async function fetchWatchlist() {
  // console.log("getting watchlist");
  try {
    const response = await fetch("http://localhost:4001/watchlist", {
      signal: AbortSignal.timeout(10000)
    });
    if (response.ok) {
      // console.log('responded', response)
      const watchlist = await response.json();
      // console.log(JSON.parse(watchlist));
      return JSON.parse(watchlist);
    }
  } catch (err) {
    if (err.name === "TimeoutError") {
      console.log(`Watchlist fetch timed out`);
    } else {
      console.log(`Watchlist fetch FAILED: ${err}`);
    }
  }
}
