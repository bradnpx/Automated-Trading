"use client";
import Image from "next/image";
import AccountSummary from "@/components/AccountSummary";
import EquityChart from "@/components/EquityChart";
import TickerTable from "@/components/TickerTable";
import PortfolioTable from "@/components/PortfolioTable";
import PerformanceStats from "@/components/PerformanceStats";
import TradeHistory from "@/components/TradeHistory";
import ScannerAlerts from "@/components/ScannerAlerts";
import HealthMonitor from "@/components/HealthMonitor";
import Nav from "@/components/Navigation";
import { fetchTradeHistory } from "@/lib/fetchTradeHistory";
import { useState, useEffect } from "react";

type History = {
  stats: [];
  logs: Trade[];
};

type Trade = {
  symbol: string;
  strategy: string;
  priceOpen: number;
  priceClose: number;
  pnl: number;
  pnlPct: number;
  isWinner: boolean;
  openedOn: string;
  closedOn: string;
};

export default function Home() {
  const [history, setHistory] = useState<History>({
    stats: [],
    logs: [],
  });

  async function getHistory() {
    const history = await fetchTradeHistory();
    setHistory(history);
  }

  useEffect(() => {
    getHistory();
    const interval = setInterval(getHistory, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <>
      <Nav></Nav>
      <div className="grid grid-cols-12 gap-6 p-5">
        <div className="col-span-12">
          <AccountSummary />
          <EquityChart />
          <TradeHistory history={history} />
        </div>
        <div className="col-span-6">
          <TickerTable />
        </div>
        <div className="col-span-6">
          <PortfolioTable />
        </div>
        <div className="col-span-12">
          <ScannerAlerts />
        </div>
        {/* <div className="col-span-12">
        <TradeHistory />
      </div> */}
        <div className="col-span-12">
          <HealthMonitor />
        </div>

        {/* ... ticker table and rest of layout */}
      </div>
    </>
  );
}
