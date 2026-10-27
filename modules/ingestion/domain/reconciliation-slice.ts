/**
 * Reconciliation slice (Step H6-A1; TA §14.2, §19.6, §47; design H6-A0). Pure. Reconciliation (pull) is H6's first
 * ingestion primitive: webhook = signal, provider re-read = authority, reconciliation = completeness.
 *
 * A slice is one bounded unit of work for one workspace and connected account, in exactly one capability scope:
 *   content_listing        listContent over the account's window (finds content items to read)
 *   content_interactions   listInteractions of ONE content item over the window
 *
 * Rules:
 *   - Bounded: at most `budget.maxPages` provider pages per slice (hard cap SLICE_MAX_PAGES). When the budget is
 *     exhausted and the provider says there is more, the slice ends and a CONTINUATION slice is planned — never an
 *     unbounded loop inside one job.
 *   - No early termination on ordering: provider ordering is not validated, so items outside the window never end a
 *     slice; only the provider's end of pages (or the budget) does.
 *   - A provider cursor is RESUMABLE-SLICE STATE ONLY: opaque, bounded, short-lived (SLICE_CURSOR_MAX_AGE_MS). It is
 *     never a long-term watermark or historical authority; an expired cursor restarts the window (idempotent upserts
 *     make the repeat harmless).
 *   - The watermark is time-based (the latest provider creation time seen); the next window starts at the watermark
 *     minus the overlap, so late or out-of-order items are seen again (and deduplicated by canonical identity).
 * Cadence is NOT decided here (TA-Q-22, TA-Q-32); the first trigger is an explicit Owner/Admin action (TL D-C1).
 *
 * Step H6-C1 (TL D-C3, D-C4): the approved runtime DEFAULTS (RECONCILIATION_DEFAULTS) are separate from the hard
 * CEILINGS above — a run may use less than a ceiling, never more. Defaults are budgets, not claims about how much
 * history the provider holds. The overlap (24 h) only re-reads recent items for deduplication; it is never coverage.
 * Each persistent slice row has its own id, and its dispatch key is derived from that id alone
 * (`ingestion.reconcile_slice:{slice id}`): a continuation is a NEW slice with a new id, so two runs over the same
 * window can never collide on a key (the H6-A1 window-derived key is superseded; it could also exceed 128 characters).
 */
import { parseCorrelationId, type CorrelationId } from "@/domain/correlation";
import { isUuid, type WorkspaceId } from "@/domain/ids";
import { compareInstants, parseInstant, type Instant } from "@/domain/instant";
import type { PlatformKey } from "@/domain/platforms";

/** Hard cap on provider pages one slice may read. */
export const SLICE_MAX_PAGES = 10;
/** A provider cursor older than this is not resumed (restart the window instead). */
export const SLICE_CURSOR_MAX_AGE_MS = 15 * 60 * 1000;
/** Mirrors the provider contract's PageCursor bound (pinned by test). */
export const SLICE_CURSOR_MAX_LENGTH = 2048;
/** Upper bound of the overlap re-read before a watermark. */
export const SLICE_OVERLAP_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** Approved runtime defaults (TL D-C3, D-C4); each stays within its hard ceiling (pinned by test). */
export const RECONCILIATION_DEFAULTS = Object.freeze({
  /** Provider pages per content-listing slice. */
  listingPagesPerSlice: 1,
  /** Provider pages per content-interactions slice. */
  interactionPagesPerSlice: 5,
  /** Continuation slices after the first, per content and run (≤ 15 interaction pages per content and run). */
  continuationsPerContent: 2,
  /** Content items whose interactions one run reads. */
  contentItemsPerRun: 10,
  /** Open reconciliation runs per connected account. */
  openRunsPerAccount: 1,
  /** Re-read margin before the watermark (deduplication only; never a coverage claim). */
  overlapMs: 24 * 60 * 60 * 1000,
});

/** Interaction pages one content may consume in one run: the first slice plus its continuations. */
export const maxInteractionPagesPerContent = (defaults: typeof RECONCILIATION_DEFAULTS = RECONCILIATION_DEFAULTS): number =>
  defaults.interactionPagesPerSlice * (1 + defaults.continuationsPerContent);

/** Dispatch-key prefix of one persistent slice row. */
export const RECONCILE_SLICE_TOPIC = "ingestion.reconcile_slice" as const;

export const SLICE_UNITS = ["content_listing", "content_interactions"] as const;
export type SliceUnit = (typeof SLICE_UNITS)[number];

export interface SliceCapabilityScope {
  readonly capability: "read_content" | "read_interactions";
  readonly contentKind: "post";
  readonly source: "unknown";
}

export interface ProviderSliceCursor {
  /** Opaque provider continuation, exactly as the provider contract returned it. Never parsed here. */
  readonly value: string;
  readonly issuedAt: Instant;
}

export interface ReconciliationSlice {
  /** The persistent slice row's own id (a continuation gets a new one). */
  readonly sliceId: string;
  readonly workspaceId: WorkspaceId;
  readonly connectedAccountId: string;
  readonly platform: PlatformKey;
  readonly unit: SliceUnit;
  readonly scope: SliceCapabilityScope;
  /** For content_interactions: the canonical content row (internal UUID); null for content_listing. */
  readonly contentRowId: string | null;
  readonly window: { readonly from: Instant; readonly to: Instant };
  readonly watermark: Instant | null;
  readonly overlapMs: number;
  readonly cursor: ProviderSliceCursor | null;
  readonly budget: { readonly maxPages: number; readonly pagesRead: number };
  /** 0 for the first slice of a window; +1 for each continuation. */
  readonly sequence: number;
  readonly attempt: number;
  readonly correlationId: CorrelationId;
}

