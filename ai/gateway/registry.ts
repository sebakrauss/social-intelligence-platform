/**
 * The model registry and the task routes (Step H7-C; TA §21.3, §22.1). Data only: no credential, no environment
 * read, no network. A route is chosen per TASK from server-side configuration — never from anything in the input
 * (H7-A0 §14). Provider and model keys are opaque strings here; nothing outside a provider adapter branches on a
 * vendor. Prices are a placeholder (`cost.status = "OPEN"`): TA-Q-23 (unit-cost model) is open.
 */

export const STRUCTURED_OUTPUT_SUPPORT = ["native_json_schema", "json_mode", "prompted_json", "none"] as const;
export type StructuredOutputSupport = (typeof STRUCTURED_OUTPUT_SUPPORT)[number];

export interface ModelCost {
  /** TA-Q-23 OPEN: no price table is frozen. A descriptor carries `{ status: "OPEN" }` until one is approved. */
  readonly status: "OPEN";
}

export interface ModelDescriptor {
  readonly providerKey: string;
  readonly modelKey: string;
  /** The configured model version (the provider-REPORTED version is recorded per attempt). */
  readonly modelVersion: string | null;
  readonly enabled: boolean;
  readonly structuredOutput: StructuredOutputSupport;
  /** H7 tasks never use tools (H7-A0 §14). */
  readonly tools: "none";
  /** Input bound of one request (system + data), in characters (a token budget is a later policy). */
  readonly maxInputChars: number;
  readonly maxOutputChars: number;
  readonly cost: ModelCost;
}

export interface ModelRef {
  readonly providerKey: string;
  readonly modelKey: string;
}

/** Task id → model, or explicitly disabled (deterministic-only is a routing outcome, not a fake provider). */
export type TaskRoute = { readonly kind: "model"; readonly model: ModelRef } | { readonly kind: "disabled" };
export type RouteTable = Readonly<Record<string, TaskRoute>>;

export interface ModelRegistry {
  readonly models: readonly ModelDescriptor[];
  get(ref: ModelRef): ModelDescriptor | undefined;
}

const KEY = /^[a-z][a-z0-9._-]{0,63}$/;

export function createModelRegistry(models: readonly ModelDescriptor[]): ModelRegistry {
  const byKey = new Map<string, ModelDescriptor>();
  for (const model of models) {
    if (!KEY.test(model.providerKey) || !KEY.test(model.modelKey)) throw new TypeError("model_registry_key_invalid");
    if (!Number.isInteger(model.maxInputChars) || model.maxInputChars < 1 || !Number.isInteger(model.maxOutputChars) || model.maxOutputChars < 1) throw new TypeError("model_registry_bounds_invalid");
    // Defensive for configuration that bypassed the type: a tool-enabled model is never registered.
    if ((model as { readonly tools: unknown }).tools !== "none") throw new TypeError("model_registry_tools_forbidden");
    const key = `${model.providerKey}/${model.modelKey}`;
    if (byKey.has(key)) throw new TypeError("model_registry_duplicate");
    byKey.set(key, Object.freeze({ ...model, cost: Object.freeze({ ...model.cost }) }));
  }
  const frozen = Object.freeze([...byKey.values()]);
  return Object.freeze({ models: frozen, get: (ref: ModelRef) => byKey.get(`${ref.providerKey}/${ref.modelKey}`) });
}
