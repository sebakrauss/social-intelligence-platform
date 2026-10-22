/**
 * PLATFORM catalog entry contract (Step 7G-H5.5-P4-B; design/phase-7g/meta-provider/api-validation/README.md — the
 * authority for the evidence record). Development/test-time validation ONLY: no runtime code imports this module
 * (guard-tested), so the evaluator, the stored profiles and every deployed plane are unchanged. It states, fail closed,
 * what a FUTURE real-platform catalog entry must carry before it may exist; today the platform catalog holds none.
 *
 * The product question the capability system answers is "can Wrenkind perform X now for this connected account?"
 * (TL decision, P4-B). A positive entry (SUPPORTED, AVAILABLE_WITH_LIMITATION) therefore needs ALL of:
 *   - an accepted, POSITIVE `api-validation:` evidence record for its exact (provider, platform, asset class,
 *     capability, content kind, source) — provider support alone is never enough;
 *   - a non-empty set of explicitly named required permissions, identical to the record's (no implicit support from an
 *     empty permission set);
 *   - implementation evidence (Step 7G-H5.5-P5-B: exact operation SETS): the capability's explicitly declared
 *     CAPABILITY_REQUIRED_OPERATIONS set, and
 *       A. an OFFLINE_IMPLEMENTED_OPERATIONS registration covering exactly that set (adapter code, offline tests), and
 *       B. an IMPLEMENTED_PLATFORM_OPERATIONS (= LIVE-VALIDATED) registration of exactly that set, resting on the
 *          same accepted record, whose `operations` are exactly that set too.
 *     A capability with no declared set can't be positive. Nothing is inferred from names; account infrastructure
 *     (discoverAssets, describeAccount) is never evidence for any capability.
 * An UNSUPPORTED entry needs an accepted record of AUTHORITATIVE NEGATIVE evidence (provider documentation, or a real
 * provider operation's non-eligibility observation). A missing or unrequested permission, an unimplemented operation,
 * unavailable facts, a failed provider read or the catalog lacking a rule are NOT negative evidence: those stay UNKNOWN.
 * UNKNOWN_NOT_VALIDATED is the catalog default and is never written as an entry.
 *
 * AUTHORIZATION SEMANTICS — RESOLVED (Step 7G-H5.5-P4-C): a missing provider authorization is the PROFILE-ONLY state
 * NOT_AUTHORIZED (reasons ACCOUNT_PERMISSION_MISSING / OBSERVED_PERMISSION_MISSING; availability UNAVAILABLE /
 * ACCOUNT_PERMISSION_MISSING / REAUTHORIZE), never UNSUPPORTED, which stays reserved for authoritative provider/platform
 * non-support (TA §16.2, Model §6.2). A catalog entry can't carry NOT_AUTHORIZED (CatalogState; refused here too), so
 * the blanket P4-B blocker is lifted. Every other requirement stands: with no accepted record and no registered
 * implementation evidence, NO real platform entry is admissible yet.
 */
import type { PlatformKey } from "@/domain/platforms";
import type { CapabilityCatalog, CatalogEntry } from "./catalog";
import { ANY, CAPABILITY_ASSET_CLASSES, CAPABILITY_KEYS, CATALOG_STATES, type CapabilityAssetClass, type CapabilityKey, type ScopeKind, type ScopeSource } from "./vocabulary";

/** The P4-B blanket blocker, lifted by Step 7G-H5.5-P4-C (the authorization semantics are resolved). */
export const FIRST_VALIDATED_PLATFORM_ENTRY_BLOCKED_UNTIL_AUTHORIZATION_SEMANTICS_RESOLVED = false;
export type AuthorizationSemantics = "OPEN" | "RESOLVED";
/** RESOLVED by Step 7G-H5.5-P4-C (kept consistent with the blocker above by the tests). */
export const AUTHORIZATION_SEMANTICS = "RESOLVED" as AuthorizationSemantics;

/** The providers that serve each real platform (the connection provider, which selects the catalog). */
export const PLATFORM_PROVIDERS: Readonly<Record<PlatformKey, string>> = Object.freeze({ facebook: "meta", instagram: "meta", tiktok: "tiktok" });

/** Account infrastructure operations: they describe or find accounts and are never evidence for any capability. */
export const ACCOUNT_INFRASTRUCTURE_OPERATIONS: readonly string[] = Object.freeze(["discoverAssets", "describeAccount"]);

