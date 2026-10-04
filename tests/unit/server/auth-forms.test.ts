import { describe, expect, it } from "vitest";
import { AUTH_STATUS_MESSAGES, callbackUrl, parseAuthStatus, readCallbackParams, readCredentials, readEmail } from "@/server/auth/forms";

const form = (entries: Record<string, string>): FormData => {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) data.set(name, value);
  return data;
};

describe("auth form parsing", () => {
  it("reads credentials, normalizing the email and keeping the password verbatim", () => {
    expect(readCredentials(form({ email: " Person@Example.Test ", password: "  pass with spaces " }))).toEqual({
      email: "person@example.test",
      password: "  pass with spaces ",
    });
  });

  it("rejects malformed credentials", () => {
    expect(readCredentials(form({ email: "not-an-email", password: "x" }))).toBeUndefined();
    expect(readCredentials(form({ email: "a@b.test", password: "" }))).toBeUndefined();
    expect(readCredentials(form({ email: "a@b.test", password: "x".repeat(1025) }))).toBeUndefined();
    expect(readEmail(form({ email: "nope" }))).toBeUndefined();
  });

  it("knows the sign-up outcomes, each with a message", () => {
    expect(parseAuthStatus("sign_up_check_email")).toBe("sign_up_check_email");
    expect(parseAuthStatus("weak_password")).toBe("weak_password");
    expect(AUTH_STATUS_MESSAGES.sign_up_check_email).toBe("auth.status.sign_up_check_email");
    expect(AUTH_STATUS_MESSAGES.weak_password).toBe("auth.status.weak_password");
  });

  it("accepts only known status codes", () => {
    expect(parseAuthStatus("link_sent")).toBe("link_sent");
    expect(parseAuthStatus("<script>")).toBeUndefined();
    expect(parseAuthStatus(["link_sent"])).toBeUndefined();
  });
});

describe("email-link callback", () => {
  it("accepts a PKCE code or a token hash with a known type", () => {
    expect(readCallbackParams(new URL("https://app.test/auth/callback?code=34e770dd-9ff9-416c-87fa-43b31d7ef225"))).toEqual({
      kind: "code",
      code: "34e770dd-9ff9-416c-87fa-43b31d7ef225",
    });
    expect(readCallbackParams(new URL("https://app.test/auth/callback?token_hash=pkce_abc123def456&type=magiclink"))).toEqual({
      kind: "token_hash",
      tokenHash: "pkce_abc123def456",
      type: "magiclink",
    });
  });

  it("rejects unknown types, malformed values and redirect parameters", () => {
    expect(readCallbackParams(new URL("https://app.test/auth/callback?token_hash=abc12345&type=recovery"))).toBeUndefined();
    expect(readCallbackParams(new URL("https://app.test/auth/callback?code=<x>"))).toBeUndefined();
    expect(readCallbackParams(new URL("https://app.test/auth/callback?next=https://evil.test"))).toBeUndefined();
  });

  it("builds the redirect URL from configuration only", () => {
    expect(callbackUrl("https://app.example.test/some/path")).toBe("https://app.example.test/auth/callback");
    expect(callbackUrl("http://localhost:3000")).toBe("http://localhost:3000/auth/callback");
    expect(callbackUrl("http://insecure.example.test")).toBeUndefined();
    expect(callbackUrl(undefined)).toBeUndefined();
    expect(callbackUrl("")).toBeUndefined();
  });
});
