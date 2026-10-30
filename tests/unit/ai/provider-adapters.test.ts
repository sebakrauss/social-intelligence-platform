/**
 * Step H7-D0 — the OpenAI and Anthropic adapters against MOCKED SDK clients (no network, no credential): request
 * mapping (model, system / instructions, one data message, strict JSON Schema, effort / thinking, tier, no tools, no
 * sampling knobs, SDK retries 0), response mapping (text only, reported model, usage incl. cached tokens), reasoning
 * discarded, refusal, model substitution fail-closed, and every error class mapped to the gateway's causes.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages/messages";
import OpenAI from "openai";
import type { Response, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { describe, expect, it, vi } from "vitest";
import type { ProviderRequest } from "@/ai/gateway";
import { anthropicRequestCapabilitiesFor, createAnthropicProvider, diagnoseAnthropicRejection, noUpfrontThinkingModeFor, type AnthropicMessagesClient, type AnthropicSpeedParameter, type AnthropicThinkingMode } from "@/ai/providers/anthropic";
import { REQUEST_REJECTION_CATEGORIES, REQUEST_REJECTION_FIELDS, TRANSPORT_DIAGNOSTIC_CODES, normalizeConnectionCause, type RequestRejectionDiagnostic } from "@/ai/providers/diagnostics";
import { createOpenAIProvider, type OpenAIResponsesClient } from "@/ai/providers/openai";
import { UNDERSTANDING_OUTPUT_JSON_SCHEMA } from "@/modules/classification/application/ai/understanding-output-schema";

const request = (providerKey: string, modelKey: string): ProviderRequest => ({
  model: { providerKey, modelKey },
  system: "SYSTEM POLICY",
  data: "<<<WRENKIND_UNTRUSTED_DATA_V1>>>\n{\"analyzedText\":\"hola\"}\n<<<END_WRENKIND_UNTRUSTED_DATA_V1>>>",
  responseFormat: { kind: "json", schemaVersion: "understanding-output.v1", schemaName: "wrenkind_understanding_output_v1", jsonSchema: UNDERSTANDING_OUTPUT_JSON_SCHEMA },
  maxOutputChars: 8_000,
});
/** Tracing-only call identity (an adapter never sends it to a vendor). */
const CALL = { reference: "case-1", attempt: 1 as const };
const OUTPUT = '{"schemaVersion":"understanding-output.v1"}';

// ── OpenAI ────────────────────────────────────────────────────────────────────────────────────────────────────
const openaiResponse = (overrides: Partial<Response> = {}): Response => ({
  id: "resp_1", object: "response", created_at: 0, model: "gpt-6-luna", status: "completed", error: null, incomplete_details: null, instructions: null, metadata: null,
  output: [
    { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "HIDDEN REASONING" }] },
    { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: OUTPUT, annotations: [] }] },
  ],
  output_text: OUTPUT, parallel_tool_calls: false, temperature: null, tool_choice: "none", tools: [], top_p: null,
  usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 80, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1280 },
  ...overrides,
} as unknown as Response);
const openai = (respond: () => Promise<Response>) => {
  const create = vi.fn<(body: ResponseCreateParamsNonStreaming, options?: { timeout?: number; maxRetries?: number }) => Promise<Response>>(() => respond());
  const client: OpenAIResponsesClient = { responses: { create } };
  const provider = createOpenAIProvider({ client, models: { "gpt-6-luna": { model: "gpt-6-luna", reasoningEffort: "none", maxOutputTokens: 2_000 } }, timeoutMs: 60_000 });
  return { create, provider };
};

