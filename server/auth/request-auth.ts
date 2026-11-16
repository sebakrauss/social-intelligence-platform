/**
 * Per-request authentication for the App Router (server only). Builds the Supabase-backed AuthPort on
 * the request's cookies. Pages, actions and routes use this module; none of them touch the SDK.
 */
import { cookies } from "next/headers";
import { cache } from "react";
import { createSupabaseAuth, readSupabaseAuthConfig, type AuthPort, type AuthUser, type CookieJar, type IdentityPort } from "@/platform/auth";
import { serviceIdentityCoherent } from "@/server/http/service-identity";

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
  // Fail closed: an auth project that does not match the database project is "unavailable", never used.
  const config = serviceIdentityCoherent(process.env) ? readSupabaseAuthConfig(process.env) : undefined;
  return config === undefined ? undefined : createSupabaseAuth(config, jar);
}

/**
 * Step 7B-17K — an identity port that asks the Auth server at most ONCE: the first `getVerifiedUser()` sends the
 * server-side validation (getUser, TA §10.2) and every later call on THIS port receives the same answer (or the same
 * failure). Nothing is decoded locally and nothing outlives the port.
 */
export function verifyOnce(auth: Pick<AuthPort, "getVerifiedUser">): IdentityPort {
  let verified: Promise<AuthUser | undefined> | undefined;
  return {
    getVerifiedUser: () => {
      verified ??= auth.getVerifiedUser();
      return verified;
    },
  };
}

/**
 * Step 7B-17K — the identity of the request being RENDERED (server components: a page, its layouts and what they read),
 * verified with the Auth server once per render instead of once per read. React's `cache` scopes the port to a single
 * server request — never shared across requests, people or sessions; outside a server-component render (actions,
 * route handlers) it memoizes nothing, so each call there builds and verifies afresh. The proxy's own session refresh
 * (proxy.ts) is a separate execution and still runs on every request. Authorization is unchanged: every read still
 * resolves the workspace and the membership live inside its own transaction (server/pipeline).
 */
const renderIdentity = cache(async (): Promise<IdentityPort | undefined> => {
  const auth = await requestAuth();
  return auth === undefined ? undefined : verifyOnce(auth);
});

/** The rendering request's verified identity (see renderIdentity), or undefined when auth configuration is absent. */
export function requestIdentity(): Promise<IdentityPort | undefined> {
  return renderIdentity();
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
