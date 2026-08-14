export type TradingSession =
  | "premarket"
  | "market"
  | "aftermarket"
  | "overnight";

export interface EasternTimeParts {
  dateKey: string;
  hour: number;
  minute: number;
}

function toDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid market timestamp: ${String(value)}`);
  }

  return date;
}

/**
 * Converts a timestamp to an America/New_York session date and time. Supplying
 * a bar timestamp keeps historical replay deterministic while the default
 * preserves the live engine's current-time behaviour.
 */
export function getEasternTimeParts(
  timestamp: Date | string = new Date(),
): EasternTimeParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(toDate(timestamp));

  const valueFor = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "0";

  const year = valueFor("year");
  const month = valueFor("month");
  const day = valueFor("day");

  return {
    dateKey: `${year}-${month}-${day}`,
    hour: Number.parseInt(valueFor("hour"), 10),
    minute: Number.parseInt(valueFor("minute"), 10),
  };
}

/**
 * Returns the U.S. market session at the supplied timestamp. The timestamp is
 * optional only for live callers; strategies should pass their bar timestamp.
 */
export default function getTradingSession(
  timestamp: Date | string = new Date(),
): TradingSession {
  const { hour, minute } = getEasternTimeParts(timestamp);
  const totalMinutes = hour * 60 + minute;

  const premarketStart = 4 * 60;
  const marketOpen = 9 * 60 + 30;
  const marketClose = 16 * 60;
  const aftermarketEnd = 20 * 60;

  if (totalMinutes >= premarketStart && totalMinutes < marketOpen) {
    return "premarket";
  }

  if (totalMinutes >= marketOpen && totalMinutes < marketClose) {
    return "market";
  }

  if (totalMinutes >= marketClose && totalMinutes < aftermarketEnd) {
    return "aftermarket";
  }

  return "overnight";
}
