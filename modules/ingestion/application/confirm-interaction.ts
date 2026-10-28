/**
 * Stored-interaction confirmation (Step H6-E): ONE authoritative direct provider re-read of ONE canonical interaction,
 * the only way a canonical interaction is ever marked removed_at_source by a re-read (absence from a listing never is,
 * TA §47.3). Application services only; the job wrapper (jobs/confirm-interaction.ts, INTEGRATION) resolves the two
 * identifiers and maps the outcome.
 *
 *   requestInteractionConfirmation   the internal (job-scope) request: the canonical interaction of the bound
 *                                    workspace → one IDs-only `ingestion.confirm_interaction` outbox row. No web
 *                                    surface, no scheduler, no fan-out.
 *   confirmStoredInteraction         INTEGRATION, between transactions:
 *     1. prepare (one transaction)   load the canonical row and its STORED authority, issued only by the interactions
 *                                    persistence layer (H6-A1, TL decision 1); derive the provider target from that
 *                                    authority alone (account, content, identity, parent, kind — never a caller's
 *                                    ids); re-check the
 *                                    account, connection, kill switch, profile and the capability for the content's
 *                                    scope AND the interaction's kind (Instagram replies are not read: refused);
 *                                    the credential of the active connection;
 *     2. read (no transaction)       exactly one `getInteraction(stored)` under the credential;
 *     3. commit (one transaction)    re-check under a share lock (a removal meanwhile discards the answer); a FOUND
 *                                    node must match its authority (verifyStoredReread: workspace, account, platform,
 *                                    asset, interaction, content, parent, kind — any mismatch fails closed); then feed
 *                                    the ONE canonical ingestion path (ingestInteractionFact, mechanism stored_reread ·
 *                                    getInteraction · stored): a FOUND node is an ordinary observation (unchanged adds
 *                                    nothing; a removed interaction that reappears becomes available again, same row);
 *                                    an AUTHORITATIVE not-found with a healthy connection is a removal observation
 *                                    (removalBasisFrom: direct_fetch_confirmed) — text history, parent, conversation
 *                                    and every earlier observation stay; an already-removed interaction adds nothing.
 * Anything else changes nothing: an UNCONFIRMED not-found (Meta's 100/33 today), a contradicting node, a transient,
 * rate-limited, permission, credential or capability failure. Coverage and watermarks are traversal facts and are
 * never touched here; no conversation is created, deleted or re-anchored by a confirmation.
 */
import type { CorrelationId } from "@/domain/correlation";
import { parseInstant, type Instant } from "@/domain/instant";
import { isPlatformKey } from "@/domain/platforms";
import { TargetNotFoundError, parseIsoInstant, providerObjectRef, type InteractionDto, type ProviderAccess, type StoredInteractionProvenance } from "@/integrations/providers/contract";
import type { DiscoveryProviders, ProviderCredentialAccess } from "@/modules/connections";
import { coveredInteractionKinds } from "@/modules/coverage";
import { parseWorkspaceId } from "@/domain/ids";
import { parseProviderId } from "@/domain/provider-identity";
import { parseInteractionSourceFact, removalBasisFrom, verifyStoredReread, type InteractionSourceFact, type StoredInteractionAuthority } from "@/modules/interactions";
import { completesConfirmation, type ConfirmationOutcome } from "../domain/confirmation";
import { reconciliationArrival } from "../domain/policy";
import { IngestionAuthorityConflict, ingestInteractionFact } from "./ingest-interaction";
import { availabilityInput, classify, gate, type Gate, type ReconciliationClock, type ReconciliationScope } from "./reconciliation";
import { SourceFactRejectedError, interactionSourceFactFromDto } from "./source-fact-mapping";

// ── request (job scope, internal) ──────────────────────────────────────────────────────────────────────────────
export type ConfirmationRequestOutcome =
  | { readonly kind: "requested"; readonly requestId: string }
  /** Step H6-F4: a confirmation already holds this request's deterministic key (a redelivery; nothing appended). */
  | { readonly kind: "coalesced" }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_eligible" };

