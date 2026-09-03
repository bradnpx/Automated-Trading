export class StockBlacklist {
  private symbols = new Set<string>();

  /** Replaces the current blacklist from the local lifecycle store. */
  public sync(symbols: Iterable<string>): void {
    this.symbols = new Set(
      Array.from(symbols).filter((symbol): symbol is string => Boolean(symbol)),
    );
  }

  public getSymbols(): string[] {
    return Array.from(this.symbols);
  }
}
