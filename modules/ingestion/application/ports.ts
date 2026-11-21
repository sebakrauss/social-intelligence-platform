/**
 * What canonical ingestion needs from its transaction (Step H6-B): the owning modules' persistence, all bound to ONE
 * workspace-scoped job transaction. Composed by server/persistence/ingestion.ts; each store is its owner's published port
 * (ingestion never touches their tables directly).
 */
import type { CorrelationId } from "@/domain/correlation";
import type { ContentItemStore } from "@/modules/content";
import type { ConversationStore } from "@/modules/conversations";
import type { CoverageStore } from "@/modules/coverage";
import type { InteractionStore } from "@/modules/interactions";
import type { IngestionEventRecord } from "../domain/events";
import type { ObservedEventAuthority } from "./reconciliation-ports";

export interface IngestionEventStore {
  /** Writes the event record and its IDs-only outbox row (`outboxId`: a fresh UUID for the outbox row). */
  emit(record: IngestionEventRecord, organizationId: string, now: Date, outboxId: string): Promise<void>;
  /** The event's identifiers and closed facts (Step H6-C3, the terminal consumer): never text. */
  authority(eventId: string): Promise<ObservedEventAuthority | undefined>;
}

/** One member that joined a conversation in this change: identity, author role and whether it is observed. */
export interface ConversationMember {
  readonly interactionId: string;
  readonly authorRole: string | null;
  readonly observed: boolean;
}

/**
 * WORKFLOW-WF-2B (PD decision D2: same transaction, through module interfaces): told, inside THIS transaction, which
 * members joined a conversation — a new interaction, a completed placeholder, or a late root's attached descendants. The
 * workflow layer (L3) implements it and is composed in by server/persistence; ingestion (L1) never imports it. It
 * receives no `arrival`: whether a reply is new to the conversation is decided by the join itself, never by the
 * realtime / reconciliation / backfill label (WF-2A §7).
 */
export interface ConversationMembershipSink {
  membersJoined(input: { readonly conversationId: string; readonly organizationId: string; readonly workspaceId: string; readonly joined: readonly ConversationMember[]; readonly correlationId: CorrelationId }): Promise<void>;
}

export interface IngestionStores {
  /** The bound workspace's organization (the transaction's scope). */
  readonly organizationId: () => Promise<string>;
  readonly content: ContentItemStore;
  readonly interactions: InteractionStore;
  readonly conversations: ConversationStore;
  readonly events: IngestionEventStore;
  readonly coverage: CoverageStore;
  readonly workflow: ConversationMembershipSink;
}

export interface IngestionClock {
  readonly newId: () => string;
  readonly now: () => Date;
}