describe("OpenAI adapter", () => {
  it("maps the request: strict JSON schema, effort none, store false, default tier, no truncation, no tools / sampling, SDK retries 0", async () => {
    const { create, provider } = openai(() => Promise.resolve(openaiResponse()));
    await provider.complete(request("openai", "gpt-6-luna"), CALL);
    const [body, options] = create.mock.calls[0] ?? [];
    expect(body).toEqual({
      model: "gpt-6-luna", instructions: "SYSTEM POLICY", input: [{ role: "user", content: request("openai", "gpt-6-luna").data }], reasoning: { effort: "none" },
      text: { format: { type: "json_schema", name: "wrenkind_understanding_output_v1", schema: UNDERSTANDING_OUTPUT_JSON_SCHEMA, strict: true } },
      max_output_tokens: 2_000, store: false, service_tier: "default", truncation: "disabled",
    });
    expect(Object.keys(body ?? {})).not.toEqual(expect.arrayContaining(["tools", "tool_choice", "temperature", "top_p", "background", "previous_response_id"]));
    expect(options).toEqual({ timeout: 60_000, maxRetries: 0 });
  });

  it("returns only the output text, the reported model and usage (cached tokens); reasoning items never leave the adapter", async () => {
    const { provider } = openai(() => Promise.resolve(openaiResponse({ model: "gpt-6-luna-2026-09-15" })));
    const result = await provider.complete(request("openai", "gpt-6-luna"), CALL);
    expect(result).toEqual({ kind: "completed", text: OUTPUT, modelVersion: "gpt-6-luna-2026-09-15", usage: { inputTokens: 1200, outputTokens: 80, cachedInputTokens: 1000 } });
    expect(JSON.stringify(result)).not.toMatch(/HIDDEN REASONING|resp_1|rs_1/);
  });

  it("a different served model fails closed (no silent substitution)", async () => {
    const { provider } = openai(() => Promise.resolve(openaiResponse({ model: "gpt-6.1-terra" })));
    expect(await provider.complete(request("openai", "gpt-6-luna"), CALL)).toEqual({ kind: "failed", cause: "model_mismatch", retryAfterSeconds: null });
  });

  it("a refusal content part, or an incomplete response for content filtering, is a refusal (not malformed JSON)", async () => {
    const refusal = openaiResponse({ output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "no" }] }] as Response["output"] });
    expect(await openai(() => Promise.resolve(refusal)).provider.complete(request("openai", "gpt-6-luna"), CALL)).toEqual({ kind: "refused" });
    const filtered = openaiResponse({ status: "incomplete", incomplete_details: { reason: "content_filter" } });
    expect(await openai(() => Promise.resolve(filtered)).provider.complete(request("openai", "gpt-6-luna"), CALL)).toEqual({ kind: "refused" });
  });

  it.each([
    ["429 + retry-after", () => new OpenAI.RateLimitError(429, { message: "slow down" }, "rate limited", new Headers({ "retry-after": "12" })), { kind: "failed", cause: "rate_limited", retryAfterSeconds: 12 }],
    ["timeout", () => new OpenAI.APIConnectionTimeoutError(), { kind: "failed", cause: "timeout", retryAfterSeconds: null }],
    ["connection", () => new OpenAI.APIConnectionError({ message: "reset" }), { kind: "failed", cause: "provider_unavailable", retryAfterSeconds: null }],
    ["401", () => new OpenAI.AuthenticationError(401, {}, "bad key", new Headers()), { kind: "failed", cause: "provider_auth_failed", retryAfterSeconds: null }],
    ["403", () => new OpenAI.PermissionDeniedError(403, {}, "forbidden", new Headers()), { kind: "failed", cause: "provider_auth_failed", retryAfterSeconds: null }],
    ["context length", () => new OpenAI.BadRequestError(400, { code: "context_length_exceeded", message: "This model's maximum context length is exceeded" }, undefined, new Headers()), { kind: "failed", cause: "provider_input_limit", retryAfterSeconds: null }],
    ["unknown model (404)", () => new OpenAI.NotFoundError(404, {}, "model not found", new Headers()), { kind: "failed", cause: "provider_request_rejected", retryAfterSeconds: null }],
    ["500", () => new OpenAI.InternalServerError(500, {}, "oops", new Headers()), { kind: "failed", cause: "provider_unavailable", retryAfterSeconds: null }],
  ] as const)("maps %s", async (_name, error, expected) => {
    expect(await openai(() => Promise.reject(error())).provider.complete(request("openai", "gpt-6-luna"), CALL)).toEqual(expected);
  });

  it("an unconfigured model is rejected without a call; a non-SDK error is a programming error (rethrown)", async () => {
    const { create, provider } = openai(() => Promise.resolve(openaiResponse()));
    expect(await provider.complete(request("openai", "other"), CALL)).toMatchObject({ kind: "failed", cause: "provider_request_rejected" });
    expect(create).not.toHaveBeenCalled();
    await expect(openai(() => Promise.reject(new TypeError("bug"))).provider.complete(request("openai", "gpt-6-luna"), CALL)).rejects.toThrow("bug");
  });
});

