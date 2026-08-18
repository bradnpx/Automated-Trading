import {
  BacktestConfig,
  ResolvedBacktestConfig,
} from "./types.js";

export const DEFAULT_BACKTEST_CONFIG: Omit<
  ResolvedBacktestConfig,
  "strategyId"
> = {
  strategyParameters: {},
  initialCash: 100_000,
  riskPerTrade: 0.01,
  positionSizingMethod: "risk-to-stop",
  maxPositionPct: 0.2,
  stopLossPct: 0.02,
  takeProfitPct: 0.022,
  slippageBps: 5,
  commissionPerOrder: 0,
  intrabarFillPriority: "stop-first",
  closeOpenPositionsAtEnd: true,
};

export function resolveBacktestConfig(
  config: BacktestConfig,
): ResolvedBacktestConfig {
  const resolved: ResolvedBacktestConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    ...config,
    strategyParameters: config.strategyParameters ?? {},
  };

  if (!(resolved.initialCash > 0)) {
    throw new Error("initialCash must be greater than zero");
  }

  if (!(resolved.riskPerTrade > 0 && resolved.riskPerTrade <= 1)) {
    throw new Error("riskPerTrade must be greater than zero and no greater than one");
  }

  if (!(resolved.maxPositionPct > 0 && resolved.maxPositionPct <= 1)) {
    throw new Error("maxPositionPct must be greater than zero and no greater than one");
  }

  if (
    resolved.stopLossPct !== null &&
    !(resolved.stopLossPct > 0 && resolved.stopLossPct < 1)
  ) {
    throw new Error("stopLossPct must be null or between zero and one");
  }

  if (
    resolved.takeProfitPct !== null &&
    !(resolved.takeProfitPct > 0 && resolved.takeProfitPct < 1)
  ) {
    throw new Error("takeProfitPct must be null or between zero and one");
  }

  if (
    resolved.positionSizingMethod === "risk-to-stop" &&
    resolved.stopLossPct === null
  ) {
    throw new Error("risk-to-stop sizing requires a stopLossPct");
  }

  if (!(resolved.slippageBps >= 0)) {
    throw new Error("slippageBps cannot be negative");
  }

  if (!(resolved.commissionPerOrder >= 0)) {
    throw new Error("commissionPerOrder cannot be negative");
  }

  return resolved;
}
