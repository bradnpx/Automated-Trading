"use client";
import { useEffect, useState, useMemo } from "react";
import { calculatePerformance } from "@/utils/analytics";
import { TradeRecord } from "@my-platform/types";

export default function PerformanceStats() {
  const [history, setHistory] = useState<TradeRecord[]>([]);

  useEffect(() => {
    fetch("http://localhost:4001/history")
      .then((res) => res.json())
      .then(setHistory);
  }, []);

  const stats = useMemo(() => calculatePerformance(history), [history]);

  const cards = [
    {
      label: "Win Rate",
      value: `${stats.winRate.toFixed(1)}%`,
      sub: `${stats.totalTrades} closed trades`,
    },
    {
      label: "Profit Factor",
      value: stats.profitFactor.toFixed(2),
      sub: "Gross Profit / Gross Loss",
    },
    {
      label: "Avg Win / Avg Loss",
      value: `$${stats.avgWin.toFixed(2)} / $${stats.avgLoss.toFixed(2)}`,
      sub: "Trade Expectancy",
    },
  ];

  return (
    <div className="grid grid-cols-3 gap-4 mb-6">
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
