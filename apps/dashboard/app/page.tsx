import Image from "next/image";
import AccountSummary from "@/components/AccountSummary";
import EquityChart from "@/components/EquityChart";
import TickerTable from "@/components/TickerTable";
import PortfolioTable from "@/components/PortfolioTable";
import PerformanceStats from "@/components/PerformanceStats";
import TradeHistory from "@/components/TradeHistory";
import ScannerAlerts from "@/components/ScannerAlerts";
import HealthMonitor from "@/components/HealthMonitor";

export default function Home() {
  return (
    <div className="grid grid-cols-12 gap-6 p-5">
      <div className="col-span-12">
        <AccountSummary />
        <EquityChart />
        <PerformanceStats />
      </div>
      <div className="col-span-6">
        <TickerTable />
      </div>
      <div className="col-span-6">
        <PortfolioTable />
      </div>
      <div className="col-span-12">
        bitches
        <ScannerAlerts />
      </div>
      <div className="col-span-12">
        <TradeHistory />
      </div>
      <div className="col-span-12">
        <HealthMonitor />
      </div>

      {/* ... ticker table and rest of layout */}
    </div>
  );
}
