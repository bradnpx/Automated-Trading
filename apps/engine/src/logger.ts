import fs from "fs/promises";
import path from "path";
import { TradeRecord } from "@my-platform/types";

const LOG_PATH = path.resolve(process.cwd(), "logs/trades.json");

export async function logTrade(record: TradeRecord) {
  try {
    await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });

    const logEntry = JSON.stringify(record) + "\n";
    await fs.appendFile(LOG_PATH, logEntry, "utf8");
  } catch (err) {
    console.error("❌ Failed to log trade:", err);
  }
}

export async function getTradeHistory(): Promise<TradeRecord[]> {
  try {
    const data = await fs.readFile(LOG_PATH, "utf8");
    return data
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch (err) {
    return [];
  }
}
