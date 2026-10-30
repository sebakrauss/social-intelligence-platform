/**
 * Anthropic provider adapter (Step H7-D0) — the ONLY code that imports the official `@anthropic-ai/sdk`. It maps the
 * gateway's provider-neutral request to ONE Messages API call and the result back to `ProviderResponse`; it decides
 * nothing else (no routing, no retry, no validation, no fallback).
 *
 *   request    system = the gateway's system text; messages = ONE user message carrying the delimited data block;
 *              output_config.format = the task's JSON Schema (native structured output; the task's validator still
 *              decides); output_config.effort and thinking from the model settings — the model's NO-UP-FRONT-THINKING
 *              mode (`noUpfrontThinkingModeFor`: `between_tools` on Claude Sonnet 5.5, which rejects `disabled` with
 *              400; `disabled` elsewhere), validated per model when the provider is built; nothing left to vendor
 *              defaults; service tier `standard_only`; speed `standard` (never fast) — or NO `speed` field where the
 *              model rejects it (`anthropicRequestCapabilitiesFor`: Claude Sonnet 5.5, H7-D0e); no tools, no
 *              temperature / top_p
 *   client     SDK retries 0 (retries belong to the later runtime); explicit timeout; NO middleware — in particular
 *              never the SDK's refusal-fallback middleware: a refusal counts against the model that produced it and is
 *              never re-run on another model
 *   response   only `text` content blocks; thinking / redacted-thinking and every other block, ids, headers and the
 *              raw object never leave this file. `stop_reason: "refusal"` ⇒ `refused`;
 *              `model_context_window_exceeded` ⇒ provider_input_limit. The served model must be the requested one
 *              (or its dated snapshot `<model>-YYYYMMDD`) ⇒ otherwise `model_mismatch` (fail closed)
 *   errors     429 ⇒ rate_limited (+ retry-after) · timeout ⇒ timeout · 401/403 ⇒ provider_auth_failed · prompt too
 *              long ⇒ provider_input_limit · other 4xx ⇒ provider_request_rejected · 5xx / 529 / connection ⇒
 *              provider_unavailable. Anything that is not an SDK API error is a programming error and is rethrown.
 *   rejection  H7-D0c: a `provider_request_rejected` 4xx is refined, in memory, into a closed diagnostic (status, error
 *              type, category, one known field token) for an optional operator sink; the raw message never leaves here
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages/messages";
import type { ModelProvider, ProviderCall, ProviderFailureCause, ProviderRequest, ProviderResponse } from "@/ai/gateway";
import {
  isProviderErrorType,
  normalizeConnectionCause,
  type RequestRejectionCategory,
  type RequestRejectionDiagnostic,
  type RequestRejectionField,
  type RequestRejectionSink,
  type TransportDiagnosticCode,
  type TransportDiagnosticSink,
} from "../diagnostics";

export const ANTHROPIC_PROVIDER_KEY = "anthropic";

/** The explicit "no up-front thinking" configurations this adapter can send (model-specific, see below). */
export type AnthropicThinkingMode = "disabled" | "between_tools";

/**
 * H7-D0b — the no-up-front-thinking mode per model, from the official per-model thinking table (2026-10-30): Claude
 * Sonnet 5.5 rejects `thinking: {type: "disabled"}` with a 400 at every effort and takes `{type: "between_tools"}`
 * instead (accepted at effort `high` or below); ONLY Sonnet 5.5 accepts `between_tools`. Models not listed use
 * `disabled`. Extend this table per model, never with a family-wide rule.
 */
/**
 * How the adapter sends the speed parameter: `standard` (explicit standard speed, never fast) or `omitted` (no `speed`
 * field at all). H7-D0e — Claude Sonnet 5.5 rejects `speed: "standard"` with a 400 (`invalid_request_error`, sanitized
 * category `invalid_speed`, field `speed`; one live diagnostic call, 2026-10-30), so it gets NO speed field.
 */
export type AnthropicSpeedParameter = "standard" | "omitted";