export async function requestInteractionConfirmation(
  scope: ReconciliationScope,
  clock: ReconciliationClock,
  input: {
    readonly interactionId: string;
    readonly correlationId: CorrelationId;
    /** Step H6-F4: signal callers pass a key derived from the routed hint (idempotent redelivery); others keep one key per request. */
    readonly dispatchKey?: string;
  },
): Promise<ConfirmationRequestOutcome> {
  // The bound workspace's row only (RLS): another workspace's id is the same not_found as an unknown one.
  const record = await scope.ingestion.interactions.findById(input.interactionId);
  if (record === undefined) return { kind: "not_found" };
  if (!record.observed || record.kind === null) return { kind: "not_eligible" };
  const requestId = clock.newId();
  const appended = await scope.reconciliation.enqueueConfirmation(
    { organizationId: record.organizationId, workspaceId: record.workspaceId, connectedAccountId: record.connectedAccountId, interactionId: record.id },
    input.correlationId,
    requestId,
    clock.now(),
    input.dispatchKey,
  );
  return appended === "appended" ? { kind: "requested", requestId } : { kind: "coalesced" };
}

// ── confirmation (INTEGRATION) ─────────────────────────────────────────────────────────────────────────────────
export interface ConfirmationDependencies {
  /** A fresh workspace-scoped transaction per call (never held across the provider call). */
  inScope<T>(work: (scope: ReconciliationScope) => Promise<T>): Promise<T>;
  readonly access: ProviderCredentialAccess;
  readonly providers: DiscoveryProviders;
  readonly clock: ReconciliationClock;
  /** Whether this task attempt is the last the runtime will make (a transient failure then finishes the confirmation). */
  readonly finalAttempt: boolean;
}

export type ConfirmationResult =
  | { readonly kind: "confirmed"; readonly outcome: ConfirmationOutcome; readonly changed: boolean }
  | { readonly kind: "retry"; readonly error: unknown };

interface Prepared {
  readonly interactionId: string;
  readonly authority: StoredInteractionAuthority;
  readonly gate: Extract<Gate, { kind: "readable" }>;
  readonly credential: { readonly id: string; readonly envelope: Uint8Array };
  readonly stored: StoredInteractionProvenance;
  readonly content: { readonly id: string; readonly contentKind: string; readonly reportedSource: string };
  readonly epoch: Date | null;
}

type Read =
  | { readonly kind: "found"; readonly dto: InteractionDto; readonly readAt: Date }
  | { readonly kind: "not_found"; readonly authoritative: boolean; readonly readAt: Date }
  | { readonly kind: "settled"; readonly outcome: ConfirmationOutcome };

const done = (outcome: ConfirmationOutcome, changed = false): ConfirmationResult => ({ kind: "confirmed", outcome, changed });
const instant = (date: Date): Instant => {
  const parsed = parseInstant(date.toISOString());
  if (parsed === undefined) throw new Error("confirmation_instant_invalid");
  return parsed;
};
/** A blocked gate is never removal authority: missing authorization is named, everything else is unavailable. */
const blockedOutcome = (blocked: Extract<Gate, { kind: "blocked" }>): ConfirmationOutcome =>
  blocked.availability?.reason === "ACCOUNT_PERMISSION_MISSING" ? "AUTHORIZATION_FAILURE" : "CAPABILITY_UNAVAILABLE";

/**
 * Step H6-F4d (0023): one confirmation attempt, bracketed by its confirm mark (when the interaction has one):
 *   before  ingestion.begin_signal_confirmation_read stamps the DB time this direct reread begins (its own committed
 *           transaction, strictly before the provider is reached); the value travels as LOSSLESS text, in memory only —
 *           never in a payload, never through a JS Date (microseconds would be lost);
 *   after   a COMPLETED authoritative reread (FOUND / AUTHORITATIVE_NOT_FOUND) confirms the mark through exactly that
 *           read start (ingestion.complete_signal_confirmation_read); any other final outcome — Meta's ambiguous 100/33,
 *           a temporary, authorization or capability failure, an ineligible target — leaves confirmed_through_at
 *           untouched and backs the next claim off (DB time); a retried attempt settles nothing (the next attempt begins
 *           its own read). A crash between the provider's answer and the settle simply leaves the mark unconfirmed: the
 *           next claim re-reads (never a false caught-up).
 * The mark schedules reads only; it never changes what counts as provider truth (removal authority stays H6-E's).
 */
