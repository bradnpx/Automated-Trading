"use client";
import type { History, Trade } from "@/lib/fetchTradeHistory";
import { useEffect, useState } from "react";
import LogItem from "./LogItem";
import PerformanceStats from "./PerformanceStats";

type TradeHistoryProps = {
  history: History;
};

export default function TradeHistory({ history }: TradeHistoryProps) {
  const logs = history?.groupedTrades ?? [];
  const [strategy, setStrategy] = useState<string>("none");

  const strategies = (): string[] => {
    const output = new Set<string>();
    logs.forEach((v) => {
      if (!output.has(v.strategy)) output.add(v.strategy);
    });
    return Array.from(output);
  };

  function handleStrategyChange(e) {
    setStrategy(e.target.value);
  }

  function handleLimit(e) {
    setLimit(e.target.value);
  }

  function showTrade(trade: Trade, index: number): boolean {
    return (
      trade !== undefined &&
      (trade.strategy === strategy || strategy === "none")
    );
  }

  useEffect(() => {
    console.log(`strategy: ${strategy}`);
  }, [strategy]);

  if (!history) {
    return <div>Nothing here but us mice!</div>;
  }

  return (
    <>
      <PerformanceStats history={history} strategy={strategy} />
      <div className="flex p-4 border-b border-slate-100 font-bold text-slate-100 text-sm">
        <div>Trade History ({logs.length})</div>
        <div className="px-10">
          <label htmlFor="strategy">Strategy: </label>
          <select id="strategy" onChange={handleStrategyChange}>
            <option value="none" className="text-black">
              All
            </option>
            {strategies().map((s, i) => (
              <option key={i} value={s} className="text-black">
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="px-10">
          <label htmlFor="limit">Limit: </label>
          <input type="text" onChange={handleLimit} />
        </div>
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
          {logs.map((t: Trade, i) => (
            <>
              {showTrade(t, i) ? (
                <tr
                  key={i}
                  className="border-t border-slate-50 hover:bg-slate-50 h-2"
                >
                  {/* <LogItem key={i} trade={t} limit={limit}></LogItem> */}
                  <LogItem key={i} trade={t}></LogItem>
                </tr>
              ) : (
                <></>
              )}
            </>
          ))}
        </tbody>
      </table>
    </>
  );
}
