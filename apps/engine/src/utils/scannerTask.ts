import { bootstrapMarketSession } from "../scanner.js";
import { MASTER_WATCHLIST, syncTrackingCaches } from "../config/config.js";
import { StrategyFactory } from "../strategies/StrategyFactory.js";

const HYDRATION_MINUTES = 30;

export async function executeDynamicScannerSweep(
  alpaca: any,
  strategies: Map<string, any>,
  pipeline: any,
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
          stopLossPct: 5,
          takeProfitPct: 5,
        });
        brandNewSymbols.push(symbol);
      }
    }

    if (brandNewSymbols.length > 0) {
      console.log(
        `✨[SCANNER] ${brandNewSymbols.length} new tickers discovered: ${brandNewSymbols.join(", ")}`,
      );
      syncTrackingCaches();

      for (const symbol of brandNewSymbols) {
        try {
          const strategyInstance = StrategyFactory.create("dayTradeMicroScalp");

          // Fix: fetch the last HYDRATION_MINUTES of 1-minute bars instead of a single
          // latest bar. With only 1 bar, RVOL is always ~1.0 (never >= 5) and the rolling
          // VWAP is meaningless, so isHighRVOL and VWAP-based criteria always fail.
          const now = new Date();
          const start = new Date(now.getTime() - HYDRATION_MINUTES * 60 * 1000);

          const barsIterable = alpaca.getBarsV2(symbol, {
            start: start.toISOString(),
            end: now.toISOString(),
            timeframe: "1Min",
            feed: "iex",
          });

          const historicalBars: any[] = [];
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
            // Graceful fallback: use the latest single bar if no range data is available
            const latestBarsMap = await alpaca.getLatestBars([symbol]);
            if (latestBarsMap && latestBarsMap.has(symbol)) {
              const b = latestBarsMap.get(symbol);
              strategyInstance.hydrate([{
                symbol,
                open: b.OpenPrice,
                high: b.HighPrice,
                low: b.LowPrice,
                close: b.ClosePrice,
                volume: b.Volume,
                timestamp: b.Timestamp,
              }]);
              console.warn(
                `⚠️[WARMUP] No range bars found for ${symbol}; fell back to single latest bar.`,
              );
            }
          }

          strategies.set(symbol, strategyInstance);
        } catch (warmupError) {
          console.error(
            `⚠️[WARMUP] Failed to hydrate technical bounds for asset ${symbol}: `,
            warmupError,
          );
        }
      }

      pipeline.subscribeToNewSymbols(brandNewSymbols);

      console.log(
        `🚀[SCANNER] Sweep complete. Monitoring new realtime tickers.`,
      );
    } else {
      console.log(
        `🚀[SCANNER] Sweep complete. No new unique volatile symbols.`,
      );
    }
  } catch (err) {
    console.error(
      "❌[SCANNER] Execution error occurred during interval run: ",
      err,
    );
  }
}
