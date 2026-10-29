/**
 * OpenAI provider adapter (Step H7-D0) — the ONLY code that imports the official `openai` SDK. It maps the gateway's
 * provider-neutral request to ONE Responses API call and the result back to `ProviderResponse`; it decides nothing else
 * (no routing, no retry, no validation, no fallback).
 *
 *   request    instructions = the gateway's system text; input = ONE user message carrying the delimited data block;
 *              text.format = the task's JSON Schema, `strict: true` (native Structured Outputs; the task's validator still
 *              decides); reasoning.effort from the model settings (no summary requested); store false; service tier
 *              `default` (never priority / fast / flex); truncation disabled (never silently cut); no tools, no
 *              temperature / top_p (reasoning models reject them; nothing is tuned per candidate)
 *   client     SDK retries 0 (retries belong to the later runtime, never hidden here); explicit timeout
 *   response   only `output_text` of message items; reasoning items, ids, headers and the raw object never leave this
 *              file. A refusal content part, or an incomplete response for content filtering ⇒ `refused`.
 *              The served model must be the requested one (or its dated snapshot `<model>-YYYY-MM-DD`) ⇒ otherwise
 *              `model_mismatch` (fail closed: no silent substitution)
 *   errors     429 ⇒ rate_limited (+ retry-after) · timeout ⇒ timeout · 401/403 ⇒ provider_auth_failed ·
 *              context length ⇒ provider_input_limit · other 4xx ⇒ provider_request_rejected · 5xx / connection ⇒
 *              provider_unavailable. Anything that is not an SDK API error is a programming error and is rethrown.
 */
import OpenAI from "openai";
import type { Response, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import type { ModelProvider, ProviderFailureCause, ProviderRequest, ProviderResponse } from "@/ai/gateway";

export const OPENAI_PROVIDER_KEY = "openai";

export interface OpenAIModelSettings {
  /** The exact API model id requested (never an alias the provider may remap silently). */
  readonly model: string;
  readonly reasoningEffort: "none" | "minimal" | "low" | "medium" | "high";
  readonly maxOutputTokens: number;
}

/** The one SDK surface the adapter uses (an injected client: the real SDK, or a test double). */
export interface OpenAIResponsesClient {
  readonly responses: { create(body: ResponseCreateParamsNonStreaming, options?: { readonly timeout?: number; readonly maxRetries?: number }): PromiseLike<Response> };
}

export interface OpenAIProviderOptions {
  readonly client: OpenAIResponsesClient;
  /** modelKey (registry) → settings. */
  readonly models: Readonly<Record<string, OpenAIModelSettings>>;
  readonly timeoutMs: number;
}

/** The real SDK client: no SDK retries; the key is passed in by the operator boundary (never read here). */
export function createOpenAIClient(apiKey: string): OpenAIResponsesClient {
  return new OpenAI({ apiKey, maxRetries: 0 });
}

const SNAPSHOT = /^-\d{4}-\d{2}-\d{2}$/;
export const isRequestedModel = (requested: string, served: string): boolean => served === requested || (served.startsWith(requested) && SNAPSHOT.test(served.slice(requested.length)));

const retryAfter = (headers: Headers | undefined): number | null => {
  const value = headers?.get("retry-after");
  if (value === null || value === undefined) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};
const failed = (cause: ProviderFailureCause, retryAfterSeconds: number | null = null): ProviderResponse => ({ kind: "failed", cause, retryAfterSeconds });

export function mapOpenAIError(error: unknown): ProviderResponse {
  if (error instanceof OpenAI.APIConnectionTimeoutError) return failed("timeout");
  if (error instanceof OpenAI.APIConnectionError) return failed("provider_unavailable");
  if (error instanceof OpenAI.RateLimitError) return failed("rate_limited", retryAfter(error.headers));
  if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) return failed("provider_auth_failed");
  if (error instanceof OpenAI.APIError) {
    const status: number = typeof error.status === "number" ? error.status : 0;
    if (status >= 500) return failed("provider_unavailable");
    // Classification only (never logged): the error code, the SDK message and the API error body.
    if (error.code === "context_length_exceeded" || /context (length|window)|maximum context|too many tokens|input is too long/i.test(`${error.message} ${JSON.stringify(error.error ?? null)}`)) return failed("provider_input_limit");
    return failed("provider_request_rejected");
  }
  throw error;
}

export function createOpenAIProvider(options: OpenAIProviderOptions): ModelProvider {
  return {
    providerKey: OPENAI_PROVIDER_KEY,
    // The call reference is tracing-only and is never sent to the vendor (so it is not taken here at all).
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      const settings = options.models[request.model.modelKey];
      if (settings === undefined || request.model.providerKey !== OPENAI_PROVIDER_KEY) return failed("provider_request_rejected");
      const body: ResponseCreateParamsNonStreaming = {
        model: settings.model,
        instructions: request.system,
        input: [{ role: "user", content: request.data }],
        reasoning: { effort: settings.reasoningEffort },
        text: { format: { type: "json_schema", name: request.responseFormat.schemaName, schema: { ...request.responseFormat.jsonSchema }, strict: true } },
        max_output_tokens: settings.maxOutputTokens,
        store: false,
        service_tier: "default",
        truncation: "disabled",
      };
      let response: Response;
      try {
        response = await options.client.responses.create(body, { timeout: options.timeoutMs, maxRetries: 0 });
      } catch (error) {
        return mapOpenAIError(error);
      }
      if (!isRequestedModel(settings.model, response.model)) return failed("model_mismatch");
      const messages = response.output.flatMap((item) => (item.type === "message" ? [item] : []));
      if (messages.some((message) => message.content.some((part) => part.type === "refusal"))) return { kind: "refused" };
      if (response.status === "incomplete" && response.incomplete_details?.reason === "content_filter") return { kind: "refused" };
      const text = messages.flatMap((message) => message.content.flatMap((part) => (part.type === "output_text" ? [part.text] : []))).join("");
      const usage = response.usage;
      return {
        kind: "completed",
        text,
        modelVersion: response.model,
        usage: usage === undefined ? null : { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cachedInputTokens: usage.input_tokens_details.cached_tokens },
      };
    },
  };
}
