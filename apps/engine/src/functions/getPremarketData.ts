import Alpaca from "@alpacahq/alpaca-trade-api";

import { getEasternTimeParts } from "./getTradingSession.js";

const alpaca = new Alpaca();
const PREMARKET_START_MINUTES = 4 * 60;
const MARKET_OPEN_MINUTES = 9 * 60 + 30;
const PREMARKET_REFRESH_MS = 60_000;
const PREMARKET_FAILURE_RETRY_MS = 60_000;

export interface PremarketData {
  price: number | null;
  open: number | null;
  high: number | null;
  premarketHigh: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  timestamp: number;
  o: number | null;
  h: number | null;
  l: number | null;
  c: number | null;
  v: number | null;
}

type AlpacaBar = {
  OpenPrice?: number;
  HighPrice?: number;
  LowPrice?: number;
  ClosePrice?: number;
  Volume?: number;
  Timestamp: string | number | Date;
};

type PremarketBarsClient = {
  getBarsV2(
    symbol: string,
    options: {
      start: string;
      end: string;
      timeframe: string;
      adjustment: string;
      feed: string;
    },
  ): AsyncIterable<AlpacaBar>;
};

type PremarketCacheEntry = {
  expiresAt: number;
  result: Promise<PremarketData | null>;
};

const premarketCache = new Map<string, PremarketCacheEntry>();

/**
 * Fetches and caches the current session's premarket bars. The completed
 * premarket snapshot is immutable after the 9:30 AM Eastern open; while
 * premarket is live, it is refreshed at most once per minute per ticker.
 */
export async function getPremarketData(
  symbol: string,
  now = new Date(),
  client: PremarketBarsClient = alpaca,
): Promise<PremarketData | null> {
  if (!symbol) {
    console.warn(
      "⚠️ [PREMARKET] getPremarketData was invoked with an undefined or empty symbol.",
    );
    return null;
  }

  const { dateKey, hour, minute } = getEasternTimeParts(now);
  const easternMinutes = hour * 60 + minute;
  if (easternMinutes < PREMARKET_START_MINUTES) return null;

  clearStalePremarketCache(dateKey);

  const cacheKey = `${dateKey}:${symbol.toUpperCase()}`;
  const cached = premarketCache.get(cacheKey);
  if (cached && cached.expiresAt > now.getTime()) {
    return cached.result;
  }

  const expiresAt =
    easternMinutes < MARKET_OPEN_MINUTES
      ? now.getTime() + PREMARKET_REFRESH_MS
      : Number.POSITIVE_INFINITY;
  let result: Promise<PremarketData | null>;
  result = fetchPremarketData(symbol, dateKey, now, client).catch((error) => {
    if (premarketCache.get(cacheKey)?.result === result) {
      premarketCache.set(cacheKey, {
        expiresAt: now.getTime() + PREMARKET_FAILURE_RETRY_MS,
        result: Promise.resolve(null),
      });
    }
    console.error(
      `❌ Error computing pre-market metrics for ${symbol} via Alpaca V2 Data:`,
      error,
    );
    return null;
  });

  premarketCache.set(cacheKey, { expiresAt, result });
  return result;
}

export function clearPremarketDataCache(): void {
  premarketCache.clear();
}

async function fetchPremarketData(
  symbol: string,
  dateKey: string,
  now: Date,
  client: PremarketBarsClient,
): Promise<PremarketData | null> {
  const easternOffset = getEasternOffset(new Date(`${dateKey}T12:00:00.000Z`));
  const startIso = new Date(
    `${dateKey}T04:00:00${easternOffset}`,
  ).toISOString();
  const premarketEnd = new Date(`${dateKey}T09:30:00${easternOffset}`);
  const endIso = new Date(
    Math.min(now.getTime(), premarketEnd.getTime() - 1),
  ).toISOString();
  const barsResponse = client.getBarsV2(symbol, {
    start: startIso,
    end: endIso,
    timeframe: "1Min",
    adjustment: "all",
    feed: "iex",
  });

  const bars: AlpacaBar[] = [];
  for await (const bar of barsResponse) {
    bars.push(bar);
  }

  if (bars.length === 0) {
    console.log(
      `⚠️ No pre-market trading activity detected for ${symbol} since 4:00 AM Eastern via Alpaca IEX.`,
    );
    return null;
  }

  const premarketHigh = Math.max(...bars.map((bar) => bar.HighPrice ?? 0));
  const firstBar = bars[0];

  return {
    price: firstBar.OpenPrice ?? null,
    open: firstBar.OpenPrice ?? null,
    high: firstBar.HighPrice ?? null,
    premarketHigh: premarketHigh || null,
    low: firstBar.LowPrice ?? null,
    close: firstBar.ClosePrice ?? null,
    volume: firstBar.Volume ?? null,
    timestamp: new Date(firstBar.Timestamp).getTime(),
    o: firstBar.OpenPrice ?? null,
    h: firstBar.HighPrice ?? null,
    l: firstBar.LowPrice ?? null,
    c: firstBar.ClosePrice ?? null,
    v: firstBar.Volume ?? null,
  };
}

function clearStalePremarketCache(currentDateKey: string): void {
  for (const cacheKey of premarketCache.keys()) {
    if (!cacheKey.startsWith(`${currentDateKey}:`)) {
      premarketCache.delete(cacheKey);
    }
  }
}

function getEasternOffset(date: Date): string {
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
  })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;

  if (!offset || offset === "GMT") {
    throw new Error("Unable to determine the America/New_York UTC offset.");
  }

  return offset.replace("GMT", "");
}
