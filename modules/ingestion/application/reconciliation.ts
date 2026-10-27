/**
 * The reconciliation runtime (Step H6-C3; design H6-C0; TL D-C1…D-C5; migration 0018). Application services only —
 * the job wrappers (jobs/reconciliation*.ts) resolve identifiers and map outcomes; no Trigger.dev, no provider SDK.
 *
 *   requestReconciliation   the job runtime's (internal/operator) adapter of the 0019 request boundary
 *                           ingestion.request_reconciliation — the ONE creation algorithm: authorization, the one-open
 *                           check (`already_running`), the REQUESTED run with its budget (max_operations included), the
 *                           audit event and the `ingestion.reconcile_account` row, atomically (the web path, H6-C4,
 *                           calls the same function under the member's claims, with no budget or time of its own)
 *   planReconciliation      MAIN: re-checks the account, connection, kill switch and capability (never a credential);
 *                           unavailable → SKIPPED_UNAVAILABLE (+ a truthful gap only over intervals already synced);
 *                           otherwise RUNNING + the first content_listing slice + its outbox row
 *   runReconciliationSlice  INTEGRATION, between transactions: claim (PENDING → RUNNING, attempt + 1, lease) →
 *                           for each page: re-check authority + reserve one operation, then ONE provider read outside
 *                           any transaction → commit: re-check the account and connection (share-locked), ingest,
 *                           coverage, watermark, the slice's terminal or CONTINUED state, and the next slice's outbox row
 *   acceptObservedInteraction  MAIN: the H6 terminal consumer of `interactions.observed` (ids only, never text)
 *
 * Serial per account: one open run, one RUNNING slice (database indexes are the authority), and the next slice is
 * dispatched only by the commit that finishes the current one. Provider ordering is never authority: a slice reads to
 * the provider's end of pages or to its budget, never stopping early, and each slice's facts are ingested parents
 * first. A cursor lives only in its slice row and expires after SLICE_CURSOR_MAX_AGE_MS (the window restarts once).
 * Coverage is written with the slice's progress, in the same transaction, and claims only what was traversed.
 */
import type { CorrelationId } from "@/domain/correlation";
import { parseCorrelationId } from "@/domain/correlation";
import { parseInstant, type Instant } from "@/domain/instant";
import { isPlatformKey } from "@/domain/platforms";
import {
  CredentialInvalidError,
  OutcomeUnknownError,
  PermanentRejectedError,
  PermissionMissingError,
  RateLimitedError,
  TargetNotEligibleError,
  TargetNotFoundError,
  TransientError,
  parseIsoInstant,
  parsePageCursor,
  providerObjectRef,
  type ContentDto,
  type InteractionDto,
  type Page,
  type ProviderAccess,
  type ProviderReadPort,
  type TimeWindow,
} from "@/integrations/providers/contract";
import { capabilityAvailability, type CapabilityAvailability, type CapabilityKey } from "@/modules/capability";
import { CredentialUnreadableError, type ConnectedAccount, type Connection, type DiscoveryProviders, type ProviderCredentialAccess } from "@/modules/connections";
import { coverageForSlice, historyBeforeFirstRead, type AvailabilityInput, type SliceReadResult } from "@/modules/coverage";
import type { InteractionSourceFact } from "@/modules/interactions";
import { resolveSwitch } from "@/platform/flags";
import { reconciliationArrival } from "../domain/policy";
import { SLICE_CURSOR_MAX_AGE_MS, advanceSlice, type ReconciliationSlice, type SliceStep } from "../domain/reconciliation-slice";
import { RECONCILIATION_RUNTIME, defaultBudgetSnapshot, type ReconciliationBudgetSnapshot } from "../domain/reconciliation-state";
import { IngestionAuthorityConflict, ingestInteractionFact } from "./ingest-interaction";
import { orderParentsFirst } from "./ordering";
import type { IngestionClock, IngestionStores } from "./ports";
import type { ReconciliationAuthorityStore, ReconciliationRunRecord, ReconciliationSliceRecord, ReconciliationStore, SliceFinish } from "./reconciliation-ports";
import { SourceFactRejectedError, interactionSourceFactFromDto } from "./source-fact-mapping";

/** One workspace-scoped transaction's stores. `isolated` runs work in a savepoint whose failure rolls back alone. */
export interface ReconciliationScope {
  readonly reconciliation: ReconciliationStore;
  readonly authority: ReconciliationAuthorityStore;
  readonly ingestion: IngestionStores;
  isolated<T>(work: (ingestion: IngestionStores) => Promise<T>): Promise<T>;
}

export type ReconciliationClock = IngestionClock;

/** The validated read scope of the listing and of an interactions slice's eligibility (H6-A1: post · unknown). */
const VALIDATED_SCOPE = { contentKind: "post", source: "unknown" } as const;

const instant = (date: Date): Instant => {
  const parsed = parseInstant(date.toISOString());
  if (parsed === undefined) throw new Error("reconciliation_instant_invalid");
  return parsed;
};
const iso = (date: Date) => {
  const parsed = parseIsoInstant(date.toISOString());
  if (parsed === undefined) throw new Error("reconciliation_instant_invalid");
  return parsed;
};
const readable = (availability: CapabilityAvailability): boolean => availability.state === "AVAILABLE" || availability.state === "AVAILABLE_WITH_LIMITATION";
const availabilityInput = (availability: CapabilityAvailability): AvailabilityInput => ({ state: availability.state, reason: availability.reason, limitationCode: availability.limitation?.code ?? null });
const failureClassOf = (reason: string): string => reason.toLowerCase();
/** Availability reasons that concern the whole account (the run stops) rather than one content scope. */
const ACCOUNT_LEVEL_REASONS: readonly string[] = [
  "ACCOUNT_PERMISSION_MISSING", "PROFILE_NOT_EVALUATED", "PROFILE_STALE", "ACCOUNT_INACTIVE",
  "CONNECTION_VALIDATING", "CONNECTION_DEGRADED", "CONNECTION_FAILED", "CONNECTION_DISCONNECTED", "CONNECTION_REMOVED",
];

