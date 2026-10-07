/**
 * Deterministic failure injection for the simulator (TA §52). Faults are explicit test configuration (a rule
 * list, or a named preset from the scenario), never randomness. A rule matches by operation (and optionally
 * by target id) and fires on the n-th matching call, or on every matching call.
 *
 * Ambiguity faults (mutations; `outcome_unknown` also on `exchangeCode`):
 *   - `outcome_unknown`: the platform APPLIES the change (for `exchangeCode`: redeems the code and issues a
 *     credential), then the response is lost → OutcomeUnknownError;
 *   - `timeout_before_send` (mutations only): the request never left → TransientError("timeout_before_send"),
 *     nothing applied.
 */
import {
  AUTHORIZATION_OPERATIONS,
  CREDENTIAL_INVALID_REASONS,
  MUTATION_OPERATIONS,
  NOT_ELIGIBLE_REASONS,
  PERMANENT_REJECTION_CODES,
  PERMISSION_CAPABILITIES,
  READ_OPERATIONS,
  TRANSIENT_REASONS,
  type CredentialInvalidReason,
  type NotEligibleReason,
  type PermanentRejectionCode,
  type PermissionCapability,
  type ProviderOperation,
  type TransientReason,
} from "../contract/errors";

export type FaultSpec =
  | { readonly kind: "rate_limited"; readonly retryAfterSeconds: number | null }
  | { readonly kind: "transient"; readonly reason: TransientReason }
  | { readonly kind: "permission_missing"; readonly capability: PermissionCapability }
  | { readonly kind: "credential_invalid"; readonly reason: CredentialInvalidReason }
  | { readonly kind: "target_not_found" }
  | { readonly kind: "target_not_eligible"; readonly reason: NotEligibleReason }
  | { readonly kind: "permanent_rejected"; readonly reasonCode: PermanentRejectionCode }
  | { readonly kind: "outcome_unknown" }
  | { readonly kind: "timeout_before_send" };

export interface FaultRule {
  readonly operation: ProviderOperation;
  /** Provider id of the call's target (or account); omitted = any target. */
  readonly target?: string;
  /** 1-based index of the matching call that fails, or "every". */
  readonly on: number | "every";
  readonly fault: FaultSpec;
}

const OPERATIONS: readonly string[] = [...READ_OPERATIONS, ...MUTATION_OPERATIONS, ...AUTHORIZATION_OPERATIONS];
const MUTATIONS: readonly string[] = MUTATION_OPERATIONS;

export class FaultConfigError extends Error {
  override readonly name = "FaultConfigError";
}

function isIn<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function parseSpec(value: unknown): FaultSpec | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const spec = value as Readonly<Record<string, unknown>>;
  switch (spec["kind"]) {
    case "rate_limited": {
      const after = spec["retryAfterSeconds"];
      if (after === null) return { kind: "rate_limited", retryAfterSeconds: null };
      return typeof after === "number" && Number.isInteger(after) && after >= 0 ? { kind: "rate_limited", retryAfterSeconds: after } : undefined;
    }
    case "transient":
      return isIn(TRANSIENT_REASONS, spec["reason"]) ? { kind: "transient", reason: spec["reason"] } : undefined;
    case "permission_missing":
      return isIn(PERMISSION_CAPABILITIES, spec["capability"]) ? { kind: "permission_missing", capability: spec["capability"] } : undefined;
    case "credential_invalid":
      return isIn(CREDENTIAL_INVALID_REASONS, spec["reason"]) ? { kind: "credential_invalid", reason: spec["reason"] } : undefined;
    case "target_not_found":
      return { kind: "target_not_found" };
    case "target_not_eligible":
      return isIn(NOT_ELIGIBLE_REASONS, spec["reason"]) ? { kind: "target_not_eligible", reason: spec["reason"] } : undefined;
    case "permanent_rejected":
      return isIn(PERMANENT_REJECTION_CODES, spec["reasonCode"]) ? { kind: "permanent_rejected", reasonCode: spec["reasonCode"] } : undefined;
    case "outcome_unknown":
      return { kind: "outcome_unknown" };
    case "timeout_before_send":
      return { kind: "timeout_before_send" };
    default:
      return undefined;
  }
}

/** Validates one rule (fixture or test input). Ambiguity faults on read operations are rejected. */
export function parseFaultRule(value: unknown): FaultRule | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const rule = value as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(rule)) if (!["operation", "target", "on", "fault"].includes(key)) return undefined;
  const operation = rule["operation"];
  const on = rule["on"];
  const target = rule["target"];
  const fault = parseSpec(rule["fault"]);
  if (!isIn(OPERATIONS as readonly ProviderOperation[], operation) || fault === undefined) return undefined;
  if (!(on === "every" || (typeof on === "number" && Number.isInteger(on) && on >= 1))) return undefined;
  if (target !== undefined && (typeof target !== "string" || target.length === 0)) return undefined;
  const ambiguityAllowed = MUTATIONS.includes(operation) || (fault.kind === "outcome_unknown" && operation === "exchangeCode");
  if ((fault.kind === "outcome_unknown" || fault.kind === "timeout_before_send") && !ambiguityAllowed) return undefined;
  return { operation, on, fault, ...(target === undefined ? {} : { target }) };
}

/** Holds the active rules and counts matching calls, so the n-th call fails deterministically. */
export class FaultInjector {
  readonly #rules: { readonly rule: FaultRule; matches: number }[] = [];

  add(rules: readonly FaultRule[]): void {
    for (const rule of rules) {
      if (parseFaultRule(rule) === undefined) throw new FaultConfigError("invalid fault rule");
      this.#rules.push({ rule, matches: 0 });
    }
  }

  clear(): void {
    this.#rules.length = 0;
  }

  /** The fault to apply to this call, if any. Every matching rule counts the call. */
  next(operation: ProviderOperation, targets: readonly string[]): FaultSpec | undefined {
    let selected: FaultSpec | undefined;
    for (const entry of this.#rules) {
      if (entry.rule.operation !== operation) continue;
      if (entry.rule.target !== undefined && !targets.includes(entry.rule.target)) continue;
      entry.matches += 1;
      if (selected === undefined && (entry.rule.on === "every" || entry.rule.on === entry.matches)) selected = entry.rule.fault;
    }
    return selected;
  }
}
