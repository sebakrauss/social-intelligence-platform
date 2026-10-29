/**
 * Step H7-D0 — the bake-off candidates and their EXACT settings (TL decision; no per-candidate tuning, no fallback, no
 * tools, no priority / fast tier, no batch). One evaluation case = one explicit candidate model.
 *
 *   gpt-6-luna          OpenAI Responses · reasoning effort `none` · strict JSON schema
 *   gpt-6.1-terra       OpenAI Responses · reasoning effort `none` · strict JSON schema
 *   claude-sonnet-5-5   Anthropic Messages · effort `low` + thinking `disabled` (the lowest-cost explicit configuration) ·
 *                       native JSON-schema output
 *
 * Every candidate gets the same prompt, task, schema, data and output-token cap (2 000) — the same semantic task.
 */
import type { ModelDescriptor, ModelProvider } from "@/ai/gateway";
import { createAnthropicClient, createAnthropicProvider, type AnthropicModelSettings } from "@/ai/providers/anthropic";
import { createOpenAIClient, createOpenAIProvider, type OpenAIModelSettings } from "@/ai/providers/openai";

export const MAX_OUTPUT_TOKENS = 2_000;
export const CALL_TIMEOUT_MS = 120_000;

export type CandidateId = "gpt-6-luna" | "gpt-6.1-terra" | "claude-sonnet-5-5";

export type Candidate =
  | { readonly id: CandidateId; readonly providerKey: "openai"; readonly credential: "OPENAI_API_KEY"; readonly settings: OpenAIModelSettings }
  | { readonly id: CandidateId; readonly providerKey: "anthropic"; readonly credential: "ANTHROPIC_API_KEY"; readonly settings: AnthropicModelSettings };

export const CANDIDATES: Readonly<Record<CandidateId, Candidate>> = Object.freeze({
  "gpt-6-luna": { id: "gpt-6-luna", providerKey: "openai", credential: "OPENAI_API_KEY", settings: { model: "gpt-6-luna", reasoningEffort: "none", maxOutputTokens: MAX_OUTPUT_TOKENS } },
  "gpt-6.1-terra": { id: "gpt-6.1-terra", providerKey: "openai", credential: "OPENAI_API_KEY", settings: { model: "gpt-6.1-terra", reasoningEffort: "none", maxOutputTokens: MAX_OUTPUT_TOKENS } },
  "claude-sonnet-5-5": { id: "claude-sonnet-5-5", providerKey: "anthropic", credential: "ANTHROPIC_API_KEY", settings: { model: "claude-sonnet-5-5", effort: "low", thinking: "disabled", maxTokens: MAX_OUTPUT_TOKENS } },
});

export const isCandidateId = (value: string): value is CandidateId => Object.hasOwn(CANDIDATES, value);

export function candidateModel(candidate: Candidate): ModelDescriptor {
  return Object.freeze({
    providerKey: candidate.providerKey,
    modelKey: candidate.id,
    modelVersion: candidate.settings.model,
    enabled: true,
    structuredOutput: "native_json_schema" as const,
    tools: "none" as const,
    maxInputChars: 200_000,
    maxOutputChars: MAX_OUTPUT_TOKENS * 4,
    cost: Object.freeze({ status: "OPEN" as const }),
  });
}

/** The real provider for one candidate (the key comes from the operator boundary and goes only to the SDK client). */
export function candidateProvider(candidate: Candidate, apiKey: string): ModelProvider {
  return candidate.providerKey === "openai"
    ? createOpenAIProvider({ client: createOpenAIClient(apiKey), models: { [candidate.id]: candidate.settings }, timeoutMs: CALL_TIMEOUT_MS })
    : createAnthropicProvider({ client: createAnthropicClient(apiKey), models: { [candidate.id]: candidate.settings }, timeoutMs: CALL_TIMEOUT_MS });
}
