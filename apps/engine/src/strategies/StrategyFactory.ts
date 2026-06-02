import { IStrategy } from "./IStrategy";
import { BasicStrategy } from "./BasicStrategy";
import { FifteenMinMorningBounce } from "./FifteenMinMorningBounce";
import { PDLSweepVWAPReclaim } from "./pdl-vwap";
import { BiotechMomentumStrategy } from "./BiotechMomentum";
import { DayTradeMicroScalp } from "./DayTradeMicroScalp";

export type StrategyIdentifier =
  | "basicStrategy"
  | "dayTradeMicroScalp"
  | "pdlSweepVWAPReclaim"
  | "biotechMomentum"
  | "fifteenMinMorningBounce";

  export class StrategyFactory {
    private static registry: Record<StrategyIdentifier, new () => IStrategy> = {
      basicStrategy: BasicStrategy,
      pdlSweepVWAPReclaim: PDLSweepVWAPReclaim,
      dayTradeMicroScalp: DayTradeMicroScalp,
      biotechMomentum: BiotechMomentumStrategy,
      fifteenMinMorningBounce: FifteenMinMorningBounce,
    };

    public static create(id: StrategyIdentifier): IStrategy {
      const StrategyClass = this.registry[id];
      if (!StrategyClass) {
        throw new Error(
          `StrategyFactory Error: Strategy type "${id}" is unregistered.`,
        );
      }
      return new StrategyClass();
    }
  }
