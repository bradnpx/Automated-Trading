import { BacktestResult } from "./types.js";

export function renderBacktestMarkdown(result: BacktestResult): string {
  const criteria = Array.from(result.criteria);
  const metrics = result.metrics;
  const lines = [
    "# Backtest Report",
    "",
    "## Run Configuration",
    "",
    "| Field | Value |",
    "| --- | ---: |",
    `| Strategy | ${result.config.strategyId} |`,
    `| Period start | ${result.firstTimestamp} |`,
    `| Period end | ${result.lastTimestamp} |`,
    `| # of Days | ${(Date.parse(result.lastTimestamp) - Date.parse(result.firstTimestamp)) / (1000 * 60 * 60 * 24).toFixed(0)} |`,
    `| Initial cash | ${formatCurrency(result.initialCash)} |`,
    `| Ending equity | ${formatCurrency(result.endingEquity)} |`,
    `| Stop loss | ${formatOptionalPercent(result.config.stopLossPct)} |`,
    `| Take profit | ${formatOptionalPercent(result.config.takeProfitPct)} |`,
    `| Slippage per side | ${result.config.slippageBps.toFixed(2)} bps |`,
    `| Commission per order | ${formatCurrency(result.config.commissionPerOrder)} |`,
    `| Sizing method | ${result.config.positionSizingMethod} |`,
    "",
    "## Criteria",
    "",
    "| Criteria |",
    "| ---: |",
    // `| ${criteria} |`,
    ...criteria.map((c) => `| ${c} |`),
    "",
    "## Performance",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Closed trades | ${metrics.closedTrades} |`,
    `| Avg. Trades per Day | ${Math.ceil(metrics.closedTrades / (Date.parse(result.lastTimestamp) - Date.parse(result.firstTimestamp)) / (1000 * 60 * 60 * 24))} |`,
    `| Wins / losses / breakevens | ${metrics.wins} / ${metrics.losses} / ${metrics.breakevens} |`,
    `| Win rate | ${formatPercent(metrics.winRatePct / 100)} |`,
    `| Net P&L | ${formatCurrency(metrics.totalNetPnl)} |`,
    `| Profit factor | ${metrics.profitFactor?.toFixed(2) ?? "N/A"} |`,
    `| Average win | ${formatCurrency(metrics.averageWin)} |`,
    `| Average loss | ${formatCurrency(metrics.averageLoss)} |`,
    `| Expectancy per trade | ${formatCurrency(metrics.expectancy)} |`,
    `| Maximum drawdown | ${formatPercent(metrics.maxDrawdownPct / 100)} |`,
    `| Turnover / initial capital | ${metrics.turnover.toFixed(2)}x |`,
    `| Time exposed | ${formatPercent(metrics.exposurePct / 100)} |`,
    "",
    "## Trade Attribution",
    "",
    "| Trade | Symbol | Entry | Exit | Net P&L | Return | Exit reason |",
    "| --- | --- | --- | --- | ---: | ---: | --- |",
    ...result.trades.map(
      (trade) =>
        `| ${trade.tradeId} | ${trade.symbol} | ${trade.entryTimestamp} | ${trade.exitTimestamp} | ${formatCurrency(trade.netPnl)} | ${formatPercent(trade.returnPct)} | ${trade.exitReason} |`,
    ),
  ];

  return `${lines.join("\n")}\n`;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatOptionalPercent(value: number | null): string {
  return value === null ? "Disabled" : formatPercent(value);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
