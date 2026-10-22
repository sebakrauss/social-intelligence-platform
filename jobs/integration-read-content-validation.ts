/**
 * INTEGRATION-plane read_content VALIDATION diagnostic (Step 7G-H5.5-P5-B; design/phase-7g/meta-provider/README.md ›
 * read_content; DEV/non-prod only). The controlled operator vehicle for the LIVE validation of the offline Facebook
 * Page read_content implementation (a later gate, P5-C): it exercises listContent and then getContent of ONE
 * connected Facebook Page through the SAME production path as the product tasks —
 *
 *   read-only lookup (worker scope, the payload's ONE workspace) → composeReadContentValidation (jobs/connections.ts:
 *   createCredentialAccess(composeCredentialOpener(env, integrationWorkerAwsCredentials(env), one KMS attempt)) and the
 *   Meta read port) → Roles Anywhere → KMS Decrypt → listContent / getContent
 *
 * — and reports only closed, redacted facts. It is NOT a product task: absent from the task registry (the outbox can
 * never route to it), no schedule, no hook, no product UI; it runs only when an operator triggers it by id, and every
 * guard below runs before anything AWS- or provider-capable is built.
 *
 *   input      exactly { acknowledge, workspace_id, connected_account_id } — internal UUIDs only, never a provider id
 *   release    a deployed Trigger.dev PRODUCTION run with an external deployment id (pinned)
 *   plane      no other plane's capability in the environment (jobs/plane-environment.ts)
 *   tier       APP_DEPLOYMENT_ENV exactly "staging"
 *   runtime    Node.js 22
 *   provider   CAPABILITY_PROVIDER_MODE unset (never the synthetic staging stub)
 *   crypto     the KMS keyring (never the local one)
 *   target     an ACTIVE, content-bearing Facebook Page of an unremoved Meta connection with its active credential
 *
 * Sequence (ONE credential opening, ONE KMS Decrypt): listContent over [now − 30 days, now), first page only (the
 * port derives a Page Access Token, then reads ONE page of published_posts); then, only if that page returned at
 * least one in-window item, getContent of the FIRST listed ref (the port derives a Page Access Token again, then reads
 * the post) — never an arbitrary target. Meta GETs: 4 with an item, 2 without. A run without an item is never
 * positive evidence (`positiveEvidenceEligible` false).
 *
 * Output names the selected item's normalized kind (`get.selectedContentKind`, closed ContentKind) so a positive run proves
 * WHICH kind getContent was validated on (Step 7G-H5.5-P5-C0); `get.contentKindMatchesListed` then says whether the
 * authoritative re-read preserved it.
 *
 * Writes NOTHING: no capability profile, catalog, outbox, ingestion, audit or effect claim (the lookup is read-only and
 * its write dependencies refuse). Provider errors are reported as closed classes, never thrown provider prose; the
 * output carries no Page/post id, ref, token, caption, name, cursor, URL or raw response. Retry: ONE task attempt and
 * ONE KMS attempt, so a logical run is exactly one attempt; a transient failure is reported, and re-running is a new,
 * deliberate operator run.
 */
