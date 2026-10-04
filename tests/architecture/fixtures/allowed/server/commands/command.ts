// ARCHITECTURE TEST FIXTURE — allowed dependencies. Never imported by application code.
import type { WorkspaceContext } from "../pipeline/context";
import { run } from "../pipeline/pipeline";
export const execute = (context: WorkspaceContext): WorkspaceContext => context ?? run();
