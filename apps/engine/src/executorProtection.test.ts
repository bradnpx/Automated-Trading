import assert from "node:assert/strict";

import {
  Executor,
  isTerminalProtectionOrder,
  toProtectionBrokerOrder,
  type ExecutorBroker,
  type ExecutorOrderRequest,
  type ProtectionBrokerOrder,
  type ProtectionExpectedExposure,
  type ProtectionExitOptions,
} from "./executor.js";

const NOW = new Date("2026-11-03T16:00:00Z");
const OPTIONS: ProtectionExitOptions = {
  extendedLimitOffset: 0.01,
  maxPriceAgeMs: 5_000,
  now: NOW,
};
const EXPECTED: ProtectionExpectedExposure = { quantity: 5, entryPrice: 100 };

function httpError(status: number): { response: { status: number } } {
  return { response: { status } };
}

function order(
  overrides: Partial<ProtectionBrokerOrder> = {},
): ProtectionBrokerOrder {
  return {
    id: "order-1",
    symbol: "TEST",
    client_order_id: "exit-1",
    side: "sell",
    type: "market",
    status: "new",
    qty: "5",
    filled_qty: "0",
    ...overrides,
  };
}

function mockBroker() {
  const state = {
    quantity: 5,
    available: 5,
    entryPrice: 100,
    fractionable: true,
    clockTimestamp: NOW.toISOString(),
    isOpen: true,
    calendar: [{ date: "2026-11-03", open: "09:30", close: "16:00" }],
    latestTrade: { Price: 105, Timestamp: NOW.toISOString() },
    orders: new Map<string, ProtectionBrokerOrder>(),
    requests: [] as ExecutorOrderRequest[],
    calls: [] as string[],
  };
  const broker: ExecutorBroker = {
    async getPosition() {
      state.calls.push("position");
      if (state.quantity === 0) throw httpError(404);
      return {
        qty: String(state.quantity),
        qty_available: String(state.available),
        avg_entry_price: String(state.entryPrice),
        side: "long",
      };
    },
    async getOrders() {
      state.calls.push("orders");
      return [...state.orders.values()].filter(
        (value) => !isTerminalProtectionOrder(value),
      );
    },
    async getOrderByClientOrderId(id) {
      state.calls.push(`lookup:${id}`);
      const existing = [...state.orders.values()].find(
        (value) => value.client_order_id === id,
      );
      if (!existing) throw httpError(404);
      return existing;
    },
    async getOrder(id) {
      state.calls.push(`order:${id}`);
      const existing = state.orders.get(id);
      if (!existing) throw httpError(404);
      return existing;
    },
    async cancelOrder(id) {
      state.calls.push(`cancel:${id}`);
      const existing = state.orders.get(id);
      if (existing) state.orders.set(id, { ...existing, status: "canceled" });
    },
    async createOrder(request) {
      state.calls.push("create");
      state.requests.push(request);
      const submitted = order({
        id: `submitted-${state.requests.length}`,
        symbol: request.symbol,
        client_order_id: request.client_order_id,
        qty: request.qty,
        side: request.side,
        type: request.type,
      });
      state.orders.set(submitted.id, submitted);
      return submitted;
    },
    async getClock() {
      return { timestamp: state.clockTimestamp, is_open: state.isOpen };
    },
    async getCalendar() {
      return state.calendar;
    },
    async getLatestTrade() {
      state.calls.push("trade");
      return state.latestTrade;
    },
    async getLatestBars() {
      state.calls.push("bars");
      return new Map([["TEST", { ClosePrice: 105 }]]);
    },
    async getAsset() {
      return { fractionable: state.fractionable };
    },
  };
  return { state, broker, executor: new Executor(broker) };
}

const tests: Array<[string, () => Promise<void>]> = [];
function test(name: string, run: () => Promise<void>): void {
  tests.push([name, run]);
}

test("regular session submits fractional market Day sell with stable ID and available clamp", async () => {
  const { state, executor } = mockBroker();
  state.quantity = 3.125;
  state.available = 1.1234567899;
  const result = await executor.submitProtectionExit("TEST", "exit-1", 20);
  assert.equal(result.kind, "submitted");
  assert.deepEqual(state.requests, [
    {
      symbol: "TEST",
      qty: 1.123456789,
      side: "sell",
      type: "market",
      time_in_force: "day",
      client_order_id: "exit-1",
    },
  ]);
  assert(!state.calls.includes("bars"));
  assert(!state.calls.includes("trade"));
});

test("decimal precision truncates scientific notation and never increases quantity", async () => {
  for (const quantity of [
    0.1234567899, 0.0000000199, 0.0000000011, 1.9999999999, 0.30000000000000004,
  ]) {
    const { state, executor } = mockBroker();
    state.quantity = quantity;
    state.available = quantity;
    await executor.submitProtectionExit("TEST", "exit-1");
    const submitted = state.requests[0];
    assert(submitted);
    assert(submitted.qty <= quantity);
    const fraction = submitted.qty.toFixed(9);
    assert.equal(Number(fraction), submitted.qty);
  }
});

