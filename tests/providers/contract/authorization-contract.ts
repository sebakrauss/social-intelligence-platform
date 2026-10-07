/**
 * PROVIDER AUTHORIZATION CONTRACT SUITE (TA §53, §54; Step 5C). Every adapter's authorization port must pass it:
 * the simulator in each PKCE mode now, real Meta / TikTok adapters later (from recorded, sanitized exchanges).
 * It asserts only what the contract guarantees; simulator-only behavior (single-use details, URL format,
 * determinism) lives in tests/providers/simulator/authorization.test.ts.
 */
import { inspect } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CALLBACK_MALFORMED_REASONS,
  PKCE_SUPPORT,
  PROVIDER_NAMES,
  ProviderError,
  SecretValue,
  isDefiniteFailure,
  isGrantedScope,
  parseIsoInstant,
  parseProviderObjectId,
  parseRedirectUri,
  type CallbackOutcome,
  type CallbackQuery,
  type OAuthState,
  type ProviderErrorKind,
  type RedirectUri,
} from "@/integrations/providers/contract";
import { pkcePair, type PkcePair } from "../support/pkce";
import { expectResult } from "./assertions";
import { REQUIRED_MALFORMED_CALLBACKS, type AuthorizationContractHarness, type ConsentDecision } from "./harness";

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

/** Every rendering a log line, error report or debugger could produce. */
function renderings(value: unknown): string {
  const error = value instanceof Error ? `${value.message} ${value.stack ?? ""}` : "";
  return [JSON.stringify(value), String(value), inspect(value, { depth: 10, showHidden: true }), error].join(" ");
}

function expectNoneOf(value: unknown, secrets: readonly string[]): void {
  const rendered = renderings(value);
  for (const secret of secrets) expect(rendered).not.toContain(secret);
}

const callbackQueryOf = (redirect: string): CallbackQuery => [...new URL(redirect).searchParams];

