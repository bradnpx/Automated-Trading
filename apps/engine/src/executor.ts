import Alpaca from "@alpacahq/alpaca-trade-api";
import { logTrade } from "./middleware/logger";
import getTradingSession from "./functions/getTradingSession";

export class Executor {
  private alpaca: Alpaca;

  constructor(alpaca: Alpaca) {
    this.alpaca = alpaca;
  }

  /**
   * Places a market order to enter a position
   */
  async placeBuyOrder(symbol: string, qty: number, price: number) {
    const session = getTradingSession();
    const isExtendedHours = session !== "market";
    try {
      const order = await this.alpaca.createOrder({
        symbol,
        qty,
        side: "buy",
        type: "market",
        time_in_force: "day",
        extended_hours: isExtendedHours,
      });
      console.log(
        `💰 [EXEC] BUY PLACED: ${symbol} | Qty: ${qty.toFixed(4)} | ID: ${order.id}`,
      );
      // logTrade({...order, filled_at: new Date()});
      return order;
    } catch (err) {
      if (err.response.data.message.includes('fractionable')) {
        console.error(`🔁 [EXEC] Fractional Buy Order Failed for ${symbol}, rounding up and retrying...`);   
        const rounded: number = Math.ceil(qty)
        try {
          const order = await this.alpaca.createOrder({
            symbol,
            qty: rounded,
            side: "buy",
            type: "market",
            time_in_force: "day",
            extended_hours: isExtendedHours,
          });
          console.log(
            `💰 [EXEC] BUY PLACED: ${symbol} | Qty: ${qty.toFixed(4)} | ID: ${order.id}`,
          );
          // logTrade({...order, filled_at: new Date()});
          return order;
        } catch (err) {
          console.error(
            `❌ [EXEC] Buy Order Failed for ${symbol}:`,
            err.response.data.message,
          );        
          }
      } else {
        console.error(
          `❌ [EXEC] Buy Order Failed for ${symbol}:`,
          err.response.data.message,
        );
      }
    }
  }

  /**
   * Closes all or part of an existing position.
   */
  async closePosition(symbol: string, requestedQuantity?: number) {
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

      let position;
      try {
        position = await this.alpaca.getPosition(symbol);
      } catch (err) {
        if (err && err.response?.status === 404) {
          console.log(
            `✅ [EXEC] No active position found for ${symbol}, nothing to close.`,
          );
          return;
        }
        throw err;
      }

      const positionQuantity = Number(position.qty);
      const quantity = requestedQuantity ?? positionQuantity;
      if (
        !Number.isFinite(quantity) ||
        quantity <= 0 ||
        quantity > positionQuantity
      ) {
        throw new Error(`Invalid sell quantity for ${symbol}: ${quantity}`);
      }

      const latestBars = await this.alpaca.getLatestBars([symbol]);
      const bar = latestBars.get(symbol);
      if (!bar) {
        throw new Error(`Unable to fetch real-time pricing data for ${symbol}`);
      }

      const marketableLimitPrice = Number((bar.ClosePrice * 0.98).toFixed(2));
      const response = await this.alpaca.createOrder({
        symbol,
        qty: quantity,
        side: "sell",
        type: "limit",
        limit_price: marketableLimitPrice,
        time_in_force: "day",
        extended_hours: true,
      });

      // const response = await this.alpaca.closePosition(symbol);
      console.log(`📉 [EXEC] CLOSING POSITION: ${symbol}...`);
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
   * Protects a remaining long position with a broker-managed trailing stop. The
   * dollar trail is calibrated so the initial broker stop is the entry price.
   */
  async placeBreakEvenTrailingStop(symbol: string, entryPrice: number) {
    if (!(entryPrice > 0)) {
      throw new Error(
        `Cannot set a break-even trailing stop for ${symbol} without a valid entry price.`,
      );
    }

    try {
      const position = await this.alpaca.getPosition(symbol);
      const quantity = Number(position.qty);
      if (!(quantity > 0)) {
        throw new Error(`No active position available for ${symbol}`);
      }

      const latestBars = await this.alpaca.getLatestBars([symbol]);
      const bar = latestBars.get(symbol);
      const currentPrice = Number(bar?.ClosePrice);
      if (!(currentPrice > entryPrice)) {
        throw new Error(
          `Cannot establish a break-even trailing stop for ${symbol} at $${currentPrice}.`,
        );
      }

      const trailPrice = roundToPriceIncrement(currentPrice - entryPrice);
      if (!(trailPrice > 0)) {
        throw new Error(`Invalid trailing price for ${symbol}: ${trailPrice}`);
      }

      const order = await this.alpaca.createOrder({
        symbol,
        qty: quantity,
        side: "sell",
        type: "trailing_stop",
        trail_price: trailPrice,
        time_in_force: "gtc",
      });
      console.log(
        `🛡️ [EXEC] TRAILING STOP PLACED: ${symbol} | Qty: ${quantity} | Initial stop: $${entryPrice.toFixed(2)} | ID: ${order.id}`,
      );
      return order;
    } catch (err) {
      console.error(
        `❌ [EXEC] Trailing Stop Placement Failed for ${symbol}:`,
        err,
      );
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

function roundToPriceIncrement(price: number): number {
  return Number(price.toFixed(price >= 1 ? 2 : 4));
}