import { CredentialUnreadableError, type ConnectedAccount, type Connection, type ProviderCredentialAccess } from "@/modules/connections";
import { isUuid, parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import {
  CONTENT_KINDS,
  CREDENTIAL_INVALID_REASONS,
  NOT_ELIGIBLE_REASONS,
  PERMANENT_REJECTION_CODES,
  PERMISSION_CAPABILITIES,
  TRANSIENT_REASONS,
  isProviderError,
  isoInstant,
  providerObjectRef,
  sameProviderObject,
  type ContentDto,
  type ContentKind,
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
import { readContentValidationLookup } from "@/server/persistence/connections";
import { composeReadContentValidation } from "./connections";
import { planeEnvironmentProblems } from "./plane-environment";
import { workerDatabase } from "./runtime";

type Environment = Readonly<Record<string, string | undefined>>;

export const READ_CONTENT_VALIDATION_TASK_ID = "integration.read_content_validation";
export const READ_CONTENT_VALIDATION_ACKNOWLEDGEMENT = "INTEGRATION_READ_CONTENT_VALIDATION_V1";
/** The only deployment tier and Trigger.dev environment type the diagnostic accepts. */
export const READ_CONTENT_VALIDATION_TIER = "staging";
export const READ_CONTENT_VALIDATION_TRIGGER_ENVIRONMENT = "PRODUCTION";
/** The listing window [now − 30 days, now) and at most ONE list page (P5-C plan). */
export const READ_CONTENT_VALIDATION_WINDOW_DAYS = 30;
export const READ_CONTENT_VALIDATION_MAX_LIST_PAGES = 1;
/** Meta GETs per successful run: token derivation + one content read, for each of listContent and getContent. */
export const READ_CONTENT_VALIDATION_META_REQUESTS = Object.freeze({ withItem: 4, withoutItem: 2 } as const);
/** One attempt for the diagnostic's KMS client: no SDK retry, independent of the task retry. */
export const READ_CONTENT_VALIDATION_AWS_ATTEMPTS = Object.freeze({ maxAttempts: 1 } as const);

const PAYLOAD_FIELDS = ["acknowledge", "workspace_id", "connected_account_id"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The ONE closed vocabulary of diagnostic refusals/failures (thrown, ending the run). No provider or AWS value ever becomes a code. */
export const READ_CONTENT_VALIDATION_FAILURES = [
  "read_content_validation_input_refused",
  "read_content_validation_release_refused",
  "read_content_validation_plane_refused",
  "read_content_validation_tier_refused",
  "read_content_validation_runtime_refused",
  "read_content_validation_provider_mode_refused",
  "read_content_validation_keyring_refused",
  "read_content_validation_target_not_found",
  "read_content_validation_target_inactive",
  "read_content_validation_target_not_facebook_page",
  "read_content_validation_credential_missing",
  "read_content_validation_credential_unreadable",
  "read_content_validation_keyring_access_denied",
  "read_content_validation_keyring_misconfigured",
  "read_content_validation_keyring_unavailable",
  "read_content_validation_failed",
] as const;
export type ReadContentValidationFailure = (typeof READ_CONTENT_VALIDATION_FAILURES)[number];

export class ReadContentValidationError extends NonRetryableJobError {
  readonly failure: ReadContentValidationFailure;
  constructor(failure: ReadContentValidationFailure) {
    super(failure);
    this.failure = failure;
  }
}

const TARGET_REFUSALS: Readonly<Record<Exclude<ReadContentValidationTarget["kind"], "found">, ReadContentValidationFailure>> = Object.freeze({
  not_found: "read_content_validation_target_not_found",
  inactive: "read_content_validation_target_inactive",
  not_facebook_page: "read_content_validation_target_not_facebook_page",
  credential_missing: "read_content_validation_credential_missing",
});

const refuse = (failure: ReadContentValidationFailure): never => {
  throw new ReadContentValidationError(failure);
};

/** A provider failure as closed facts: its kind and, where it has one, its closed reason/capability code. */
export interface ReadContentErrorClass {
  readonly kind: ProviderErrorKind;
  readonly detail: string | null;
}

export type ReadContentStage = "list_content" | "get_content";

export type ReadContentValidationResult =
  | "READ_CONTENT_LIST_AND_GET_SUCCEEDED"
  | "READ_CONTENT_LIST_SUCCEEDED_NO_ITEMS"
  | "READ_CONTENT_LIST_FAILED"
  | "READ_CONTENT_GET_FAILED"
  | "READ_CONTENT_GET_NOT_CORRELATED";

/** What the provider answer says about authorization — an observation for P5-C, never a capability verdict. */
export type ReadContentAuthorizationClass = "AUTHORIZED_READS_OBSERVED" | "PERMISSION_MISSING_OBSERVED" | "CREDENTIAL_INVALID_OBSERVED" | "NOT_DETERMINED";

/** The ONLY output: closed values, counts and booleans. No id, ref, token, text, name, cursor, URL or raw body. */
export interface ReadContentValidationOutcome {
  readonly result: ReadContentValidationResult;
  /** True only for a list AND get success with full correlation; a zero-item run can never be positive evidence. */
  readonly positiveEvidenceEligible: boolean;
  readonly authorization: ReadContentAuthorizationClass;
  readonly graphVersion: typeof META_GRAPH_VERSION;
  readonly windowDays: typeof READ_CONTENT_VALIDATION_WINDOW_DAYS;
  readonly maxListPages: typeof READ_CONTENT_VALIDATION_MAX_LIST_PAGES;
  readonly stages: readonly ReadContentStage[];
  /** The Meta GETs the implemented sequence made for the stages reached (4 with an item, 2 without). */
  readonly expectedMetaRequests: number;
  readonly list: {
    readonly succeeded: boolean;
    readonly itemCount: number;
    /** Items the diagnostic re-checked inside [from, to) — equal to itemCount when the port's client-side filter held. */
    readonly inWindowItemCount: number;
    readonly contentKinds: Readonly<Record<ContentKind, number>>;
    readonly pagination: "more" | "end" | null;
    readonly allItemsFromManagedPage: boolean | null;
    readonly allSourcesUnknown: boolean | null;
    readonly error: ReadContentErrorClass | null;
  };
  readonly get: {
    readonly attempted: boolean;
    readonly succeeded: boolean | null;
    /**
     * The normalized kind of the EXACT listed item whose ref was passed to getContent (the first in-window item) — set
     * whenever getContent is attempted, null when it is not. Read from that same selected object, never from the
     * histogram or the getContent answer (Step 7G-H5.5-P5-C0).
     */
    readonly selectedContentKind: ContentKind | null;
    readonly refMatchesListed: boolean | null;
    readonly accountMatchesManagedPage: boolean | null;
    /** getContent's kind === selectedContentKind (the selected item's own kind); null when nothing was read back. */
    readonly contentKindMatchesListed: boolean | null;
    readonly error: ReadContentErrorClass | null;
  };
}

/** The run facts the guards need, from the Trigger.dev run context (never from the payload). */
export interface ReadContentValidationRun {
  readonly environmentType: string | undefined;
  readonly release: JobRelease;
}

export interface ReadContentValidationInput {
  readonly workspaceId: WorkspaceId;
  readonly connectedAccountId: string;
}

/** What the read-only lookup found for the payload's account (closed facts plus the envelope to open). */
export type ReadContentValidationTarget =
  | { readonly kind: "not_found" | "inactive" | "not_facebook_page" | "credential_missing" }
  | { readonly kind: "found"; readonly providerAssetId: string; readonly credentialId: string; readonly envelope: Uint8Array };

export interface ReadContentValidationDependencies {
  readonly nodeVersion: string;
  readonly clock: () => Date;
  /** The read-only target lookup (one worker transaction bound to the input's workspace). */
  readonly lookup: (input: ReadContentValidationInput) => Promise<ReadContentValidationTarget>;
  /** Builds the credential access and the Meta read port; called only after every guard passed. */
  readonly compose: (environment: Environment) => { readonly access: ProviderCredentialAccess; readonly read: ProviderReadPort };
}

/** Classifies what the lookup read (pure): the Page must be an ACTIVE content-bearing Facebook account of a live Meta connection. */
export function classifyTarget(
  account: ConnectedAccount | undefined,
  connection: Connection | undefined,
  credential: { readonly connectionId: string; readonly envelope: Uint8Array } | undefined,
): ReadContentValidationTarget {
  if (account === undefined || connection === undefined || connection.status === "REMOVED") return { kind: "not_found" };
  if (account.status !== "ACTIVE") return { kind: "inactive" };
  if (connection.provider !== "meta" || account.platform !== "facebook" || account.assetClass !== "content_bearing") return { kind: "not_facebook_page" };
  if (connection.activeCredentialId === null || credential?.connectionId !== connection.id) return { kind: "credential_missing" };
  return { kind: "found", providerAssetId: account.providerAssetId, credentialId: connection.activeCredentialId, envelope: credential.envelope };
}

/** The production lookup: ONE worker transaction bound to the payload's workspace; reads only. */
export function productionLookup(input: ReadContentValidationInput): Promise<ReadContentValidationTarget> {
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
  return composeReadContentValidation(environment, READ_CONTENT_VALIDATION_AWS_ATTEMPTS);
}

const PRODUCTION: ReadContentValidationDependencies = Object.freeze({ nodeVersion: process.version, clock: () => new Date(), lookup: productionLookup, compose: productionCompose });

/** The payload must be exactly the acknowledgement plus two UUIDs. */
export function parseReadContentValidationInput(payload: unknown): ReadContentValidationInput {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return refuse("read_content_validation_input_refused");
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== PAYLOAD_FIELDS.length || !PAYLOAD_FIELDS.every((field) => keys.includes(field))) return refuse("read_content_validation_input_refused");
  if (record["acknowledge"] !== READ_CONTENT_VALIDATION_ACKNOWLEDGEMENT) return refuse("read_content_validation_input_refused");
  const workspaceId = parseWorkspaceId(record["workspace_id"]);
  const connectedAccountId = record["connected_account_id"];
  if (workspaceId === undefined || !isUuid(connectedAccountId)) return refuse("read_content_validation_input_refused");
  return Object.freeze({ workspaceId, connectedAccountId });
}

/** Every precondition, in order, before anything AWS- or provider-capable exists. */
export function assertReadContentValidationPreconditions(payload: unknown, run: ReadContentValidationRun, environment: Environment, nodeVersion: string): ReadContentValidationInput {
  const input = parseReadContentValidationInput(payload);
  if (run.environmentType !== READ_CONTENT_VALIDATION_TRIGGER_ENVIRONMENT || run.release.kind !== "pinned") refuse("read_content_validation_release_refused");
  if (planeEnvironmentProblems("integration", run.release, environment).length > 0) refuse("read_content_validation_plane_refused");
  if (environment[PROVIDER_MODE_VARIABLES.tier] !== READ_CONTENT_VALIDATION_TIER) refuse("read_content_validation_tier_refused");
  if (!nodeVersion.startsWith("v22.")) refuse("read_content_validation_runtime_refused");
  if ((environment[PROVIDER_MODE_VARIABLES.mode] ?? "") !== "") refuse("read_content_validation_provider_mode_refused");
  let kms: boolean;
  try {
    kms = selectCredentialCrypto(environment).kind === "kms";
  } catch {
    return refuse("read_content_validation_keyring_refused");
  }
  if (!kms) refuse("read_content_validation_keyring_refused");
  return input;
}

const CLOSED_DETAILS: readonly string[] = [...PERMISSION_CAPABILITIES, ...TRANSIENT_REASONS, ...NOT_ELIGIBLE_REASONS, ...CREDENTIAL_INVALID_REASONS, ...PERMANENT_REJECTION_CODES];

/** A provider error as closed facts only (kind + one closed detail code); a number such as retry-after is dropped. */
export function errorClassOf(error: ProviderError): ReadContentErrorClass {
  const details = error.toJSON().details;
  const detail = Object.values(details).find((value): value is string => typeof value === "string" && CLOSED_DETAILS.includes(value)) ?? null;
  return Object.freeze({ kind: error.kind, detail });
}

function authorizationOf(errors: readonly (ReadContentErrorClass | null)[], anySuccess: boolean): ReadContentAuthorizationClass {
  if (errors.some((error) => error?.kind === "permission_missing")) return "PERMISSION_MISSING_OBSERVED";
  if (errors.some((error) => error?.kind === "credential_invalid")) return "CREDENTIAL_INVALID_OBSERVED";
  return anySuccess && errors.every((error) => error === null) ? "AUTHORIZED_READS_OBSERVED" : "NOT_DETERMINED";
}

const emptyHistogram = (): Record<ContentKind, number> => Object.fromEntries(CONTENT_KINDS.map((kind) => [kind, 0])) as Record<ContentKind, number>;

/** A credential-access failure BEFORE the provider call, as one fixed code (never retried here). */
function accessFailure(error: unknown): ReadContentValidationFailure {
  if (error instanceof ReadContentValidationError) return error.failure;
  if (error instanceof CredentialUnreadableError) return "read_content_validation_credential_unreadable";
  if (error instanceof NonRetryableJobError) {
    if (error.failureClass === "credential_keyring_access_denied") return "read_content_validation_keyring_access_denied";
    if (error.failureClass === "credential_keyring_misconfigured") return "read_content_validation_keyring_misconfigured";
  }
  if (isCredentialCryptoError(error)) {
    if (isRetryableCredentialCryptoError(error)) return "read_content_validation_keyring_unavailable";
    return error.code === "KEYRING_ACCESS_DENIED" ? "read_content_validation_keyring_access_denied" : "read_content_validation_keyring_misconfigured";
  }
  return "read_content_validation_failed";
}

/**
 * The diagnostic: guards, the read-only lookup, then ONE credential opening in which listContent and (with an item)
 * getContent run. Throws ReadContentValidationError (fixed code) on a refusal or a pre-provider failure; provider
 * answers — successes and normalized provider errors alike — are returned as the redacted outcome.
 */
export async function runReadContentValidation(
  payload: unknown,
  run: ReadContentValidationRun,
  environment: Environment,
  overrides: Partial<ReadContentValidationDependencies> = {},
): Promise<ReadContentValidationOutcome> {
  const deps: ReadContentValidationDependencies = { ...PRODUCTION, ...overrides };
  const input = assertReadContentValidationPreconditions(payload, run, environment, deps.nodeVersion);
  let target: ReadContentValidationTarget;
  try {
    target = await deps.lookup(input);
  } catch {
    return refuse("read_content_validation_failed");
  }
  if (target.kind !== "found") return refuse(TARGET_REFUSALS[target.kind]);
  const found = target;

  const now = deps.clock();
  const window = { from: isoInstant(new Date(now.getTime() - READ_CONTENT_VALIDATION_WINDOW_DAYS * DAY_MS)), to: isoInstant(now) };
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  const managed = providerObjectRef("facebook", "asset", found.providerAssetId);

  try {
    const { access, read } = deps.compose(environment);
    return await access.withCredential({ workspaceId: input.workspaceId, credentialId: found.credentialId, envelope: found.envelope }, async (credential) => {
      const providerAccess = { credential, account: managed };
      const stages: ReadContentStage[] = ["list_content"];
      let items: readonly ContentDto[] = [];
      let pagination: "more" | "end" | null = null;
      let listError: ReadContentErrorClass | null = null;
      try {
        const page = (await read.listContent(providerAccess, window, null)).data;
        items = page.items;
        pagination = page.next.kind;
      } catch (error) {
        if (!isProviderError(error)) throw error;
        listError = errorClassOf(error);
      }
      const histogram = emptyHistogram();
      for (const item of items) histogram[item.contentKind] += 1;
      const listed = listError === null;
      const list = Object.freeze({
        succeeded: listed,
        itemCount: items.length,
        inWindowItemCount: items.filter((item) => {
          const at = Date.parse(item.publishedAt ?? "");
          return at >= from && at < to;
        }).length,
        contentKinds: Object.freeze(histogram),
        pagination,
        allItemsFromManagedPage: listed ? items.every((item) => sameProviderObject(item.account, managed)) : null,
        allSourcesUnknown: listed ? items.every((item) => item.reportedSource === "unknown") : null,
        error: listError,
      });

      const first = items[0];
      if (!listed || first === undefined) {
        return Object.freeze({
          result: listed ? "READ_CONTENT_LIST_SUCCEEDED_NO_ITEMS" : "READ_CONTENT_LIST_FAILED",
          positiveEvidenceEligible: false,
          authorization: authorizationOf([listError], false),
          graphVersion: META_GRAPH_VERSION,
          windowDays: READ_CONTENT_VALIDATION_WINDOW_DAYS,
          maxListPages: READ_CONTENT_VALIDATION_MAX_LIST_PAGES,
          stages: Object.freeze(stages),
          expectedMetaRequests: READ_CONTENT_VALIDATION_META_REQUESTS.withoutItem,
          list,
          get: Object.freeze({ attempted: false, succeeded: null, selectedContentKind: null, refMatchesListed: null, accountMatchesManagedPage: null, contentKindMatchesListed: null, error: null }),
        } satisfies ReadContentValidationOutcome);
      }

      // ONE selected object supplies both the ref read back and the kind reported for it.
      const selectedContentKind: ContentKind = first.contentKind;
      stages.push("get_content");
      let got: ContentDto | undefined;
      let getError: ReadContentErrorClass | null = null;
      try {
        got = (await read.getContent(providerAccess, first.ref)).data;
      } catch (error) {
        if (!isProviderError(error)) throw error;
        getError = errorClassOf(error);
      }
      const refMatchesListed = got === undefined ? null : sameProviderObject(got.ref, first.ref);
      const accountMatchesManagedPage = got === undefined ? null : sameProviderObject(got.account, managed);
      const contentKindMatchesListed = got === undefined ? null : got.contentKind === selectedContentKind;
      const correlated = refMatchesListed === true && accountMatchesManagedPage === true && list.allItemsFromManagedPage === true;
      const result: ReadContentValidationResult = got === undefined ? "READ_CONTENT_GET_FAILED" : correlated ? "READ_CONTENT_LIST_AND_GET_SUCCEEDED" : "READ_CONTENT_GET_NOT_CORRELATED";
      return Object.freeze({
        result,
        positiveEvidenceEligible: result === "READ_CONTENT_LIST_AND_GET_SUCCEEDED" && list.inWindowItemCount === list.itemCount,
        authorization: authorizationOf([listError, getError], got !== undefined),
        graphVersion: META_GRAPH_VERSION,
        windowDays: READ_CONTENT_VALIDATION_WINDOW_DAYS,
        maxListPages: READ_CONTENT_VALIDATION_MAX_LIST_PAGES,
        stages: Object.freeze(stages),
        expectedMetaRequests: READ_CONTENT_VALIDATION_META_REQUESTS.withItem,
        list,
        get: Object.freeze({ attempted: true, succeeded: got !== undefined, selectedContentKind, refMatchesListed, accountMatchesManagedPage, contentKindMatchesListed, error: getError }),
      } satisfies ReadContentValidationOutcome);
    });
  } catch (error) {
    return refuse(accessFailure(error));
  }
}