test("sub-nanoshare dust and unavailable shares defer without creating an order", async () => {
  for (const quantity of [0.0000000009, 0]) {
    const { state, executor } = mockBroker();
    state.available = quantity;
    const result = await executor.submitProtectionExit("TEST", "exit-1");
    assert.equal(result.kind, "deferred");
    assert.equal(state.requests.length, 0);
  }
});

test("concurrent submissions with one client ID submit only once", async () => {
  const { state, executor } = mockBroker();
  const results = await Promise.all([
    executor.submitProtectionExit("TEST", "exit-1"),
    executor.submitProtectionExit("TEST", "exit-1"),
  ]);
  assert.deepEqual(
    results.map((result) => result.kind),
    ["submitted", "working"],
  );
  assert.equal(state.requests.length, 1);
});

test("working and all terminal stable IDs are returned without replacement", async () => {
  for (const status of [
    "new",
    "partially_filled",
    "pending_cancel",
    "unknown_broker_state",
    "filled",
    "canceled",
    "expired",
    "rejected",
    "replaced",
  ]) {
    const { state, executor } = mockBroker();
    state.orders.set("order-1", order({ status }));
    const result = await executor.submitProtectionExit("TEST", "exit-1");
    assert.equal(
      result.kind,
      ["filled", "canceled", "expired", "rejected", "replaced"].includes(status)
        ? "terminal"
        : "working",
    );
    assert.equal(state.requests.length, 0);
    assert.equal(state.calls.includes("orders"), false);
  }
});

test("a known terminal client ID is never resubmitted even if the broker later returns 404", async () => {
  const { state, executor } = mockBroker();
  state.orders.set("order-1", order({ status: "canceled" }));
  assert.equal(
    (await executor.submitProtectionExit("TEST", "exit-1")).kind,
    "terminal",
  );
  state.orders.clear();
  assert.equal(
    (await executor.submitProtectionExit("TEST", "exit-1")).kind,
    "terminal",
  );
  assert.equal(state.requests.length, 0);
});

test("ambiguous accepted submission is reconciled by ID, not retried", async () => {
  const { state, broker, executor } = mockBroker();
  broker.createOrder = async (request) => {
    state.requests.push(request);
    state.orders.set("order-1", order());
    throw new Error("request timed out after broker acceptance");
  };
  assert.equal(
    (await executor.submitProtectionExit("TEST", "exit-1")).kind,
    "working",
  );
  assert.equal(
    (await executor.submitProtectionExit("TEST", "exit-1")).kind,
    "working",
  );
  assert.equal(state.requests.length, 1);
});

test("unresolved submission failure is not blindly retried in the same invocation", async () => {
  const { state, broker, executor } = mockBroker();
  broker.createOrder = async (request) => {
    state.requests.push(request);
    throw new Error("ambiguous timeout");
  };
  await assert.rejects(
    executor.submitProtectionExit("TEST", "exit-1"),
    /ambiguous timeout/,
  );
  assert.equal(state.requests.length, 1);
});

test("failed client-order lookup fails closed; only HTTP 404 means missing", async () => {
  const { state, broker, executor } = mockBroker();
  broker.getOrderByClientOrderId = async () => {
    throw httpError(503);
  };
  await assert.rejects(
    executor.submitProtectionExit("TEST", "exit-1"),
    (error: unknown) => {
      assert.deepEqual(error, httpError(503));
      return true;
    },
  );
  assert.equal(state.requests.length, 0);
  assert(!state.calls.includes("orders"));
  broker.getOrderByClientOrderId = async () => undefined;
  await assert.rejects(
    executor.getProtectionOrder("exit-1"),
    /Invalid broker order/,
  );
});

test("installed SDK client-ID alias remains compatible", async () => {
  const { broker, executor } = mockBroker();
  broker.getOrderByClientId = broker.getOrderByClientOrderId;
  delete broker.getOrderByClientOrderId;
  assert.equal(await executor.getProtectionOrder("missing"), undefined);
});

