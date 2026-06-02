import axios from "axios";
import { POLYGON_API } from "../config";

interface PolygonFloatResponse {
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
  ticker: string,
): Promise<number | null> {
  const url = `https://api.massive.com/stocks/vX/float`;

  try {
    const response = await axios.get<PolygonFloatResponse>(url, {
      params: {
        ticker: ticker.toUpperCase(),
        apiKey: POLYGON_API,
      },
    });

    // console.log("[API Payload Debug]:", JSON.stringify(response.data, null, 2));

    if (
      response.data.status === "OK" &&
      response.data.results &&
      response.data.results.length > 0
    ) {
      return response.data.results[0].free_float ?? null;
    }

    return null;
  } catch (error) {
    console.error(
      `[Polygon API Error] Failed to fetch float for ${ticker}:`,
      error,
    );
    return null;
  }
}
