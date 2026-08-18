export interface StrategyParameters {
  donchianPeriod: number;
  rsiPeriod: number;
  rsiLower: number;
  rsiUpper: number;
  smaFastPeriod: number;
  smaSlowPeriod: number;
}

export type StrategyParameterOverrides = Partial<StrategyParameters>;

export const DEFAULT_STRATEGY_PARAMETERS: StrategyParameters = {
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

  if (!Number.isInteger(parameters.donchianPeriod) || parameters.donchianPeriod < 2) {
    throw new Error("donchianPeriod must be an integer greater than or equal to 2");
  }

  if (!Number.isInteger(parameters.rsiPeriod) || parameters.rsiPeriod < 2) {
    throw new Error("rsiPeriod must be an integer greater than or equal to 2");
  }

  if (
    !(0 < parameters.rsiLower &&
      parameters.rsiLower < parameters.rsiUpper &&
      parameters.rsiUpper < 100)
  ) {
    throw new Error("require 0 < rsiLower < rsiUpper < 100");
  }

  if (
    !Number.isInteger(parameters.smaFastPeriod) ||
    !Number.isInteger(parameters.smaSlowPeriod) ||
    parameters.smaFastPeriod < 2 ||
    parameters.smaFastPeriod >= parameters.smaSlowPeriod
  ) {
    throw new Error("require integer SMA windows where 2 <= smaFastPeriod < smaSlowPeriod");
  }

  return parameters;
}
