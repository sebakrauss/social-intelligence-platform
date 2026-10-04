// ARCHITECTURE TEST FIXTURE — deliberately violates boundaries. Never imported by application code.
import { createServerClient } from "@supabase/ssr";
export const client = createServerClient;
