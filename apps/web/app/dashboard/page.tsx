// app/dashboard/page.tsx
// Main dashboard page — Server Component.
// Static shell rendered on the server; live data is hydrated on the client
// by the Socket.IO hook (positions, account) and TanStack Query (history).

import {
  AccountStats,
  EngineControls,
  PositionsTable,
  TradeHistory,
} from "@/components/dashboard";

export const metadata = {
  title: "Dashboard | Automated Trading",
};

export default function DashboardPage() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6 space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">
            Automated Trading
          </h1>
          <p className="text-xs text-zinc-500 mt-0.5">Live Engine Dashboard</p>
        </div>
        <EngineControls />
      </header>

      {/* ── Account Stats ───────────────────────────────────────────────── */}
      <section aria-label="Account statistics">
        <AccountStats />
      </section>

      {/* ── Open Positions ──────────────────────────────────────────────── */}
      <section aria-label="Open positions">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">
          Open Positions
        </h2>
        <PositionsTable />
      </section>

      {/* ── Trade History ───────────────────────────────────────────────── */}
      <section aria-label="Trade history">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-3">
          Trade History
        </h2>
        <TradeHistory />
      </section>
    </div>
  );
}