/**
 * read_content = BOTH provider-contract reads (TL decision, Step 7G-H5.5-P5-B): listing a Page's content and the
 * authoritative single-content read. A read_content verdict may never rest on only one of them.
 */
export const READ_CONTENT_REQUIRED_OPERATIONS: readonly string[] = Object.freeze(["getContent", "listContent"]);

/**
 * The EXACT provider-contract operation set (sorted) each capability's verdict rests on — declared, never inferred
 * from names. Only read_content is declared (P5-B); every other capability has no set, so no positive entry is
 * admissible for it (REQUIRED_OPERATIONS_UNDEFINED) until a gate declares one.
 */
export const CAPABILITY_REQUIRED_OPERATIONS: Readonly<Partial<Record<CapabilityKey, readonly string[]>>> = Object.freeze({ read_content: READ_CONTENT_REQUIRED_OPERATIONS });

/** One registration of a capability's operations on one platform (operations: provider contract names, sorted). */
export interface OperationSetRegistration {
  readonly provider: string;
  readonly platform: PlatformKey;
  readonly capability: CapabilityKey;
  /** Provider contract operation names (READ_OPERATIONS / MUTATION_OPERATIONS), checked by the architecture guard. */
  readonly operations: readonly string[];
}

/**
 * IMPLEMENTED OFFLINE: the adapter implements these operations and offline tests cover them; NOT validated against
 * the live provider, so never evidence by itself (requirement A only). The architecture guard proves each one is
 * actually implemented by the adapter. Step 7G-H5.5-P5-B: Facebook Page read_content (listContent + getContent).
 */
export const OFFLINE_IMPLEMENTED_OPERATIONS: readonly OperationSetRegistration[] = Object.freeze([
  Object.freeze({ provider: "meta", platform: "facebook", capability: "read_content", operations: READ_CONTENT_REQUIRED_OPERATIONS }),
]);

/**
 * LIVE-VALIDATED implementation evidence (requirement B): the operations that perform a capability on one platform,
 * registered explicitly by the gate that implemented AND validated them live, with the accepted positive record.
 * Empty (LIVE_VALIDATED_OPERATIONS = none): nothing has been validated live for any of the ten capabilities, so every
 * positive platform entry is refused (IMPLEMENTATION_EVIDENCE_MISSING).
 */
export interface ImplementedOperation extends OperationSetRegistration {
  /** The accepted positive record proving it. */
  readonly evidence: string;
}
export const IMPLEMENTED_PLATFORM_OPERATIONS: readonly ImplementedOperation[] = Object.freeze([]);

/**
 * `api-validation:{provider}.{platform}.{capability}.{YYYYMMDD}-{NN}` — dot-separated so every id is admitted by the
 * stored column `capability.profile_entries.evidence_ref` (0009: ^[a-z][a-z0-9_.:-]{0,127}$; guard-tested). The record
 * file lives at records/{provider}/{platform}/{capability}/{YYYYMMDD}-{NN}.json.
 */
export const API_VALIDATION_EVIDENCE_ID = /^api-validation:([a-z][a-z0-9]{1,31})\.(facebook|instagram|tiktok)\.([a-z_]{2,40})\.(\d{8})-(\d{2})$/;
const EVIDENCE_ID = API_VALIDATION_EVIDENCE_ID;
/** A provider permission/scope name, explicitly spelled (lower-case identifier, dots allowed); never the simulator's. */
const PERMISSION_NAME = /^(?!sim\.)[a-z][a-z0-9_.]{0,99}$/;
const SHORT_TEXT_MAX = 2000;

export const RECORD_STATUSES = ["draft", "accepted", "rejected"] as const;
export const RECORD_POLARITIES = ["positive", "authoritative_negative"] as const;
/** The only accepted bases for negative evidence. Absence of a permission, implementation or facts is not one of them. */
export const NEGATIVE_BASES = ["provider_documentation", "provider_non_eligibility_observation"] as const;