export async function confirmStoredInteraction(
  deps: ConfirmationDependencies,
  input: { readonly interactionId: string; readonly connectedAccountId: string; readonly correlationId: CorrelationId },
): Promise<ConfirmationResult> {
  const begun = await deps.inScope((scope) => scope.signals.beginConfirmationRead(input.connectedAccountId, input.interactionId));
  const result = await confirmOnce(deps, input);
  if (result.kind === "confirmed" && begun.startedAt !== null) {
    const startedAt = begun.startedAt;
    await deps.inScope(async (scope) => {
      if (completesConfirmation(result.outcome)) await scope.signals.completeConfirmationRead(input.connectedAccountId, input.interactionId, startedAt);
      else await scope.signals.backoffConfirmation(input.connectedAccountId, input.interactionId);
    });
  }
  return result;
}

async function confirmOnce(
  deps: ConfirmationDependencies,
  input: { readonly interactionId: string; readonly connectedAccountId: string; readonly correlationId: CorrelationId },
): Promise<ConfirmationResult> {
  // ── step 1: prepare ─────────────────────────────────────────────────────────────────────────────────────────
  const prepared = await deps.inScope((scope) => prepare(scope, input));
  if ("kind" in prepared) return prepared;

  // ── step 2: exactly one direct provider read, outside any transaction ─────────────────────────────────────
  const read = await readStored(deps, prepared);
  if ("error" in read) return deps.finalAttempt ? done("TEMPORARY_FAILURE") : { kind: "retry", error: read.error };
  if (read.kind === "settled") return done(read.outcome);

  // ── step 3: commit ──────────────────────────────────────────────────────────────────────────────────────────
  return deps.inScope((scope) => commit(scope, deps.clock, prepared, read, input.correlationId));
}

async function prepare(scope: ReconciliationScope, input: { readonly interactionId: string; readonly connectedAccountId: string }): Promise<Prepared | ConfirmationResult> {
  const record = await scope.ingestion.interactions.findById(input.interactionId);
  // Another workspace's id (RLS hides it), an unknown id, or one of another account: the same answer.
  if (record === undefined || record.connectedAccountId !== input.connectedAccountId) return done("INTERACTION_NOT_FOUND");
  if (!record.observed || (record.kind !== "comment" && record.kind !== "reply") || record.providerCreatedAt === null) return done("NOT_ELIGIBLE");
  const content = await scope.ingestion.content.findById(record.contentItemId);
  if (content === undefined) return done("NOT_ELIGIBLE");
  const checked = await gate(scope, record.connectedAccountId, "read_interactions", content.contentKind, content.reportedSource);
  if (checked.kind === "blocked") return done(blockedOutcome(checked));
  // The capability must read this KIND too (Instagram replies: REPLIES_NOT_READ — never re-read, never removed).
  if (!coveredInteractionKinds(availabilityInput(checked.availability)).includes(record.kind)) return done("CAPABILITY_UNAVAILABLE");
  const platform = checked.account.platform;
  const workspaceId = parseWorkspaceId(record.workspaceId);
  if (!isPlatformKey(platform) || workspaceId === undefined || record.platform !== platform) return done("PROVIDER_CONTRACT_AMBIGUOUS");
  // The STORED authority, issued by the interactions persistence layer from the canonical row (the only issuer).
  const authority = await scope.authority.storedInteraction(workspaceId, record.platform, record.providerInteractionId);
  if (authority === undefined) return done("NOT_ELIGIBLE");
  if (authority.canonicalId !== record.id || authority.connectedAccountId !== checked.account.id || authority.providerAssetId !== checked.account.providerAssetId) return done("PROVIDER_CONTRACT_AMBIGUOUS");
  const credentialId = checked.connection.activeCredentialId;
  const credential = credentialId === null ? undefined : await scope.authority.credential(credentialId);
  if (credentialId === null || credential?.connectionId !== checked.connection.id) return done("CAPABILITY_UNAVAILABLE");
  const watermark = await scope.reconciliation.watermark(record.connectedAccountId, content.id);
  // The provider target is the authority's facts only — never a caller's ids, never a bare provider id.
  const stored: StoredInteractionProvenance = Object.freeze({
    account: providerObjectRef(platform, "asset", authority.providerAssetId),
    content: providerObjectRef(platform, "content", authority.contentId),
    ref: providerObjectRef(platform, "interaction", authority.interactionId),
    parent: authority.parentId === null ? null : providerObjectRef(platform, "interaction", authority.parentId),
    interactionKind: authority.kind,
  });
  return {
    interactionId: record.id,
    authority,
    gate: checked,
    credential: { id: credentialId, envelope: credential.envelope },
    stored,
    content: { id: content.id, contentKind: content.contentKind, reportedSource: content.reportedSource },
    epoch: watermark?.epochAt ?? null,
  };
}

