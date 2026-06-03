// src/functions/getPremarketData.ts
import Alpaca from "@alpacahq/alpaca-trade-api";

// Initialize a self-contained Alpaca instance from environment variables,
// matching the pattern originally used for the Polygon REST client.
const alpaca = new Alpaca();

/**
 * Fetches pre-market bar metrics using Alpaca's V2 Data API.
 * Keeps the original single-argument signature to prevent upstream parameter shifting.
 * * @param symbol - The stock ticker symbol (e.g., "XOS").
 */
export async function getPremarketData(symbol: string) {
  // Defensive guard against missing or unpopulated tickers
  if (!symbol) {
    console.warn(
      "⚠️ [PREMARKET] getPremarketData was invoked with an undefined or empty symbol.",
    );
    return null;
  }

  try {
    const nyDateString = new Date().toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    const [month, day, year] = nyDateString.split("/");
    const formattedDate = `${year}-${month}-${day}`;

    const startIso = new Date(`${formattedDate}T04:00:00-04:00`).toISOString();
    const endIso = new Date().toISOString();
    const barsResponse = alpaca.getBarsV2(symbol, {
      start: startIso,
      end: endIso,
      timeframe: "1Min",
      adjustment: "all",
      feed: "iex", // "sip" for premium accounts
    });

    const results = [];
    for await (const bar of barsResponse) {
      results.push(bar);
    }

    if (results.length === 0) {
      console.log(
        `⚠️ No pre-market trading activity detected for ${symbol} since 4:00 AM Eastern via Alpaca IEX.`,
      );
      return null;
    }

    // Grab the first historical pre-market bar from the array
    const firstBar = results[0];

    // Includes both standard fields and Polygon lookalike shorthand variables (.o, .v)
    // to protect getPremarketChange.ts function from throwing undefined property reads.
    return {
      // Alpaca descriptive properties
      open: firstBar.OpenPrice ?? null,
      high: firstBar.HighPrice ?? null,
      low: firstBar.LowPrice ?? null,
      close: firstBar.ClosePrice ?? null,
      volume: firstBar.Volume ?? null,
      timestamp: new Date(firstBar.Timestamp).getTime(),

      // Polygon compatibility mapping fallbacks (.o, .h, .l, .c, .v)
      o: firstBar.OpenPrice ?? null,
      h: firstBar.HighPrice ?? null,
      l: firstBar.LowPrice ?? null,
      c: firstBar.ClosePrice ?? null,
      v: firstBar.Volume ?? null,
    };
  } catch (err) {
    console.error(
      `❌ Error computing pre-market metrics for ${symbol} via Alpaca V2 Data:`,
      err,
    );
    throw err;
  }
}
