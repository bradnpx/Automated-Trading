import { bootstrapMarketSession } from "../scanner.js";
import { MASTER_WATCHLIST, syncTrackingCaches } from "../config/config.js";
import { StrategyFactory } from "../strategies/StrategyFactory.js";

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
          stopLossPct: 2,
          takeProfitPct: 2.2,
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

          const historicalBars = await alpaca.getLatestBars([symbol]);

          if (historicalBars && historicalBars.has(symbol)) {
            strategyInstance.hydrate([historicalBars.get(symbol)]);
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
