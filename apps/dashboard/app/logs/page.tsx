import AccountSummary from "@/components/AccountSummary";
import PerformanceStats from "@/components/PerformanceStats";
import TradeHistory from "@/components/TradeHistory";
import Nav from "@/components/Navigation";

export default function Home() {
  return (
    <>
        <Nav/>
        <AccountSummary/>
        <PerformanceStats/>
        <TradeHistory />
    </>
    
  );
}
