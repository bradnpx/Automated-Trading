// components/dashboard/AccountStats.tsx
// Displays live account equity, buying power, cash, and day P&L.
// Reads from Zustand store — no props needed.

"use client";

import { useEngineStore } from "@/store/engine.store";
import type { AccountState } from "@/types/dashboard";

interface StatCardProps {
  label: string;
  value: string;
  subtext?: string;
  positive?: boolean;
}

function StatCard({ label, value, subtext, positive }: StatCardProps) {
  const valueColor =
    positive === undefined
      ? "text-white"
      : positive
        ? "text-green-400"
        : "text-red-400";

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <p className="text-xs text-zinc-400 uppercase tracking-wider mb-1">
        {label}
      </p>
      <p className={`text-2xl font-mono font-semibold ${valueColor}`}>
        {value}
      </p>
      {subtext && (
        <p className={`text-xs mt-1 ${valueColor} opacity-70`}>{subtext}</p>
      )}
    </div>
  );
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

export function AccountStats() {
  const account = useEngineStore((s) => s.account);

  if (!account) {
    return (
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-24 rounded-lg border border-zinc-800 bg-zinc-900 animate-pulse"
          />
        ))}
      </div>
    );
  }

  const dayPlPositive = account.day_pl >= 0;

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      <StatCard label="Equity" value={formatCurrency(account.equity)} />
      <StatCard
        label="Buying Power"
        value={formatCurrency(account.buying_power)}
      />
      <StatCard label="Cash" value={formatCurrency(account.cash)} />
      <StatCard
        label="Day P&L"
        value={formatCurrency(account.day_pl)}
        subtext={`${(account.day_pl_pct * 100).toFixed(2)}%`}
        positive={dayPlPositive}
      />
    </div>
  );
}