test("cancellation is polled to terminal before a fresh fill-adjusted position is sold", async () => {
  const { state, broker, executor } = mockBroker();
  state.orders.set(
    "competitor",
    order({
      id: "competitor",
      client_order_id: "old-exit",
      status: "partially_filled",
    }),
  );
  broker.cancelOrder = async () => {
    state.calls.push("cancel");
  };
  let probes = 0;
  broker.getOrder = async () => {
    state.calls.push("probe");
    probes += 1;
    if (probes === 1)
      return order({ id: "competitor", status: "pending_cancel" });
    state.quantity = 2.125;
    state.available = 1.25;
    const canceled = order({
      id: "competitor",
      client_order_id: "old-exit",
      status: "canceled",
      filled_qty: "2.875",
    });
    state.orders.set("competitor", canceled);
    return canceled;
  };
  assert.equal(
    (await executor.submitProtectionExit("TEST", "exit-1", 5)).kind,
    "submitted",
  );
  assert.equal(probes, 2);
  assert.equal(state.requests[0]?.qty, 1.25);
  assert(state.calls.lastIndexOf("probe") < state.calls.indexOf("position"));
});

test("competing buy fills during cancellation reject attribution after all cancellations are confirmed", async () => {
  for (const requested of [undefined, 5]) {
    const { state, broker, executor } = mockBroker();
    state.orders.set(
      "buy",
      order({ id: "buy", client_order_id: "other-buy", side: "buy" }),
    );
    state.orders.set(
      "sell",
      order({ id: "sell", client_order_id: "other-sell" }),
    );
    const cancel = broker.cancelOrder;
    assert(cancel);
    broker.cancelOrder = async (id) => {
      await cancel(id);
      if (id === "buy") {
        state.quantity = 6;
        state.available = 6;
      }
    };
    await assert.rejects(
      executor.submitProtectionExit(
        "TEST",
        "exit-1",
        requested,
        undefined,
        EXPECTED,
      ),
      { message: "Attribution changed during cancellation" },
    );
    assert.equal(state.requests.length, 0);
    assert(state.calls.indexOf("order:buy") < state.calls.indexOf("position"));
    assert(state.calls.indexOf("order:sell") < state.calls.indexOf("position"));
    assert.equal(state.calls.filter((call) => call === "position").length, 1);
  }
});

test("basis changes during cancellation reject even unchanged or reduced broker quantity", async () => {
  for (const quantity of [5, 4]) {
    for (const entryPrice of [99.98, 100.02]) {
      const { state, broker, executor } = mockBroker();
      state.orders.set(
        "competitor",
        order({ id: "competitor", client_order_id: "old-exit" }),
      );
      const cancel = broker.cancelOrder;
      assert(cancel);
      broker.cancelOrder = async (id) => {
        await cancel(id);
        state.quantity = quantity;
        state.available = quantity;
        state.entryPrice = entryPrice;
      };
      await assert.rejects(
        executor.submitProtectionExit(
          "TEST",
          "exit-1",
          undefined,
          undefined,
          EXPECTED,
        ),
        { message: "Attribution changed during cancellation" },
      );
      assert.equal(state.requests.length, 0);
    }
  }
});

test("legitimate existing-exit partial fills reduce expected exposure without rejecting or rounding up", async () => {
  for (const requested of [undefined, 5]) {
    const { state, broker, executor } = mockBroker();
    state.orders.set(
      "competitor",
      order({ id: "competitor", client_order_id: "old-exit" }),
    );
    broker.cancelOrder = async () => {
      state.quantity = 2.125;
      state.available = 1.1234567899;
      state.orders.set(
        "competitor",
        order({
          id: "competitor",
          client_order_id: "old-exit",
          status: "canceled",
          filled_qty: "2.875",
        }),
      );
    };
    const result = await executor.submitProtectionExit(
      "TEST",
      "exit-1",
      requested,
      undefined,
      EXPECTED,
    );
    assert.equal(result.kind, "submitted");
    assert.equal(state.requests[0]?.qty, 1.123456789);
    assert.equal(state.calls.filter((call) => call === "position").length, 2);
  }
});

test("expected exposure uses quantity and absolute-or-relative basis tolerances with an explicit ledger cap", async () => {
  for (const [entryPrice, basisChange, allowed] of [
    [100, 0.009, true],
    [100, 0.011, false],
    [100_000, 0.09, true],
    [100_000, 0.11, false],
  ] as const) {
    const { state, executor } = mockBroker();
    state.quantity = 5 + 5e-10;
    state.available = state.quantity;
    state.entryPrice = entryPrice + basisChange;
    const submission = executor.submitProtectionExit(
      "TEST",
      "exit-1",
      5,
      undefined,
      { quantity: 5, entryPrice },
    );
    if (allowed) {
      assert.equal((await submission).kind, "submitted");
      assert.equal(state.requests[0]?.qty, 5);
    } else {
      await assert.rejects(submission, {
        message: "Attribution changed during cancellation",
      });
      assert.equal(state.requests.length, 0);
    }
  }
  const { state, executor } = mockBroker();
  state.quantity = 5 + 2e-9;
  state.available = state.quantity;
  await assert.rejects(
    executor.submitProtectionExit("TEST", "exit-1", 5, undefined, EXPECTED),
    { message: "Attribution changed during cancellation" },
  );
  assert.equal(state.requests.length, 0);
});