/** One API-validation evidence record (schema: design/phase-7g/meta-provider/api-validation/README.md). */
export interface ApiValidationRecord {
  readonly id: string;
  readonly provider: string;
  readonly platform: PlatformKey;
  readonly assetClass: CapabilityAssetClass;
  /** e.g. "facebook_page", "instagram_professional_account" — a kind, never an account. */
  readonly accountKind: string;
  readonly capability: CapabilityKey;
  readonly contentKind: ScopeKind;
  readonly source: ScopeSource;
  /** The provider contract operations exercised: sorted, distinct; for a positive record, the capability's exact set. */
  readonly operations: readonly string[];
  /** YYYY-MM-DD, equal to the id's date. */
  readonly validatedOn: string;
  /** The 40-hex commit the validated code ran from. */
  readonly sourceRevision: string;
  /** Sorted, distinct, explicitly named. */
  readonly requiredPermissions: readonly string[];
  readonly scenario: string;
  readonly observedResult: string;
  readonly polarity: (typeof RECORD_POLARITIES)[number];
  /** Required for authoritative negatives, null for positives. */
  readonly negativeBasis: (typeof NEGATIVE_BASES)[number] | null;
  /** A role (e.g. "TL"), never a person's name. */
  readonly reviewer: string;
  readonly status: (typeof RECORD_STATUSES)[number];
}

export type RecordViolation =
  | "ID_MALFORMED"
  | "ID_FIELD_MISMATCH"
  | "PROVIDER_PLATFORM_MISMATCH"
  | "UNKNOWN_CAPABILITY"
  | "UNKNOWN_ASSET_CLASS"
  | "DATE_MALFORMED"
  | "SOURCE_REVISION_MALFORMED"
  | "PERMISSIONS_NOT_NAMED"
  | "OPERATIONS_MALFORMED"
  | "POLARITY_BASIS_INCONSISTENT"
  | "TEXT_MISSING_OR_OVERSIZED"
  | "TEXT_SUSPECTED_IDENTIFIER"
  | "STATUS_UNKNOWN";

export type EntryViolation =
  | "AUTHORIZATION_SEMANTICS_OPEN"
  | "NOT_A_CATALOG_STATE"
  | "PLATFORM_NOT_NAMED"
  | "UNKNOWN_IS_THE_DEFAULT"
  | "NOT_VALIDATED"
  | "EVIDENCE_NOT_API_VALIDATION"
  | "EVIDENCE_RECORD_MISSING"
  | "EVIDENCE_RECORD_INVALID"
  | "EVIDENCE_RECORD_NOT_ACCEPTED"
  | "EVIDENCE_SCOPE_MISMATCH"
  | "EVIDENCE_POLARITY_MISMATCH"
  | "REQUIRED_PERMISSIONS_EMPTY"
  | "REQUIRED_PERMISSION_UNNAMED"
  | "EVIDENCE_PERMISSIONS_MISMATCH"
  | "REQUIRED_OPERATIONS_UNDEFINED"
  | "IMPLEMENTATION_INCOMPLETE"
  | "EVIDENCE_OPERATIONS_INCOMPLETE"
  | "IMPLEMENTATION_EVIDENCE_MISSING"
  | "IMPLEMENTATION_EVIDENCE_MISMATCH"
  | "INFRASTRUCTURE_OPERATION_IS_NOT_EVIDENCE"
  | "UNSUPPORTED_NAMES_PERMISSIONS"
  | "LIMITATION_INCONSISTENT"
  | "DUPLICATE_SCOPE";

export interface CatalogContractContext {
  readonly records: readonly ApiValidationRecord[];
  /** Requirement A: OFFLINE_IMPLEMENTED_OPERATIONS. */
  readonly offlineImplementations: readonly OperationSetRegistration[];
  /** Requirement B: IMPLEMENTED_PLATFORM_OPERATIONS (live-validated). */
  readonly implementedOperations: readonly ImplementedOperation[];
  readonly authorizationSemantics: AuthorizationSemantics;
}

const isNamedPermissionSet = (permissions: readonly string[]): boolean =>
  permissions.every((p) => PERMISSION_NAME.test(p)) && new Set(permissions).size === permissions.length;
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().every((p, i) => p === [...b].sort()[i]);
/** A provider contract operation name (camelCase identifier); membership in the contract is the guard's check. */
const OPERATION_NAME = /^[a-z][A-Za-z]{1,63}$/;
const isOperationSet = (operations: readonly string[]): boolean =>
  operations.length > 0 && operations.every((op) => OPERATION_NAME.test(op)) && operations.every((op, i, all) => i === 0 || (all[i - 1] ?? "") < op);
