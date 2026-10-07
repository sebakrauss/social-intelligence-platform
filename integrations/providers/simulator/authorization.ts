/**
 * Simulator implementation of the provider AUTHORIZATION port (authorization-code grant), plus the simulated
 * consent screen that turns an authorization URL into the callback redirect. Deterministic, no network: the
 * authorization URL points at `simulator.invalid` (a reserved name that never resolves) and is never fetched.
 *
 * Everything below is SIMULATOR CONTRACT BEHAVIOR: executable evidence that the product contract is coherent,
 * NOT evidence that Meta or TikTok implement OAuth this way. Real OAuth flavor, PKCE support, scopes, app
 * review and authorization continuity stay VALIDATE (PD OQ-18, OQ-19, OQ-26, OQ-27).
 *
 *   - PKCE: the scenario's mode, overridable per port instance; S256 only.
 *   - Authorization URL: fixed endpoint, parameters in a fixed order (deterministic for the same input).
 *   - Callback wire format: `code`, `state`, `error` (RFC 6749 names). `error=user_cancelled` (a simulator code)
 *     → user_cancelled, `error=access_denied` → access_denied, any other error token → other. A repeated
 *     `code`/`state`/`error`, or `code` together with `error`, is malformed. `error_description` and unknown
 *     parameters are ignored: they carry no security meaning and are never surfaced.
 *   - Codes are single-use and expire after `codeLifetimeSeconds`. A code is consumed ONLY when a credential is
 *     issued: a failed exchange (redirect URI mismatch, PKCE mismatch, missing permission, injected transient or
 *     rate limit) leaves it redeemable by a correct exchange. Unknown, expired and already-used codes are
 *     terminal.
 *   - Response lost after the exchange (preset `exchange_response_lost`): the simulated provider REDEEMS the code
 *     and issues a credential, then the response is lost → OutcomeUnknown. The code is consumed, so a later
 *     replay fails with CredentialInvalid(revoked); that is one possible provider behavior, not evidence that
 *     replaying codes is safe or unsafe anywhere else. Credentials issued earlier are untouched.
 *   - A grant without `sim.discover_assets` can't produce a usable connection: PermissionMissing.
 *   - Error mapping: unknown code → CredentialInvalid(unknown) · expired → CredentialInvalid(expired) · reused →
 *     CredentialInvalid(revoked) · PKCE mismatch → CredentialInvalid(unknown) · redirect URI mismatch or PKCE
 *     material in not_supported mode → PermanentRejected(invalid_request).
 *   - No retry inside the port: one exchange = one simulated token-endpoint call (one journal entry).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import {
  isPkceVerifierShape,
  parseAuthorizationCode,
  parseOAuthState,
  parsePkceChallenge,
  parseRedirectUri,
  type CallbackDenialReason,
  type CallbackMalformedReason,
  type CallbackOutcome,
  type CallbackQuery,
  type CodeExchangeInput,
  type CodeExchangeResult,
  type PkceSupport,
  type ProviderAuthorizationPort,
} from "../contract/authorization-port";
import { providerCredential, type SecretValue } from "../contract/credential";
import { CredentialInvalidError, PermanentRejectedError, PermissionMissingError, type AuthorizationOperation } from "../contract/errors";
import { isoInstant } from "../contract/identity";
import type { ScenarioAuthorization } from "./scenario";
import { asPromise, simulatedPermission, type SimulatorWorld } from "./world";

export const SIM_AUTHORIZE_ENDPOINT = "https://simulator.invalid/oauth/authorize";

/** The scope a grant needs for the simulated provider to issue a usable credential. */
const REQUIRED_SCOPE = simulatedPermission("discover_assets");

const SECURITY_PARAMETERS: ReadonlySet<string> = new Set(["code", "state", "error"]);
const ERROR_TOKEN = /^[a-z][a-z0-9_]{0,63}$/;

export interface SimulatorAuthorizationPortOptions {
  /** Overrides the scenario's PKCE mode (to exercise every mode against one scenario). */
  readonly pkce?: PkceSupport;
}

