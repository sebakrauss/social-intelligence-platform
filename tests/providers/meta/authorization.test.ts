/**
 * The Meta Facebook Login for Business authorization adapter (Step 7G-D), offline. Behavior follows the frozen contract
 * in design/phase-7g/meta-provider/README.md (D1): the dialog URL, the callback, the single GET token exchange, the
 * ProviderCredential v1 mapping and Graph error normalization. `fetch` is an in-process double: no request leaves the
 * process. Synthetic values only; Graph error codes are the documented ones (an arbitrary code only exercises the
 * unmapped default).
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  ProviderError,
  SecretValue,
  parseOAuthState,
  parseRedirectUri,
  type CallbackQuery,
  type OAuthState,
  type PkceChallenge,
  type ProviderErrorKind,
  type RedirectUri,
} from "@/integrations/providers/contract";
import { createMetaAuthorizationPort, parseMetaCallback, type MetaAppCredentials } from "@/integrations/providers/meta/authorization";
import { META_GRAPH_VERSION } from "@/integrations/providers/meta/endpoints";
import { META_TOKEN_EXCHANGE_TIMEOUT_MS, META_TOKEN_RESPONSE_MAX_BYTES, createMetaTokenTransport, type MetaFetch, type MetaTokenExchangeRequest, type MetaTokenOutcome, type MetaTokenTransport } from "@/integrations/providers/meta/oauth-transport";

const CLIENT_ID = "synthetic-meta-app-id";
const CONFIG_ID = "synthetic-meta-config-id";
const SECRET_MARKER = "synthetic-meta-app-secret-marker";
const CODE_MARKER = "synthetic-meta-auth-code-marker";
const TOKEN_MARKER = "synthetic-meta-access-token-marker";
const BODY_MARKER = "synthetic-meta-error-body-marker";
const APP: MetaAppCredentials = Object.freeze({ clientId: CLIENT_ID, configId: CONFIG_ID, clientSecret: new SecretValue(SECRET_MARKER) });
const STATE = parseOAuthState(`v1.5eed0000-d1a9-4000-8000-00000000f001.${"S".repeat(43)}`) as OAuthState;
const REDIRECT = parseRedirectUri("https://app.example.test/api/oauth/meta/callback") as RedirectUri;
const NOW = new Date("2026-10-17T12:00:00.000Z");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const renderings = (value: unknown): string => {
  const error = value instanceof Error ? `${value.message} ${value.stack ?? ""} ${String(value.cause)}` : "";
  return [JSON.stringify(value), String(value), inspect(value, { depth: 10, showHidden: true }), error].join(" ");
};
const expectNoneOf = (value: unknown, secrets: readonly string[]): void => {
  const rendered = renderings(value);
  for (const secret of secrets) expect(rendered).not.toContain(secret);
};

async function rejection(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
  throw new Error("expected the call to fail");
}

// ── fetch double ───────────────────────────────────────────────────────────────────────────────────────────────
interface Call {
  readonly url: string;
  readonly init: RequestInit;
}
type Reply = (call: Call) => Promise<Response>;
function fakeFetch(reply: Reply): { readonly fetch: MetaFetch; readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      const call = { url, init };
      calls.push(call);
      return reply(call);
    },
  };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }));
const tokenBody = (overrides: Record<string, unknown> = {}) => ({ access_token: TOKEN_MARKER, token_type: "bearer", expires_in: 5400, ...overrides });
const graphError = (fields: Record<string, unknown>) => ({ error: { message: BODY_MARKER, error_user_msg: BODY_MARKER, fbtrace_id: "synthetic-trace", ...fields } });

function portWith(reply: Reply, options: { readonly timeoutMs?: number; readonly maxResponseBytes?: number } = {}) {
  const double = fakeFetch(reply);
  const transport = createMetaTokenTransport({ fetch: double.fetch, ...options });
  const port = createMetaAuthorizationPort(APP, { transport, now: () => NOW });
  const exchange = (code = CODE_MARKER, redirectUri = REDIRECT) => port.exchangeCode({ code: new SecretValue(code), redirectUri, pkceVerifier: null });
  return { port, calls: double.calls, exchange };
}

describe("Meta authorization port · shape", () => {
  it("is the meta provider, without PKCE, exposing exactly the authorization operations", () => {
    const port = createMetaAuthorizationPort(APP);
    expect(port.provider).toBe("meta");
    expect(port.pkce).toBe("not_supported");
    expect(Object.keys(port).sort()).toEqual(["authorizationRequest", "exchangeCode", "parseCallback", "pkce", "provider"]);
    expect(META_GRAPH_VERSION).toBe("v25.0");
  });
});

describe("Meta authorization port · authorization URL (FLfB dialog)", () => {
  const port = createMetaAuthorizationPort(APP);
  const urlOf = async (): Promise<URL> => new URL((await port.authorizationRequest({ state: STATE, redirectUri: REDIRECT, pkce: null })).url);

  it("is the fixed HTTPS dialog with exactly the six validated parameters, each once, in a fixed order", async () => {
    const url = await urlOf();
    expect(url.origin).toBe("https://www.facebook.com");
    expect(url.pathname).toBe("/v25.0/dialog/oauth");
    expect(url.hash).toBe("");
    expect([...url.searchParams]).toEqual([
      ["client_id", CLIENT_ID],
      ["config_id", CONFIG_ID],
      ["redirect_uri", REDIRECT],
      ["state", STATE],
      ["response_type", "code"],
      ["override_default_response_type", "true"],
    ]);
    for (const name of ["client_id", "config_id", "redirect_uri", "state", "response_type", "override_default_response_type"]) expect(url.searchParams.getAll(name), name).toHaveLength(1);
  });

  it("carries no scope, no PKCE, no secret and no Client Token", async () => {
    const url = await urlOf();
    for (const name of ["scope", "client_secret", "code_challenge", "code_challenge_method", "code_verifier", "client_token", "access_token", "appsecret_proof"]) {
      expect(url.searchParams.has(name), name).toBe(false);
    }
    expect(url.href).not.toContain(SECRET_MARKER);
    expect(url.href.toLowerCase()).not.toContain("token");
  });

  it("round-trips the state and the redirect URI exactly (deterministic encoding)", async () => {
    const withQuery = parseRedirectUri("https://app.example.test/api/oauth/meta/callback?a=b&c=d") as RedirectUri;
    const url = new URL((await port.authorizationRequest({ state: STATE, redirectUri: withQuery, pkce: null })).url);
    expect(url.searchParams.get("state")).toBe(STATE);
    expect(url.searchParams.get("redirect_uri")).toBe(withQuery);
    expect((await port.authorizationRequest({ state: STATE, redirectUri: REDIRECT, pkce: null })).url).toBe((await urlOf()).href);
  });

  it("refuses a PKCE challenge and forged state or redirect URI, without echoing the state", async () => {
    const challenge = { method: "S256", challenge: "A".repeat(43) } as PkceChallenge;
    for (const input of [
      { state: STATE, redirectUri: REDIRECT, pkce: challenge },
      { state: "short" as OAuthState, redirectUri: REDIRECT, pkce: null },
      { state: STATE, redirectUri: "http://app.example.test/callback" as RedirectUri, pkce: null },
    ]) {
      const error = await rejection(port.authorizationRequest(input));
      expect(error.toJSON()).toEqual({ kind: "permanent_rejected", operation: "authorizationRequest", retry: "never", details: { reasonCode: "invalid_request" } });
      expectNoneOf(error, [STATE, SECRET_MARKER]);
    }
  });
});

describe("Meta authorization port · callback (pure, total)", () => {
  const q = (...pairs: (readonly [string, string])[]): CallbackQuery => pairs;

  it("code + state is a code outcome, the code wrapped as a secret", () => {
    const outcome = parseMetaCallback(q(["code", CODE_MARKER], ["state", STATE]));
    expect(outcome.kind).toBe("code");
    if (outcome.kind !== "code") return;
    expect(outcome.state).toBe(STATE);
    expect(outcome.code).toBeInstanceOf(SecretValue);
    expect(outcome.code.expose()).toBe(CODE_MARKER);
    expectNoneOf(outcome, [CODE_MARKER]);
  });

  it("Meta's documented cancellation with a bindable state is a denial; error_description never classifies", () => {
    for (const description of ["Permissions error.", "user_cancelled", "anything"]) {
      expect(parseMetaCallback(q(["error_reason", "user_denied"], ["error", "access_denied"], ["error_description", description], ["state", STATE]))).toEqual({ kind: "denied", state: STATE, reason: "access_denied" });
    }
  });

  it.each([
    ["denial without state", q(["error_reason", "user_denied"], ["error", "access_denied"], ["error_description", "Permissions error."]), "missing_state"],
    ["denial with an unusable state", q(["error_reason", "user_denied"], ["error", "access_denied"], ["state", "x"]), "invalid_state"],
    ["missing code (state only)", q(["state", STATE]), "missing_result"],
    ["missing state", q(["code", CODE_MARKER]), "missing_state"],
    ["empty code", q(["code", ""], ["state", STATE]), "invalid_code"],
    ["empty state", q(["code", CODE_MARKER], ["state", ""]), "invalid_state"],
    ["duplicate code", q(["code", CODE_MARKER], ["code", CODE_MARKER], ["state", STATE]), "duplicate_parameter"],
    ["duplicate state", q(["code", CODE_MARKER], ["state", STATE], ["state", STATE]), "duplicate_parameter"],
    ["code together with an error", q(["code", CODE_MARKER], ["error", "access_denied"], ["state", STATE]), "conflicting_result"],
    ["code together with an error reason", q(["code", CODE_MARKER], ["error_reason", "user_denied"], ["state", STATE]), "conflicting_result"],
    ["duplicate error", q(["error", "access_denied"], ["error", "access_denied"], ["error_reason", "user_denied"], ["state", STATE]), "duplicate_parameter"],
    ["duplicate error reason", q(["error", "access_denied"], ["error_reason", "user_denied"], ["error_reason", "user_denied"], ["state", STATE]), "duplicate_parameter"],
    ["error reason without error", q(["error_reason", "user_denied"], ["state", STATE]), "invalid_error"],
    ["access_denied with another reason", q(["error", "access_denied"], ["error_reason", "something_else"], ["state", STATE]), "invalid_error"],
    ["access_denied without a reason", q(["error", "access_denied"], ["state", STATE]), "invalid_error"],
    ["an unknown provider error", q(["error", "server_error"], ["error_reason", "user_denied"], ["state", STATE]), "invalid_error"],
  ])("%s → malformed (%s)", (_label, query, reason) => {
    const outcome = parseMetaCallback(query);
    expect(outcome).toEqual({ kind: "malformed", reason });
    expectNoneOf(outcome, [CODE_MARKER]);
  });

  it("ignores parameters without security meaning, and garbage is malformed, never an exception", () => {
    expect(parseMetaCallback(q(["code", CODE_MARKER], ["state", STATE], ["x_unrelated", "1"])).kind).toBe("code");
    for (const garbage of [[], [["", ""]], [["state"]], [[1, 2]], "code=x", null] as unknown[]) {
      expect(parseMetaCallback(garbage as CallbackQuery).kind).toBe("malformed");
    }
  });
});

describe("Meta authorization port · token exchange", () => {
  it("one GET to the fixed token endpoint with exactly client_id, redirect_uri, client_secret and code", async () => {
    const { calls, exchange } = portWith(() => json(200, tokenBody()));
    await exchange();
    expect(calls).toHaveLength(1);
    const [call] = calls as [Call];
    const url = new URL(call.url);
    expect(url.origin).toBe("https://graph.facebook.com");
    expect(url.pathname).toBe("/v25.0/oauth/access_token");
    expect([...url.searchParams]).toEqual([
      ["client_id", CLIENT_ID],
      ["redirect_uri", REDIRECT],
      ["client_secret", SECRET_MARKER],
      ["code", CODE_MARKER],
    ]);
    for (const name of ["config_id", "scope", "client_token", "appsecret_proof", "code_verifier", "grant_type"]) expect(url.searchParams.has(name), name).toBe(false);
    expect(call.init.method).toBe("GET");
    expect(call.init.redirect).toBe("manual");
    expect(call.init.credentials).toBe("omit");
    expect(call.init.body).toBeUndefined();
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(call.init.signal?.aborted).toBe(false);
    expect(META_TOKEN_EXCHANGE_TIMEOUT_MS).toBe(10_000);
    expect(META_TOKEN_RESPONSE_MAX_BYTES).toBe(65_536);
    expect(Object.keys(call.init.headers ?? {})).toEqual(["accept"]);
  });

  it("the App Secret and the code reach the transport still wrapped: only the request URL holds them in clear", async () => {
    const seen: MetaTokenExchangeRequest[] = [];
    const spy: MetaTokenTransport = { exchange: (request) => { seen.push(request); return Promise.resolve<MetaTokenOutcome>({ kind: "token", accessToken: new SecretValue(TOKEN_MARKER), expiresInSeconds: 60 }); } };
    const port = createMetaAuthorizationPort(APP, { transport: spy, now: () => NOW });
    await port.exchangeCode({ code: new SecretValue(CODE_MARKER), redirectUri: REDIRECT, pkceVerifier: null });
    expect(seen).toHaveLength(1);
    const [request] = seen as [MetaTokenExchangeRequest];
    expect(request.clientSecret).toBeInstanceOf(SecretValue);
    expect(request.code).toBeInstanceOf(SecretValue);
    expect(request.redirectUri).toBe(REDIRECT);
    expectNoneOf(request, [SECRET_MARKER, CODE_MARKER]);
  });

  it("a valid response maps to a ProviderCredential v1 with an opaque UUID, the token as its secret, the expiry and no scopes", async () => {
    const { exchange } = portWith(() => json(200, tokenBody()));
    const result = await exchange();
    expect(result.budget).toEqual({ kind: "not_reported" });
    const { credential, expiresAt, grantedScopes } = result.data;
    expect(Object.keys(result.data).sort()).toEqual(["credential", "expiresAt", "grantedScopes"]);
    expect(credential.id).toMatch(UUID);
    for (const other of [TOKEN_MARKER, CLIENT_ID, CONFIG_ID, CODE_MARKER]) expect(credential.id).not.toContain(other);
    expect(credential.secret).toBeInstanceOf(SecretValue);
    expect(credential.secret.expose()).toBe(TOKEN_MARKER);
    expect(expiresAt).toBe("2026-10-17T13:30:00.000Z");
    expect(grantedScopes).toEqual([]);
    expectNoneOf(result, [TOKEN_MARKER, SECRET_MARKER, CODE_MARKER]);
  });

  it("each exchange gets a fresh opaque identifier and always a known, positive expiry (never null)", async () => {
    const { exchange } = portWith(() => json(200, tokenBody({ expires_in: 60 })));
    const first = await exchange();
    const second = await exchange();
    expect(first.data.credential.id).not.toBe(second.data.credential.id);
    for (const result of [first, second]) {
      expect(result.data.expiresAt).not.toBeNull();
      expect(result.data.expiresAt).toBe("2026-10-17T12:01:00.000Z");
    }
  });

  it("expires_in at the ten-year bound is still accepted (the bound is inclusive)", async () => {
    const { exchange } = portWith(() => json(200, tokenBody({ expires_in: 10 * 365 * 24 * 3600 })));
    expect((await exchange()).data.expiresAt).toBe(new Date(NOW.getTime() + 10 * 365 * 24 * 3600 * 1000).toISOString());
  });

  it("refuses a PKCE verifier and a forged redirect URI before any request", async () => {
    const { calls, port } = portWith(() => json(200, tokenBody()));
    for (const input of [
      { code: new SecretValue(CODE_MARKER), redirectUri: REDIRECT, pkceVerifier: new SecretValue("v".repeat(43)) },
      { code: new SecretValue(CODE_MARKER), redirectUri: "http://app.example.test/x" as RedirectUri, pkceVerifier: null },
    ]) {
      const error = await rejection(port.exchangeCode(input));
      expect(error.toJSON().details).toEqual({ reasonCode: "invalid_request" });
    }
    expect(calls).toHaveLength(0);
  });

  const ambiguous: readonly (readonly [string, Reply, { readonly timeoutMs?: number; readonly maxResponseBytes?: number }])[] = [
    ["a network error", () => Promise.reject(new TypeError(`fetch failed ${BODY_MARKER}`)), {}],
    ["a timeout", (call) => new Promise((_resolve, reject) => { call.init.signal?.addEventListener("abort", () => { reject(new Error(BODY_MARKER)); }); }), { timeoutMs: 20 }],
    ["a 5xx without a Graph error", () => Promise.resolve(new Response(`<html>${BODY_MARKER}</html>`, { status: 502 })), {}],
    ["a redirect", () => Promise.resolve(new Response(null, { status: 302, headers: { location: "https://elsewhere.example.test/" } })), {}],
    ["an oversized body (declared)", () => json(200, tokenBody(), { "content-length": "999999" }), { maxResponseBytes: 128 }],
    ["an oversized body (streamed)", () => Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(tokenBody({ padding: "x".repeat(200) })))); controller.close(); } }), { status: 200 })), { maxResponseBytes: 128 }],
    ["malformed JSON", () => Promise.resolve(new Response(`{"access_token": "${TOKEN_MARKER}"`, { status: 200 })), {}],
    ["invalid UTF-8", () => Promise.resolve(new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200 })), {}],
    ["a JSON array", () => json(200, [tokenBody()]), {}],
    ["a missing access_token", () => json(200, tokenBody({ access_token: undefined })), {}],
    ["an empty access_token", () => json(200, tokenBody({ access_token: "" })), {}],
    ["an access_token with whitespace", () => json(200, tokenBody({ access_token: `${TOKEN_MARKER} x` })), {}],
    ["a non-string token_type", () => json(200, tokenBody({ token_type: 1 })), {}],
    ["a missing expires_in (no default lifetime is invented)", () => json(200, tokenBody({ expires_in: undefined })), {}],
    ["a null expires_in", () => json(200, tokenBody({ expires_in: null })), {}],
    ["a boolean expires_in", () => json(200, tokenBody({ expires_in: true })), {}],
    ["expires_in = 0", () => json(200, tokenBody({ expires_in: 0 })), {}],
    ["expires_in < 0", () => json(200, tokenBody({ expires_in: -1 })), {}],
    ["fractional expires_in", () => json(200, tokenBody({ expires_in: 1.5 })), {}],
    ["string expires_in", () => json(200, tokenBody({ expires_in: "5400" })), {}],
    ["absurd expires_in", () => json(200, tokenBody({ expires_in: Number.MAX_SAFE_INTEGER })), {}],
    ["expires_in just above the ten-year bound", () => json(200, tokenBody({ expires_in: 10 * 365 * 24 * 3600 + 1 })), {}],
    ["a non-finite expires_in (JSON overflow)", () => Promise.resolve(new Response(`{"access_token":"${TOKEN_MARKER}","token_type":"bearer","expires_in":1e400}`, { status: 200 })), {}],
    ["a 4xx that is not a Graph error", () => json(400, { message: BODY_MARKER }), {}],
  ];

  it.each(ambiguous)("%s → OutcomeUnknown after exactly one request (no retry), leaking nothing", async (_label, reply, options) => {
    const { calls, exchange } = portWith(reply, options);
    const error = await rejection(exchange());
    expect(error.toJSON()).toEqual({ kind: "outcome_unknown", operation: "exchangeCode", retry: "verify_first", details: {} });
    expect(calls).toHaveLength(1);
    const [call] = calls as [Call];
    expectNoneOf(error, [SECRET_MARKER, CODE_MARKER, TOKEN_MARKER, BODY_MARKER, call.url, "graph.facebook.com", "client_secret"]);
  });
});

describe("Meta authorization port · Graph error normalization (documented codes)", () => {
  const cases: readonly (readonly [string, number, Record<string, unknown>, ProviderErrorKind, Record<string, string | number | null>])[] = [
    ["190 / 463 expired", 400, { type: "OAuthException", code: 190, error_subcode: 463 }, "credential_invalid", { reason: "expired" }],
    ["190 / 458 app not authorized", 400, { type: "OAuthException", code: 190, error_subcode: 458 }, "credential_invalid", { reason: "revoked" }],
    ["190 / 460 logged out or password changed", 400, { type: "OAuthException", code: 190, error_subcode: 460 }, "credential_invalid", { reason: "revoked" }],
    ["190 without subcode", 400, { type: "OAuthException", code: 190 }, "credential_invalid", { reason: "unknown" }],
    ["102 session", 400, { code: 102 }, "credential_invalid", { reason: "unknown" }],
    ["an OAuthException with another code", 400, { type: "OAuthException", code: 100 }, "credential_invalid", { reason: "unknown" }],
    ["4 app rate limit", 400, { type: "OAuthException", code: 4 }, "rate_limited", { retryAfterSeconds: null }],
    ["17 user rate limit", 400, { code: 17 }, "rate_limited", { retryAfterSeconds: null }],
    ["80004 business use case", 400, { code: 80004 }, "rate_limited", { retryAfterSeconds: null }],
    ["10 permission", 403, { type: "OAuthException", code: 10 }, "permission_missing", { capability: "discover_assets" }],
    ["200 permission", 403, { code: 200 }, "permission_missing", { capability: "discover_assets" }],
    ["299 permission", 403, { code: 299 }, "permission_missing", { capability: "discover_assets" }],
    ["1 temporary", 500, { code: 1 }, "transient", { reason: "provider_unavailable" }],
    ["2 temporary", 503, { code: 2 }, "transient", { reason: "provider_unavailable" }],
    ["368 policy block", 400, { code: 368 }, "permanent_rejected", { reasonCode: "content_policy" }],
    ["an unmapped Graph error (default branch)", 400, { type: "GraphMethodException", code: 987654 }, "permanent_rejected", { reasonCode: "unknown" }],
  ];

  it.each(cases)("%s → %s, one request, no provider text", async (_label, status, fields, kind, details) => {
    const { calls, exchange } = portWith(() => json(status, graphError(fields)));
    const error = await rejection(exchange());
    expect(error.kind).toBe(kind);
    expect(error.operation).toBe("exchangeCode");
    expect(error.toJSON().details).toEqual(details);
    expect(calls).toHaveLength(1);
    expectNoneOf(error, [BODY_MARKER, "synthetic-trace", SECRET_MARKER, CODE_MARKER]);
  });
});
