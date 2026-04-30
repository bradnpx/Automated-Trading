import Alpaca from "@alpacahq/alpaca-trade-api";

export class Executor {
  private alpaca: Alpaca;

  constructor(alpaca: Alpaca) {
    this.alpaca = alpaca;
  }

  /**
   * Places a market order to enter a position
   */
  async placeBuyOrder(symbol: string, qty: number) {
    try {
      const order = await this.alpaca.createOrder({
        symbol,
        qty,
        side: "buy",
        type: "market",
        time_in_force: "day",
      });
      console.log(
        `💰 [EXEC] BUY PLACED: ${symbol} | Qty: ${qty.toFixed(4)} | ID: ${order.id}`,
      );
      return order;
    } catch (err) {
      console.error(`❌ [EXEC] Buy Order Failed for ${symbol}:`, err);
    }
  }

  /**
   * Closes an existing position entirely
   */
  async closePosition(symbol: string) {
    try {
      // Alpaca has a specific 'closePosition' endpoint which is safer than
      // calculating quantity manually to sell.
      const response = await this.alpaca.closePosition(symbol);
      console.log(`📉 [EXEC] POSITION CLOSED: ${symbol}`);
      return response;
    } catch (err) {
      console.error(`❌ [EXEC] Close Position Failed for ${symbol}:`, err);
    }
  }

  /**
   * THE NUCLEAR OPTION: Cancels all orders and closes all positions.
   */
  async killEverything() {
    try {
      console.log("☢️  PANIC INITIATED: Clearing all orders and positions...");

      // 1. Cancel all open orders (pending buys/sells)
      await this.alpaca.cancelAllOrders();
      console.log("🛑 All open orders canceled.");

      // 2. Close all positions (sell everything at market price)
      await this.alpaca.closeAllPositions();
      console.log("📉 All positions closed.");

      return { success: true };
    } catch (err) {
      console.error("❌ PANIC FAILED:", err);
      return { success: false, error: err };
    }
  }
}