/** What the simulated user does on the consent screen. */
export type SimulatedConsent =
  | { readonly kind: "grant"; readonly grant: string }
  | { readonly kind: "deny"; readonly error: "access_denied" | "user_cancelled" | "server_error" };

function serverOf(world: SimulatorWorld): ScenarioAuthorization {
  const server = world.scenario.authorization;
  if (server === null) throw new TypeError("scenario has no simulated authorization server");
  return server;
}

const invalidRequest = (operation: AuthorizationOperation) => new PermanentRejectedError(operation, "invalid_request");

export function createSimulatorAuthorizationPort(world: SimulatorWorld, options: SimulatorAuthorizationPortOptions = {}): ProviderAuthorizationPort {
  const server = serverOf(world);
  const pkce = options.pkce ?? server.pkce;

  return {
    provider: "simulator",
    pkce,

    authorizationRequest(input) {
      return asPromise(() => {
        if (pkce === "required" && input.pkce === null) throw invalidRequest("authorizationRequest");
        if (pkce === "not_supported" && input.pkce !== null) throw invalidRequest("authorizationRequest");
        // Branded types can be forged with a cast: re-validate at the boundary.
        if (parseOAuthState(input.state) === undefined || parseRedirectUri(input.redirectUri) === undefined) throw invalidRequest("authorizationRequest");
        const method: unknown = input.pkce?.method;
        if (input.pkce !== null && (method !== "S256" || parsePkceChallenge(input.pkce.challenge) === undefined)) {
          throw invalidRequest("authorizationRequest");
        }
        const params = new URLSearchParams([
          ["response_type", "code"],
          ["client_id", server.clientId],
          ["redirect_uri", input.redirectUri],
          ["scope", server.requestedScopes.join(" ")],
          ["state", input.state],
        ]);
        if (input.pkce !== null) {
          params.append("code_challenge", input.pkce.challenge);
          params.append("code_challenge_method", "S256");
        }
        return Object.freeze({ url: `${SIM_AUTHORIZE_ENDPOINT}?${params.toString()}` });
      });
    },

    parseCallback: parseSimulatorCallback,

    exchangeCode(input) {
      return asPromise(() => world.executeAuthorization("exchangeCode", () => exchange(world, server, pkce, input)));
    },
  };
}

function malformed(reason: CallbackMalformedReason): CallbackOutcome {
  return Object.freeze({ kind: "malformed", reason });
}

/** Normalizes the simulated callback query. Pure and total: never throws. */
export function parseSimulatorCallback(query: CallbackQuery): CallbackOutcome {
  const entries: unknown = query;
  if (!Array.isArray(entries)) return malformed("invalid_query");
  const seen = new Map<string, string>();
  for (const entry of entries as readonly unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) return malformed("invalid_query");
    const [name, value] = entry as readonly unknown[];
    if (typeof name !== "string" || typeof value !== "string") return malformed("invalid_query");
    if (!SECURITY_PARAMETERS.has(name)) continue;
    if (seen.has(name)) return malformed("duplicate_parameter");
    seen.set(name, value);
  }
  const code = seen.get("code");
  const error = seen.get("error");
  if (code !== undefined && error !== undefined) return malformed("conflicting_result");
  const rawState = seen.get("state");
  if (code === undefined && error === undefined) return malformed("missing_result");
  if (rawState === undefined) return malformed("missing_state");
  const state = parseOAuthState(rawState);
  if (state === undefined) return malformed("invalid_state");
  if (code !== undefined) {
    const secret = parseAuthorizationCode(code);
    return secret === undefined ? malformed("invalid_code") : Object.freeze({ kind: "code", state, code: secret });
  }
  if (error === undefined || !ERROR_TOKEN.test(error)) return malformed("invalid_error");
  const reason: CallbackDenialReason = error === "user_cancelled" ? "user_cancelled" : error === "access_denied" ? "access_denied" : "other";
  return Object.freeze({ kind: "denied", state, reason });
}

