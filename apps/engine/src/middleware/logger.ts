import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import Alpaca from "@alpacahq/alpaca-trade-api";
import { TradeRecord, WinRateReport } from "@my-platform/types";

const DEFAULT_LOG_PATH = path.resolve(process.cwd(), "logs/trades.json");

interface AlpacaOrderHistoryClient {
  getOrders(query: {
    status: string;
    direction: string;
    until: undefined;
    after: undefined;
    limit: number;
    nested: boolean;
    symbols: string[];
  }): Promise<unknown>;
}

interface AlpacaOrderHistoryConstructor {
  new (config: { keyId: string; secretKey: string }): AlpacaOrderHistoryClient;
}

const AlpacaOrderHistory = Alpaca as unknown as AlpacaOrderHistoryConstructor;

export class TradeJournal {
  private persistenceQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filepath = DEFAULT_LOG_PATH) {}

  public async logTrade(trade: TradeRecord): Promise<void> {
    await this.enqueue(async () => {
      await mkdir(path.dirname(this.filepath), { recursive: true });
      await appendFile(this.filepath, `${JSON.stringify(trade)}\n`, "utf8");
    });
    console.log("Trade Logged");
  }

  public async getTradeHistory(): Promise<TradeRecord[]> {
    return this.read();
  }

  public async reconcileBrokerRecords(
    brokerRecords: TradeRecord[],
    snapshotStartedAt: string,
  ): Promise<TradeRecord[]> {
    return this.enqueue(async () => {
      const currentRecords = await this.read();
      const brokerRecordIds = new Set(brokerRecords.map(recordIdentity));
      const snapshotStartedAtMs = Date.parse(snapshotStartedAt);
      const retainedRecords = currentRecords.filter(
        (record) =>
          !brokerRecordIds.has(recordIdentity(record)) &&
          (!record.order_id ||
            Date.parse(record.timestamp) >= snapshotStartedAtMs),
      );
      const reconciled = dedupeRecords([...retainedRecords, ...brokerRecords]);

      await this.write(reconciled);
      return reconciled;
    });
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    let result: T | undefined;
    const persistOperation = async () => {
      result = await operation();
    };

    this.persistenceQueue = this.persistenceQueue.then(
      persistOperation,
      persistOperation,
    );
    await this.persistenceQueue;
    return result as T;
  }

  private async read(): Promise<TradeRecord[]> {
    try {
      const data = await readFile(this.filepath, "utf8");
      return data
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .flatMap((line, index) => parseTradeRecord(line, index));
    } catch (error) {
      if (isMissingFileError(error)) return [];
      console.error("❌ Failed to read local trade log:", error);
      return [];
    }
  }

  private async write(records: TradeRecord[]): Promise<void> {
    await mkdir(path.dirname(this.filepath), { recursive: true });
    const temporaryPath = `${this.filepath}.tmp`;
    const content = records.map((record) => JSON.stringify(record)).join("\n");
    await writeFile(temporaryPath, content ? `${content}\n` : "", "utf8");
    await rename(temporaryPath, this.filepath);
  }
}

export const tradeJournal = new TradeJournal();

export async function logTrade(trade: TradeRecord): Promise<void> {
  await tradeJournal.logTrade(trade);
}

export async function fetchTradeHistory() {
  const alpaca = new AlpacaOrderHistory({
    keyId: process.env.APCA_API_KEY_ID || "",
    secretKey: process.env.APCA_API_SECRET_KEY || "",
  });

  try {
    return await alpaca.getOrders({
      status: "filled",
      direction: "desc",
      until: undefined,
      after: undefined,
      limit: 500,
      nested: false,
      symbols: [],
    });
  } catch (error) {
    console.error("Error fetching trades:", error);
    return [];
  }
}

export async function getTradeHistory(): Promise<TradeRecord[]> {
  return tradeJournal.getTradeHistory();
}

export async function calculateWinRateMetrics(): Promise<WinRateReport> {
  const history = await getTradeHistory();
  const completedExits = history.filter((trade) => trade.reason === "Exit");

  if (completedExits.length === 0) {
    return {
      winRate: 0,
      totalCompletedTrades: 0,
      wins: 0,
      losses: 0,
      breakevens: 0,
      netRealizedPnL: 0,
    };
  }

  let wins = 0;
  let losses = 0;
  let breakevens = 0;
  let netRealizedPnL = 0;

  for (const trade of completedExits) {
    netRealizedPnL += trade.pnl || 0;

    if (trade.win_status === "WIN") {
      wins += 1;
    } else if (trade.win_status === "LOSS") {
      losses += 1;
    } else if (trade.win_status === "BREAKEVEN") {
      breakevens += 1;
    }
  }

  const totalDecisiveTrades = wins + losses;
  const winRate =
    totalDecisiveTrades > 0 ? (wins / totalDecisiveTrades) * 100 : 0;

  return {
    winRate: parseFloat(winRate.toFixed(2)),
    totalCompletedTrades: completedExits.length,
    wins,
    losses,
    breakevens,
    netRealizedPnL: parseFloat(netRealizedPnL.toFixed(2)),
  };
}

function parseTradeRecord(line: string, index: number): TradeRecord[] {
  try {
    const value: unknown = JSON.parse(line);
    return isTradeRecord(value) ? [value] : [];
  } catch {
    console.error(`❌ Parse Error on line ${index + 1}:`, line);
    return [];
  }
}

function dedupeRecords(records: TradeRecord[]): TradeRecord[] {
  const byIdentity = new Map<string, TradeRecord>();
  for (const record of records) {
    byIdentity.set(recordIdentity(record), record);
  }

  return Array.from(byIdentity.values()).sort(
    (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
  );
}

function recordIdentity(record: TradeRecord): string {
  return (
    record.order_id ??
    record.execution_id ??
    [
      record.symbol,
      record.side,
      record.qty,
      record.price,
      record.timestamp,
    ].join(":")
  );
}

function isTradeRecord(value: unknown): value is TradeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<TradeRecord>;
  return (
    typeof record.symbol === "string" &&
    (record.side === "buy" || record.side === "sell") &&
    typeof record.qty === "string" &&
    typeof record.price === "string" &&
    typeof record.timestamp === "string" &&
    typeof record.reason === "string" &&
    (record.win_status === "WIN" ||
      record.win_status === "LOSS" ||
      record.win_status === "BREAKEVEN" ||
      record.win_status === "OPENING")
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
