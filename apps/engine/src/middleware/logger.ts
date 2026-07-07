import fs from "fs/promises";
import path from "path";
import { TradeRecord, WinRateReport } from "@my-platform/types";
import { SYMBOL_STRATEGY_MAP } from "../config/config.js";

// We import Alpaca if needed, though getAccountActivities might need a configured instance
// If AlpacaService isn't globally available, we can instantiate it or pass it.
import Alpaca from "@alpacahq/alpaca-trade-api";

interface TradeLog {
    id: string;
    activity_type: string;
    transaction_time: string;
    type: string;
    price: string;
    qty: string;
    side: string;
    symbol: string;
    leaves_qty: string;
    order_id: string;
    cum_qty: string;
    order_status: string;
    strategy?: string;
}

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

export async function fetchTradeHistory(): Promise<TradeLog[] | string> {
  // Create a temporary instance to fetch activities. 
  // In production, you might want to pass the existing alpaca instance to this function.
  const alpaca = new Alpaca();
  try {
    const tradeHistory = await alpaca.getAccountActivities({
      activityTypes: "FILL",
    });
    console.log("Fetched trade history from Alpaca");
    
    // The Alpaca API returns activities in descending order (newest first).
    // We should process them in chronological order (oldest first) to group trades properly.
    const chronologicalHistory = (tradeHistory as any[]).reverse();
    
    return handleHistory(chronologicalHistory);
  } catch (error) {
    console.log(`Error fetching trade logs from Alpaca service: ${error}`);
    return `Error fetching trade logs from Alpaca service: ${error}`;
  }
}

function handleHistory(history: TradeLog[]) {
  const fullTrades = groupTrades(history);
  
  console.log(`history: ${history.length}, completed trades: ${fullTrades ? fullTrades.length : 0}`);
  return history;
}

function checkStrategy(symbol: string): string | null {
  try {
    const strategyItem = SYMBOL_STRATEGY_MAP.get(symbol);
    return strategyItem ? strategyItem.strategy : null;
  } catch (err) {
    console.error(`checkStrategy failed: ${err}`);
    return null;
  }
}

export type CompleteTrade = {
  symbol: string;
  totalQty: number;
  openPrice: number;
  closePrice: number;
  pnl: number;
  isSuccess: boolean;
  strategy: string | null;
  openedOn: string;
  fullyClosedOn: string;
  trades: TradeLog[];
}

/**
 * Find open and close bookends for positions to track profit/winloss
 * @param trades - Chronological list of trade activities
 * @returns Array of completed trades
 */
export function groupTrades(trades: TradeLog[]): CompleteTrade[] | null {
  if (!trades || trades.length === 0) {
    return null;
  }

  const openBuys = new Map<string, MapData>();
  const closedCombos: CompleteTrade[] = [];

  type MapData = {
    qty: number;
    sharesToSell: number;
    buyPrices: number[];
    sellPrices: number[];
    highestQty: number;
    trades: TradeLog[];
  };

  for (const trade of trades) {
    if (!trade.symbol) continue;

    if (!openBuys.has(trade.symbol)) {
      openBuys.set(trade.symbol, {
        qty: 0,
        sharesToSell: 0,
        buyPrices: [],
        sellPrices: [],
        highestQty: 0,
        trades: [],
      });
    }

    const mapData = openBuys.get(trade.symbol)!;
    
    const tradeQty = Number(trade.qty);
    const tradePrice = Number(trade.price);
    
    // For a long strategy:
    // buy increases shares we hold (sharesToSell increases)
    // sell decreases shares we hold (sharesToSell decreases)
    
    // In the user's logic, sharesToSell starts at 0. 
    // When buying, we add to it. When selling, we subtract.
    
    if (trade.side === "buy") {
      mapData.buyPrices.push(tradePrice);
      mapData.highestQty += tradeQty;
      mapData.sharesToSell += tradeQty;
    } else if (trade.side === "sell") {
      mapData.sellPrices.push(tradePrice);
      mapData.sharesToSell -= tradeQty;
    }

    mapData.trades.push(trade);

    // If we have zeroed out our position (or gone short, which we treat as closed for this simple grouping)
    // We only close if we actually had some buys before (highestQty > 0)
    if (mapData.sharesToSell <= 0 && mapData.highestQty > 0) {
      const avgBuyPrice = mapData.buyPrices.length > 0 
        ? mapData.buyPrices.reduce((total, num) => total + num, 0) / mapData.buyPrices.length
        : 0;
        
      const avgSellPrice = mapData.sellPrices.length > 0
        ? mapData.sellPrices.reduce((total, num) => total + num, 0) / mapData.sellPrices.length
        : 0;

      const pnl = (avgSellPrice - avgBuyPrice) * mapData.highestQty;
      
      const fullTrade: CompleteTrade = {
        symbol: trade.symbol,
        totalQty: mapData.highestQty,
        openPrice: avgBuyPrice,
        closePrice: avgSellPrice,
        pnl: pnl,
        isSuccess: pnl > 0,
        strategy: checkStrategy(trade.symbol),
        openedOn: mapData.trades[0].transaction_time,
        fullyClosedOn: trade.transaction_time,
        trades: [...mapData.trades],
      };

      closedCombos.push(fullTrade);
      openBuys.delete(trade.symbol);
    }
  }

  return closedCombos;
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
  const winRate = totalDecisiveTrades > 0 ? (wins / totalDecisiveTrades) * 100 : 0

  return {
    winRate: parseFloat(winRate.toFixed(2)),
    totalCompletedTrades: completedExits.length,
    wins,
    losses,
    breakevens,
    netRealizedPnL: parseFloat(netRealizedPnL.toFixed(2))
  }
}
