/**
 * Per-request authentication for the App Router (server only). Builds the Supabase-backed AuthPort on
 * the request's cookies. Pages, actions and routes use this module; none of them touch the SDK.
 */
import { cookies } from "next/headers";
import { createSupabaseAuth, readSupabaseAuthConfig, type AuthPort, type CookieJar } from "@/platform/auth";

async function requestCookieJar(): Promise<CookieJar> {
  const store = await cookies();
  return {
    getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
    setAll: (toSet) => {
      try {
        for (const { name, value, options } of toSet) {
          store.set({ ...options, name, value });
        }
      } catch {
        // Server Components can't write cookies; the proxy refreshes the session on the next request.
      }
    },
  };
}

/**
 * The request's AuthPort, or undefined when public auth configuration is absent. Cookies are read
 * first so every caller renders per request (never prerendered with a build-time auth state).
 */
export async function requestAuth(): Promise<AuthPort | undefined> {
  const jar = await requestCookieJar();
  const config = readSupabaseAuthConfig(process.env);
  return config === undefined ? undefined : createSupabaseAuth(config, jar);
}

export type SessionState = "signed_out" | "verification_required" | "signed_in" | "unavailable";

/** Session state from a server-side validated identity. Never from cookies or claims alone. */
export async function currentSessionState(): Promise<SessionState> {
  const auth = await requestAuth();
  if (auth === undefined) return "unavailable";
  const user = await auth.getVerifiedUser();
  if (user === undefined) return "signed_out";
  return user.emailVerified ? "signed_in" : "verification_required";
}
