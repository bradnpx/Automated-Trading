import { restClient } from "@polygon.io/client-js";

// Initialize the Polygon REST Client
const polygonRest = restClient(process.env.POLYGON_API_KEY || "");

export async function calculateTimeOfDayRVOL(
  symbol: string,
  lookbackDays = 14,
) {
  try {
    // 1. Get current time attributes in NY
    const now = new Date();
    const currentNYTime = now.toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour12: false,
    });
    const [currentHour, currentMinute] = currentNYTime.split(":");

    // 2. Fetch today's accumulated volume from Polygon Ticker Snapshot
    const snapshot = await polygonRest.stocks.snapshotTicker(symbol);
    const todayVolume = snapshot.ticker?.day?.v || 0;

    // 3. Query historical 1-minute bars over the lookback period
    const pastDate = new Date();
    pastDate.setDate(now.getDate() - (lookbackDays + 7)); // Buffer for weekends

    const startTimestamp = pastDate.getTime();
    const endTimestamp = now.getTime();

    const response = await polygonRest.stocks.aggregates(
      symbol,
      1,
      "minute",
      startTimestamp,
      endTimestamp,
      {
        limit: 50000, // High limit ensures 1Min bars don't truncate mid-query
      },
    );

    // Map to group volumes by calendar date
    const dailyVolumeTotals: Record<string, number> = {};

    if (response.results) {
      for (const bar of response.results) {
        if (!bar.t || !bar.v) continue;

        // bar.t is the Unix millisecond timestamp
        const barDate = new Date(bar.t);

        // Track calendar date strictly in New York time to match market session days
        const nyDateParts = barDate.toLocaleDateString("en-US", {
          timeZone: "America/New_York",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        });
        const [month, day, year] = nyDateParts.split("/");
        const barDateStr = `${year}-${month}-${day}`;

        // Parse the bar's timestamp to New York Time clock string
        const barNYTime = barDate.toLocaleTimeString("en-US", {
          timeZone: "America/New_York",
          hour12: false,
        });
        const [barHour, barMinute] = barNYTime.split(":");

        // Only add volume if the historical bar happened BEFORE the current time of day
        if (
          barHour < currentHour ||
          (barHour === currentHour && barMinute <= currentMinute)
        ) {
          dailyVolumeTotals[barDateStr] =
            (dailyVolumeTotals[barDateStr] || 0) + bar.v; // 'v' represents volume
        }
      }
    }

    // 4. Compute the average historical volume up to this time of day
    // Format today's comparison string in New York time for safe exclusion
    const todayNYParts = now.toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const [tMonth, tDay, tYear] = todayNYParts.split("/");
    const todayStr = `${tYear}-${tMonth}-${tDay}`;

    const historicalDaysOnly = Object.keys(dailyVolumeTotals)
      .filter((date) => date !== todayStr)
      .map((date) => dailyVolumeTotals[date]);

    if (historicalDaysOnly.length === 0) {
      console.log(
        `No historical data found to calculate average RVOL for ${symbol}.`,
      );
      return null;
    }

    const totalHistoricalVolumeForTimeWindow = historicalDaysOnly.reduce(
      (sum, vol) => sum + vol,
      0,
    );
    const averageVolumeForTimeWindow =
      totalHistoricalVolumeForTimeWindow / historicalDaysOnly.length;

    // 5. Run the final ratio matching Ross Cameron's Pillar
    const relativeVolume = todayVolume / (averageVolumeForTimeWindow || 1);

    return {
      symbol,
      todayVolume,
      expectedVolumeByThisTime: Math.round(averageVolumeForTimeWindow),
      rvol: parseFloat(relativeVolume.toFixed(2)), // Ross wants this value >= 2.0+
    };
  } catch (error) {
    console.error(
      "Error computing time-of-day RVOL metrics via Polygon:",
      error,
    );
    throw error;
  }
}
