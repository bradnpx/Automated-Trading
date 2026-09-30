"use client";

import { getStats, type History } from "@/lib/fetchTradeHistory";

interface PerformanceStatsProps {
  history: History;
  strategy: string;
  limit?: number;
}

export default function PerformanceStats({
  history,
  strategy,
  limit = 0,
}: PerformanceStatsProps) {
  const stats = getStats(history.groupedTrades, strategy, limit);
  const cards = [
    { label: "Trades Today", value: `${stats.tradesToday}` },
    { label: "Avg Trades Per Day", value: `${stats.tradesPerDay}` },
    {
      label: "Win Rate",
      value: `${(stats.winRate * 100).toFixed(2)}%`,
    },
    {
      label: "Average P&L",
      value: formatCurrency(stats.dailyPnL),
      color: stats.dailyPnL >= 0 ? "text-green-600" : "text-red-600",
    },
    {
      label: "Avg Win / Avg Loss",
      value: `${formatCurrency(stats.avgWin)} / ${formatCurrency(stats.avgLoss)}`,
      sub: "Closed lifecycles only",
    },
  ];

  return (
    <div className="grid grid-cols-5 gap-4 mb-6">
      {cards.map((card) => (
        <div
          key={card.label}
          className="bg-black p-4 rounded-xl border border-slate-200 shadow-sm"
        >
          <p className="text-[10px] uppercase font-bold text-slate-500 mb-1">
            {card.label}
          </p>
          <p
            className={`text-2xl font-black ${card.color ?? "text-slate-400"}`}
          >
            {card.value}
          </p>
          <p className="text-sm text-slate-400 mt-1 italic">{card.sub}</p>
        </div>
      ))}
    </div>
  );
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}
