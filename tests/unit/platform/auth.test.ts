import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSupabaseAuthConfig } from "@/platform/auth/config";
import { createSupabaseAuth, signInOutcomeFor, signUpOutcomeFor, toAuthUser } from "@/platform/auth/supabase";
import { opaqueTokens } from "@/platform/crypto";

const ID = "3b241101-e2bb-4255-8caf-4136c566a962";

/** A Supabase-shaped user with everything the provider might return. */
const providerUser = {
  id: ID,
  aud: "authenticated",
  role: "service_role",
  email: "Person@Example.Test",
  phone: "+56912345678",
  email_confirmed_at: "2026-10-01T10:00:00Z",
  app_metadata: { provider: "email", roles: ["OWNER"] },
  user_metadata: { full_name: "María Pérez", workspace_role: "OWNER" },
  identities: [],
  created_at: "2026-10-01T09:00:00Z",
};

describe("auth adapter isolation", () => {
  it("exposes only the provider-neutral identity: id, verification and the normalized verified email", () => {
    const user = toAuthUser(providerUser);
    expect(user).toEqual({ id: ID, emailVerified: true, verifiedEmail: "person@example.test" });
    expect(Object.keys(user ?? {}).sort()).toEqual(["emailVerified", "id", "verifiedEmail"]);
    expect(JSON.stringify(user)).not.toMatch(/OWNER|service_role|María|\+569|authenticated/);
  });

  it("marks unconfirmed emails as unverified and never exposes an unverified address", () => {
    expect(toAuthUser({ id: ID, email: "person@example.test" })).toEqual({ id: ID, emailVerified: false });
    expect(toAuthUser({ id: ID, email: "person@example.test", email_confirmed_at: "" })).toEqual({ id: ID, emailVerified: false });
  });

  it("omits a malformed provider email even when verified", () => {
    expect(toAuthUser({ id: ID, email: "not an email", email_confirmed_at: "2026-10-01T10:00:00Z" })).toEqual({ id: ID, emailVerified: true });
  });

  it("rejects malformed or missing users", () => {
    expect(toAuthUser(null)).toBeUndefined();
    expect(toAuthUser(undefined)).toBeUndefined();
    expect(toAuthUser({ id: "not-a-uuid", email_confirmed_at: "2026-10-01T10:00:00Z" })).toBeUndefined();
  });

  it("maps provider error codes to closed outcomes", () => {
    expect(signInOutcomeFor("invalid_credentials")).toBe("invalid_credentials");
    expect(signInOutcomeFor("email_not_confirmed")).toBe("verification_required");
    expect(signInOutcomeFor("over_request_rate_limit")).toBe("rate_limited");
    expect(signInOutcomeFor("something_new")).toBe("unavailable");
    expect(signInOutcomeFor(undefined)).toBe("unavailable");
  });

  it("maps sign-up errors to closed outcomes without revealing existing accounts", () => {
    expect(signUpOutcomeFor("weak_password")).toBe("weak_password");
    expect(signUpOutcomeFor("email_address_invalid")).toBe("invalid_input");
    expect(signUpOutcomeFor("over_email_send_rate_limit")).toBe("rate_limited");
    expect(signUpOutcomeFor("user_already_exists")).toBe("verification_required");
    expect(signUpOutcomeFor("email_exists")).toBe("verification_required");
    expect(signUpOutcomeFor("signup_disabled")).toBe("unavailable");
    expect(signUpOutcomeFor(undefined)).toBe("unavailable");
  });

  it("builds an AuthPort that exposes only the port's methods (no network on construction)", () => {
    const port = createSupabaseAuth(
      { url: "https://project.example.test", publishableKey: "public-test-key", secureCookies: true },
      { getAll: () => [], setAll: () => undefined },
    );
    expect(Object.keys(port).sort()).toEqual(["completeEmailLink", "getVerifiedUser", "requestSignInLink", "signInWithPassword", "signOut", "signUpWithPassword"]);
  });
});

