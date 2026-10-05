// ARCHITECTURE TEST FIXTURE — deliberately violates boundaries. Never imported by application code.
import { tasks } from "@trigger.dev/sdk";
import { runtime } from "../platform/jobs/trigger-dev";
import { relayPass } from "../platform/outbox/delivery";
import { withSystemScope } from "../platform/db/system-scope";
export const bypass: unknown[] = [tasks, runtime, relayPass, withSystemScope];
