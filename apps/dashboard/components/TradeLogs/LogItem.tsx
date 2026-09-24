import { Trade } from "@/lib/fetchTradeHistory";

interface LogItemProps {
  id: number;
  trade: Trade;
}

export default function LogItem({ id, trade }: LogItemProps) {
  const pnlClass =
    trade.pnl > 0
      ? "text-green-600"
      : trade.pnl < 0
        ? "text-red-600"
        : "text-slate-400";

  return (
    <>
      <td className="px-4 py-2 text-slate-400">{id}</td>
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
      <td className="px-4 py-2 capitalize">{trade.status.replace("_", " ")}</td>
      <td className="px-4 py-2 text-xs text-slate-400">
        {trade.exits.length === 0 ? (
          "—"
        ) : (
          <details>
            <summary className="cursor-pointer text-slate-300">
              {trade.exits.length} exit{trade.exits.length === 1 ? "" : "s"}
            </summary>
            <ul className="mt-1 space-y-1 whitespace-nowrap">
              {trade.exits.map((exit) => (
                <li key={`${exit.orderId}:${exit.filledAt}`}>
                  {formatQuantity(exit.quantity)} @ ${exit.price.toFixed(2)} —{" "}
                  {exit.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </td>
      <td className="px-4 py-2">{trade.strategy}</td>
    </>
  );
}

function formatDateRange(openedOn: string, closedOn?: string): string {
  const opened = new Date(openedOn).toLocaleDateString();
  const closed = closedOn ? new Date(closedOn).toLocaleDateString() : "Open";
  return `${opened} — ${closed}`;
}

function formatQuantity(quantity: number): string {
  return Number.isInteger(quantity) ? quantity.toString() : quantity.toFixed(4);
}
