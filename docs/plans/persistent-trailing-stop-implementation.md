# Persistent trailing-stop implementation

This implementation follows the November 3, 2026 approval on `feat/persistent-trailing-stop-plan`. It changes only protected-remainder risk handling, required order coordination, lifecycle persistence, and their tests. Strategy entry criteria and percentage thresholds are unchanged. No dependencies are added or upgraded. No engine is launched, deployment performed, or brokerage orders submitted during development.

## Protected-remainder behavior

A take-profit half-sale has a durable client identifier, original target quantity, cumulative confirmed fills, and a permanent completion flag. An accepted order is not treated as a fill. For a nonfractionable odd holding, the half-sale rounds downward to supported whole shares, leaving the balance protected. A holding too small to split is flagged unsupported instead of rounding upward or endlessly retrying an invalid half-sale; its original loss guard remains active.

New remainders use local fixed-dollar protection, including fractional shares. After confirmed half-out, a validated fresh trade establishes the initial distance above the original entry. The entry floor remains active when calibration is unavailable. The high-water mark and effective stop can only increase. A strict-below breach is latched synchronously for each accepted ticker update, independently of strategy timers and entry-watchlist membership. A subsequent recovery tick cannot undo that intent. Incoming timestamps must be valid, ordered, and within 10 seconds of the injected/system clock; equal-millisecond trades can still raise the high or breach the stop.

The coordinator shares per-symbol broker submission serialization with the existing close path. It persists a stable client identifier before submission, queries that identifier after ambiguous responses, confirms cancellation before overlapping sells, and uses the broker's current long quantity and available shares. Supported precision is truncated downward; it never enlarges the sale. A pending partial half-sale does not disable the applicable original stop-loss. Protected strategy/manual exits reuse the coordinator rather than create another independent remainder order.

## Restarts, fills, and storage

The version-2 lifecycle ledger stores original entry, fixed distance, high-water mark, effective stop, half-exit completion, native order reference when present, and any latched exit/retry state. Startup restores that ledger and reconciles positions and known orders before new strategy exposure is allowed. Lower current prices do not recalibrate an established distance. Final broker cumulative fills are reconciled before zero-position closure, including fills missed while offline. Order snapshot averages are converted to incremental fill value so duplicates do not inflate quantities or realized P&L.

Writes are serialized within the store and use a unique same-directory temporary file, file flush, atomic rename, and directory flush where supported. Corrupt/unreadable ledgers are not replaced with empty history. Failed writes leave risk state in memory and report degraded persistence; unpersisted new order intents are not submitted. In-memory and durable revisions are separately visible. Only one engine process may own a ledger; this change does not install a cross-process lock or coordinate multiple independent engine deployments.

Version-1 ledgers are validated and backed up as `<ledger>.v1.bak` before migration. Only explicit half-sale history or a saved native trailing reference establishes a legacy protected remainder; arbitrary partial sales do not. An unknown historical trail is not guessed from the restart quote. Such records retain the original entry floor and `recovery-required` until a native dollar trail can be verified or the migration policy is explicitly reviewed. A verified native stop can raise but never lower the saved local floor. Missing/canceled/expired native orders do not reset half-out completion. External quantity/basis changes with ambiguous strategy attribution block an automatic sale and raise recovery status rather than silently attach unrelated shares.

Keep `TRADE_LIFECYCLE_PATH` on persistent disk and back up the actual ledger separately from Git. Do not check the runtime ledger, its backup, private trade history, or credentials into the branch. A machine move or deployment is outside this change.

## Sessions and the open execution-policy decision

Regular-session protected exits use broker-clock/calendar-eligible market Day orders. Holidays, weekends, overnight closures, and early closes are not inferred solely from the local wall clock. Fractional `trailing_stop` requests are rejected before creation; changing time-in-force does not make that unsupported combination acceptable.