// ── Anthropic ─────────────────────────────────────────────────────────────────────────────────────────────────
const message = (overrides: Partial<Message> = {}): Message => ({
  id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn", stop_sequence: null, stop_details: null, container: null, diagnostics: null,
  content: [{ type: "thinking", thinking: "HIDDEN THINKING", signature: "sig" }, { type: "text", text: OUTPUT, citations: null }],
  usage: { input_tokens: 900, output_tokens: 70, cache_read_input_tokens: 300, cache_creation_input_tokens: 0, cache_creation: null, inference_geo: null, server_tool_use: null, service_tier: "standard", output_tokens_details: null },
  ...overrides,
} as unknown as Message);
const anthropic = (respond: () => Promise<Message>) => {
  const create = vi.fn<(body: MessageCreateParamsNonStreaming, options?: { timeout?: number; maxRetries?: number }) => Promise<Message>>(() => respond());
  const client: AnthropicMessagesClient = { messages: { create } };
  const provider = createAnthropicProvider({ client, models: { "claude-sonnet-5-5": { model: "claude-sonnet-5-5", effort: "low", thinking: "between_tools", speed: "omitted", maxTokens: 2_000 } }, timeoutMs: 60_000 });
  return { create, provider };
};

describe("Anthropic adapter", () => {
  it("maps the request: native JSON schema, effort low, thinking between_tools + no speed field (Sonnet 5.5), standard tier, no tools / sampling, SDK retries 0", async () => {
    const { create, provider } = anthropic(() => Promise.resolve(message()));
    await provider.complete(request("anthropic", "claude-sonnet-5-5"), CALL);
    const [body, options] = create.mock.calls[0] ?? [];
    expect(body).toEqual({
      model: "claude-sonnet-5-5", max_tokens: 2_000, system: "SYSTEM POLICY", messages: [{ role: "user", content: request("anthropic", "claude-sonnet-5-5").data }],
      thinking: { type: "between_tools" }, output_config: { effort: "low", format: { type: "json_schema", schema: UNDERSTANDING_OUTPUT_JSON_SCHEMA } }, service_tier: "standard_only",
    });
    expect(Object.keys(body ?? {})).not.toEqual(expect.arrayContaining(["tools", "tool_choice", "temperature", "top_p", "top_k"]));
    expect(options).toEqual({ timeout: 60_000, maxRetries: 0 });
  });

  it("returns only text blocks, the reported model and usage; thinking never leaves the adapter", async () => {
    const result = await anthropic(() => Promise.resolve(message({ model: "claude-sonnet-5-5-20261001" }))).provider.complete(request("anthropic", "claude-sonnet-5-5"), CALL);
    expect(result).toEqual({ kind: "completed", text: OUTPUT, modelVersion: "claude-sonnet-5-5-20261001", usage: { inputTokens: 900, outputTokens: 70, cachedInputTokens: 300 } });
    expect(JSON.stringify(result)).not.toMatch(/HIDDEN THINKING|sig|msg_1/);
  });

  it("refusal stop reason ⇒ refused; context window ⇒ input limit; another model ⇒ model_mismatch", async () => {
    expect(await anthropic(() => Promise.resolve(message({ stop_reason: "refusal" }))).provider.complete(request("anthropic", "claude-sonnet-5-5"), CALL)).toEqual({ kind: "refused" });
    expect(await anthropic(() => Promise.resolve(message({ stop_reason: "model_context_window_exceeded" }))).provider.complete(request("anthropic", "claude-sonnet-5-5"), CALL)).toMatchObject({ cause: "provider_input_limit" });
    expect(await anthropic(() => Promise.resolve(message({ model: "claude-haiku-4-5" }))).provider.complete(request("anthropic", "claude-sonnet-5-5"), CALL)).toMatchObject({ cause: "model_mismatch" });
  });

  it.each([
    ["429 + retry-after", () => new Anthropic.RateLimitError(429, {}, "rate limited", new Headers({ "retry-after": "7" })), { kind: "failed", cause: "rate_limited", retryAfterSeconds: 7 }],
    ["timeout", () => new Anthropic.APIConnectionTimeoutError(), { kind: "failed", cause: "timeout", retryAfterSeconds: null }],
    ["401", () => new Anthropic.AuthenticationError(401, {}, "bad key", new Headers()), { kind: "failed", cause: "provider_auth_failed", retryAfterSeconds: null }],
    ["prompt too long", () => new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } }, undefined, new Headers()), { kind: "failed", cause: "provider_input_limit", retryAfterSeconds: null }],
    ["invalid request", () => new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "output_config.effort: invalid" } }, undefined, new Headers()), { kind: "failed", cause: "provider_request_rejected", retryAfterSeconds: null }],
    ["529 overloaded", () => new Anthropic.InternalServerError(529, {}, "overloaded", new Headers()), { kind: "failed", cause: "provider_unavailable", retryAfterSeconds: null }],
  ] as const)("maps %s", async (_name, error, expected) => {
    expect(await anthropic(() => Promise.reject(error())).provider.complete(request("anthropic", "claude-sonnet-5-5"), CALL)).toEqual(expected);
  });
});

