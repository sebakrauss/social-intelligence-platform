/**
 * Step H7-D1g-minimization — first real-data shadow pilot policy SUMMARY_POLICY = DO_NOT_PERSIST. The frozen output
 * contract still admits and validates the model's optional free-text `summary` (it lives transiently in memory), but no
 * derivation depends on it and no persisted row can carry it. Pure: no database, no provider, synthetic text only.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseInstant } from "@/domain/instant";
import {
  UNDERSTANDING_OUTPUT_SCHEMA_VERSION,
  deriveUnderstandingOutcome,
  parseAnalysisTarget,
  validateUnderstandingOutput,
  type AiMethod,
  type ValidatedUnderstanding,
} from "@/modules/classification";
import { codeOf } from "../../support/source-scan";

const TEXT = "Me interesa, pero el precio es demasiado caro. ¿Hay descuento?";
const SUMMARY = "Objeta el precio y pide un descuento.";
const raw = (summary?: string) => ({
  schemaVersion: UNDERSTANDING_OUTPUT_SCHEMA_VERSION,
  taxonomyVersion: "taxonomy.v1",
  dimensions: {
    intent: { status: "assessed", values: [{ key: "price_objection", confidence: "high" }, { key: "purchase_question", confidence: "high" }] },
    sentiment: { status: "assessed", values: [{ key: "mixed", confidence: "medium" }] },
    safety: { status: "assessed", values: [{ key: "none", confidence: "high" }] },
    authenticity: { status: "assessed", values: [{ key: "likely_human", confidence: "medium" }] },
    risk: { status: "assessed", values: [{ key: "low", confidence: "high" }] },
    response_need: { status: "assessed", values: [{ key: "response_recommended", confidence: "high" }] },
    language: { status: "assessed", languages: ["es"], certainty: "certain", confidence: "high" },
  },
  ...(summary === undefined ? {} : { summary }),
  evidence: [{ quote: "demasiado caro" }],
});
const TARGET = parseAnalysisTarget({ workspaceId: randomUUID(), interactionId: randomUUID(), sourceTextVersionId: randomUUID() }) ?? (() => { throw new Error("target"); })();
const AT = parseInstant("2026-11-03T12:00:00.000Z") ?? (() => { throw new Error("instant"); })();
const METHOD: AiMethod = {
  kind: "ai", provider: "simulator", model: "sim", modelVersion: null, taskId: "classification.understanding", taskVersion: "understanding-task.v2",
  promptVersion: "understanding-prompt.v2", promptHash: "0".repeat(64), schemaVersion: "understanding-output.v1", taxonomyVersion: "taxonomy.v1", confidencePolicyVersion: "confidence.v1",
};
const REFS = Object.fromEntries(["safety", "authenticity", "intent", "sentiment", "risk", "response_need", "language"].map((d) => [d, `ref:${d}`]));
const validated = (summary?: string): ValidatedUnderstanding => {
  const result = validateUnderstandingOutput(raw(summary), TEXT);
  if (!result.ok) throw new Error(`invalid: ${result.failure.issues.join(",")}`);
  return result.output;
};
const outcomeOf = (output: ValidatedUnderstanding) => deriveUnderstandingOutcome({ target: TARGET, ruleAssessments: [], run: { kind: "assessed", output, method: METHOD, assessedAt: AT, refs: REFS } });

describe("H7-D1g-minimization · `summary` is transient only", () => {
  it("1. a valid provider output WITH a summary still validates (frozen contract unchanged); the summary exists only in memory", () => {
    const output = validated(SUMMARY);
    expect(output.summary).toBe(SUMMARY);
    expect(output.evidence.map((s) => TEXT.slice(s.start, s.end))).toEqual(["demasiado caro"]);
  });

  it("2–5. assessments, Protection and Needs review are IDENTICAL with the summary, without it, or with it discarded (nothing derives from it)", () => {
    const withSummary = outcomeOf(validated(SUMMARY));
    const without = outcomeOf(validated());
    const discarded = outcomeOf({ ...validated(SUMMARY), summary: null });
    expect(without).toEqual(withSummary);
    expect(discarded).toEqual(withSummary);
    expect(withSummary.aiAssessments).toHaveLength(7);
    expect(withSummary.protection).toMatchObject({ result: "protected", meanings: ["commercial_objection"] });
    expect(withSummary.needsReview.needsReview).toBe(false);
    expect(JSON.stringify(withSummary)).not.toContain(SUMMARY);
  });

  it("guard: the persisted result row has NO summary field, the store writes summary NULL, and no runtime file reads a validated summary", () => {
    const ports = codeOf("modules/classification/application/ports.ts");
    const row = ports.slice(ports.indexOf("export interface AiResultRow"), ports.indexOf("}", ports.indexOf("export interface AiResultRow")));
    expect(row).toContain("readonly evidence: readonly SourceSpan[];");
    expect(row).not.toMatch(/readonly summary/);
    const store = codeOf("modules/classification/persistence/intelligence-store.ts");
    expect(store).toMatch(/input_contract_version, summary, evidence_starts, evidence_ends,/);
    expect(store).toMatch(/\$\{r\.inputContractVersion\}, null,\n/);
    expect(store).not.toMatch(/r\.summary/);
    for (const file of ["modules/classification/application/ai/run-understanding.ts", "jobs/intelligence.ts", "modules/classification/persistence/intelligence-store.ts", "server/persistence/classification.ts"]) {
      expect(codeOf(file).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ""), file).not.toMatch(/\.summary\b|summary:/);
    }
  });
});
