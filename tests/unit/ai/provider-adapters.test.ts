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
import { createAnthropicProvider, type AnthropicMessagesClient } from "@/ai/providers/anthropic";
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
  const provider = createAnthropicProvider({ client, models: { "claude-sonnet-5-5": { model: "claude-sonnet-5-5", effort: "low", thinking: "disabled", maxTokens: 2_000 } }, timeoutMs: 60_000 });
  return { create, provider };
};

describe("Anthropic adapter", () => {
  it("maps the request: native JSON schema, effort low, thinking disabled, standard tier/speed, no tools / sampling, SDK retries 0", async () => {
    const { create, provider } = anthropic(() => Promise.resolve(message()));
    await provider.complete(request("anthropic", "claude-sonnet-5-5"), CALL);
    const [body, options] = create.mock.calls[0] ?? [];
    expect(body).toEqual({
      model: "claude-sonnet-5-5", max_tokens: 2_000, system: "SYSTEM POLICY", messages: [{ role: "user", content: request("anthropic", "claude-sonnet-5-5").data }],
      thinking: { type: "disabled" }, output_config: { effort: "low", format: { type: "json_schema", schema: UNDERSTANDING_OUTPUT_JSON_SCHEMA } }, service_tier: "standard_only", speed: "standard",
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
