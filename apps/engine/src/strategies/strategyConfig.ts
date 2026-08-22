export interface StrategyParameters {
  donchianPeriod: number;
  rsiPeriod: number;
  rsiLower: number;
  rsiUpper: number;
  smaFastPeriod: number;
  smaSlowPeriod: number;
  microScalpMaxVwapExtensionPct: number;
  microScalpMinRelativeVolume: number;
}

export type StrategyParameterOverrides = Partial<StrategyParameters>;

export const DEFAULT_STRATEGY_PARAMETERS: StrategyParameters = {
  donchianPeriod: 20,
  rsiPeriod: 14,
  rsiLower: 30,
  rsiUpper: 70,
  smaFastPeriod: 20,
  smaSlowPeriod: 50,
  microScalpMaxVwapExtensionPct: 0.015,
  microScalpMinRelativeVolume: 1.5,
};

export function resolveStrategyParameters(
  overrides: StrategyParameterOverrides = {},
): StrategyParameters {
  const parameters: StrategyParameters = {
    ...DEFAULT_STRATEGY_PARAMETERS,
    ...overrides,
  };

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

  if (
    !Number.isFinite(parameters.microScalpMaxVwapExtensionPct) ||
    parameters.microScalpMaxVwapExtensionPct <= 0 ||
    parameters.microScalpMaxVwapExtensionPct > 0.05
  ) {
    throw new Error(
      "microScalpMaxVwapExtensionPct must be greater than 0 and no more than 0.05",
    );
  }

  if (
    !Number.isFinite(parameters.microScalpMinRelativeVolume) ||
    parameters.microScalpMinRelativeVolume < 1
  ) {
    throw new Error("microScalpMinRelativeVolume must be at least 1");
  }

  return parameters;
}
