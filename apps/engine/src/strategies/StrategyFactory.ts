import { IStrategy } from "./IStrategy";
import { BasicStrategy } from "./BasicStrategy";
import { FifteenMinMorningBounce } from "./FifteenMinMorningBounce";
import { PDLSweepVWAPReclaim } from "./pdl-vwap";
import { BiotechMomentumStrategy } from "./BiotechMomentum";
import { DayTradeMicroScalp } from "./DayTradeMicroScalp";
import { BuyAndHold } from "./BuyAndHold";
import { DonchianBreakout } from "./DonchianBreakout";
import { RSIReversion } from "./RSIReversion";
import { SMACross } from "./SMACross";
import { StrategyParameterOverrides } from "./strategyConfig";

export type StrategyIdentifier =
  | "basicStrategy"
  | "dayTradeMicroScalp"
  | "pdlSweepVWAPReclaim"
  | "biotechMomentum"
  | "fifteenMinMorningBounce"
  | "buyAndHold"
  | "donchianBreakout"
  | "rsiReversion"
  | "smaCross";

type StrategyCreator = (parameters: StrategyParameterOverrides) => IStrategy;

export class StrategyFactory {
  private static registry: Record<StrategyIdentifier, StrategyCreator> = {
    basicStrategy: () => new BasicStrategy(),
    pdlSweepVWAPReclaim: () => new PDLSweepVWAPReclaim(),
    dayTradeMicroScalp: (parameters) => new DayTradeMicroScalp(parameters),
    biotechMomentum: () => new BiotechMomentumStrategy(),
    fifteenMinMorningBounce: () => new FifteenMinMorningBounce(),
    buyAndHold: () => new BuyAndHold(),
    donchianBreakout: (parameters) =>
      new DonchianBreakout(parameters.donchianPeriod),
    rsiReversion: (parameters) =>
      new RSIReversion(
        parameters.rsiPeriod,
        parameters.rsiLower,
        parameters.rsiUpper,
      ),
    smaCross: (parameters) =>
      new SMACross(parameters.smaFastPeriod, parameters.smaSlowPeriod),
  };

  public static create(
    id: StrategyIdentifier,
    parameters: StrategyParameterOverrides = {},
  ): IStrategy {
    const createStrategy = this.registry[id];
    if (!createStrategy) {
      throw new Error(
        `StrategyFactory Error: Strategy type "${id}" is unregistered.`,
      );
    }

    return createStrategy(parameters);
  }
}
