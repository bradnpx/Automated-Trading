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

  export class StrategyFactory {
    private static registry: Record<StrategyIdentifier, new () => IStrategy> = {
      basicStrategy: BasicStrategy,
      pdlSweepVWAPReclaim: PDLSweepVWAPReclaim,
      dayTradeMicroScalp: DayTradeMicroScalp,
      biotechMomentum: BiotechMomentumStrategy,
      fifteenMinMorningBounce: FifteenMinMorningBounce,
      buyAndHold: BuyAndHold,
      donchianBreakout: DonchianBreakout,
      rsiReversion: RSIReversion,
      smaCross: SMACross,
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
