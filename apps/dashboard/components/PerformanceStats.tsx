"use client";
import type { TradeStats } from "@/lib/fetchTradeHistory";

export default function PerformanceStats(stats: TradeStats) {
  stats = stats.stats // TODO: fix this
  const cards = [
    {
      label: "Trades Today",
      value: `${stats.tradesToday}`,
    },
    {
      label: "Avg Trades Per Day",
      value: `${stats.tradesPerDay}`,
    },
    {
      label: "Win Rate",
      value: `${Number(stats.winRate / stats.totalTrades * 100).toFixed(2)}%`,
    },
    {
      label: "Average PnL",
      value: `$${stats.dailyPnL?.toFixed(2)}`,
      sub: "",
    },
    {
      label: "Avg Win / Avg Loss",
      value: `$${stats.avgWin?.toFixed(2)} / -$${stats.avgLoss?.toFixed(2)}`,
      sub: "Trade Expectancy",
    },
  ];

  return (
    <div className="grid grid-cols-5 gap-4 mb-6">
      {cards.map((c) => (
        <div
          key={c.label}
          className="bg-black p-4 rounded-xl border border-slate-200 shadow-sm"
        >
          <p className="text-[10px] uppercase font-bold text-slate-500 mb-1">
            {c.label}
          </p>
          <p className="text-2xl font-black text-slate-400">{c.value}</p>
          <p className="text-sm text-slate-400 mt-1 italic">{c.sub}</p>
        </div>
      ))}
    </div>
  );
}
