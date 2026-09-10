import assert from "node:assert/strict";

import {
  clearPremarketDataCache,
  getPremarketData,
} from "./getPremarketData.js";

type AlpacaBar = {
  OpenPrice: number;
  HighPrice: number;
  LowPrice: number;
  ClosePrice: number;
  Volume: number;
  Timestamp: string;
};

function createClient(bars: AlpacaBar[]) {
  let requestCount = 0;

  return {
    get requestCount() {
      return requestCount;
    },
    getBarsV2: async function* (): AsyncIterable<AlpacaBar> {
      requestCount++;
      for (const bar of bars) {
        yield bar;
      }
    },
  };
}

async function run(): Promise<void> {
  const bars: AlpacaBar[] = [
    {
      OpenPrice: 10,
      HighPrice: 10.5,
      LowPrice: 9.9,
      ClosePrice: 10.25,
      Volume: 100,
      Timestamp: "2026-09-10T08:00:00.000Z",
    },
    {
      OpenPrice: 10.25,
      HighPrice: 12,
      LowPrice: 10.2,
      ClosePrice: 11.5,
      Volume: 200,
      Timestamp: "2026-09-10T08:01:00.000Z",
    },
  ];
  const now = new Date("2026-09-10T15:00:00.000Z");
  const client = createClient(bars);

  clearPremarketDataCache();
  const [first, second] = await Promise.all([
    getPremarketData("AAPL", now, client),
    getPremarketData("AAPL", now, client),
  ]);

  assert.equal(
    client.requestCount,
    1,
    "concurrent ticker requests share one call",
  );
  assert.equal(first?.premarketHigh, 12);
  assert.deepEqual(second, first);

  await getPremarketData("AAPL", now, client);
  assert.equal(
    client.requestCount,
    1,
    "completed premarket data remains cached after the market opens",
  );

  const beforePremarket = new Date("2026-09-10T07:00:00.000Z");
  clearPremarketDataCache();
  assert.equal(await getPremarketData("AAPL", beforePremarket, client), null);
  assert.equal(
    client.requestCount,
    1,
    "requests before the 4:00 AM Eastern premarket start are skipped",
  );

  let failedRequestCount = 0;
  const failingClient = {
    getBarsV2: async function* (): AsyncIterable<AlpacaBar> {
      failedRequestCount++;
      throw new Error("rate limited");
    },
  };

  clearPremarketDataCache();
  assert.equal(await getPremarketData("MSFT", now, failingClient), null);
  assert.equal(await getPremarketData("MSFT", now, failingClient), null);
  assert.equal(
    failedRequestCount,
    1,
    "failed requests are cached briefly to prevent rapid retry storms",
  );

  console.log("Premarket data cache verification passed.");
}

void run();
