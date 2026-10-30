/**
 * Step H7-D0g — the Anthropic TRANSPORT schema (`projectSchemaForAnthropic`) against the canonical strict-dialect schema
 * (no network): structure preserved, complexity materially lower and guarded, nothing unsupported introduced, OpenAI
 * and the simulator untouched — and the A1 validator still the authority: every semantic constraint the projection
 * no longer encodes is still rejected after generation, and every golden output stays valid.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ProviderRequest } from "@/ai/gateway";
import { ANTHROPIC_TRANSPORT_SCHEMA_VERSION, measureSchemaComplexity, projectSchemaForAnthropic } from "@/ai/providers/anthropic/schema-projection";
import { createOpenAIProvider } from "@/ai/providers/openai";
import { UNDERSTANDING_OUTPUT_JSON_SCHEMA, fromStructuredOutput } from "@/modules/classification/application/ai/understanding-output-schema";
import { SAFETY_VALUES, TAXONOMY, type ClosedDimensionDefinition } from "@/modules/classification/domain/taxonomy";
import { validateUnderstandingOutput } from "@/modules/classification/domain/understanding-output";
import { parseEvalCorpus } from "../../eval/classification/corpus";
import { goldenOutput } from "../../eval/classification/golden";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../../support/source-scan";

type Node = Readonly<Record<string, unknown>>;
const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);
const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const CANONICAL = UNDERSTANDING_OUTPUT_JSON_SCHEMA;
const CANONICAL_JSON = JSON.stringify(CANONICAL);
const PROJECTED = projectSchemaForAnthropic(CANONICAL);
const CORPUS = parseEvalCorpus(JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "fixtures/intelligence/classification/understanding-eval.v2.json"), "utf8")));

/** A minimal validator for exactly the keyword subset both schemas use (type, properties, required, additionalProperties, enum, anyOf, items). */
function conforms(schema: Node, value: unknown): boolean {
  if (Array.isArray(schema["anyOf"])) return (schema["anyOf"] as Node[]).some((branch) => conforms(branch, value));
  if (Array.isArray(schema["enum"]) && !(schema["enum"] as unknown[]).includes(value)) return false;
  switch (schema["type"]) {
    case "null": return value === null;
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "array": return Array.isArray(value) && value.every((item) => conforms(schema["items"] as Node, item));
    case "object": {
      if (!isNode(value)) return false;
      const properties = schema["properties"] as Readonly<Record<string, Node>>;
      if (schema["additionalProperties"] === false && Object.keys(value).some((key) => !Object.hasOwn(properties, key))) return false;
      if ((schema["required"] as string[]).some((key) => !Object.hasOwn(value, key))) return false;
      return Object.entries(value).every(([key, child]) => conforms(properties[key] as Node, child));
    }
    default: throw new Error(`unsupported type in test validator: ${String(schema["type"])}`);
  }
}

/** Every node with its path (properties, anyOf branches, array items). */
const nodes = (node: unknown, at = "$"): [string, Node][] => {
  if (!isNode(node)) return [];
  const props = isNode(node["properties"]) ? Object.entries(node["properties"]).flatMap(([k, v]) => nodes(v, `${at}.${k}`)) : [];
  const branches = Array.isArray(node["anyOf"]) ? (node["anyOf"] as unknown[]).flatMap((b, i) => nodes(b, `${at}|${String(i)}`)) : [];
  return [[at, node], ...props, ...branches, ...nodes(node["items"], `${at}[]`)];
};
const isNullOnly = (n: Node): boolean => n["type"] === "null" && Object.keys(n).length === 1;
const nonNullBranches = (n: Node): Node[] => (Array.isArray(n["anyOf"]) ? (n["anyOf"] as Node[]).filter((b) => !isNullOnly(b)) : [n]);

