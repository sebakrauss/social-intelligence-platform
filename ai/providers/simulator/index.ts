/**
 * The deterministic model SIMULATOR (Step H7-C; H7-A0 §10 "a simulator provider (fixture-driven, deterministic) is the
 * default in tests"). It is NOT a classifier: it never reads the request's system or data — it answers from a script
 * keyed by the call's opaque reference and attempt number. No randomness, no clock, no network, no environment, no
 * file access (scripts are parsed from values the caller loaded).
 *
 * Scripted responses: a structured output (any JSON value, serialized), raw text (malformed output), a refusal, a
 * transport failure (unavailable · timeout · rate limited) or a provider input-limit refusal. A scripted `reasoning`
 * field models a vendor that returns reasoning: the adapter DISCARDS it (no gateway type can carry it).
 * An unscripted reference or attempt fails closed as provider_unavailable.
 */
import type { ModelDescriptor, ModelProvider, ProviderCall, ProviderRequest, ProviderResponse } from "@/ai/gateway";

export const SIMULATOR_PROVIDER_KEY = "simulator";
export const SIMULATOR_SCRIPT_VERSION = "simulator-script.v1";

export type SimulatedResponse =
  | { readonly kind: "output"; readonly body: unknown; readonly modelVersion?: string; readonly reasoning?: string }
  | { readonly kind: "raw"; readonly text: string }
  | { readonly kind: "refusal" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "timeout" }
  | { readonly kind: "rate_limited"; readonly retryAfterSeconds: number | null }
  | { readonly kind: "input_too_large" };

/** Reference → the response of attempt 1, attempt 2. */
export type SimulatorScript = ReadonlyMap<string, readonly SimulatedResponse[]>;

export function simulatorModel(modelKey: string, overrides: Partial<Pick<ModelDescriptor, "maxInputChars" | "maxOutputChars" | "enabled" | "structuredOutput">> = {}): ModelDescriptor {
  return Object.freeze({
    providerKey: SIMULATOR_PROVIDER_KEY,
    modelKey,
    modelVersion: "simulator-1",
    enabled: overrides.enabled ?? true,
    structuredOutput: overrides.structuredOutput ?? "native_json_schema",
    tools: "none" as const,
    maxInputChars: overrides.maxInputChars ?? 80_000,
    maxOutputChars: overrides.maxOutputChars ?? 8_000,
    cost: Object.freeze({ status: "OPEN" as const }),
  });
}

const KINDS = ["output", "raw", "refusal", "unavailable", "timeout", "rate_limited", "input_too_large"] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Strictly parses a committed script fixture `{ scriptVersion, synthetic: true, references: { ref: [response…] } }`. */
export function parseSimulatorScript(value: unknown): SimulatorScript {
  if (!isRecord(value) || value["scriptVersion"] !== SIMULATOR_SCRIPT_VERSION || value["synthetic"] !== true || !isRecord(value["references"])) throw new TypeError("simulator_script_invalid");
  const out = new Map<string, readonly SimulatedResponse[]>();
  for (const [reference, responses] of Object.entries(value["references"])) {
    if (!Array.isArray(responses) || responses.length < 1 || responses.length > 2) throw new TypeError(`simulator_script_invalid:${reference}`);
    out.set(reference, Object.freeze(responses.map((entry: unknown) => {
      if (!isRecord(entry) || !(KINDS as readonly unknown[]).includes(entry["kind"])) throw new TypeError(`simulator_script_invalid:${reference}`);
      if (entry["kind"] === "raw" && typeof entry["text"] !== "string") throw new TypeError(`simulator_script_invalid:${reference}`);
      return Object.freeze({ ...entry }) as SimulatedResponse;
    })));
  }
  return out;
}

export interface SimulatorProvider extends ModelProvider {
  /** Every call received (reference + attempt only), for tests. */
  readonly calls: readonly ProviderCall[];
}

export function createSimulatorProvider(script: SimulatorScript): SimulatorProvider {
  const calls: ProviderCall[] = [];
  const respond = (call: ProviderCall): ProviderResponse => {
    const scripted = script.get(call.reference)?.[call.attempt - 1];
    if (scripted === undefined) return { kind: "failed", cause: "provider_unavailable", retryAfterSeconds: null };
    switch (scripted.kind) {
      case "output":
        // Only the output text crosses the port; any scripted `reasoning` is dropped here.
        return { kind: "completed", text: JSON.stringify(scripted.body), modelVersion: scripted.modelVersion ?? "simulator-1", usage: null };
      case "raw":
        return { kind: "completed", text: scripted.text, modelVersion: "simulator-1", usage: null };
      case "refusal":
        return { kind: "refused" };
      case "unavailable":
        return { kind: "failed", cause: "provider_unavailable", retryAfterSeconds: null };
      case "timeout":
        return { kind: "failed", cause: "timeout", retryAfterSeconds: null };
      case "rate_limited":
        return { kind: "failed", cause: "rate_limited", retryAfterSeconds: scripted.retryAfterSeconds };
      case "input_too_large":
        return { kind: "failed", cause: "provider_input_limit", retryAfterSeconds: null };
    }
  };
  return {
    providerKey: SIMULATOR_PROVIDER_KEY,
    calls,
    complete(_request: ProviderRequest, call: ProviderCall): Promise<ProviderResponse> {
      calls.push(Object.freeze({ ...call }));
      return Promise.resolve(respond(call));
    },
  };
}
