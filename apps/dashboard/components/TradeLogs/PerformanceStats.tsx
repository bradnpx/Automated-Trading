"use client";
import { getStats, type TradeStats, History } from "@/lib/fetchTradeHistory";

interface Props {
  history: History;
  strategy: string;
  limit?: number;
}
export default function PerformanceStats(props: Props) {
  // stats = stats.stats // TODO: fix this

  const stats = getStats(props.history.rawLogs, props.history.groupedTrades, props.strategy, props.limit || 0);
  console.log(stats)
  // return <></>
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
      value: `${Number((stats.winRate / stats.totalTrades) * 100).toFixed(2)}%`,
    },
    {
      label: "Average PnL",
      value: `$${stats.dailyPnL?.toFixed(2)}`,
      sub: "",
      color: stats.dailyPnL >= 0 ? "text-green-600" : "text-red-600",
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
          <p className={`text-2xl font-black ${c.color || 'text-slate-400'}`}>{c.value}</p>
          <p className="text-sm text-slate-400 mt-1 italic">{c.sub}</p>
        </div>
      ))}
    </div>
  );
}
