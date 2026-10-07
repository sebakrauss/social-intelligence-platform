/**
 * Supabase Auth adapter: the ONLY place that imports the Supabase SDK (enforced by dependency-cruiser).
 * One client per request, built on the framework's cookie jar (official @supabase/ssr pattern).
 * Provider types and errors are translated here; nothing Supabase-shaped is returned.
 */
import { createServerClient } from "@supabase/ssr";
import type { User } from "@supabase/supabase-js";
import { asVerifiedEmail } from "@/domain/email";
import { parseUserId } from "@/domain/ids";
import type { SupabaseAuthConfig } from "./config";
import type { AuthPort, AuthUser, CallbackOutcome, CookieJar, LinkRequestOutcome, SignInOutcome, SignUpOutcome } from "./port";

/**
 * Maps a Supabase user to the provider-neutral AuthUser. The email is exposed only once verified, and
 * only as a normalized VerifiedEmail. Returns undefined for anything malformed.
 */
export function toAuthUser(user: Pick<User, "id" | "email" | "email_confirmed_at"> | null | undefined): AuthUser | undefined {
  const id = parseUserId(user?.id);
  if (user === null || user === undefined || id === undefined) return undefined;
  const emailVerified = typeof user.email_confirmed_at === "string" && user.email_confirmed_at !== "";
  const verifiedEmail = emailVerified ? asVerifiedEmail(user.email) : undefined;
  return verifiedEmail === undefined ? { id, emailVerified } : { id, emailVerified, verifiedEmail };
}

const SIGN_IN_OUTCOMES: Readonly<Record<string, SignInOutcome>> = {
  invalid_credentials: "invalid_credentials",
  email_not_confirmed: "verification_required",
  over_request_rate_limit: "rate_limited",
  over_email_send_rate_limit: "rate_limited",
};

/** Maps a sign-in error code to an outcome. Messages and user data are never inspected or returned. */
export function signInOutcomeFor(code: string | undefined): SignInOutcome {
  return (code !== undefined && Object.hasOwn(SIGN_IN_OUTCOMES, code) ? SIGN_IN_OUTCOMES[code] : undefined) ?? "unavailable";
}

const SIGN_UP_OUTCOMES: Readonly<Record<string, SignUpOutcome>> = {
  weak_password: "weak_password",
  email_address_invalid: "invalid_input",
  validation_failed: "invalid_input",
  over_request_rate_limit: "rate_limited",
  over_email_send_rate_limit: "rate_limited",
  // An existing account is reported exactly like a new registration: no account enumeration.
  user_already_exists: "verification_required",
  email_exists: "verification_required",
};

/** Maps a sign-up error code to an outcome. Unknown codes are "unavailable". */
export function signUpOutcomeFor(code: string | undefined): SignUpOutcome {
  return (code !== undefined && Object.hasOwn(SIGN_UP_OUTCOMES, code) ? SIGN_UP_OUTCOMES[code] : undefined) ?? "unavailable";
}

function linkOutcomeFor(code: string | undefined): LinkRequestOutcome {
  return code === "over_email_send_rate_limit" || code === "over_request_rate_limit" ? "rate_limited" : "unavailable";
}

/** Return type inferred from the current (non-deprecated) getAll/setAll overload. */
function createSupabaseClient(config: SupabaseAuthConfig, cookies: CookieJar) {
  return createServerClient(config.url, config.publishableKey, {
    // Only the Secure attribute is set explicitly; every other cookie default of the library is kept.
    ...(config.secureCookies ? { cookieOptions: { secure: true } } : {}),
    cookies: {
      getAll: () => cookies.getAll().map(({ name, value }) => ({ name, value })),
      setAll: (toSet) => {
        cookies.setAll(toSet.map(({ name, value, options }) => ({ name, value, options: { ...options } })));
      },
    },
  });
}

export function createSupabaseAuth(config: SupabaseAuthConfig, cookies: CookieJar): AuthPort {
  const client = createSupabaseClient(config, cookies);

  return {
    async getVerifiedUser() {
      // getUser() validates the session with the Auth server on every call (TA §10.2).
      const { data, error } = await client.auth.getUser();
      return error === null ? toAuthUser(data.user) : undefined;
    },

    async signInWithPassword(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error !== null) return signInOutcomeFor(error.code);
      return toAuthUser(data.user)?.emailVerified === true ? "signed_in" : "verification_required";
    },

    async signUpWithPassword(email, password, redirectTo) {
      const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } });
      if (error !== null) return signUpOutcomeFor(error.code);
      // With email confirmation enabled there is no session until the address is verified. An already
      // registered address returns an obfuscated user and no session: the same outcome, by design.
      return data.session !== null && toAuthUser(data.user)?.emailVerified === true ? "signed_in" : "verification_required";
    },

    async requestSignInLink(email, redirectTo) {
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
      });
      // An unknown address is reported like success so the form can't be used to probe accounts.
      if (error === null || error.code === "otp_disabled" || error.code === "user_not_found" || error.code === "signup_disabled") {
        return "sent";
      }
      return linkOutcomeFor(error.code);
    },

    async completeEmailLink(params): Promise<CallbackOutcome> {
      const { error } =
        params.kind === "code"
          ? await client.auth.exchangeCodeForSession(params.code)
          : await client.auth.verifyOtp({ token_hash: params.tokenHash, type: params.type });
      if (error === null) return "signed_in";
      return error.status !== undefined && error.status >= 500 ? "unavailable" : "invalid_link";
    },

    async signOut() {
      await client.auth.signOut({ scope: "local" });
    },
  };
}

/** Refreshes the session cookies for a request (used by the Next.js proxy). Authorization never happens here. */
export async function refreshSession(config: SupabaseAuthConfig, cookies: CookieJar): Promise<void> {
  await createSupabaseClient(config, cookies).auth.getUser();
}
