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

export default function Home() {
  return (
    <>
        <Nav/>
        <TradeHistory />
    </>
    
  );
}