// ── H7-D0a: sanitized transport diagnostics ──────────────────────────────────────────────────────────────────
describe("transport diagnostics (operator metadata only)", () => {
  const leaky = (code: string) => Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:443 api.example-vendor.com /v1/responses Authorization: Bearer xyz"), { code });
  const fetchFailed = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: leaky(code) });
  const sinkFor = () => {
    const seen: unknown[] = [];
    return { seen, sink: (d: unknown) => { seen.push(d); } };
  };

  it("normalizes a closed vocabulary from the cause chain only; unknown → unknown_connection_error", () => {
    expect(normalizeConnectionCause(fetchFailed("ECONNRESET"))).toBe("ECONNRESET");
    expect(normalizeConnectionCause(fetchFailed("UND_ERR_CONNECT_TIMEOUT"))).toBe("UND_ERR_CONNECT_TIMEOUT");
    expect(normalizeConnectionCause(fetchFailed("UND_ERR_SOCKET"))).toBe("socket_closed");
    expect(normalizeConnectionCause(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("request_aborted");
    expect(normalizeConnectionCause(fetchFailed("SOMETHING_NEW"))).toBe("unknown_connection_error");
    expect(normalizeConnectionCause(new Error("api.example-vendor.com unreachable"))).toBe("unknown_connection_error");
    expect(normalizeConnectionCause(null)).toBe("unknown_connection_error");
    for (const code of ["ECONNRESET", "socket_closed", "unknown_connection_error"]) expect(TRANSPORT_DIAGNOSTIC_CODES).toContain(code);
  });

  it("OpenAI: a connection error reports its normalized cause to the sink (reference + attempt + code only); the response mapping is unchanged", async () => {
    const { seen, sink } = sinkFor();
    const create = vi.fn(() => Promise.reject(new OpenAI.APIConnectionError({ cause: fetchFailed("ECONNRESET") })));
    const provider = createOpenAIProvider({ client: { responses: { create } }, models: { "gpt-6-luna": { model: "gpt-6-luna", reasoningEffort: "none", maxOutputTokens: 2_000 } }, timeoutMs: 30_000, onTransportDiagnostic: sink });
    expect(await provider.complete(request("openai", "gpt-6-luna"), { reference: "case-7", attempt: 2 })).toEqual({ kind: "failed", cause: "provider_unavailable", retryAfterSeconds: null });
    expect(seen).toEqual([{ reference: "case-7", attempt: 2, code: "ECONNRESET" }]);
    expect(JSON.stringify(seen)).not.toMatch(/10\.1\.2\.3|example-vendor|Bearer|v1\/responses|fetch failed/);
  });

  it("Anthropic: socket / timeout / 429 / 5xx codes; a non-transport error reports nothing", async () => {
    const cases: [() => Error, string | null][] = [
      [() => new Anthropic.APIConnectionError({ cause: fetchFailed("UND_ERR_SOCKET") }), "socket_closed"],
      [() => new Anthropic.APIConnectionTimeoutError(), "request_timeout"],
      [() => new Anthropic.RateLimitError(429, {}, "slow", new Headers()), "http_429"],
      [() => new Anthropic.InternalServerError(529, {}, "overloaded", new Headers()), "http_5xx"],
      [() => new Anthropic.APIConnectionError({ cause: fetchFailed("WHO_KNOWS") }), "unknown_connection_error"],
      [() => new Anthropic.BadRequestError(400, {}, "bad", new Headers()), null],
      [() => new Anthropic.AuthenticationError(401, {}, "bad key", new Headers()), null],
    ];
    for (const [error, code] of cases) {
      const { seen, sink } = sinkFor();
      const provider = createAnthropicProvider({ client: { messages: { create: () => Promise.reject(error()) } }, models: { "claude-sonnet-5-5": { model: "claude-sonnet-5-5", effort: "low", thinking: "between_tools", speed: "omitted", maxTokens: 2_000 } }, timeoutMs: 30_000, onTransportDiagnostic: sink });
      await provider.complete(request("anthropic", "claude-sonnet-5-5"), CALL);
      expect(seen, String(code)).toEqual(code === null ? [] : [{ reference: "case-1", attempt: 1, code }]);
    }
  });

  it("a provider response never reports a diagnostic; without a sink nothing breaks", async () => {
    const { seen, sink } = sinkFor();
    await createOpenAIProvider({ client: { responses: { create: () => Promise.resolve(openaiResponse()) } }, models: { "gpt-6-luna": { model: "gpt-6-luna", reasoningEffort: "none", maxOutputTokens: 2_000 } }, timeoutMs: 30_000, onTransportDiagnostic: sink }).complete(request("openai", "gpt-6-luna"), CALL);
    expect(seen).toEqual([]);
    expect(await openai(() => Promise.reject(new OpenAI.APIConnectionError({ cause: fetchFailed("ECONNRESET") }))).provider.complete(request("openai", "gpt-6-luna"), CALL)).toMatchObject({ cause: "provider_unavailable" });
  });
});