// ── authority gate ──────────────────────────────────────────────────────────────────────────────────────────
type Gate =
  | {
    readonly kind: "readable";
    readonly account: ConnectedAccount;
    readonly connection: Connection;
    readonly availability: CapabilityAvailability;
    readonly profile: { readonly catalogRevision: number; readonly revision: number };
  }
  | { readonly kind: "blocked"; readonly failureClass: string; readonly accountLevel: boolean; readonly availability: AvailabilityInput | null };

/** Re-evaluates everything one provider operation rests on, from persistence, now (never from an earlier step). */
async function gate(scope: ReconciliationScope, connectedAccountId: string, capability: CapabilityKey, contentKind: string, source: string, options: { readonly shareLock?: boolean } = {}): Promise<Gate> {
  const account = await scope.authority.account(connectedAccountId);
  if (account === undefined) return { kind: "blocked", failureClass: "account_not_found", accountLevel: true, availability: null };
  if (account.status !== "ACTIVE") return { kind: "blocked", failureClass: "account_inactive", accountLevel: true, availability: { state: "UNAVAILABLE", reason: "ACCOUNT_INACTIVE", limitationCode: null } };
  const connection = options.shareLock === true ? await scope.authority.connectionForShare(account.connectionId) : await scope.authority.connection(account.connectionId);
  if (connection === undefined || connection.status === "REMOVED") {
    return { kind: "blocked", failureClass: "connection_removed", accountLevel: true, availability: { state: "UNAVAILABLE", reason: "CONNECTION_REMOVED", limitationCode: null } };
  }
  const paused = resolveSwitch(await scope.authority.switches(), "ingestion.provider_pause", { qualifier: account.platform });
  // A paused provider reads nothing; its gap is not described as a provider failure (no coverage record = UNKNOWN).
  if (paused.value.paused) return { kind: "blocked", failureClass: "provider_paused", accountLevel: true, availability: null };
  const availability = await capabilityAvailability(scope.authority.capability, {
    connectedAccountId: account.id,
    accountStatus: account.status,
    provider: connection.provider,
    capability,
    contentKind: contentKind as Parameters<typeof capabilityAvailability>[1]["contentKind"],
    source: source as Parameters<typeof capabilityAvailability>[1]["source"],
    connection: connection.status,
  });
  if (!readable(availability)) {
    return { kind: "blocked", failureClass: failureClassOf(availability.reason), accountLevel: ACCOUNT_LEVEL_REASONS.includes(availability.reason), availability: availabilityInput(availability) };
  }
  const header = await scope.authority.capability.header(account.id);
  if (header === undefined) return { kind: "blocked", failureClass: "profile_not_evaluated", accountLevel: true, availability: { state: "UNAVAILABLE", reason: "PROFILE_NOT_EVALUATED", limitationCode: null } };
  if (connection.activeCredentialId === null) return { kind: "blocked", failureClass: "no_credential", accountLevel: true, availability: { state: "TEMPORARILY_UNAVAILABLE", reason: "CONNECTION_FAILED", limitationCode: null } };
  return { kind: "readable", account, connection, availability, profile: { catalogRevision: header.catalogRevision, revision: header.revision } };
}

// ── request ─────────────────────────────────────────────────────────────────────────────────────────────────
export type RequestReconciliationOutcome =
  | { readonly kind: "requested"; readonly runId: string }
  | { readonly kind: "already_running"; readonly runId: string }
  | { readonly kind: "not_found" };

export async function requestReconciliation(
  scope: ReconciliationScope,
  clock: ReconciliationClock,
  input: {
    readonly connectedAccountId: string;
    readonly correlationId: CorrelationId;
    /** The approved defaults (40 operations) unless an internal/operator caller narrows them (e.g. LIVE acceptance: 8). */
    readonly budget?: ReconciliationBudgetSnapshot;
  },
): Promise<RequestReconciliationOutcome> {
  // The job runtime's (internal) path: the boundary itself authorizes, checks the open run, writes the run, its audit
  // event and the planner row atomically. This adapter only names the time and the budget, and maps the answer.
  const result = await scope.reconciliation.requestRun({
    connectedAccountId: input.connectedAccountId,
    correlationId: input.correlationId,
    requestedAt: clock.now(),
    budget: input.budget ?? defaultBudgetSnapshot(),
  });
  if (result.outcome === "requested") return { kind: "requested", runId: result.runId };
  if (result.outcome === "already_running") return { kind: "already_running", runId: result.runId };
  return { kind: "not_found" };
}

// ── planner (MAIN) ──────────────────────────────────────────────────────────────────────────────────────────
export type PlanOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "already_planned"; readonly state: string }
  | { readonly kind: "skipped"; readonly failureClass: string }
  | { readonly kind: "started"; readonly sliceId: string };

export async function planReconciliation(scope: ReconciliationScope, clock: ReconciliationClock, input: { readonly runId: string; readonly connectedAccountId: string }): Promise<PlanOutcome> {
  const run = await scope.reconciliation.lockRun(input.runId);
  if (run === undefined || run.connectedAccountId !== input.connectedAccountId) return { kind: "not_found" };
  if (run.state !== "REQUESTED") return { kind: "already_planned", state: run.state };
  const now = clock.now();
  const correlationId = correlationOf(run);
  // Both capabilities at the validated scope: listing without readable interactions would read for nothing.
  let blocked: Extract<Gate, { kind: "blocked" }> | undefined;
  for (const capability of ["read_content", "read_interactions"] as const) {
    const checked = await gate(scope, run.connectedAccountId, capability, VALIDATED_SCOPE.contentKind, VALIDATED_SCOPE.source);
    if (checked.kind === "blocked") {
      blocked = checked;
      break;
    }
  }
  const backoff = blocked === undefined ? await scope.reconciliation.activeBackoff(run.connectedAccountId, now) : undefined;
  if (backoff !== undefined) blocked = { kind: "blocked", failureClass: "rate_limited_backoff", accountLevel: true, availability: null };
  if (blocked !== undefined) {
    // A truthful gap only where an interval is already known: since each synced content's synced-through.
    if (blocked.availability !== null) {
      for (const watermark of await scope.reconciliation.watermarksWithSync(run.connectedAccountId)) {
        if (watermark.syncedThrough === null || watermark.syncedThrough >= now) continue;
        await recordCoverage(scope, run, watermark.contentItemId, watermark.syncedThrough, now, blocked.availability, "not_attempted", correlationId, clock);
      }
    }
    await scope.reconciliation.finishRun(run.id, "SKIPPED_UNAVAILABLE", blocked.failureClass, now);
    return { kind: "skipped", failureClass: blocked.failureClass };
  }
  if (!(await scope.reconciliation.startRun(run.id, now))) return { kind: "already_planned", state: "RUNNING" };
  const slice = { id: clock.newId(), organizationId: run.organizationId, workspaceId: run.workspaceId, connectedAccountId: run.connectedAccountId };
  await scope.reconciliation.insertSlice({
    ...slice,
    runId: run.id,
    unit: "content_listing",
    contentItemId: null,
    sequence: 0,
    cursor: null,
    cursorIssuedAt: null,
    windowStart: new Date(RECONCILIATION_RUNTIME.windowFloor),
    windowEnd: now,
    maxPages: run.budget.listingPagesPerSlice,
    createdAt: now,
  });
  await scope.reconciliation.enqueueSlice(slice, run.correlationId, clock.newId(), now);
  return { kind: "started", sliceId: slice.id };
}

