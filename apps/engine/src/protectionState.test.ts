import assert from "node:assert/strict";

import type { RemainderProtection } from "@my-platform/types";

import {
  advanceProtection,
  createHalfProtection,
  isProtectionBreached,
  latchProtectionExit,
} from "./protectionState.js";

const time = (seconds: number) =>
  new Date(Date.UTC(2026, 10, 3, 15, 0, seconds)).toISOString();

function completed(entryPrice = 341.97): RemainderProtection {
  const state = createHalfProtection(entryPrice, 5, "half-stable", time(0));
  return {
    ...state,
    halfExit: { ...state.halfExit, filledQuantity: 5, completed: true },
  };
}

function near(actual: number, expected: number): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${actual} differs from ${expected}`,
  );
}

function run(): void {
  const pending = createHalfProtection(341.97, 5, "half-stable", time(0));
  assert.equal(pending.phase, "half-exit-working");
  assert.equal(pending.trailingDistance, null);
  assert.equal(pending.effectiveStop, 341.97);
  const preHalf = advanceProtection(pending, 400, time(1));
  assert.equal(preHalf.highWaterMark, 341.97);
  assert.equal(preHalf.trailingDistance, null);
  assert.equal(isProtectionBreached(pending, 300), false);

  const original = completed();
  const active = advanceProtection(original, 349.8, time(2));
  assert.equal(active.phase, "protected-remainder");
  assert.equal(active.activatedAt, time(2));
  assert.equal(active.activationSource, "trade");
  near(active.trailingDistance ?? 0, 7.83);
  near(active.effectiveStop, 341.97);
  assert.equal(original.trailingDistance, null);
  assert.notEqual(active.halfExit, original.halfExit);

  const raised = advanceProtection(active, 355, time(3));
  near(raised.highWaterMark, 355);
  near(raised.effectiveStop, 347.17);
  assert.equal(raised.trailingDistance, active.trailingDistance);
  const dip = advanceProtection(raised, 350, time(4));
  assert.equal(dip.highWaterMark, raised.highWaterMark);
  assert.equal(dip.effectiveStop, raised.effectiveStop);
  assert.equal(dip.revision, raised.revision);
  assert.equal(dip.lastPriceAt, time(4));
  assert.equal(isProtectionBreached(dip, dip.effectiveStop), false);
  assert.equal(isProtectionBreached(dip, dip.effectiveStop - 0.01), true);

  const sameTimeHigh = advanceProtection(dip, 360, time(4));
  assert.equal(sameTimeHigh.highWaterMark, 360);
  assert.ok(sameTimeHigh.effectiveStop > dip.effectiveStop);
  const sameTimeLow = advanceProtection(sameTimeHigh, 350, time(4));
  assert.deepEqual(sameTimeLow, sameTimeHigh);
  assert.notEqual(sameTimeLow, sameTimeHigh);
  assert.notEqual(sameTimeLow.halfExit, sameTimeHigh.halfExit);
  assert.equal(sameTimeLow.revision, sameTimeHigh.revision);
  assert.equal(isProtectionBreached(sameTimeLow, 350), true);
  const sameTimeLatched = latchProtectionExit(
    sameTimeLow,
    "same-ms-exit",
    "TRAILING_STOP_LOSS",
    time(4),
  );
  assert.equal(sameTimeLatched.exit?.clientOrderId, "same-ms-exit");
  assert.deepEqual(advanceProtection(dip, 350, time(4)), dip);

  const breached = advanceProtection(dip, 347, time(5));
  const latched = latchProtectionExit(
    breached,
    "exit-stable",
    "TRAILING_STOP_LOSS",
    time(5),
  );
  assert.equal(latched.phase, "remainder-exit-pending");
  assert.equal(latched.exit?.status, "pending");
  assert.equal(latched.exit?.submittedAt, undefined);
  const recovered = advanceProtection(latched, 356, time(6));
  assert.equal(recovered.exit?.clientOrderId, "exit-stable");
  assert.equal(recovered.phase, "remainder-exit-pending");
  assert.equal(recovered.halfExit.completed, true);
  const duplicate = latchProtectionExit(
    recovered,
    "another-id",
    "ENTRY_PRICE_BACKSTOP",
    time(7),
  );
  assert.deepEqual(duplicate, recovered);
  assert.notEqual(duplicate.exit, recovered.exit);

  const belowEntry = advanceProtection(completed(), 341, time(1));
  assert.equal(belowEntry.phase, "recovery-required");
  assert.equal(belowEntry.trailingDistance, null);
  assert.equal(isProtectionBreached(belowEntry, 341), true);
  const atEntry = advanceProtection(completed(), 341.97, time(1));
  assert.equal(atEntry.trailingDistance, null);
  assert.equal(atEntry.phase, "recovery-required");
  assert.equal(isProtectionBreached(atEntry, 341.97), false);
  assert.equal(atEntry.activatedAt, undefined);
  assert.equal(atEntry.activationSource, undefined);
  const delayedActivation = advanceProtection(atEntry, 349.8, time(2));
  assert.equal(delayedActivation.phase, "protected-remainder");
  near(delayedActivation.trailingDistance ?? 0, 7.83);
  assert.equal(delayedActivation.activatedAt, time(2));
  assert.equal(delayedActivation.activationSource, "trade");
  assert.equal(delayedActivation.halfExit.completed, true);
  // Recovery can occur before any quote is available, not just after equality.
  const noQuoteRecovery = advanceProtection(
    { ...completed(), phase: "recovery-required", calibrationRequired: false },
    349.8,
    time(2),
  );
  assert.equal(noQuoteRecovery.phase, "protected-remainder");
  near(noQuoteRecovery.trailingDistance ?? 0, 7.83);
  assert.deepEqual(advanceProtection(atEntry, 349.8, time(0)), atEntry);
  for (const status of ["pending", "working", "unknown"] as const) {
    const floorExit = latchProtectionExit(
      belowEntry,
      `floor-exit-${status}`,
      "ENTRY_PRICE_BACKSTOP",
      time(1),
    );
    floorExit.exit!.status = status;
    floorExit.phase =
      status === "working"
        ? "remainder-exit-working"
        : "remainder-exit-pending";
    const stillAtFloor = advanceProtection(floorExit, 341.97, time(2));
    assert.equal(stillAtFloor.phase, floorExit.phase);
    assert.equal(stillAtFloor.trailingDistance, null);
    assert.equal(stillAtFloor.activatedAt, undefined);
    assert.deepEqual(stillAtFloor.exit, floorExit.exit);
    const activatedExit = advanceProtection(stillAtFloor, 349.8, time(3));
    near(activatedExit.trailingDistance ?? 0, 7.83);
    assert.equal(activatedExit.phase, floorExit.phase);
    assert.deepEqual(activatedExit.exit, floorExit.exit);
    assert.equal(activatedExit.halfExit.completed, true);
    assert.equal(activatedExit.activatedAt, time(3));
  }

  const legacy: RemainderProtection = {
    ...completed(),
    phase: "recovery-required",
    calibrationRequired: true,
    lastError: "An unrelated API error has overwritten the diagnostic",
  };
  const uncalibrated = advanceProtection(legacy, 355, time(1));
  assert.equal(uncalibrated.trailingDistance, null);
  assert.equal(uncalibrated.highWaterMark, legacy.highWaterMark);
  assert.equal(uncalibrated.calibrationRequired, true);
  assert.equal(uncalibrated.effectiveStop, legacy.entryPrice);
  assert.equal(isProtectionBreached(uncalibrated, 340), true);
  const legacyWrongPhase = advanceProtection(
    { ...legacy, phase: "half-exit-working" },
    355,
    time(2),
  );
  assert.equal(legacyWrongPhase.trailingDistance, null);

  for (const [price, timestamp] of [
    [NaN, time(10)],
    [Infinity, time(10)],
    [0, time(10)],
    [-1, time(10)],
    [360, "not-a-date"],
    [360, time(2)],
    [340, time(4)],
  ] as const) {
    assert.deepEqual(advanceProtection(dip, price, timestamp), dip);
  }
  assert.equal(isProtectionBreached(dip, NaN), false);
  assert.equal(isProtectionBreached(dip, 0), false);
  const closed = { ...recovered, phase: "closed" as const };
  assert.deepEqual(advanceProtection(closed, 400, time(10)), closed);
  assert.equal(isProtectionBreached(closed, 1), false);
  assert.deepEqual(
    latchProtectionExit(closed, "new", "EXIT", time(10)),
    closed,
  );

  for (const invalid of [0, -1, NaN, Infinity]) {
    assert.throws(() => createHalfProtection(invalid, 5, "half", time(0)));
    assert.throws(() => createHalfProtection(10, invalid, "half", time(0)));
  }
  assert.throws(() => createHalfProtection(10, 5, "", time(0)));
  assert.throws(() => createHalfProtection(10, 5, "half", "invalid"));
  assert.throws(() => latchProtectionExit(active, "", "EXIT", time(0)));
  assert.throws(() => latchProtectionExit(active, "exit", "EXIT", "invalid"));
  console.log(
    "Protection-state helper verification passed (activation, strict equality, raise/dip, latch/recovery, legacy calibration, invalid/out-of-order ticks).",
  );
}

run();