/** Free text must not carry provider/account ids (long digit runs) or links (which may embed them). */
const textOk = (value: string): boolean => value.trim().length > 0 && value.length <= SHORT_TEXT_MAX;
const textSuspicious = (value: string): boolean => /\d{8,}/.test(value) || /:\/\//.test(value);
const validDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

/** Every way an evidence record breaks the schema (empty = valid). Never inspects anything but the record. */
export function apiValidationRecordViolations(record: ApiValidationRecord): readonly RecordViolation[] {
  const out = new Set<RecordViolation>();
  const id = EVIDENCE_ID.exec(record.id);
  if (id === null) out.add("ID_MALFORMED");
  else if (id[1] !== record.provider || id[2] !== record.platform || id[3] !== record.capability || id[4] !== record.validatedOn.replaceAll("-", "")) out.add("ID_FIELD_MISMATCH");
  if ((PLATFORM_PROVIDERS as Record<string, string | undefined>)[record.platform] !== record.provider) out.add("PROVIDER_PLATFORM_MISMATCH");
  if (!(CAPABILITY_KEYS as readonly string[]).includes(record.capability)) out.add("UNKNOWN_CAPABILITY");
  if (!(CAPABILITY_ASSET_CLASSES as readonly string[]).includes(record.assetClass)) out.add("UNKNOWN_ASSET_CLASS");
  if (!validDate(record.validatedOn)) out.add("DATE_MALFORMED");
  if (!/^[0-9a-f]{40}$/.test(record.sourceRevision)) out.add("SOURCE_REVISION_MALFORMED");
  if (!isNamedPermissionSet(record.requiredPermissions) || record.requiredPermissions.some((p, i, all) => i > 0 && (all[i - 1] ?? "") > p)) out.add("PERMISSIONS_NOT_NAMED");
  if (!Array.isArray(record.operations) || !isOperationSet(record.operations)) out.add("OPERATIONS_MALFORMED");
  const negative = record.polarity === "authoritative_negative";
  if (!(RECORD_POLARITIES as readonly string[]).includes(record.polarity)) out.add("POLARITY_BASIS_INCONSISTENT");
  else if (negative ? record.negativeBasis === null || !(NEGATIVE_BASES as readonly string[]).includes(record.negativeBasis) : record.negativeBasis !== null) out.add("POLARITY_BASIS_INCONSISTENT");
  const texts = [record.accountKind, record.scenario, record.observedResult, record.reviewer];
  if (!texts.every(textOk)) out.add("TEXT_MISSING_OR_OVERSIZED");
  if (texts.some(textSuspicious)) out.add("TEXT_SUSPECTED_IDENTIFIER");
  if (!(RECORD_STATUSES as readonly string[]).includes(record.status)) out.add("STATUS_UNKNOWN");
  return [...out];
}