// ── slice (INTEGRATION) ─────────────────────────────────────────────────────────────────────────────────────
export interface SliceDependencies {
  /** A fresh workspace-scoped transaction per call (never held across a provider call). */
  inScope<T>(work: (scope: ReconciliationScope) => Promise<T>): Promise<T>;
  readonly access: ProviderCredentialAccess;
  readonly providers: DiscoveryProviders;
  readonly clock: ReconciliationClock;
  /** Whether this task attempt is the last the runtime will make (a transient failure then finishes the slice). */
  readonly finalAttempt: boolean;
}

export type SliceOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "already_finished" }
  | { readonly kind: "busy" }
  | { readonly kind: "superseded" }
  | { readonly kind: "finished"; readonly state: SliceFinish["state"]; readonly failureClass: string | null }
  | { readonly kind: "retry"; readonly error: unknown };

interface ClaimedSlice {
  readonly slice: ReconciliationSliceRecord;
  readonly run: ReconciliationRunRecord;
  readonly gate: Extract<Gate, { kind: "readable" }>;
  readonly credential: { readonly id: string; readonly envelope: Uint8Array };
  readonly content: { readonly id: string; readonly providerContentId: string; readonly contentKind: string; readonly reportedSource: string } | null;
  readonly watermark: { readonly epochAt: Date; readonly syncedThrough: Date | null } | null;
}

type ReadResult =
  | { readonly kind: "complete"; readonly pages: readonly ReadPage[]; readonly latestCreatedAt: Instant | null }
  | { readonly kind: "continuation"; readonly pages: readonly ReadPage[]; readonly cursor: string; readonly cursorIssuedAt: Date; readonly latestCreatedAt: Instant | null }
  | { readonly kind: "budget_exhausted"; readonly pages: readonly ReadPage[] }
  | { readonly kind: "blocked"; readonly gate: Extract<Gate, { kind: "blocked" }> }
  | { readonly kind: "superseded" }
  | { readonly kind: "failed"; readonly failure: ProviderFailure };

interface ReadPage {
  readonly items: readonly (ContentDto | InteractionDto)[];
  readonly readAt: Date;
}

type ProviderFailure =
  | { readonly kind: "rate_limited"; readonly retryAfterSeconds: number | null }
  | { readonly kind: "transient"; readonly error: unknown }
  | { readonly kind: "permanent"; readonly failureClass: string; readonly accountLevel: boolean; readonly availability: AvailabilityInput | null };

/** Closed classification of a provider failure; anything unrecognized propagates (the job runtime retries it). */
function classify(error: unknown): ProviderFailure | undefined {
  if (error instanceof RateLimitedError) return { kind: "rate_limited", retryAfterSeconds: error.retryAfterSeconds };
  if (error instanceof TransientError || error instanceof OutcomeUnknownError) return { kind: "transient", error };
  if (error instanceof PermissionMissingError) return { kind: "permanent", failureClass: "permission_missing", accountLevel: true, availability: { state: "UNAVAILABLE", reason: "ACCOUNT_PERMISSION_MISSING", limitationCode: null } };
  if (error instanceof CredentialInvalidError) return { kind: "permanent", failureClass: "credential_invalid", accountLevel: true, availability: { state: "TEMPORARILY_UNAVAILABLE", reason: "CONNECTION_FAILED", limitationCode: null } };
  if (error instanceof CredentialUnreadableError) return { kind: "permanent", failureClass: "credential_unreadable", accountLevel: true, availability: { state: "TEMPORARILY_UNAVAILABLE", reason: "CONNECTION_FAILED", limitationCode: null } };
  if (error instanceof TargetNotFoundError) return { kind: "permanent", failureClass: "target_not_found", accountLevel: false, availability: null };
  if (error instanceof TargetNotEligibleError) return { kind: "permanent", failureClass: "target_not_eligible", accountLevel: false, availability: null };
  if (error instanceof PermanentRejectedError) return { kind: "permanent", failureClass: "provider_rejected", accountLevel: false, availability: null };
  return undefined;
}

const correlationOf = (run: ReconciliationRunRecord): CorrelationId => {
  const parsed = parseCorrelationId(run.correlationId);
  if (parsed === undefined) throw new Error("reconciliation_run_incoherent");
  return parsed;
};

