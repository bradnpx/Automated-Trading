import { getPremarketData } from "./getPremarketData.js";

export interface PremarketChange {
  premarketHigh: number | null;
  premarketVolume: number;
  percentageChange: number;
  volumePercentageChange: number;
  latestPrice: number;
}

/**
 * Combines a cached premarket snapshot with the streamed bar currently under
 * evaluation. This deliberately avoids separate latest-trade and latest-bar
 * REST calls for every strategy evaluation.
 */
export async function getPremarketChange(
  symbol: string,
  currentPrice: number,
  currentVolume: number,
): Promise<PremarketChange | null> {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null;

  const premarketData = await getPremarketData(symbol);
  if (!premarketData?.price) return null;

  const premarketVolume = premarketData.volume ?? 0;
  const latestVolume =
    Number.isFinite(currentVolume) && currentVolume > 0 ? currentVolume : 0;

  return {
    premarketHigh: premarketData.premarketHigh,
    premarketVolume,
    percentageChange:
      ((currentPrice - premarketData.price) / premarketData.price) * 100,
    volumePercentageChange:
      latestVolume > 0
        ? ((latestVolume - premarketVolume) / latestVolume) * 100
        : 0,
    latestPrice: currentPrice,
  };
}
