# Persistent trailing-stop and entry-price backstop plan

**Status:** Design only. Implementation is not authorized by this document.

**Requested scope:** Write and push this plan on `feat/persistent-trailing-stop-plan`. Do not change application code, dependencies, deployment, or broker orders. Do not merge into `main`.

**Design baseline:** `04d29bcd76c36b1bf5ebf09d1f22a3891b3d05a7`, reviewed October 28, 2026.

## Intended behavior

When trailing-stop mode is enabled, the configured take-profit first sells half the original position. After that half-sale is confirmed, the entire remaining position must be protected by a trailing threshold with the original entry price as its minimum floor. Every valid incoming trade update for an open position must evaluate that protection independently of the one-second strategy timer and entry watchlist.

For a long position:

```text
highWaterMark = max(previousHighWaterMark, validIncomingPrice)
trailingStop = highWaterMark - fixedTrailingDistance
newEffectiveStop = max(previousEffectiveStop, originalEntryPrice, trailingStop)

If validIncomingPrice < newEffectiveStop:
    latch a full-remainder exit intent
    reconcile orders and shares
    submit or continue the protective exit
```

Use strict `<` to match the requested behavior of falling below the threshold. Equality must be covered explicitly in tests. A broker-native order can have its own trigger semantics; do not represent those as an exact match to the local comparison.

The effective stop must never move downward for the same lifecycle. Once a threshold breach is latched, a recovery tick must not erase the exit intent. Changing to a percentage trail, retuning strategy thresholds, or changing entry signals is outside this feature.

## Problems this plan addresses

The current market-trade handler updates marks but does not evaluate exits. The one-second evaluator only checks the latest live-candle close and skips symbols outside `MASTER_WATCHLIST`. Active or pending native trailing state suppresses all local stop decisions.

Initial native trailing placement failure attempts a fallback close, but restart restoration failure only logs an error and can leave local exits suppressed. An expired, canceled, or rejected trailing order removes protection without preserving an explicit entry floor or a reliable half-out-completed state. The remainder can then be eligible for another half-sale.

Fractional quantities currently change native trailing time-in-force to `day`, without establishing that native trailing orders support fractional quantities. Saved native order IDs are not sufficient evidence that the broker still holds protection after a restart.

The existing simulator's half-out/trailing tests do not exercise native order acceptance, expiration, live ticker cadence, or recovery. Passing a simulator test is therefore not acceptance of this repair.

## Persistent lifecycle state

Extend the existing lifecycle ledger rather than introducing a separate unrelated database. The ledger must remain the source of strategy attribution and position lifecycle identity; Alpaca does not know the strategy that generated an order.

Add a versioned protection object associated with the lifecycle, with precisely typed fields for:

- The half-exit order ID, target quantity, confirmed cumulative fill quantity, and completion flag.
- The original entry price used by the exit profile, fixed trailing distance, activation time, and highest accepted price/time since activation.
- The effective stop and its monotonically increasing protection revision.
- Protection mode: local, native broker, or coordinated local plus verified broker protection.
- Current protection phase and any native protective order ID with last verified broker status.
- A latched full-remainder exit intent, stable client order identifier, order ID when known, reason, retry timing, last error, and last reconciliation time.

Keep confirmed share quantities in the existing fill accounting; do not create a competing quantity authority. The broker position and reconciled fills determine what can still be sold.

Use explicit phases such as `pre-half-out`, `half-exit-working`, `protected-remainder`, `remainder-exit-pending`, `remainder-exit-working`, `recovery-required`, and `closed`. These names are illustrative; the implementation should use a discriminated union and allowed transitions, not independent booleans that can contradict one another.

The half-sale completion flag is permanent for that lifecycle. A canceled protective order, engine restart, or price recovery cannot return it to `pre-half-out`. Partial half-exit fills must update actual exposure without causing a second half-exit order. Keep applicable original risk checks active while the half-exit is incomplete; pending setup must never mean all risk checks are disabled.

### Trailing activation and entry floor

Preserve the current intended fixed-dollar calibration: at confirmed half-exit completion, choose a fresh activation price and set the initial dollar distance to activation price minus original entry. Prefer the latest validated trade price; a fresh broker snapshot can be used for recovery when no valid trade is available. Do not use a stale latest-minute bar while claiming it is an exact current price.

