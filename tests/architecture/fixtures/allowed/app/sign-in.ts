// ARCHITECTURE TEST FIXTURE — allowed dependencies. Never imported by application code.
import { session } from "../server/auth/session";
export const state = session();