export async function runReconciliationSlice(deps: SliceDependencies, input: { readonly sliceId: string; readonly connectedAccountId: string }): Promise<SliceOutcome> {
  const { clock } = deps;
  // ── step 1: claim ────────────────────────────────────────────────────────────────────────────────────────
  const claimed = await deps.inScope(async (scope): Promise<ClaimedSlice | SliceOutcome> => {
    const slice = await scope.reconciliation.lockSlice(input.sliceId);
    if (slice === undefined || slice.connectedAccountId !== input.connectedAccountId) return { kind: "not_found" };
    if (slice.state !== "PENDING" && slice.state !== "RUNNING") return { kind: "already_finished" };
    const run = await scope.reconciliation.lockRun(slice.runId);
    if (run?.state !== "RUNNING") return { kind: "already_finished" };
    const now = clock.now();
    if (slice.attempt >= RECONCILIATION_RUNTIME.maxSliceAttempts) {
      return closeSlice(scope, clock, run, slice, { state: "FAILED_TRANSIENT", failureClass: "attempts_exhausted", retryNotBefore: null }, "failed_transient", null, now);
    }
    const content = slice.contentItemId === null ? null : ((await scope.ingestion.content.findById(slice.contentItemId)) ?? undefined);
    if (content === undefined) {
      return closeSlice(scope, clock, run, slice, { state: "FAILED_PERMANENT", failureClass: "content_missing", retryNotBefore: null }, null, null, now);
    }
    const capability = slice.unit === "content_listing" ? "read_content" : "read_interactions";
    const checked = await gate(scope, slice.connectedAccountId, capability, content?.contentKind ?? VALIDATED_SCOPE.contentKind, content?.reportedSource ?? VALIDATED_SCOPE.source);
    if (checked.kind === "blocked") return closeBlocked(scope, clock, run, slice, checked, now);
    const claim = await scope.reconciliation.claimSlice(slice.id, new Date(now.getTime() + RECONCILIATION_RUNTIME.sliceLeaseMs), now, new Date(now.getTime() - SLICE_CURSOR_MAX_AGE_MS));
    if (claim === "busy") return { kind: "busy" };
    if (claim === undefined) return { kind: "already_finished" };
    const credentialId = checked.connection.activeCredentialId;
    const credential = credentialId === null ? undefined : await scope.authority.credential(credentialId);
    if (credentialId === null || credential?.connectionId !== checked.connection.id) {
      return closeBlocked(scope, clock, run, claim, { kind: "blocked", failureClass: "no_credential", accountLevel: true, availability: { state: "TEMPORARILY_UNAVAILABLE", reason: "CONNECTION_FAILED", limitationCode: null } }, now);
    }
    const watermark = content === null ? undefined : await scope.reconciliation.watermark(slice.connectedAccountId, content.id);
    return {
      slice: claim,
      run,
      gate: checked,
      credential: { id: credentialId, envelope: credential.envelope },
      content: content === null ? null : { id: content.id, providerContentId: content.providerContentId, contentKind: content.contentKind, reportedSource: content.reportedSource },
      watermark: watermark === undefined ? null : { epochAt: watermark.epochAt, syncedThrough: watermark.syncedThrough },
    };
  });
  if ("kind" in claimed) return claimed;

  // ── step 2: provider reads, one operation at a time, outside any transaction ─────────────────────────────
  let result: ReadResult;
  try {
    result = await readSlice(deps, claimed);
  } catch (error) {
    return { kind: "retry", error };
  }
  if (result.kind === "failed" && result.failure.kind === "transient" && !deps.finalAttempt) return { kind: "retry", error: result.failure.error };

  // ── step 3: commit ───────────────────────────────────────────────────────────────────────────────────────
  return deps.inScope((scope) => commitSlice(scope, deps, claimed, result));
}

async function readSlice(deps: SliceDependencies, claimed: ClaimedSlice): Promise<ReadResult> {
  const { clock } = deps;
  const { slice, run, content } = claimed;
  const port = deps.providers.read(claimed.gate.connection.provider);
  if (port === undefined) return { kind: "failed", failure: { kind: "permanent", failureClass: "provider_unavailable", accountLevel: true, availability: null } };
  const platform = claimed.gate.account.platform;
  if (!isPlatformKey(platform)) throw new Error("reconciliation_platform_invalid");
  const window: TimeWindow = { from: iso(slice.windowStart), to: iso(slice.windowEnd) };
  const correlationId = correlationOf(run);
  let contract: ReconciliationSlice = {
    sliceId: slice.id,
    workspaceId: slice.workspaceId as ReconciliationSlice["workspaceId"],
    connectedAccountId: slice.connectedAccountId,
    platform,
    unit: slice.unit,
    scope: { capability: slice.unit === "content_listing" ? "read_content" : "read_interactions", contentKind: "post", source: "unknown" },
    contentRowId: slice.contentItemId,
    window: { from: instant(slice.windowStart), to: instant(slice.windowEnd) },
    watermark: null,
    overlapMs: run.budget.overlapSeconds * 1000,
    cursor: slice.cursor === null || slice.cursorIssuedAt === null ? null : { value: slice.cursor, issuedAt: instant(slice.cursorIssuedAt) },
    budget: { maxPages: slice.maxPages, pagesRead: 0 },
    sequence: slice.sequence,
    attempt: slice.attempt,
    correlationId,
  };
  let pages: ReadPage[] = [];
  let restarted = false;
  for (;;) {
    // Re-check every authority and reserve the operation (and the page) BEFORE the provider is reached.
    const reserved = await deps.inScope(async (scope) => {
      const capability = slice.unit === "content_listing" ? "read_content" : "read_interactions";
      const checked = await gate(scope, slice.connectedAccountId, capability, content?.contentKind ?? VALIDATED_SCOPE.contentKind, content?.reportedSource ?? VALIDATED_SCOPE.source);
      if (checked.kind === "blocked") return checked;
      // The run's persisted max_operations governs (0019): every read attempt reserves one, retries included.
      if (!(await scope.reconciliation.reserveRunOperation(run.id, clock.now()))) return "budget" as const;
      if (!(await scope.reconciliation.recordSliceOperation(slice.id, slice.attempt, 1, clock.now()))) return "superseded" as const;
      return "ok" as const;
    });
    if (reserved === "superseded") return { kind: "superseded" };
    if (reserved === "budget") return { kind: "budget_exhausted", pages };
    if (reserved !== "ok") return { kind: "blocked", gate: reserved };
    const cursor = contract.cursor === null ? null : parsePageCursor(contract.cursor.value);
    if (contract.cursor !== null && cursor === undefined) return { kind: "failed", failure: { kind: "permanent", failureClass: "cursor_invalid", accountLevel: false, availability: null } };
    let page: Page<ContentDto | InteractionDto>;
    try {
      page = await deps.access.withCredential(
        { workspaceId: claimed.gate.account.workspaceId, credentialId: claimed.credential.id, envelope: claimed.credential.envelope },
        async (credential) => {
          const access: ProviderAccess = { credential, account: providerObjectRef(platform, "asset", claimed.gate.account.providerAssetId) };
          return listPage(port, access, slice, content, window, cursor ?? null);
        },
      );
    } catch (error) {
      // An expired or refused cursor restarts the window ONCE (pages already read stay counted against the budget).
      if (error instanceof PermanentRejectedError && error.reasonCode === "invalid_cursor" && contract.cursor !== null && !restarted) {
        restarted = true;
        pages = [];
        contract = { ...contract, cursor: null, watermark: null };
        if (contract.budget.pagesRead + 1 >= contract.budget.maxPages) return { kind: "budget_exhausted", pages };
        contract = { ...contract, budget: { ...contract.budget, pagesRead: contract.budget.pagesRead + 1 } };
        continue;
      }
      const failure = classify(error);
      if (failure === undefined) throw error;
      return { kind: "failed", failure };
    }
    const readAt = clock.now();
    pages.push({ items: page.items, readAt });
    const created = page.items.map((item) => item.timestamps.createdAt).filter((value): value is NonNullable<typeof value> => value !== null).map((value) => parseInstant(value)).filter((value): value is Instant => value !== undefined);
    const latestCreatedAt = created.length === 0 ? null : created.reduce((a, b) => (a > b ? a : b));
    const step: SliceStep = advanceSlice(contract, { next: page.next, latestCreatedAt, readAt: instant(readAt) }, deps.clock.newId());
    if (step.kind === "continue") {
      contract = step.slice;
      continue;
    }
    if (step.kind === "complete") return { kind: "complete", pages, latestCreatedAt: step.watermark };
    const next = step.next.cursor;
    if (next === null) throw new Error("reconciliation_continuation_without_cursor");
    return { kind: "continuation", pages, cursor: next.value, cursorIssuedAt: new Date(next.issuedAt), latestCreatedAt: step.next.watermark };
  }
}