If the activation price is already below entry, latch a remainder exit rather than attempt an invalid native trailing order. At entry, the local floor remains active and a positive trailing distance must not be invented. If no fresh price or valid distance is available, persist `recovery-required`, retain entry-floor evaluation on new ticks, and alert instead of marking protection active or suppressing all exits.

Record the selected activation source and time. Once established, do not recompute the distance from a lower restart price. Any tick accepted while activation is being persisted must still be evaluated in sequence and must not be lost behind asynchronous broker calls.

### Write integrity and durability

Reuse the lifecycle store's serialized mutation queue. Write a complete versioned snapshot to a temporary file in the same directory, flush it and atomically rename it into place; assess directory syncing for the target filesystem. Only acknowledge a persisted protection revision after successful completion. No two writers may mutate the same ledger concurrently.

Persist fills, half-sale transitions, raised stops, latched breaches, and exit-order transitions. Unchanged tick prices need no disk write. Any optimization to coalesce queued high-water updates must preserve the maximum, monotonically increasing stop, and every latched breach; it must not silently weaken durability.

An abrupt crash may lose a tick update that had not finished persisting. Clearly distinguish the current in-memory revision from the last durably saved revision. Failed writes must raise an explicit degraded-protection status, preserve in-memory risk evaluation, and prevent new exposure for the affected lifecycle; they must not clear the stop or report successful persistence.

## Live ticker and order coordination

Put protection evaluation in the existing market-trade event path for every open position, independent of entry watchlist membership. Keep strategy evaluation throttled as it is today. Do not append synthetic tick bars to minute-based indicator history.

Validate positive finite prices and event timestamps. Define and test rejection of malformed or out-of-order events so they cannot lower the stop or overwrite a newer mark. Feed silence and stale prices must be visible; the engine cannot infer market moves it did not receive.

Evaluate and latch the risk decision before deferring asynchronous persistence or broker work. Serialize protective actions by lifecycle/symbol without blocking unrelated tickers. Tick, minute-bar, startup, retry, strategy-sell, and manual-close paths must share the relevant order coordination so they cannot independently oversell the same shares.

Persist a stable client order identifier before submission. An ambiguous timeout is not a confirmed rejection: query by the identifier and reconcile before resubmitting. Do not create a new identifier for each retry of the same unresolved submission.

If an existing broker sell reserves shares, cancel or coordinate with it and confirm its terminal status before selling overlapping quantity. Process fills that arrive during cancellation, then fetch the current remaining quantity. Do not rely on a fixed delay as proof of cancellation, and do not treat a failed broker lookup as an empty order list.

A sell is complete only when reconciled fills or a verified absent position establish closure. A submitted order is not a fill. Partial remainder-exit fills keep the exit intent active for the unsold quantity. Failed or expired remainder orders retain that intent and retry safely; they never re-enable another take-profit half-sale.

## Fractional shares and trading sessions

Local protection must work for fractional remainders without submitting a fractional `trailing_stop` merely because its time-in-force is `day`. Verify supported combinations against current Alpaca documentation during implementation, using read-only information and mocked broker tests rather than real test orders.

Use supported quantity precision and reject invalid quantities without increasing exposure or rounding a sell above available shares. Native broker protection may be retained for eligible quantities only when its acceptance and actual stop are verified. Do not claim native protection covers fractional dust if it only covers whole shares.

For the protected-remainder exit path, use a supported market sell during regular hours where eligible. During eligible extended sessions, use a supported marketable Day limit order derived from a fresh price/quote, with explicit bounded repricing and cancellation reconciliation. Confirm the exact price source and repricing limits before implementation; do not silently reuse a stale minute-bar price or change unrelated closing behavior. Outside executable sessions, keep the exit intent queued and visibly unfilled.

Where a supported broker-held protective order is available, verify the returned high-water mark and derived stop against the local floor. A broker order must never cause the saved local threshold to move downward. Reconcile any native order with the local exit lock to avoid competing sells.

No stop or marketable-limit policy guarantees a fill at entry or at the trailing threshold. Gaps, liquidity, halts, order rejection, and session rules remain execution risks.

