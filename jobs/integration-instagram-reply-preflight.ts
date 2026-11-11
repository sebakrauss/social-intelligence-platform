/**
 * INTEGRATION-plane Instagram reply PREFLIGHT / OBSERVE diagnostic (Step 7B-14C1; 7B-14B design §6; DEV only). The
 * controlled, READ-ONLY operator vehicle that must run before the first controlled Instagram public reply (preflight:
 * permissions, account identity, Page link, the exact comment's eligibility, the media's owner, the replies baseline)
 * and after it (observe: the replies under that same comment), through the SAME credential path as the product tasks —
 *
 *   read-only lookup (worker scope, the payload's ONE workspace) → composeInstagramReplyPreflight (jobs/connections.ts:
 *   the read diagnostics' opener, worker identity, ONE KMS attempt, the Meta read-only preflight reader) → Roles Anywhere
 *   → KMS Decrypt → at most 10 (preflight) or 3 (observe) Graph GETs
 *
 * — and reports only closed, redacted facts. It is NOT a product task: absent from the task registry (the outbox can
 * never route to it), no schedule, no hook, no product UI, no endpoint; it runs only when an operator triggers it by id,
 * and every guard below runs before anything AWS- or provider-capable is built. The guards are the read diagnostics'
 * (release, plane, tier, runtime, provider mode, keyring), with this diagnostic's own acknowledgement and codes.
 *
 *   input      exactly { acknowledge, mode, workspace_id, connected_account_id, target_interaction_id } — internal
 *              UUIDs only; never a provider id, Graph path, URL, token or text (the Meta ids come from storage)
 *   mode       "preflight" | "observe"
 *   target     an ACTIVE content-bearing Instagram account of an ACTIVE Meta connection with its active credential, and
 *              an observed, top-level, canonical COMMENT of that account in that workspace — anything else is refused
 *              before the credential is opened
 *
 * Writes NOTHING: no intent, reply, outbox, capability profile, catalog, evidence record, audit or provider object; it
 * never reaches the write transport, a mutation port or the executor (tests/architecture + depcruise
 * instagram-reply-preflight-reads-only). A successful read says nothing about the token type a reply POST requires
 * (tokenTypeForReplyPost is always NOT_VERIFIED). Retry: ONE task attempt and ONE KMS attempt; re-running is a new,
 * deliberate operator run.
 */