function listPage(port: ProviderReadPort, access: ProviderAccess, slice: ReconciliationSliceRecord, content: ClaimedSlice["content"], window: TimeWindow, cursor: Parameters<ProviderReadPort["listContent"]>[2]) {
  if (slice.unit === "content_listing") return port.listContent(access, window, cursor).then((result) => result.data as Page<ContentDto | InteractionDto>);
  if (content === null) throw new Error("reconciliation_slice_incoherent");
  const platform = access.account.platform;
  return port.listInteractions(access, { kind: "content", content: providerObjectRef(platform, "content", content.providerContentId) }, window, cursor).then((result) => result.data as Page<ContentDto | InteractionDto>);
}

async function commitSlice(scope: ReconciliationScope, deps: SliceDependencies, claimed: ClaimedSlice, result: ReadResult): Promise<SliceOutcome> {
  const { clock } = deps;
  const now = clock.now();
  const slice = await scope.reconciliation.lockSlice(claimed.slice.id);
  // Another attempt took the slice over (or it finished): this execution's reads are discarded.
  if (slice?.state !== "RUNNING" || slice.attempt !== claimed.slice.attempt || result.kind === "superseded") return { kind: "superseded" };
  const run = await scope.reconciliation.lockRun(slice.runId);
  if (run?.state !== "RUNNING") return { kind: "superseded" };
  // The account and connection are re-checked share-locked: a removal that happened after the provider answered wins,
  // and the answer is discarded unread.
  const capability = slice.unit === "content_listing" ? "read_content" : "read_interactions";
  const authority = await gate(scope, slice.connectedAccountId, capability, claimed.content?.contentKind ?? VALIDATED_SCOPE.contentKind, claimed.content?.reportedSource ?? VALIDATED_SCOPE.source, { shareLock: true });
  if (authority.kind === "blocked") return closeBlocked(scope, clock, run, slice, authority, now);
  if (result.kind === "blocked") return closeBlocked(scope, clock, run, slice, result.gate, now);

  if (result.kind === "failed") {
    const failure = result.failure;
    if (failure.kind === "rate_limited") {
      const retryNotBefore = new Date(now.getTime() + (failure.retryAfterSeconds ?? RECONCILIATION_RUNTIME.rateLimitDefaultBackoffSeconds) * 1000);
      const finish: SliceFinish = { state: "FAILED_RATE_LIMITED", failureClass: "rate_limited", retryNotBefore };
      return stopRun(scope, clock, run, slice, finish, "failed_transient", availabilityInput(authority.availability), now, { state: "FAILED_RATE_LIMITED", failureClass: "rate_limited_backoff", retryNotBefore });
    }
    if (failure.kind === "transient") {
      return closeSlice(scope, clock, run, slice, { state: "FAILED_TRANSIENT", failureClass: "provider_transient", retryNotBefore: null }, "failed_transient", availabilityInput(authority.availability), now);
    }
    if (failure.accountLevel) {
      const finish: SliceFinish = { state: "FAILED_PERMANENT", failureClass: failure.failureClass, retryNotBefore: null };
      return stopRun(scope, clock, run, slice, finish, failure.availability === null ? null : "not_attempted", failure.availability, now, finish);
    }
    return closeSlice(scope, clock, run, slice, { state: "FAILED_PERMANENT", failureClass: failure.failureClass, retryNotBefore: null }, null, null, now);
  }

  const pages = result.pages.length;
  if (slice.unit === "content_listing") {
    if (result.kind === "budget_exhausted") {
      return stopRun(scope, clock, run, slice, { state: "ABANDONED_BUDGET", failureClass: null, retryNotBefore: null }, null, null, now, { state: "ABANDONED_BUDGET", failureClass: null, retryNotBefore: null });
    }
    // A listing reads its authorized page(s) only; content beyond them is not reached this run (no claim about it).
    const created = await planContentSlices(scope, clock, run, slice, result.pages, authority, now);
    await scope.reconciliation.addRunUsage(run.id, { pages, contentItems: created }, now);
    return closeSlice(scope, clock, run, slice, { state: "COMPLETED", failureClass: null, retryNotBefore: null }, null, null, now);
  }

  // content_interactions
  const content = claimed.content;
  if (content === null) throw new Error("reconciliation_slice_incoherent");
  const watermark = await scope.reconciliation.watermark(slice.connectedAccountId, content.id);
  const conflicts = await ingestPages(scope, clock, run, slice, content, result.pages, watermark?.epochAt ?? null, authority);
  await scope.reconciliation.addRunUsage(run.id, { pages, contentItems: 0 }, now);
  const availability = availabilityInput(authority.availability);
  if (result.kind === "budget_exhausted") {
    // The RUN's operations are spent: this content and every content not reached yet are incomplete, never complete.
    const finish: SliceFinish = { state: "ABANDONED_BUDGET", failureClass: null, retryNotBefore: null };
    return stopRun(scope, clock, run, slice, finish, "budget_exhausted", availability, now, finish, conflicts);
  }
  if (result.kind === "complete") {
    const syncedFrom = watermark?.syncedThrough ?? null;
    if (syncedFrom === null) {
      // First complete traversal: the epoch is this traversal's window end; nothing before it is claimed.
      await recordHistoryGap(scope, clock, run, content.id, slice.windowStart, slice.windowEnd, correlationOf(run));
    } else {
      await recordCoverage(scope, run, content.id, syncedFrom, slice.windowEnd, availability, "completed", correlationOf(run), clock);
    }
    await scope.reconciliation.recordCompleteTraversal({
      organizationId: run.organizationId,
      workspaceId: run.workspaceId,
      connectedAccountId: slice.connectedAccountId,
      contentItemId: content.id,
      contentKind: content.contentKind,
      source: content.reportedSource,
      syncedThrough: slice.windowEnd,
      latestCreatedAt: result.latestCreatedAt === null ? null : new Date(result.latestCreatedAt),
      runId: run.id,
      now,
    });
    return closeSlice(scope, clock, run, slice, { state: "COMPLETED", failureClass: null, retryNotBefore: null }, null, null, now, conflicts);
  }
  if (slice.sequence < run.budget.continuationsPerContent) {
    const next = { id: clock.newId(), organizationId: slice.organizationId, workspaceId: slice.workspaceId, connectedAccountId: slice.connectedAccountId };
    await scope.reconciliation.insertSlice({
      ...next,
      runId: run.id,
      unit: "content_interactions",
      contentItemId: content.id,
      sequence: slice.sequence + 1,
      cursor: result.cursor,
      cursorIssuedAt: result.cursorIssuedAt,
      windowStart: slice.windowStart,
      windowEnd: slice.windowEnd,
      maxPages: slice.maxPages,
      createdAt: now,
    });
    await recordCoverage(scope, run, content.id, watermark?.syncedThrough ?? slice.windowStart, slice.windowEnd, availability, "in_progress", correlationOf(run), clock);
    if (!(await scope.reconciliation.finishSlice(slice.id, slice.attempt, { state: "CONTINUED", failureClass: null, retryNotBefore: null }, conflicts, now))) return { kind: "superseded" };
    // The continuation runs next (its cursor is short-lived), before any other content.
    await scope.reconciliation.enqueueSlice(next, run.correlationId, clock.newId(), now);
    return { kind: "finished", state: "CONTINUED", failureClass: null };
  }
  // Out of pages or continuations (or of run operations) before the provider's end: nothing is claimed complete.
  return closeSlice(scope, clock, run, slice, { state: "ABANDONED_BUDGET", failureClass: null, retryNotBefore: null }, "budget_exhausted", availability, now, conflicts);
}

