import Alpaca from "@alpacahq/alpaca-trade-api";
import { getPremarketData } from "./getPremarketData.js";

// Initialize the Alpaca client (automatically sources keys from process.env)
const alpaca = new Alpaca();

export async function getPremarketChange(symbol: string) {
  try {
    // 1. Fetch the baseline pre-market data safely
    const premarketData = await getPremarketData(symbol);

    // Guard rail: handle illiquid tickers gracefully if no early prints exist
    if (!premarketData || !premarketData.price) {
      console.log(
        `Skipping calculations: No premarket data baseline found for ${symbol}.`,
      );
      return null;
    }

    // 2. Query valid Alpaca Market Data v2 endpoints
    // NOTE: getLatestBars strictly requires an array argument and returns a Map
    const latestBarsMap = await alpaca.getLatestBars([symbol]);
    const latestBar = latestBarsMap.get(symbol);

    // getLatestTrade takes a single string symbol and returns the object directly
    const latestTrade = await alpaca.getLatestTrade(symbol);

    // Fall back to the latest bar's close price if a real-time trade print isn't available
    const latestPrice = latestTrade?.Price ?? latestBar?.ClosePrice ?? null;

    if (!latestPrice) {
      console.log(`Could not resolve a current real-time price for ${symbol}.`);
      return null;
    }

    // 3. Compute percentage price delta against the pre-market baseline
    const percentageChange =
      ((latestPrice - premarketData.price) / premarketData.price) * 100;

    // 4. Resolve the current bar volume safely (Alpaca properties use PascalCase)
    const latestVolume = latestBar?.Volume ?? 0;

    // Safety check to prevent dividing by zero if no volume has transacted yet
    const volumePercentageChange =
      latestVolume > 0
        ? ((latestVolume - premarketData.volume) / latestVolume) * 100
        : 0;

    console.log(
      `\n--- ${symbol} Extended Hours Analysis (Alpaca Data Feed) ---`,
    );
    console.log(`4:00 AM Pre-Market Open : $${premarketData.price.toFixed(2)}`);
    console.log(`Current Executed Price   : $${latestPrice.toFixed(2)}`);
    console.log(
      `Net Performance          : ${percentageChange >= 0 ? "+" : ""}${percentageChange.toFixed(2)}%`,
    );
    console.log(`Latest Minute Volume     : ${latestVolume}`);

    return {
      premarketVolume: premarketData.volume,
      percentageChange: percentageChange,
      volumePercentageChange: volumePercentageChange,
      latestPrice: latestPrice,
    };
  } catch (error) {
    console.error(`❌ Error computing pre-market change for ${symbol}:`, error);
    return null;
  }
}
