"use client";

/**
 * ActiveTradesTable
 *
 * Renders the active-trade log as a sortable, readable table.
 * Each row preserves the Alpaca order schema columns and appends the
 * engine-specific strategy, takeProfitPct, and stopLossPct columns.
 *
 * Follows project conventions:
 *  - Named export (no default export)
 *  - 'use client' pushed as far down as possible (this component owns state)
 *  - No direct useEffect fetching — data is passed in as a prop
 */

import type { ActiveTradeLog } from "@my-platform/types";

interface ActiveTradesTableProps {
  trades: ActiveTradeLog[];
}

function StatusBadge({ status }: { status: string }) {
  const colourMap: Record<string, string> = {
    new: "bg-blue-100 text-blue-800",
    partially_filled: "bg-yellow-100 text-yellow-800",
    filled: "bg-green-100 text-green-800",
    canceled: "bg-gray-100 text-gray-600",
    expired: "bg-gray-100 text-gray-600",
    pending_new: "bg-purple-100 text-purple-800",
  };
  const cls = colourMap[status] ?? "bg-gray-100 text-gray-600";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {status}
    </span>
  );
}

export function ActiveTradesTable({ trades }: ActiveTradesTableProps) {
  if (trades.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-gray-500">
        No active trades logged.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          <tr>
            {[
              "Symbol",
              "Strategy",
              "Status",
              "Qty",
              "Filled Qty",
              "Filled Avg Price",
              "TP %",
              "SL %",
              "Submitted At",
              "Order ID",
            ].map((header) => (
              <th
                key={header}
                scope="col"
                className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white">
          {trades.map((trade) => (
            <tr key={trade.id} className="hover:bg-gray-50">
              <td className="whitespace-nowrap px-4 py-3 font-semibold text-gray-900">
                {trade.symbol}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-gray-700">
                {trade.strategy}
              </td>
              <td className="whitespace-nowrap px-4 py-3">
                <StatusBadge status={trade.status} />
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-gray-700">
                {trade.qty}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-gray-700">
                {trade.filled_qty}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-gray-700">
                {trade.filled_avg_price != null
                  ? `$${parseFloat(trade.filled_avg_price).toFixed(2)}`
                  : "—"}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-green-700 font-medium">
                +{trade.takeProfitPct}%
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-red-600 font-medium">
                -{trade.stopLossPct}%
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-gray-500">
                {new Date(trade.submitted_at).toLocaleTimeString()}
              </td>
              <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-gray-400">
                {trade.id.slice(0, 8)}…
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
