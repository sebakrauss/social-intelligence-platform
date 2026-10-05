// ARCHITECTURE TEST FIXTURE — allowed dependencies. Never imported by application code.
import { task } from "@trigger.dev/sdk";
import { runtime } from "../platform/jobs/trigger-dev";
import { relayPass } from "../platform/outbox/delivery";
export const relay: unknown[] = [task, runtime, relayPass];
