/**
 * Provider AUTHORIZATION port (TA §15.1, §39; Step 5 decision D1): the provider-neutral boundary of an
 * authorization-code grant. It does three things and nothing else:
 *
 *   1. builds the provider authorization URL for a caller-supplied state, redirect URI and optional PKCE challenge;
 *   2. parses the provider's callback query into a CLOSED outcome (code · denied · malformed);
 *   3. exchanges an authorization code for a normalized ProviderCredential, its expiry and the granted scopes.
 *
 * It never decides anything for the product. Verifying that the callback state belongs to the persisted connect
 * attempt (CSRF), workspace authorization, connection lifecycle, sealing the credential and every database
 * write belong to the caller (Step 5D). Granted scopes are opaque provider identifiers; only the versioned
 * capability catalog interprets them (TA §16).
 *
 * Secrets: the authorization code, the PKCE verifier and the issued credential are SecretValues and never
 * appear in URLs, errors, logs or serialized output. The PKCE challenge is not secret. The state is sensitive
 * correlation material (not a credential): it travels in the URL and the callback, but is never logged.
 *
 * `exchangeCode` makes exactly one provider call and never retries: authorization codes are single-use, so a
 * retry after any failure may legitimately fail with CredentialInvalid. Retry policy belongs to the caller.
 *
 * Real-provider behavior (Meta, TikTok: OAuth flavor, PKCE support, scopes, app review, whether an
 * authorization survives its author leaving) stays VALIDATE (PD OQ-18, OQ-19, OQ-26, OQ-27). The simulator
 * implementing this port is product-contract evidence only.
 */
import { SecretValue, type ProviderCredential } from "./credential";
import type { IsoInstant, ProviderName } from "./identity";
import type { ProviderResult } from "./pagination";

// ── State ───────────────────────────────────────────────────────────────────────────────────────────────

declare const oauthStateBrand: unique symbol;
/** Caller-generated, high-entropy correlation value, URL-safe as is (RFC 3986 unreserved characters only). */
export type OAuthState = string & { readonly [oauthStateBrand]: true };

const OAUTH_STATE = /^[A-Za-z0-9._~-]{32,512}$/;

export function parseOAuthState(value: unknown): OAuthState | undefined {
  return typeof value === "string" && OAUTH_STATE.test(value) ? (value as OAuthState) : undefined;
}

// ── Redirect URI ────────────────────────────────────────────────────────────────────────────────────────

declare const redirectUriBrand: unique symbol;
/**
 * The exact redirect URI registered for the callback: absolute, HTTPS (plain HTTP only on a loopback host),
 * without userinfo or fragment. A query component is allowed and kept exactly as given: the value must already
 * equal its own WHATWG serialization, so it is never normalized, reordered or reconstructed, and the exchange
 * compares it to the authorization request's redirect URI as an exact string. Whether a given provider accepts
 * query components is VALIDATE per provider. A query that repeats a callback parameter (`code`, `state`, …)
 * makes the callback ambiguous, and adapters must then fail closed as malformed.
 */
export type RedirectUri = string & { readonly [redirectUriBrand]: true };

const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

export function parseRedirectUri(value: unknown): RedirectUri | undefined {
  if (typeof value !== "string" || value.length > 2048 || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname));
  const clean = url.username === "" && url.password === "" && url.hash === "" && !value.includes("#");
  return secure && clean && url.href === value ? (value as RedirectUri) : undefined;
}

// ── PKCE (S256 only) ────────────────────────────────────────────────────────────────────────────────────

/**
 * - `required`:      the authorization request MUST carry an S256 challenge; the exchange MUST carry its verifier.
 * - `supported`:     PKCE is the caller's choice; if a challenge was used the exchange MUST carry the matching
 *                    verifier, and if none was used the exchange takes `pkceVerifier: null`.
 * - `not_supported`: a supplied challenge is rejected; a supplied verifier is rejected.
 * Only S256 is modeled ("plain" is deliberately absent). Per-provider support is VALIDATE.
 */
export const PKCE_SUPPORT = ["required", "supported", "not_supported"] as const;
export type PkceSupport = (typeof PKCE_SUPPORT)[number];

declare const pkceChallengeBrand: unique symbol;
/** BASE64URL(SHA-256(verifier)) without padding: exactly 43 characters. Not secret. */
export type PkceChallengeValue = string & { readonly [pkceChallengeBrand]: true };

export interface PkceChallenge {
  readonly method: "S256";
  readonly challenge: PkceChallengeValue;
}

const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export function parsePkceChallenge(value: unknown): PkceChallenge | undefined {
  return typeof value === "string" && PKCE_CHALLENGE.test(value) ? Object.freeze({ method: "S256", challenge: value as PkceChallengeValue }) : undefined;
}

/** A PKCE verifier (RFC 7636 §4.1 shape: 43–128 unreserved characters), wrapped as a secret. */
export function parsePkceVerifier(value: unknown): SecretValue | undefined {
  return typeof value === "string" && PKCE_VERIFIER.test(value) ? new SecretValue(value) : undefined;
}

