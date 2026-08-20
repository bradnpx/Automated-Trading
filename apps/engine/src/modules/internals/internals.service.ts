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

  async getIndexValue(ticker: string, timestamp: number): Promise<number | null> {
    if (!POLYGON_API_KEY) return null;
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
    } catch (err) {
      console.error(`🚫[MARKET INTERNALS] Polygon request failed for ${ticker}`);
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
    
    // Polygon supports VIX (I:VIX). For TICK, they don't natively support NYSE TICK but often traders map to an alternative or have a specialized data feed. We'll use I:VIX and I:TICK as requested in the pasted content, acknowledging that I:TICK might not return data on standard Polygon plans without the indices package.
    const [vix, tick] = await Promise.all([
      this.getIndexValue("I:VIX", now),
      this.getIndexValue("I:TICK", now)
    ]);
    
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
