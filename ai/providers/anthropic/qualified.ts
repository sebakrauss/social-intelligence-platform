/**
 * The QUALIFIED classification-understanding model configuration (Step H7-D1b; H7-D0 closed with the TL-confirmed
 * PROVISIONAL recommendation RECOMMEND_CLAUDE_SONNET_5_5 — NOT a production model selection).
 *
 *   configuration   EXACTLY the H7-D0 bake-off candidate `claude-sonnet-5-5`: Anthropic Messages, effort `low`, thinking
 *                   `between_tools`, no `speed` field, 2 000 output tokens, 30 s call timeout, transport schema
 *                   `anthropic-transport-schema.v2`, taxonomy.v1. The fingerprint below is the SHA-256 of
 *                   `QUALIFIED_UNDERSTANDING_FINGERPRINT_MATERIAL` (the bake-off's `candidateConfigFingerprint` input);
 *                   a test recomputes it and compares it with the evaluation candidate, so any drift fails CI
 *   timeout         30 s is part of the qualified configuration (it is fingerprinted, and every qualifying H7-D0 run —
 *                   pass 1 and the stability-only run — completed under it with zero transport failures)
 *   availability    the descriptor is DISABLED and no runtime composes this file yet: the route is disabled by default
 *                   (modules/classification `DEFAULT_UNDERSTAND_AI_ROUTE_POLICY`); enabling either is a later gate
 *   qualification   route-level provenance only (evaluator / promotion / stability-policy versions and the evidence
 *                   hashes); the runtime never runs the benchmark evaluator and stores none of this per assessment
 *
 * Registry configuration may name the vendor (the H7-C vendor-free guard exempts `ai/providers/<vendor>`); nothing here
 * reads the environment or holds a credential.
 */
import type { ModelDescriptor, ModelRef } from "@/ai/gateway";
import type { AnthropicModelSettings } from "./index";
import { ANTHROPIC_TRANSPORT_SCHEMA_VERSION } from "./schema-projection";

export const QUALIFIED_UNDERSTANDING_MODEL_KEY = "claude-sonnet-5-5" as const;
export const QUALIFIED_UNDERSTANDING_MAX_OUTPUT_TOKENS = 2_000;
export const QUALIFIED_UNDERSTANDING_CALL_TIMEOUT_MS = 30_000;

export const QUALIFIED_UNDERSTANDING_SETTINGS: AnthropicModelSettings = Object.freeze({
  model: "claude-sonnet-5-5",
  effort: "low",
  thinking: "between_tools",
  speed: "omitted",
  maxTokens: QUALIFIED_UNDERSTANDING_MAX_OUTPUT_TOKENS,
});

/** The exact fingerprint input of the qualified H7-D0 candidate (key order is part of the hash). */
export const QUALIFIED_UNDERSTANDING_FINGERPRINT_MATERIAL = Object.freeze({
  id: QUALIFIED_UNDERSTANDING_MODEL_KEY,
  providerKey: "anthropic",
  settings: QUALIFIED_UNDERSTANDING_SETTINGS,
  maxOutputTokens: QUALIFIED_UNDERSTANDING_MAX_OUTPUT_TOKENS,
  callTimeoutMs: QUALIFIED_UNDERSTANDING_CALL_TIMEOUT_MS,
  transportSchema: ANTHROPIC_TRANSPORT_SCHEMA_VERSION,
  taxonomyVersion: "taxonomy.v1",
});

export const QUALIFIED_UNDERSTANDING_FINGERPRINT = "76e0ca1f5478239fe0cb11df2994071f1a20825c12fc90c3c82e6d53f1d4b53b" as const;

export const QUALIFIED_UNDERSTANDING_MODEL_REF: ModelRef = Object.freeze({ providerKey: "anthropic", modelKey: QUALIFIED_UNDERSTANDING_MODEL_KEY });

/** The gateway descriptor: the H7-D0 evaluation bounds, DISABLED until a later gate enables it. */
export const QUALIFIED_UNDERSTANDING_DESCRIPTOR: ModelDescriptor = Object.freeze({
  providerKey: "anthropic",
  modelKey: QUALIFIED_UNDERSTANDING_MODEL_KEY,
  modelVersion: QUALIFIED_UNDERSTANDING_SETTINGS.model,
  enabled: false,
  structuredOutput: "native_json_schema",
  tools: "none",
  maxInputChars: 200_000,
  maxOutputChars: QUALIFIED_UNDERSTANDING_MAX_OUTPUT_TOKENS * 4,
  cost: Object.freeze({ status: "OPEN" }),
});

/** Route-qualification provenance (H7-D0 closure). Never copied onto assessments. */
export const QUALIFIED_UNDERSTANDING_QUALIFICATION = Object.freeze({
  recommendation: "RECOMMEND_CLAUDE_SONNET_5_5",
  productionModelSelected: false,
  configurationFingerprint: QUALIFIED_UNDERSTANDING_FINGERPRINT,
  promptVersion: "understanding-prompt.v2",
  promptHash: "c177c6f36c77337645d2cc9f45628f80bd2fbeddd8f5ac2a418ac97ae2c9b7bf",
  taskVersion: "understanding-task.v2",
  corpusVersion: "eval-corpus.v2",
  corpusSha256: "8dc159ffb74c70acd90a30b00fe35dc9f290ae5502acefb0f0f2c59cd527c989",
  evaluatorVersion: "classification-evaluator.v3",
  promotionVersion: "understanding-promotion.v3",
  stabilityPolicyVersion: "classification-stability-policy.v2",
  parentEvidenceSha256: "a27052b4e7c7b6e923194c527245fe63402d2d4782f843636b77b0737be9630d",
  stabilityEvidenceSha256: "e7448e99cd3af3186591bb541ae8c18d86a5c1d5977f330bf06273f71a7d8d90",
  replayArtifactSha256: "e2a58b157397f861534fe8e3d6b4ab0067455a75ceaa8c206ae20b7089b3c38a",
});