describe("H7-D0i: Anthropic transport schema v2 — structure (no unions)", () => {
  const dims = (schema: Node) => ((schema["properties"] as Record<string, Node>)["dimensions"] as Node)["properties"] as Record<string, Node>;
  /** The canonical branch inventory of one dimension, derived mechanically (null branch excluded). */
  const branchesOf = (dimension: string) => nonNullBranches(dims(CANONICAL)[dimension] as Node);

  it("the canonical schema is unchanged (content pin) and the projection never mutates its input", () => {
    // Pinned at the pre-H7-D0g source (5e57741): the schema OpenAI receives and the A1 contract's generation aid.
    expect(sha256(CANONICAL)).toBe("53e161d44c29648043af1de527990d07b756b709a0efb9016f39831b7ca9d978");
    projectSchemaForAnthropic(structuredClone<Node>(CANONICAL));
    expect(JSON.stringify(CANONICAL)).toBe(CANONICAL_JSON);
  });

  it("is deterministic (same output for an equal input; pinned v2 fingerprint + version)", () => {
    expect(projectSchemaForAnthropic(structuredClone<Node>(CANONICAL))).toEqual(PROJECTED);
    expect(JSON.stringify(projectSchemaForAnthropic(structuredClone<Node>(CANONICAL)))).toBe(JSON.stringify(PROJECTED));
    expect(ANTHROPIC_TRANSPORT_SCHEMA_VERSION).toBe("anthropic-transport-schema.v2");
    expect(sha256(PROJECTED)).toBe("062f21b710694ac10330226d55fb01637549babd6673596c81883d60392422e5");
  });

  it("the seven canonical dimension unions are gone: no anyOf / oneOf / type array anywhere", () => {
    expect(Object.values(dims(CANONICAL)).filter((d) => Array.isArray(d["anyOf"]))).toHaveLength(7);
    for (const [at, node] of nodes(PROJECTED)) {
      for (const key of ["anyOf", "oneOf", "allOf"]) expect(Object.hasOwn(node, key), `${at}: ${key}`).toBe(false);
      expect(Array.isArray(node["type"]), at).toBe(false);
      expect(node["type"], at).not.toBe("null");
    }
  });

  it("each dimension is ONE closed object: status required with the united canonical status enum; the branch property union is complete; nothing invented", () => {
    for (const [dimension, merged] of Object.entries(dims(PROJECTED))) {
      const branches = branchesOf(dimension);
      expect(branches.length, dimension).toBe(2);
      expect(merged["type"], dimension).toBe("object");
      expect(merged["additionalProperties"], dimension).toBe(false);
      expect(merged["required"], dimension).toEqual(["status"]);
      const statuses = branches.flatMap((b) => ((b["properties"] as Record<string, Node>)["status"] as Node)["enum"] as string[]);
      expect(((merged["properties"] as Record<string, Node>)["status"] as Node)["enum"], dimension).toEqual(statuses);
      expect(statuses, dimension).toEqual(["assessed", "none_fits", "insufficient_evidence"]);
      // Every non-placeholder branch property is present, and no other property exists.
      const expected = [...new Set(branches.flatMap((b) => Object.entries(b["properties"] as Record<string, Node>).filter(([, v]) => !isNullOnly(v)).map(([k]) => k)))];
      expect(Object.keys(merged["properties"] as Node), dimension).toEqual(expected);
    }
  });

  it("requiredness: non-nullable canonical properties outside a merged union stay required; strict-dialect nullables become optional; root evidence is a required array (empty ≡ absent)", () => {
    expect(Object.keys(PROJECTED["properties"] as Node)).toEqual(Object.keys(CANONICAL["properties"] as Node));
    expect(PROJECTED["required"]).toEqual(["schemaVersion", "taxonomyVersion", "dimensions", "evidence"]);
    expect((PROJECTED["properties"] as Record<string, Node>)["dimensions"]?.["required"]).toEqual([]);
    for (const [at, node] of nodes(PROJECTED)) {
      if (at.endsWith(".values[]")) expect(node["required"], at).toEqual(["key", "confidence"]);
      if (at.endsWith(".evidence[]")) expect(node["required"], at).toEqual(["quote"]);
    }
  });

  it("A1 treats an omitted evidence array and an empty one identically (the ONLY nullable → required rule)", () => {
    const testCase = CORPUS.cases.find((c) => c.id === "es-cl-praise-01") ?? (() => { throw new Error("case"); })();
    const absent = validateUnderstandingOutput(fromStructuredOutput(goldenOutput(testCase)), testCase.text);
    const empty = validateUnderstandingOutput(fromStructuredOutput({ ...goldenOutput(testCase), evidence: [] }), testCase.text);
    expect(absent.ok && empty.ok).toBe(true);
    expect(empty).toEqual(absent);
  });

  it("types and array boundaries are preserved; multi-value enums other than status become string; no value added or renamed", () => {
    const relaxed: string[] = [];
    for (const [at, node] of nodes(PROJECTED)) {
      if (node["type"] === "string" && !Array.isArray(node["enum"])) relaxed.push(at);
      if (Array.isArray(node["enum"])) expect(at === "$.schemaVersion" || at === "$.taxonomyVersion" || at.endsWith(".status"), at).toBe(true);
    }
    expect(relaxed.filter((at) => /\.(key|confidence|certainty)$|reasonCodes\[\]$/.test(at))).toHaveLength(15);
    expect(nodes(PROJECTED).filter(([, n]) => n["type"] === "array").length).toBe(nodes(CANONICAL).filter(([, n]) => n["type"] === "array").length);
  });

  it("introduces no keyword outside Anthropic's documented subset; every object closed", () => {
    expect([...new Set(nodes(PROJECTED).flatMap(([, n]) => Object.keys(n)))].sort()).toEqual(["additionalProperties", "enum", "items", "properties", "required", "type"]);
    for (const [at, node] of nodes(PROJECTED)) if (node["type"] === "object") expect(node["additionalProperties"], at).toBe(false);
  });

  it("fails closed on what it cannot merge (incompatible shared property, branch without discriminator, non-object branch)", () => {
    const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
    const wrap = (anyOf: unknown[]) => obj({ d: { anyOf } }, ["d"]);
    expect(() => projectSchemaForAnthropic(wrap([obj({ s: { type: "string", enum: ["a"] }, x: { type: "string" } }, ["s"]), obj({ s: { type: "string", enum: ["b"] }, x: { type: "number" } }, ["s"])]))).toThrow("incompatible_shared_property:x");
    expect(() => projectSchemaForAnthropic(wrap([obj({ x: { type: "string" } }, ["x"]), obj({ y: { type: "string" } }, ["y"])]))).toThrow("anyOf_without_discriminator");
    expect(() => projectSchemaForAnthropic(wrap([{ type: "string" }, { type: "number" }]))).toThrow("anyOf_branch_not_a_closed_object");
  });
});

