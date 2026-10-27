/**
 * The canonical downstream event `interactions.observed` (Step H6-A1; TA §14.1 step 9, §19.3–§19.4). Pure.
 *
 * Emitted once per canonical change ingestion commits, in the same transaction as the state, history and audit. It is
 * where H6 ends: future understanding, alerts, protocols, drafting and approval consume it; none is built here.
 *
 * Two layers, because the outbox carries identifiers only (its `subject_ids` admit UUID values exclusively):
 *   IngestionEventRecord   the append-only record persistence writes (H6-B), holding the closed facts of the change
 *                          — change, arrival, observed time, correlation, initiator — and the ids it concerns.
 *   outbox row             topic + subject ids (the event record and the objects it names) + correlation + system
 *                          initiator + a deterministic dispatch key. No text, author, handle, URL or label: a consumer
 *                          re-reads everything from Postgres in its tenant scope.
 *
 * `arrival` keeps backfill distinguishable from realtime and reconciliation, because automation is forward-only
 * (PD D-51, S21): an interaction imported by backfill must never be treated as newly arrived.
 */
import { parseCorrelationId, type CorrelationId } from "@/domain/correlation";
import { isUuid, type WorkspaceId } from "@/domain/ids";
import { parseInstant, type Instant } from "@/domain/instant";

/** Matches the outbox topic format (pinned by test). */
export const INTERACTIONS_OBSERVED_TOPIC = "interactions.observed";

export const OBSERVED_CHANGES = ["created", "text_changed", "state_changed", "removed_at_source"] as const;
export type ObservedChange = (typeof OBSERVED_CHANGES)[number];

export const OBSERVED_ARRIVALS = ["realtime", "reconciliation", "backfill"] as const;
export type ObservedArrival = (typeof OBSERVED_ARRIVALS)[number];

export interface IngestionEventRecord {
  /** The event record's own internal identity (UUID). */
  readonly eventId: string;
  readonly workspaceId: WorkspaceId;
  /** Internal canonical identities (UUIDs), never provider ids. */
  readonly interactionId: string;
  readonly conversationId: string | null;
  readonly sourceTextVersionId: string | null;
  readonly change: ObservedChange;
  readonly arrival: ObservedArrival;
  readonly observedAt: Instant;
  readonly correlationId: CorrelationId;
  readonly initiator: "system";
}

export interface InteractionsObservedOutboxRow {
  readonly topic: typeof INTERACTIONS_OBSERVED_TOPIC;
  readonly workspaceId: WorkspaceId;
  readonly subjectIds: Readonly<Record<string, string>>;
  readonly correlationId: CorrelationId;
  readonly initiatorType: "system";
  readonly dispatchKey: string;
}

const isChange = (value: unknown): value is ObservedChange => typeof value === "string" && (OBSERVED_CHANGES as readonly string[]).includes(value);
const isArrival = (value: unknown): value is ObservedArrival => typeof value === "string" && (OBSERVED_ARRIVALS as readonly string[]).includes(value);

/** Fail closed on an incoherent record (a non-UUID id, an unknown change or arrival, a text-version-less created). */
export function ingestionEventViolations(record: IngestionEventRecord): readonly string[] {
  const out: string[] = [];
  if (![record.eventId, record.workspaceId, record.interactionId].every(isUuid)) out.push("ID_INVALID");
  if (record.conversationId !== null && !isUuid(record.conversationId)) out.push("ID_INVALID");
  if (record.sourceTextVersionId !== null && !isUuid(record.sourceTextVersionId)) out.push("ID_INVALID");
  if (!isChange(record.change) || !isArrival(record.arrival)) out.push("ENUM_INVALID");
  if (parseInstant(record.observedAt) === undefined || parseCorrelationId(record.correlationId) === undefined) out.push("METADATA_INVALID");
  if (record.change === "text_changed" && record.sourceTextVersionId === null) out.push("TEXT_VERSION_MISSING");
  return [...new Set(out)];
}

/** The IDs-only outbox row for an event record. Takes no text and returns UUID values only. */
export function interactionsObservedOutboxRow(record: IngestionEventRecord): InteractionsObservedOutboxRow {
  if (ingestionEventViolations(record).length > 0) throw new TypeError("ingestion_event_invalid");
  const subjectIds: Record<string, string> = { ingestion_event_id: record.eventId, interaction_id: record.interactionId };
  if (record.conversationId !== null) subjectIds["conversation_id"] = record.conversationId;
  if (record.sourceTextVersionId !== null) subjectIds["source_text_version_id"] = record.sourceTextVersionId;
  return Object.freeze({
    topic: INTERACTIONS_OBSERVED_TOPIC,
    workspaceId: record.workspaceId,
    subjectIds: Object.freeze(subjectIds),
    correlationId: record.correlationId,
    initiatorType: "system" as const,
    dispatchKey: `${INTERACTIONS_OBSERVED_TOPIC}:${record.eventId}`,
  });
}