/** The listing's eligible content (read_content AND read_interactions readable for its exact scope), deterministic. */
async function planContentSlices(scope: ReconciliationScope, clock: ReconciliationClock, run: ReconciliationRunRecord, slice: ReconciliationSliceRecord,
  pages: readonly ReadPage[], authority: Extract<Gate, { kind: "readable" }>, now: Date): Promise<number> {
  const room = Math.max(0, run.budget.contentItems - run.contentItemsUsed);
  let created = 0;
  for (const page of pages) {
    for (const item of page.items) {
      if (created >= room) return created;
      const dto = item as ContentDto;
      if (dto.availability !== "available") continue;
      const contentGate = await gate(scope, slice.connectedAccountId, "read_content", dto.contentKind, dto.reportedSource);
      const interactionsGate = await gate(scope, slice.connectedAccountId, "read_interactions", dto.contentKind, dto.reportedSource);
      // Another kind or source (a carousel, a reel, an organic post) is not a validated scope: neither stored nor read.
      if (contentGate.kind !== "readable" || interactionsGate.kind !== "readable") continue;
      const existing = await scope.ingestion.content.findByProviderId(authority.account.platform, dto.ref.id);
      let contentItemId: string;
      if (existing === undefined) {
        contentItemId = clock.newId();
        await scope.ingestion.content.insert({
          id: contentItemId,
          organizationId: run.organizationId,
          workspaceId: run.workspaceId,
          platform: authority.account.platform,
          connectedAccountId: authority.account.id,
          providerAssetId: authority.account.providerAssetId,
          providerContentId: dto.ref.id,
          contentKind: dto.contentKind,
          reportedSource: dto.reportedSource,
          observedAt: page.readAt,
        });
      } else {
        if (existing.connectedAccountId !== authority.account.id) continue;
        contentItemId = existing.id;
        await scope.ingestion.content.noteObserved(existing.id, page.readAt);
      }
      const watermark = await scope.reconciliation.watermark(slice.connectedAccountId, contentItemId);
      const overlapMs = run.budget.overlapSeconds * 1000;
      const windowStart = watermark?.syncedThrough === null || watermark?.syncedThrough === undefined
        ? new Date(RECONCILIATION_RUNTIME.windowFloor)
        : new Date(Math.max(new Date(RECONCILIATION_RUNTIME.windowFloor).getTime(), watermark.syncedThrough.getTime() - overlapMs));
      await scope.reconciliation.insertSlice({
        id: clock.newId(),
        organizationId: run.organizationId,
        workspaceId: run.workspaceId,
        runId: run.id,
        connectedAccountId: slice.connectedAccountId,
        unit: "content_interactions",
        contentItemId,
        sequence: 0,
        cursor: null,
        cursorIssuedAt: null,
        windowStart,
        // Every content of a run is read as of the run's start: an interaction created later belongs to the next run.
        windowEnd: run.startedAt ?? now,
        maxPages: run.budget.interactionPagesPerSlice,
        // Strictly increasing creation times keep the serial chain in listing order.
        createdAt: new Date(now.getTime() + created + 1),
      });
      created += 1;
    }
  }
  return created;
}