/** Every way one PLATFORM entry breaks the contract (empty = admissible). All checks run; nothing short-circuits. */
export function platformEntryViolations(entry: CatalogEntry, context: CatalogContractContext): readonly EntryViolation[] {
  const out = new Set<EntryViolation>();
  if (context.authorizationSemantics !== "RESOLVED") out.add("AUTHORIZATION_SEMANTICS_OPEN");
  // NOT_AUTHORIZED (or any profile-only value) is refused even if a cast smuggled it past the CatalogState type.
  if (!(CATALOG_STATES as readonly string[]).includes(entry.state)) out.add("NOT_A_CATALOG_STATE");
  if (entry.platform === ANY) out.add("PLATFORM_NOT_NAMED");
  if (entry.state === "UNKNOWN_NOT_VALIDATED") out.add("UNKNOWN_IS_THE_DEFAULT");
  if (entry.validation !== "validated") out.add("NOT_VALIDATED");

  const positive = entry.state === "SUPPORTED" || entry.state === "AVAILABLE_WITH_LIMITATION";
  const record = entry.evidence !== null && EVIDENCE_ID.test(entry.evidence) ? context.records.find((r) => r.id === entry.evidence) : undefined;
  if (entry.evidence === null || !EVIDENCE_ID.test(entry.evidence)) out.add("EVIDENCE_NOT_API_VALIDATION");
  else if (record === undefined) out.add("EVIDENCE_RECORD_MISSING");
  else {
    if (apiValidationRecordViolations(record).length > 0) out.add("EVIDENCE_RECORD_INVALID");
    if (record.status !== "accepted") out.add("EVIDENCE_RECORD_NOT_ACCEPTED");
    const provider = entry.platform === ANY ? undefined : PLATFORM_PROVIDERS[entry.platform];
    if (record.provider !== provider || record.platform !== entry.platform || record.assetClass !== entry.assetClass || record.capability !== entry.capability
      || record.contentKind !== entry.contentKind || record.source !== entry.source) out.add("EVIDENCE_SCOPE_MISMATCH");
    if (record.polarity !== (positive ? "positive" : "authoritative_negative")) out.add("EVIDENCE_POLARITY_MISMATCH");
  }

  if (positive) {
    if (entry.requiredPermissions.length === 0) out.add("REQUIRED_PERMISSIONS_EMPTY");
    if (!isNamedPermissionSet(entry.requiredPermissions)) out.add("REQUIRED_PERMISSION_UNNAMED");
    if (record !== undefined && !sameSet(record.requiredPermissions, entry.requiredPermissions)) out.add("EVIDENCE_PERMISSIONS_MISMATCH");
    const required = CAPABILITY_REQUIRED_OPERATIONS[entry.capability];
    if (required === undefined) out.add("REQUIRED_OPERATIONS_UNDEFINED");
    const sameScope = (op: OperationSetRegistration): boolean => entry.platform !== ANY && op.platform === entry.platform && op.capability === entry.capability && op.provider === PLATFORM_PROVIDERS[entry.platform];
    const exactlyRequired = (operations: readonly string[]): boolean => required !== undefined && sameSet(operations, required);
    // A: implemented — an offline registration of exactly the required set.
    const offline = context.offlineImplementations.filter(sameScope);
    if (!offline.some((op) => exactlyRequired(op.operations))) out.add("IMPLEMENTATION_INCOMPLETE");
    // B: validated live — the accepted record exercised exactly the required set, and a live registration of exactly
    // that set rests on that same record.
    if (record !== undefined && !exactlyRequired(record.operations)) out.add("EVIDENCE_OPERATIONS_INCOMPLETE");
    const implemented = context.implementedOperations.filter(sameScope);
    if (implemented.length === 0) out.add("IMPLEMENTATION_EVIDENCE_MISSING");
    else if (!implemented.some((op) => op.evidence === entry.evidence && record !== undefined && exactlyRequired(op.operations) && sameSet(op.operations, record.operations))) out.add("IMPLEMENTATION_EVIDENCE_MISMATCH");
    const named = [...(required ?? []), ...offline.flatMap((op) => op.operations), ...implemented.flatMap((op) => op.operations), ...(record?.operations ?? [])];
    if (named.some((op) => ACCOUNT_INFRASTRUCTURE_OPERATIONS.includes(op))) out.add("INFRASTRUCTURE_OPERATION_IS_NOT_EVIDENCE");
    if ((entry.state === "AVAILABLE_WITH_LIMITATION") !== (entry.limitation !== null)) out.add("LIMITATION_INCONSISTENT");
  } else if (entry.state === "UNSUPPORTED") {
    // Never "unsupported because a permission is absent": an authoritative negative names no permission.
    if (entry.requiredPermissions.length > 0) out.add("UNSUPPORTED_NAMES_PERMISSIONS");
    if (entry.limitation !== null) out.add("LIMITATION_INCONSISTENT");
  }
  return [...out];
}

/** Violations of a whole platform catalog, by entry index (empty = admissible). */
export function platformCatalogViolations(catalog: CapabilityCatalog, context: CatalogContractContext): readonly { readonly index: number; readonly violations: readonly EntryViolation[] }[] {
  const seen = new Set<string>();
  const out: { index: number; violations: readonly EntryViolation[] }[] = [];
  catalog.entries.forEach((entry, index) => {
    const violations = new Set(platformEntryViolations(entry, context));
    const scope = [entry.platform, entry.assetClass, entry.capability, entry.contentKind, entry.source].join("|");
    if (seen.has(scope)) violations.add("DUPLICATE_SCOPE");
    seen.add(scope);
    if (violations.size > 0) out.push({ index, violations: [...violations] });
  });
  return out;
}
