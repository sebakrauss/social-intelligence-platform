/**
 * Production task registry: the named system jobs that deliver the outbox (relay, dispatch sweeper, R7
 * run-outcome sweeper; Step 3) and the tenant workloads registered by the steps that build them, each on its lane.
 *
 *   connections.discover_assets (Step 5D)  lane 3 (health/validation), one run per connection at a time,
 *                                          payload subject: connection_id only
 */
import { RETRY_POLICIES, defineTaskRegistry } from "@/platform/jobs";

/** Sweeper cadence (explicit configuration; Trigger.dev plan limits on schedule frequency: TA-Q-32). */
export const SWEEPER_SCHEDULES = {
  dispatchSweep: "* * * * *",
  outcomeSweep: "*/2 * * * *",
} as const;

export const PRODUCTION_TASKS = defineTaskRegistry([
  { name: "outbox.relay", scope: "system", retry: RETRY_POLICIES.transient },
  { name: "outbox.dispatch_sweep", scope: "system", retry: RETRY_POLICIES.singleAttempt, schedule: { cron: SWEEPER_SCHEDULES.dispatchSweep } },
  { name: "outbox.outcome_sweep", scope: "system", retry: RETRY_POLICIES.singleAttempt, schedule: { cron: SWEEPER_SCHEDULES.outcomeSweep } },
  {
    name: "connections.discover_assets",
    scope: "workspace",
    lane: 3,
    retry: RETRY_POLICIES.transient,
    concurrency: { by: "subject", subject: "connection_id" },
    subjects: ["connection_id"],
  },
]);
