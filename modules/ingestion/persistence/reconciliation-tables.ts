/**
 * Drizzle mappings of the reconciliation runtime tables (Step H6-C2; db/migrations/0018 — the SQL is the source of
 * truth). Mappings only: the stores that write them, and every state transition, are H6-C3's. A slice's cursor is
 * opaque provider continuation state; it never leaves this table (no outbox row, job payload or log carries it).
 */
import { integer, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ingestion = pgSchema("ingestion");
const at = (name: string) => timestamp(name, { withTimezone: true });

export const reconciliationRuns = ingestion.table("reconciliation_runs", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  connectedAccountId: uuid("connected_account_id").notNull(),
  state: text("state").notNull(),
  initiatorType: text("initiator_type").notNull(),
  initiatorUserId: uuid("initiator_user_id"),
  correlationId: text("correlation_id").notNull(),
  requestedAt: at("requested_at").notNull(),
  startedAt: at("started_at"),
  completedAt: at("completed_at"),
  budgetListingPagesPerSlice: integer("budget_listing_pages_per_slice").notNull(),
  budgetInteractionPagesPerSlice: integer("budget_interaction_pages_per_slice").notNull(),
  budgetContinuationsPerContent: integer("budget_continuations_per_content").notNull(),
  budgetInteractionPagesPerContent: integer("budget_interaction_pages_per_content").notNull(),
  budgetContentItems: integer("budget_content_items").notNull(),
  budgetOverlapSeconds: integer("budget_overlap_seconds").notNull(),
  /** 0019: the run's immutable provider-operation budget. */
  maxOperations: integer("max_operations").notNull(),
  // Step H6-F2 (0022): 'account' (every manual run) | 'relist' (webhook-signal runs); immutable, chosen at request.
  plan: text("plan").notNull().default("account"),
  operationsUsed: integer("operations_used").notNull(),
  pagesUsed: integer("pages_used").notNull(),
  contentItemsUsed: integer("content_items_used").notNull(),
  failureClass: text("failure_class"),
  createdAt: at("created_at").notNull(),
  updatedAt: at("updated_at").notNull(),
});

export const reconciliationSlices = ingestion.table("reconciliation_slices", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  reconciliationRunId: uuid("reconciliation_run_id").notNull(),
  connectedAccountId: uuid("connected_account_id").notNull(),
  unit: text("unit").notNull(),
  contentItemId: uuid("content_item_id"),
  sequence: integer("sequence").notNull(),
  state: text("state").notNull(),
  attempt: integer("attempt").notNull(),
  leasedUntil: at("leased_until"),
  cursor: text("cursor"),
  cursorIssuedAt: at("cursor_issued_at"),
  windowStart: at("window_start").notNull(),
  windowEnd: at("window_end").notNull(),
  maxPages: integer("max_pages").notNull(),
  pagesRead: integer("pages_read").notNull(),
  operationsUsed: integer("operations_used").notNull(),
  conflictCount: integer("conflict_count").notNull(),
  failureClass: text("failure_class"),
  retryNotBefore: at("retry_not_before"),
  completedAt: at("completed_at"),
  createdAt: at("created_at").notNull(),
  updatedAt: at("updated_at").notNull(),
});

export const reconciliationWatermarks = ingestion.table("reconciliation_watermarks", {
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  connectedAccountId: uuid("connected_account_id").notNull(),
  contentItemId: uuid("content_item_id").notNull(),
  capability: text("capability").notNull(),
  contentKind: text("content_kind").notNull(),
  source: text("source").notNull(),
  epochAt: at("epoch_at").notNull(),
  syncedThrough: at("synced_through"),
  latestCreatedAt: at("latest_created_at"),
  lastReconciliationRunId: uuid("last_reconciliation_run_id"),
  consecutiveFailures: integer("consecutive_failures").notNull(),
  retryNotBefore: at("retry_not_before"),
  createdAt: at("created_at").notNull(),
  updatedAt: at("updated_at").notNull(),
});

/** Append-only: identifiers and closed classes only (no text, payload, label, provider id or URL). */
export const authorityConflicts = ingestion.table("authority_conflicts", {
  id: uuid("id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  connectedAccountId: uuid("connected_account_id").notNull(),
  reconciliationRunId: uuid("reconciliation_run_id"),
  reconciliationSliceId: uuid("reconciliation_slice_id"),
  interactionId: uuid("interaction_id"),
  conflictClass: text("conflict_class").notNull(),
  observedAt: at("observed_at").notNull(),
  correlationId: text("correlation_id").notNull(),
  createdAt: at("created_at").notNull(),
});