async function readStored(deps: ConfirmationDependencies, prepared: Prepared): Promise<Read | { readonly error: unknown }> {
  const port = deps.providers.read(prepared.gate.connection.provider);
  if (port === undefined) return { kind: "settled", outcome: "CAPABILITY_UNAVAILABLE" };
  // Exactly one read per attempt (CONFIRMATION_RUNTIME): no loop, no fallback, no listing.
  try {
    const dto = await deps.access.withCredential(
      { workspaceId: prepared.gate.account.workspaceId, credentialId: prepared.credential.id, envelope: prepared.credential.envelope },
      async (credential) => {
        const access: ProviderAccess = { credential, account: prepared.stored.account };
        return (await port.getInteraction(access, { kind: "stored", stored: prepared.stored })).data;
      },
    );
    return { kind: "found", dto, readAt: deps.clock.now() };
  } catch (error) {
    // Only the provider's VALIDATED not-found for this node is removal authority; Meta's is unconfirmed today.
    if (error instanceof TargetNotFoundError) return { kind: "not_found", authoritative: error.authority === "authoritative", readAt: deps.clock.now() };
    const failure = classify(error);
    if (failure === undefined || failure.kind === "transient" || failure.kind === "rate_limited") return { error };
    if (failure.failureClass === "permission_missing" || failure.failureClass === "credential_invalid" || failure.failureClass === "credential_unreadable") return { kind: "settled", outcome: "AUTHORIZATION_FAILURE" };
    return { kind: "settled", outcome: "PROVIDER_CONTRACT_AMBIGUOUS" };
  }
}

