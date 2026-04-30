import Image from "next/image";
import AccountSummary from "@/components/AccountSummary";
import EquityChart from "@/components/EquityChart";

export default function Home() {
  return (
    <div className="grid grid-cols-12 gap-6">
      <div className="col-span-12">
        <AccountSummary />
        <EquityChart /> {/* Add it here */}
      </div>
      {/* ... ticker table and rest of layout */}
    </div>
  );
}
