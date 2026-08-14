import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadHistoricalData } from "./data.js";
import { BacktestEngine } from "./engine.js";
import { renderBacktestMarkdown } from "./report.js";
import { BacktestConfig } from "./types.js";

const STRATEGY_IDS = [
  "basicStrategy",
  "dayTradeMicroScalp",
  "pdlSweepVWAPReclaim",
  "biotechMomentum",
  "fifteenMinMorningBounce",
  "buyAndHold",
  "donchianBreakout",
  "rsiReversion",
  "smaCross",
] as const;

async function main(): Promise<void> {
  const argumentsByName = parseArguments(process.argv.slice(2));
  const dataPath = requiredArgument(argumentsByName, "data");
  const configPath = requiredArgument(argumentsByName, "config");
  const outputDirectory = argumentsByName.get("output") ?? "backtest-results";

  const inputRoot = process.env.INIT_CWD ?? process.cwd();
  const [dataSet, config] = await Promise.all([
    loadHistoricalData(resolve(inputRoot, dataPath)),
    loadBacktestConfig(resolve(inputRoot, configPath)),
  ]);
  const result = await new BacktestEngine().run(dataSet.bars, config);
  const resolvedOutputDirectory = resolve(inputRoot, outputDirectory);

  await mkdir(resolvedOutputDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      resolve(resolvedOutputDirectory, "result.json"),
      `${JSON.stringify({ ...result, dataSource: dataSet.source }, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      resolve(resolvedOutputDirectory, "report.md"),
      renderBacktestMarkdown(result),
      "utf8",
    ),
  ]);

  process.stdout.write(
    `Backtest complete: ${result.metrics.closedTrades} closed trades, ${result.metrics.winRatePct.toFixed(2)}% win rate.\nResults: ${resolvedOutputDirectory}\n`,
  );
}

function parseArguments(values: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  const commandArguments = values[0] === "--" ? values.slice(1) : values;

  for (let index = 0; index < commandArguments.length; index += 1) {
    const argument = commandArguments[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }

    const name = argument.slice(2);
    const value = commandArguments[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }

    parsed.set(name, value);
    index += 1;
  }

  return parsed;
}

function requiredArgument(argumentsByName: Map<string, string>, name: string): string {
  const value = argumentsByName.get(name);
  if (!value) {
    throw new Error(`Missing required argument --${name}`);
  }

  return value;
}

async function loadBacktestConfig(path: string): Promise<BacktestConfig> {
  const contents = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(contents);

  if (!isRecord(parsed)) {
    throw new Error("Backtest config must be a JSON object");
  }

  const strategyId = readStrategyId(parsed, "strategyId");
  return {
    strategyId,
    initialCash: readNumber(parsed, "initialCash"),
    riskPerTrade: readNumber(parsed, "riskPerTrade"),
    positionSizingMethod: readPositionSizingMethod(parsed, "positionSizingMethod"),
    maxPositionPct: readNumber(parsed, "maxPositionPct"),
    stopLossPct: readNullableNumber(parsed, "stopLossPct"),
    takeProfitPct: readNullableNumber(parsed, "takeProfitPct"),
    slippageBps: readNumber(parsed, "slippageBps"),
    commissionPerOrder: readNumber(parsed, "commissionPerOrder"),
    intrabarFillPriority: readIntrabarFillPriority(parsed, "intrabarFillPriority"),
    closeOpenPositionsAtEnd: readBoolean(parsed, "closeOpenPositionsAtEnd"),
    strategyParameters: readStrategyParameters(parsed.strategyParameters),
  };
}

function readStrategyId(
  config: Record<string, unknown>,
  key: string,
): BacktestConfig["strategyId"] {
  const value = config[key];
  if (typeof value === "string" && STRATEGY_IDS.includes(value as BacktestConfig["strategyId"])) {
    return value as BacktestConfig["strategyId"];
  }

  throw new Error(`${key} must be a registered strategy identifier`);
}

function readPositionSizingMethod(
  config: Record<string, unknown>,
  key: string,
): BacktestConfig["positionSizingMethod"] {
  const value = config[key];
  if (value === "risk-to-stop" || value === "equity-fraction") {
    return value;
  }

  throw new Error(`${key} must be risk-to-stop or equity-fraction`);
}

function readIntrabarFillPriority(
  config: Record<string, unknown>,
  key: string,
): BacktestConfig["intrabarFillPriority"] {
  const value = config[key];
  if (value === "stop-first" || value === "target-first") {
    return value;
  }

  throw new Error(`${key} must be stop-first or target-first`);
}

function readNumber(config: Record<string, unknown>, key: string): number {
  const value = config[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  throw new Error(`${key} must be a finite number`);
}

function readNullableNumber(
  config: Record<string, unknown>,
  key: string,
): number | null {
  const value = config[key];
  if (value === null) {
    return null;
  }

  return readNumber(config, key);
}

function readBoolean(config: Record<string, unknown>, key: string): boolean {
  const value = config[key];
  if (typeof value === "boolean") {
    return value;
  }

  throw new Error(`${key} must be a boolean`);
}

function readStrategyParameters(value: unknown): BacktestConfig["strategyParameters"] {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("strategyParameters must be a JSON object when provided");
  }

  const parameters: Record<string, number> = {};
  for (const [key, parameterValue] of Object.entries(value)) {
    if (typeof parameterValue !== "number" || !Number.isFinite(parameterValue)) {
      throw new Error(`strategyParameters.${key} must be a finite number`);
    }
    parameters[key] = parameterValue;
  }

  return parameters;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown backtest failure";
  process.stderr.write(`Backtest failed: ${message}\n`);
  process.exitCode = 1;
});
