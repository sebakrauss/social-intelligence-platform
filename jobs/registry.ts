/**
 * Production task registry: the named system jobs that deliver the outbox (relay, dispatch sweeper, R7
 * run-outcome sweeper; Step 3) and the tenant workloads registered by the steps that build them, each on its lane.
 *
 *   connections.discover_assets (Step 5D)  lane 3 (health/validation), one run per connection at a time,
 *                                          payload subject: connection_id only
 *   connections.move.* (Step 5F)           the Move saga steps, lane 3, one run per move at a time; routed across
 *                                          workspaces only by connections.route_move_step (0010). release_source
 *                                          also names the source account and the destination workspace (derived by
 *                                          the definer); activate/reject name the move only
 *   capability.evaluate_account (Step 5F)  capability evaluation after an activation, lane 3, one run per account
 *   ingestion.reconcile_account (H6-C3)    MAIN planner of one reconciliation run, lane 3 (never a credential)
 *   ingestion.reconcile_slice (H6-C3)      INTEGRATION: one bounded slice of provider reads, lane 3
 *   interactions.observed (H6-C3)          MAIN: the H6 terminal consumer of the canonical event, lane 2 (ids only)
 *   ingestion.confirm_interaction (H6-E)   INTEGRATION: ONE direct re-read of one canonical interaction from its STORED
 *                                          provenance (the only removal authority besides a verified signal), lane 3
 *
 * Execution planes (Step 7E.4B.3), declared explicitly per task — drawn by credential-opening capability, never by
 * name, directory or scope: the two tasks that open a provider credential run in the integration plane; the relay, the
 * sweepers and the Move saga steps run in the main plane.
 */
import { RETRY_POLICIES, defineTaskRegistry } from "@/platform/jobs";

/** Sweeper cadence (explicit configuration; Trigger.dev plan limits on schedule frequency: TA-Q-32). */
export const SWEEPER_SCHEDULES = {
  dispatchSweep: "* * * * *",
  outcomeSweep: "*/2 * * * *",
  // Step H6-F3 (design H6-F0 §3, §5): the inbox's guaranteed drain (the web nudge only lowers latency) and its retention.
  routeProviderEvents: "* * * * *",
  purgeProviderEvents: "*/15 * * * *",
} as const;

export const PRODUCTION_TASKS = defineTaskRegistry([
  { name: "outbox.relay", scope: "system", executionPlane: "main", retry: RETRY_POLICIES.transient },
  { name: "outbox.dispatch_sweep", scope: "system", executionPlane: "main", retry: RETRY_POLICIES.singleAttempt, schedule: { cron: SWEEPER_SCHEDULES.dispatchSweep } },
  { name: "outbox.outcome_sweep", scope: "system", executionPlane: "main", retry: RETRY_POLICIES.singleAttempt, schedule: { cron: SWEEPER_SCHEDULES.outcomeSweep } },
  // Step H6-F3: drains the provider-event inbox (D-F1) — cron every minute, also nudged by the web after a new receipt.
  // DB-only: no provider, no credential; a transient database failure is retried (routing is idempotent per hint).
  { name: "ingestion.route_provider_events", scope: "system", executionPlane: "main", retry: RETRY_POLICIES.transient, schedule: { cron: SWEEPER_SCHEDULES.routeProviderEvents } },
  // Step H6-F3: the 7-day retention of the inbox and its hints (bounded batches; the next run continues).
  { name: "ingestion.purge_provider_events", scope: "system", executionPlane: "main", retry: RETRY_POLICIES.singleAttempt, schedule: { cron: SWEEPER_SCHEDULES.purgeProviderEvents } },
  {
    name: "connections.discover_assets",
    scope: "workspace",
    executionPlane: "integration",
    lane: 3,
    retry: RETRY_POLICIES.transient,
    concurrency: { by: "subject", subject: "connection_id" },
    // Step 7G-H5.5-P12-C0-R1: a re-authorization's discovery also names the credential whose capabilities it refreshes.
    subjects: ["connection_id", "capability_refresh_credential_id"],
  },
  {
    name: "connections.move.release_source",
    scope: "workspace",
    executionPlane: "main",
    lane: 3,
    retry: RETRY_POLICIES.transient,
    concurrency: { by: "subject", subject: "move_id" },
    subjects: ["move_id", "connected_account_id", "counterpart_workspace_id"],
  },
  {
    name: "connections.move.activate_destination",
    scope: "workspace",
    executionPlane: "main",
    lane: 3,
    retry: RETRY_POLICIES.transient,
    concurrency: { by: "subject", subject: "move_id" },
    subjects: ["move_id"],
  },
  {
    name: "connections.move.reject_destination",
    scope: "workspace",
    executionPlane: "main",
    lane: 3,
    retry: RETRY_POLICIES.transient,
    concurrency: { by: "subject", subject: "move_id" },
    subjects: ["move_id"],
  },
  {
    name: "capability.evaluate_account",
    scope: "workspace",
    executionPlane: "integration",
    lane: 3,
    retry: RETRY_POLICIES.transient,
    concurrency: { by: "subject", subject: "connected_account_id" },
    // Step 7G-H5.5-P12-C0-R1: a credential-bound request also names its credential (checked before any opening).
    subjects: ["connected_account_id", "credential_id"],
  },
  // Step H6-C3 (design H6-C0): reconciliation. Serial per account by the 0018 indexes, never by the vendor's keys.
  {
    name: "ingestion.reconcile_account",
    scope: "workspace",
    executionPlane: "main",
    lane: 3,
    retry: RETRY_POLICIES.transient,
    concurrency: { by: "subject", subject: "connected_account_id" },
    subjects: ["connected_account_id", "reconciliation_run_id"],
  },
  {
    name: "ingestion.reconcile_slice",
    scope: "workspace",
    executionPlane: "integration",
    lane: 3,
    retry: RETRY_POLICIES.transient,
    concurrency: { by: "subject", subject: "connected_account_id" },
    subjects: ["connected_account_id", "reconciliation_slice_id"],
  },
  // Step H6-E: one stored-interaction confirmation — exactly one provider read per attempt, bounded by this policy.
  {
    name: "ingestion.confirm_interaction",
    scope: "workspace",
    executionPlane: "integration",
    lane: 3,
    retry: RETRY_POLICIES.transient,
    concurrency: { by: "subject", subject: "connected_account_id" },
    subjects: ["connected_account_id", "interaction_id"],
  },
  {
    name: "interactions.observed",
    scope: "workspace",
    executionPlane: "main",
    lane: 2,
    retry: RETRY_POLICIES.transient,
    concurrency: { by: "none" },
    subjects: ["ingestion_event_id", "interaction_id", "conversation_id", "source_text_version_id"],
  },
]);
