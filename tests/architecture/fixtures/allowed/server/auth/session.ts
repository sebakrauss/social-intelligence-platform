// ARCHITECTURE TEST FIXTURE — allowed dependencies. Never imported by application code.
import type { AuthUser } from "../../platform/auth/port";
export const session = (): AuthUser | undefined => undefined;
