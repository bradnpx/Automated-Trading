import { fetchTradeHistory } from "../middleware/logger";

export class StockBlacklist {
  private static instance: StockBlacklist | null = null;
  private symbols: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private isUpdating = false;

  private constructor() {}

  // Fetch initial instance and start interval polling
  static async getInstance(
    pollIntervalMs: number = 60000,
  ): Promise<StockBlacklist> {
    if (!StockBlacklist.instance) {
      StockBlacklist.instance = new StockBlacklist();
      await StockBlacklist.instance.refresh();
      StockBlacklist.instance.startPolling(pollIntervalMs);
    }
    return StockBlacklist.instance;
  }

  // Refreshes symbols safely without overlapping executions
  public async refresh(): Promise<void> {
    if (this.isUpdating) return;
    this.isUpdating = true;

    try {
      this.symbols = await this.getHistory();
    } catch (error) {
      console.error("Error refreshing StockBlacklist:", error);
    } finally {
      this.isUpdating = false;
    }
  }

  // Starts the background polling timer
  public startPolling(intervalMs: number = 60000): void {
    if (this.timer) return; // Prevent duplicate timers

    this.timer = setInterval(() => {
      this.refresh();
    }, intervalMs);
  }

  // Stops background polling (useful during app shutdown or testing)
  public stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public getSymbols(): string[] {
    return this.symbols;
  }

  private async getHistory(): Promise<string[]> {
    const todaysTrades = new Set<string>();
    // const target = new Date();
    // target.setDate(target.getDate() - 1);
    // const today: string = target.toISOString().split("T")[0];
    const today: string = new Date().toISOString().split("T")[0];

    const history: any[] = await fetchTradeHistory();

    for (const h of history) {
      if (h.filled_at.split("T")[0] !== today) {
        console.log(`Blacklisted symbols: ${Array.from(todaysTrades)}`)
        return Array.from(todaysTrades);
      }

      if (!todaysTrades.has(h.symbol)) {
        todaysTrades.add(h.symbol);
      }
    }

    return Array.from(todaysTrades);
  }
}
