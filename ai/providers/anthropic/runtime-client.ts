/**
 * The INTELLIGENCE plane's Anthropic SDK client (Step H7-D1g-prep). The qualified adapter (./index.ts) is a frozen H7-D0
 * artifact and stays byte-identical; this file only constructs the client the runtime hands to it — same `maxRetries: 0`,
 * plus explicit OpenTelemetry settings:
 *
 *   propagation   false: the SDK never injects the ambient trace context (`traceparent` / `tracestate` / `baggage`, or
 *                 any field of the registered propagator — the Trigger.dev run's) into a request to the model provider
 *   traces        metadata-only spans (never prompt or response content). An explicit option is complete, so the SDK's
 *                 ANTHROPIC_OPEN_TELEMETRY* environment variables can change neither (the plane refuses them anyway)
 *
 * Note `openTelemetry: false` would NOT do: it only disables spans, and propagation would stay on. The key is passed in by
 * the operator boundary (jobs/intelligence.ts); nothing here reads the environment or holds a credential.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicMessagesClient } from "./index";

export const ANTHROPIC_CLIENT_OPEN_TELEMETRY = Object.freeze({ propagation: false, traces: Object.freeze({ contentMode: "metadata_only" as const }) });

/** The runtime client: no SDK retries, no middleware, no trace propagation to the provider. */
export function createRuntimeAnthropicClient(apiKey: string): AnthropicMessagesClient {
  return new Anthropic({ apiKey, maxRetries: 0, openTelemetry: ANTHROPIC_CLIENT_OPEN_TELEMETRY });
}
