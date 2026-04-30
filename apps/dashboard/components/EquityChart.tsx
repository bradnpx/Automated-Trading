"use client";
import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useTradingSocket } from "@/hooks/useTradingSocket";

export default function EquityChart() {
  const { equityHistory } = useTradingSocket();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted || equityHistory.length < 2) {
    return (
      <div className="h-64 flex items-center justify-center bg-white rounded-xl border border-slate-200 italic text-slate-400 text-sm">
        Collecting data points for live chart...
      </div>
    );
  }

  // Calculate Y-axis domain to zoom in on equity movement
  const minEquity = Math.min(...equityHistory.map((d) => d.equity));
  const maxEquity = Math.max(...equityHistory.map((d) => d.equity));
  const padding = (maxEquity - minEquity) * 0.01 || 100;

  return (
    <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm h-80">
      <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">
        Live Equity Curve (USD)
      </h3>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={equityHistory}>
          <defs>
            <linearGradient id="colorEquity" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#2563eb" stopOpacity={0.1} />
              <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            vertical={false}
            stroke="#f1f5f9"
          />
          <XAxis dataKey="time" hide />
          <YAxis hide domain={[minEquity - padding, maxEquity + padding]} />
          <Tooltip
            contentStyle={{
              borderRadius: "8px",
              border: "none",
              boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1)",
            }}
            labelStyle={{ fontWeight: "bold", marginBottom: "4px" }}
          />
          <Area 
            type="monotone"
            dataKey="equity"
            stroke="#2563eb"
            strokeWidth={3}
            fillOpacity={1}
            fill="url(#colorEquity)"
            animationDuration={300}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