/** Maps, orders and ingests one slice's facts; a fact refused for authority is recorded and rolled back alone. */
async function ingestPages(scope: ReconciliationScope, clock: ReconciliationClock, run: ReconciliationRunRecord, slice: ReconciliationSliceRecord,
  content: NonNullable<ClaimedSlice["content"]>, pages: readonly ReadPage[], epoch: Date | null, authority: Extract<Gate, { kind: "readable" }>): Promise<number> {
  const facts: InteractionSourceFact[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      try {
        facts.push(interactionSourceFactFromDto(item as InteractionDto, {
          workspaceId: run.workspaceId as InteractionSourceFact["scope"]["workspaceId"],
          connectedAccountId: authority.account.id,
          providerAssetId: authority.account.providerAssetId,
          mechanism: "reconciliation",
          operation: "listInteractions",
          provenance: "listed",
          observedAt: instant(page.readAt),
          catalogRevision: authority.profile.catalogRevision,
          profileRevision: authority.profile.revision,
        }));
      } catch (error) {
        // A DTO the trusted mapping refuses is not a fact: it is skipped (never stored, never interpreted).
        if (!(error instanceof SourceFactRejectedError)) throw error;
      }
    }
  }
  const availability = availabilityInput(authority.availability);
  const correlationId = correlationOf(run);
  const epochInstant = epoch === null ? null : instant(epoch);
  let conflicts = 0;
  for (const fact of orderParentsFirst(facts)) {
    try {
      await scope.isolated((stores) => ingestInteractionFact(stores, clock, {
        fact,
        content: { contentKind: content.contentKind, reportedSource: content.reportedSource },
        availability,
        arrival: reconciliationArrival({ epoch: epochInstant, providerCreatedAt: fact.time.providerCreatedAt }),
        correlationId,
      }));
    } catch (error) {
      if (!(error instanceof IngestionAuthorityConflict)) throw error;
      const existing = await scope.ingestion.interactions.findByKey(fact.scope.platform, fact.identity.interactionId);
      for (const conflictClass of error.conflicts) {
        conflicts += 1;
        await scope.reconciliation.appendConflict({
          id: clock.newId(),
          organizationId: run.organizationId,
          workspaceId: run.workspaceId,
          connectedAccountId: slice.connectedAccountId,
          runId: run.id,
          sliceId: slice.id,
          interactionId: existing?.id ?? null,
          conflictClass,
          observedAt: new Date(fact.time.observedAt),
          correlationId: run.correlationId,
        });
      }
    }
  }
  return conflicts;
}

// ── closing slices and runs ─────────────────────────────────────────────────────────────────────────────────
/** Coverage of one content over [from, to), from the domain's slice result (nothing when the interval is empty). */
async function recordCoverage(scope: ReconciliationScope, run: ReconciliationRunRecord, contentItemId: string, from: Date, to: Date, availability: AvailabilityInput, result: SliceReadResult, correlationId: CorrelationId, clock: ReconciliationClock): Promise<void> {
  if (from >= to) return;
  const coverage = coverageForSlice({
    scope: { connectedAccountId: run.connectedAccountId, capability: "read_interactions", contentId: contentItemId },
    from: instant(from),
    to: instant(to),
    asOf: instant(clock.now()),
    availability,
    result,
  });
  await scope.ingestion.coverage.recordSlice({ organizationId: run.organizationId, workspaceId: run.workspaceId, contentItemId, coverage, correlationId, newId: clock.newId });
}

/** Before a content's epoch nothing is claimed: HISTORY_DEPTH_NOT_VALIDATED (no implied history, TL decision 6). */
async function recordHistoryGap(scope: ReconciliationScope, clock: ReconciliationClock, run: ReconciliationRunRecord, contentItemId: string, from: Date, epoch: Date, correlationId: CorrelationId): Promise<void> {
  if (from >= epoch) return;
  const intervals = historyBeforeFirstRead({ scope: { connectedAccountId: run.connectedAccountId, capability: "read_interactions", contentId: contentItemId }, from: instant(from), firstReadFrom: instant(epoch), asOf: instant(clock.now()) });
  await scope.ingestion.coverage.recordSlice({ organizationId: run.organizationId, workspaceId: run.workspaceId, contentItemId, coverage: { outcome: "NOT_VALIDATED", intervals }, correlationId, newId: clock.newId });
}

/** Closes one slice (RUNNING at its attempt, or still PENDING), with its coverage, then moves the chain on. */
async function closeSlice(scope: ReconciliationScope, clock: ReconciliationClock, run: ReconciliationRunRecord, slice: ReconciliationSliceRecord, finish: SliceFinish,
  coverage: SliceReadResult | null, availability: AvailabilityInput | null, now: Date, conflicts = 0): Promise<SliceOutcome> {
  const closed = slice.state === "PENDING"
    ? await scope.reconciliation.finishPendingSlice(slice.id, finish, now)
    : await scope.reconciliation.finishSlice(slice.id, slice.attempt, finish, conflicts, now);
  if (!closed) return { kind: "superseded" };
  if (slice.contentItemId !== null && coverage !== null && availability !== null) {
    const watermark = await scope.reconciliation.watermark(slice.connectedAccountId, slice.contentItemId);
    await recordCoverage(scope, run, slice.contentItemId, watermark?.syncedThrough ?? slice.windowStart, slice.windowEnd, availability, coverage, correlationOf(run), clock);
    if (finish.state !== "COMPLETED" && watermark !== undefined) await scope.reconciliation.recordTraversalFailure(slice.connectedAccountId, slice.contentItemId, finish.retryNotBefore, now);
  }
  await advanceChain(scope, clock, run, now);
  return { kind: "finished", state: finish.state, failureClass: finish.failureClass };
}

