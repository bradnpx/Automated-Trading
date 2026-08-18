import { readFile } from "node:fs/promises";

import { Bar, BarSchema } from "@my-platform/types";

import { HistoricalDataSet } from "./types.js";

const REQUIRED_COLUMNS = ["timestamp", "symbol", "open", "high", "low", "close", "volume"] as const;

type RequiredColumn = (typeof REQUIRED_COLUMNS)[number];

const COLUMN_ALIASES: Record<RequiredColumn, string[]> = {
  timestamp: ["timestamp", "time", "datetime", "date"],
  symbol: ["symbol", "ticker"],
  open: ["open", "o"],
  high: ["high", "h"],
  low: ["low", "l"],
  close: ["close", "c"],
  volume: ["volume", "v"],
};

export async function loadHistoricalData(
  path: string,
): Promise<HistoricalDataSet> {
  const contents = await readFile(path, "utf8");
  const bars = path.toLowerCase().endsWith(".json")
    ? parseJsonBars(contents)
    : parseCsvBars(contents);

  validateAndSortBars(bars);

  return { bars, source: path };
}

function parseJsonBars(contents: string): Bar[] {
  const parsed: unknown = JSON.parse(contents);
  const candidates = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.bars)
      ? parsed.bars
      : null;

  if (!candidates) {
    throw new Error("JSON historical data must be an array of bars or an object with a bars array");
  }

  return candidates.map((candidate, index) => {
    const result = BarSchema.safeParse(candidate);
    if (!result.success) {
      throw new Error(`Invalid JSON bar at index ${index}: ${result.error.message}`);
    }

    return result.data;
  });
}

function parseCsvBars(contents: string): Bar[] {
  const lines = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    throw new Error("CSV historical data requires a header row and at least one bar");
  }

  const header = parseCsvLine(lines[0]).map((value) => value.toLowerCase());
  const indexes = resolveColumnIndexes(header);

  return lines.slice(1).map((line, index) => {
    const values = parseCsvLine(line);
    const rawBar = {
      timestamp: readCsvValue(values, indexes.timestamp, index),
      symbol: readCsvValue(values, indexes.symbol, index),
      open: parseNumber(readCsvValue(values, indexes.open, index), "open", index),
      high: parseNumber(readCsvValue(values, indexes.high, index), "high", index),
      low: parseNumber(readCsvValue(values, indexes.low, index), "low", index),
      close: parseNumber(readCsvValue(values, indexes.close, index), "close", index),
      volume: parseNumber(readCsvValue(values, indexes.volume, index), "volume", index),
    };
    const result = BarSchema.safeParse(rawBar);

    if (!result.success) {
      throw new Error(`Invalid CSV bar on data row ${index + 2}: ${result.error.message}`);
    }

    return result.data;
  });
}

function resolveColumnIndexes(header: string[]): Record<RequiredColumn, number> {
  const indexes = {} as Record<RequiredColumn, number>;

  for (const column of REQUIRED_COLUMNS) {
    const index = header.findIndex((value) => COLUMN_ALIASES[column].includes(value));
    if (index < 0) {
      throw new Error(`CSV historical data is missing a ${column} column`);
    }
    indexes[column] = index;
  }

  return indexes;
}

function readCsvValue(values: string[], index: number, rowIndex: number): string {
  const value = values[index];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing CSV value on data row ${rowIndex + 2}`);
  }

  return value;
}

function parseNumber(value: string, field: string, rowIndex: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${field} value on data row ${rowIndex + 2}`);
  }

  return parsed;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === '"' && inQuotes && nextCharacter === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      inQuotes = !inQuotes;
    } else if (character === "," && !inQuotes) {
      values.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }

  if (inQuotes) {
    throw new Error("Unterminated quoted CSV value");
  }

  values.push(value.trim());
  return values;
}

function validateAndSortBars(bars: Bar[]): void {
  if (bars.length === 0) {
    throw new Error("Historical data contains no bars");
  }

  bars.sort((left, right) => toMilliseconds(left.timestamp) - toMilliseconds(right.timestamp));

  const lastTimestampBySymbol = new Map<string, number>();
  for (const bar of bars) {
    validateOhlcv(bar);

    const timestamp = toMilliseconds(bar.timestamp);
    const lastTimestamp = lastTimestampBySymbol.get(bar.symbol);
    if (lastTimestamp !== undefined && timestamp <= lastTimestamp) {
      throw new Error(
        `Bars for ${bar.symbol} must have unique, strictly increasing timestamps`,
      );
    }
    lastTimestampBySymbol.set(bar.symbol, timestamp);
  }
}

function validateOhlcv(bar: Bar): void {
  if (!(bar.open > 0 && bar.high > 0 && bar.low > 0 && bar.close > 0)) {
    throw new Error(`OHLC values must be positive for ${bar.symbol}`);
  }

  if (!(bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close))) {
    throw new Error(`Inconsistent OHLC range for ${bar.symbol} at ${String(bar.timestamp)}`);
  }

  if (!(bar.volume >= 0)) {
    throw new Error(`Volume cannot be negative for ${bar.symbol}`);
  }

  toMilliseconds(bar.timestamp);
}

function toMilliseconds(timestamp: Date | string): number {
  const value = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
  if (Number.isNaN(value)) {
    throw new Error(`Invalid timestamp: ${String(timestamp)}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