test("final expected guard blocks quantity or basis changes during session, price and stable-ID HTTP lookups", async () => {
  for (const phase of ["session", "price", "id"] as const) {
    for (const change of ["quantity", "basis"] as const) {
      const { state, broker, executor } = mockBroker();
      state.clockTimestamp = "2026-11-03T21:30:00Z";
      state.isOpen = false;
      state.latestTrade.Timestamp = state.clockTimestamp;
      const options = { ...OPTIONS, now: new Date(state.clockTimestamp) };
      const mutate = () => {
        if (change === "quantity") {
          state.quantity = 6;
          state.available = 6;
        } else {
          state.entryPrice = 101;
        }
      };
      if (phase === "session") {
        const clock = broker.getClock;
        assert(clock);
        let calls = 0;
        broker.getClock = async () => {
          if (++calls === 2) mutate();
          return clock();
        };
      } else if (phase === "price") {
        const price = broker.getLatestTrade;
        assert(price);
        broker.getLatestTrade = async (symbol) => {
          mutate();
          return price(symbol);
        };
      } else {
        const lookup = broker.getOrderByClientOrderId;
        assert(lookup);
        let calls = 0;
        broker.getOrderByClientOrderId = async (id) => {
          if (++calls === 2) mutate();
          return lookup(id);
        };
      }
      await assert.rejects(
        executor.submitProtectionExit("TEST", "exit-1", 5, options, EXPECTED),
        { message: "Attribution changed during cancellation" },
      );
      assert.equal(state.requests.length, 0);
      assert.equal(state.calls.filter((call) => call === "position").length, 2);
      assert.deepEqual(state.calls.slice(-2), ["lookup:exit-1", "position"]);
      assert(
        state.calls.indexOf("trade") < state.calls.lastIndexOf("position"),
      );
    }
  }
});

test("final position refresh only clamps sells down as quantity or available shares change", async () => {
  for (const [
    initialQuantity,
    initialAvailable,
    finalQuantity,
    finalAvailable,
    requested,
    sold,
  ] of [
    [5, 5, 3, 3, undefined, 3],
    [5, 5, 5, 1.1234567899, undefined, 1.123456789],
    [5, 1.25, 5, 5, undefined, 1.25],
    [3, 3, 4, 4, undefined, 3],
    [5, 5, 4, 4, 2, 2],
  ] as const) {
    for (const expected of [undefined, EXPECTED]) {
      const { state, broker, executor } = mockBroker();
      state.quantity = initialQuantity;
      state.available = initialAvailable;
      const lookup = broker.getOrderByClientOrderId;
      assert(lookup);
      let calls = 0;
      broker.getOrderByClientOrderId = async (id) => {
        if (++calls === 2) {
          state.quantity = finalQuantity;
          state.available = finalAvailable;
        }
        return lookup(id);
      };
      const result = await executor.submitProtectionExit(
        "TEST",
        "exit-1",
        requested,
        undefined,
        expected,
      );
      assert.equal(result.kind, "submitted");
      assert.equal(state.requests[0]?.qty, sold);
      assert.deepEqual(state.calls.slice(-3), [
        "lookup:exit-1",
        "position",
        "create",
      ]);
    }
  }
});

test("final position closure or exhausted availability never submits an order", async () => {
  for (const [quantity, available, kind] of [
    [0, 0, "closed"],
    [5, 0, "deferred"],
    [5, 0.0000000009, "deferred"],
  ] as const) {
    const { state, broker, executor } = mockBroker();
    const lookup = broker.getOrderByClientOrderId;
    assert(lookup);
    let calls = 0;
    broker.getOrderByClientOrderId = async (id) => {
      if (++calls === 2) {
        state.quantity = quantity;
        state.available = available;
      }
      return lookup(id);
    };
    const result = await executor.submitProtectionExit(
      "TEST",
      "exit-1",
      5,
      undefined,
      EXPECTED,
    );
    assert.equal(result.kind, kind);
    assert.equal(state.requests.length, 0);
  }
});

test("final position refresh errors fail closed without falling back to the earlier snapshot", async () => {
  const { state, broker, executor } = mockBroker();
  const position = broker.getPosition;
  let calls = 0;
  broker.getPosition = async (symbol) => {
    if (++calls === 2) throw httpError(503);
    return position(symbol);
  };
  await assert.rejects(
    executor.submitProtectionExit("TEST", "exit-1", 5, undefined, EXPECTED),
    (error: unknown) => {
      assert.deepEqual(error, httpError(503));
      return true;
    },
  );
  assert.equal(state.requests.length, 0);
});

