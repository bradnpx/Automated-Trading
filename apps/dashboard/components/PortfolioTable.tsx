"use client";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useTradingSocket } from "@/context/SocketContext";

const columnHelper = createColumnHelper<any>();

const columns = [
  columnHelper.accessor("symbol", {
    header: "Asset",
    cell: (info) => <span className="font-bold">{info.getValue()}</span>,
  }),
  columnHelper.accessor("qty", {
    header: "Qty",
  }),
  columnHelper.accessor("avg_entry_price", {
    header: "Entry",
    cell: (info) => `$${parseFloat(info.getValue()).toFixed(2)}`,
  }),
  columnHelper.accessor("current_price", {
    header: "Mark",
    cell: (info) => `$${parseFloat(info.getValue()).toFixed(2)}`,
  }),
  columnHelper.accessor("unrealized_pl", {
    header: "P&L ($)",
    cell: (info) => {
      const val = parseFloat(info.getValue());
      return (
        <span
          className={`font-mono font-bold ${val >= 0 ? "text-green-600" : "text-red-600"}`}
        >
          {val >= 0 ? "+" : ""}
          {val.toFixed(2)}
        </span>
      );
    },
  }),
  columnHelper.accessor("unrealized_plpc", {
    header: "P&L (%)",
    cell: (info) => {
      const val = parseFloat(info.getValue()) * 100;
      return (
        <span
          className={`text-xs px-2 py-1 rounded ${val >= 0 ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}
        >
          {val.toFixed(2)}%
        </span>
      );
    },
  }),
  columnHelper.display({
    id: 'exits',
    header: 'SL / TP Levels',
    cell: info => {
        const entry = parseFloat(info.row.original.avg_entry_price);
        const sl = entry * 0.98;
        const tp = entry * 1.04;
        return (
            <div className="text-[10px] space-y-1">
                <div className="text-red-500 font-mono">SL: ${sl.toFixed(2)}</div>
                <div className="text-green-500 font-mono">SL: ${tp.toFixed(2)}</div>
            </div>
        )
    }
  }),
  columnHelper.display({
    id: 'trailing_stop',
    head: 'Current Floor',
    cell: info => {
        const row = info.row.original;
        const entry = parseFloat(row.avg_entry_price)
        const current = parseFloat(row.current_price)

        const floor = current * 0.985; //1.5% trail

        return (
            <div className="flex flex-col">
                <span className={`text-xs font-mono ${current > entry ? 'text-green-600' : 'text-slate-400'}`}>
                    Floor: %{floor.toFixed(2)}
                </span>
            </div>
        )
    }
  })
];

export default function PortfolioTable() {
  const { portfolio } = useTradingSocket();

  const table = useReactTable({
    data: portfolio,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="bg-black rounded-lg border border-slate-200 shadow-sm overflow-hidden">
      <div className="p-4 border-b border-slate-100 bg-slate-900">
        <h3 className="text-md font-bold text-slate-400">Active Positions</h3>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left bg-slate-500 text-slate-50 uppercase text-[10px] tracking-wider">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th key={header.id} className="px-4 py-3 font-semibold">
                  {flexRender(
                    header.column.columnDef.header,
                    header.getContext(),
                  )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              className="border-t border-slate-50 hover:bg-slate-50/80"
            >
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="px-4 py-3">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {portfolio.length === 0 && (
        <div className="p-10 text-center text-slate-400 text-xs italic">
          No open positions
        </div>
      )}
    </div>
  );
}
