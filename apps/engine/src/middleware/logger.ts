import fs from "fs/promises";
import path from "path";
import { TradeRecord, WinRateReport } from "@my-platform/types";

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

export async function calculateWinRateMetrics(): Promise<WinRateReport> {
  const history = await getTradeHistory();

  const completedExits = history.filter(
    (trade: any) => trade.reason === "Exit",
  );

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
      wins++;
    } else if (trade.win_status === "LOSS") {
      losses++;
    } else if (trade.win_status === "BREAKEVEN") {
      breakevens++;
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
