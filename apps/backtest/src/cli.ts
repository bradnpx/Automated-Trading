import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadHistoricalData } from "./data.js";
import { BacktestEngine, BacktestProgress } from "./engine.js";
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

interface RunInputs {
  dataPath: string;
  configPath: string;
  outputDirectory: string;
  description: string;
}

async function main(): Promise<void> {
  const argumentsByName = parseArguments(process.argv.slice(2));
  if (argumentsByName.has("help")) {
    printHelp();
    return;
  }

  const inputRoot = process.env.INIT_CWD ?? process.cwd();
  const runInputs = resolveRunInputs(argumentsByName, inputRoot);
  const [dataSet, config] = await Promise.all([
    loadHistoricalData(runInputs.dataPath),
    loadBacktestConfig(runInputs.configPath),
  ]);

  process.stdout.write(
    `Starting ${runInputs.description}: ${dataSet.bars.length.toLocaleString()} bars.\n`,
  );
  const result = await new BacktestEngine().run(dataSet.bars, config, {
    onProgress: renderProgress,
  });

  await mkdir(runInputs.outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      resolve(runInputs.outputDirectory, "result.json"),
      `${JSON.stringify({ ...result, dataSource: dataSet.source }, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      resolve(runInputs.outputDirectory, "report.md"),
      renderBacktestMarkdown(result),
      "utf8",
    ),
  ]);

  process.stdout.write(
    `Backtest complete: ${result.metrics.closedTrades} closed trades, ${result.metrics.winRatePct.toFixed(2)}% win rate.\nResults: ${runInputs.outputDirectory}\n`,
  );
}

function resolveRunInputs(
  argumentsByName: Map<string, string>,
  inputRoot: string,
): RunInputs {
  const strategy = argumentsByName.get("strategy");
  const dataPath = argumentsByName.get("data");
  const configPath = argumentsByName.get("config");
  const outputDirectory = argumentsByName.get("output");

  if (strategy) {
    if (dataPath || configPath) {
      throw new Error("Use either --strategy or both --data and --config, not both modes");
    }

    const strategyId = readStrategyId({ strategyId: strategy }, "strategyId");
    const fixtureDirectory = resolve(
      inputRoot,
      "apps",
      "backtest",
      "fixtures",
      strategyId,
    );

    return {
      dataPath: resolve(fixtureDirectory, `${strategyId}.csv`),
      configPath: resolve(fixtureDirectory, `${strategyId}.json`),
      outputDirectory: resolve(
        inputRoot,
        outputDirectory ?? "backtest-results",
        strategyId,
      ),
      description: `fixture strategy ${strategyId}`,
    };
  }

  if (!dataPath || !configPath) {
    throw new Error("Provide --strategy <strategyId>, or provide both --data and --config");
  }

  return {
    dataPath: resolve(inputRoot, dataPath),
    configPath: resolve(inputRoot, configPath),
    outputDirectory: resolve(inputRoot, outputDirectory ?? "backtest-results"),
    description: "explicit data and configuration files",
  };
}

function parseArguments(values: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  const commandArguments = values[0] === "--" ? values.slice(1) : values;

  for (let index = 0; index < commandArguments.length; index += 1) {
    const argument = commandArguments[index];
    if (argument === "--help") {
      parsed.set("help", "true");
      continue;
    }
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }

    const name = argument.slice(2);
    const value = commandArguments[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    if (parsed.has(name)) {
      throw new Error(`--${name} may only be supplied once`);
    }

    parsed.set(name, value);
    index += 1;
  }

  return parsed;
}

function renderProgress(progress: BacktestProgress): void {
  const barWidth = 30;
  const percent = Math.floor(progress.percentComplete);
  const filledWidth = Math.round((percent / 100) * barWidth);
  const bar = `${"#".repeat(filledWidth)}${"-".repeat(barWidth - filledWidth)}`;

  process.stdout.write(
    `\rReplay [${bar}] ${String(percent).padStart(3)}% (${progress.completedBars.toLocaleString()}/${progress.totalBars.toLocaleString()} bars)`,
  );

  if (progress.completedBars === progress.totalBars) {
    process.stdout.write("\n");
  }
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
  if (
    typeof value === "string" &&
    STRATEGY_IDS.includes(value as BacktestConfig["strategyId"])
  ) {
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

function printHelp(): void {
  process.stdout.write(`Backtest runner\n\nSimplified fixture run:\n  pnpm --filter backtest backtest -- --strategy smaCross\n\nFixture convention:\n  apps/backtest/fixtures/<strategyId>/<strategyId>.csv\n  apps/backtest/fixtures/<strategyId>/<strategyId>.json\n\nAdvanced explicit-path run:\n  pnpm --filter backtest backtest -- --data data/aapl.csv --config configs/sma.json\n\nOptional:\n  --output <directory>    Result directory; defaults to backtest-results/<strategyId> in fixture mode\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown backtest failure";
  process.stderr.write(`Backtest failed: ${message}\n`);
  process.exitCode = 1;
});
