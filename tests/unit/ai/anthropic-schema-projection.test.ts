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
import { SAFETY_VALUES } from "@/modules/classification/domain/taxonomy";
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
const CORPUS = parseEvalCorpus(JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "fixtures/intelligence/classification/understanding-eval.v1.json"), "utf8")));

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

describe("H7-D0g: Anthropic transport schema projection — structure", () => {
  it("the canonical schema is unchanged (content pin) and the projection never mutates its input", () => {
    // Pinned at the pre-H7-D0g source (5e57741): the schema OpenAI receives and the A1 contract's generation aid.
    expect(sha256(CANONICAL)).toBe("53e161d44c29648043af1de527990d07b756b709a0efb9016f39831b7ca9d978");
    projectSchemaForAnthropic(structuredClone<Node>(CANONICAL));
    expect(JSON.stringify(CANONICAL)).toBe(CANONICAL_JSON);
  });

  it("is deterministic (same output for an equal input; pinned fingerprint + version)", () => {
    expect(projectSchemaForAnthropic(structuredClone<Node>(CANONICAL))).toEqual(PROJECTED);
    expect(JSON.stringify(projectSchemaForAnthropic(structuredClone<Node>(CANONICAL)))).toBe(JSON.stringify(PROJECTED));
    expect(ANTHROPIC_TRANSPORT_SCHEMA_VERSION).toBe("anthropic-transport-schema.v1");
    expect(sha256(PROJECTED)).toBe("a7d444e796c3c8538bd15581618194ae8315a7d84b9d48c068c2ed24fe095593");
  });

  it("keeps every root property; root identity fields and dimensions stay required", () => {
    expect(Object.keys(PROJECTED["properties"] as Node)).toEqual(Object.keys(CANONICAL["properties"] as Node));
    expect(PROJECTED["required"]).toEqual(["schemaVersion", "taxonomyVersion", "dimensions"]);
  });

  it("requiredness: every NON-nullable canonical property stays required; ONLY the strict-dialect nullable (= optional) ones become optional — exactly the ones the A1 bridge strips", () => {
    const optionalized: string[] = [];
    const dropped: string[] = [];
    const pair = (c: Node, p: Node, at: string): void => {
      if (Array.isArray(c["anyOf"])) {
        const cb = nonNullBranches(c);
        const pb = Array.isArray(p["anyOf"]) ? (p["anyOf"] as Node[]) : [p];
        expect(pb.length, at).toBe(cb.length);
        cb.forEach((branch, i) => { pair(branch, pb[i] as Node, `${at}|${String(i)}`); });
        return;
      }
      if (c["type"] === "array") { pair(c["items"] as Node, p["items"] as Node, `${at}[]`); return; }
      if (c["type"] !== "object") return;
      expect(p["additionalProperties"], at).toBe(false);
      const cp = c["properties"] as Record<string, Node>;
      const pp = p["properties"] as Record<string, Node>;
      const preq = new Set(p["required"] as string[]);
      for (const [key, child] of Object.entries(cp)) {
        const nullable = Array.isArray(child["anyOf"]) && (child["anyOf"] as Node[]).some(isNullOnly);
        if (isNullOnly(child)) { expect(Object.hasOwn(pp, key), `${at}.${key}`).toBe(false); dropped.push(`${at}.${key}`); continue; }
        expect(Object.hasOwn(pp, key), `${at}.${key}`).toBe(true);
        if (nullable) { expect(preq.has(key), `${at}.${key}`).toBe(false); optionalized.push(`${at}.${key}`); } else expect(preq.has(key), `${at}.${key}`).toBe(true);
        const single = nonNullBranches(child);
        pair(single.length === 1 ? single[0] as Node : { anyOf: single }, pp[key] as Node, `${at}.${key}`);
      }
    };
    pair(CANONICAL, PROJECTED, "$");
    const leaf = (p: string) => p.replace(/\|\d+/g, "").split(".").at(-1)?.replace("[]", "") ?? "";
    // The fields fromStructuredOutput strips when null: summary, evidence, a dimension, score, reasonCodes.
    expect([...new Set(optionalized.map(leaf))].sort()).toEqual(["authenticity", "evidence", "intent", "language", "reasonCodes", "response_need", "risk", "safety", "score", "sentiment", "summary"].sort());
    expect([...new Set(dropped.map(leaf))]).toEqual(["reasonCodes"]);
  });

  it("types and object / array boundaries are preserved; the only node change is a removed multi-value string enum (no value added or renamed)", () => {
    const relaxed: string[] = [];
    const pair = (c: Node, p: Node, at: string): void => {
      if (Array.isArray(c["anyOf"])) {
        const cb = nonNullBranches(c);
        const pb = Array.isArray(p["anyOf"]) ? (p["anyOf"] as Node[]) : [p];
        cb.forEach((branch, i) => { pair(branch, pb[i] as Node, at); });
        return;
      }
      expect(p["type"], at).toBe(c["type"]);
      if (Array.isArray(c["enum"])) {
        if (Array.isArray(p["enum"])) expect(p["enum"], at).toEqual(c["enum"]);
        else { expect((c["enum"] as unknown[]).length, at).toBeGreaterThan(1); expect(p, at).toEqual({ type: "string" }); relaxed.push(at); }
      } else expect(Object.hasOwn(p, "enum"), at).toBe(false);
      if (c["type"] === "array") pair(c["items"] as Node, p["items"] as Node, `${at}[]`);
      if (c["type"] === "object") {
        for (const [key, child] of Object.entries(c["properties"] as Record<string, Node>)) {
          const target = (p["properties"] as Record<string, Node>)[key];
          if (target !== undefined) pair(child, target, `${at}.${key}`);
        }
      }
    };
    pair(CANONICAL, PROJECTED, "$");
    // Value keys, confidence levels, language certainty and reason codes move to A1; the branch discriminators (status) stay.
    expect(relaxed.length).toBe(15);
    expect(relaxed.every((at) => /\.(key|confidence|certainty)$|reasonCodes\[\]$/.test(at))).toBe(true);
    for (const [at, node] of nodes(PROJECTED)) if (at.endsWith(".status")) expect(Array.isArray(node["enum"]), at).toBe(true);
  });

  it("introduces no keyword outside Anthropic's documented subset", () => {
    expect([...new Set(nodes(PROJECTED).flatMap(([, n]) => Object.keys(n)))].sort()).toEqual(["additionalProperties", "anyOf", "enum", "items", "properties", "required", "type"]);
    for (const [at, node] of nodes(PROJECTED)) if (node["type"] === "object") expect(node["additionalProperties"], at).toBe(false);
  });
});