test("panic guard activated during the final position refresh still prevents submission", async () => {
  const { state, broker, executor } = mockBroker();
  let allowed = true;
  executor.setSubmissionGuard(() => allowed);
  const position = broker.getPosition;
  let calls = 0;
  broker.getPosition = async (symbol) => {
    if (++calls === 2) allowed = false;
    return position(symbol);
  };
  const result = await executor.submitProtectionExit(
    "TEST",
    "exit-1",
    5,
    undefined,
    EXPECTED,
  );
  assert.equal(result.kind, "deferred");
  assert.equal(state.requests.length, 0);
  assert.equal(calls, 2);
});

test("invalid expected exposure fails before broker lookups or cancellations", async () => {
  for (const expected of [
    { quantity: NaN, entryPrice: 100 },
    { quantity: Infinity, entryPrice: 100 },
    { quantity: -1, entryPrice: 100 },
    { quantity: 5, entryPrice: NaN },
    { quantity: 5, entryPrice: Infinity },
    { quantity: 5, entryPrice: 0 },
    { quantity: 5, entryPrice: -100 },
  ]) {
    const { state, executor } = mockBroker();
    await assert.rejects(
      executor.submitProtectionExit(
        "TEST",
        "exit-1",
        undefined,
        undefined,
        expected,
      ),
      /Invalid expected protection exposure/,
    );
    assert.deepEqual(state.calls, []);
    assert.equal(state.requests.length, 0);
  }
});

test("cancel rejection caused by a winning full fill reconciles closure", async () => {
  const { state, broker, executor } = mockBroker();
  state.orders.set(
    "competitor",
    order({ id: "competitor", client_order_id: "old-exit" }),
  );
  broker.cancelOrder = async () => {
    state.quantity = 0;
    state.orders.set(
      "competitor",
      order({
        id: "competitor",
        client_order_id: "old-exit",
        status: "filled",
        filled_qty: "5",
      }),
    );
    throw httpError(422);
  };
  assert.deepEqual(await executor.submitProtectionExit("TEST", "exit-1"), {
    kind: "closed",
  });
  assert.equal(state.requests.length, 0);
});

test("failed cancellation lookup cannot be mistaken for released shares", async () => {
  const { state, broker, executor } = mockBroker();
  state.orders.set(
    "competitor",
    order({ id: "competitor", client_order_id: "old-exit" }),
  );
  broker.getOrder = async () => {
    throw httpError(404);
  };
  await assert.rejects(executor.submitProtectionExit("TEST", "exit-1"));
  assert.equal(state.requests.length, 0);
  assert(!state.calls.includes("position"));
});

test("an unconfirmed cancellation stays fail-closed after bounded polling", async () => {
  const { state, broker, executor } = mockBroker();
  let probes = 0;
  broker.cancelOrder = async () => {};
  broker.getOrder = async () => {
    probes += 1;
    return order({ status: "pending_cancel" });
  };
  await assert.rejects(
    executor.cancelProtectionOrder("order-1"),
    /Cancellation not confirmed/,
  );
  assert.equal(probes, 20);
  assert.equal(state.requests.length, 0);
});

test("snapshot distinguishes missing positions from broker errors and never uses minute bars", async () => {
  const { state, broker, executor } = mockBroker();
  const snapshot = await executor.getProtectionSnapshot("TEST");
  assert.deepEqual(snapshot.position, {
    qty: 5,
    availableQuantity: 5,
    entryPrice: 100,
  });
  assert.deepEqual(snapshot.price, {
    price: 105,
    timestamp: NOW.toISOString(),
  });
  assert(!state.calls.includes("bars"));
  state.quantity = 0;
  assert.equal(
    (await executor.getProtectionSnapshot("TEST")).position,
    undefined,
  );
  broker.getPosition = async () => {
    throw httpError(500);
  };
  await assert.rejects(executor.getProtectionSnapshot("TEST"));
  assert.equal(state.requests.length, 0);
});

test("order-list errors including 404 are not treated as closed or empty", async () => {
  for (const status of [404, 503]) {
    const { state, broker, executor } = mockBroker();
    broker.getOrders = async () => {
      throw httpError(status);
    };
    await assert.rejects(executor.getProtectionSnapshot("TEST"));
    await assert.rejects(executor.submitProtectionExit("TEST", "exit-1"));
    await assert.rejects(executor.closePosition("TEST"));
    assert.equal(state.requests.length, 0);
  }
});

test("missing position is closed but other position errors propagate", async () => {
  const { state, broker, executor } = mockBroker();
  state.quantity = 0;
  assert.deepEqual(await executor.submitProtectionExit("TEST", "exit-1"), {
    kind: "closed",
  });
  broker.getPosition = async () => {
    throw httpError(403);
  };
  await assert.rejects(executor.submitProtectionExit("TEST", "exit-1"));
  assert.equal(state.requests.length, 0);
});