/** The per-model request capabilities this adapter honours (explicit per model; never a family-wide rule). */
export interface AnthropicRequestCapabilities {
  readonly noUpfrontThinking: AnthropicThinkingMode;
  readonly speed: AnthropicSpeedParameter;
}
const DEFAULT_REQUEST_CAPABILITIES: AnthropicRequestCapabilities = Object.freeze({ noUpfrontThinking: "disabled", speed: "standard" });
const MODEL_REQUEST_CAPABILITIES: Readonly<Record<string, AnthropicRequestCapabilities>> = Object.freeze({
  "claude-sonnet-5-5": Object.freeze({ noUpfrontThinking: "between_tools", speed: "omitted" }),
});
export const anthropicRequestCapabilitiesFor = (model: string): AnthropicRequestCapabilities => MODEL_REQUEST_CAPABILITIES[model] ?? DEFAULT_REQUEST_CAPABILITIES;
export const noUpfrontThinkingModeFor = (model: string): AnthropicThinkingMode => anthropicRequestCapabilitiesFor(model).noUpfrontThinking;

export interface AnthropicModelSettings {
  readonly model: string;
  /** `between_tools` requires effort `high` or below — the only levels this type admits. */
  readonly effort: "low" | "medium" | "high";
  readonly thinking: AnthropicThinkingMode;
  readonly speed: AnthropicSpeedParameter;
  readonly maxTokens: number;
}

/** The one SDK surface the adapter uses (an injected client: the real SDK, or a test double). */
export interface AnthropicMessagesClient {
  readonly messages: { create(body: MessageCreateParamsNonStreaming, options?: { readonly timeout?: number; readonly maxRetries?: number }): PromiseLike<Message> };
}

export interface AnthropicProviderOptions {
  readonly client: AnthropicMessagesClient;
  /** modelKey (registry) → settings. */
  readonly models: Readonly<Record<string, AnthropicModelSettings>>;
  readonly timeoutMs: number;
  /** H7-D0a: operator / evaluation sink for the sanitized transport cause of a failed call (never product data). */
  readonly onTransportDiagnostic?: TransportDiagnosticSink;
  /** H7-D0c: operator / evaluation sink for the sanitized reason of a rejected request (never product data). */
  readonly onRequestRejection?: RequestRejectionSink;
}

/** The real SDK client: no SDK retries, no middleware; the key is passed in by the operator boundary. */
export function createAnthropicClient(apiKey: string): AnthropicMessagesClient {
  return new Anthropic({ apiKey, maxRetries: 0 });
}

const SNAPSHOT = /^-\d{8}$/;
export const isRequestedModel = (requested: string, served: string): boolean => served === requested || (served.startsWith(requested) && SNAPSHOT.test(served.slice(requested.length)));

const retryAfter = (headers: Headers | undefined): number | null => {
  const value = headers?.get("retry-after");
  if (value === null || value === undefined) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};
const failed = (cause: ProviderFailureCause, retryAfterSeconds: number | null = null): ProviderResponse => ({ kind: "failed", cause, retryAfterSeconds });

export function mapAnthropicError(error: unknown): ProviderResponse {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return failed("timeout");
  if (error instanceof Anthropic.APIConnectionError) return failed("provider_unavailable");
  if (error instanceof Anthropic.RateLimitError) return failed("rate_limited", retryAfter(error.headers));
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return failed("provider_auth_failed");
  if (error instanceof Anthropic.APIError) {
    const status: number = typeof error.status === "number" ? error.status : 0;
    if (status >= 500) return failed("provider_unavailable");
    // Classification only (never logged): the SDK message and the API error body, which carries the reason text.
    if (/prompt is too long|context window|too many tokens|maximum context/i.test(`${error.message} ${JSON.stringify(error.error ?? null)}`)) return failed("provider_input_limit");
    return failed("provider_request_rejected");
  }
  throw error;
}

/** The sanitized transport cause of an SDK error (a closed code; null when the failure is not transport-level). */
export function diagnoseAnthropicError(error: unknown): TransportDiagnosticCode | null {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return "request_timeout";
  if (error instanceof Anthropic.APIConnectionError) return normalizeConnectionCause(error);
  if (error instanceof Anthropic.RateLimitError) return "http_429";
  if (error instanceof Anthropic.APIError && typeof error.status === "number" && error.status >= 500) return "http_5xx";
  return null;
}

/** Field tokens in precedence order (a message naming `output_config.format.schema` is about the schema). */
const FIELD_PRECEDENCE: readonly RequestRejectionField[] = ["thinking", "speed", "service_tier", "effort", "max_tokens", "schema", "format", "output_config"];
const FIELD_CATEGORY: Readonly<Record<RequestRejectionField, RequestRejectionCategory>> = {
  thinking: "invalid_thinking",
  speed: "invalid_speed",
  service_tier: "invalid_service_tier",
  effort: "invalid_effort",
  max_tokens: "invalid_max_tokens",
  schema: "invalid_json_schema",
  format: "invalid_output_format",
  output_config: "invalid_output_format",
};
const mentions = (text: string, token: string): boolean => new RegExp(`(^|[^a-z0-9_])${token}([^a-z0-9_]|$)`).test(text);

