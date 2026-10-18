/**
 * Meta implementation of the provider AUTHORIZATION port: Facebook Login for Business with a User Access Token
 * configuration (Step 7G-D; design/phase-7g/meta-provider/README.md, D1 — the implementation authority).
 *
 *   - Dialog: https://www.facebook.com/v25.0/dialog/oauth with exactly client_id, config_id, redirect_uri, state,
 *     response_type=code and override_default_response_type=true (a user-token configuration defaults to the
 *     implicit grant; the override makes response_type govern). No scope (the configuration carries the
 *     permissions), no PKCE (not supported in the first slice), never a secret.
 *   - Callback: `code` + `state` on success. The one recognized denial is Meta's documented cancellation,
 *     error=access_denied with error_reason=user_denied, and only with a bindable state; every other shape is
 *     malformed. error_description and unknown parameters are ignored and never surfaced.
 *   - Exchange: exactly one GET to the token endpoint (./oauth-transport), never retried here. A token becomes a
 *     ProviderCredential v1: a locally generated opaque UUID (never derived from the token, the app or a Meta
 *     account) and the access token as its SecretValue. The expiry comes from expires_in, which a successful
 *     response must carry: never null, never a default. Granted scopes are not reported by the exchange, so they are
 *     empty (capability reads them later). No long-lived exchange, no refresh.
 *
 * Errors are the normalized taxonomy only (./errors). A response that might have redeemed the code without our
 * receiving the credential — no response, timeout, redirect, unreadable or unexpected body — is OutcomeUnknown.
 */
import { randomUUID } from "node:crypto";
import {
  parseAuthorizationCode,
  parseOAuthState,
  parseRedirectUri,
  type CallbackMalformedReason,
  type CallbackOutcome,
  type CallbackQuery,
  type ProviderAuthorizationPort,
} from "../contract/authorization-port";
import { providerCredential, type SecretValue } from "../contract/credential";
import { OutcomeUnknownError, PermanentRejectedError } from "../contract/errors";
import { isoInstant } from "../contract/identity";
import { BUDGET_NOT_REPORTED } from "../contract/pagination";
import { META_DIALOG_URL } from "./endpoints";
import { metaGraphError } from "./errors";
import { createMetaTokenTransport, type MetaTokenTransport } from "./oauth-transport";

/** The Meta app configuration the hosted web composes this port with (and nothing else). */
export interface MetaAppCredentials {
  readonly clientId: string;
  readonly configId: string;
  readonly clientSecret: SecretValue;
}

export interface MetaAuthorizationPortOptions {
  readonly transport?: MetaTokenTransport;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

const SECURITY_PARAMETERS: ReadonlySet<string> = new Set(["code", "state", "error", "error_reason"]);

function malformed(reason: CallbackMalformedReason): CallbackOutcome {
  return Object.freeze({ kind: "malformed", reason });
}

/** Normalizes Meta's callback query. Pure and total: never throws. */
export function parseMetaCallback(query: CallbackQuery): CallbackOutcome {
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
  const errorReason = seen.get("error_reason");
  if (code !== undefined && (error !== undefined || errorReason !== undefined)) return malformed("conflicting_result");
  if (code === undefined && error === undefined) return malformed(errorReason === undefined ? "missing_result" : "invalid_error");
  const rawState = seen.get("state");
  if (rawState === undefined) return malformed("missing_state");
  const state = parseOAuthState(rawState);
  if (state === undefined) return malformed("invalid_state");
  if (code !== undefined) {
    const secret = parseAuthorizationCode(code);
    return secret === undefined ? malformed("invalid_code") : Object.freeze({ kind: "code", state, code: secret });
  }
  if (error === "access_denied" && errorReason === "user_denied") return Object.freeze({ kind: "denied", state, reason: "access_denied" });
  return malformed("invalid_error");
}

export function createMetaAuthorizationPort(app: MetaAppCredentials, options: MetaAuthorizationPortOptions = {}): ProviderAuthorizationPort {
  const transport = options.transport ?? createMetaTokenTransport();
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const { clientId, configId, clientSecret } = app;

  return {
    provider: "meta",
    pkce: "not_supported",

    authorizationRequest(input) {
      // Branded types can be forged with a cast: re-validate at the boundary.
      if (input.pkce !== null || parseOAuthState(input.state) === undefined || parseRedirectUri(input.redirectUri) === undefined) {
        return Promise.reject(new PermanentRejectedError("authorizationRequest", "invalid_request"));
      }
      const url = new URL(META_DIALOG_URL);
      url.search = new URLSearchParams([
        ["client_id", clientId],
        ["config_id", configId],
        ["redirect_uri", input.redirectUri],
        ["state", input.state],
        ["response_type", "code"],
        ["override_default_response_type", "true"],
      ]).toString();
      return Promise.resolve(Object.freeze({ url: url.href }));
    },

    parseCallback: parseMetaCallback,

    async exchangeCode(input) {
      const operation = "exchangeCode";
      if (input.pkceVerifier !== null || parseRedirectUri(input.redirectUri) === undefined) throw new PermanentRejectedError(operation, "invalid_request");
      const outcome = await transport.exchange({ clientId, clientSecret, redirectUri: input.redirectUri, code: input.code });
      if (outcome.kind === "ambiguous") throw new OutcomeUnknownError(operation);
      if (outcome.kind === "graph_error") throw metaGraphError(operation, outcome.error, "discover_assets");
      const expiresAt = isoInstant(new Date(now().getTime() + outcome.expiresInSeconds * 1000));
      const credential = providerCredential(newId(), outcome.accessToken.expose());
      return Object.freeze({
        data: Object.freeze({ credential, expiresAt, grantedScopes: Object.freeze([]) }),
        budget: BUDGET_NOT_REPORTED,
      });
    },
  };
}