## Restart and recovery sequence

Before enabling new strategy orders, load and validate the ledger, reconcile broker positions and orders, and obtain a fresh valid market price. Continue to process protective information during reconciliation rather than treating startup as a reason to disable risk checks.

Restore the original entry, fixed distance, high-water mark, and effective stop from the saved protection object. For example, an illustrative saved entry of `$341.97`, distance `$7.83`, high-water mark `$355.00`, and effective stop `$347.17` must retain the `$347.17` stop when restarted at `$350.00`; it must not recalibrate a lower stop from the new price.

If the fresh price is below the saved stop, latch or continue the full-remainder exit. If a matching order is already working, reconcile it instead of placing a duplicate. If the position is verified closed, mark the lifecycle closed and clear only obsolete intents.

A saved native-order ID must be checked against the broker. Missing, expired, canceled, or rejected native protection must transition to local protection/recovery while preserving the half-out state and effective stop. Failure to place protection must not leave a pending map that suppresses all exits.

A restored exit intent remains latched even if the startup price has recovered. Reconcile its submission and fills before deciding whether a retry is required. Broker API failure, missing price, or corrupt state must produce an explicit recovery condition rather than an invented threshold or a false protected status.

Retries must use bounded backoff and per-lifecycle concurrency controls. Repeated failure must remain visible and must not be retried on every tick without rate limits. Retrying submission must not block evaluating newly received prices.

### Downtime boundary

A locally managed trail cannot submit orders while the engine is stopped. Startup can evaluate the latest price against the last durably saved stop, but cannot guarantee detection of an outage-time breach followed by a recovery. Nor can it infer an unobserved outage-time high and claim that its trail captured that high.

A supported broker-held order can provide protection during its eligible hours independently of the engine. Its expiration and actual coverage still need reconciliation. Do not describe disk persistence as uninterrupted market protection.

The ledger path must be on persistent disk. A future machine move requires a private transfer/backup of the actual ledger, not just the Git repository, and a deployment must not replace it with an empty file. Cloud deployment or migration is not part of this change.

## Existing-state migration

Version the ledger schema and preserve compatibility with existing entries and fills. Back up the ledger before a future migration, validate before replacement, and never silently discard unreadable protection state.

Use application lifecycle reasons and recorded exit intent to establish whether an old position completed the intended half-sale. Do not assume every `partially_closed` lifecycle is a trailing half-sale, and do not assign a strategy from Alpaca symbols alone.

Where a verified native order exists, inspect its current stop and high-water mark before migration. Preserve the greater of any valid saved stop and the verified protected threshold. For an old half-out record missing its historical high-water mark or fixed distance, those values cannot reliably be reconstructed from a current price alone. Mark the lifecycle `recovery-required`, retain any known entry floor, and require an explicitly reviewed migration policy rather than fabricate historical protection.

Account for external/manual quantity changes. A scale-in must not silently reset the original entry floor or trailing distance for an existing protected lifecycle. Reconcile and surface ambiguous attribution rather than attaching unrelated shares to the old strategy.

## Expected implementation locations

`packages/types/src/index.ts` would define the versioned protection and exit-intent types. `apps/engine/src/models/tradeLifecycleStore.ts` would own persistence, validation, migration, and atomic transitions.

`apps/engine/src/positionManager.ts` would evaluate the protected remainder and preserve the half-out latch without blanket pending-state suppression. `apps/engine/src/pipeline.ts` would evaluate every valid tick, handle fill transitions, and coordinate orders.

`apps/engine/src/executor.ts` would provide the narrowly scoped supported remainder-exit requests and order reconciliation primitives. `apps/engine/src/index.ts` and `tasks.ts` would handle startup readiness and controlled recovery. Changes to the existing close path must be limited to integration required by this feature.

Existing engine test files would be expanded or focused new tests added. A small pure risk helper may be introduced if it keeps price logic deterministic and shared. Backtest changes would be limited to exposing or testing the same risk semantics where practical; bar replay must not pretend to provide tick ordering or live broker execution guarantees.

