import { BarSchema } from "@my-platform/types";
import {
  TRADING_CONFIG,
  ALL_TRACKED_SYMBOLS,
  MASTER_WATCHLIST,
} from "../config.js";
import { StrategyFactory } from "../strategies/StrategyFactory.js";

/**
 * Converts the async generator returned by getBarsV2 into a plain array.
 * Useful for batch-processing historical bars, backbone for bar comparison.
 */
async function barsToArray(gen: AsyncIterable<any>): Promise<any[]> {
  const result: any[] = [];
  for await (const b of gen) {
    result.push(b);
  }
  return result;
}

/**
 * Checks the connectivity and trading status of the Alpaca brokerage account.
 * Kills the engine safely if any critical trade blocking is active.
 */
export async function checkAccountHealth(alpaca: any): Promise<void> {
  console.log("--- 🚀 Initializing Trading Engine Health Check ---");
  try {
    const account = await alpaca.getAccount();
    console.log(
      `Status: ${account.status} | Buying Power: $${account.buying_power} | Equity: $${account.equity}`,
    );

    if (account.trading_blocked) {
      console.warn("⚠️ WARNING: Account is blocked from trading.");
      process.exit(1);
    }
  } catch (error) {
    console.error(
      "❌ Failed to connect to Alpaca API:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
}

/**
 * Fetches the previous trading day's low for a given symbol using free IEX data feed.
 */
export async function getPreviousDayLow(
  alpaca: any,
  symbol: string,
): Promise<number> {
  try {
    const gen = alpaca.getBarsV2(symbol, {
      start: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
      end: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
      timeframe: alpaca.newTimeframe(1, alpaca.timeframeUnit.DAY),
      feed: "iex",
    });

    const bars = await barsToArray(gen);
    if (bars.length === 0) return 0;

    const b = bars[bars.length - 1];
    return b.LowPrice ?? b.Low ?? b.low ?? 0;
  } catch (error) {
    console.error(`❌ Error fetching previous day low for ${symbol}:`, error);
    return 0;
  }
}

/**
 * Iterates through your core tracking watchlist, pulls historical lookback 1-min intervals,
 * parses them through Zod schemas, and pre-populates your active technical indicators.
 * Now completely dynamic across multiple strategy shapes via the StrategyFactory.
 */
export async function warmupStrategies(
  alpaca: any,
  strategies: Map<string, any>,
): Promise<void> {
  // for (const symbol of ALL_TRACKED_SYMBOLS) {
  for (const [symbol, props] of MASTER_WATCHLIST) {
    const targetStrategyKey = props.strategy;

    if (!targetStrategyKey) {
      console.warn(
        `⚠️ Warmup Skip: No strategy mapping found in config for symbol: ${symbol}`,
      );
      continue;
    }

    console.log(
      `🔥 Warming up strategy configuration [${targetStrategyKey}] for ${symbol}...`,
    );

    try {
      // Fetch last ~3 hours of 1-min bars for indicator warmup
      const gen = alpaca.getBarsV2(symbol, {
        start: new Date(Date.now() - 1000 * 60 * 200).toISOString(), // ~3 hours ago
        end: new Date(Date.now() - 1000 * 60 * 16).toISOString(), // 16 mins delay layout for free IEX tier
        timeframe: alpaca.newTimeframe(1, alpaca.timeframeUnit.MIN),
        feed: "iex",
      });

      const rawBars = await barsToArray(gen);

      const historicalBars = rawBars.map((b) =>
        BarSchema.parse({
          symbol: symbol,
          timestamp: b.Timestamp ?? b.timestamp,
          open: b.OpenPrice ?? b.Open ?? b.open,
          high: b.HighPrice ?? b.High ?? b.high,
          low: b.LowPrice ?? b.Low ?? b.low,
          close: b.ClosePrice ?? b.Close ?? b.close,
          volume: b.Volume ?? b.volume,
        }),
      );

      // Derive baseline support levels using the absolute lowest point in the warmup block
      const prevLow =
        historicalBars.length > 0
          ? Math.min(...historicalBars.map((b) => b.low))
          : 0;

      // 2. DYNAMIC STEP: Instantiate the exact type of strategy class requested by the config matrix
      const strategy = StrategyFactory.create(targetStrategyKey);

      // 3. SEAMLESS INTERFACE INVOCATION: Every strategy (BasicStrategy, PDLSweep, etc.)
      // safely implements `.hydrate()`, so this single contract execution covers all strategy shapes!
      strategy.hydrate(historicalBars, prevLow);

      // Save the freshly populated strategy instance into the shared memory registry map
      strategies.set(symbol, strategy);

      console.log(
        `✅ Strategy [${targetStrategyKey}] for ${symbol} successfully warmed up with ${historicalBars.length} bars.`,
      );
    } catch (error) {
      console.error(
        `❌ Critical error pre-warming strategy indicators for ${symbol}:`,
        error,
      );
    }
  }
}
