/** Task registry of the managed Trigger.dev test leg (test-only tasks; never part of PRODUCTION_TASKS). */
import { RETRY_POLICIES, defineTaskRegistry } from "@/platform/jobs";

export const CRASH_TASK = "managedtest.crash_after_effect";

export const MANAGED_TEST_TASKS = defineTaskRegistry([
  { name: CRASH_TASK, scope: "workspace", executionPlane: "main", lane: 3, retry: RETRY_POLICIES.transient, concurrency: { by: "none" }, subjects: ["item_id"] },
]);