Use existing broadcast/logging mechanisms to report local protection, verified native protection, pending exit, persistence failure, stale data, and recovery-required status. A dashboard redesign is outside scope; any essential visibility change must remain narrowly focused and be included in the later implementation approval.

## Regression tests and acceptance criteria

### Price and quantity behavior

Assert that take-profit half-out completes only once per lifecycle, including duplicate fill events and partial fills. Assert a fixed trail, entry floor, monotonic effective stop, strict-below comparison, and a full-remainder intent after a breach. Invalid prices, quantity precision, and out-of-order events must be deterministic.

Replay synthetic AAPL scenarios with entry `$341.97`: half-out at an illustrative `$349.80`, rise to `$355.00`, then breach of the resulting `$347.17` stop; and half-out followed by a tick below entry. These are deterministic fixtures, not historical price claims or attribution of a real AAPL trade.

A breach followed by recovery before the next one-second timer must still create exactly one exit intent. Multiple bad ticks and simultaneous completed bars must not create duplicate sells. An open position removed from the entry watchlist must remain protected.

### Lifecycle and broker failures

Cover native order rejection at submission and after acceptance, cancellation, Day expiration, missing saved order IDs, API lookup failure, ambiguous submission timeout, and partial fills during cancel/replacement. Verify stable identifiers and that submitted quantities never exceed reconciled available shares.

Verify that a fractional remainder does not generate an unsupported native trailing request. Cover whole-share protection plus fractional dust and odd-share/non-fractionable half-out handling without rounding into an oversell. Test session-eligible order types, unfilled extended-hours limits, and retry/reprice limits using mocks.

When both native setup and fallback exit fail, the half-out latch, effective stop, and exit intent must remain. Error messages must distinguish failure to submit from failure to persist an already-submitted order. Strategy and manual exits must share order coordination without changing their trading criteria.

### Restart and disk failures

Use fresh engine objects and an actual temporary ledger file to prove restart behavior; an in-memory restore alone is insufficient. Cover a lower restart price above the saved stop, a fresh price below it, a previously latched breach whose price recovered, an already-working exit, and an already-closed position.

Cover a crash/interruption around temporary-file write, rename, intent persistence, submission, and fill processing. The ledger must remain readable at the last completed revision, and ambiguous broker actions must reconcile before retry. Test concurrent mutations, failed disk writes, schema migration, and corrupt records without silently resetting protection.

Verify the documented limitation: a breach entirely during engine downtime is not claimed to have been executed or detected from a recovered current quote. Tests must not give credit to forced end-of-data liquidation or unrealistically exact stop fills.

## Implementation sequence after separate approval

1. Define lifecycle types, allowed transitions, invariants, and existing-state migration; add persistence tests first.
2. Implement a pure protected-remainder price decision and exercise the deterministic threshold fixtures.
3. Integrate per-tick evaluation, durable breach latching, and shared duplicate-order coordination.
4. Implement supported fractional/session execution and cancellation/fill reconciliation for this path.
5. Add startup restoration, missing-order recovery, controlled retries, and explicit degraded status.
6. Run focused mocked integration tests and existing regressions, then validate the scoped diff before a reviewable implementation commit.

Do not add or upgrade dependencies without separate approval. Follow repository TypeScript and error-handling rules. Use the test/typecheck/lint commands actually available in the repository; the current engine package has no `test` or `typecheck` script, so do not claim nonexistent commands passed. Record missing scripts or baseline failures rather than perform unrelated cleanup.

Any future validation against paper/live brokerage execution requires separately authorized scope. Automated regression tests must use mocks and must not place real broker orders. Implementation approval does not automatically authorize deployment or real trades.

## Completion boundary for this branch

This branch is complete when only this Markdown plan is committed and pushed. It must contain no engine implementation, dependency edits, runtime ledger, credentials, private account history, or generated test output. A pull request or merge is not part of the authorized step.

## Broker references to recheck during implementation

- [Alpaca fractional trading and supported order types](https://docs.alpaca.markets/us/docs/fractional-trading).
- [Alpaca order types, native trailing stops, and trading-hours rules](https://docs.alpaca.markets/us/docs/orders-at-alpaca).

These references document broker constraints; they do not establish that any specific account has accepted a particular request. No broker acceptance test is part of this plan-only branch.
