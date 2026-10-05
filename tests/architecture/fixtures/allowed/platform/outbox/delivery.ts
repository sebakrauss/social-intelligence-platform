// ARCHITECTURE TEST FIXTURE — allowed dependencies. Never imported by application code.
import { withSystemScope } from "../db/system-scope";
import { port } from "../jobs/port";
export const relayPass = withSystemScope + port;
