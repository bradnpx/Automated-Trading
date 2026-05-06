import { TradeRecord } from "@my-platform/types";

export function calculatePerformance(history: TradeRecord[]) {
  const sellTrades = history.filter(
    (t) => t.side === "SELL" && t.pnl !== undefined,
  );

  const wins = sellTrades.filter((t) => (t.pnl || 0) > 0);
  const losses = sellTrades.filter((t) => (t.pnl || 0) <= 0);

  const totalPnl = sellTrades.reduce((acc, t) => acc + (t.pnl || 0), 0);
  const grossProfit = wins.reduce((acc, t) => acc + (t.pnl || 0), 0);
  const grossLoss = Math.abs(losses.reduce((acc, t) => acc + (t.pnl || 0), 0));

  return {
    totalTrades: sellTrades.length,
    winRate:
      sellTrades.length > 0 ? (wins.length / sellTrades.length) * 100 : 0,
    profitFactor:
      grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    totalPnl,
  };
}
