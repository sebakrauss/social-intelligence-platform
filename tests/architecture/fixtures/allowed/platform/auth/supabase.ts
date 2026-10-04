// ARCHITECTURE TEST FIXTURE — allowed dependencies. Never imported by application code.
import { createServerClient } from "@supabase/ssr";
import type { AuthUser } from "./port";
export const adapter: [typeof createServerClient, AuthUser | undefined] = [createServerClient, undefined];
