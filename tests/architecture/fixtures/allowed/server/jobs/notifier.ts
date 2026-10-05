// ARCHITECTURE TEST FIXTURE — allowed dependencies. Never imported by application code.
import { runtime } from "../../platform/jobs/trigger-dev";
import { port } from "../../platform/jobs/port";
export const notifier: unknown[] = [runtime, port];
