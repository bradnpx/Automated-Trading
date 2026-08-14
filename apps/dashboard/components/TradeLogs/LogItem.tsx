import { Trade } from "@/lib/fetchTradeHistory";

interface Props {
    key: number;
    trade: Trade;
    limit?: number;
}

export default function LogItem(item: Props) {
    const trade = item.trade;
  return (
    <>
      <td className="px-4 py-2 text-slate-400">
        {trade.openedOn
          ? new Date(trade.openedOn).toLocaleDateString() +
            " - " +
            new Date(trade.closedOn).toLocaleDateString()
          : ""}{" "}
      </td>
      <td className="px-4 py-2 font-bold">{trade.symbol}</td>
      <td className="px-4 py-2 font-mono">{trade.qty ? trade.qty : ""}</td>
      <td className="px-4 py-2 font-mono">{trade.priceOpen ? trade.priceOpen : ""}</td>
      <td className="px-4 py-2 font-mono">
        {trade.priceClose ? trade.priceClose : ""}
      </td>
      <td
        className={`px-4 py-2 font-mono font-bold ${trade.pnl && trade.pnl >= 0 ? "text-green-600" : "text-red-600"}`}
      >
        {trade.pnl
          ? `${trade.pnl >= 0 ? "+" : ""}${(trade.pnl * trade.qty).toFixed(2)} (${(trade.pnlPct * 100).toFixed(2)}%)`
          : "-"}
      </td>
      <td>{trade.strategy}</td>
    </>
  );
}