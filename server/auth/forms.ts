/**
 * Pure helpers for the auth surface: form parsing and status mapping. No framework or SDK imports,
 * so they are unit-testable. Status values are a closed set; anything else is ignored.
 */
import { email } from "@/domain/validation";
import type { MessageKey } from "@/domain/i18n/message-keys";
import { EMAIL_LINK_TYPES, type CallbackParams, type EmailLinkType } from "@/platform/auth/port";

export const AUTH_STATUSES = [
  "signed_out",
  "invalid_credentials",
  "verification_required",
  "link_sent",
  "invalid_link",
  "rate_limited",
  "invalid_input",
  "unavailable",
  "sign_up_check_email",
  "weak_password",
] as const;
export type AuthStatus = (typeof AUTH_STATUSES)[number];

export const AUTH_STATUS_MESSAGES: { readonly [S in AuthStatus]: MessageKey } = {
  signed_out: "auth.status.signed_out",
  invalid_credentials: "auth.status.invalid_credentials",
  verification_required: "auth.status.verification_required",
  link_sent: "auth.status.link_sent",
  invalid_link: "auth.status.invalid_link",
  rate_limited: "auth.status.rate_limited",
  invalid_input: "auth.status.invalid_input",
  unavailable: "auth.status.unavailable",
  sign_up_check_email: "auth.status.sign_up_check_email",
  weak_password: "auth.status.weak_password",
};

export function parseAuthStatus(value: unknown): AuthStatus | undefined {
  return typeof value === "string" && (AUTH_STATUSES as readonly string[]).includes(value) ? (value as AuthStatus) : undefined;
}

const MAX_PASSWORD_LENGTH = 1024;

/** Reads credentials from a submitted form. Passwords are taken verbatim (never trimmed or logged). */
export function readCredentials(form: FormData): { readonly email: string; readonly password: string } | undefined {
  const password = form.get("password");
  try {
    const address = email(form.get("email"), "email");
    if (typeof password !== "string" || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return undefined;
    return { email: address, password };
  } catch {
    return undefined;
  }
}

export function readEmail(form: FormData): string | undefined {
  try {
    return email(form.get("email"), "email");
  } catch {
    return undefined;
  }
}

const CODE = /^[A-Za-z0-9-]{8,128}$/;
const TOKEN_HASH = /^[A-Za-z0-9_-]{8,256}$/;

/** Extracts and shape-checks email-link callback parameters. The auth service does the real verification. */
export function readCallbackParams(url: URL): CallbackParams | undefined {
  const code = url.searchParams.get("code");
  if (code !== null) return CODE.test(code) ? { kind: "code", code } : undefined;
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  if (tokenHash === null || type === null || !TOKEN_HASH.test(tokenHash)) return undefined;
  return (EMAIL_LINK_TYPES as readonly string[]).includes(type) ? { kind: "token_hash", tokenHash, type: type as EmailLinkType } : undefined;
}

/** Absolute callback URL from configuration; never derived from request headers (host-header injection). */
export function callbackUrl(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined || baseUrl.trim() === "") return undefined;
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") return undefined;
    return new URL("/auth/callback", base.origin).toString();
  } catch {
    return undefined;
  }
}