describe("auth configuration", () => {
  it("uses only the public URL and publishable key (Secure session cookies unless development/test)", () => {
    expect(readSupabaseAuthConfig({ NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co/rest/v1", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "pk" })).toEqual({
      url: "https://abc.supabase.co",
      publishableKey: "pk",
      secureCookies: true,
    });
  });

  it("is unavailable when incomplete, insecure, or only a service-role/secret key is present", () => {
    expect(readSupabaseAuthConfig({})).toBeUndefined();
    expect(readSupabaseAuthConfig({ NEXT_PUBLIC_SUPABASE_URL: "http://abc.example.test", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "pk" })).toBeUndefined();
    expect(readSupabaseAuthConfig({ SUPABASE_SERVICE_ROLE_KEY: "x", SUPABASE_SECRET_KEY: "y", NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co" })).toBeUndefined();
  });

  it("declares only reviewed, value-free variables in .env.example (no service-role or secret key)", () => {
    const lines = readFileSync(path.resolve(import.meta.dirname, "../../../.env.example"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith("#"));
    expect(lines).toEqual([
      "NEXT_PUBLIC_SUPABASE_URL=",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=",
      "APP_BASE_URL=",
      // Step 2 database configuration: per-runtime login-role URLs, CA path, tooling-only migration URL, target ref.
      "DATABASE_WEB_URL=",
      "DATABASE_WORKER_URL=",
      "DATABASE_SYSTEM_URL=",
      "DATABASE_SSL_ROOT_CERT=",
      // Step 5K: the CA as PEM content (deployed workers), the alternative to the path above.
      "DATABASE_SSL_ROOT_CERT_PEM=",
      "DATABASE_MIGRATION_URL=",
      "SUPABASE_PROJECT_REF=",
      // Step 3 job runtime (Trigger.dev): the environment's API key and project reference, names only.
      "TRIGGER_SECRET_KEY=",
      "TRIGGER_PROJECT_REF=",
      // Step 5A credential crypto: local/test-only keyring KEK (refused outside NODE_ENV development/test), name only.
      "LOCAL_KEYRING_KEY=",
      // Step 7D: deployed KMS credential keyring configuration (non-secret), names only.
      "CREDENTIAL_CONTEXT_ENV=",
      "CREDENTIAL_KMS_KEY_ARN=",
      "CREDENTIAL_KMS_ALLOWED_KEY_ARNS=",
      // Step 7E.2: the hosted web's role ARN for KMS sealing (non-secret), name only.
      "CREDENTIAL_KMS_WEB_ROLE_ARN=",
      // Step 5D OAuth: web-only stateless PKCE derivation key, name only.
      "OAUTH_PKCE_DERIVATION_KEY=",
      // Step 5K: explicit deployment tier and job-runtime provider mode (staging_stub only for preview/staging).
      "APP_DEPLOYMENT_ENV=",
      "CAPABILITY_PROVIDER_MODE=",
    ]);
    expect(lines.join("\n")).not.toMatch(/SERVICE_ROLE|SUPABASE_SECRET|POSTGRES|DATABASE_URL=/);
  });
});

describe("opaque invitation tokens", () => {
  it("issue 256-bit base64url tokens with a SHA-256 digest, never repeating", () => {
    const a = opaqueTokens.issue();
    const b = opaqueTokens.issue();
    expect(a.raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.digest).not.toContain(a.raw);
    expect(a.raw).not.toBe(b.raw);
    expect(opaqueTokens.digest(a.raw)).toBe(a.digest);
  });

  it("match only the right token, rejecting malformed input", () => {
    const { raw, digest } = opaqueTokens.issue();
    expect(opaqueTokens.matches(raw, digest)).toBe(true);
    expect(opaqueTokens.matches(opaqueTokens.issue().raw, digest)).toBe(false);
    expect(opaqueTokens.matches("short", digest)).toBe(false);
    expect(opaqueTokens.matches(raw, "not-a-digest")).toBe(false);
  });
});
