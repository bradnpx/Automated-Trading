"use client";
import React from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useTradingSocket } from "@/context/SocketContext";
import { SocketBarPayload } from "@my-platform/types";
import PriceCell from "./PriceCell";

const columnHelper = createColumnHelper<SocketBarPayload>();

const columns = [
  columnHelper.accessor("symbol", {
    header: "Ticker",
    cell: (info) => (
      <span className="font-bold text-blue-600">{info.getValue()}</span>
    ),
  }),
  columnHelper.accessor("price", {
    header: "Last Price",
    cell: (info) => {
      const { price, direction } = info.row.original as any;
      return <PriceCell price={price} direction={direction} />;
    },
  }),
  columnHelper.accessor("timestamp", {
    header: "Last Update",
    cell: (info) => new Date(info.getValue()).toLocaleTimeString(),
  }),
];

export default function TickerTable() {
  const { tableData, signals, engineStatus } = useTradingSocket();

  const table = useReactTable({
    data: tableData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    // Row ID is crucial for preventing unnecessary re-renders in real-time
    getRowId: (row) => row.symbol,
  });

  return (
    <div className="rounded-md border border-slate-200 overflow-hidden">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-500 border-b border-slate-200 uppercase text-xs font-semibold text-slate-200">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th key={header.id} className="px-4 py-3">
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
              className="border-b border-slate-100 hover:bg-slate-50 transition-colors"
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
      {tableData.length === 0 && (
        <div className="p-8 text-center text-slate-400 italic">
          Waiting for market data stream...
        </div>
      )}
    </div>
  );
}
