import * as fs from 'fs';
import * as path from 'path';
import * as z from 'zod';
import { MASTER_WATCHLIST } from "../config/config";


export class Portfolio {
  private filepath = path.join(__dirname, "portfolio.json");
  private openTrades = new Map();
  constructor(getTrades) {
    this.openTrades = getTrades;
  }

  saveTradesToLocal(portfolio) {
    try {
      const jsonString = JSON.stringify(portfolio, null, 2);
      fs.writeFileSync(this.filepath, jsonString, "utf8");
      console.log("💾 portfolio saved locally!");
    } catch (error) {
      console.error("Error writing JSON file:", error);
    }
  }

  loadTradesFromLocal(): Map<string, unknown> | null {
    try {
      if (!fs.existsSync(this.filepath)) {
        console.warn("No saved portfolio file found. Initializing empty list");
        return null;
      }

      const fileContents = fs.readFileSync(this.filepath, "utf8");
      const rawData: unknown = JSON.parse(fileContents);
      const dataMap = new Map<string, unknown>(Object.entries(rawData));
    //   const validationResult = z.array(OpenTradeSchema).safeParse(rawData);

    //   if (!validationResult.success) {
    //     console.error(
    //       "The saved file content format is invalid:",
    //       validationResult.error.format(),
    //     );
    //     return null;
    //   }
      return dataMap;

    } catch (error) {
      console.error("Error reading or parsing the trade backup file:", error);
      return null;
    }
  }

  syncTrades() {
    const trades = this.loadTradesFromLocal();
    if (!trades || trades.length === 0) {
      //sync trades
      // return this.openTrades
    } else {
    }
    this.openTrades = trades;
  }

  getStrategyForTrade(symbol: string) {
    if (!symbol || typeof symbol !== "string") {
      return null;
    }

    return MASTER_WATCHLIST.get(symbol);
  }

  addTrade(trade) {
    const strategyConfig = this.getStrategyForTrade(trade.symbol);
    if (strategyConfig) {
      Object.assign(trade, {
        strategy: strategyConfig.strategy,
        takeProfitPct: strategyConfig.takeProfitPct,
        stopLossPct: strategyConfig.stopLossPct,
        totalRisk: strategyConfig.totalRisk,
        expiration: strategyConfig.expiration,
      });
    }
    this.openTrades.set(trade.id, trade);
  }

  closeTrade(id: string) {
    this.openTrades.delete(id);
  }
}
