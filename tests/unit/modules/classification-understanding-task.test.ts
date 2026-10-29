/**
 * Step H7-C — task A bound to the gateway: the prompt is versioned and content-hashed and names exactly the frozen
 * taxonomy; the data block carries only the allowlisted fields (no author, handle, profile, credential, webhook body,
 * thread history or watch-term match); the A1 validator is reused unchanged; the language cap still applies.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DATA_BLOCK_CLOSE, DATA_BLOCK_OPEN } from "@/ai/gateway";
import {
  CLOSED_DIMENSIONS,
  TAXONOMY,
  TAXONOMY_VERSION,
  UNDERSTANDING_OUTPUT_SCHEMA_VERSION,
  buildUnderstandingInput,
  toAiAssessments,
  validateUnderstandingOutput,
  type ClosedDimensionDefinition,
} from "@/modules/classification";
import { UNDERSTANDING_DATA_FIELDS, UNDERSTANDING_TASK, understandingData } from "@/modules/classification/application/ai/understanding-task";
import { UNDERSTANDING_PROMPT_HASH, UNDERSTANDING_PROMPT_SYSTEM } from "@/prompts/classification/understanding.v1";

const reply = () => {
  const built = buildUnderstandingInput({
    interactionKind: "reply", platform: "facebook", source: "paid", text: "¿y en azul?", parentText: "Tenemos la polera en rojo", rootText: "Nueva colección", captionText: "Colección otoño",
    brandName: "Café Aurora", linkPresent: false, parentByOwnBrand: true, rootByOwnBrand: true,
    // Fields a careless caller might pass: the builder copies none of them.
    ...({ authorName: "Ana", handle: "@ana", profileId: "p1", accessToken: "t", webhookBody: "{}", credential: "c", threadHistory: ["x"], watchTermMatches: ["precio"] } as Record<string, unknown>),
  });
  if (!built.ok) throw new Error(built.violations.join(","));
  return built.input;
};

describe("prompt", () => {
  it("is content-hashed: the pinned hash is the SHA-256 of the system text", () => {
    expect(createHash("sha256").update(UNDERSTANDING_PROMPT_SYSTEM, "utf8").digest("hex")).toBe(UNDERSTANDING_PROMPT_HASH);
    expect(UNDERSTANDING_TASK.prompt.hash).toBe(UNDERSTANDING_PROMPT_HASH);
  });

  it("names exactly the frozen schema, taxonomy version and every closed value key; no tools, no placeholders", () => {
    expect(UNDERSTANDING_PROMPT_SYSTEM).toContain(`"schemaVersion":"${UNDERSTANDING_OUTPUT_SCHEMA_VERSION}"`);
    expect(UNDERSTANDING_PROMPT_SYSTEM).toContain(`"taxonomyVersion":"${TAXONOMY_VERSION}"`);
    for (const dimension of CLOSED_DIMENSIONS) {
      for (const value of (TAXONOMY[dimension] as ClosedDimensionDefinition).values) expect(UNDERSTANDING_PROMPT_SYSTEM, `${dimension}.${value}`).toMatch(new RegExp(`\\b${value}\\b`));
    }
    expect(UNDERSTANDING_PROMPT_SYSTEM).not.toMatch(/\{\{|\$\{|function_call|tool_choice/);
    expect(UNDERSTANDING_PROMPT_SYSTEM).toContain(DATA_BLOCK_OPEN);
    expect(UNDERSTANDING_PROMPT_SYSTEM).toContain(DATA_BLOCK_CLOSE);
  });
});

describe("data minimization", () => {
  it("the data block has exactly the allowlisted fields; nothing about authors, credentials, webhooks, history or watch terms", () => {
    const data = understandingData(reply());
    expect(Object.keys(data).sort()).toEqual([...UNDERSTANDING_DATA_FIELDS].sort());
    expect(Object.keys(data.hints as object).sort()).toEqual(["linkPresent", "parentByOwnBrand", "rootByOwnBrand"]);
    expect(JSON.stringify(data)).not.toMatch(/"Ana"|@ana|"p1"|authorName|handle|profileId|accessToken|webhookBody|credential|threadHistory|watchTermMatches|"precio"/);
  });

  it("context stays within the frozen A1 bounds (parent ≤ 1000, root ≤ 500, caption ≤ 500)", () => {
    const built = buildUnderstandingInput({ interactionKind: "reply", platform: "facebook", source: "organic", text: "ok", parentText: "p".repeat(5_000), rootText: "r".repeat(5_000), captionText: "c".repeat(5_000), linkPresent: false });
    if (!built.ok) throw new Error("build");
    const data = understandingData(built.input);
    expect([String(data.parentExcerpt).length, String(data.rootExcerpt).length, String(data.captionExcerpt).length]).toEqual([1_000, 500, 500]);
  });
});

describe("output validation and language", () => {
  const target = { workspaceId: "0d7e0c1a-1f2b-4c3d-8e4f-5a6b7c8d9e01", interactionId: "1d7e0c1a-1f2b-4c3d-8e4f-5a6b7c8d9e01", sourceTextVersionId: "2d7e0c1a-1f2b-4c3d-8e4f-5a6b7c8d9e01" };
  const method = { kind: "ai" as const, provider: "simulator", model: "m", modelVersion: null, taskId: "classification.understanding", taskVersion: "understanding-task.v1", promptVersion: "understanding-prompt.v1", promptHash: UNDERSTANDING_PROMPT_HASH, schemaVersion: "understanding-output.v1", taxonomyVersion: "taxonomy.v1", confidencePolicyVersion: "confidence.v1" };

  it("the task's validator IS the A1 validator (same verdicts)", () => {
    const input = reply();
    for (const raw of [{}, { schemaVersion: "understanding-output.v1", taxonomyVersion: "taxonomy.v1", dimensions: {} }, { schemaVersion: "x" }]) {
      const ours = UNDERSTANDING_TASK.validate(raw, input);
      const theirs = validateUnderstandingOutput(raw, input.text);
      expect(ours.ok).toBe(theirs.ok);
      if (!ours.ok && !theirs.ok) expect(ours.issues).toEqual(theirs.failure.issues);
    }
  });

  it("an unsupported-language output claiming high confidence is capped at medium (D-H7-5)", () => {
    const raw = { schemaVersion: "understanding-output.v1", taxonomyVersion: "taxonomy.v1", dimensions: {
      intent: { status: "assessed", values: [{ key: "price_objection", confidence: "high" }] }, language: { status: "assessed", languages: ["fr"], certainty: "certain", confidence: "high" } } };
    const validated = validateUnderstandingOutput(raw, "Le prix est trop cher");
    if (!validated.ok) throw new Error("valid");
    const assessments = toAiAssessments(validated.output, { target: target as never, method, assessedAt: "2026-10-29T12:00:00.000Z" as never, refs: { intent: "a1", language: "a2" } });
    const intent = assessments.find((a) => a.dimension === "intent");
    expect(intent?.content).toMatchObject({ kind: "values", values: [{ key: "price_objection", confidence: { level: "medium" } }] });
  });
});
