import { useState } from "react";
import type { KeyboardEvent } from "react";

import type { Trade, TradeOrder } from "@/lib/fetchTradeHistory";

interface LogItemProps {
  id: number;
  trade: Trade;
}

export default function LogItem({ id, trade }: LogItemProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const detailId = `trade-orders-${trade.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const pnlClass =
    trade.pnl > 0
      ? "text-green-600"
      : trade.pnl < 0
        ? "text-red-600"
        : "text-slate-400";

  function toggleExpanded(): void {
    setIsExpanded((expanded) => !expanded);
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleExpanded();
    }
  }

  return (
    <>
      <tr
        className="cursor-pointer border-t border-slate-50 hover:bg-slate-50 h-2"
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-controls={detailId}
        onClick={toggleExpanded}
        onKeyDown={handleRowKeyDown}
      >
        <td className="px-4 py-2 text-slate-400">
          <span aria-hidden="true" className="mr-2 inline-block w-3">
            {isExpanded ? "▾" : "▸"}
          </span>
          {id}
        </td>
        <td className="px-4 py-2 text-slate-400">
          {formatDateRange(trade.openedOn, trade.closedOn)}
        </td>
        <td className="px-4 py-2 font-bold">{trade.symbol}</td>
        <td className="px-4 py-2 font-mono">
          {formatQuantity(trade.exitedQty)} / {formatQuantity(trade.qty)}
        </td>
        <td className="px-4 py-2 font-mono">${trade.priceOpen.toFixed(2)}</td>
        <td className="px-4 py-2 font-mono">
          {trade.priceClose === undefined
            ? "—"
            : `$${trade.priceClose.toFixed(2)}`}
        </td>
        <td className={`px-4 py-2 font-mono font-bold ${pnlClass}`}>
          {trade.exitedQty === 0
            ? "—"
            : `${trade.pnl >= 0 ? "+" : ""}$${trade.pnl.toFixed(2)} (${(trade.pnlPct * 100).toFixed(2)}%)`}
        </td>
        <td className="px-4 py-2 capitalize">
          {trade.status.replace("_", " ")}
        </td>
        <td className="px-4 py-2">{trade.strategy}</td>
      </tr>
      {isExpanded ? (
        <tr id={detailId} className="bg-slate-950/50">
          <td colSpan={9} className="px-8 py-4">
            <TradeOrderDetails orders={trade.orders} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function TradeOrderDetails({ orders }: { orders: TradeOrder[] }) {
  return (
    <div className="rounded border border-slate-700 bg-slate-900 p-3 text-slate-200">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Associated fills ({orders.length})
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-slate-400">
            <tr>
              <th className="px-2 py-1">Time</th>
              <th className="px-2 py-1">Side</th>
              <th className="px-2 py-1">Qty</th>
              <th className="px-2 py-1">Price</th>
              <th className="px-2 py-1">Order Type</th>
              <th className="px-2 py-1">Reason</th>
              <th className="px-2 py-1">Source</th>
              <th className="px-2 py-1">Order / Execution ID</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr
                key={`${order.id}:${order.sequence}`}
                className="border-t border-slate-800"
              >
                <td className="px-2 py-2 whitespace-nowrap">
                  {formatDateTime(order.filledAt)}
                </td>
                <td
                  className={`px-2 py-2 font-semibold uppercase ${order.side === "buy" ? "text-emerald-400" : "text-rose-400"}`}
                >
                  {order.side}
                </td>
                <td className="px-2 py-2 font-mono">
                  {formatQuantity(order.quantity)}
                </td>
                <td className="px-2 py-2 font-mono">
                  ${order.price.toFixed(2)}
                </td>
                <td className="px-2 py-2">{order.orderType ?? "—"}</td>
                <td className="px-2 py-2">{order.reason}</td>
                <td className="px-2 py-2 capitalize">{order.source}</td>
                <td className="px-2 py-2 font-mono text-slate-400">
                  {order.orderId ?? "—"}
                  {order.executionId ? ` / ${order.executionId}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatDateRange(openedOn: string, closedOn?: string): string {
  const opened = new Date(openedOn).toLocaleDateString();
  const closed = closedOn ? new Date(closedOn).toLocaleDateString() : "Open";
  return `${opened} — ${closed}`;
}

function formatDateTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}

function formatQuantity(quantity: number): string {
  return Number.isInteger(quantity) ? quantity.toString() : quantity.toFixed(4);
}
