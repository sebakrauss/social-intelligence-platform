/**
 * Anthropic provider adapter (Step H7-D0) — the ONLY code that imports the official `@anthropic-ai/sdk`. It maps the
 * gateway's provider-neutral request to ONE Messages API call and the result back to `ProviderResponse`; it decides
 * nothing else (no routing, no retry, no validation, no fallback).
 *
 *   request    system = the gateway's system text; messages = ONE user message carrying the delimited data block;
 *              output_config.format = the task's JSON Schema (native structured output; the task's validator still
 *              decides); output_config.effort and thinking from the model settings (thinking `disabled` — the lowest-
 *              cost explicit configuration; nothing left to vendor defaults); service tier `standard_only` and speed
 *              `standard` (never priority / fast); no tools, no temperature / top_p
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
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages/messages";
import type { ModelProvider, ProviderCall, ProviderFailureCause, ProviderRequest, ProviderResponse } from "@/ai/gateway";
import { normalizeConnectionCause, type TransportDiagnosticCode, type TransportDiagnosticSink } from "../diagnostics";

export const ANTHROPIC_PROVIDER_KEY = "anthropic";

export interface AnthropicModelSettings {
  readonly model: string;
  readonly effort: "low" | "medium" | "high";
  readonly thinking: "disabled";
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

export function createAnthropicProvider(options: AnthropicProviderOptions): ModelProvider {
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
        speed: "standard",
      };
      let message: Message;
      try {
        message = await options.client.messages.create(body, { timeout: options.timeoutMs, maxRetries: 0 });
      } catch (error) {
        const mapped = mapAnthropicError(error);
        const code = diagnoseAnthropicError(error);
        if (code !== null) options.onTransportDiagnostic?.({ reference: call.reference, attempt: call.attempt, code });
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