import { CredentialUnreadableError, type ConnectedAccount, type Connection, type ProviderCredentialAccess } from "@/modules/connections";
import { isUuid, parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import { INTERACTION_VISIBILITY, parseProviderObjectId, type InteractionVisibility } from "@/integrations/providers/contract";
import type { InstagramReplyPreflight, InstagramReplyPreflightFacts, InstagramReplyPreflightMode, InstagramReplyPreflightTarget } from "@/integrations/providers/meta/instagram-reply-preflight";
import { isCredentialCryptoError, isRetryableCredentialCryptoError } from "@/platform/crypto/credentials/errors";
import { withWorkspaceJobScope } from "@/platform/db";
import { NonRetryableJobError, type JobRelease } from "@/platform/jobs";
import { selectCredentialCrypto } from "@/server/connections/environment";
import { PROVIDER_MODE_VARIABLES } from "@/server/connections/provider-mode";
import { instagramReplyPreflightLookup, type InteractionReplyTargetRow } from "@/server/persistence/instagram-reply-preflight";
import { composeInstagramReplyPreflight } from "./connections";
import { planeEnvironmentProblems } from "./plane-environment";
import { workerDatabase } from "./runtime";

type Environment = Readonly<Record<string, string | undefined>>;

export const INSTAGRAM_REPLY_PREFLIGHT_TASK_ID = "integration.instagram_reply_preflight";
export const INSTAGRAM_REPLY_PREFLIGHT_ACKNOWLEDGEMENT = "INTEGRATION_INSTAGRAM_REPLY_PREFLIGHT_V1";
/** The only deployment tier and Trigger.dev environment type the diagnostic accepts (the read diagnostics' DEV tier). */
export const INSTAGRAM_REPLY_PREFLIGHT_TIER = "staging";
export const INSTAGRAM_REPLY_PREFLIGHT_TRIGGER_ENVIRONMENT = "PRODUCTION";
export const INSTAGRAM_REPLY_PREFLIGHT_MODES = ["preflight", "observe"] as const satisfies readonly InstagramReplyPreflightMode[];
/** One attempt for the diagnostic's KMS client: no SDK retry, independent of the task retry. */
export const INSTAGRAM_REPLY_PREFLIGHT_AWS_ATTEMPTS = Object.freeze({ maxAttempts: 1 } as const);

const PAYLOAD_FIELDS = ["acknowledge", "mode", "workspace_id", "connected_account_id", "target_interaction_id"] as const;

/** The ONE closed vocabulary of diagnostic refusals/failures (thrown, ending the run). No provider or AWS value ever becomes a code. */
export const INSTAGRAM_REPLY_PREFLIGHT_FAILURES = [
  "instagram_reply_preflight_input_refused",
  "instagram_reply_preflight_release_refused",
  "instagram_reply_preflight_plane_refused",
  "instagram_reply_preflight_tier_refused",
  "instagram_reply_preflight_runtime_refused",
  "instagram_reply_preflight_provider_mode_refused",
  "instagram_reply_preflight_keyring_refused",
  "instagram_reply_preflight_account_not_found",
  "instagram_reply_preflight_account_inactive",
  "instagram_reply_preflight_account_not_meta_instagram",
  "instagram_reply_preflight_connection_inactive",
  "instagram_reply_preflight_credential_missing",
  "instagram_reply_preflight_target_not_found",
  "instagram_reply_preflight_target_account_mismatch",
  "instagram_reply_preflight_target_not_top_level_comment",
  "instagram_reply_preflight_target_not_observed",
  "instagram_reply_preflight_target_identity_invalid",
  "instagram_reply_preflight_credential_unreadable",
  "instagram_reply_preflight_keyring_access_denied",
  "instagram_reply_preflight_keyring_misconfigured",
  "instagram_reply_preflight_keyring_unavailable",
  "instagram_reply_preflight_failed",
] as const;
export type InstagramReplyPreflightFailure = (typeof INSTAGRAM_REPLY_PREFLIGHT_FAILURES)[number];

export class InstagramReplyPreflightError extends NonRetryableJobError {
  readonly failure: InstagramReplyPreflightFailure;
  constructor(failure: InstagramReplyPreflightFailure) {
    super(failure);
    this.failure = failure;
  }
}

const refuse = (failure: InstagramReplyPreflightFailure): never => {
  throw new InstagramReplyPreflightError(failure);
};

/** The run facts the guards need, from the Trigger.dev run context (never from the payload). */
export interface InstagramReplyPreflightRun {
  readonly environmentType: string | undefined;
  readonly release: JobRelease;
}

export interface InstagramReplyPreflightInput {
  readonly mode: InstagramReplyPreflightMode;
  readonly workspaceId: WorkspaceId;
  readonly connectedAccountId: string;
  readonly targetInteractionId: string;
}

/** What storage says about the target (closed values) — reported apart from what Meta answered. */
export interface InstagramReplyStoredTarget {
  readonly kind: "comment";
  readonly topLevel: true;
  readonly observed: true;
  readonly visibility: InteractionVisibility | "unknown";
  readonly removedAtSource: boolean;
  readonly ownAuthor: boolean;
}

/** What the read-only lookup found (closed facts plus the stored provider ids and the envelope to open). */
export type InstagramReplyPreflightLookupResult =
  | { readonly kind: "refused"; readonly failure: InstagramReplyPreflightFailure }
  | { readonly kind: "found"; readonly target: InstagramReplyPreflightTarget; readonly stored: InstagramReplyStoredTarget; readonly credentialId: string; readonly envelope: Uint8Array };

/** The ONLY output: closed values, counts, booleans and managed-account reply instants. No id, token, text or name. */
export interface InstagramReplyPreflightOutcome {
  readonly mode: InstagramReplyPreflightMode;
  readonly platform: "instagram";
  readonly accountKind: "instagram_professional_account";
  /** From canonical storage (last observation), never from Meta. */
  readonly stored: InstagramReplyStoredTarget;
  /** Observed directly in Meta during this run. */
  readonly observed: InstagramReplyPreflightFacts;
  readonly status: InstagramReplyPreflightFacts["status"];
}

export interface InstagramReplyPreflightDependencies {
  readonly nodeVersion: string;
  /** The read-only lookup (one worker transaction bound to the input's workspace). */
  readonly lookup: (input: InstagramReplyPreflightInput) => Promise<InstagramReplyPreflightLookupResult>;
  /** Builds the credential access and the Meta read-only preflight reader; called only after every guard passed. */
  readonly compose: (environment: Environment) => { readonly access: ProviderCredentialAccess; readonly preflight: InstagramReplyPreflight };
}

/**
 * Classifies what the lookup read (pure). The account: ACTIVE, Instagram, content-bearing, of an ACTIVE Meta connection
 * with that connection's active credential. The target: the canonical row of THAT account in THAT workspace, an
 * observed top-level comment whose stored provider ids are valid. Everything else is refused before any credential.
 */
export function classifyPreflightTarget(
  input: InstagramReplyPreflightInput,
  account: ConnectedAccount | undefined,
  connection: Connection | undefined,
  credential: { readonly connectionId: string; readonly envelope: Uint8Array } | undefined,
  interaction: InteractionReplyTargetRow | undefined,
): InstagramReplyPreflightLookupResult {
  const refused = (failure: InstagramReplyPreflightFailure): InstagramReplyPreflightLookupResult => ({ kind: "refused", failure });
  if (account === undefined || connection === undefined || connection.status === "REMOVED" || account.workspaceId !== input.workspaceId) return refused("instagram_reply_preflight_account_not_found");
  if (account.status !== "ACTIVE") return refused("instagram_reply_preflight_account_inactive");
  if (connection.provider !== "meta" || account.platform !== "instagram" || account.assetClass !== "content_bearing") return refused("instagram_reply_preflight_account_not_meta_instagram");
  if (connection.status !== "ACTIVE") return refused("instagram_reply_preflight_connection_inactive");
  if (connection.activeCredentialId === null || credential?.connectionId !== connection.id) return refused("instagram_reply_preflight_credential_missing");
  if (interaction === undefined || interaction.workspaceId !== input.workspaceId) return refused("instagram_reply_preflight_target_not_found");
  if (interaction.connectedAccountId !== account.id || interaction.platform !== "instagram" || interaction.providerAssetId !== account.providerAssetId) return refused("instagram_reply_preflight_target_account_mismatch");
  if (interaction.kind !== "comment" || interaction.parentProviderInteractionId !== null) return refused("instagram_reply_preflight_target_not_top_level_comment");
  if (!interaction.observed) return refused("instagram_reply_preflight_target_not_observed");
  const instagramAccountId = parseProviderObjectId(account.providerAssetId);
  const commentId = parseProviderObjectId(interaction.providerInteractionId);
  const mediaId = parseProviderObjectId(interaction.providerContentId);
  if (instagramAccountId === undefined || commentId === undefined || mediaId === undefined) return refused("instagram_reply_preflight_target_identity_invalid");
  const visibility = (INTERACTION_VISIBILITY as readonly string[]).includes(interaction.visibility ?? "") ? (interaction.visibility as InteractionVisibility) : "unknown";
  return {
    kind: "found",
    target: Object.freeze({ instagramAccountId, commentId, mediaId }),
    stored: Object.freeze({ kind: "comment", topLevel: true, observed: true, visibility, removedAtSource: interaction.availability === "removed_at_source", ownAuthor: interaction.authorRole === "account_identity" }),
    credentialId: connection.activeCredentialId,
    envelope: credential.envelope,
  };
}

/** The production lookup: ONE worker transaction bound to the payload's workspace; reads only. */
export function productionLookup(input: InstagramReplyPreflightInput): Promise<InstagramReplyPreflightLookupResult> {
  return withWorkspaceJobScope(workerDatabase(), input.workspaceId, async (tx) => {
    const lookup = instagramReplyPreflightLookup(tx, input.workspaceId);
    const account = await lookup.account(input.connectedAccountId);
    const connection = account === undefined ? undefined : await lookup.connection(account.connectionId);
    const credentialId = connection?.activeCredentialId ?? null;
    const credential = credentialId === null ? undefined : await lookup.credential(credentialId);
    const interaction = await lookup.interaction(input.targetInteractionId);
    return classifyPreflightTarget(input, account, connection, credential, interaction);
  });
}

/** The production composition: the integration plane's opener and worker identity (one KMS attempt) and the read-only reader. */
export function productionCompose(environment: Environment): { readonly access: ProviderCredentialAccess; readonly preflight: InstagramReplyPreflight } {
  return composeInstagramReplyPreflight(environment, INSTAGRAM_REPLY_PREFLIGHT_AWS_ATTEMPTS);
}

const PRODUCTION: InstagramReplyPreflightDependencies = Object.freeze({ nodeVersion: process.version, lookup: productionLookup, compose: productionCompose });

/** The payload must be exactly the acknowledgement, a mode and three UUIDs — nothing else is accepted. */
export function parseInstagramReplyPreflightInput(payload: unknown): InstagramReplyPreflightInput {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return refuse("instagram_reply_preflight_input_refused");
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== PAYLOAD_FIELDS.length || !PAYLOAD_FIELDS.every((field) => keys.includes(field))) return refuse("instagram_reply_preflight_input_refused");
  if (record["acknowledge"] !== INSTAGRAM_REPLY_PREFLIGHT_ACKNOWLEDGEMENT) return refuse("instagram_reply_preflight_input_refused");
  const mode = record["mode"];
  if (mode !== "preflight" && mode !== "observe") return refuse("instagram_reply_preflight_input_refused");
  const workspaceId = parseWorkspaceId(record["workspace_id"]);
  const connectedAccountId = record["connected_account_id"];
  const targetInteractionId = record["target_interaction_id"];
  if (workspaceId === undefined || !isUuid(connectedAccountId) || !isUuid(targetInteractionId)) return refuse("instagram_reply_preflight_input_refused");
  return Object.freeze({ mode, workspaceId, connectedAccountId, targetInteractionId });
}

