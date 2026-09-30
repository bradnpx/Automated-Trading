import assert from "node:assert/strict";

import { Executor } from "./executor.js";

async function run(): Promise<void> {
  const submittedOrders: Array<Record<string, unknown>> = [];
  const executor = new Executor({
    async getPosition() {
      return { qty: "5" };
    },
    async getLatestBars() {
      return new Map([["TEST", { ClosePrice: 105 }]]);
    },
    async createOrder(order: Record<string, unknown>) {
      submittedOrders.push(order);
      return { id: "trailing-order-1" };
    },
  } as never);

  await executor.placeBreakEvenTrailingStop("TEST", 100);

  assert.deepEqual(submittedOrders, [
    {
      symbol: "TEST",
      qty: 5,
      side: "sell",
      type: "trailing_stop",
      trail_price: 5,
      time_in_force: "gtc",
    },
  ]);
  console.log("Broker trailing-stop verification passed.");
}

void run().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : "Unknown error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
