/**
 * Work items: the shared Workflow core (WORKFLOW-WF-2B; PD D-57/D-59, ADR-66/67, Model §10). Pure — no I/O.
 *
 * A work item is the workflow subject's operational state: Open or Done (with an optional resolution), who changed it
 * and when, and an optimistic version. For Comments, the subject is a conversation and the work item IS that
 * conversation (same id), so the list position (activity, id) is the conversation's own.
 *
 * Two kinds of change exist, and only two:
 *   manual       a person marks Done (optionally with a resolution) or reopens — always against the version they saw;
 *   auto-reopen  D1: a Done conversation reopens when a genuinely NEW AUDIENCE member joins it. Event-based, not
 *                time-based: a member is "new" when it joins the conversation in THIS ingestion change (a first
 *                observation, a placeholder completed, or a reply attached with a late root). Nothing else reopens —
 *                not a duplicate, an edit, a visibility or availability change, the account's own reply, or a placeholder.
 *                The ingestion `arrival` (realtime / reconciliation / backfill) is deliberately NOT an input: it is not
 *                a reliable historical-import signal (WF-2A §7), and the conservative bias here is to surface a reply.
 * There is no automatic Done (the database refuses one from the job runtime).
 */
import type { WorkItemResolution, WorkItemState } from "@/domain/workflow";

export { WORK_ITEM_RESOLUTIONS, WORK_ITEM_STATES, isWorkItemResolution, isWorkItemState, type WorkItemResolution, type WorkItemState } from "@/domain/workflow";

/** Typed subjects (ADR-66). Comments only; a Messages gate adds its own kind with its own reference and policy. */
export const WORK_ITEM_SUBJECT_KINDS = ["comment_conversation"] as const;
export type WorkItemSubjectKind = (typeof WORK_ITEM_SUBJECT_KINDS)[number];

/** Who changed the state last. */
export const STATE_CHANGE_INITIATORS = ["system_ingestion", "migration", "user", "system_auto_reopen"] as const;
export type StateChangeInitiator = (typeof STATE_CHANGE_INITIATORS)[number];

/** One member that joined a conversation in the current ingestion change, as the interactions owner describes it. */
export interface JoinedMember {
  readonly interactionId: string;
  /** account_identity · user · unknown; null for an unobserved placeholder. */
  readonly authorRole: string | null;
  readonly observed: boolean;
}

/** An audience member: observed, and not written by the account itself (an unknown author counts as audience). */
export function isAudienceMember(member: JoinedMember): boolean {
  return member.observed && (member.authorRole === "user" || member.authorRole === "unknown");
}

export interface ProjectionDecision {
  /** A new audience member joined: the version advances (a Done decided on an older screen becomes stale). */
  readonly audienceJoined: boolean;
  /** Done → Open (D1). */
  readonly reopen: boolean;
  /** The member that causes the reopen (the first audience member, in the order given). */
  readonly cause: string | null;
}

/** D1 — what the members that just joined do to the work item's state. */
export function decideMembersJoined(state: WorkItemState, joined: readonly JoinedMember[]): ProjectionDecision {
  const audience = joined.find(isAudienceMember);
  return { audienceJoined: audience !== undefined, reopen: audience !== undefined && state === "DONE", cause: audience === undefined ? null : audience.interactionId };
}

/** A manual change a person asks for. A resolution exists only with Done. */
export type ManualChange = { readonly to: "DONE"; readonly resolution: WorkItemResolution | null } | { readonly to: "OPEN" };

/** The outcome of a manual change, as the database boundary reports it. */
export type ManualChangeOutcome = "changed" | "unchanged" | "stale";

/** The list views of the queue: one state, or every state. */
export const QUEUE_VIEWS = ["open", "done", "all"] as const;
export type QueueView = (typeof QUEUE_VIEWS)[number];

export const stateOfView = (view: QueueView): WorkItemState | null => (view === "open" ? "OPEN" : view === "done" ? "DONE" : null);