export type SliceViolation = "IDENTITY_INVALID" | "UNIT_SCOPE_INCOHERENT" | "WINDOW_INVALID" | "OVERLAP_INVALID" | "CURSOR_INVALID" | "BUDGET_INVALID" | "SEQUENCE_INVALID";

export function sliceViolations(slice: ReconciliationSlice): readonly SliceViolation[] {
  const out: SliceViolation[] = [];
  if (!isUuid(slice.sliceId) || !isUuid(slice.workspaceId) || !isUuid(slice.connectedAccountId) || parseCorrelationId(slice.correlationId) === undefined) out.push("IDENTITY_INVALID");
  const listing = slice.unit === "content_listing";
  if ((listing ? slice.scope.capability !== "read_content" || slice.contentRowId !== null : slice.scope.capability !== "read_interactions" || !isUuid(slice.contentRowId))) out.push("UNIT_SCOPE_INCOHERENT");
  if (parseInstant(slice.window.from) === undefined || parseInstant(slice.window.to) === undefined || compareInstants(slice.window.from, slice.window.to) >= 0
    || (slice.watermark !== null && parseInstant(slice.watermark) === undefined)) out.push("WINDOW_INVALID");
  if (!Number.isInteger(slice.overlapMs) || slice.overlapMs < 0 || slice.overlapMs > SLICE_OVERLAP_MAX_MS) out.push("OVERLAP_INVALID");
  if (slice.cursor !== null && (slice.cursor.value.length === 0 || slice.cursor.value.length > SLICE_CURSOR_MAX_LENGTH || parseInstant(slice.cursor.issuedAt) === undefined)) out.push("CURSOR_INVALID");
  const { maxPages, pagesRead } = slice.budget;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > SLICE_MAX_PAGES || !Number.isInteger(pagesRead) || pagesRead < 0 || pagesRead > maxPages) out.push("BUDGET_INVALID");
  if (!Number.isInteger(slice.sequence) || slice.sequence < 0 || !Number.isInteger(slice.attempt) || slice.attempt < 1) out.push("SEQUENCE_INVALID");
  return out;
}

/** Whether a stored cursor may still be resumed at `now` (otherwise the window restarts from its beginning). */
export function cursorResumable(cursor: ProviderSliceCursor, now: Instant): boolean {
  const age = Date.parse(now) - Date.parse(cursor.issuedAt);
  return age >= 0 && age <= SLICE_CURSOR_MAX_AGE_MS;
}

export interface SlicePage {
  readonly next: { readonly kind: "more"; readonly cursor: string } | { readonly kind: "end" };
  /** The latest provider creation time among this page's items, if any (ordering is not assumed). */
  readonly latestCreatedAt: Instant | null;
  readonly readAt: Instant;
}

export type SliceStep =
  | { readonly kind: "continue"; readonly slice: ReconciliationSlice }
  | { readonly kind: "continuation"; readonly next: ReconciliationSlice }
  | { readonly kind: "complete"; readonly watermark: Instant | null };

const later = (a: Instant | null, b: Instant | null): Instant | null => (a === null ? b : b === null ? a : compareInstants(a, b) >= 0 ? a : b);

/**
 * Account for one provider page. Ends only on the provider's end of pages (complete) or on the budget (a new bounded
 * continuation slice with the cursor, under `nextSliceId` — the new persistent row's id). Items outside the window
 * never end a slice.
 */
export function advanceSlice(slice: ReconciliationSlice, page: SlicePage, nextSliceId: string): SliceStep {
  if (sliceViolations(slice).length > 0) throw new TypeError("slice_invalid");
  if (!isUuid(nextSliceId) || nextSliceId === slice.sliceId) throw new TypeError("slice_next_id_invalid");
  if (slice.budget.pagesRead >= slice.budget.maxPages) throw new TypeError("slice_budget_exhausted");
  const watermark = later(slice.watermark, page.latestCreatedAt);
  const pagesRead = slice.budget.pagesRead + 1;
  if (page.next.kind === "end") return { kind: "complete", watermark };
  if (page.next.cursor.length === 0 || page.next.cursor.length > SLICE_CURSOR_MAX_LENGTH) throw new TypeError("slice_cursor_invalid");
  const cursor = Object.freeze({ value: page.next.cursor, issuedAt: page.readAt });
  if (pagesRead < slice.budget.maxPages) return { kind: "continue", slice: Object.freeze({ ...slice, watermark, cursor, budget: Object.freeze({ ...slice.budget, pagesRead }) }) };
  return { kind: "continuation", next: Object.freeze({ ...slice, sliceId: nextSliceId, watermark, cursor, budget: Object.freeze({ maxPages: slice.budget.maxPages, pagesRead: 0 }), sequence: slice.sequence + 1, attempt: 1 }) };
}

/** The next window's start: the watermark minus the overlap, never before the previous window's start. */
export function nextWindowStart(previous: { readonly from: Instant }, watermark: Instant | null, overlapMs: number): Instant {
  if (watermark === null) return previous.from;
  const start = new Date(Math.max(Date.parse(previous.from), Date.parse(watermark) - overlapMs)).toISOString();
  return start as Instant;
}

/** The slice's domain dispatch key (outbox dispatch_key format): its persistent row id alone, ≤ 128 characters. */
export function sliceDispatchKey(slice: Pick<ReconciliationSlice, "sliceId">): string {
  if (!isUuid(slice.sliceId)) throw new TypeError("slice_id_invalid");
  return `${RECONCILE_SLICE_TOPIC}:${slice.sliceId}`;
}
