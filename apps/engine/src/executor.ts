import Alpaca from "@alpacahq/alpaca-trade-api";
import { logTrade } from "./logger";

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
      logTrade(order);
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
      //cancel outstanding orders pertaining to the symbol to 'clear out the lane'
      const orders = await this.alpaca.getOrders({
        status: "open",
        until: undefined,
        after: undefined,
        limit: undefined,
        direction: undefined,
        nested: undefined,
        symbols: [symbol],
      });
      for (const order of orders) {
        try {
          await this.alpaca.cancelOrder(order.id);
          logTrade(order);
        } catch (err: any) {
          if (err?.response?.status === 422) {
            console.log(
              `⏳ [EXEC] Order ${order.id} already pending cancel, skipping...`,
            );
          } else {
            throw err;
          }
        }
      }

      if (orders.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      const response = await this.alpaca.closePosition(symbol);
      console.log(`📉 [EXEC] POSITION CLOSED: ${symbol}`);
      return response;
    } catch (err: any) {
      if (err?.response?.status === 404) {
        console.log(`✅ [EXEC] Position ${symbol} already closed.`);
        return;
      }
      console.error(`❌ [EXEC] Close Position Failed for ${symbol}:`, err);
      throw err;
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
