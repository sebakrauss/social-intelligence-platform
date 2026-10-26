/**
 * INTEGRATION-plane read_interactions VALIDATION diagnostic (Step 7G-H5.5-P12-B2; design/phase-7g/meta-provider/README.md ›
 * read_interactions; DEV/non-prod only). The controlled operator vehicle for the future LIVE validation of Meta
 * read_interactions: on ONE connected Facebook Page or Instagram professional account it finds one content target and
 * exercises listInteractions, then getInteraction of one observed interaction of each kind, through the SAME production
 * path as the product tasks —
 *
 *   read-only lookup (worker scope, the payload's ONE workspace) → composeReadInteractionsValidation (jobs/connections.ts:
 *   the read_content diagnostic's composition — this plane's opener, worker identity, one KMS attempt, the Meta read
 *   port) → Roles Anywhere → KMS Decrypt → listContent → listInteractions → getInteraction (per kind)
 *
 * — and reports only closed, redacted facts. It is NOT a product task: absent from the task registry (the outbox can
 * never route to it), no schedule, no hook, no product UI; it runs only when an operator triggers it by id, and every
 * guard below runs before anything AWS- or provider-capable is built. The guards are the read_content diagnostic's,
 * with this diagnostic's own acknowledgement and failure codes.
 *
 *   input      exactly { acknowledge, workspace_id, connected_account_id } — internal UUIDs only, never a provider id,
 *              content id, comment id, cursor or URL (the target content and interactions are DERIVED, never named)
 *   release    a deployed Trigger.dev PRODUCTION run with an external deployment id (pinned)
 *   plane      no other plane's capability in the environment (jobs/plane-environment.ts)
 *   tier       APP_DEPLOYMENT_ENV exactly "staging"
 *   runtime    Node.js 22
 *   provider   CAPABILITY_PROVIDER_MODE unset (never the synthetic staging stub)
 *   crypto     the KMS keyring (never the local one)
 *   target     an ACTIVE, content-bearing Facebook Page or Instagram professional account of an unremoved Meta
 *              connection with its active credential (the account's platform selects the read path; no fallback)
 *
 * Sequence (ONE credential opening, ONE KMS Decrypt; window [now − 30 days, now); first provider page of each list):
 *   1. listContent; with no item the run ends (INCONCLUSIVE_EMPTY_CONTENT) — never an arbitrary target;
 *   2. a BOUNDED candidate scan (Step 7G-H5.5-P12-C4): listInteractions of the first, then the next in-window content
 *      item of that ONE page, in provider order, for at most READ_INTERACTIONS_VALIDATION_CANDIDATE_LIMIT items — the
 *      FIRST candidate with at least one interaction is selected; a provider error ends the scan (fail closed); with
 *      no interaction on any inspected candidate the run ends (INCONCLUSIVE_EMPTY_INTERACTIONS);
 *   3. getInteraction of the selected candidate's FIRST listed comment, if any, and FIRST listed reply, if any (each
 *      re-read once).
 * Each re-read is correlated with the listed object on identity only — interaction ref, content ref, kind, author ref
 * and parent ref (never text, name, handle or visibility, which may legitimately change).
 *
 * Evidence (A2): `evidenceInteractionKinds` is the canonical set of kinds that were BOTH listed and re-read with full
 * correlation, and it is non-null only when it contains `comment` — Facebook ["comment"] (no reply observed:
 * INCONCLUSIVE_COMMENT_ONLY for reply support) or ["comment", "reply"]; Instagram ["comment"] only (its first slice
 * reads no replies). A reply without a comment is never evidence (INCONCLUSIVE_REPLY_WITHOUT_COMMENT). Nothing is
 * inferred from the offline implementation. Meta GETs per operation: Facebook 2 (the port derives a Page token
 * before each read), Instagram 1 (the User token directly) — at most Facebook 2·(1 + N + 2) = 12 and Instagram
 * 1 + N + 1 = 5 with N = 3 candidates (expectedMetaRequests = per-operation GETs × stages reached).
 *
 * Writes NOTHING: no capability profile, catalog, evidence, outbox, ingestion, audit or effect claim (the lookup is
 * read-only and its write dependencies refuse). Provider errors are reported as closed classes, never thrown provider
 * prose; the output carries no account/content/interaction/author id, ref, token, text, caption, name, handle, cursor,
 * URL, raw reference or raw response. Retry: ONE task attempt and ONE KMS attempt, so a logical run is exactly one
 * attempt; re-running is a new, deliberate operator run.
 */