export function defineAuthorizationContractSuite(makeHarness: () => AuthorizationContractHarness): void {
  const h = makeHarness();
  const mode = h.port.pkce;

  /** Starts an authorization; with PKCE when the mode requires it or `withPkce` asks for it. */
  const start = async (withPkce = mode === "required", marker = "contract-verifier-marker", redirectUri = h.redirectUri) => {
    const state = h.newState();
    const pkce: PkcePair | null = withPkce ? pkcePair(marker) : null;
    const request = await h.port.authorizationRequest({ state, redirectUri, pkce: pkce?.challenge ?? null });
    return { state, pkce, request };
  };

  const authorize = async (decision: ConsentDecision = "grant", withPkce?: boolean, redirectUri?: RedirectUri) => {
    const started = await start(withPkce, undefined, redirectUri);
    const redirect = h.consent(started.request.url, decision);
    return { ...started, redirect, outcome: h.port.parseCallback(callbackQueryOf(redirect)) };
  };

  const codeOf = (outcome: CallbackOutcome): SecretValue => {
    if (outcome.kind !== "code") throw new Error(`expected a code callback, got ${outcome.kind}`);
    return outcome.code;
  };

  const expectProviderError = (error: unknown, kind: ProviderErrorKind): ProviderError => {
    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.kind).toBe(kind);
    expect(providerError.message).toBe(`provider_${kind}`);
    expect(Object.keys(providerError.toJSON()).sort()).toEqual(["details", "kind", "operation", "retry"]);
    expectNoneOf(providerError, h.secrets);
    return providerError;
  };

  describe(`provider authorization contract · ${h.name}`, () => {
    beforeEach(async () => {
      await h.reset();
    });

    describe("1 · port shape", () => {
      it("names a known provider and a PKCE mode, and exposes exactly the authorization operations", () => {
        expect(PROVIDER_NAMES).toContain(h.port.provider);
        expect(h.port.provider).toBe(h.provider);
        expect(PKCE_SUPPORT).toContain(h.port.pkce);
        expect(Object.keys(h.port).sort()).toEqual(["authorizationRequest", "exchangeCode", "parseCallback", "pkce", "provider"]);
      });
    });

    describe("2 · authorization request", () => {
      it("returns the authorization URL only", async () => {
        const { request } = await start();
        expect(Object.keys(request)).toEqual(["url"]);
        expect(URL.canParse(request.url)).toBe(true);
      });

      it("propagates state and redirect URI exactly through the provider round trip", async () => {
        const { state, redirect, outcome } = await authorize("grant");
        const landed = new URL(redirect);
        expect(`${landed.origin}${landed.pathname}`).toBe(h.redirectUri);
        expect(outcome.kind).toBe("code");
        if (outcome.kind === "code") expect(outcome.state).toBe(state);
      });

      it("never carries the PKCE verifier", async () => {
        if (mode === "not_supported") return;
        const { request, pkce } = await start(true, "verifier-in-url-marker");
        expect(pkce).not.toBeNull();
        if (pkce !== null) expect(request.url).not.toContain(pkce.raw);
      });

      it(`enforces PKCE mode "${mode}" on the request`, async () => {
        const state = h.newState();
        const challenge = pkcePair("mode-check").challenge;
        const withChallenge = h.port.authorizationRequest({ state, redirectUri: h.redirectUri, pkce: challenge });
        const without = h.port.authorizationRequest({ state, redirectUri: h.redirectUri, pkce: null });
        if (mode === "required") {
          await expect(withChallenge).resolves.toBeDefined();
          const error = expectProviderError(await rejection(without), "permanent_rejected");
          expect(error.toJSON().details).toEqual({ reasonCode: "invalid_request" });
        } else if (mode === "supported") {
          await expect(withChallenge).resolves.toBeDefined();
          await expect(without).resolves.toBeDefined();
        } else {
          await expect(without).resolves.toBeDefined();
          const error = expectProviderError(await rejection(withChallenge), "permanent_rejected");
          expect(error.toJSON().details).toEqual({ reasonCode: "invalid_request" });
        }
      });
    });

    describe("3 · callback", () => {
      it("a granted authorization yields a code outcome with the code wrapped as a secret", async () => {
        const { outcome } = await authorize("grant");
        expect(outcome.kind).toBe("code");
        const code = codeOf(outcome);
        expect(code).toBeInstanceOf(SecretValue);
        expect(Object.keys(outcome).sort()).toEqual(["code", "kind", "state"]);
        expectNoneOf(outcome, [code.expose()]);
      });

      it("a cancelled or refused consent is a denial with the state, not an error", async () => {
        const cancelled = await authorize("cancel");
        expect(cancelled.outcome).toEqual({ kind: "denied", state: cancelled.state, reason: "user_cancelled" });
        const refused = await authorize("deny");
        expect(refused.outcome).toEqual({ kind: "denied", state: refused.state, reason: "access_denied" });
      });

      for (const name of REQUIRED_MALFORMED_CALLBACKS) {
        it(`fails closed as malformed: ${name}`, () => {
          const outcome = h.port.parseCallback(h.malformedCallbacks[name]);
          expect(outcome.kind).toBe("malformed");
          expect(Object.keys(outcome).sort()).toEqual(["kind", "reason"]);
          if (outcome.kind === "malformed") expect(CALLBACK_MALFORMED_REASONS).toContain(outcome.reason);
        });
      }

      it("ignores parameters without security meaning", async () => {
        const { state, redirect } = await authorize("grant");
        const outcome = h.port.parseCallback([...callbackQueryOf(redirect), ["x_contract_unrelated", "1"]]);
        expect(outcome.kind).toBe("code");
        if (outcome.kind === "code") expect(outcome.state).toBe(state);
      });

      it("is total: garbage input is malformed, never an exception", () => {
        for (const garbage of [[], [["", ""]], [["state"]], [[1, 2]], "code=x", null] as unknown[]) {
          expect(h.port.parseCallback(garbage as CallbackQuery).kind).toBe("malformed");
        }
      });
    });

    describe("4 · code exchange", () => {
      const exchange = (code: SecretValue, verifier: SecretValue | null, redirectUri = h.redirectUri) =>
        h.port.exchangeCode({ code, redirectUri, pkceVerifier: verifier });

      it("returns a normalized credential, expiry and opaque scopes", async () => {
        const { outcome, pkce } = await authorize("grant");
        const result = expectResult(await exchange(codeOf(outcome), pkce?.verifier ?? null));
        expect(Object.keys(result).sort()).toEqual(["credential", "expiresAt", "grantedScopes"]);
        expect(Object.keys(result.credential).sort()).toEqual(["id", "secret"]);
        expect(parseProviderObjectId(result.credential.id)).toBe(result.credential.id);
        expect(result.credential.secret).toBeInstanceOf(SecretValue);
        if (result.expiresAt !== null) expect(parseIsoInstant(result.expiresAt)).toBe(result.expiresAt);
        expect(result.grantedScopes.every((scope) => isGrantedScope(scope))).toBe(true);
        expect([...result.grantedScopes]).toEqual([...new Set(result.grantedScopes)].sort());
      });

      it("an unknown code is CredentialInvalid", async () => {
        expectProviderError(await rejection(exchange(new SecretValue("contract-unknown-code"), null)), "credential_invalid");
      });

      it("an expired code is CredentialInvalid", async () => {
        const { outcome, pkce } = await authorize("grant");
        h.expireCodes();
        expectProviderError(await rejection(exchange(codeOf(outcome), pkce?.verifier ?? null)), "credential_invalid");
      });

      it("a code is single-use: a second exchange is CredentialInvalid", async () => {
        const { outcome, pkce } = await authorize("grant");
        await exchange(codeOf(outcome), pkce?.verifier ?? null);
        expectProviderError(await rejection(exchange(codeOf(outcome), pkce?.verifier ?? null)), "credential_invalid");
      });

      it("a redirect URI that differs from the request's is PermanentRejected", async () => {
        const { outcome, pkce } = await authorize("grant");
        const error = expectProviderError(await rejection(exchange(codeOf(outcome), pkce?.verifier ?? null, h.otherRedirectUri)), "permanent_rejected");
        expect(error.retry).toBe("never");
      });

      it("a redirect URI with a query component round-trips and must match exactly, query included", async () => {
        const uri = h.redirectUriWithQuery;
        const own = [...new URL(uri).searchParams];
        expect(own.length).toBeGreaterThanOrEqual(2);
        const variant = (query: string): RedirectUri => {
          const parsed = parseRedirectUri(`${uri.slice(0, uri.indexOf("?"))}${query}`);
          if (parsed === undefined) throw new Error("invalid variant");
          return parsed;
        };
        const [first, second] = own as [[string, string], [string, string]];
        const variants = [
          variant(""),
          variant(`?${first[0]}=${first[1]}`),
          variant(`?${first[0]}=${first[1]}x&${second[0]}=${second[1]}`),
          variant(`?${second[0]}=${second[1]}&${first[0]}=${first[1]}`),
          variant(`?${first[0]}=${first[1]}&${second[0]}=${second[1]}&extra=1`),
        ];
        for (const different of variants) {
          const { outcome, pkce, redirect } = await authorize("grant", undefined, uri);
          const landed = new URL(redirect);
          expect(`${landed.origin}${landed.pathname}`).toBe(uri.slice(0, uri.indexOf("?")));
          expect([...landed.searchParams].slice(0, own.length)).toEqual(own);
          expect(different).not.toBe(uri);
          expectProviderError(await rejection(exchange(codeOf(outcome), pkce?.verifier ?? null, different)), "permanent_rejected");
          await expect(exchange(codeOf(outcome), pkce?.verifier ?? null, uri)).resolves.toBeDefined();
        }
      });

      it("a wrong or missing PKCE verifier is CredentialInvalid", async () => {
        if (mode === "not_supported") return;
        const wrong = await authorize("grant", true);
        expectProviderError(await rejection(exchange(codeOf(wrong.outcome), pkcePair("another-verifier").verifier)), "credential_invalid");
        const missing = await authorize("grant", true);
        expectProviderError(await rejection(exchange(codeOf(missing.outcome), null)), "credential_invalid");
      });

      it("PKCE is optional only where the mode says so", async () => {
        if (mode === "supported") {
          const { outcome } = await authorize("grant", false);
          await expect(exchange(codeOf(outcome), null)).resolves.toBeDefined();
        }
        if (mode === "not_supported") {
          const { outcome } = await authorize("grant", false);
          expectProviderError(await rejection(exchange(codeOf(outcome), pkcePair("unsupported").verifier)), "permanent_rejected");
        }
      });

      it("an authorization without what a usable connection needs is PermissionMissing", async () => {
        const { outcome, pkce } = await authorize("grant_without_required_permission");
        expectProviderError(await rejection(exchange(codeOf(outcome), pkce?.verifier ?? null)), "permission_missing");
      });

      for (const kind of ["transient", "rate_limited", "outcome_unknown"] as const) {
        it(`${kind}: normalized, and the port makes exactly one provider call (no automatic retry)`, async () => {
          const { outcome, pkce } = await authorize("grant");
          h.failNextExchange(kind);
          const before = h.exchangeCalls();
          const error = expectProviderError(await rejection(exchange(codeOf(outcome), pkce?.verifier ?? null)), kind);
          expect(error.operation).toBe("exchangeCode");
          expect(h.exchangeCalls() - before).toBe(1);
          if (kind === "rate_limited") expect("retryAfterSeconds" in error.toJSON().details).toBe(true);
          if (kind === "outcome_unknown") {
            // Ambiguous, never a definite failure: the code may have been redeemed, so it must not be replayed blindly.
            expect(error.retry).toBe("verify_first");
            expect(isDefiniteFailure(error)).toBe(false);
          }
        });
      }

      it("a denial is never an exchange: it carries no code", async () => {
        const { outcome } = await authorize("deny");
        expect(outcome.kind).toBe("denied");
        expect("code" in outcome).toBe(false);
      });
    });

    describe("5 · secret safety", () => {
      it("a code never appears in errors, whatever the failure", async () => {
        const marker = "contract-code-leak-marker-7f3a";
        const error = await rejection(h.port.exchangeCode({ code: new SecretValue(marker), redirectUri: h.redirectUri, pkceVerifier: null }));
        expectNoneOf(error, [marker]);
        const { outcome, pkce } = await authorize("grant");
        const real = codeOf(outcome).expose();
        expectNoneOf(await rejection(h.port.exchangeCode({ code: codeOf(outcome), redirectUri: h.otherRedirectUri, pkceVerifier: pkce?.verifier ?? null })), [real]);
      });

      it("a verifier never appears in errors or URLs", async () => {
        if (mode === "not_supported") return;
        const leaked = pkcePair("contract-verifier-leak-marker-9c1e");
        const { outcome, request } = await authorize("grant", true);
        expect(request.url).not.toContain(leaked.raw);
        const error = await rejection(h.port.exchangeCode({ code: codeOf(outcome), redirectUri: h.redirectUri, pkceVerifier: leaked.verifier }));
        expectNoneOf(error, [leaked.raw]);
      });

      it("an issued credential never renders its secret, and later failures don't echo it", async () => {
        const { outcome, pkce } = await authorize("grant");
        const result = expectResult(await h.port.exchangeCode({ code: codeOf(outcome), redirectUri: h.redirectUri, pkceVerifier: pkce?.verifier ?? null }));
        const secret = result.credential.secret.expose();
        expectNoneOf(result, [secret, codeOf(outcome).expose()]);
        expect(JSON.stringify(result.credential)).toContain("[redacted]");
        const reuse = await rejection(h.port.exchangeCode({ code: codeOf(outcome), redirectUri: h.redirectUri, pkceVerifier: pkce?.verifier ?? null }));
        expectNoneOf(reuse, [secret, codeOf(outcome).expose()]);
      });

      it("a lost exchange response leaks no code, verifier or issued credential", async () => {
        const withPkce = mode !== "not_supported";
        const started = await start(withPkce, "contract-lost-response-verifier-4d2b");
        const outcome = h.port.parseCallback(callbackQueryOf(h.consent(started.request.url, "grant")));
        h.failNextExchange("outcome_unknown");
        const error = await rejection(h.port.exchangeCode({ code: codeOf(outcome), redirectUri: h.redirectUri, pkceVerifier: started.pkce?.verifier ?? null }));
        expectProviderError(error, "outcome_unknown");
        expectNoneOf(error, [codeOf(outcome).expose(), started.state, ...(started.pkce === null ? [] : [started.pkce.raw])]);
      });

      it("state values are never placed in error output", async () => {
        const state: OAuthState = h.newState();
        if (mode === "required") {
          expectNoneOf(await rejection(h.port.authorizationRequest({ state, redirectUri: h.redirectUri, pkce: null })), [state]);
        } else if (mode === "not_supported") {
          expectNoneOf(await rejection(h.port.authorizationRequest({ state, redirectUri: h.redirectUri, pkce: pkcePair("x-state-check").challenge })), [state]);
        } else {
          const { outcome, state: used } = await authorize("grant");
          expectNoneOf(await rejection(h.port.exchangeCode({ code: codeOf(outcome), redirectUri: h.otherRedirectUri, pkceVerifier: null })), [used]);
        }
      });
    });
  });
}
