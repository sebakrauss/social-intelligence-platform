// ARCHITECTURE TEST FIXTURE — deliberately violates boundaries. Never imported by application code.
import { WorkspaceContext } from "../pipeline/context";
export const forged = WorkspaceContext.mint();