// ── H7-D0b regression: Claude Sonnet 5.5 rejects thinking "disabled" with HTTP 400 ──────────────────────────
describe("H7-D0b: Sonnet 5.5 thinking-mode regression (the 67/67 provider_request_rejected bake-off failure)", () => {
  const models = (thinking: AnthropicThinkingMode, model = "claude-sonnet-5-5", speed: AnthropicSpeedParameter = anthropicRequestCapabilitiesFor(model).speed) => ({ [model]: { model, effort: "low" as const, thinking, speed, maxTokens: 2_000 } });
  const client = () => {
    const create = vi.fn<(body: MessageCreateParamsNonStreaming) => Promise<Message>>(() => Promise.resolve(message()));
    return { create, client: { messages: { create } } };
  };

  it("Sonnet 5.5 sends thinking between_tools — never disabled — with effort low, the same schema, standard tier, no speed field, no tools / sampling", async () => {
    const { create, client: c } = client();
    await createAnthropicProvider({ client: c, models: models("between_tools"), timeoutMs: 30_000 }).complete(request("anthropic", "claude-sonnet-5-5"), CALL);
    const body = create.mock.calls[0]?.[0];
    expect(body?.thinking).toEqual({ type: "between_tools" });
    expect(JSON.stringify(body)).not.toContain('"disabled"');
    expect(body?.output_config).toEqual({ effort: "low", format: { type: "json_schema", schema: UNDERSTANDING_OUTPUT_JSON_SCHEMA } });
    expect(body?.service_tier).toBe("standard_only");
    expect(body !== undefined && Object.hasOwn(body, "speed")).toBe(false);
    for (const key of ["tools", "tool_choice", "temperature", "top_p", "top_k", "budget_tokens", "display", "block_binding"]) expect(JSON.stringify(body), key).not.toContain(`"${key}"`);
  });

  it("a configuration that would 400 is refused when the provider is built (no call is ever made)", () => {
    const { create, client: c } = client();
    expect(() => createAnthropicProvider({ client: c, models: models("disabled"), timeoutMs: 30_000 })).toThrow("anthropic_thinking_mode_unsupported:claude-sonnet-5-5:disabled");
    // between_tools is Sonnet 5.5 only: never applied family-wide.
    expect(() => createAnthropicProvider({ client: c, models: models("between_tools", "claude-other-model"), timeoutMs: 30_000 })).toThrow("anthropic_thinking_mode_unsupported:claude-other-model:between_tools");
    expect(create).not.toHaveBeenCalled();
    expect([noUpfrontThinkingModeFor("claude-sonnet-5-5"), noUpfrontThinkingModeFor("claude-other-model")]).toEqual(["between_tools", "disabled"]);
  });

  it("thinking blocks are still discarded and a different served model still fails closed", async () => {
    const result = await createAnthropicProvider({ client: client().client, models: models("between_tools"), timeoutMs: 30_000 }).complete(request("anthropic", "claude-sonnet-5-5"), CALL);
    expect(JSON.stringify(result)).not.toMatch(/HIDDEN THINKING/);
    const mismatch = { messages: { create: () => Promise.resolve(message({ model: "claude-sonnet-5" })) } };
    expect(await createAnthropicProvider({ client: mismatch, models: models("between_tools"), timeoutMs: 30_000 }).complete(request("anthropic", "claude-sonnet-5-5"), CALL)).toMatchObject({ cause: "model_mismatch" });
  });
});

