import { Bar } from "@my-platform/types";

/**
 * Returns the current US market session based on Eastern Time.
 *
 * Fix: the previous implementation hardcoded UTC-4, which is only correct during
 * EDT (summer). During EST (winter, Nov–Mar) the correct offset is UTC-5, causing
 * the opening window to be misclassified by a full hour. We now derive the offset
 * dynamically by comparing the local UTC time against the Eastern locale string.
 */
function getEasternHourAndMinute(): { hour: number; minute: number } {
  const now = new Date();

  // Use Intl to get the current wall-clock time in New York, which automatically
  // accounts for both EST (UTC-5) and EDT (UTC-4) depending on the date.
  const easternParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);

  const hour = parseInt(
    easternParts.find((p) => p.type === "hour")?.value ?? "0",
    10,
  );
  const minute = parseInt(
    easternParts.find((p) => p.type === "minute")?.value ?? "0",
    10,
  );

  return { hour, minute };
}

export default function getTradingSession() {
  const { hour, minute } = getEasternHourAndMinute();
  const totalMinutes = hour * 60 + minute;

  // Premarket:   4:00 AM – 9:29 AM ET
  // Market:      9:30 AM – 4:00 PM ET
  // Aftermarket: 4:01 PM – 8:00 PM ET
  // Overnight:   everything else

  const PREMARKET_START  = 4 * 60;        // 04:00
  const MARKET_OPEN      = 9 * 60 + 30;   // 09:30
  const MARKET_CLOSE     = 16 * 60;       // 16:00
  const AFTERMARKET_END  = 20 * 60;       // 20:00

  if (totalMinutes >= PREMARKET_START && totalMinutes < MARKET_OPEN) {
    return "premarket";
  } else if (totalMinutes >= MARKET_OPEN && totalMinutes < MARKET_CLOSE) {
    return "market";
  } else if (totalMinutes >= MARKET_CLOSE && totalMinutes < AFTERMARKET_END) {
    return "aftermarket";
  } else {
    return "overnight";
  }
}