function pkceMatches(challenge: string | null, verifier: SecretValue | null): boolean {
  if (challenge === null) return verifier === null;
  if (verifier === null) return false;
  const derived = Buffer.from(createHash("sha256").update(verifier.expose(), "ascii").digest("base64url"), "ascii");
  const expected = Buffer.from(challenge, "ascii");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function exchange(world: SimulatorWorld, server: ScenarioAuthorization, pkce: PkceSupport, input: CodeExchangeInput): CodeExchangeResult {
  const operation = "exchangeCode";
  if (parseRedirectUri(input.redirectUri) === undefined) throw invalidRequest(operation);
  if (pkce === "not_supported" && input.pkceVerifier !== null) throw invalidRequest(operation);
  if (input.pkceVerifier !== null && !isPkceVerifierShape(input.pkceVerifier)) throw invalidRequest(operation);

  const issued = world.authorizationCode(input.code.expose());
  if (issued === undefined) throw new CredentialInvalidError(operation, "unknown");
  if (issued.consumed) throw new CredentialInvalidError(operation, "revoked");
  if (world.nowMs() >= issued.expiresAtMs) throw new CredentialInvalidError(operation, "expired");
  if (issued.redirectUri !== input.redirectUri) throw invalidRequest(operation);
  if (!pkceMatches(issued.challenge, input.pkceVerifier)) throw new CredentialInvalidError(operation, "unknown");
  const grant = server.grants.find((g) => g.id === issued.grant);
  if (grant === undefined) throw new TypeError("unknown simulated grant");
  if (!grant.scopes.includes(REQUIRED_SCOPE)) throw new PermissionMissingError(operation, "discover_assets");

  issued.consumed = true;
  const expiresAt = server.credentialLifetimeSeconds === null ? null : isoInstant(new Date(world.nowMs() + server.credentialLifetimeSeconds * 1000));
  const credential = world.issueCredential(grant.assets, expiresAt);
  return Object.freeze({
    credential: providerCredential(credential.id, credential.secret),
    expiresAt,
    grantedScopes: Object.freeze([...new Set(grant.scopes)].sort()),
  });
}

/**
 * The simulated consent screen: validates the authorization URL the port built, then either issues a code for
 * `consent.grant` or denies, and returns the URL the provider would redirect the browser to. Test/dev only.
 */
export function simulateConsent(world: SimulatorWorld, authorizationUrl: string, consent: SimulatedConsent): string {
  const server = serverOf(world);
  const refuse = (): never => {
    throw new TypeError("invalid simulated authorization request");
  };
  if (!authorizationUrl.startsWith(`${SIM_AUTHORIZE_ENDPOINT}?`) || !URL.canParse(authorizationUrl)) refuse();
  const params = new URL(authorizationUrl).searchParams;
  const optional = (name: string): string | undefined => {
    const values = params.getAll(name);
    return values.length > 1 ? refuse() : values[0];
  };
  const one = (name: string): string => optional(name) ?? refuse();

  if (one("response_type") !== "code" || one("client_id") !== server.clientId) refuse();
  const redirectUri = parseRedirectUri(one("redirect_uri")) ?? refuse();
  const state = parseOAuthState(one("state")) ?? refuse();
  const challenge = optional("code_challenge");
  const method = optional("code_challenge_method");
  if ((challenge === undefined) !== (method === undefined)) refuse();
  if (challenge !== undefined && (method !== "S256" || parsePkceChallenge(challenge) === undefined)) refuse();

  const callback = new URLSearchParams();
  if (consent.kind === "deny") {
    callback.append("error", consent.error);
  } else {
    if (!server.grants.some((g) => g.id === consent.grant)) throw new TypeError("unknown simulated grant");
    const code = world.issueAuthorizationCode({
      grant: consent.grant,
      redirectUri,
      challenge: challenge ?? null,
      expiresAtMs: world.nowMs() + server.codeLifetimeSeconds * 1000,
    });
    callback.append("code", code);
  }
  callback.append("state", state);
  // Callback parameters are added to the redirect URI's own query component (kept exactly as registered).
  const separator = !redirectUri.includes("?") ? "?" : redirectUri.endsWith("?") ? "" : "&";
  return `${redirectUri}${separator}${callback.toString()}`;
}
