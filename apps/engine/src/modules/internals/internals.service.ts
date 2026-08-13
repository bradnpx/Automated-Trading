import { yFinance } from "../../strategies/services/yfinance";

export class Internals {
  private api: typeof yFinance = yFinance;
  public vix: number | null = null;
  public tick: number | null = null;

  async getChart(symbol: string) {
    try {
      const result = await this.api.quote(symbol);
      console.log(result.regularMarketPrice);
      return result;
    } catch (err) {
      console.error(
        `🚫[MARKET INTERNALS] ${symbol} check failed: ${err as string}`,
      );
    }
  }

  async getCharts() {
    const getVix = await this.getChart("^VIX");
    this.vix = getVix ? getVix.regularMarketPrice : null;
    // const tick = await this.getChart("^TICK");
    // this.tick = tick ? tick.regularMarketPrice : null;
  }
}
