/**
 * /active-trades — Active Trades Dashboard page
 *
 * This is a React Server Component that acts as the route entry point.
 * It delegates all client-side state and polling to ActiveTradesDashboard,
 * keeping the 'use client' boundary as far down the tree as possible.
 */

import { ActiveTradesDashboard } from "@/components/active-trades/ActiveTradesDashboard";

export const metadata = {
  title: "Active Trades | Trading Engine",
  description:
    "Live view of all open buy-side positions with strategy and risk metadata.",
};

export default function ActiveTradesPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <ActiveTradesDashboard />
    </main>
  );
}
