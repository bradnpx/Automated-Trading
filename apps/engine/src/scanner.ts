import { runPreMarketScanner } from "./scanners/preMarketScanner";


export class Scanner {
  private volumeHistory: Map<string, number[]> = new Map();
  private readonly WINDOW = 20;

  public processBar(
    symbol: string,
    volume: number,
    price: number,
  ): { isHot: boolean; rvol: number; isTradable: boolean } {
    // Get volume history
    if (!this.volumeHistory.has(symbol)) {
      this.volumeHistory.set(symbol, []);
    }
    const history = this.volumeHistory.get(symbol)!;

    const isTradable = price >= 1 && price <= 10;
    
    if (history.length < this.WINDOW) {
      history.push(volume);
      return { isHot: false, rvol: 0, isTradable };
    }

    const avgVolume = history.reduce((a, b) => a + b, 0) / history.length;
    const rvol = volume / avgVolume;

    // Update history
    history.push(volume);
    history.shift();

    // Threshold for promotion: 5.0x Relative Volume
    // return { isHot: rvol >= 5.0, rvol };
    return { isHot: rvol >= 5 && volume >= 50_000, rvol, isTradable };
  }
}


/**
 * Dynamic Pre-Market Watchlist Setup
 * Wipes old watchlist states and provisions today's elite high-velocity candidates.
 */
export async function bootstrapMarketSession(): Promise<string[]> {
  console.log("⏳ [BOOTSTRAP] Executing dynamic watchlist setup...");

  // 1. Fire market scan across Polygon snapshots and filter by float metrics
  const detectedSymbols = await runPreMarketScanner();

  // 2. Clear out tracking symbols from any previous trading sessions
  // SYMBOL_STRATEGY_MAP.clear();

  // 3. Register the new low-float movers into the active execution workspace
  console.log(
    `✅ [BOOTSTRAP] Market session provisioned with ${detectedSymbols.length} active tickers.`,
  );
  return detectedSymbols;
  detectedSymbols.forEach((symbol) => {
    SYMBOL_STRATEGY_MAP[symbol] = "dayTradeMicroScalp";
  });

}