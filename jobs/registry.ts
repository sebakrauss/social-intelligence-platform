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
} as const;

export const PRODUCTION_TASKS = defineTaskRegistry([
  { name: "outbox.relay", scope: "system", executionPlane: "main", retry: RETRY_POLICIES.transient },
  { name: "outbox.dispatch_sweep", scope: "system", executionPlane: "main", retry: RETRY_POLICIES.singleAttempt, schedule: { cron: SWEEPER_SCHEDULES.dispatchSweep } },
  { name: "outbox.outcome_sweep", scope: "system", executionPlane: "main", retry: RETRY_POLICIES.singleAttempt, schedule: { cron: SWEEPER_SCHEDULES.outcomeSweep } },
  {
    name: "connections.discover_assets",
    scope: "workspace",
    executionPlane: "integration",
    lane: 3,
    retry: RETRY_POLICIES.transient,
    concurrency: { by: "subject", subject: "connection_id" },
    subjects: ["connection_id"],
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
    subjects: ["connected_account_id"],
  },
]);
