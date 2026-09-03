"use client";
import Image from "next/image";
import AccountSummary from "@/components/AccountSummary";
import EquityChart from "@/components/EquityChart";
import TickerTable from "@/components/TickerTable";
import PortfolioTable from "@/components/PortfolioTable";
import PerformanceStats from "@/components/TradeLogs/PerformanceStats";
import TradeHistory from "@/components/TradeLogs/TradeHistory";
import ScannerAlerts from "@/components/ScannerAlerts";
import HealthMonitor from "@/components/HealthMonitor";
import Nav from "@/components/Navigation";
export default function Home() {
  return (
    <>
      <Nav></Nav>
      <div className="grid grid-cols-12 gap-6 p-5">
        <div className="col-span-12">
          <AccountSummary />
          <EquityChart />
          {/* <TradeHistory history={history} /> */}
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