/** A gate refusal: one content scope fails alone; an account-level refusal stops the run. */
async function closeBlocked(scope: ReconciliationScope, clock: ReconciliationClock, run: ReconciliationRunRecord, slice: ReconciliationSliceRecord, blocked: Extract<Gate, { kind: "blocked" }>, now: Date): Promise<SliceOutcome> {
  const coverage: SliceReadResult | null = blocked.availability === null ? null : "not_attempted";
  if (!blocked.accountLevel) {
    return closeSlice(scope, clock, run, slice, { state: "FAILED_PERMANENT", failureClass: blocked.failureClass, retryNotBefore: null }, coverage, blocked.availability, now);
  }
  const finish: SliceFinish = { state: "FAILED_TRANSIENT", failureClass: blocked.failureClass, retryNotBefore: null };
  return stopRun(scope, clock, run, slice, finish, coverage, blocked.availability, now, finish);
}

/** Closes the slice and every PENDING slice of the run (never read: `not_attempted` coverage), then the run. */
async function stopRun(scope: ReconciliationScope, clock: ReconciliationClock, run: ReconciliationRunRecord, slice: ReconciliationSliceRecord, finish: SliceFinish,
  coverage: SliceReadResult | null, availability: AvailabilityInput | null, now: Date, pendingFinish: SliceFinish, conflicts = 0): Promise<SliceOutcome> {
  const closed = slice.state === "PENDING"
    ? await scope.reconciliation.finishPendingSlice(slice.id, finish, now)
    : await scope.reconciliation.finishSlice(slice.id, slice.attempt, finish, conflicts, now);
  if (!closed) return { kind: "superseded" };
  const correlationId = correlationOf(run);
  const pendingCoverage: SliceReadResult | null = pendingFinish.state === "ABANDONED_BUDGET" ? "budget_exhausted" : coverage === null ? null : "not_attempted";
  for (const target of [slice, ...(await scope.reconciliation.pendingSlices(run.id))]) {
    if (target.id !== slice.id) await scope.reconciliation.finishPendingSlice(target.id, pendingFinish, now);
    const result = target.id === slice.id ? coverage : pendingCoverage;
    if (target.contentItemId === null || result === null) continue;
    const watermark = await scope.reconciliation.watermark(target.connectedAccountId, target.contentItemId);
    const effective = availability ?? (result === "budget_exhausted" ? await currentAvailability(scope, target) : null);
    if (effective === null) continue;
    await recordCoverage(scope, run, target.contentItemId, watermark?.syncedThrough ?? target.windowStart, target.windowEnd, effective, result, correlationId, clock);
    if (watermark !== undefined) await scope.reconciliation.recordTraversalFailure(target.connectedAccountId, target.contentItemId, pendingFinish.retryNotBefore, now);
  }
  await advanceChain(scope, clock, run, now);
  return { kind: "finished", state: finish.state, failureClass: finish.failureClass };
}

/** The current availability of a slice's content scope (for budget coverage of slices never read). */
async function currentAvailability(scope: ReconciliationScope, slice: ReconciliationSliceRecord): Promise<AvailabilityInput | null> {
  if (slice.contentItemId === null) return null;
  const content = await scope.ingestion.content.findById(slice.contentItemId);
  if (content === undefined) return null;
  const checked = await gate(scope, slice.connectedAccountId, "read_interactions", content.contentKind, content.reportedSource);
  return checked.kind === "readable" ? availabilityInput(checked.availability) : checked.availability;
}

/** Dispatches the run's next PENDING slice, or finishes the run when none is left. */
async function advanceChain(scope: ReconciliationScope, clock: ReconciliationClock, run: ReconciliationRunRecord, now: Date): Promise<void> {
  const next = await scope.reconciliation.nextPendingSlice(run.id);
  if (next !== undefined) {
    await scope.reconciliation.enqueueSlice(next, run.correlationId, clock.newId(), now);
    return;
  }
  const states = await scope.reconciliation.sliceStates(run.id);
  if (states.some((slice) => slice.state === "PENDING" || slice.state === "RUNNING")) return;
  const listing = states.find((slice) => slice.unit === "content_listing");
  if (listing !== undefined && listing.state !== "COMPLETED") {
    await scope.reconciliation.finishRun(run.id, listing.state === "ABANDONED_BUDGET" ? "PARTIAL" : "FAILED", listing.state === "ABANDONED_BUDGET" ? null : "listing_failed", now);
    return;
  }
  const complete = states.every((slice) => slice.state === "COMPLETED" || slice.state === "CONTINUED");
  await scope.reconciliation.finishRun(run.id, complete ? "COMPLETED" : "PARTIAL", null, now);
}

// ── terminal consumer (MAIN) ────────────────────────────────────────────────────────────────────────────────
export type ObservedOutcome =
  | { readonly kind: "accepted_terminal"; readonly change: string; readonly arrival: string }
  | { readonly kind: "rejected"; readonly reason: "observed_event_not_found" | "observed_event_mismatch" };

/**
 * The H6 terminal boundary of `interactions.observed`: proves the IDs-only payload names one canonical event of the
 * bound workspace, then finishes. It reads identifiers only — never text, never a provider, a credential, an AI model or
 * a workflow state — and writes nothing. Later steps extend from this event without changing its producer.
 */
export async function acceptObservedInteraction(
  stores: Pick<IngestionStores, "events" | "interactions">,
  input: { readonly eventId: string; readonly interactionId: string; readonly conversationId: string | null; readonly sourceTextVersionId: string | null },
): Promise<ObservedOutcome> {
  const event = await stores.events.authority(input.eventId);
  if (event === undefined) return { kind: "rejected", reason: "observed_event_not_found" };
  if (event.interactionId !== input.interactionId || event.conversationId !== input.conversationId || event.sourceTextVersionId !== input.sourceTextVersionId) {
    return { kind: "rejected", reason: "observed_event_mismatch" };
  }
  if (!(await stores.interactions.exists(event.interactionId))) return { kind: "rejected", reason: "observed_event_not_found" };
  return { kind: "accepted_terminal", change: event.change, arrival: event.arrival };
}