describe("H7-D0i: complexity — union-free, and guarded against drift", () => {
  const pre = measureSchemaComplexity(CANONICAL);
  const post = measureSchemaComplexity(PROJECTED);

  it("pre-gate canonical metrics (authority for the reduction)", () => {
    expect(pre).toEqual({ bytes: 5864, objects: 23, properties: 60, requiredProperties: 60, optionalProperties: 0, enums: 31, enumValues: 85, anyOf: 16, anyOfBranches: 39, unionParameters: 16, nullTypes: 21, arrays: 9, maxDepth: 7 });
  });

  it("ZERO unions (H7-D0h: unions are what Anthropic's compiler rejects); optional parameters within the documented maximum of 24", () => {
    expect(post.unionParameters).toBe(0);
    expect(post.anyOf).toBe(0);
    expect(post.anyOfBranches).toBe(0);
    expect(post.nullTypes).toBe(0);
    expect(post.optionalProperties).toBeLessThanOrEqual(24);
    expect(post.maxDepth).toBeLessThanOrEqual(6);
    expect(post.enums).toBeLessThanOrEqual(10);
    expect(post.enumValues).toBeLessThanOrEqual(24);
    expect(post.objects).toBeLessThanOrEqual(16);
    expect(post.arrays).toBe(pre.arrays);
    for (const key of ["unionParameters", "anyOfBranches", "enums", "enumValues", "nullTypes", "objects", "bytes", "maxDepth"] as const) expect(post[key], key).toBeLessThan(pre[key]);
  });
});

