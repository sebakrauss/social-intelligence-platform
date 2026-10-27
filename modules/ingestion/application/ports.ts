/**
 * What canonical ingestion needs from its transaction (Step H6-B): the owning modules' persistence, all bound to ONE
 * workspace-scoped job transaction. Composed by server/persistence/ingestion.ts; each store is its owner's published port
 * (ingestion never touches their tables directly).
 */
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

export interface IngestionStores {
  /** The bound workspace's organization (the transaction's scope). */
  readonly organizationId: () => Promise<string>;
  readonly content: ContentItemStore;
  readonly interactions: InteractionStore;
  readonly conversations: ConversationStore;
  readonly events: IngestionEventStore;
  readonly coverage: CoverageStore;
}

export interface IngestionClock {
  readonly newId: () => string;
  readonly now: () => Date;
}
