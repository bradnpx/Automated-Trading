import { StrategyIdentifier } from "./strategies/StrategyFactory";


export const WATCHLIST_CONFIGS = [
  {
    name: "Basic Strategy Test",
    strategy: "basicStrategy" as StrategyIdentifier,
    symbols: [],
  },
  {
    name: "15-minute Morning SPX bounce",
    strategy: "fifteenMinMorningBounce" as StrategyIdentifier,
    symbols: ["SPX", "SPXL", "SPXS"],
  },
  {
    name: "Liquidity Sweep Scour",
    strategy: "pdlSweepVWAPReclaim" as StrategyIdentifier,
    symbols: ["SPY", "AAPL", "QQQ", "NVDA", "MSFT", "META", "IWM"],
  },
  {
    name: "Biotech High Volatility",
    strategy: "biotechMomentum" as StrategyIdentifier,
    symbols: ["MRNA", "XBI", "IBB"],
  },
];

export const SYMBOL_STRATEGY_MAP: Record<string, StrategyIdentifier> = {};
// export const SYMBOL_STRATEGY_MAP: Record<string, StrategyIdentifier> = {
//   CAKE: "basicStrategy", // ← or whatever test symbol you want
//   // ...
// };
export const ALL_TRACKED_SYMBOLS: string[] = [];

for (const list of WATCHLIST_CONFIGS) {
    for (const symbol of list.symbols) {
        SYMBOL_STRATEGY_MAP[symbol] = list.strategy;
        if (!ALL_TRACKED_SYMBOLS.includes(symbol)) {
            ALL_TRACKED_SYMBOLS.push(symbol)
        }
    }
}

export const TRADING_CONFIG = {
  RISK_PER_TRADE: 0.05, // 5% of total equity
  PORT_WS_BROADCASTER: 4000,
  PORT_KILL_SWITCH_API: 4001,
};
