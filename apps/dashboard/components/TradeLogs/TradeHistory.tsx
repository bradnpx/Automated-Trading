"use client";

import { ChangeEvent, useMemo, useState } from "react";

import type { History, Trade } from "@/lib/fetchTradeHistory";

import LogItem from "./LogItem";
import PerformanceStats from "./PerformanceStats";

interface TradeHistoryProps {
  history: History;
}

export default function TradeHistory({ history }: TradeHistoryProps) {
  const [strategy, setStrategy] = useState("none");
  const [limit, setLimit] = useState(0);
  const logs = history.groupedTrades;

  const strategies = useMemo(
    () => Array.from(new Set(logs.map((trade) => trade.strategy))).sort(),
    [logs],
  );
  const visibleTrades = logs.filter(
    (trade) => strategy === "none" || trade.strategy === strategy,
  );
  const displayedTrades =
    limit > 0 ? visibleTrades.slice(0, limit) : visibleTrades;

  function handleStrategyChange(event: ChangeEvent<HTMLSelectElement>): void {
    setStrategy(event.target.value);
  }

  function handleLimit(event: ChangeEvent<HTMLInputElement>): void {
    const nextLimit = Number(event.target.value);
    setLimit(Number.isFinite(nextLimit) && nextLimit > 0 ? nextLimit : 0);
  }

  return (
    <>
      <PerformanceStats history={history} strategy={strategy} limit={limit} />
      <div className="flex p-4 border-b border-slate-100 font-bold text-slate-100 text-sm">
        <div>Trade History ({visibleTrades.length})</div>
        <div className="px-10">
          <label htmlFor="strategy">Strategy: </label>
          <select
            id="strategy"
            value={strategy}
            onChange={handleStrategyChange}
          >
            <option value="none" className="text-black">
              All
            </option>
            {strategies.map((name) => (
              <option key={name} value={name} className="text-black">
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="px-10">
          <label htmlFor="limit">Limit: </label>
          <input id="limit" type="number" min="1" onChange={handleLimit} />
        </div>
      </div>
      <table className="w-full text-[14px] text-left">
        <thead className="text-slate-500 uppercase text-[12px] sticky top-0">
          <tr>
            <th className="px-4 py-2">#</th>
            <th className="px-4 py-2">Time</th>
            <th className="px-4 py-2">Symbol</th>
            <th className="px-4 py-2">Exited / Entry Qty</th>
            <th className="px-4 py-2">Open Price</th>
            <th className="px-4 py-2">Avg Exit Price</th>
            <th className="px-4 py-2">Realized P&amp;L</th>
            <th className="px-4 py-2">Status</th>
            <th className="px-4 py-2">Exit Details</th>
            <th className="px-4 py-2">Strategy</th>
          </tr>
        </thead>
        <tbody>
          {displayedTrades.map((trade: Trade, index) => (
            <tr
              key={trade.id}
              className="border-t border-slate-50 hover:bg-slate-50 h-2"
            >
              <LogItem id={index + 1} trade={trade} />
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
