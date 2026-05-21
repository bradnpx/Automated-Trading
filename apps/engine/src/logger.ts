import fs from "fs/promises";
import path from "path";
import { TradeRecord } from "@my-platform/types";

const LOG_PATH = path.resolve(process.cwd(), "logs/trades.json");

export async function logTrade(trade: TradeRecord) {
  const entry = JSON.stringify(trade).replace(/\n/g, "") + "\n";
  try {
    await fs.appendFile(LOG_PATH, entry, "utf8");
  } catch (err) {
    console.error("❌ Failed to write to log file", err);
  }
  console.log("Trade Logged");
}

export async function getTradeHistory() {
  try {
    const data = await fs.readFile(LOG_PATH, "utf8");

    // Split by line, trim whitespace, and filter out empty lines
    return data
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (e) {
          console.error(`❌ Parse Error on line ${index + 1}:`, line);
          return null;
        }
      })
      .filter((item) => item !== null);
  } catch (err) {
    return [];
  }
}