describe("H7-D0g: provider boundaries — only Anthropic projects", () => {
  it("OpenAI still receives the canonical schema byte-for-byte", async () => {
    const create = vi.fn<(body: { text: { format: { schema: unknown } } }) => Promise<unknown>>(() => Promise.resolve({ id: "r", model: "gpt-6-luna", status: "completed", output: [], output_text: "{}", usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } }));
    const request: ProviderRequest = { model: { providerKey: "openai", modelKey: "gpt-6-luna" }, system: "S", data: "D", responseFormat: { kind: "json", schemaVersion: "understanding-output.v1", schemaName: "wrenkind_understanding_output_v1", jsonSchema: CANONICAL }, maxOutputChars: 8_000 };
    await createOpenAIProvider({ client: { responses: { create } } as never, models: { "gpt-6-luna": { model: "gpt-6-luna", reasoningEffort: "none", maxOutputTokens: 2_000 } }, timeoutMs: 30_000 }).complete(request, { reference: "c", attempt: 1 });
    expect(JSON.stringify(create.mock.calls[0]?.[0].text.format.schema)).toBe(CANONICAL_JSON);
  });

  it("only the Anthropic adapter uses the projection (OpenAI, simulator, gateway and modules never do)", () => {
    const users = sourceFiles(["app", "ui", "server", "domain", "modules", "platform", "integrations", "jobs", "mutations", "prompts", "ai", "tools"]).filter((file) => /schema-projection|projectSchemaForAnthropic/.test(codeOf(file)));
    expect(users.sort()).toEqual(["ai/providers/anthropic/index.ts", "ai/providers/anthropic/schema-projection.ts"]);
  });
});

