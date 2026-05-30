"use client";
import { useEffect, useState } from "react";
import { TradeRecord } from "@my-platform/types";

export default function TradeHistory() {
  const [history, setHistory] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHistory = async () => {
    try {
      const response = await fetch("http://localhost:4001/history");
      const data = await response.json();
      setHistory(data);
    } catch (error) {
      setError(`Failed to load trade history: ${error as string}`);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchHistory();
    const interval = setInterval(fetchHistory, 30000);
    return () => clearInterval(interval);
  }, []);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        Fetching trade history...
      </div>
    );
  }

  return (
    <div className="">
      <div className="p-4 border-b border-slate-100 font-bold text-slate-100 text-sm">
        Trade History
      </div>
      <div className="">
        <table className="w-full text-[14px] text-left">
          <thead className="text-slate-500 uppercase text-[12px] sticky top-0">
            <tr>
              <th className="px-4 py-2">Time</th>
              <th className="px-4 py-2">Symbol</th>
              <th className="px-4 py-2">Qty</th>
              <th className="px-4 py-2">Side</th>
              <th className="px-4 py-2">Price</th>
              <th className="px-4 py-2">P&L</th>
              <th className="px-4 py-2">Strategy</th>
            </tr>
          </thead>
          <tbody>
            {history.map((t, i) => (
              <tr
                key={i}
                className="border-t border-slate-50 hover:bg-slate-50"
              >
                <td className="px-4 py-2 text-slate-400">
                  {new Date(t.timestamp).toLocaleTimeString()}
                </td>
                <td className="px-4 py-2 font-bold">{t.symbol}</td>
                <td
                  className={`px-4 py-2 font-bold ${t.side === "BUY" ? "text-blue-600" : "text-orange-600"}`}
                >
                  {t.side}
                </td>
                <td className="px-4 py-2 font-mono">{t.qty ? t.qty : ''}</td>
                <td className="px-4 py-2 font-mono">{t.price ? t.price : ''}</td>
                <td
                  className={`px-4 py-2 font-mono font-bold ${t.pnl && t.pnl >= 0 ? "text-green-600" : "text-red-600"}`}
                >
                  {t.pnl ? `${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}` : "-"}
                </td>
                <td>
                  {t.reason}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