test("extended session uses caller-approved fresh latest trade, Day limit and extended_hours", async () => {
  const { state, executor } = mockBroker();
  state.clockTimestamp = "2026-11-03T21:30:00Z";
  state.isOpen = false;
  state.latestTrade.Timestamp = "2026-11-03T21:29:59Z";
  const options = { ...OPTIONS, now: new Date("2026-11-03T21:30:00Z") };
  assert.equal(
    (await executor.submitProtectionExit("TEST", "exit-1", 2.5, options)).kind,
    "submitted",
  );
  assert.deepEqual(state.requests, [
    {
      symbol: "TEST",
      qty: 2.5,
      side: "sell",
      type: "limit",
      time_in_force: "day",
      client_order_id: "exit-1",
      limit_price: 103.95,
      extended_hours: true,
    },
  ]);
  assert(!state.calls.includes("bars"));
});

test("extended session without approved options defers without canceling other orders", async () => {
  const { state, executor } = mockBroker();
  state.clockTimestamp = "2026-11-03T21:30:00Z";
  state.isOpen = false;
  state.orders.set(
    "competitor",
    order({ id: "competitor", client_order_id: "other" }),
  );
  assert.equal(
    (await executor.submitProtectionExit("TEST", "exit-1")).kind,
    "deferred",
  );
  assert(!state.calls.some((call) => call.startsWith("cancel:")));
  assert.equal(state.requests.length, 0);
});

test("stale, future, malformed, and absent latest trades never submit extended exits", async () => {
  for (const timestamp of [
    "2026-11-03T21:29:54Z",
    "2026-11-03T21:30:01Z",
    "invalid",
  ]) {
    const { state, executor } = mockBroker();
    state.clockTimestamp = "2026-11-03T21:30:00Z";
    state.isOpen = false;
    state.latestTrade.Timestamp = timestamp;
    assert.equal(
      (
        await executor.submitProtectionExit("TEST", "exit-1", undefined, {
          ...OPTIONS,
          now: new Date("2026-11-03T21:30:00Z"),
        })
      ).kind,
      "deferred",
    );
    assert.equal(state.requests.length, 0);
    assert(!state.calls.includes("bars"));
  }
  const { state, broker, executor } = mockBroker();
  state.isOpen = false;
  state.clockTimestamp = "2026-11-03T21:30:00Z";
  delete broker.getLatestTrade;
  assert.equal(
    (await executor.submitProtectionExit("TEST", "exit-1", undefined, OPTIONS))
      .kind,
    "deferred",
  );
  assert.equal(state.requests.length, 0);
});

test("trade at exact maximum permitted age is accepted", async () => {
  const { state, executor } = mockBroker();
  state.isOpen = false;
  state.clockTimestamp = "2026-11-03T21:30:00Z";
  state.latestTrade.Timestamp = "2026-11-03T21:29:55Z";
  assert.equal(
    (
      await executor.submitProtectionExit("TEST", "exit-1", undefined, {
        ...OPTIONS,
        now: new Date("2026-11-03T21:30:00Z"),
      })
    ).kind,
    "submitted",
  );
});

test("calendar holidays, weekends, closed regular session, and overnight defer", async () => {
  for (const [timestamp, calendar, isOpen] of [
    ["2026-11-07T16:00:00Z", [], true],
    ["2026-11-26T16:00:00Z", [], false],
    [
      "2026-11-03T08:00:00Z",
      [{ date: "2026-11-03", open: "09:30", close: "16:00" }],
      false,
    ],
    [
      NOW.toISOString(),
      [{ date: "2026-11-03", open: "09:30", close: "16:00" }],
      false,
    ],
  ] as const) {
    const { state, executor } = mockBroker();
    state.clockTimestamp = timestamp;
    state.calendar = [...calendar];
    state.isOpen = isOpen;
    assert.equal(
      (
        await executor.submitProtectionExit(
          "TEST",
          "exit-1",
          undefined,
          OPTIONS,
        )
      ).kind,
      "deferred",
    );
    assert.equal(state.requests.length, 0);
  }
});

test("early close and premarket are classified using the broker calendar and clock", async () => {
  for (const timestamp of ["2026-11-03T19:00:00Z", "2026-11-03T12:00:00Z"]) {
    const { state, executor } = mockBroker();
    state.clockTimestamp = timestamp;
    state.isOpen = false;
    state.calendar[0] = { date: "2026-11-03", open: "09:30", close: "13:00" };
    state.latestTrade.Timestamp = timestamp;
    assert.equal(
      (
        await executor.submitProtectionExit("TEST", "exit-1", undefined, {
          ...OPTIONS,
          now: new Date(timestamp),
        })
      ).kind,
      "submitted",
    );
    assert.equal(state.requests[0]?.type, "limit");
  }
});

