// ARCHITECTURE TEST FIXTURE — allowed dependencies. Never imported by application code.
import { WorkspaceContext } from "./context";
export const run = (): WorkspaceContext => WorkspaceContext.resolve();