/** Every precondition, in order, before anything AWS- or provider-capable exists. */
export function assertInstagramReplyPreflightPreconditions(payload: unknown, run: InstagramReplyPreflightRun, environment: Environment, nodeVersion: string): InstagramReplyPreflightInput {
  const input = parseInstagramReplyPreflightInput(payload);
  if (run.environmentType !== INSTAGRAM_REPLY_PREFLIGHT_TRIGGER_ENVIRONMENT || run.release.kind !== "pinned") refuse("instagram_reply_preflight_release_refused");
  if (planeEnvironmentProblems("integration", run.release, environment).length > 0) refuse("instagram_reply_preflight_plane_refused");
  if (environment[PROVIDER_MODE_VARIABLES.tier] !== INSTAGRAM_REPLY_PREFLIGHT_TIER) refuse("instagram_reply_preflight_tier_refused");
  if (!nodeVersion.startsWith("v22.")) refuse("instagram_reply_preflight_runtime_refused");
  if ((environment[PROVIDER_MODE_VARIABLES.mode] ?? "") !== "") refuse("instagram_reply_preflight_provider_mode_refused");
  let kms: boolean;
  try {
    kms = selectCredentialCrypto(environment).kind === "kms";
  } catch {
    return refuse("instagram_reply_preflight_keyring_refused");
  }
  if (!kms) refuse("instagram_reply_preflight_keyring_refused");
  return input;
}

