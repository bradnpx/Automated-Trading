# Backtest Package

`apps/backtest` replays historical bars through the same `StrategyFactory` and strategy classes used by the live engine, while replacing brokerage dependencies with a deterministic simulated executor and portfolio ledger.

## Included components

| Component | Responsibility |
| --- | --- |
| `src/data.ts` | Strict JSON and CSV OHLCV loaders; chronological sorting; timestamp and OHLC validation. |
| `src/engine.ts` | Bar-by-bar replay, strategy hydration, signal evaluation, bracket/strategy exits, position sizing, fills, cash, and equity accounting. |
| `src/config.ts` | Validates versioned strategy, risk, cost, sizing, and intrabar-fill assumptions. |
| `src/metrics.ts` | Win rate, expectancy, profit factor, average win/loss, drawdown, turnover, and exposure. |
| `src/report.ts` | JSON and Markdown result reporting with trade attribution. |
| `src/test/run.ts` | Deterministic regression tests for sessions, Donchian behavior, fills, and forced end-of-data exits. |

## Historical data contract

Provide a CSV or JSON file containing one-minute bars. CSV must have a header row with the following fields; aliases such as `time`, `ticker`, and `o/h/l/c/v` are also accepted.

```text
timestamp,symbol,open,high,low,close,volume
2026-08-12T13:30:00.000Z,TEST,10.00,10.10,9.95,10.05,100000
```

JSON may be either an array of bars or `{ "bars": [...] }`. Bars must have unique, strictly increasing timestamps for each symbol. The loader rejects invalid OHLC ranges and malformed timestamps rather than silently repairing them.

## Configuration

Create a full JSON configuration file. Percentages are decimal values, so `0.02` means 2.0%.

```json
{
  "strategyId": "biotechMomentum",
  "strategyParameters": {
    "rsiPeriod": 14,
    "rsiLower": 30,
    "rsiUpper": 70,
    "smaFastPeriod": 20,
    "smaSlowPeriod": 50,
    "donchianPeriod": 20
  },
  "initialCash": 100000,
  "riskPerTrade": 0.01,
  "positionSizingMethod": "risk-to-stop",
  "maxPositionPct": 0.20,
  "stopLossPct": 0.02,
  "takeProfitPct": 0.022,
  "slippageBps": 5,
  "commissionPerOrder": 0,
  "intrabarFillPriority": "stop-first",
  "closeOpenPositionsAtEnd": true
}
```

Use `"equity-fraction"` sizing when `stopLossPct` is `null`. Setting either bracket percentage to `null` disables that bracket. `stop-first` is the conservative assumption when one OHLC bar reaches both a stop and target.

## Download Alpaca Historical Data

The downloader fetches historical Alpaca bars and writes the exact CSV schema required by this package. It loads credentials from the repository-root `.env` file. Define:

```text
APCA_API_KEY_ID=your_alpaca_key
APCA_API_SECRET_KEY=your_alpaca_secret
```

Fetch 90 calendar days of AAPL one-minute IEX bars:

```bash
pnpm --filter backtest download-alpaca -- --symbol AAPL --days 90
```

The default output is placed under `data/alpaca/`. You may instead use explicit dates and select a destination:

```bash
pnpm --filter backtest download-alpaca -- \\
  --symbol AAPL \\
  --start 2025-01-01 \\
  --end 2025-04-01 \\
  --timeframe 1Min \\
  --feed iex \\
  --output data/aapl-2025-q1.csv
```

Use `pnpm --filter backtest download-alpaca -- --help` to see all supported arguments. In PowerShell, use the command on one line or use a backtick (`` ` ``) for multiline continuation rather than a backslash. Availability of a particular feed, interval, or historical depth depends on the permissions of the user's Alpaca market-data subscription.

## Run a Strategy Fixture

Each backtest fixture belongs in a strategy-named folder with two files named after that strategy:

```text
apps/backtest/fixtures/<strategyId>/<strategyId>.csv
apps/backtest/fixtures/<strategyId>/<strategyId>.json
```

For example, the included fixture is stored as:

```text
apps/backtest/fixtures/buyAndHold/buyAndHold.csv
apps/backtest/fixtures/buyAndHold/buyAndHold.json
```

Run it with only the strategy identifier:

```bash
pnpm --filter backtest backtest -- --strategy buyAndHold
```

Replay progress is displayed in the console as completed CSV bars and percentage. By default, the command writes `result.json` and `report.md` to `backtest-results/<strategyId>/`.

### Advanced explicit-path mode

Explicit files remain supported when needed:

```bash
pnpm --filter backtest backtest -- --data ./data/minute-bars.csv --config ./configs/biotech-momentum.json --output ./backtest-results/biotech-momentum
```

Use `pnpm --filter backtest backtest -- --help` to view the accepted command options.

## Validation discipline

The package prevents the most basic sources of invalid inference, but data selection remains the caller’s responsibility. Use a point-in-time symbol universe, include delisted securities where relevant, account for splits/dividends consistently, retain the feed’s actual bar timestamps, and use costs that reflect the intended broker and liquidity class.

For strategy selection, reserve a final period that is never used to set parameters. Prefer rolling walk-forward evaluation and compare each run with the same assumptions, data universe, and costs. Do not select a strategy solely because its in-sample win rate is high; evaluate expectancy, drawdown, turnover, trade count, and stability across market regimes.

## Strategy parity repairs included

The engine changes on this branch make replay behavior match intended strategy semantics more closely:

- Session checks now use the bar timestamp rather than machine wall-clock time.
- VWAP resets by Eastern trading date rather than using a rolling 20-bar approximation.
- PDL strategies receive the completed prior regular-session low in live warm-up and derive the same level from historical data in backtests.
- Donchian breakouts use the prior `N` bars, and both entry and exit conditions are evaluated.
- SMA conditions detect an actual crossover/crossdown, with explicit configurable windows.
- RSI period/threshold parameters reach the evaluator.
- Live strategy `SELL` signals now enter the close-order path.
- The morning PDL bounce requires an actual PDL sweep/reclaim and bullish follow-through.

Run the regression suite with:

```bash
pnpm --filter backtest test
```
