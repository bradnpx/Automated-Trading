import Alpaca from "@alpacahq/alpaca-trade-api";
import dotenv from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_FEEDS = new Set(["iex", "sip", "otc"]);
const SUPPORTED_TIMEFRAMES = new Set(["1Min", "5Min", "15Min", "1Hour", "1Day"]);

interface ExportOptions {
  symbol: string;
  start: Date;
  end: Date;
  timeframe: string;
  feed: string;
  outputPath: string;
}

interface CsvBar {
  timestamp: string;
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../../..");
dotenv.config({ path: path.join(repositoryRoot, ".env") });

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const client = createAlpacaClient();
  const bars = await fetchBars(client, options);

  if (bars.length === 0) {
    throw new Error(
      `Alpaca returned no ${options.timeframe} bars for ${options.symbol} in the requested range.`,
    );
  }

  await writeCsv(options.outputPath, bars);
  process.stdout.write(
    [
      `Saved ${bars.length} ${options.timeframe} bars for ${options.symbol}.`,
      `Range: ${bars[0].timestamp} to ${bars[bars.length - 1].timestamp}.`,
      `File: ${options.outputPath}`,
    ].join("\n") + "\n",
  );
}

function parseOptions(argumentsList: string[]): ExportOptions {
  if (argumentsList.includes("--help") || argumentsList.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const values = parseNamedArguments(argumentsList);
  const symbol = requiredValue(values, "symbol").toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-/]{0,14}$/.test(symbol)) {
    throw new Error("--symbol must be a valid Alpaca symbol, such as AAPL or BRK.B");
  }

  const end = values.has("end") ? parseDate(requiredValue(values, "end"), "--end") : new Date();
  const start = resolveStartDate(values, end);
  const timeframe = values.get("timeframe") ?? "1Min";
  const feed = values.get("feed") ?? "iex";

  if (!SUPPORTED_TIMEFRAMES.has(timeframe)) {
    throw new Error(
      `--timeframe must be one of: ${[...SUPPORTED_TIMEFRAMES].join(", ")}`,
    );
  }
  if (!SUPPORTED_FEEDS.has(feed)) {
    throw new Error(`--feed must be one of: ${[...SUPPORTED_FEEDS].join(", ")}`);
  }
  if (start >= end) {
    throw new Error("The start date must be earlier than the end date");
  }

  const defaultFilename = `${symbol.toLowerCase()}-${formatFileDate(start)}-to-${formatFileDate(end)}-${timeframe.toLowerCase()}.csv`;
  const outputArgument = values.get("output") ?? path.join("apps", "backtest", "data", defaultFilename);

  return {
    symbol,
    start,
    end,
    timeframe,
    feed,
    outputPath: path.resolve(repositoryRoot, outputArgument),
  };
}

function parseNamedArguments(argumentsList: string[]): Map<string, string> {
  const values = new Map<string, string>();
  const filteredArguments =
    argumentsList[0] === "--" ? argumentsList.slice(1) : argumentsList;

  for (let index = 0; index < filteredArguments.length; index += 1) {
    const argument = filteredArguments[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }

    const name = argument.slice(2);
    const value = filteredArguments[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    if (values.has(name)) {
      throw new Error(`--${name} may only be supplied once`);
    }

    values.set(name, value);
    index += 1;
  }

  return values;
}

function resolveStartDate(values: Map<string, string>, end: Date): Date {
  const suppliedStart = values.get("start");
  const suppliedDays = values.get("days");

  if (suppliedStart && suppliedDays) {
    throw new Error("Use either --start or --days, not both");
  }
  if (suppliedStart) {
    return parseDate(suppliedStart, "--start");
  }

  const days = suppliedDays === undefined ? 30 : Number(suppliedDays);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error("--days must be an integer between 1 and 3650");
  }

  return new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
}

function parseDate(value: string, optionName: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${optionName} must be an ISO date or timestamp`);
  }
  return date;
}

function createAlpacaClient(): Alpaca {
  const keyId = process.env.APCA_API_KEY_ID ?? process.env.ALPACA_API_KEY;
  const secretKey =
    process.env.APCA_API_SECRET_KEY ?? process.env.ALPACA_API_SECRET_KEY;

  if (!keyId || !secretKey) {
    throw new Error(
      "Missing Alpaca credentials. Set APCA_API_KEY_ID and APCA_API_SECRET_KEY in the repository .env file.",
    );
  }

  return new Alpaca({ keyId, secretKey, paper: true });
}

async function fetchBars(client: Alpaca, options: ExportOptions): Promise<CsvBar[]> {
  const response = client.getBarsV2(options.symbol, {
    start: options.start.toISOString(),
    end: options.end.toISOString(),
    timeframe: options.timeframe,
    adjustment: "all",
    feed: options.feed,
  });

  const bars: CsvBar[] = [];
  for await (const bar of response) {
    const normalized = normalizeBar(bar, options.symbol);
    if (normalized) {
      bars.push(normalized);
    }
  }

  return bars.sort(
    (left, right) =>
      new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime(),
  );
}

function normalizeBar(bar: Record<string, unknown>, symbol: string): CsvBar | null {
  const timestamp = bar.Timestamp ?? bar.timestamp;
  const open = toNumber(bar.OpenPrice ?? bar.open);
  const high = toNumber(bar.HighPrice ?? bar.high);
  const low = toNumber(bar.LowPrice ?? bar.low);
  const close = toNumber(bar.ClosePrice ?? bar.close);
  const volume = toNumber(bar.Volume ?? bar.volume);

  if (
    timestamp === undefined ||
    open === null ||
    high === null ||
    low === null ||
    close === null ||
    volume === null
  ) {
    return null;
  }

  const date = new Date(String(timestamp));
  if (
    Number.isNaN(date.getTime()) ||
    open <= 0 ||
    high <= 0 ||
    low <= 0 ||
    close <= 0 ||
    volume < 0 ||
    low > Math.min(open, close) ||
    high < Math.max(open, close)
  ) {
    return null;
  }

  return {
    timestamp: date.toISOString(),
    symbol,
    open,
    high,
    low,
    close,
    volume,
  };
}

function toNumber(value: unknown): number | null {
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : null;
}

async function writeCsv(outputPath: string, bars: CsvBar[]): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const header = "timestamp,symbol,open,high,low,close,volume";
  const records = bars.map((bar) =>
    [
      bar.timestamp,
      bar.symbol,
      bar.open,
      bar.high,
      bar.low,
      bar.close,
      bar.volume,
    ].join(","),
  );

  await writeFile(outputPath, `${[header, ...records].join("\n")}\n`, "utf8");
}

function requiredValue(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) {
    throw new Error(`Missing required argument --${name}`);
  }
  return value;
}

function formatFileDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function printHelp(): void {
  process.stdout.write(`Alpaca historical-data downloader\n\nUsage:\n  pnpm --filter backtest download-alpaca -- --symbol AAPL --days 90\n\nRequired:\n  --symbol <ticker>       Alpaca market-data symbol, for example AAPL\n\nDate range (choose one):\n  --days <integer>        Number of calendar days ending now or at --end; default 30\n  --start <ISO date>      Inclusive start date, such as 2025-01-01\n  --end <ISO date>        Exclusive end date; defaults to the current time\n\nOptional:\n  --timeframe <value>     1Min, 5Min, 15Min, 1Hour, or 1Day; default 1Min\n  --feed <value>          iex, sip, or otc; default iex\n  --output <path>         CSV path relative to repository root\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown download failure";
  process.stderr.write(`Alpaca download failed: ${message}\n`);
  process.exitCode = 1;
});