async function commit(scope: ReconciliationScope, clock: ReconciliationClock, prepared: Prepared, read: Extract<Read, { kind: "found" | "not_found" }>, correlationId: CorrelationId): Promise<ConfirmationResult> {
  // Re-check under a share lock: a removal, a pause or a lost capability meanwhile discards the answer.
  const checked = await gate(scope, prepared.gate.account.id, "read_interactions", prepared.content.contentKind, prepared.content.reportedSource, { shareLock: true });
  if (checked.kind === "blocked") return done(blockedOutcome(checked));
  const record = await scope.ingestion.interactions.findById(prepared.interactionId);
  if (record === undefined || record.connectedAccountId !== prepared.gate.account.id || record.providerCreatedAt === null) return done("INTERACTION_NOT_FOUND");
  const availability = availabilityInput(checked.availability);

  let fact: InteractionSourceFact;
  let outcome: ConfirmationOutcome;
  if (read.kind === "found") {
    try {
      fact = interactionSourceFactFromDto(read.dto, {
        workspaceId: record.workspaceId as InteractionSourceFact["scope"]["workspaceId"],
        connectedAccountId: record.connectedAccountId,
        providerAssetId: checked.account.providerAssetId,
        mechanism: "stored_reread",
        operation: "getInteraction",
        provenance: "stored",
        observedAt: instant(read.readAt),
        catalogRevision: checked.profile.catalogRevision,
        profileRevision: checked.profile.revision,
      });
    } catch (error) {
      if (error instanceof SourceFactRejectedError) return done("PROVIDER_CONTRACT_AMBIGUOUS");
      throw error;
    }
    // The node must be the stored interaction: any contradiction of its authority fails closed (nothing applied).
    const interactionId = parseProviderId(read.dto.ref.id);
    const contentId = parseProviderId(read.dto.content.id);
    const parentId = read.dto.parent === null ? null : parseProviderId(read.dto.parent.id);
    const providerAssetId = parseProviderId(checked.account.providerAssetId);
    if (interactionId === undefined || contentId === undefined || parentId === undefined || providerAssetId === undefined) return done("PROVIDER_CONTRACT_AMBIGUOUS");
    const mismatches = verifyStoredReread(
      prepared.authority,
      { workspaceId: prepared.authority.workspaceId, connectedAccountId: checked.account.id, platform: prepared.authority.platform, providerAssetId },
      { interactionId, contentId, parentId, kind: read.dto.interactionKind },
    );
    if (mismatches.length > 0) return done("PROVIDER_CONTRACT_AMBIGUOUS");
    outcome = "FOUND";
  } else {
    const basis = removalBasisFrom({ verifiedProviderSignal: false, directFetch: "not_found", connectionHealthy: checked.connection.status === "ACTIVE", notFoundConfirmsRemoval: read.authoritative });
    if (basis === null) return done(read.authoritative ? "CAPABILITY_UNAVAILABLE" : "PROVIDER_CONTRACT_AMBIGUOUS");
    const createdAt = parseIsoInstant(record.providerCreatedAt.toISOString());
    // The removal observation is built from the canonical row only: same identity, no text, no author re-creation.
    const parsed = parseInteractionSourceFact({
      scope: { workspaceId: prepared.authority.workspaceId, connectedAccountId: prepared.authority.connectedAccountId, platform: prepared.authority.platform, providerAssetId: prepared.authority.providerAssetId },
      identity: { interactionId: prepared.authority.interactionId, contentId: prepared.authority.contentId, parentId: prepared.authority.parentId, kind: prepared.authority.kind },
      author: { ref: null, role: record.authorRole ?? "unknown", label: null },
      text: { sourceText: null, textHash: null },
      state: { visibility: record.currentVisibility ?? "unknown", availability: "removed_at_source", removalBasis: basis },
      time: { providerCreatedAt: createdAt, providerEditedAt: null, observedAt: instant(read.readAt) },
      provenance: { mechanism: "stored_reread", operation: "getInteraction", provenance: "stored" },
      evaluation: { catalogRevision: checked.profile.catalogRevision, profileRevision: checked.profile.revision },
    });
    if (!parsed.ok) return done("PROVIDER_CONTRACT_AMBIGUOUS");
    fact = parsed.fact;
    outcome = "AUTHORITATIVE_NOT_FOUND";
  }

  try {
    const result = await scope.isolated((stores) => ingestInteractionFact(stores, clock, {
      fact,
      content: { contentKind: prepared.content.contentKind, reportedSource: prepared.content.reportedSource },
      availability,
      arrival: reconciliationArrival({ epoch: prepared.epoch === null ? null : instant(prepared.epoch), providerCreatedAt: fact.time.providerCreatedAt }),
      correlationId,
    }));
    if (result.kind === "rejected") return done("CAPABILITY_UNAVAILABLE");
    return done(outcome, result.kind !== "unchanged");
  } catch (error) {
    // The node contradicts the stored identity: nothing is written (the savepoint rolled back), fail closed.
    if (error instanceof IngestionAuthorityConflict) return done("PROVIDER_CONTRACT_AMBIGUOUS");
    throw error;
  }
}
