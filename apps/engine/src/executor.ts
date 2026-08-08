import Alpaca from "@alpacahq/alpaca-trade-api";
import getTradingSession from "./functions/getTradingSession.js";
import { logActiveTrade, removeActiveTrade } from "./middleware/activeTradeLogger.js";

export class Executor {
  private alpaca: Alpaca;

  constructor(alpaca: Alpaca) {
    this.alpaca = alpaca;
  }

  /**
   * Places a market buy order and logs the resulting Alpaca order object,
   * augmented with the strategy name and risk thresholds, to the active-trade
   * log.
   *
   * @param symbol        Ticker symbol.
   * @param qty           Fractional or whole share quantity.
   * @param meta          Strategy context injected by the pipeline caller.
   */
  async placeBuyOrder(
    symbol: string,
    qty: number,
    meta: { strategy: string; takeProfitPct: number; stopLossPct: number } = {
      strategy: "unknown",
      takeProfitPct: 2.2,
      stopLossPct: 2.0,
    },
  ) {
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

      // Log the full Alpaca order object + engine-level metadata
      await logActiveTrade(order as Record<string, unknown>, meta);

      return order;
    } catch (err: any) {
      if (err?.response?.data?.message?.includes("fractionable")) {
        console.error(
          `🔁 [EXEC] Fractional Buy Order Failed for ${symbol}, rounding up and retrying...`,
        );
        const rounded = Math.ceil(qty);
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
            `💰 [EXEC] BUY PLACED (rounded): ${symbol} | Qty: ${rounded} | ID: ${order.id}`,
          );

          // Log the retried order with the same metadata
          await logActiveTrade(order as Record<string, unknown>, meta);

          return order;
        } catch (retryErr: any) {
          console.error(
            `❌ [EXEC] Buy Order Failed for ${symbol}:`,
            retryErr?.response?.data?.message,
          );
        }
      } else {
        console.error(
          `❌ [EXEC] Buy Order Failed for ${symbol}:`,
          err?.response?.data?.message,
        );
      }
    }
  }

  /**
   * Closes an existing position entirely and removes the corresponding entry
   * from the active-trade log once the close order is submitted.
   */
  async closePosition(symbol: string) {
    try {
      // Cancel outstanding orders for this symbol to clear the lane
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
      } catch (err: any) {
        if (err?.response?.status === 404) {
          console.log(
            `✅ [EXEC] No active position found for ${symbol}, nothing to close.`,
          );
          return;
        }
        throw err;
      }

      const qty = position.qty;
      const latestBars = await this.alpaca.getLatestBars([symbol]);
      const bar = latestBars.get(symbol);
      if (!bar) {
        throw new Error(`Unable to fetch real-time pricing data for ${symbol}`);
      }

      const marketableLimitPrice = Number((bar.ClosePrice * 0.98).toFixed(2));
      const response = await this.alpaca.createOrder({
        symbol,
        qty,
        side: "sell",
        type: "limit",
        limit_price: marketableLimitPrice,
        time_in_force: "day",
        extended_hours: true,
      });

      console.log(`📉 [EXEC] CLOSING POSITION: ${symbol}...`);

      // Remove the corresponding buy-side log entry now that the position
      // is being closed. We match by symbol since the original order id is
      // not readily available here; removeActiveTrade accepts an order id,
      // so we look it up from the open orders we already fetched above.
      const buyOrder = orders.find(
        (o: Record<string, unknown>) => o["side"] === "buy",
      );
      if (buyOrder) {
        await removeActiveTrade(String(buyOrder["id"] ?? ""));
      }

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
