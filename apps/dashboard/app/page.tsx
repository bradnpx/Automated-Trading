import Image from "next/image";
import AccountSummary from "@/components/AccountSummary";
import EquityChart from "@/components/EquityChart";
import TickerTable from "@/components/TickerTable";
import PortfolioTable from "@/components/PortfolioTable";

export default function Home() {
  return (
    <div className="grid grid-cols-12 gap-6 p-5">
      <div className="col-span-12">
        <AccountSummary />
        <EquityChart />
      </div>
      <div className="col-span-6">
        <TickerTable />
      </div>
      <div className="col-span-6">
        <PortfolioTable />
      </div>

      {/* ... ticker table and rest of layout */}
    </div>
  );
}
