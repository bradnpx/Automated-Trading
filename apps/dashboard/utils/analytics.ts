import { TradeRecord } from "@my-platform/types";

export function calculatePerformance(history: TradeRecord[]) {
  const sellTrades = history.filter(
    (t) => t.side === "SELL".toUpperCase() && t.pnl !== undefined,
  );

  function getAverageDailyTrades(history: TradeRecord[]) {
    if (history.length === 0) return 0;
    const uniqueDays = new Set(
      history.map((trade) => {
        const date = new Date(trade.timestamp);
        return date.toLocaleDateString("en-NY");
      }),
    );

    return (history.length / uniqueDays.size).toFixed(0);
  }

  const wins = sellTrades.filter((t) => (t.pnl || 0) > 0);
  const losses = sellTrades.filter((t) => (t.pnl || 0) <= 0);
  const avgTradesPerDay = getAverageDailyTrades(history);

  const totalPnl = sellTrades.reduce((acc, t) => acc + (t.pnl || 0), 0);
  const grossProfit = wins.reduce((acc, t) => acc + (t.pnl || 0), 0);
  const grossLoss = Math.abs(losses.reduce((acc, t) => acc + (t.pnl || 0), 0));

  return {
    totalTrades: sellTrades.length,
    avgTradesPerDay: avgTradesPerDay,
    winRate:
      sellTrades.length > 0 ? (wins.length / sellTrades.length) * 100 : 0,
    profitFactor:
      grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    totalPnl,
  };
}