// ── H7-D0c: the remaining Anthropic 400 — static schema audit + sanitized rejection diagnostics ─────────────────
describe("H7-D0c: the native-output schema stays inside Anthropic's documented structured-output subset", () => {
  type Node = Readonly<Record<string, unknown>>;
  const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);
  /** Every node with its path, walking properties, anyOf branches and array items. */
  const nodes = (node: unknown, at = "$"): [string, Node][] => {
    if (!isNode(node)) return [];
    const props = isNode(node["properties"]) ? Object.entries(node["properties"]).flatMap(([k, v]) => nodes(v, `${at}.${k}`)) : [];
    const branches = Array.isArray(node["anyOf"]) ? (node["anyOf"] as unknown[]).flatMap((b, i) => nodes(b, `${at}|${String(i)}`)) : [];
    return [[at, node], ...props, ...branches, ...nodes(node["items"], `${at}[]`)];
  };
  const ALL = nodes(UNDERSTANDING_OUTPUT_JSON_SCHEMA);
  const params = ALL.flatMap(([at, node]) => (node["type"] === "object" && isNode(node["properties"]) ? Object.entries(node["properties"]).map(([k, v]) => ({ at: `${at}.${k}`, required: (node["required"] as string[]).includes(k), schema: v as Node })) : []));

  it("no documented-unsupported keyword anywhere (string / numeric / array constraints, recursion, external $ref, oneOf, …)", () => {
    const UNSUPPORTED = ["minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "maxItems", "uniqueItems", "contains", "prefixItems", "pattern", "patternProperties", "propertyNames", "minProperties", "maxProperties", "oneOf", "not", "if", "then", "else", "$ref", "$defs", "definitions", "allOf", "dependentRequired", "dependentSchemas", "unevaluatedProperties"];
    for (const [at, node] of ALL) {
      for (const key of UNSUPPORTED) expect(Object.hasOwn(node, key), `${at}: ${key}`).toBe(false);
      if (Object.hasOwn(node, "minItems")) expect([0, 1], at).toContain(node["minItems"]);
      if (Array.isArray(node["enum"])) for (const value of node["enum"] as unknown[]) expect(typeof value === "object" && value !== null, `${at}: complex enum`).toBe(false);
      if (node["type"] === "object") expect(node["additionalProperties"], at).toBe(false);
    }
    expect([...new Set(ALL.flatMap(([, node]) => Object.keys(node)))].sort()).toEqual(["additionalProperties", "anyOf", "enum", "items", "properties", "required", "type"]);
  });

  it("within the documented complexity limits: ≤ 24 optional parameters, ≤ 16 union-typed parameters (pinned: 0 and 16 — at the union limit)", () => {
    const optional = params.filter((p) => !p.required);
    const unions = params.filter((p) => Array.isArray(p.schema["anyOf"]) || Array.isArray(p.schema["type"]));
    expect(optional).toEqual([]);
    expect(unions.length).toBeLessThanOrEqual(16);
    // Pinned so any taxonomy / schema growth is a visible decision: one more union-typed field crosses the documented limit.
    expect(unions.length).toBe(16);
  });
});

