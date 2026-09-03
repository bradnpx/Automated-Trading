import axios from "axios";
import { POLYGON_API } from "../config/config";
import { yFinance } from "../services/yfinance";
import { response } from "express";

interface FloatResponse {
  status: string;
  results?: {
    free_float?: number; // Marked optional to catch structural mismatches safely
    free_float_percent: number;
    effective_date: string;
  }[];
}

/**
 * Fetches the public free float for a given ticker from Polygon.io -> Now Massive.com
 */
export async function getPublicFreeFloat(
  symbol: string,
): Promise<number | null> {
  const url = `https://api.massive.com/stocks/vX/float`;
  const ticker = symbol.replaceAll(".", "-");

  try {
    const result = await yFinance.quoteSummary(ticker, {
      modules: ["defaultKeyStatistics"],
    });

    console.log(
      `☀️yfinance float call for ${symbol} (${ticker}):`,
      result.defaultKeyStatistics?.floatShares,
    );
    return result.defaultKeyStatistics?.floatShares ?? null;
  } catch (error) {
    console.error(`Failed to fetch float for ${ticker}:`);
    return null;
  }
}
