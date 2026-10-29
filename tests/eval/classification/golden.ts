/**
 * Step H7-C — the GOLDEN simulator script: for each corpus case, the output its expectations describe (gold values at
 * the case's gold confidence, the expected language, abstentions where expected). It exists to test the evaluation
 * MACHINERY: a golden run measures nothing about any model. Regression scripts are derived from it by explicit,
 * named transformations of single cases (the negative evaluator tests).
 */
import type { SimulatedResponse, SimulatorScript } from "@/ai/providers/simulator";
import type { EvalCase, EvalCorpus } from "./corpus";

export type OutputBody = Record<string, unknown> & { dimensions: Record<string, unknown> };

export function goldenOutput(testCase: EvalCase): OutputBody {
  const dimensions: Record<string, unknown> = {};
  for (const [dimension, expectation] of Object.entries(testCase.expected)) {
    dimensions[dimension] = expectation.kind === "abstain"
      ? { status: "insufficient_evidence" }
      : { status: "assessed", values: expectation.values.map((key) => ({ key, confidence: testCase.goldConfidence })), ...(expectation.reasonCodes.length > 0 ? { reasonCodes: [...expectation.reasonCodes] } : {}) };
  }
  dimensions["language"] = testCase.language.tags.length === 0
    ? { status: "insufficient_evidence" }
    : { status: "assessed", languages: [...testCase.language.tags], certainty: testCase.language.certainty, confidence: testCase.language.certainty === "certain" ? "high" : "medium" };
  return { schemaVersion: "understanding-output.v1", taxonomyVersion: "taxonomy.v1", dimensions };
}

export function goldenScript(corpus: EvalCorpus): Map<string, readonly SimulatedResponse[]> {
  return new Map(corpus.cases.filter((testCase) => testCase.expectedFailure === null).map((testCase) => [testCase.id, [{ kind: "output" as const, body: goldenOutput(testCase) }]]));
}

/** A copy of `script` where ONE case answers differently (attempt 1 and, when given, the re-ask). */
export function withCase(script: SimulatorScript, id: string, responses: readonly SimulatedResponse[]): Map<string, readonly SimulatedResponse[]> {
  if (!script.has(id)) throw new Error(`unknown_case:${id}`);
  return new Map([...script, [id, responses]]);
}

/** The golden output of one case transformed (e.g. a dropped intent, a swapped value). */
export function transformCase(script: SimulatorScript, corpus: EvalCorpus, id: string, change: (body: OutputBody) => void): Map<string, readonly SimulatedResponse[]> {
  const testCase = corpus.cases.find((c) => c.id === id);
  if (testCase === undefined) throw new Error(`unknown_case:${id}`);
  const body = structuredClone(goldenOutput(testCase));
  change(body);
  return withCase(script, id, [{ kind: "output", body }]);
}

export const values = (...pairs: readonly (readonly [string, "low" | "medium" | "high"])[]): Record<string, unknown> =>
  ({ status: "assessed", values: pairs.map(([key, confidence]) => ({ key, confidence })) });
