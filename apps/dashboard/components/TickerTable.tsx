"use client";
import React from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import type { TickerData } from "@/context/SocketContext";
import type { StrategyEvaluationPayload } from "@my-platform/types";

import { useTradingSocket } from "@/context/SocketContext";
import PriceCell from "./PriceCell";

const columnHelper = createColumnHelper<TickerData>();

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
      const price = info.getValue();
      const direction = info.row.original.direction;
      if (typeof price !== "number" || !direction) {
        return <span className="text-slate-400">—</span>;
      }

      return <PriceCell price={price} direction={direction} />;
    },
  }),
  columnHelper.accessor("timestamp", {
    header: "Last Update",
    cell: (info) => {
      const timestamp = info.getValue();
      return timestamp ? (
        new Date(timestamp).toLocaleTimeString()
      ) : (
        <span className="text-slate-400">—</span>
      );
    },
  }),
  columnHelper.display({
    id: "criteria",
    header: "Strategy Criteria",
    cell: (info) => (
      <CriteriaChecklist evaluation={info.row.original.strategyEvaluation} />
    ),
  }),
];

export default function TickerTable() {
  const { tableData } = useTradingSocket();

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

function CriteriaChecklist({
  evaluation,
}: {
  evaluation?: StrategyEvaluationPayload;
}) {
  if (!evaluation) {
    return <span className="text-xs text-slate-400">Awaiting evaluation</span>;
  }

  if (evaluation.criteria.length === 0) {
    return <span className="text-xs text-slate-400">No criteria reported</span>;
  }

  return (
    <div className="min-w-60 space-y-1.5 py-1">
      <div className="flex items-center justify-between gap-2">
        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-slate-600">
          {evaluation.strategy}
        </span>
        <time
          className="text-[10px] text-slate-400"
          dateTime={evaluation.timestamp}
        >
          {new Date(evaluation.timestamp).toLocaleTimeString()}
        </time>
      </div>
      <ul className="grid gap-1" aria-label={`${evaluation.strategy} criteria`}>
        {evaluation.criteria.map(({ criterion, passed }) => (
          <li
            key={criterion}
            className="flex items-center gap-1.5 text-xs text-slate-600"
          >
            <span
              role="img"
              aria-label={passed ? "Passed" : "Failed"}
              className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border text-[11px] font-bold leading-none ${
                passed
                  ? "border-emerald-600 bg-emerald-600 text-white"
                  : "border-rose-300 bg-rose-50 text-rose-600"
              }`}
            >
              {passed ? "✓" : "×"}
            </span>
            <span>{formatCriterion(criterion)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatCriterion(criterion: string): string {
  return criterion
    .replace(/^is/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (value) => value.toUpperCase());
}
