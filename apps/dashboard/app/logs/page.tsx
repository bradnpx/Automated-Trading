"use client";
import { useState, useEffect } from "react";
import AccountSummary from "@/components/AccountSummary";
import PerformanceStats from "@/components/TradeLogs/PerformanceStats";
import TradeHistory from "@/components/TradeLogs/TradeHistory";
import Nav from "@/components/Navigation";
import { fetchTradeHistory, fetchWatchlist } from "@/lib/fetchTradeHistory";
import type { Trade, History, TradeStats } from "@/lib/fetchTradeHistory";

type TradeProps = {
  stats: TradeStats[];
  groupedTrade: History[];
  rawLogs: any[];
};

export default function Home() {
  const [tradeHistory, setTradeHistory] = useState<History>({
    stats: [],
    groupedTrades: [],
    rawLogs: [],
  });

  async function getHistory() {
    const history = await fetchTradeHistory();
    setTradeHistory(history);
  }

  useEffect(() => {
    getHistory();
    const interval = setInterval(getHistory, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <>
      <Nav />
      <AccountSummary />
      {/* <PerformanceStats stats={tradeHistory.stats} /> */}
      <TradeHistory history={tradeHistory} />
    </>
  );
}