describe("H7-D0c: sanitized Anthropic request-rejection diagnostics", () => {
  const SECRET = "SECRET-PROMPT-TEXT req_011SECRET https://leak.example";
  const bad = (message: string, type = "invalid_request_error", status = 400) =>
    Anthropic.APIError.generate(status, { type: "error", error: { type, message: `${message} ${SECRET}` }, request_id: "req_011SECRET" }, undefined, new Headers());
  const diag = (message: string, type?: string, status?: number) => diagnoseAnthropicRejection(bad(message, type, status));

  it("maps a known field token to a closed category; unknown text ⇒ unknown_invalid_request; never echoes the message", () => {
    const cases: [string, string, string | null][] = [
      ["thinking.type: between_tools is not supported at this effort", "invalid_thinking", "thinking"],
      ["output_config.effort: unexpected value", "invalid_effort", "effort"],
      ["speed: not available for this model", "invalid_speed", "speed"],
      ["service_tier: invalid value", "invalid_service_tier", "service_tier"],
      ["max_tokens: must be at most 64000", "invalid_max_tokens", "max_tokens"],
      ["output_config.format.schema: invalid JSON schema", "invalid_json_schema", "schema"],
      ["output_config.format.schema: minLength is not supported", "unsupported_schema_constraint", "schema"],
      ["Schema is too complex for compilation.", "schema_too_complex", "schema"],
      ["output_config.format: unknown type", "invalid_output_format", "format"],
      ["Your credit balance is too low to access the Anthropic API.", "spend_limit", null],
      ["something entirely different happened", "unknown_invalid_request", null],
    ];
    for (const [message, category, field] of cases) {
      const result = diag(message);
      expect(result, message).toEqual({ status: 400, errorType: "invalid_request_error", category, field });
      expect(JSON.stringify(result), message).not.toMatch(/SECRET|req_|leak|https?:|between_tools|minLength|credit|64000/);
    }
    expect(REQUEST_REJECTION_CATEGORIES).toContain("unknown_invalid_request");
    expect([...REQUEST_REJECTION_FIELDS].sort()).toEqual(["effort", "format", "max_tokens", "output_config", "schema", "service_tier", "speed", "thinking"]);
  });

  it("status and error type are closed: billing_error ⇒ spend_limit; unknown vendor type ⇒ unknown; non-4xx / connection ⇒ null", () => {
    expect(diag("whatever", "billing_error")).toEqual({ status: 400, errorType: "billing_error", category: "spend_limit", field: null });
    expect(diag("model: not found", "not_found_error", 404)).toEqual({ status: 404, errorType: "not_found_error", category: "unknown_invalid_request", field: null });
    expect(diag("thinking bad", "made_up_vendor_type")).toMatchObject({ errorType: "unknown", category: "invalid_thinking" });
    expect(diagnoseAnthropicRejection(new Anthropic.InternalServerError(500, {}, "thinking", new Headers()))).toBeNull();
    expect(diagnoseAnthropicRejection(new Anthropic.APIConnectionError({ cause: new Error("thinking") }))).toBeNull();
    expect(diagnoseAnthropicRejection(new Error("thinking"))).toBeNull();
  });

  it("the adapter reports it ONLY for provider_request_rejected, with the call identity; the gateway result is unchanged", async () => {
    const run = async (error: () => Error) => {
      const seen: RequestRejectionDiagnostic[] = [];
      const provider = createAnthropicProvider({ client: { messages: { create: () => Promise.reject(error()) } }, models: { "claude-sonnet-5-5": { model: "claude-sonnet-5-5", effort: "low", thinking: "between_tools", speed: "omitted", maxTokens: 2_000 } }, timeoutMs: 30_000, onRequestRejection: (d) => { seen.push(d); } });
      return { result: await provider.complete(request("anthropic", "claude-sonnet-5-5"), CALL), seen };
    };
    const rejected = await run(() => bad("speed: not supported for this model"));
    expect(rejected.result).toEqual({ kind: "failed", cause: "provider_request_rejected", retryAfterSeconds: null });
    expect(rejected.seen).toEqual([{ reference: "case-1", attempt: 1, status: 400, errorType: "invalid_request_error", category: "invalid_speed", field: "speed" }]);
    for (const error of [() => bad("prompt is too long: 300000 tokens"), () => new Anthropic.AuthenticationError(401, {}, "thinking", new Headers()), () => new Anthropic.RateLimitError(429, {}, "thinking", new Headers()), () => new Anthropic.InternalServerError(529, {}, "thinking", new Headers()), () => new Anthropic.APIConnectionTimeoutError()]) {
      const { seen } = await run(error);
      expect(seen).toEqual([]);
    }
  });
});

