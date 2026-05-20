import { getPremarketData } from "./getPremarketData";
import { restClient } from "@polygon.io/client-js";

// Initialize the Polygon REST Client using your environment key
const polygonRest = restClient(process.env.POLYGON_API_KEY || "");

export async function getPremarketChange(symbol: string) {
  try {
    // 1. Fetch the baseline premarket data safely from your updated function
    const premarketData = await getPremarketData(symbol);

    // Guard rail: handle illiquid tickers gracefully if no early prints exist
    if (!premarketData || !premarketData.price) {
      console.log(
        `Skipping calculations: No premarket data baseline found for ${symbol}.`,
      );
      return null;
    }

    // 2. Fetch the current marketplace snapshot via Polygon
    const snapshot = await polygonRest.stocks.snapshotTicker(symbol);

    // Fall back to LastQuote Bid/Ask values if LastTrade isn't printing (common in thin hours)
    const latestPrice =
      snapshot.ticker?.lastTrade?.p ||
      snapshot.ticker?.lastQuote?.P || // 'P' is the Bid Price field in Polygon snapshots
      snapshot.ticker?.lastQuote?.p; // 'p' is the Ask Price field fallback

    if (!latestPrice) {
      console.log(`Could not resolve a current real-time price for ${symbol}.`);
      return null;
    }

    // 3. Compute percentage price delta
    const percentageChange =
      ((latestPrice - premarketData.price) / premarketData.price) * 100;

    // 4. Resolve the current minute bar volume safely ('min' object represents the current minute candle)
    const latestVolume = snapshot.ticker?.min?.v || 0;

    // Safety check to prevent dividing by zero if no volume has transacted yet
    const volumePercentageChange =
      latestVolume > 0
        ? ((latestVolume - premarketData.volume) / latestVolume) * 100
        : 0;

    console.log(`\n--- ${symbol} Extended Hours Analysis ---`);
    console.log(`4:00 AM Pre-Market Open : $${premarketData.price.toFixed(2)}`);
    console.log(`Current Executed Price   : $${latestPrice.toFixed(2)}`);
    console.log(
      `Net Performance          : ${percentageChange >= 0 ? "+" : ""}${percentageChange.toFixed(2)}%`,
    );
    console.log(`Current Minute Volume    : ${latestVolume}`);

    // Explicit property names so you don't confuse prices with percentages down the road
    return {
      premarketVolume: premarketData.volume,
      percentageChange: percentageChange,
      volumePercentageChange: volumePercentageChange,
    };
  } catch (error) {
    console.error(`Error computing pre-market metrics for ${symbol}:`, error);
    return null;
  }
}