import { CredentialUnreadableError, type ConnectedAccount, type Connection, type ProviderCredentialAccess } from "@/modules/connections";
import { isUuid, parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import {
  AUTHOR_ROLES,
  CREDENTIAL_INVALID_REASONS,
  INTERACTION_KINDS,
  INTERACTION_VISIBILITY,
  NOT_ELIGIBLE_REASONS,
  PERMANENT_REJECTION_CODES,
  PERMISSION_CAPABILITIES,
  TRANSIENT_REASONS,
  isProviderError,
  isoInstant,
  providerObjectRef,
  sameProviderObject,
  type AuthorRole,
  type ContentDto,
  type ContentKind,
  type ContentSource,
  type InteractionDto,
  type InteractionKind,
  type InteractionVisibility,
  type ProviderError,
  type ProviderErrorKind,
  type ProviderReadPort,
} from "@/integrations/providers/contract";
import { META_GRAPH_VERSION } from "@/integrations/providers/meta/endpoints";
import { isCredentialCryptoError, isRetryableCredentialCryptoError } from "@/platform/crypto/credentials/errors";
import { withWorkspaceJobScope } from "@/platform/db";
import { NonRetryableJobError, type JobRelease } from "@/platform/jobs";
import { selectCredentialCrypto } from "@/server/connections/environment";
import { PROVIDER_MODE_VARIABLES } from "@/server/connections/provider-mode";
// The read_content diagnostic's read-only lookup, reused as is: one account, its connection, its envelope; writes refuse.
import { readContentValidationLookup } from "@/server/persistence/connections";
import { composeReadInteractionsValidation } from "./connections";
import { planeEnvironmentProblems } from "./plane-environment";
import { workerDatabase } from "./runtime";

type Environment = Readonly<Record<string, string | undefined>>;

export const READ_INTERACTIONS_VALIDATION_TASK_ID = "integration.read_interactions_validation";
export const READ_INTERACTIONS_VALIDATION_ACKNOWLEDGEMENT = "INTEGRATION_READ_INTERACTIONS_VALIDATION_V1";
/** The only deployment tier and Trigger.dev environment type the diagnostic accepts. */
export const READ_INTERACTIONS_VALIDATION_TIER = "staging";
export const READ_INTERACTIONS_VALIDATION_TRIGGER_ENVIRONMENT = "PRODUCTION";
/** One window [now − 30 days, now) for both lists, and at most ONE provider page of each. */
export const READ_INTERACTIONS_VALIDATION_WINDOW_DAYS = 30;
export const READ_INTERACTIONS_VALIDATION_MAX_LIST_PAGES = 1;
/**
 * Content candidates the scan may inspect (Step 7G-H5.5-P12-C4): the first N in-window items of the ONE content page, in
 * provider order — the smallest N that covers the three in-window posts observed LIVE (P12-C2/C3), so a newer post
 * without interactions can no longer hide the prepared one. Never a cursor, never a second page.
 */
export const READ_INTERACTIONS_VALIDATION_CANDIDATE_LIMIT = 3;
/** The platforms the diagnostic reads (Meta content-bearing accounts) and the account kind each one is. */
export const READ_INTERACTIONS_VALIDATION_PLATFORMS = ["facebook", "instagram"] as const;
export type ReadInteractionsValidationPlatform = (typeof READ_INTERACTIONS_VALIDATION_PLATFORMS)[number];
export const READ_INTERACTIONS_VALIDATION_ACCOUNT_KINDS = Object.freeze({ facebook: "facebook_page", instagram: "instagram_professional_account" } as const);
/**
 * The interaction kinds a validation may prove, per platform: Facebook reads comments and replies (`filter=stream`);
 * Instagram's first slice reads top-level comments only (P12-B1), so it can never prove a reply.
 */
export const READ_INTERACTIONS_VALIDATION_PROVABLE_KINDS = Object.freeze({
  facebook: Object.freeze(["comment", "reply"] as const),
  instagram: Object.freeze(["comment"] as const),
} as const);
/** Meta GETs per provider operation: Facebook derives a Page token before each read; Instagram uses the User token directly. */
export const READ_INTERACTIONS_VALIDATION_META_REQUESTS_PER_OPERATION = Object.freeze({ facebook: 2, instagram: 1 } as const);
/** One attempt for the diagnostic's KMS client: no SDK retry, independent of the task retry. */
export const READ_INTERACTIONS_VALIDATION_AWS_ATTEMPTS = Object.freeze({ maxAttempts: 1 } as const);

const PAYLOAD_FIELDS = ["acknowledge", "workspace_id", "connected_account_id"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The ONE closed vocabulary of diagnostic refusals/failures (thrown, ending the run). No provider or AWS value ever becomes a code. */
export const READ_INTERACTIONS_VALIDATION_FAILURES = [
  "read_interactions_validation_input_refused",
  "read_interactions_validation_release_refused",
  "read_interactions_validation_plane_refused",
  "read_interactions_validation_tier_refused",
  "read_interactions_validation_runtime_refused",
  "read_interactions_validation_provider_mode_refused",
  "read_interactions_validation_keyring_refused",
  "read_interactions_validation_target_not_found",
  "read_interactions_validation_target_inactive",
  "read_interactions_validation_target_not_meta_content_account",
  "read_interactions_validation_credential_missing",
  "read_interactions_validation_credential_unreadable",
  "read_interactions_validation_keyring_access_denied",
  "read_interactions_validation_keyring_misconfigured",
  "read_interactions_validation_keyring_unavailable",
  "read_interactions_validation_failed",
] as const;
export type ReadInteractionsValidationFailure = (typeof READ_INTERACTIONS_VALIDATION_FAILURES)[number];

export class ReadInteractionsValidationError extends NonRetryableJobError {
  readonly failure: ReadInteractionsValidationFailure;
  constructor(failure: ReadInteractionsValidationFailure) {
    super(failure);
    this.failure = failure;
  }
}

const TARGET_REFUSALS: Readonly<Record<Exclude<ReadInteractionsValidationTarget["kind"], "found">, ReadInteractionsValidationFailure>> = Object.freeze({
  not_found: "read_interactions_validation_target_not_found",
  inactive: "read_interactions_validation_target_inactive",
  not_meta_content_account: "read_interactions_validation_target_not_meta_content_account",
  credential_missing: "read_interactions_validation_credential_missing",
});

const refuse = (failure: ReadInteractionsValidationFailure): never => {
  throw new ReadInteractionsValidationError(failure);
};

/** A provider failure as closed facts: its kind and, where it has one, its closed reason/capability code. */
export interface ReadInteractionsErrorClass {
  readonly kind: ProviderErrorKind;
  readonly detail: string | null;
}

export type ReadInteractionsStage = "list_content" | "list_interactions" | "get_comment" | "get_reply";

/**
 * The run's closed classification. Success never names more kinds than were proven: the proven kinds are
 * `evidenceInteractionKinds`; INCONCLUSIVE_COMMENT_ONLY is Facebook's comment-only run (comments proven, replies not).
 */
export const READ_INTERACTIONS_VALIDATION_RESULTS = [
  "READ_INTERACTIONS_LIST_AND_GET_SUCCEEDED",
  "INCONCLUSIVE_COMMENT_ONLY",
  "INCONCLUSIVE_REPLY_WITHOUT_COMMENT",
  "INCONCLUSIVE_EMPTY_CONTENT",
  "INCONCLUSIVE_EMPTY_INTERACTIONS",
  "PERMISSION_MISSING",
  "TARGET_NOT_ELIGIBLE",
  "MALFORMED_RESPONSE",
  "PROVIDER_FAILURE",
  "CORRELATION_FAILURE",
] as const;
export type ReadInteractionsValidationResult = (typeof READ_INTERACTIONS_VALIDATION_RESULTS)[number];

/** What the provider answers say about authorization — an observation, never a capability verdict. */
export type ReadInteractionsAuthorizationClass = "AUTHORIZED_READS_OBSERVED" | "PERMISSION_MISSING_OBSERVED" | "CREDENTIAL_INVALID_OBSERVED" | "NOT_DETERMINED";

/** One list → get pair, on identity only. Every correlation is null when nothing was read back. */
export interface ReadInteractionsPairOutcome {
  /** An interaction of this kind was listed. */
  readonly observed: boolean;
  readonly attempted: boolean;
  readonly succeeded: boolean | null;
  readonly refCorrelated: boolean | null;
  readonly contentCorrelated: boolean | null;
  readonly kindCorrelated: boolean | null;
  readonly authorCorrelated: boolean | null;
  readonly parentCorrelated: boolean | null;
  /** All five correlations held. */
  readonly correlated: boolean | null;
  readonly error: ReadInteractionsErrorClass | null;
}

/** The ONLY output: closed values, counts and booleans. No id, ref, token, text, name, handle, cursor, URL or raw body. */
export interface ReadInteractionsValidationOutcome {
  readonly platform: ReadInteractionsValidationPlatform;
  readonly accountKind: (typeof READ_INTERACTIONS_VALIDATION_ACCOUNT_KINDS)[ReadInteractionsValidationPlatform];
  readonly result: ReadInteractionsValidationResult;
  /** True exactly when evidenceInteractionKinds is non-null. */
  readonly positiveEvidenceEligible: boolean;
  /** Canonical kinds listed in the interaction page. */
  readonly interactionKindsObserved: readonly InteractionKind[];
  /** Canonical kinds both listed and re-read with full correlation. */
  readonly interactionKindsValidated: readonly InteractionKind[];
  /** The kinds a future record could state: interactionKindsValidated when it contains `comment` and every check held; else null. */
  readonly evidenceInteractionKinds: readonly InteractionKind[] | null;
  readonly authorization: ReadInteractionsAuthorizationClass;
  readonly graphVersion: typeof META_GRAPH_VERSION;
  readonly windowDays: typeof READ_INTERACTIONS_VALIDATION_WINDOW_DAYS;
  readonly maxListPages: typeof READ_INTERACTIONS_VALIDATION_MAX_LIST_PAGES;
  readonly candidateLimit: typeof READ_INTERACTIONS_VALIDATION_CANDIDATE_LIMIT;
  /** Content candidates whose interactions were listed (0 when no content was listed). */
  readonly candidatesInspected: number;
  /** 1-based position, in the content page, of the candidate whose interactions were found; null when none had any. */
  readonly selectedCandidatePosition: number | null;
  readonly stages: readonly ReadInteractionsStage[];
  /** The Meta GETs the implemented sequence made for the stages reached (READ_INTERACTIONS_VALIDATION_META_REQUESTS_PER_OPERATION × stages). */
  readonly expectedMetaRequests: number;
  readonly content: {
    readonly succeeded: boolean;
    readonly itemCount: number;
    /** Every listed item belongs to the managed account. */
    readonly allItemsFromManagedAccount: boolean | null;
    /** The reported candidate's normalized kind and reported source (the selected one, else the last inspected); null without content. */
    readonly selectedContentKind: ContentKind | null;
    readonly selectedSource: ContentSource | null;
    readonly error: ReadInteractionsErrorClass | null;
  };
  readonly interactions: {
    readonly attempted: boolean;
    readonly succeeded: boolean | null;
    readonly itemCount: number;
    /** Items the diagnostic re-checked inside [from, to). */
    readonly inWindowItemCount: number;
    readonly commentCount: number;
    readonly replyCount: number;
    readonly pagination: "more" | "end" | null;
    /** Every listed interaction is on the selected content. */
    readonly allOnSelectedContent: boolean | null;
    /** Every comment has no parent and every reply has one. */
    readonly parentShapeConsistent: boolean | null;
    readonly authorRoles: Readonly<Record<AuthorRole, number>>;
    readonly visibility: Readonly<Record<InteractionVisibility, number>>;
    readonly error: ReadInteractionsErrorClass | null;
  };
  readonly comment: ReadInteractionsPairOutcome;
  readonly reply: ReadInteractionsPairOutcome;
}

/** The run facts the guards need, from the Trigger.dev run context (never from the payload). */
export interface ReadInteractionsValidationRun {
  readonly environmentType: string | undefined;
  readonly release: JobRelease;
}

export interface ReadInteractionsValidationInput {
  readonly workspaceId: WorkspaceId;
  readonly connectedAccountId: string;
}

/** What the read-only lookup found for the payload's account (closed facts plus the envelope to open). */
export type ReadInteractionsValidationTarget =
  | { readonly kind: "not_found" | "inactive" | "not_meta_content_account" | "credential_missing" }
  | { readonly kind: "found"; readonly platform: ReadInteractionsValidationPlatform; readonly providerAssetId: string; readonly credentialId: string; readonly envelope: Uint8Array };

export interface ReadInteractionsValidationDependencies {
  readonly nodeVersion: string;
  readonly clock: () => Date;
  /** The read-only target lookup (one worker transaction bound to the input's workspace). */
  readonly lookup: (input: ReadInteractionsValidationInput) => Promise<ReadInteractionsValidationTarget>;
  /** Builds the credential access and the Meta read port; called only after every guard passed. */
  readonly compose: (environment: Environment) => { readonly access: ProviderCredentialAccess; readonly read: ProviderReadPort };
}

/**
 * Classifies what the lookup read (pure): an ACTIVE content-bearing Facebook Page or Instagram professional account of
 * a live Meta connection, with that connection's active credential. Any other platform, an ad account or another
 * provider is refused.
 */
export function classifyTarget(
  account: ConnectedAccount | undefined,
  connection: Connection | undefined,
  credential: { readonly connectionId: string; readonly envelope: Uint8Array } | undefined,
): ReadInteractionsValidationTarget {
  if (account === undefined || connection === undefined || connection.status === "REMOVED") return { kind: "not_found" };
  if (account.status !== "ACTIVE") return { kind: "inactive" };
  const platform = (READ_INTERACTIONS_VALIDATION_PLATFORMS as readonly string[]).includes(account.platform) ? (account.platform as ReadInteractionsValidationPlatform) : undefined;
  if (connection.provider !== "meta" || platform === undefined || account.assetClass !== "content_bearing") return { kind: "not_meta_content_account" };
  if (connection.activeCredentialId === null || credential?.connectionId !== connection.id) return { kind: "credential_missing" };
  return { kind: "found", platform, providerAssetId: account.providerAssetId, credentialId: connection.activeCredentialId, envelope: credential.envelope };
}

/** The production lookup: ONE worker transaction bound to the payload's workspace; reads only. */
export function productionLookup(input: ReadInteractionsValidationInput): Promise<ReadInteractionsValidationTarget> {
  return withWorkspaceJobScope(workerDatabase(), input.workspaceId, async (tx) => {
    const lookup = readContentValidationLookup(tx);
    const account = await lookup.account(input.connectedAccountId);
    const connection = account === undefined ? undefined : await lookup.connection(account.connectionId);
    const credentialId = connection?.activeCredentialId ?? null;
    const credential = credentialId === null ? undefined : await lookup.credential(credentialId);
    return classifyTarget(account, connection, credential);
  });
}

/** The production composition: the integration plane's opener and worker identity (one KMS attempt) and the Meta read port. */
export function productionCompose(environment: Environment): { readonly access: ProviderCredentialAccess; readonly read: ProviderReadPort } {
  return composeReadInteractionsValidation(environment, READ_INTERACTIONS_VALIDATION_AWS_ATTEMPTS);
}

const PRODUCTION: ReadInteractionsValidationDependencies = Object.freeze({ nodeVersion: process.version, clock: () => new Date(), lookup: productionLookup, compose: productionCompose });

/** The payload must be exactly the acknowledgement plus two UUIDs. */
export function parseReadInteractionsValidationInput(payload: unknown): ReadInteractionsValidationInput {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return refuse("read_interactions_validation_input_refused");
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== PAYLOAD_FIELDS.length || !PAYLOAD_FIELDS.every((field) => keys.includes(field))) return refuse("read_interactions_validation_input_refused");
  if (record["acknowledge"] !== READ_INTERACTIONS_VALIDATION_ACKNOWLEDGEMENT) return refuse("read_interactions_validation_input_refused");
  const workspaceId = parseWorkspaceId(record["workspace_id"]);
  const connectedAccountId = record["connected_account_id"];
  if (workspaceId === undefined || !isUuid(connectedAccountId)) return refuse("read_interactions_validation_input_refused");
  return Object.freeze({ workspaceId, connectedAccountId });
}

/** Every precondition, in order, before anything AWS- or provider-capable exists. */
export function assertReadInteractionsValidationPreconditions(payload: unknown, run: ReadInteractionsValidationRun, environment: Environment, nodeVersion: string): ReadInteractionsValidationInput {
  const input = parseReadInteractionsValidationInput(payload);
  if (run.environmentType !== READ_INTERACTIONS_VALIDATION_TRIGGER_ENVIRONMENT || run.release.kind !== "pinned") refuse("read_interactions_validation_release_refused");
  if (planeEnvironmentProblems("integration", run.release, environment).length > 0) refuse("read_interactions_validation_plane_refused");
  if (environment[PROVIDER_MODE_VARIABLES.tier] !== READ_INTERACTIONS_VALIDATION_TIER) refuse("read_interactions_validation_tier_refused");
  if (!nodeVersion.startsWith("v22.")) refuse("read_interactions_validation_runtime_refused");
  if ((environment[PROVIDER_MODE_VARIABLES.mode] ?? "") !== "") refuse("read_interactions_validation_provider_mode_refused");
  let kms: boolean;
  try {
    kms = selectCredentialCrypto(environment).kind === "kms";
  } catch {
    return refuse("read_interactions_validation_keyring_refused");
  }
  if (!kms) refuse("read_interactions_validation_keyring_refused");
  return input;
}

const CLOSED_DETAILS: readonly string[] = [...PERMISSION_CAPABILITIES, ...TRANSIENT_REASONS, ...NOT_ELIGIBLE_REASONS, ...CREDENTIAL_INVALID_REASONS, ...PERMANENT_REJECTION_CODES];

/** A provider error as closed facts only (kind + one closed detail code); a number such as retry-after is dropped. */
export function errorClassOf(error: ProviderError): ReadInteractionsErrorClass {
  const details = error.toJSON().details;
  const detail = Object.values(details).find((value): value is string => typeof value === "string" && CLOSED_DETAILS.includes(value)) ?? null;
  return Object.freeze({ kind: error.kind, detail });
}

/** A provider error as the run's closed failure classification. An unreadable or fail-closed answer is MALFORMED_RESPONSE. */
function failureResult(error: ReadInteractionsErrorClass): ReadInteractionsValidationResult {
  if (error.kind === "permission_missing") return "PERMISSION_MISSING";
  if (error.kind === "target_not_eligible") return "TARGET_NOT_ELIGIBLE";
  if (error.kind === "permanent_rejected" && error.detail === "unknown") return "MALFORMED_RESPONSE";
  return "PROVIDER_FAILURE";
}

function authorizationOf(errors: readonly (ReadInteractionsErrorClass | null)[], anySuccess: boolean): ReadInteractionsAuthorizationClass {
  if (errors.some((error) => error?.kind === "permission_missing")) return "PERMISSION_MISSING_OBSERVED";
  if (errors.some((error) => error?.kind === "credential_invalid")) return "CREDENTIAL_INVALID_OBSERVED";
  return anySuccess && errors.every((error) => error === null) ? "AUTHORIZED_READS_OBSERVED" : "NOT_DETERMINED";
}

const histogram = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
const canonical = (kinds: Iterable<InteractionKind>): readonly InteractionKind[] => {
  const set = new Set(kinds);
  return Object.freeze(INTERACTION_KINDS.filter((kind) => set.has(kind)));
};
const sameParent = (a: InteractionDto["parent"], b: InteractionDto["parent"]): boolean => (a === null || b === null ? a === b : sameProviderObject(a, b));

const NOT_OBSERVED: ReadInteractionsPairOutcome = Object.freeze({ observed: false, attempted: false, succeeded: null, refCorrelated: null, contentCorrelated: null, kindCorrelated: null, authorCorrelated: null, parentCorrelated: null, correlated: null, error: null });

/** A credential-access failure BEFORE the provider call, as one fixed code (never retried here). */
function accessFailure(error: unknown): ReadInteractionsValidationFailure {
  if (error instanceof ReadInteractionsValidationError) return error.failure;
  if (error instanceof CredentialUnreadableError) return "read_interactions_validation_credential_unreadable";
  if (error instanceof NonRetryableJobError) {
    if (error.failureClass === "credential_keyring_access_denied") return "read_interactions_validation_keyring_access_denied";
    if (error.failureClass === "credential_keyring_misconfigured") return "read_interactions_validation_keyring_misconfigured";
  }
  if (isCredentialCryptoError(error)) {
    if (isRetryableCredentialCryptoError(error)) return "read_interactions_validation_keyring_unavailable";
    return error.code === "KEYRING_ACCESS_DENIED" ? "read_interactions_validation_keyring_access_denied" : "read_interactions_validation_keyring_misconfigured";
  }
  return "read_interactions_validation_failed";
}

/**
 * The diagnostic: guards, the read-only lookup, then ONE credential opening in which listContent, listInteractions and
 * the per-kind getInteraction run. Throws ReadInteractionsValidationError (fixed code) on a refusal or a pre-provider
 * failure; provider answers — successes and normalized provider errors alike — are returned as the redacted outcome.
 */
export async function runReadInteractionsValidation(
  payload: unknown,
  run: ReadInteractionsValidationRun,
  environment: Environment,
  overrides: Partial<ReadInteractionsValidationDependencies> = {},
): Promise<ReadInteractionsValidationOutcome> {
  const deps: ReadInteractionsValidationDependencies = { ...PRODUCTION, ...overrides };
  const input = assertReadInteractionsValidationPreconditions(payload, run, environment, deps.nodeVersion);
  let target: ReadInteractionsValidationTarget;
  try {
    target = await deps.lookup(input);
  } catch {
    return refuse("read_interactions_validation_failed");
  }
  if (target.kind !== "found") return refuse(TARGET_REFUSALS[target.kind]);
  const found = target;

  const now = deps.clock();
  const window = { from: isoInstant(new Date(now.getTime() - READ_INTERACTIONS_VALIDATION_WINDOW_DAYS * DAY_MS)), to: isoInstant(now) };
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  const platform = found.platform;
  const perOperation = READ_INTERACTIONS_VALIDATION_META_REQUESTS_PER_OPERATION[platform];
  const provable: readonly InteractionKind[] = READ_INTERACTIONS_VALIDATION_PROVABLE_KINDS[platform];
  const managed = providerObjectRef(platform, "asset", found.providerAssetId);

  try {
    const { access, read } = deps.compose(environment);
    return await access.withCredential({ workspaceId: input.workspaceId, credentialId: found.credentialId, envelope: found.envelope }, async (credential) => {
      const providerAccess = { credential, account: managed };
      const stages: ReadInteractionsStage[] = ["list_content"];

      // 1. The content page: candidates are its in-window items in provider order, never a caller-named one.
      let contents: readonly ContentDto[] = [];
      let contentError: ReadInteractionsErrorClass | null = null;
      try {
        contents = (await read.listContent(providerAccess, window, null)).data.items;
      } catch (error) {
        if (!isProviderError(error)) throw error;
        contentError = errorClassOf(error);
      }
      /** The content facts, about the reported candidate (the selected one, else the last inspected, else the first listed). */
      const contentFacts = (reported: ContentDto | undefined): ReadInteractionsValidationOutcome["content"] =>
        Object.freeze({
          succeeded: contentError === null,
          itemCount: contents.length,
          allItemsFromManagedAccount: contentError === null ? contents.every((item) => sameProviderObject(item.account, managed)) : null,
          selectedContentKind: reported?.contentKind ?? null,
          selectedSource: reported?.reportedSource ?? null,
          error: contentError,
        });
      let candidatesInspected = 0;
      let selectedCandidatePosition: number | null = null;

      const outcome = (fields: {
        readonly result: ReadInteractionsValidationResult;
        readonly observed: readonly InteractionKind[];
        readonly validated: readonly InteractionKind[];
        readonly evidence: readonly InteractionKind[] | null;
        readonly errors: readonly (ReadInteractionsErrorClass | null)[];
        readonly anySuccess: boolean;
        readonly content: ReadInteractionsValidationOutcome["content"];
        readonly interactions: ReadInteractionsValidationOutcome["interactions"];
        readonly comment: ReadInteractionsPairOutcome;
        readonly reply: ReadInteractionsPairOutcome;
      }): ReadInteractionsValidationOutcome =>
        Object.freeze({
          platform,
          accountKind: READ_INTERACTIONS_VALIDATION_ACCOUNT_KINDS[platform],
          result: fields.result,
          positiveEvidenceEligible: fields.evidence !== null,
          interactionKindsObserved: fields.observed,
          interactionKindsValidated: fields.validated,
          evidenceInteractionKinds: fields.evidence,
          authorization: authorizationOf(fields.errors, fields.anySuccess),
          graphVersion: META_GRAPH_VERSION,
          windowDays: READ_INTERACTIONS_VALIDATION_WINDOW_DAYS,
          maxListPages: READ_INTERACTIONS_VALIDATION_MAX_LIST_PAGES,
          candidateLimit: READ_INTERACTIONS_VALIDATION_CANDIDATE_LIMIT,
          candidatesInspected,
          selectedCandidatePosition,
          stages: Object.freeze([...stages]),
          expectedMetaRequests: perOperation * stages.length,
          content: fields.content,
          interactions: fields.interactions,
          comment: fields.comment,
          reply: fields.reply,
        });

      const NOT_LISTED: ReadInteractionsValidationOutcome["interactions"] = Object.freeze({
        attempted: false, succeeded: null, itemCount: 0, inWindowItemCount: 0, commentCount: 0, replyCount: 0, pagination: null, allOnSelectedContent: null, parentShapeConsistent: null,
        authorRoles: Object.freeze(histogram(AUTHOR_ROLES)), visibility: Object.freeze(histogram(INTERACTION_VISIBILITY)), error: null,
      });
      const none = Object.freeze([] as InteractionKind[]);
      const [firstListed] = contents;
      if (contentError !== null || firstListed === undefined) {
        return outcome({
          result: contentError === null ? "INCONCLUSIVE_EMPTY_CONTENT" : failureResult(contentError),
          observed: none, validated: none, evidence: null, errors: [contentError], anySuccess: contentError === null,
          content: contentFacts(firstListed), interactions: NOT_LISTED, comment: NOT_OBSERVED, reply: NOT_OBSERVED,
        });
      }

      // 2. The bounded candidate scan: ONE provider page of interactions per candidate, at most CANDIDATE_LIMIT
      //    candidates; the first with an interaction is selected; a provider error ends the scan (fail closed).
      let selected: ContentDto = firstListed;
      let items: readonly InteractionDto[] = [];
      let pagination: "more" | "end" | null = null;
      let listError: ReadInteractionsErrorClass | null = null;
      for (const [index, candidate] of contents.slice(0, READ_INTERACTIONS_VALIDATION_CANDIDATE_LIMIT).entries()) {
        stages.push("list_interactions");
        candidatesInspected += 1;
        selected = candidate;
        try {
          const page = (await read.listInteractions(providerAccess, { kind: "content", content: candidate.ref }, window, null)).data;
          items = page.items;
          pagination = page.next.kind;
        } catch (error) {
          if (!isProviderError(error)) throw error;
          listError = errorClassOf(error);
          items = [];
          pagination = null;
          break;
        }
        if (items.length > 0) {
          selectedCandidatePosition = index + 1;
          break;
        }
      }
      const content = contentFacts(selected);
      const listed = listError === null;
      const roles = histogram(AUTHOR_ROLES);
      const visibility = histogram(INTERACTION_VISIBILITY);
      for (const item of items) {
        roles[item.author.role] += 1;
        visibility[item.visibility] += 1;
      }
      const interactions = Object.freeze({
        attempted: true,
        succeeded: listed,
        itemCount: items.length,
        inWindowItemCount: items.filter((item) => {
          const at = Date.parse(item.timestamps.createdAt ?? "");
          return at >= from && at < to;
        }).length,
        commentCount: items.filter((item) => item.interactionKind === "comment").length,
        replyCount: items.filter((item) => item.interactionKind === "reply").length,
        pagination,
        allOnSelectedContent: listed ? items.every((item) => sameProviderObject(item.content, selected.ref)) : null,
        parentShapeConsistent: listed ? items.every((item) => (item.interactionKind === "comment") === (item.parent === null)) : null,
        authorRoles: Object.freeze(roles),
        visibility: Object.freeze(visibility),
        error: listError,
      });
      const observed = canonical(items.map((item) => item.interactionKind));
      if (!listed || items.length === 0) {
        return outcome({
          result: listed ? "INCONCLUSIVE_EMPTY_INTERACTIONS" : failureResult(listError ?? { kind: "permanent_rejected", detail: "unknown" }),
          observed, validated: none, evidence: null, errors: [listError], anySuccess: listed,
          content, interactions, comment: NOT_OBSERVED, reply: NOT_OBSERVED,
        });
      }

      // 3. One re-read per observed kind: the FIRST listed interaction of that kind, compared on identity only.
      const reread = async (kind: InteractionKind, stage: ReadInteractionsStage): Promise<ReadInteractionsPairOutcome> => {
        const first = items.find((item) => item.interactionKind === kind);
        if (first === undefined) return NOT_OBSERVED;
        stages.push(stage);
        let got: InteractionDto | undefined;
        let error: ReadInteractionsErrorClass | null = null;
        try {
          got = (await read.getInteraction(providerAccess, first.ref)).data;
        } catch (caught) {
          if (!isProviderError(caught)) throw caught;
          error = errorClassOf(caught);
        }
        if (got === undefined) return Object.freeze({ ...NOT_OBSERVED, observed: true, attempted: true, succeeded: false, error });
        const refCorrelated = sameProviderObject(got.ref, first.ref);
        const contentCorrelated = sameProviderObject(got.content, first.content) && sameProviderObject(first.content, selected.ref);
        const kindCorrelated = got.interactionKind === first.interactionKind;
        const authorCorrelated = sameProviderObject(got.author.ref, first.author.ref);
        const parentCorrelated = sameParent(got.parent, first.parent) && (kind === "comment" ? first.parent === null : first.parent !== null);
        const correlated = refCorrelated && contentCorrelated && kindCorrelated && authorCorrelated && parentCorrelated;
        return Object.freeze({ observed: true, attempted: true, succeeded: true, refCorrelated, contentCorrelated, kindCorrelated, authorCorrelated, parentCorrelated, correlated, error: null });
      };
      // Only a kind this platform's slice can prove is re-read (Instagram never spends a GET on a reply); an unprovable
      // kind that was nevertheless listed is reported as observed and fails the structural check below.
      const comment = await reread("comment", "get_comment");
      const reply = provable.includes("reply") ? await reread("reply", "get_reply") : Object.freeze({ ...NOT_OBSERVED, observed: observed.includes("reply") });

      const validated = canonical([...(comment.correlated === true ? ["comment" as const] : []), ...(reply.correlated === true ? ["reply" as const] : [])]);
      const getError = comment.error ?? reply.error;
      // Every structural check of the run itself: the content and interaction pages belong to the target, each item's
      // parent matches its kind, and nothing was observed that this platform's slice cannot prove.
      const structural =
        content.allItemsFromManagedAccount === true && interactions.allOnSelectedContent === true && interactions.parentShapeConsistent === true
        && interactions.inWindowItemCount === interactions.itemCount && observed.every((kind) => provable.includes(kind));
      const correlationFailed = [comment, reply].some((pair) => pair.succeeded === true && pair.correlated !== true) || !structural;
      let result: ReadInteractionsValidationResult;
      if (getError !== null) result = failureResult(getError);
      else if (correlationFailed) result = "CORRELATION_FAILURE";
      else if (!observed.includes("comment")) result = "INCONCLUSIVE_REPLY_WITHOUT_COMMENT";
      else if (platform === "facebook" && !observed.includes("reply")) result = "INCONCLUSIVE_COMMENT_ONLY";
      else result = "READ_INTERACTIONS_LIST_AND_GET_SUCCEEDED";
      // Evidence only from what was proven on BOTH operations, always with a comment, never wider than the platform's slice.
      const allObservedValidated = observed.every((kind) => validated.includes(kind));
      const evidence = (result === "READ_INTERACTIONS_LIST_AND_GET_SUCCEEDED" || result === "INCONCLUSIVE_COMMENT_ONLY") && allObservedValidated && validated.includes("comment") ? validated : null;
      return outcome({
        result, observed, validated, evidence, errors: [listError, comment.error, reply.error], anySuccess: comment.succeeded === true || reply.succeeded === true,
        content, interactions, comment, reply,
      });
    });
  } catch (error) {
    return refuse(accessFailure(error));
  }
}