The executor and coordinator support fresh-trade-based Day limit orders and bounded cancel/repricing for eligible pre/post-market sessions. **That policy is not enabled in startup until the user approves the requested source, offset, freshness, and replacement limits.** Startup deliberately passes no extended-hours policy. During extended/closed sessions a protected exit remains durably queued and visibly unfilled; it is eligible to proceed in the next regular session. This is an explicit boundary, not a claim of all-session automatic execution.

The proposed but not yet approved policy is a latest trade no older than 10 seconds, a 2% discounted Day limit during eligible pre/post-market hours, a minimum 30-second replacement interval, and at most three replacements before deferring to the next regular session. Offline tests may pass explicit policy values to exercise the mechanism; that does not enable account trading. Overnight support and account-specific eligibility are not enabled by this feature.

## Visibility and unavoidable limits

`GET /protection` returns readiness, persistence health, each protection phase, original entry, distance, high-water mark, effective stop, order intent, retry/error state, durable revision, and stale-price status. Existing signal broadcasting carries explicit HOLD/error/recovery alerts; no dashboard redesign is included. `/history` continues to use the application lifecycle ledger for strategy attribution, not Alpaca symbol-to-strategy assumptions. Panic-mode guards prevent a delayed protective/legacy close submission after the engine is killed.

Local protection cannot submit while the engine is stopped or disconnected. Disk persistence preserves the last completed revision; it cannot reconstruct an unobserved outage-time high or a breach followed by recovery. Only an already-accepted, still-valid broker-held order can act without the engine during its eligible sessions. Gaps, slippage, halts, liquidity and rejected/unfilled orders still prevent any guarantee of an entry-price or stop-price fill.

## Offline validation

Run with the existing locked dependencies, without engine startup or brokerage credentials:

```sh
pnpm --dir apps/engine exec tsc -p tsconfig.protection.json
pnpm --dir apps/engine exec tsx src/protectionState.test.ts
pnpm --dir apps/engine exec tsx src/models/tradeLifecycleStore.test.ts
pnpm --dir apps/engine exec tsx src/models/tradeLifecycleStore.protection.test.ts
pnpm --dir apps/engine exec tsx src/models/tradeLifecycleStore.race.test.ts
pnpm --dir apps/engine exec tsx src/executorProtection.test.ts
pnpm --dir apps/engine exec tsx --test src/remainderProtection.test.ts
pnpm --dir apps/engine exec tsx --test src/remainderRecovery.test.ts
pnpm --dir apps/engine exec tsx --test src/protectionPipeline.test.ts
pnpm --dir apps/engine exec tsx src/executor.test.ts
pnpm --dir apps/engine exec tsx src/positionManager.test.ts
pnpm --dir apps/engine exec tsx src/pipeline.test.ts
pnpm --dir apps/engine exec tsx src/pipelineLifecycle.test.ts
git diff --check
```

Validation passed for 37 disk-backed controller/stream/recovery tests, 44 mocked execution scenarios, 14 additional actual-disk store scenarios, the pure-state and store-race runners, and the existing executor, position-manager, pipeline, lifecycle and store regressions. Scoped strict TypeScript validation and focused formatting/whitespace checks also passed. The tests do not launch the engine and their broker calls are mocked; the integration suites explicitly reject network attempts.

The engine has no pre-existing `test`, `typecheck`, or lint script, so no nonexistent script is claimed to pass. Repository-wide `pnpm --filter backtest check-types` and `pnpm lint` fail on the same seven baseline errors: strategy identifier/export mismatch, missing strategy criteria, report arithmetic, and missing ATR/SMA/boolean return in the strategy registry. Those failures were captured before implementation and are not repaired as unrelated cleanup.

## Broker references

Constraints were rechecked read-only on November 3, 2026: [fractional supported order types](https://docs.alpaca.markets/us/docs/fractional-trading) and [native trailing, order identifiers, and session rules](https://docs.alpaca.markets/us/docs/orders-at-alpaca). Mock passing is not proof of broker acceptance for any specific account. A future paper/live validation requires separate authorization.
