import YahooFinance from "yahoo-finance2";

/** Shared client for Yahoo Finance reference data used by strategy rules. */
export const yFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
});
