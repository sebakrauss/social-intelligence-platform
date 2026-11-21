/**
 * The activity projection and the objective auto-reopen (WORKFLOW-WF-2B; WF-1 §8; PD decision D2: same transaction,
 * through module interfaces). Runs inside the CALLER's workspace job transaction — the ingestion change that made the
 * members join — so the queue row commits or rolls back with the interaction write.
 *
 * Order (WF-1 §8.2, measured): LOCK the work item, THEN recompute the activity from the members in a new statement, THEN
 * write. A concurrent ingestion of another member of the same conversation waits on the lock and recomputes after this
 * one commits, so neither member is lost; `greatest(current, new)` is not used because an activity may legitimately fall
 * (a placeholder completed with an older platform time).
 *
 * Idempotent: a retried ingestion that changes nothing never reaches here (no member joins), and a repeated call with no
 * new member only re-derives the same activity. Rebuild is the same call with no joined member (`rebuildWorkItem`).
 */
import type { CorrelationId } from "@/domain/correlation";
import { decideMembersJoined, type JoinedMember } from "../domain/work-item";
import type { ConversationActivitySource, WorkflowProjectionStore } from "./ports";

export interface ProjectionClock {
  readonly newId: () => string;
  readonly now: () => Date;
}

export interface MembersJoinedInput {
  readonly conversationId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  /** The members that joined the conversation in this change (the node, and a late root's attached descendants). */
  readonly joined: readonly JoinedMember[];
  readonly correlationId: CorrelationId;
}

export type ProjectionOutcome = { readonly kind: "unchanged" } | { readonly kind: "projected"; readonly created: boolean; readonly reopened: boolean; readonly versionAdvanced: boolean };

export async function projectMembersJoined(store: WorkflowProjectionStore, activity: ConversationActivitySource, clock: ProjectionClock, input: MembersJoinedInput): Promise<ProjectionOutcome> {
  const now = clock.now();
  const item = await store.ensureAndLock({ conversationId: input.conversationId, organizationId: input.organizationId, workspaceId: input.workspaceId, now, correlationId: input.correlationId, eventId: clock.newId() });
  // After the lock: every member a concurrent, already committed change added is visible to this statement.
  const latest = (await activity.latestActivity(input.conversationId)) ?? item.latestActivityAt;
  // The members that CREATE a work item are its initial content (version 1), not a join into an existing one.
  const decision = item.created ? decideMembersJoined(item.state, []) : decideMembersJoined(item.state, input.joined);
  if (!item.created && !decision.audienceJoined && latest.getTime() === item.latestActivityAt.getTime()) return { kind: "unchanged" };
  await store.apply({ item, latestActivityAt: latest, decision, now, correlationId: input.correlationId, eventId: clock.newId() });
  return { kind: "projected", created: item.created, reopened: decision.reopen, versionAdvanced: decision.audienceJoined };
}

/**
 * Rebuild / reconciliation of one conversation's work item: created if missing, activity re-derived from the members.
 * No member joins, so it never reopens and never advances the version.
 */
export function rebuildWorkItem(store: WorkflowProjectionStore, activity: ConversationActivitySource, clock: ProjectionClock, input: Omit<MembersJoinedInput, "joined">): Promise<ProjectionOutcome> {
  return projectMembersJoined(store, activity, clock, { ...input, joined: [] });
}
