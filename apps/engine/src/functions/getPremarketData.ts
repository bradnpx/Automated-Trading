import { restClient } from "@polygon.io/client-js";

// Initialize the Polygon REST Client using your environment key
const polygonRest = restClient(process.env.POLYGON_API_KEY || "");

export async function getPremarketData(symbol: string) {
  try {
    // 1. Force the date extraction to stay aligned with New York's calendar date
    const nyDateString = new Date().toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    // Convert MM/DD/YYYY to YYYY-MM-DD
    const [month, day, year] = nyDateString.split("/");
    const formattedDate = `${year}-${month}-${day}`;

    // 4:00 AM EST/EDT offset string converted to numeric Unix milliseconds
    const startTimestamp = new Date(
      `${formattedDate}T04:00:00-04:00`,
    ).getTime();
    const endTimestamp = Date.now();

    // Call Polygon's aggregate endpoint (Ticker, Multiplier, Timespan, From, To, Options)
    const response = await polygonRest.stocks.aggregates(
      symbol,
      1,
      "minute",
      startTimestamp,
      endTimestamp,
      {
        limit: 10,
        order: "asc", // Ensures results start chronologically from 4:00 AM onward
      },
    );

    // Verify data structures were returned safely
    if (!response.results || response.results.length === 0) {
      console.log(
        `No pre-market trading activity detected for ${symbol} since 4:00 AM Eastern.`,
      );
      return null;
    }

    // Grab the first element from the results array
    const firstBar = response.results[0];

    // Mapping properties: 'o' is Open Price, 'v' is Volume
    const premarketOpenPrice = firstBar.o ?? null;
    const premarketVolume = firstBar.v ?? null;

    if (!premarketOpenPrice) {
      console.log(`No valid open price data found for ${symbol}.`);
      return null;
    }

    return {
      price: premarketOpenPrice,
      volume: premarketVolume,
    };
  } catch (error) {
    console.error("Error computing pre-market metrics via Polygon:", error);
    throw error;
  }
}
