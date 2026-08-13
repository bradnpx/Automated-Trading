import axios from "axios";
import { POLYGON_API } from "../config/config.js";
import { getPublicFreeFloat } from "../functions/getFloat.js";

interface AlpacaMover {
  symbol: string;
  price: number;
  percent_change: number;
}

interface AlpacaMoversResponse {
  gainers: AlpacaMover[];
  losers: AlpacaMover[];
}

const LOW_FLOAT_THRESHOLD = 25_000_000;

/**
 * Sweeps the stock market for top gainers using Alpaca's free screener endpoint,
 * then checks Polygon's basic tier to isolate low-supply targets.
 */
export async function runPreMarketScanner() {
  const eliteWatchlist: string[] = [];

  console.log(
    "🔍 [PRE-MARKET] Initializing free Alpaca-powered discovery scan...",
  );

  try {
    const alpacaUrl =
      "https://data.alpaca.markets/v1beta1/screener/stocks/movers";
    const response = await axios.get<AlpacaMoversResponse>(alpacaUrl, {
      headers: {
        "APCA-API-KEY-ID": process.env.APCA_API_KEY_ID || "",
        "APCA-API-SECRET-KEY": process.env.APCA_API_SECRET_KEY || "",
        accept: "application/json",
      },
      params: {
        top: 20,
      },
    });

    if (!response.data || !response.data.gainers) {
      console.log("⚠️ [PRE-MARKET] Empty response from Alpaca screener feed.");
      return [];
    }

    const marketGainers = response.data.gainers;

    const immediateCandidates = marketGainers.filter((stock) => {
      const price = stock.price || 0;
      const percentChange = stock.percent_change || 0;

      return price >= 1.0 && price <= 10.0 && percentChange >= 10.0;
    });

    console.log(
      `📊 [PRE-MARKET] Alpaca found ${immediateCandidates.length} hot low-priced gainers. Checking supply via Polygon...`,
    );

    for (const candidate of immediateCandidates) {
      const ticker = candidate.symbol;

      // If you hit a high amount of candidates, consider increasing this delay
      await new Promise((resolve) => setTimeout(resolve, 200));

      const freeFloat = await getPublicFreeFloat(ticker);

      // Fix: enforce the low-float threshold rather than accepting any non-null value.
      // Previously, any ticker with a resolvable float (including large-caps) was admitted,
      // causing the strategy's isLowFloat criterion to always fail at evaluation time.
      if (freeFloat !== null && freeFloat < LOW_FLOAT_THRESHOLD) {
        console.log(
          `✅ [ELITE CANDIDATE] ${ticker} | Float: ${(freeFloat / 1e6).toFixed(2)}M | Gain: +${candidate.percent_change.toFixed(1)}%`,
        );
        eliteWatchlist.push(ticker);
      } else {
        // console.log(
        //   `⛔ [REJECTED] ${ticker} | Float: ${freeFloat !== null ? (freeFloat / 1e6).toFixed(2) + "M" : "unavailable"} | Threshold: <${(LOW_FLOAT_THRESHOLD / 1e6).toFixed(0)}M`,
        // );
      }
    }

    console.log(
      `🚀 [PRE-MARKET] Scan complete. ${eliteWatchlist.length} symbols passed into active engine cache.`,
    );
    return eliteWatchlist;
  } catch (error) {
    console.error("❌ [PRE-MARKET SCANNER CRITICAL FAILURE]:", error);
    return [];
  }
}
