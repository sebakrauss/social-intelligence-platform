/**
 * Production task registry. Step 3 ships the job FOUNDATION only: the named system jobs that deliver the
 * outbox (relay, dispatch sweeper, R7 run-outcome sweeper). Tenant workloads (ingestion, understanding,
 * mutations, intelligence, backfill) are registered by the steps that build them, each on its lane.
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
]);
