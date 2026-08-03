// utils/market.ts
// Utility functions for account health checks, historical bar fetching,
// and strategy warm-up. All `any` types replaced with strict interfaces.

import Alpaca from "@alpacahq/alpaca-trade-api";
import { BarSchema, Bar } from "@my-platform/types";
import { MASTER_WATCHLIST } from "../config/config.js";
import { StrategyFactory } from "../strategies/StrategyFactory.js";
import { IStrategy } from "../strategies/IStrategy.js";

// ─── Raw bar shape returned by the Alpaca getBarsV2 generator ─────────────────
interface RawAlpacaBar {
  Timestamp?: string;
  timestamp?: string;
  OpenPrice?: number;
  Open?: number;
  open?: number;
  HighPrice?: number;
  High?: number;
  high?: number;
  LowPrice?: number;
  Low?: number;
  low?: number;
  ClosePrice?: number;
  Close?: number;
  close?: number;
  Volume?: number;
  volume?: number;
}

/**
 * Drains an async generator of raw Alpaca bars into a plain array.
 */
async function barsToArray(gen: AsyncIterable<RawAlpacaBar>): Promise<RawAlpacaBar[]> {
  const result: RawAlpacaBar[] = [];
  for await (const b of gen) {
    result.push(b);
  }
  return result;
}

/**
 * Checks the connectivity and trading status of the Alpaca brokerage account.
 * Exits the process if the account is blocked or unreachable.
 */
export async function checkAccountHealth(alpaca: Alpaca): Promise<void> {
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
 * Fetches the previous trading day's low for a given symbol using the IEX feed.
 */
export async function getPreviousDayLow(
  alpaca: Alpaca,
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

    const b = bars[bars.length - 1]!;
    return b.LowPrice ?? b.Low ?? b.low ?? 0;
  } catch (error) {
    console.error(`❌ Error fetching previous day low for ${symbol}:`, error);
    return 0;
  }
}

/**
 * Pre-warms all strategies in the master watchlist with historical 1-minute bars
 * so that technical indicators (VWAP, RSI, RVOL) have meaningful values before
 * the live stream begins.
 */
export async function warmupStrategies(
  alpaca: Alpaca,
  strategies: Map<string, IStrategy>,
): Promise<void> {
  for (const [symbol, props] of MASTER_WATCHLIST) {
    const targetStrategyKey = props.strategy;

    if (!targetStrategyKey) {
      console.warn(
        `⚠️ Warmup Skip: No strategy mapping found in config for symbol: ${symbol}`,
      );
      continue;
    }

    console.log(
      `🔥 Warming up strategy [${targetStrategyKey}] for ${symbol}...`,
    );

    try {
      // Fetch last ~200 minutes of 1-min bars for indicator warmup.
      // The 16-minute end offset accounts for the IEX free-tier data delay.
      const gen = alpaca.getBarsV2(symbol, {
        start: new Date(Date.now() - 1000 * 60 * 200).toISOString(),
        end: new Date(Date.now() - 1000 * 60 * 16).toISOString(),
        timeframe: alpaca.newTimeframe(1, alpaca.timeframeUnit.MIN),
        feed: "iex",
      });

      const rawBars = await barsToArray(gen);

      const historicalBars: Bar[] = rawBars.map((b) =>
        BarSchema.parse({
          symbol,
          timestamp: b.Timestamp ?? b.timestamp,
          open: b.OpenPrice ?? b.Open ?? b.open,
          high: b.HighPrice ?? b.High ?? b.high,
          low: b.LowPrice ?? b.Low ?? b.low,
          close: b.ClosePrice ?? b.Close ?? b.close,
          volume: b.Volume ?? b.volume,
        }),
      );

      // Derive the previous day's low as a baseline support level for PDL strategies.
      const prevLow =
        historicalBars.length > 0
          ? Math.min(...historicalBars.map((b) => b.low))
          : 0;

      const strategy = StrategyFactory.create(targetStrategyKey);
      strategy.hydrate(historicalBars, prevLow);
      strategies.set(symbol, strategy);

      console.log(
        `✅ Strategy [${targetStrategyKey}] for ${symbol} warmed up with ${historicalBars.length} bars.`,
      );
    } catch (error) {
      console.error(
        `❌ Critical error pre-warming strategy indicators for ${symbol}:`,
        error,
      );
    }
  }
}