/** A credential-access failure BEFORE the provider call, as one fixed code (never retried here). */
function accessFailure(error: unknown): InstagramReplyPreflightFailure {
  if (error instanceof InstagramReplyPreflightError) return error.failure;
  if (error instanceof CredentialUnreadableError) return "instagram_reply_preflight_credential_unreadable";
  if (error instanceof NonRetryableJobError) {
    if (error.failureClass === "credential_keyring_access_denied") return "instagram_reply_preflight_keyring_access_denied";
    if (error.failureClass === "credential_keyring_misconfigured") return "instagram_reply_preflight_keyring_misconfigured";
  }
  if (isCredentialCryptoError(error)) {
    if (isRetryableCredentialCryptoError(error)) return "instagram_reply_preflight_keyring_unavailable";
    return error.code === "KEYRING_ACCESS_DENIED" ? "instagram_reply_preflight_keyring_access_denied" : "instagram_reply_preflight_keyring_misconfigured";
  }
  return "instagram_reply_preflight_failed";
}

/**
 * The diagnostic: guards, the read-only lookup, then ONE credential opening in which the reader makes its bounded GETs.
 * Throws InstagramReplyPreflightError (fixed code) on a refusal or a pre-provider failure; provider answers — successes
 * and read failures alike — are returned as the redacted outcome.
 */
export async function runInstagramReplyPreflight(
  payload: unknown,
  run: InstagramReplyPreflightRun,
  environment: Environment,
  overrides: Partial<InstagramReplyPreflightDependencies> = {},
): Promise<InstagramReplyPreflightOutcome> {
  const deps: InstagramReplyPreflightDependencies = { ...PRODUCTION, ...overrides };
  const input = assertInstagramReplyPreflightPreconditions(payload, run, environment, deps.nodeVersion);
  let found: InstagramReplyPreflightLookupResult;
  try {
    found = await deps.lookup(input);
  } catch {
    return refuse("instagram_reply_preflight_failed");
  }
  if (found.kind === "refused") return refuse(found.failure);
  const { target, stored } = found;

  const progress = { opened: false };
  try {
    const { access, preflight } = deps.compose(environment);
    const observed = await access.withCredential({ workspaceId: input.workspaceId, credentialId: found.credentialId, envelope: found.envelope }, (credential) => {
      progress.opened = true;
      return preflight.inspect(credential, target, input.mode);
    });
    return Object.freeze({ mode: input.mode, platform: "instagram", accountKind: "instagram_professional_account", stored, observed, status: observed.status });
  } catch (error) {
    // The reader returns every provider answer as facts; anything thrown after opening is an internal failure.
    if (progress.opened) return refuse("instagram_reply_preflight_failed");
    return refuse(accessFailure(error));
  }
}
