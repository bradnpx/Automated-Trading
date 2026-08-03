// components/dashboard/PositionsTable.tsx
// Displays live open positions streamed from the engine via Socket.IO.
// Reads from Zustand store — no props needed.

"use client";

import { useEngineStore } from "@/store/engine.store";
import { useClosePosition } from "@/hooks/useEngineActions";
import type { Position } from "@/types/dashboard";

function PnlCell({ value, pct }: { value: string; pct: string }) {
  const numericPnl = parseFloat(value);
  const isPositive = numericPnl >= 0;
  const colorClass = isPositive ? "text-green-400" : "text-red-400";
  const sign = isPositive ? "+" : "";

  return (
    <span className={colorClass}>
      {sign}${numericPnl.toFixed(2)}{" "}
      <span className="text-xs opacity-70">
        ({sign}{(parseFloat(pct) * 100).toFixed(2)}%)
      </span>
    </span>
  );
}

function PositionRow({ position }: { position: Position }) {
  const { mutate: close, isPending } = useClosePosition();

  return (
    <tr className="border-b border-zinc-800 hover:bg-zinc-800/50 transition-colors">
      <td className="px-4 py-3 font-mono font-semibold">{position.symbol}</td>
      <td className="px-4 py-3 text-right">{position.qty}</td>
      <td className="px-4 py-3 text-right font-mono">
        ${parseFloat(position.avg_entry_price).toFixed(2)}
      </td>
      <td className="px-4 py-3 text-right font-mono">
        ${parseFloat(position.current_price).toFixed(2)}
      </td>
      <td className="px-4 py-3 text-right">
        <PnlCell value={position.unrealized_pl} pct={position.unrealized_plpc} />
      </td>
      <td className="px-4 py-3 text-right font-mono">
        ${parseFloat(position.market_value).toFixed(2)}
      </td>
      <td className="px-4 py-3 text-right">
        <button
          onClick={() => close(position.symbol)}
          disabled={isPending}
          className="px-3 py-1 text-xs rounded bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isPending ? "Closing…" : "Close"}
        </button>
      </td>
    </tr>
  );
}

export function PositionsTable() {
  const positions = useEngineStore((s) => s.positions);

  if (positions.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-zinc-500 text-sm">
        No open positions
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full text-sm text-zinc-200">
        <thead>
          <tr className="bg-zinc-900 text-zinc-400 text-xs uppercase tracking-wider">
            <th className="px-4 py-3 text-left">Symbol</th>
            <th className="px-4 py-3 text-right">Qty</th>
            <th className="px-4 py-3 text-right">Entry</th>
            <th className="px-4 py-3 text-right">Current</th>
            <th className="px-4 py-3 text-right">Unrealized P&amp;L</th>
            <th className="px-4 py-3 text-right">Market Value</th>
            <th className="px-4 py-3 text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((pos) => (
            <PositionRow key={pos.symbol} position={pos} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
