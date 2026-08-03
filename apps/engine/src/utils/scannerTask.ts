// utils/scannerTask.ts
// Recurring market discovery sweep.
// Discovers new volatile symbols, adds them to the master watchlist,
// hydrates their strategies with historical bars, and subscribes the
// stream pipeline to their real-time data feed.

import Alpaca from "@alpacahq/alpaca-trade-api";
import { Bar } from "@my-platform/types";
import { bootstrapMarketSession } from "../scanner.js";
import { MASTER_WATCHLIST, syncTrackingCaches } from "../config/config.js";
import { StrategyFactory } from "../strategies/StrategyFactory.js";
import { IStrategy } from "../strategies/IStrategy.js";
import { StreamPipeline } from "../pipeline.js";

const HYDRATION_MINUTES = 30;

export async function executeDynamicScannerSweep(
  alpaca: Alpaca,
  strategies: Map<string, IStrategy>,
  pipeline: StreamPipeline,
): Promise<void> {
  console.log("🔁[SCANNER] Initializing recurring market discovery sweep...");

  try {
    const discoveredSymbols = await bootstrapMarketSession();
    const brandNewSymbols: string[] = [];

    for (const symbol of discoveredSymbols) {
      if (!MASTER_WATCHLIST.has(symbol)) {
        MASTER_WATCHLIST.set(symbol, {
          symbol,
          strategy: "dayTradeMicroScalp",
          stopLossPct: 2,
          takeProfitPct: 2.2,
        });
        brandNewSymbols.push(symbol);
      }
    }

    if (brandNewSymbols.length === 0) {
      console.log("🚀[SCANNER] Sweep complete. No new unique volatile symbols.");
      return;
    }

    console.log(
      `✨[SCANNER] ${brandNewSymbols.length} new tickers discovered: ${brandNewSymbols.join(", ")}`,
    );
    syncTrackingCaches();

    for (const symbol of brandNewSymbols) {
      try {
        const strategyInstance = StrategyFactory.create("dayTradeMicroScalp");

        // Fetch the last HYDRATION_MINUTES of 1-minute bars so that RVOL and
        // VWAP have enough history to produce meaningful values from the first tick.
        const now = new Date();
        const start = new Date(now.getTime() - HYDRATION_MINUTES * 60 * 1000);

        const barsIterable = alpaca.getBarsV2(symbol, {
          start: start.toISOString(),
          end: now.toISOString(),
          timeframe: "1Min",
          feed: "iex",
        });

        const historicalBars: Bar[] = [];
        for await (const bar of barsIterable) {
          historicalBars.push({
            symbol,
            open: bar.OpenPrice,
            high: bar.HighPrice,
            low: bar.LowPrice,
            close: bar.ClosePrice,
            volume: bar.Volume,
            timestamp: bar.Timestamp,
          });
        }

        if (historicalBars.length > 0) {
          strategyInstance.hydrate(historicalBars);
          console.log(
            `📈[WARMUP] Hydrated ${symbol} with ${historicalBars.length} historical bars.`,
          );
        } else {
          // Graceful fallback: use the latest single bar if no range data is available.
          const latestBarsMap = await alpaca.getLatestBars([symbol]);
          if (latestBarsMap?.has(symbol)) {
            const b = latestBarsMap.get(symbol);
            strategyInstance.hydrate([
              {
                symbol,
                open: b.OpenPrice,
                high: b.HighPrice,
                low: b.LowPrice,
                close: b.ClosePrice,
                volume: b.Volume,
                timestamp: b.Timestamp,
              },
            ]);
            console.warn(
              `⚠️[WARMUP] No range bars for ${symbol}; fell back to single latest bar.`,
            );
          }
        }

        strategies.set(symbol, strategyInstance);
      } catch (warmupError) {
        console.error(
          `⚠️[WARMUP] Failed to hydrate technical bounds for ${symbol}:`,
          warmupError,
        );
      }
    }

    pipeline.subscribeToNewSymbols(brandNewSymbols);
    console.log("🚀[SCANNER] Sweep complete. Monitoring new realtime tickers.");
  } catch (err) {
    console.error(
      "❌[SCANNER] Execution error occurred during interval run:",
      err,
    );
  }
}