describe("H7-D0g: the canonical A1 validator stays the authority", () => {
  const testCase = CORPUS.cases.find((c) => c.id === "es-cl-praise-01") ?? (() => { throw new Error("case"); })();
  /** A canonical output in its Anthropic transport form (v2: the required evidence array, empty when absent). */
  type Output = Record<string, unknown> & { dimensions: Record<string, Record<string, unknown>> };
  const transportForm = (output: Record<string, unknown>): Output => {
    const copy: Record<string, unknown> = structuredClone(output);
    copy["evidence"] = output["evidence"] ?? [];
    return copy as Output;
  };
  const base = (): Output => transportForm(goldenOutput(testCase));
  const assessed = (key: string, extra: Record<string, unknown> = {}) => ({ status: "assessed", values: [{ key, confidence: "high" }], ...extra });

  it("every golden output, in its transport form, conforms to the transport schema AND passes A1 with the same result (golden labels unchanged)", () => {
    let checked = 0;
    for (const c of CORPUS.cases.filter((x) => x.expectedFailure === null)) {
      const canonical = goldenOutput(c);
      const output = transportForm(canonical);
      expect(conforms(PROJECTED, output), c.id).toBe(true);
      const viaTransport = validateUnderstandingOutput(fromStructuredOutput(JSON.parse(JSON.stringify(output))), c.text);
      expect(viaTransport.ok, c.id).toBe(true);
      expect(viaTransport, c.id).toEqual(validateUnderstandingOutput(fromStructuredOutput(canonical), c.text));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(60);
  });

  const cases: [string, (o: ReturnType<typeof base>) => void, string][] = [
    ["unknown sentiment", (o) => { o.dimensions["sentiment"] = assessed("happy"); }, "UNKNOWN_VALUE"],
    ["unknown intent", (o) => { o.dimensions["intent"] = assessed("buy_a_boat"); }, "UNKNOWN_VALUE"],
    ["unknown safety label", (o) => { o.dimensions["safety"] = assessed("mildly_rude"); }, "UNKNOWN_VALUE"],
    ["invalid confidence", (o) => { o.dimensions["sentiment"] = { status: "assessed", values: [{ key: "positive", confidence: "very_high" }] }; }, "CONFIDENCE_INVALID"],
    ["score outside [0, 1]", (o) => { o.dimensions["sentiment"] = { status: "assessed", values: [{ key: "positive", confidence: "high", score: 7 }] }; }, "SCORE_INVALID"],
    ["invalid language tag", (o) => { o.dimensions["language"] = { status: "assessed", languages: ["not a language!"], certainty: "certain", confidence: "high" }; }, "LANGUAGE_TAG_INVALID"],
    ["invalid language certainty", (o) => { o.dimensions["language"] = { status: "assessed", languages: ["es"], certainty: "pretty_sure", confidence: "high" }; }, "LANGUAGE_CERTAINTY_INVALID"],
    ["invalid reason code", (o) => { o.dimensions["risk"] = assessed("none", { reasonCodes: ["vibes"] }); }, "REASON_CODE_INVALID"],
    ["cardinality (single-valued sentiment with two values)", (o) => { o.dimensions["sentiment"] = { status: "assessed", values: [{ key: "positive", confidence: "high" }, { key: "negative", confidence: "low" }] }; }, "CARDINALITY_VIOLATION"],
    ["duplicate value", (o) => { o.dimensions["intent"] = { status: "assessed", values: [{ key: "praise", confidence: "high" }, { key: "praise", confidence: "low" }] }; }, "DUPLICATE_VALUE"],
    ["protection semantics: exclusive safety 'none' combined", (o) => { o.dimensions["safety"] = { status: "assessed", values: [{ key: "none", confidence: "high" }, { key: SAFETY_VALUES.find((v) => v !== "none") ?? "", confidence: "high" }] }; }, "EXCLUSIVE_VALUE_COMBINED"],
    ["evidence quote not in the text", (o) => { o["evidence"] = [{ quote: "this text is nowhere in the comment" }]; }, "QUOTE_NOT_IN_TEXT"],
    ["too many evidence quotes", (o) => { o["evidence"] = [{ quote: "a" }, { quote: "a" }, { quote: "a" }, { quote: "a" }]; }, "EVIDENCE_INVALID"],
    ["overlong summary", (o) => { o["summary"] = "x".repeat(241); }, "SUMMARY_INVALID"],
  ];
  for (const [name, change, issue] of cases) {
    it(`transport-valid but semantically invalid ⇒ A1 still rejects: ${name} (${issue})`, () => {
      const output = base();
      change(output);
      expect(conforms(PROJECTED, output), "the looser transport schema admits it").toBe(true);
      const result = validateUnderstandingOutput(fromStructuredOutput(output), testCase.text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.issues).toContain(issue);
    });
  }

  it("the structure the projection keeps is still enforced by the transport schema itself", () => {
    const extraKey = base(); (extraKey as Record<string, unknown>)["extra"] = 1;
    const unknownStatus = base(); unknownStatus.dimensions["sentiment"] = { status: "abstained" };
    const missingStatus = base(); missingStatus.dimensions["sentiment"] = { values: [{ key: "positive", confidence: "high" }] };
    const missingVersion = base(); Reflect.deleteProperty(missingVersion, "schemaVersion");
    const nullScore = base(); nullScore.dimensions["sentiment"] = { status: "assessed", values: [{ key: "positive", confidence: "high", score: null }] };
    for (const output of [extraKey, unknownStatus, missingStatus, missingVersion, nullScore]) expect(conforms(PROJECTED, output)).toBe(false);
    // …and A1 independently rejects the same status mistakes.
    for (const output of [unknownStatus, missingStatus]) {
      const result = validateUnderstandingOutput(fromStructuredOutput(output), testCase.text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.issues).toContain("STATUS_INVALID");
    }
  });

  // H7-D0i: the cross-field rules the removed unions encoded are A1's — for EVERY dimension.
  const CLOSED = ["safety", "authenticity", "intent", "sentiment", "risk", "response_need"] as const;
  const branchCases: [string, (o: ReturnType<typeof base>) => void, string][] = [
    ...CLOSED.flatMap((d): [string, (o: ReturnType<typeof base>) => void, string][] => [
      [`${d}: assessed without values`, (o) => { o.dimensions[d] = { status: "assessed" }; }, "CARDINALITY_VIOLATION"],
      [`${d}: assessed with an empty values array`, (o) => { o.dimensions[d] = { status: "assessed", values: [] }; }, "CARDINALITY_VIOLATION"],
      [`${d}: abstention carrying values`, (o) => { o.dimensions[d] = { status: "none_fits", values: [{ key: "x", confidence: "high" }] }; }, "UNEXPECTED_KEY"],
      [`${d}: abstention carrying an empty values array`, (o) => { o.dimensions[d] = { status: "insufficient_evidence", values: [] }; }, "UNEXPECTED_KEY"],
    ]),
    ["risk: abstention carrying reason codes", (o) => { o.dimensions["risk"] = { status: "none_fits", reasonCodes: ["reputation_risk"] }; }, "UNEXPECTED_KEY"],
    ["language: assessed without languages", (o) => { o.dimensions["language"] = { status: "assessed", certainty: "certain", confidence: "high" }; }, "CARDINALITY_VIOLATION"],
    ["language: assessed without certainty", (o) => { o.dimensions["language"] = { status: "assessed", languages: ["es"], confidence: "high" }; }, "LANGUAGE_CERTAINTY_INVALID"],
    ["language: assessed without confidence", (o) => { o.dimensions["language"] = { status: "assessed", languages: ["es"], certainty: "certain" }; }, "CONFIDENCE_INVALID"],
    ["language: abstention carrying languages", (o) => { o.dimensions["language"] = { status: "none_fits", languages: ["es"] }; }, "UNEXPECTED_KEY"],
    ["language: abstention carrying certainty", (o) => { o.dimensions["language"] = { status: "insufficient_evidence", certainty: "certain" }; }, "UNEXPECTED_KEY"],
  ];
  for (const [name, change, issue] of branchCases) {
    it(`branch consistency — transport-valid, A1 rejects: ${name} (${issue})`, () => {
      const output = base();
      change(output);
      expect(conforms(PROJECTED, output), "the union-free transport schema admits it").toBe(true);
      const result = validateUnderstandingOutput(fromStructuredOutput(output), testCase.text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.issues).toContain(issue);
    });
  }

  it("valid assessed and abstention forms pass A1 for every dimension", () => {
    for (const d of CLOSED) {
      const key = (TAXONOMY[d] as ClosedDimensionDefinition).values[0] ?? "";
      for (const form of [{ status: "assessed", values: [{ key, confidence: "medium" }] }, { status: "none_fits" }, { status: "insufficient_evidence" }]) {
        const output = base();
        output.dimensions[d] = form;
        expect(conforms(PROJECTED, output), `${d} ${form.status}`).toBe(true);
        expect(validateUnderstandingOutput(fromStructuredOutput(output), testCase.text).ok, `${d} ${form.status}`).toBe(true);
      }
    }
    for (const form of [{ status: "assessed", languages: ["es"], certainty: "certain", confidence: "high" }, { status: "none_fits" }]) {
      const output = base();
      output.dimensions["language"] = form;
      expect(conforms(PROJECTED, output)).toBe(true);
      expect(validateUnderstandingOutput(fromStructuredOutput(output), testCase.text).ok).toBe(true);
    }
  });
});
