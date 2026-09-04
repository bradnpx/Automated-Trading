export interface StrategyParameters {
  bullFlagBreakoutBufferPct: number;
  bullFlagBreakoutVolumeMultiplier: number;
  bullFlagFakeoutCloseBelowResistancePct: number;
  bullFlagMaxConsolidationBars: number;
  bullFlagMaxConsolidationRangePct: number;
  bullFlagMaxRetracementPct: number;
  bullFlagMinBullishPoleBars: number;
  bullFlagMinConsolidationBars: number;
  bullFlagMinPoleGainPct: number;
  bullFlagMinPoleToFlagVolumeRatio: number;
  bullFlagPoleBars: number;
  donchianPeriod: number;
  rsiPeriod: number;
  rsiLower: number;
  rsiUpper: number;
  smaFastPeriod: number;
  smaSlowPeriod: number;
}

export type StrategyParameterOverrides = Partial<StrategyParameters>;

export const DEFAULT_STRATEGY_PARAMETERS: StrategyParameters = {
  bullFlagBreakoutBufferPct: 0.001,
  bullFlagBreakoutVolumeMultiplier: 1.5,
  bullFlagFakeoutCloseBelowResistancePct: 0.0025,
  bullFlagMaxConsolidationBars: 5,
  bullFlagMaxConsolidationRangePct: 0.06,
  bullFlagMaxRetracementPct: 0.5,
  bullFlagMinBullishPoleBars: 2,
  bullFlagMinConsolidationBars: 2,
  bullFlagMinPoleGainPct: 0.04,
  bullFlagMinPoleToFlagVolumeRatio: 1.25,
  bullFlagPoleBars: 3,
  donchianPeriod: 20,
  rsiPeriod: 14,
  rsiLower: 30,
  rsiUpper: 70,
  smaFastPeriod: 20,
  smaSlowPeriod: 50,
};

export function resolveStrategyParameters(
  overrides: StrategyParameterOverrides = {},
): StrategyParameters {
  const parameters: StrategyParameters = {
    ...DEFAULT_STRATEGY_PARAMETERS,
    ...overrides,
  };

  if (
    !Number.isInteger(parameters.bullFlagPoleBars) ||
    parameters.bullFlagPoleBars < 1 ||
    !Number.isInteger(parameters.bullFlagMinBullishPoleBars) ||
    parameters.bullFlagMinBullishPoleBars < 1 ||
    parameters.bullFlagMinBullishPoleBars > parameters.bullFlagPoleBars
  ) {
    throw new Error(
      "require 1 <= bullFlagMinBullishPoleBars <= bullFlagPoleBars, with integer values",
    );
  }

  if (
    !Number.isInteger(parameters.bullFlagMinConsolidationBars) ||
    !Number.isInteger(parameters.bullFlagMaxConsolidationBars) ||
    parameters.bullFlagMinConsolidationBars < 2 ||
    parameters.bullFlagMinConsolidationBars >
      parameters.bullFlagMaxConsolidationBars
  ) {
    throw new Error(
      "require integer bull flag consolidation bars where 2 <= minimum <= maximum",
    );
  }

  if (
    !(parameters.bullFlagMinPoleGainPct > 0) ||
    !(parameters.bullFlagMaxRetracementPct > 0) ||
    parameters.bullFlagMaxRetracementPct > 0.5 ||
    !(parameters.bullFlagMaxConsolidationRangePct > 0) ||
    !(parameters.bullFlagMinPoleToFlagVolumeRatio > 0) ||
    !(parameters.bullFlagBreakoutVolumeMultiplier > 0) ||
    parameters.bullFlagBreakoutBufferPct < 0 ||
    parameters.bullFlagFakeoutCloseBelowResistancePct < 0
  ) {
    throw new Error(
      "bull flag percentages and volume multipliers must be positive; retracement may not exceed 50%",
    );
  }

  if (
    !Number.isInteger(parameters.donchianPeriod) ||
    parameters.donchianPeriod < 2
  ) {
    throw new Error(
      "donchianPeriod must be an integer greater than or equal to 2",
    );
  }

  if (!Number.isInteger(parameters.rsiPeriod) || parameters.rsiPeriod < 2) {
    throw new Error("rsiPeriod must be an integer greater than or equal to 2");
  }

  if (
    !(
      0 < parameters.rsiLower &&
      parameters.rsiLower < parameters.rsiUpper &&
      parameters.rsiUpper < 100
    )
  ) {
    throw new Error("require 0 < rsiLower < rsiUpper < 100");
  }

  if (
    !Number.isInteger(parameters.smaFastPeriod) ||
    !Number.isInteger(parameters.smaSlowPeriod) ||
    parameters.smaFastPeriod < 2 ||
    parameters.smaFastPeriod >= parameters.smaSlowPeriod
  ) {
    throw new Error(
      "require integer SMA windows where 2 <= smaFastPeriod < smaSlowPeriod",
    );
  }

  return parameters;
}