/**
 * H7-D0c — the sanitized reason of a rejected request: only closed values (status, vendor error type, category, one
 * allowlisted field token). The SDK message and error body are matched in memory against known tokens and never
 * returned, stored or logged. Null when the error is not a 4xx API error.
 */
export function diagnoseAnthropicRejection(error: unknown): Omit<RequestRejectionDiagnostic, "reference" | "attempt"> | null {
  if (!(error instanceof Anthropic.APIError) || error instanceof Anthropic.APIConnectionError) return null;
  const status: number | null = typeof error.status === "number" && error.status >= 400 && error.status < 500 ? error.status : null;
  if (status === null) return null;
  const errorType = isProviderErrorType(error.type) ? error.type : "unknown";
  const text = `${error.message} ${JSON.stringify(error.error ?? null)}`.toLowerCase();
  if (errorType === "billing_error" || /credit balance|spend limit|spending limit|billing/.test(text)) return { status, errorType, category: "spend_limit", field: null };
  if (/too complex/.test(text)) return { status, errorType, category: "schema_too_complex", field: "schema" };
  const field = FIELD_PRECEDENCE.find((token) => mentions(text, token)) ?? null;
  if (field === null) return { status, errorType, category: "unknown_invalid_request", field: null };
  const category = field === "schema" && /not supported|unsupported|does not support/.test(text) ? "unsupported_schema_constraint" : FIELD_CATEGORY[field];
  return { status, errorType, category, field };
}

export function createAnthropicProvider(options: AnthropicProviderOptions): ModelProvider {
  // A thinking mode or speed parameter the model does not take would be rejected on every call: refuse it up front.
  for (const settings of Object.values(options.models)) {
    const capabilities = anthropicRequestCapabilitiesFor(settings.model);
    if (settings.thinking !== capabilities.noUpfrontThinking) throw new TypeError(`anthropic_thinking_mode_unsupported:${settings.model}:${settings.thinking}`);
    if (settings.speed !== capabilities.speed) throw new TypeError(`anthropic_speed_parameter_unsupported:${settings.model}:${settings.speed}`);
  }
  return {
    providerKey: ANTHROPIC_PROVIDER_KEY,
    // The call reference is tracing-only: it keys the operator diagnostic and is never sent to the vendor.
    async complete(request: ProviderRequest, call: ProviderCall): Promise<ProviderResponse> {
      const settings = options.models[request.model.modelKey];
      if (settings === undefined || request.model.providerKey !== ANTHROPIC_PROVIDER_KEY) return failed("provider_request_rejected");
      const body: MessageCreateParamsNonStreaming = {
        model: settings.model,
        max_tokens: settings.maxTokens,
        system: request.system,
        messages: [{ role: "user", content: request.data }],
        thinking: { type: settings.thinking },
        output_config: { effort: settings.effort, format: { type: "json_schema", schema: { ...request.responseFormat.jsonSchema } } },
        service_tier: "standard_only",
        // The key is absent (not undefined / null) when the model takes no speed parameter.
        ...(settings.speed === "standard" ? { speed: "standard" as const } : {}),
      };
      let message: Message;
      try {
        message = await options.client.messages.create(body, { timeout: options.timeoutMs, maxRetries: 0 });
      } catch (error) {
        const mapped = mapAnthropicError(error);
        const code = diagnoseAnthropicError(error);
        if (code !== null) options.onTransportDiagnostic?.({ reference: call.reference, attempt: call.attempt, code });
        if (mapped.kind === "failed" && mapped.cause === "provider_request_rejected") {
          const rejection = diagnoseAnthropicRejection(error);
          if (rejection !== null) options.onRequestRejection?.({ reference: call.reference, attempt: call.attempt, ...rejection });
        }
        return mapped;
      }
      if (!isRequestedModel(settings.model, message.model)) return failed("model_mismatch");
      if (message.stop_reason === "refusal") return { kind: "refused" };
      if (message.stop_reason === "model_context_window_exceeded") return failed("provider_input_limit");
      const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      return {
        kind: "completed",
        text,
        modelVersion: message.model,
        usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, cachedInputTokens: message.usage.cache_read_input_tokens },
      };
    },
  };
}
