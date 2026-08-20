import axios from "axios";
import { getEasternTimeParts } from "../../functions/getTradingSession.js";

const POLYGON_API_KEY = process.env.POLYGON_API_KEY;

export class Internals {
  public vix: number | null = null;
  public tick: number | null = null;
  public previousCloses: Map<string, number> = new Map();

  private getMinuteStart(timestamp: number): number {
    return Math.floor(timestamp / 60000) * 60000;
  }

  async getIndexValue(ticker: string, provider: 'polygon' | 'yahoo' = 'polygon', timestamp?: number): Promise<number | null> {
    if (provider === 'yahoo') {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1m`;
      try {
        const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const result = response.data?.chart?.result?.[0];
        if (result?.meta?.regularMarketPrice !== undefined) {
          // Yahoo often returns 0 for indices like C:TICK if market is closed or unsupported, fallback to indicators if possible
          if (result.meta.regularMarketPrice !== 0) {
            return result.meta.regularMarketPrice;
          }
        }
      } catch (err) {
        console.error(`🚫[MARKET INTERNALS] Yahoo request failed for ${ticker}`);
      }
      return null;
    }

    if (!POLYGON_API_KEY || !timestamp) return null;
    const minute = this.getMinuteStart(timestamp);
    const from = minute - 5 * 60000;
    const to = minute + 60000;
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/minute/${from}/${to}?adjusted=true&sort=desc&limit=20&apiKey=${POLYGON_API_KEY}`;
    
    try {
      const response = await axios.get(url);
      if (response.data?.results?.length) {
        const eligibleBars = response.data.results.filter((r: any) => r.t <= minute + 60000);
        if (eligibleBars.length > 0) {
          return eligibleBars[0].c;
        }
      }
    } catch (err: any) {
      // Catch 403 Forbidden which means the user lacks the Indices package
      if (err.response?.status === 403) {
        console.error(`🚫[MARKET INTERNALS] Polygon 403 Forbidden for ${ticker}. Ensure you have the Polygon Indices subscription.`);
      } else {
        console.error(`🚫[MARKET INTERNALS] Polygon request failed for ${ticker}: ${err.message}`);
      }
    }
    return null;
  }

  async getPreviousClose(symbol: string): Promise<number | null> {
    if (this.previousCloses.has(symbol)) {
      return this.previousCloses.get(symbol) ?? null;
    }
    if (!POLYGON_API_KEY) return null;
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/prev?adjusted=true&apiKey=${POLYGON_API_KEY}`;
    try {
      const response = await axios.get(url);
      if (response.data?.results?.length) {
        const prevClose = response.data.results[0].c;
        this.previousCloses.set(symbol, prevClose);
        return prevClose;
      }
    } catch (err) {
      console.error(`🚫[MARKET INTERNALS] Polygon prev close failed for ${symbol}`);
    }
    return null;
  }

  async getCharts() {
    const now = Date.now();
    
    // Attempt Yahoo Finance first for VIX since Polygon Indices requires an extra subscription
    let vix = await this.getIndexValue("^VIX", "yahoo");
    if (vix === null) {
      // Fallback to Polygon if Yahoo fails
      vix = await this.getIndexValue("I:VIX", "polygon", now);
    }

    // TICK is notoriously hard to get for free. Yahoo's C:TICK is often stale or 0.
    // We'll try Polygon's I:TICK (which requires the indices sub) and fallback to Yahoo if we have to.
    let tick = await this.getIndexValue("I:TICK", "polygon", now);
    if (tick === null) {
       // Optional fallback to a proxy or just leave as null if unavailable
       // tick = await this.getIndexValue("C:TICK", "yahoo");
    }
    
    if (vix !== null) this.vix = vix;
    if (tick !== null) this.tick = tick;
  }

  getSnapshot() {
    return {
      vix: this.vix,
      tick: this.tick,
      timestamp: new Date().toISOString()
    };
  }
}

export const internalsService = new Internals();
