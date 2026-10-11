"use client";
import { useEffect, useState } from "react";
import AccountSummary from "@/components/AccountSummary";
import TradeHistory from "@/components/TradeLogs/TradeHistory";
import Nav from "@/components/Navigation";
import { fetchTradeHistory, type History } from "@/lib/fetchTradeHistory";

const EMPTY_HISTORY: History = { groupedTrades: [], rawLogs: [] };

export default function Home() {
  const [tradeHistory, setTradeHistory] = useState<History>(EMPTY_HISTORY);

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
