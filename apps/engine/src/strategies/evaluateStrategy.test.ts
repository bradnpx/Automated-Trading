import assert from "node:assert/strict";

import { Bar } from "@my-platform/types";

import { EvaluateStrategy } from "./evaluateStrategy.js";

function createBar(timestamp: string, close: number): Bar {
  return {
    symbol: "AAPL",
    timestamp,
    open: close - 0.5,
    high: close + 0.5,
    low: close - 1,
    close,
    volume: 100,
  };
}

async function run(): Promise<void> {
  const evaluator = new EvaluateStrategy();
  const historicalBars = [
    createBar("2026-09-02T13:00:00.000Z", 100),
    createBar("2026-09-02T13:01:00.000Z", 101),
  ];
  evaluator.hydrate(historicalBars);

  const liveBar = createBar("2026-09-02T13:01:30.000Z", 102);
  let criteriaEvaluation:
    | { criteria: string[]; report: Record<string, boolean> }
    | undefined;
  const result = await evaluator.evaluate(
    liveBar,
    ["isBullish"],
    0,
    undefined,
    {
      recordBar: false,
      onCriteriaEvaluated: (evaluation) => {
        criteriaEvaluation = evaluation;
      },
    },
  );

  assert.equal(result.meetsCriteria, true);
  assert.deepEqual(criteriaEvaluation, {
    criteria: ["isBullish"],
    report: { isBullish: true },
  });
  assert.equal(
    Reflect.get(evaluator, "history").length,
    historicalBars.length,
    "A live evaluation must not append a synthetic tick bar to minute history.",
  );

  console.log("Live indicator history verification passed.");
}

void run();
