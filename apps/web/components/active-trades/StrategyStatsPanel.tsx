"use client";

/**
 * StrategyStatsPanel
 *
 * Displays the per-strategy aggregated statistics returned by the engine's
 * groupTradesStat function. Each strategy is rendered as a card showing:
 *   - Total trades, wins, losses, breakevens
 *   - Win rate (%)
 *   - Net realised PnL
 *   - Average take-profit and stop-loss thresholds
 *
 * Data is passed in as a prop; this component is purely presentational.
 */

import type { StrategyTradeStats } from "@my-platform/types";

interface StrategyStatsPanelProps {
  stats: StrategyTradeStats[];
}

function StatRow({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string | number;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-gray-500">{label}</span>
      <span className={`text-sm font-semibold ${valueClassName ?? "text-gray-900"}`}>
        {value}
      </span>
    </div>
  );
}

function WinRateBar({ winRate }: { winRate: number }) {
  const clamped = Math.min(100, Math.max(0, winRate));
  const colour =
    clamped >= 60
      ? "bg-green-500"
      : clamped >= 40
        ? "bg-yellow-400"
        : "bg-red-500";
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-gray-500">Win rate</span>
        <span className="text-xs font-semibold text-gray-700">
          {clamped.toFixed(1)}%
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
        <div
          className={`h-full rounded-full transition-all ${colour}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

export function StrategyStatsPanel({ stats }: StrategyStatsPanelProps) {
  if (stats.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-gray-500">
        No strategy statistics available yet.
      </p>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {stats.map((s) => (
        <div
          key={s.strategy}
          className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
        >
          <h3 className="mb-3 truncate text-sm font-bold text-gray-900">
            {s.strategy}
          </h3>

          <WinRateBar winRate={s.winRate} />

          <div className="mt-3 divide-y divide-gray-100">
            <StatRow label="Total trades" value={s.totalTrades} />
            <StatRow
              label="Wins"
              value={s.wins}
              valueClassName="text-green-600"
            />
            <StatRow
              label="Losses"
              value={s.losses}
              valueClassName="text-red-600"
            />
            <StatRow label="Breakevens" value={s.breakevens} />
            <StatRow
              label="Net PnL"
              value={
                s.netRealizedPnL >= 0
                  ? `+$${s.netRealizedPnL.toFixed(2)}`
                  : `-$${Math.abs(s.netRealizedPnL).toFixed(2)}`
              }
              valueClassName={
                s.netRealizedPnL >= 0 ? "text-green-600" : "text-red-600"
              }
            />
            <StatRow
              label="Avg TP"
              value={`+${s.avgTakeProfitPct}%`}
              valueClassName="text-green-700"
            />
            <StatRow
              label="Avg SL"
              value={`-${s.avgStopLossPct}%`}
              valueClassName="text-red-700"
            />
          </div>
        </div>
      ))}
    </div>
  );
}
