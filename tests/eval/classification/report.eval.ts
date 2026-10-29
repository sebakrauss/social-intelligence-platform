/**
 * Step H7-C — prints the offline evaluation report of task A for the golden simulator (`npm run eval:classification`).
 * Machinery check only: provider = simulator, NOT a real model benchmark. A real provider is evaluated with the same
 * runner in a later gate (H7-D), never here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createSimulatorProvider, simulatorModel } from "@/ai/providers/simulator";
import { REPOSITORY_ROOT } from "../../support/source-scan";
import { parseEvalCorpus } from "./corpus";
import { evaluateCorpus } from "./evaluate";
import { goldenScript } from "./golden";
import { evaluatePromotion } from "./promotion";

it("classification understanding — offline evaluation report (simulator)", async () => {
  const corpus = parseEvalCorpus(JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "fixtures/intelligence/classification/understanding-eval.v1.json"), "utf8")));
  const report = await evaluateCorpus(corpus, { provider: createSimulatorProvider(goldenScript(corpus)), model: simulatorModel("simulator-golden"), realModel: false });
  const { cases, ...summary } = report;
  process.stdout.write(`${JSON.stringify({ ...summary, promotion: evaluatePromotion(report, null), failedCases: cases.filter((c) => !c.pass).map((c) => c.id) }, null, 1)}\n`);
  expect(report.realModelBenchmark).toBe(false);
});
