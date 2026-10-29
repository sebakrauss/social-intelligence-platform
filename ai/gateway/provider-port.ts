/**
 * The provider adapter port (Step H7-C; TA §22; H7-A0 §10). Gateway-internal: callers never see a request or a
 * response. A future adapter (`ai/providers/<vendor>`, the only place an SDK may be imported) maps it to the vendor's
 * API and back — and nothing else: it decides no routing, no retry, no validation.
 *
 *   request    system policy + schema (server-side text) and ONE delimited data block (untrusted social text);
 *              no tools, no function calls, no network instructions; JSON output only
 *   response   the raw output TEXT (validated by the gateway, never trusted), the reported model version and usage —
 *              or a refusal, or a typed transport failure
 *
 * There is no reasoning / thinking field anywhere: an adapter whose vendor returns one DISCARDS it (H7-A0 §4.5, §15).
 */
import type { ModelRef } from "./registry";

export interface ProviderRequest {
  readonly model: ModelRef;
  /** Server-side policy, schema and (on the re-ask) the closed validation issue codes. Never contains social text. */
  readonly system: string;
  /** The one delimited data section (social text is data, never instruction). */
  readonly data: string;
  readonly responseFormat: { readonly kind: "json"; readonly schemaVersion: string };
  readonly maxOutputChars: number;
}

export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type ProviderResponse =
  | { readonly kind: "completed"; readonly text: string; readonly modelVersion: string | null; readonly usage: ProviderUsage | null }
  | { readonly kind: "refused" }
  | { readonly kind: "failed"; readonly cause: "provider_unavailable" | "timeout" | "rate_limited" | "provider_input_limit"; readonly retryAfterSeconds: number | null };

/** Opaque call identity for tracing and for the simulator's script; an adapter never sends it to a vendor. */
export interface ProviderCall {
  readonly reference: string;
  readonly attempt: 1 | 2;
}

export interface ModelProvider {
  readonly providerKey: string;
  complete(request: ProviderRequest, call: ProviderCall): Promise<ProviderResponse>;
}
