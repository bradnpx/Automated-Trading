import { BacktestMetrics, EquityPoint, SimulatedTrade } from "./types.js";

interface MetricsInput {
  trades: SimulatedTrade[];
  equityCurve: EquityPoint[];
  initialCash: number;
  turnoverNotional: number;
  exposedBars: number;
  processedBars: number;
}

export function calculateMetrics(input: MetricsInput): BacktestMetrics {
  const wins = input.trades.filter((trade) => trade.netPnl > 0);
  const losses = input.trades.filter((trade) => trade.netPnl < 0);
  const breakevens = input.trades.length - wins.length - losses.length;
  const grossProfit = sum(wins.map((trade) => trade.netPnl));
  const grossLoss = Math.abs(sum(losses.map((trade) => trade.netPnl)));
  const totalNetPnl = sum(input.trades.map((trade) => trade.netPnl));

  return {
    closedTrades: input.trades.length,
    wins: wins.length,
    losses: losses.length,
    breakevens,
    winRatePct:
      input.trades.length > 0 ? (wins.length / input.trades.length) * 100 : 0,
    totalNetPnl,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    averageWin: wins.length > 0 ? grossProfit / wins.length : 0,
    averageLoss: losses.length > 0 ? -grossLoss / losses.length : 0,
    expectancy:
      input.trades.length > 0 ? totalNetPnl / input.trades.length : 0,
    maxDrawdownPct: calculateMaxDrawdownPct(input.equityCurve),
    turnover:
      input.initialCash > 0 ? input.turnoverNotional / input.initialCash : 0,
    exposurePct:
      input.processedBars > 0
        ? (input.exposedBars / input.processedBars) * 100
        : 0,
  };
}

function calculateMaxDrawdownPct(equityCurve: EquityPoint[]): number {
  let highWaterMark = Number.NEGATIVE_INFINITY;
  let maxDrawdownPct = 0;

  for (const point of equityCurve) {
    highWaterMark = Math.max(highWaterMark, point.equity);
    if (highWaterMark <= 0) {
      continue;
    }

    const drawdownPct = ((highWaterMark - point.equity) / highWaterMark) * 100;
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
  }

  return maxDrawdownPct;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
