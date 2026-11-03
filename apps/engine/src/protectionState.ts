import type { RemainderProtection, TradeExitReason } from "@my-platform/types";

export function createHalfProtection(
  entryPrice: number,
  targetQuantity: number,
  clientOrderId: string,
  now: string,
): RemainderProtection {
  if (!isPositiveFinite(entryPrice) || !isPositiveFinite(targetQuantity)) {
    throw new Error(
      "Protection requires positive finite entry and target quantity",
    );
  }
  if (!clientOrderId || !isTimestamp(now)) {
    throw new Error(
      "Protection requires a client order identifier and valid timestamp",
    );
  }
  return {
    version: 1,
    phase: "half-exit-working",
    revision: 1,
    entryPrice,
    trailingDistance: null,
    // Entry is the known floor, not a reconstructed historical high.
    highWaterMark: entryPrice,
    effectiveStop: entryPrice,
    halfExit: {
      clientOrderId,
      targetQuantity,
      filledQuantity: 0,
      completed: false,
    },
  };
}

/**
 * Accept an ordered, valid tick without performing broker work or inventing an
 * exit identifier. Call isProtectionBreached on the returned state and latch
 * with a stable client identifier before starting asynchronous work.
 */
export function advanceProtection(
  state: RemainderProtection,
  price: number,
  timestamp: string,
): RemainderProtection {
  const next = structuredClone(state);
  if (
    state.phase === "closed" ||
    !isPositiveFinite(price) ||
    !isTimestamp(timestamp) ||
    (state.lastPriceAt !== undefined &&
      Date.parse(timestamp) < Date.parse(state.lastPriceAt))
  ) {
    return next;
  }

  next.lastPriceAt = timestamp;
  // Do not let pre-half ticks set the high used to calibrate a new trail.
  if (state.halfExit.completed) {
    if (state.trailingDistance === null && !state.calibrationRequired) {
      if (price > state.entryPrice) {
        next.trailingDistance = price - state.entryPrice;
        next.highWaterMark = Math.max(state.highWaterMark, price);
        next.activatedAt = timestamp;
        next.activationSource = "trade";
        next.phase = state.exit
          ? state.exit.status === "working"
            ? "remainder-exit-working"
            : "remainder-exit-pending"
          : "protected-remainder";
      } else {
        next.phase = state.exit
          ? state.exit.status === "working"
            ? "remainder-exit-working"
            : "remainder-exit-pending"
          : "recovery-required";
      }
    } else if (state.trailingDistance !== null) {
      next.highWaterMark = Math.max(state.highWaterMark, price);
    }
    // Only a completed historical half flagged calibrationRequired needs explicit
    // calibration; a restart quote cannot reconstruct its historical trail.
    next.effectiveStop = Math.max(
      state.effectiveStop,
      state.entryPrice,
      next.trailingDistance === null
        ? state.entryPrice
        : next.highWaterMark - next.trailingDistance,
    );
  }
  // lastPriceAt still advances for in-memory ordering/freshness, but unchanged
  // risk need not create a durable revision or a disk write on every tick.
  if (
    JSON.stringify({ ...next, lastPriceAt: undefined }) !==
    JSON.stringify({ ...state, lastPriceAt: undefined })
  ) {
    next.revision = state.revision + 1;
  }
  return next;
}

/** Equality is deliberately NOT a breach. Invalid prices cannot trigger exits. */
export function isProtectionBreached(
  state: RemainderProtection,
  price: number,
): boolean {
  return (
    state.phase !== "closed" &&
    state.halfExit.completed &&
    isPositiveFinite(price) &&
    price < Math.max(state.entryPrice, state.effectiveStop)
  );
}

export function latchProtectionExit(
  state: RemainderProtection,
  clientOrderId: string,
  reason: TradeExitReason,
  now: string,
): RemainderProtection {
  if (!clientOrderId || !isTimestamp(now)) {
    throw new Error(
      "Exit intent requires a client order identifier and valid timestamp",
    );
  }
  const next = structuredClone(state);
  if (state.exit || state.phase === "closed") return next;
  next.phase = "remainder-exit-pending";
  next.exit = {
    clientOrderId,
    reason,
    attempt: 0,
    status: "pending",
    replacements: 0,
  };
  // submittedAt is set only after submission, not when the intent is latched.
  next.revision = state.revision + 1;
  return next;
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}