describe("H7-D0g: complexity — materially lower, and guarded against drift", () => {
  const pre = measureSchemaComplexity(CANONICAL);
  const post = measureSchemaComplexity(PROJECTED);

  it("pre-gate canonical metrics (authority for the reduction)", () => {
    expect(pre).toEqual({ bytes: 5864, objects: 23, properties: 60, requiredProperties: 60, optionalProperties: 0, enums: 31, enumValues: 85, anyOf: 16, anyOfBranches: 39, unionParameters: 16, nullTypes: 21, arrays: 9, maxDepth: 7 });
  });

  it("the transport schema stays under these ceilings (well below the documented 16 unions / 24 optional parameters)", () => {
    expect(post.unionParameters).toBeLessThanOrEqual(8);
    expect(post.anyOf).toBeLessThanOrEqual(8);
    expect(post.anyOfBranches).toBeLessThanOrEqual(16);
    expect(post.enums).toBeLessThanOrEqual(16);
    expect(post.enumValues).toBeLessThanOrEqual(24);
    expect(post.nullTypes).toBe(0);
    expect(post.maxDepth).toBeLessThanOrEqual(6);
    expect(post.optionalProperties).toBeLessThanOrEqual(18);
    expect(post.objects).toBe(pre.objects);
    expect(post.arrays).toBe(pre.arrays);
    for (const key of ["unionParameters", "anyOfBranches", "enums", "enumValues", "nullTypes", "bytes"] as const) expect(post[key], key).toBeLessThan(pre[key]);
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
  const base = () => structuredClone(goldenOutput(testCase)) as Record<string, unknown> & { dimensions: Record<string, Record<string, unknown>> };
  const assessed = (key: string, extra: Record<string, unknown> = {}) => ({ status: "assessed", values: [{ key, confidence: "high" }], ...extra });

  it("every golden output conforms to the transport schema AND passes A1 (golden labels unchanged)", () => {
    let checked = 0;
    for (const c of CORPUS.cases.filter((x) => x.expectedFailure === null)) {
      const output = goldenOutput(c);
      expect(conforms(PROJECTED, output), c.id).toBe(true);
      expect(validateUnderstandingOutput(fromStructuredOutput(output), c.text).ok, c.id).toBe(true);
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
    const abstentionWithValues = base(); abstentionWithValues.dimensions["sentiment"] = { status: "none_fits", values: [] };
    const missingVersion = base(); Reflect.deleteProperty(missingVersion, "schemaVersion");
    const nullScore = base(); nullScore.dimensions["sentiment"] = { status: "assessed", values: [{ key: "positive", confidence: "high", score: null }] };
    for (const output of [extraKey, abstentionWithValues, missingVersion, nullScore]) expect(conforms(PROJECTED, output)).toBe(false);
  });
});