export function isPkceVerifierShape(verifier: SecretValue): boolean {
  return PKCE_VERIFIER.test(verifier.expose());
}

// ── Authorization request ───────────────────────────────────────────────────────────────────────────────

export interface AuthorizationRequestInput {
  readonly state: OAuthState;
  readonly redirectUri: RedirectUri;
  /** `null` = no PKCE. Must be non-null when the port's `pkce` is `required`, and null when `not_supported`. */
  readonly pkce: PkceChallenge | null;
}

/** Where to send the user. Contains the state, redirect URI and challenge; never a verifier or other secret. */
export interface AuthorizationRequest {
  readonly url: string;
}

// ── Callback ────────────────────────────────────────────────────────────────────────────────────────────

/** The callback's raw query parameters, in order, duplicates preserved. Never passed beyond the adapter. */
export type CallbackQuery = readonly (readonly [string, string])[];

export const CALLBACK_DENIAL_REASONS = ["user_cancelled", "access_denied", "other"] as const;
export type CallbackDenialReason = (typeof CALLBACK_DENIAL_REASONS)[number];

export const CALLBACK_MALFORMED_REASONS = [
  "invalid_query",
  "duplicate_parameter",
  "conflicting_result",
  "missing_result",
  "missing_state",
  "invalid_state",
  "invalid_code",
  "invalid_error",
] as const;
export type CallbackMalformedReason = (typeof CALLBACK_MALFORMED_REASONS)[number];

/**
 * The closed callback outcome. Duplicated security-relevant parameters, a missing state or result, or a
 * success and an error at once are `malformed` (fail closed). The state here is only what the provider sent
 * back: matching it against the persisted attempt is the caller's job. A denial is an outcome, not an error.
 */
export type CallbackOutcome =
  | { readonly kind: "code"; readonly state: OAuthState; readonly code: SecretValue }
  | { readonly kind: "denied"; readonly state: OAuthState; readonly reason: CallbackDenialReason }
  | { readonly kind: "malformed"; readonly reason: CallbackMalformedReason };

const AUTHORIZATION_CODE = /^[\x21-\x7E]{1,2048}$/;

/** An authorization code as received (printable, bounded), wrapped as a secret. */
export function parseAuthorizationCode(value: unknown): SecretValue | undefined {
  return typeof value === "string" && AUTHORIZATION_CODE.test(value) ? new SecretValue(value) : undefined;
}

// ── Code exchange ───────────────────────────────────────────────────────────────────────────────────────

export interface CodeExchangeInput {
  readonly code: SecretValue;
  /** Must equal, exactly, the redirect URI of the authorization request that produced the code. */
  readonly redirectUri: RedirectUri;
  /** The verifier of the challenge used for this code, or `null` when no challenge was used. */
  readonly pkceVerifier: SecretValue | null;
}

const GRANTED_SCOPE = /^[\x21-\x7E]{1,256}$/;

export function isGrantedScope(value: unknown): value is string {
  return typeof value === "string" && GRANTED_SCOPE.test(value);
}

export interface CodeExchangeResult {
  readonly credential: ProviderCredential;
  /** When the provider says the credential expires; `null` when it doesn't say (never "never expires"). */
  readonly expiresAt: IsoInstant | null;
  /** Opaque provider scope identifiers as granted, de-duplicated and sorted. Never interpreted here. */
  readonly grantedScopes: readonly string[];
}

// ── Port ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Errors are the normalized provider errors (./errors) with an authorization operation. For `exchangeCode`:
 * unknown, expired or already-used code and PKCE mismatch → CredentialInvalid; redirect URI mismatch, or PKCE
 * material the provider doesn't support → PermanentRejected(invalid_request); the authorization lacks what a
 * usable connection needs → PermissionMissing; plus RateLimited and Transient (the request definitely didn't
 * take effect). A PKCE contract violation in `authorizationRequest` → PermanentRejected(invalid_request).
 *
 * OutcomeUnknown (existing taxonomy): the request was sent and the response was lost, so the provider MAY have
 * redeemed the code and issued a credential the caller never received. It is never a definite failure: the
 * caller must not assume the code is still usable and must never replay it blindly (no adapter retry either).
 * Product recovery is Step 5D's decision: for a new connection the expected safe path is a fresh
 * authorization, and for re-authorizing an existing connection the currently valid credential must be kept.
 */
export interface ProviderAuthorizationPort {
  readonly provider: ProviderName;
  readonly pkce: PkceSupport;
  authorizationRequest(input: AuthorizationRequestInput): Promise<AuthorizationRequest>;
  /** Pure and total: never throws, never calls the provider. */
  parseCallback(query: CallbackQuery): CallbackOutcome;
  exchangeCode(input: CodeExchangeInput): Promise<ProviderResult<CodeExchangeResult>>;
}

