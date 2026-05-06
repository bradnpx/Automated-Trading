"use client";
import { useEffect, useState } from "react";
import { TradeRecord } from "@my-platform/types";

export default function TradeHistory() {
  const [history, setHistory] = useState<TradeRecord[]>([]);

  useEffect(() => {
    fetch("http://localhost:4001/history")
      .then((res) => res.json())
      .then(setHistory);
  }, []);

  return (
    <div className="rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="p-4 border-b border-slate-100 font-bold text-slate-700 text-sm">
        Trade History
      </div>
      <div className="max-h-96 overflow-y-auto">
        <table className="w-full text-xs text-left">
          <thead className="bg-slate-50 text-slate-500 uppercase text-[10px] sticky top-0">
            <tr>
              <th className="px-4 py-2">Symbol</th>
              <th className="px-4 py-2">Side</th>
              <th className="px-4 py-2">Price</th>
              <th className="px-4 py-2">P&L</th>
              <th className="px-4 py-2">Time</th>
            </tr>
          </thead>
          <tbody>
            {history.map((t, i) => (
              <tr
                key={i}
                className="border-t border-slate-50 hover:bg-slate-50"
              >
                <td className="px-4 py-2 font-bold">{t.symbol}</td>
                <td
                  className={`px-4 py-2 font-bold ${t.side === "BUY" ? "text-blue-600" : "text-orange-600"}`}
                >
                  {t.side}
                </td>
                <td className="px-4 py-2 font-mono">${t.price.toFixed(2)}</td>
                <td
                  className={`px-4 py-2 font-mono font-bold ${t.pnl && t.pnl >= 0 ? "text-green-600" : "text-red-600"}`}
                >
                  {t.pnl ? `${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}` : "-"}
                </td>
                <td className="px-4 py-2 text-slate-400">
                  {new Date(t.timestamp).toLocaleTimeString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
