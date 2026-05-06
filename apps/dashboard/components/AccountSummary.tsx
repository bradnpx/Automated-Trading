"use client";
import { useTradingSocket } from "@/context/SocketContext";
import EmergencyButton from "./EmergencyButton";

export default function AccountSummary() {
    const { account } = useTradingSocket();

    if (!account) return <div className="h-24 animate-pulse bg-slate-200 rounded-lg" />;

    const metrics = [
        { label: 'Total Equity', value: account.equity, isCurrency: true, highlight: true },
        { label: 'Buying Power', value: account.buying_power, isCurrency: true },
        { label: 'Daily P&L', value: account.day_pl, isCurrency: true, isTrend: true },
        { label: 'Daily Change', value: account.day_pl_pct * 100, isCurrency: false, suffix: '%'},
    ];

    return (
      <div className="grid grid-cols-5 gap-4 mb-6">
        {metrics.map((m) => (
          <div
            key={m.label}
            className="bg-black p-4 rounded-xl border border-slate-200 shadow-sm"
          >
            <p className="text-[10px] uppercase tracking-wider font-bold text-slate-300 mb-1">
              {m.label}
            </p>
            <p
              className={`text-2xl font-black tabular-nums ${
                m.highlight ? "text-blue-500" : "text-slate-400"
              } ${
                m.isTrend && m.value > 0
                  ? "text-green-600"
                  : m.isTrend && m.value < 0
                    ? "text-red-600"
                    : ""
              }`}
            >
              {m.isCurrency && "$"}
              {m.value.toLocaleString(undefined, {
                maximumFractionDigits: 2,
                minimumFractionDigits: 2,
              })}
              {m.suffix}
            </p>
          </div>
        ))}
        <EmergencyButton/>
      </div>
    );
}