test("half exits floor whole odd lots, preserve fractional halves, and reject indivisible shares", async () => {
  const { state, executor } = mockBroker();
  state.fractionable = false;
  assert.equal(await executor.getHalfExitQuantity("TEST", 5), 2);
  await assert.rejects(
    executor.getHalfExitQuantity("TEST", 1),
    /two supported nonzero halves/,
  );
  await assert.rejects(
    executor.getHalfExitQuantity("TEST", 5.5),
    /two supported nonzero halves/,
  );
  state.fractionable = true;
  assert.equal(await executor.getHalfExitQuantity("TEST", 5), 2.5);
  assert.equal(
    await executor.getHalfExitQuantity("TEST", 0.1234567899),
    0.061728394,
  );
  await assert.rejects(
    executor.getHalfExitQuantity("TEST", 0.000000001),
    /two supported nonzero halves/,
  );
  assert.equal(state.requests.length, 0);
});

test("fractional native trailing stop is rejected before any order or bar request", async () => {
  const { state, executor } = mockBroker();
  state.quantity = 2.5;
  await assert.rejects(
    executor.placeBreakEvenTrailingStop("TEST", 100),
    /cannot use a native trailing_stop/,
  );
  assert.equal(state.requests.length, 0);
  assert(!state.calls.includes("bars"));
});

test("invalid quantity, asset metadata, options, short position and mismatched orders fail safely", async () => {
  for (const qty of [NaN, Infinity, -1, 0]) {
    const { state, executor } = mockBroker();
    await assert.rejects(
      executor.submitProtectionExit("TEST", "exit-1", qty),
      /Invalid protection sell quantity/,
    );
    await assert.rejects(
      executor.getHalfExitQuantity("TEST", qty),
      /Invalid half-exit quantity/,
    );
    assert.equal(state.requests.length, 0);
  }
  const { state, broker, executor } = mockBroker();
  broker.getAsset = async () => ({});
  await assert.rejects(
    executor.getHalfExitQuantity("TEST", 5),
    /Unknown fractionability/,
  );
  await assert.rejects(
    executor.submitProtectionExit("TEST", "exit-1", undefined, {
      ...OPTIONS,
      extendedLimitOffset: 1,
    }),
    /finite discount/,
  );
  await assert.rejects(
    executor.submitProtectionExit("TEST", "exit-1", undefined, {
      ...OPTIONS,
      maxPriceAgeMs: NaN,
    }),
    /Invalid maximum price age/,
  );
  broker.getPosition = async () => ({
    qty: "-5",
    qty_available: "5",
    avg_entry_price: "100",
    side: "short",
  });
  await assert.rejects(
    executor.submitProtectionExit("TEST", "exit-1"),
    /long positions only/,
  );
  state.orders.set("order-1", order({ side: "buy" }));
  await assert.rejects(
    executor.submitProtectionExit("TEST", "exit-1"),
    /does not match a long exit/,
  );
  assert.equal(state.requests.length, 0);
  assert.throws(
    () => toProtectionBrokerOrder({ id: "bad" }),
    /missing symbol or status/,
  );
  assert.throws(
    () => toProtectionBrokerOrder({ ...order(), qty: NaN }),
    /Invalid broker order qty/,
  );
});