// ── H7-D0e regression: Claude Sonnet 5.5 rejects `speed: "standard"` with HTTP 400 (invalid_speed / speed) ────────
describe("H7-D0e: Sonnet 5.5 speed omission", () => {
  const capture = async (model: string, speed: AnthropicSpeedParameter, thinking: AnthropicThinkingMode) => {
    const create = vi.fn<(body: MessageCreateParamsNonStreaming) => Promise<Message>>(() => Promise.resolve(message({ model })));
    await createAnthropicProvider({ client: { messages: { create } }, models: { [model]: { model, effort: "low", thinking, speed, maxTokens: 2_000 } }, timeoutMs: 30_000 }).complete(request("anthropic", model), CALL);
    const body = create.mock.calls[0]?.[0];
    if (body === undefined) throw new Error("no call");
    return body;
  };

  it("the Sonnet 5.5 request has NO speed key — not undefined, not null, not standard — and survives serialization without one", async () => {
    const body = await capture("claude-sonnet-5-5", "omitted", "between_tools");
    expect(Object.hasOwn(body, "speed")).toBe(false);
    expect(Object.keys(body)).not.toContain("speed");
    expect(JSON.stringify(body)).not.toContain('"speed"');
    expect(Object.keys(JSON.parse(JSON.stringify(body)) as object)).not.toContain("speed");
  });

  it("the ONLY outbound difference from the H7-D0d request is the removed speed field (everything else equivalent)", async () => {
    const body = await capture("claude-sonnet-5-5", "omitted", "between_tools");
    const h7d0d = {
      model: "claude-sonnet-5-5", max_tokens: 2_000, system: "SYSTEM POLICY", messages: [{ role: "user", content: request("anthropic", "claude-sonnet-5-5").data }],
      thinking: { type: "between_tools" }, output_config: { effort: "low", format: { type: "json_schema", schema: UNDERSTANDING_OUTPUT_JSON_SCHEMA } }, service_tier: "standard_only", speed: "standard",
    };
    const { speed, ...rest } = h7d0d;
    expect(speed).toBe("standard");
    expect(body).toEqual(rest);
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "output_config", "service_tier", "system", "thinking"]);
    for (const key of ["tools", "tool_choice", "temperature", "top_p", "top_k", "budget_tokens", "display", "block_binding"]) expect(JSON.stringify(body), key).not.toContain(`"${key}"`);
  });

  it("model-specific, never family-wide: other models keep explicit standard speed; a mismatched setting is refused before any call", async () => {
    expect(anthropicRequestCapabilitiesFor("claude-sonnet-5-5")).toEqual({ noUpfrontThinking: "between_tools", speed: "omitted" });
    expect(anthropicRequestCapabilitiesFor("claude-other-model")).toEqual({ noUpfrontThinking: "disabled", speed: "standard" });
    expect((await capture("claude-other-model", "standard", "disabled")).speed).toBe("standard");
    const create = vi.fn();
    const client = { messages: { create } } as unknown as AnthropicMessagesClient;
    const settings = (model: string, thinking: AnthropicThinkingMode, speed: AnthropicSpeedParameter) => ({ [model]: { model, effort: "low" as const, thinking, speed, maxTokens: 2_000 } });
    expect(() => createAnthropicProvider({ client, models: settings("claude-sonnet-5-5", "between_tools", "standard"), timeoutMs: 30_000 })).toThrow("anthropic_speed_parameter_unsupported:claude-sonnet-5-5:standard");
    expect(() => createAnthropicProvider({ client, models: settings("claude-other-model", "disabled", "omitted"), timeoutMs: 30_000 })).toThrow("anthropic_speed_parameter_unsupported:claude-other-model:omitted");
    expect(create).not.toHaveBeenCalled();
  });
});
