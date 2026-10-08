/**
 * PostgreSQL outbox writer (system.outbox). Appends inside the caller's scoped transaction, so the row
 * commits or rolls back with the state change it follows up. Web users and workers can append but not
 * read; only the system role reads delivery metadata (Step 3 relay).
 */
import { integer, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createOutboxMessage, type OutboxMessage, type OutboxWriter } from "@/platform/outbox/message";
import type { DatabaseTransaction } from "./scopes";

const system = pgSchema("system");

/**
 * The semantic execution plane a delivery is bound to (0011) — never a vendor project identifier. Bound only by the
 * delivery claim; producers always insert NULL (unbound).
 */
export const OUTBOX_EXECUTION_PLANES = ["main", "integration"] as const;
export type OutboxExecutionPlane = (typeof OUTBOX_EXECUTION_PLANES)[number];

export const outbox = system.table("outbox", {
  id: uuid("id").primaryKey(),
  topic: text("topic").notNull(),
  organizationId: uuid("organization_id"),
  workspaceId: uuid("workspace_id"),
  subjectIds: jsonb("subject_ids").$type<Readonly<Record<string, string>>>().notNull(),
  correlationId: text("correlation_id").notNull(),
  initiatorType: text("initiator_type").notNull(),
  initiatorUserId: uuid("initiator_user_id"),
  dispatchKey: text("dispatch_key").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  // Delivery state (0005, R7): written only by the system relay and sweepers.
  dispatchAttempts: integer("dispatch_attempts").notNull().default(0),
  nextDispatchAt: timestamp("next_dispatch_at", { withTimezone: true }),
  claimedUntil: timestamp("claimed_until", { withTimezone: true }),
  recoveryCount: integer("recovery_count").notNull().default(0),
  runOutcome: text("run_outcome"),
  runOutcomeAt: timestamp("run_outcome_at", { withTimezone: true }),
  lastFailureClass: text("last_failure_class"),
  sloBreachedAt: timestamp("slo_breached_at", { withTimezone: true }),
  runDiagnostic: text("run_diagnostic"),
  runDiagnosticAt: timestamp("run_diagnostic_at", { withTimezone: true }),
  // Execution plane (0011): NULL until the delivery claim binds it, then immutable (DB guard). Never written here.
  executionPlane: text("execution_plane").$type<OutboxExecutionPlane | null>(),
});

/** Every vendor run dispatched for an outbox row; the latest is current (R7 diagnosability). */
export const outboxRuns = system.table(
  "outbox_runs",
  {
    outboxId: uuid("outbox_id").notNull(),
    runId: text("run_id").notNull(),
    dispatchAttempt: integer("dispatch_attempt").notNull(),
    recoveryGeneration: integer("recovery_generation").notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }).notNull(),
    lastStatus: text("last_status"),
    statusCheckedAt: timestamp("status_checked_at", { withTimezone: true }),
    attemptCount: integer("attempt_count"),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    unknownChecks: integer("unknown_checks").notNull().default(0),
    firstUnknownAt: timestamp("first_unknown_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.outboxId, table.runId] })],
);

export function createPostgresOutbox(tx: DatabaseTransaction): OutboxWriter {
  return {
    async append(input: OutboxMessage): Promise<void> {
      const message = createOutboxMessage(input);
      await tx.insert(outbox).values({
        id: message.id,
        topic: message.topic,
        organizationId: message.organizationId ?? null,
        workspaceId: message.workspaceId ?? null,
        subjectIds: message.subjectIds,
        correlationId: message.correlationId,
        initiatorType: message.initiator.type,
        initiatorUserId: message.initiator.type === "user" ? message.initiator.userId : null,
        dispatchKey: message.dispatchKey,
        status: "PENDING",
        createdAt: message.createdAt,
      });
    },
    // The row is already written (by the definer, in this transaction); only the caller's notifier cares.
    routed: () => undefined,
  };
}
