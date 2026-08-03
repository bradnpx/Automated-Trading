// components/dashboard/TradeHistory.tsx
// Displays trade history fetched from the engine REST API via TanStack Query.

"use client";

import { useTradeHistory } from "@/hooks/useTradeHistory";
import type { TradeRecord } from "@/types/dashboard";

const WIN_STATUS_STYLES: Record<TradeRecord["win_status"], string> = {
  WIN: "text-green-400",
  LOSS: "text-red-400",
  BREAKEVEN: "text-yellow-400",
  OPENING: "text-zinc-400",
};

function TradeRow({ trade }: { trade: TradeRecord }) {
  const pnlPositive = (trade.pnl ?? 0) >= 0;
  const pnlColor = pnlPositive ? "text-green-400" : "text-red-400";
  const sign = pnlPositive ? "+" : "";

  return (
    <tr className="border-b border-zinc-800 hover:bg-zinc-800/50 transition-colors text-sm">
      <td className="px-4 py-2.5 font-mono font-semibold">{trade.symbol}</td>
      <td className="px-4 py-2.5">
        <span
          className={`px-1.5 py-0.5 rounded text-xs font-semibold ${
            trade.side === "buy"
              ? "bg-blue-900/50 text-blue-400"
              : "bg-orange-900/50 text-orange-400"
          }`}
        >
          {trade.side.toUpperCase()}
        </span>
      </td>
      <td className="px-4 py-2.5 text-right font-mono">{trade.qty}</td>
      <td className="px-4 py-2.5 text-right font-mono">
        ${parseFloat(trade.price).toFixed(2)}
      </td>
      <td className="px-4 py-2.5 text-right font-mono">
        {trade.pnl !== undefined ? (
          <span className={pnlColor}>
            {sign}${trade.pnl.toFixed(2)}
          </span>
        ) : (
          <span className="text-zinc-600">—</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-right">
        <span className={WIN_STATUS_STYLES[trade.win_status]}>
          {trade.win_status}
        </span>
      </td>
      <td className="px-4 py-2.5 text-zinc-500 text-xs">
        {new Date(trade.timestamp).toLocaleTimeString()}
      </td>
      <td className="px-4 py-2.5 text-zinc-500 text-xs max-w-[200px] truncate">
        {trade.reason}
      </td>
    </tr>
  );
}

export function TradeHistory() {
  const { data: trades, isLoading, error } = useTradeHistory();

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-10 rounded bg-zinc-800 animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-32 text-red-400 text-sm">
        Failed to load trade history: {error.message}
      </div>
    );
  }

  if (!trades || trades.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-zinc-500 text-sm">
        No trades recorded yet
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full text-zinc-200">
        <thead>
          <tr className="bg-zinc-900 text-zinc-400 text-xs uppercase tracking-wider">
            <th className="px-4 py-3 text-left">Symbol</th>
            <th className="px-4 py-3 text-left">Side</th>
            <th className="px-4 py-3 text-right">Qty</th>
            <th className="px-4 py-3 text-right">Price</th>
            <th className="px-4 py-3 text-right">P&amp;L</th>
            <th className="px-4 py-3 text-right">Status</th>
            <th className="px-4 py-3 text-left">Time</th>
            <th className="px-4 py-3 text-left">Reason</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade, i) => (
            <TradeRow key={`${trade.symbol}-${trade.timestamp}-${i}`} trade={trade} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
