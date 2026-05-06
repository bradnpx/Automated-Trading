// apps/engine/src/scanner.ts
export class Scanner {
  private volumeHistory: Map<string, number[]> = new Map();
  private readonly WINDOW = 20;

  public processBar(
    symbol: string,
    volume: number,
  ): { isHot: boolean; rvol: number } {
    if (!this.volumeHistory.has(symbol)) {
      this.volumeHistory.set(symbol, []);
    }

    const history = this.volumeHistory.get(symbol)!;

    if (history.length < this.WINDOW) {
      history.push(volume);
      return { isHot: false, rvol: 0 };
    }

    const avgVolume = history.reduce((a, b) => a + b, 0) / history.length;
    const rvol = volume / avgVolume;

    // Update history
    history.push(volume);
    history.shift();

    // Threshold for promotion: 5.0x Relative Volume
    return { isHot: rvol >= 5.0, rvol };
  }
}