test("legacy close and protection share the same symbol lock and confirm cancellation", async () => {
  const { state, broker, executor } = mockBroker();
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const originalGetOrders = broker.getOrders;
  assert(originalGetOrders);
  let listingCalls = 0;
  broker.getOrders = async (query) => {
    listingCalls += 1;
    if (listingCalls === 1) {
      entered();
      await gate;
    }
    return originalGetOrders(query);
  };
  const protection = executor.submitProtectionExit("TEST", "exit-1", 2);
  await enteredPromise;
  const legacy = executor.closePosition("TEST", 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(listingCalls, 1);
  release();
  await Promise.all([protection, legacy]);
  assert.equal(listingCalls, 2);
  assert.equal(state.requests.length, 2);
  assert.equal(state.requests[0]?.client_order_id, "exit-1");
  const cancel = state.calls.indexOf("cancel:submitted-1");
  const terminalProbe = state.calls.indexOf("order:submitted-1");
  const lastPosition = state.calls.lastIndexOf("position");
  assert(cancel >= 0 && terminalProbe > cancel && lastPosition > terminalProbe);
  assert.equal(state.requests[1]?.type, "limit");
  assert.equal(state.requests[1]?.limit_price, 102.9);
});

test("session eligibility is rechecked after cancellation crosses the market close", async () => {
  const { state, broker, executor } = mockBroker();
  state.orders.set(
    "competitor",
    order({ id: "competitor", client_order_id: "old-exit" }),
  );
  broker.cancelOrder = async () => {
    state.clockTimestamp = "2026-11-03T21:30:00Z";
    state.isOpen = false;
    state.orders.set(
      "competitor",
      order({
        id: "competitor",
        client_order_id: "old-exit",
        status: "canceled",
      }),
    );
  };
  assert.equal(
    (await executor.submitProtectionExit("TEST", "exit-1")).kind,
    "deferred",
  );
  assert.equal(state.requests.length, 0);
});

test("missing broker available quantity is not invented from the position quantity", async () => {
  const { state, broker, executor } = mockBroker();
  broker.getPosition = async () => ({
    qty: "5",
    avg_entry_price: "100",
    side: "long",
  });
  await assert.rejects(
    executor.submitProtectionExit("TEST", "exit-1"),
    /available position quantity/,
  );
  assert.equal(state.requests.length, 0);
});

test("panic guard activated during HTTP reconciliation prevents a protective order", async () => {
  const { state, broker, executor } = mockBroker();
  let allowed = true;
  executor.setSubmissionGuard(() => allowed);
  const lookup = broker.getOrderByClientOrderId;
  assert(lookup);
  let lookups = 0;
  broker.getOrderByClientOrderId = async (id) => {
    lookups += 1;
    if (lookups === 2) allowed = false;
    return lookup(id);
  };
  const result = await executor.submitProtectionExit("TEST", "exit-1");
  assert.equal(result.kind, "deferred");
  assert.equal(state.requests.length, 0);
});

test("panic guard activated during legacy price lookup prevents a legacy sell", async () => {
  const { state, broker, executor } = mockBroker();
  let allowed = true;
  executor.setSubmissionGuard(() => allowed);
  broker.getLatestBars = async () => {
    allowed = false;
    return new Map([["TEST", { ClosePrice: 105 }]]);
  };
  await assert.rejects(
    executor.closePosition("TEST"),
    /disabled by broker safety guard/,
  );
  assert.equal(state.requests.length, 0);
});

test("symbol locks are released after errors and do not block unrelated symbols", async () => {
  const { state, broker, executor } = mockBroker();
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const lookup = broker.getOrderByClientOrderId;
  assert(lookup);
  broker.getOrderByClientOrderId = async (id) => {
    if (id === "held") {
      entered();
      await gate;
      throw new Error("failed lookup");
    }
    return lookup(id);
  };
  const held = executor.submitProtectionExit("TEST", "held");
  const rejected = assert.rejects(held, /failed lookup/);
  await started;
  assert.equal(
    (await executor.submitProtectionExit("OTHER", "other-id")).kind,
    "submitted",
  );
  release();
  await rejected;
  assert.equal(
    (await executor.submitProtectionExit("TEST", "exit-1")).kind,
    "submitted",
  );
  assert.equal(state.requests.length, 2);
});

test("native order ID lookup returns filled orders, only 404 is missing, and IDs are verified", async () => {
  const { state, broker, executor } = mockBroker();
  state.orders.set(
    "native-1",
    order({
      id: "native-1",
      type: "trailing_stop",
      status: "filled",
      filled_qty: "5",
      filled_avg_price: "107",
    }),
  );
  const filled = await executor.getProtectionOrderById("native-1");
  assert.equal(filled?.filled_qty, "5");
  assert.equal(filled?.filled_avg_price, "107");
  assert.equal(await executor.getProtectionOrderById("missing"), undefined);
  broker.getOrder = async () => {
    throw httpError(503);
  };
  await assert.rejects(executor.getProtectionOrderById("native-1"));
  broker.getOrder = async () => order({ id: "different" });
  await assert.rejects(
    executor.getProtectionOrderById("native-1"),
    /different order identifier/,
  );
  assert.equal(state.requests.length, 0);
});

test("snapshot closure needs no price lookup and an open-position pricing failure is explicit missing price", async () => {
  const { state, broker, executor } = mockBroker();
  let pricesRequested = 0;
  broker.getLatestTrade = async () => {
    pricesRequested += 1;
    throw httpError(503);
  };
  state.quantity = 0;
  assert.deepEqual(await executor.getProtectionSnapshot("TEST"), {
    position: undefined,
    orders: [],
    price: undefined,
  });
  assert.equal(pricesRequested, 0);
  state.quantity = 5;
  const snapshot = await executor.getProtectionSnapshot("TEST");
  assert.equal(snapshot.position?.qty, 5);
  assert.equal(snapshot.price, undefined);
  assert.equal(pricesRequested, 1);
  assert.equal(state.requests.length, 0);
});

async function run(): Promise<void> {
  for (const [name, verify] of tests) {
    await verify();
    console.log(`PASS: ${name}`);
  }
  console.log(
    `Protection executor verification passed (${tests.length} mocked scenarios; no broker connectivity).`,
  );
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : "Unknown error"}\n`,
  );
  process.exitCode = 1;
});
