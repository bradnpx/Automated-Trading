"use client";
import type { History } from "@/lib/fetchTradeHistory";
import { useEffect, useState } from "react";

type TradeHistoryProps = {
  history: History;
};

export default function TradeHistory({ history }: TradeHistoryProps) {
  const logs = history?.groupedTrades ?? [];

  if (!history) {
    return <div>Nothing here but us mice!</div>;
  }

  return (
    <>
      <div className="p-4 border-b border-slate-100 font-bold text-slate-100 text-sm">
        Trade History ({logs.length})
      </div>
      <table className="w-full text-[14px] text-left">
        <thead className="text-slate-500 uppercase text-[12px] sticky top-0">
          <tr>
            <th className="px-4 py-2">Time</th>
            <th className="px-4 py-2">Symbol</th>
            <th className="px-4 py-2">Qty</th>
            <th className="px-4 py-2">Open Price</th>
            <th className="px-4 py-2">Closed Price</th>
            <th className="px-4 py-2">P&L</th>
            <th className="px-4 py-2">Strategy</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((t, i) => (
            <tr key={i} className="border-t border-slate-50 hover:bg-slate-50">
              <td className="px-4 py-2 text-slate-400">
                {t.openedOn
                  ? new Date(t.openedOn).toLocaleDateString() +
                    " " +
                    new Date(t.closedOn).toLocaleTimeString()
                  : ""}{" "}
              </td>
              <td className="px-4 py-2 font-bold">{t.symbol}</td>
              <td className="px-4 py-2 font-mono">{t.qty ? t.qty : ""}</td>
              <td className="px-4 py-2 font-mono">
                {t.priceOpen ? t.priceOpen : ""}
              </td>
              <td className="px-4 py-2 font-mono">
                {t.priceClose ? t.priceClose : ""}
              </td>
              <td
                className={`px-4 py-2 font-mono font-bold ${t.pnl && t.pnl >= 0 ? "text-green-600" : "text-red-600"}`}
              >
                {t.pnl
                  ? `${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)} (${(t.pnlPct * 100).toFixed(2)}%)`
                  : "-"}
              </td>
              <td>{t.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
