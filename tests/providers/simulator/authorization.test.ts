/**
 * Simulator authorization behavior (Step 5C): deterministic URLs and codes, the documented single-use
 * semantics, the lost-response (OutcomeUnknown) case, redirect URIs with a query component, error-reason
 * mapping, scenario isolation, journal hygiene, fixture validation and no network.
 * SIMULATOR CONTRACT BEHAVIOR ONLY: none of this is evidence about Meta or TikTok (OQ-18/19/26/27 VALIDATE).
 */
import net from "node:net";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecretValue, parseRedirectUri, type CallbackOutcome, type OAuthState, type PkceChallenge, type ProviderAuthorizationPort } from "@/integrations/providers/contract";
import {
  ScenarioError,
  SimulatorWorld,
  createSimulatorAuthorizationPort,
  createSimulatorReadPort,
  parseFaultRule,
  parseScenario,
  parseSimulatorCallback,
  simulateConsent,
  type SimulatedConsent,
} from "@/integrations/providers/simulator";
import { loadScenario, rawScenario, stableSerialize } from "../support/fixtures";
import { pkcePair } from "../support/pkce";
import { CONSENT, SIM_OTHER_REDIRECT_URI, SIM_QUERY_REDIRECT_URI, SIM_REDIRECT_URI, SIM_SIGNING_KEY, createAuthorizationSimulator, syntheticState } from "../support/simulator-harness";

const { world, port } = createAuthorizationSimulator();
const STATE = syntheticState(1);

beforeEach(() => {
  world.reset();
});

const codeOf = (outcome: CallbackOutcome): SecretValue => {
  if (outcome.kind !== "code") throw new Error(`expected code, got ${outcome.kind}`);
  return outcome.code;
};

async function authorize(options: { readonly on?: SimulatorWorld; readonly with?: ProviderAuthorizationPort; readonly pkce?: PkceChallenge | null; readonly consent?: SimulatedConsent; readonly state?: OAuthState } = {}) {
  const target = options.on ?? world;
  const p = options.with ?? port;
  const request = await p.authorizationRequest({ state: options.state ?? STATE, redirectUri: SIM_REDIRECT_URI, pkce: options.pkce ?? null });
  const redirect = simulateConsent(target, request.url, options.consent ?? CONSENT.grant);
  return { request, redirect, outcome: p.parseCallback([...new URL(redirect).searchParams]) };
}

const exchange = (code: SecretValue, verifier: SecretValue | null = null, redirectUri = SIM_REDIRECT_URI, p = port) =>
  p.exchangeCode({ code, redirectUri, pkceVerifier: verifier });

describe("deterministic authorization URL", () => {
  it("is pinned: fixed endpoint, parameters in fixed order, challenge but never the verifier", async () => {
    const pair = pkcePair("pinned-verifier");
    const { url } = await port.authorizationRequest({ state: STATE, redirectUri: SIM_REDIRECT_URI, pkce: pair.challenge });
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe("https://simulator.invalid/oauth/authorize");
    expect([...parsed.searchParams.keys()]).toEqual(["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method"]);
    expect(parsed.searchParams.get("redirect_uri")).toBe(SIM_REDIRECT_URI);
    expect(parsed.searchParams.get("state")).toBe(STATE);
    expect(parsed.searchParams.get("code_challenge")).toBe(pair.challenge.challenge);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url).not.toContain(pair.raw);
    expect((await port.authorizationRequest({ state: STATE, redirectUri: SIM_REDIRECT_URI, pkce: pair.challenge })).url).toBe(url);
  });

  it("two worlds from the same scenario issue the same codes and credentials", async () => {
    const run = async () => {
      const sim = createAuthorizationSimulator();
      const { outcome } = await authorize({ on: sim.world, with: sim.port });
      const result = (await exchange(codeOf(outcome), null, SIM_REDIRECT_URI, sim.port)).data;
      return stableSerialize({ code: codeOf(outcome).expose(), id: result.credential.id, expiresAt: result.expiresAt, scopes: result.grantedScopes, journal: sim.world.journal });
    };
    expect(await run()).toBe(await run());
  });

  it("re-validates branded inputs forged with a cast", async () => {
    for (const input of [
      { state: "short" as OAuthState, redirectUri: SIM_REDIRECT_URI, pkce: null },
      { state: STATE, redirectUri: SIM_REDIRECT_URI.replace("https", "http") as typeof SIM_REDIRECT_URI, pkce: null },
      { state: STATE, redirectUri: SIM_REDIRECT_URI, pkce: { method: "S256", challenge: "not-43" } as unknown as PkceChallenge },
    ]) {
      await expect(port.authorizationRequest(input)).rejects.toMatchObject({ kind: "permanent_rejected", reasonCode: "invalid_request", operation: "authorizationRequest" });
    }
  });
});

describe("single-use code semantics (simulator contract behavior)", () => {
  it("a redirect URI mismatch does not consume the code; the correct exchange then succeeds once", async () => {
    const { outcome } = await authorize();
    await expect(exchange(codeOf(outcome), null, SIM_OTHER_REDIRECT_URI)).rejects.toMatchObject({ kind: "permanent_rejected", reasonCode: "invalid_request" });
    await expect(exchange(codeOf(outcome))).resolves.toBeDefined();
    await expect(exchange(codeOf(outcome))).rejects.toMatchObject({ kind: "credential_invalid", reason: "revoked" });
  });

  it("a PKCE mismatch (wrong or missing verifier) does not consume the code", async () => {
    const pair = pkcePair("right-verifier");
    const { outcome } = await authorize({ pkce: pair.challenge });
    await expect(exchange(codeOf(outcome), pkcePair("wrong-verifier").verifier)).rejects.toMatchObject({ kind: "credential_invalid", reason: "unknown" });
    await expect(exchange(codeOf(outcome), null)).rejects.toMatchObject({ kind: "credential_invalid", reason: "unknown" });
    await expect(exchange(codeOf(outcome), pair.verifier)).resolves.toBeDefined();
  });

  it("injected transient and rate-limit failures happen before redemption: the code stays redeemable", async () => {
    const { outcome } = await authorize();
    world.applyFaultPreset("exchange_transient");
    await expect(exchange(codeOf(outcome))).rejects.toMatchObject({ kind: "transient", reason: "provider_unavailable" });
    world.applyFaultPreset("exchange_rate_limited");
    await expect(exchange(codeOf(outcome))).rejects.toMatchObject({ kind: "rate_limited", retryAfterSeconds: 60 });
    await expect(exchange(codeOf(outcome))).resolves.toBeDefined();
    expect(world.journal.map((e) => [e.operation, e.outcome])).toEqual([
      ["exchangeCode", "transient"],
      ["exchangeCode", "rate_limited"],
      ["exchangeCode", "ok"],
    ]);
  });

  it("expired, unknown and already-used codes are terminal, with distinct closed reasons", async () => {
    const { outcome } = await authorize();
    world.advanceClock(599);
    await expect(exchange(codeOf(outcome))).resolves.toBeDefined();
    await expect(exchange(codeOf(outcome))).rejects.toMatchObject({ kind: "credential_invalid", reason: "revoked", retry: "after_recovery" });
    const late = await authorize({ state: syntheticState(2) });
    world.advanceClock(600);
    await expect(exchange(codeOf(late.outcome))).rejects.toMatchObject({ kind: "credential_invalid", reason: "expired" });
    await expect(exchange(new SecretValue("sim-code-baseline-999"))).rejects.toMatchObject({ kind: "credential_invalid", reason: "unknown" });
  });

  it("a grant missing the required permission is PermissionMissing(discover_assets) and is never redeemed", async () => {
    const { outcome } = await authorize({ consent: CONSENT.grant_without_required_permission });
    await expect(exchange(codeOf(outcome))).rejects.toMatchObject({ kind: "permission_missing", capability: "discover_assets", retry: "never" });
    expect(world.authorizationCode(codeOf(outcome).expose())?.consumed).toBe(false);
  });
});

describe("issued credentials", () => {
  it("expose exactly the granted assets through the read port, with expiry from the scenario clock", async () => {
    const { outcome } = await authorize();
    const result = (await exchange(codeOf(outcome))).data;
    expect(result.expiresAt).toBe("2026-11-14T12:00:00.000Z");
    expect(result.credential.id).toBe("sim-cred-2");
    const read = createSimulatorReadPort(world, { webhookSigningKey: SIM_SIGNING_KEY });
    const assets = (await read.discoverAssets(result.credential)).data.map((a) => a.ref.id);
    expect(assets.sort()).toEqual(["act_meta_100", "fb_page_aurora", "ig_acct_aurora"]);
  });

  it("report granted scopes as opaque identifiers, de-duplicated and sorted, without interpreting them", async () => {
    const { outcome } = await authorize({ consent: { kind: "grant", grant: "meta_partial" } });
    expect((await exchange(codeOf(outcome))).data.grantedScopes).toEqual(["sim.discover_assets", "sim.read_account", "sim.read_content"]);
  });
});

describe("PKCE modes", () => {
  it("required: no challenge is refused; a code issued with a challenge needs its verifier", async () => {
    const required = createSimulatorAuthorizationPort(world, { pkce: "required" });
    await expect(required.authorizationRequest({ state: STATE, redirectUri: SIM_REDIRECT_URI, pkce: null })).rejects.toMatchObject({ kind: "permanent_rejected" });
    const pair = pkcePair("required-verifier");
    const { outcome } = await authorize({ with: required, pkce: pair.challenge });
    await expect(exchange(codeOf(outcome), null, SIM_REDIRECT_URI, required)).rejects.toMatchObject({ kind: "credential_invalid" });
    await expect(exchange(codeOf(outcome), pair.verifier, SIM_REDIRECT_URI, required)).resolves.toBeDefined();
  });

  it("supported: a verifier for a code issued without a challenge is a mismatch", async () => {
    const { outcome } = await authorize();
    await expect(exchange(codeOf(outcome), pkcePair("unexpected").verifier)).rejects.toMatchObject({ kind: "credential_invalid", reason: "unknown" });
  });

  it("not_supported: challenge and verifier are both refused as invalid requests", async () => {
    const none = createSimulatorAuthorizationPort(world, { pkce: "not_supported" });
    await expect(none.authorizationRequest({ state: STATE, redirectUri: SIM_REDIRECT_URI, pkce: pkcePair("x").challenge })).rejects.toMatchObject({ reasonCode: "invalid_request" });
    const { outcome } = await authorize({ with: none });
    await expect(exchange(codeOf(outcome), pkcePair("y").verifier, SIM_REDIRECT_URI, none)).rejects.toMatchObject({ kind: "permanent_rejected", reasonCode: "invalid_request" });
  });

  it("a verifier outside the RFC 7636 shape is an invalid request", async () => {
    const { outcome } = await authorize({ pkce: pkcePair("shape").challenge });
    await expect(exchange(codeOf(outcome), new SecretValue("too short"))).rejects.toMatchObject({ kind: "permanent_rejected", reasonCode: "invalid_request" });
  });
});

describe("callback normalization (simulator wire format)", () => {
  const malformed = (query: unknown) => parseSimulatorCallback(query as never);

  it("maps each malformed shape to its closed reason", () => {
    expect(malformed([["code", "c"], ["state", STATE], ["state", STATE]])).toEqual({ kind: "malformed", reason: "duplicate_parameter" });
    expect(malformed([["code", "c"], ["error", "access_denied"], ["state", STATE]])).toEqual({ kind: "malformed", reason: "conflicting_result" });
    expect(malformed([["state", STATE]])).toEqual({ kind: "malformed", reason: "missing_result" });
    expect(malformed([["code", "c"]])).toEqual({ kind: "malformed", reason: "missing_state" });
    expect(malformed([["code", "c"], ["state", "x"]])).toEqual({ kind: "malformed", reason: "invalid_state" });
    expect(malformed([["code", "has space"], ["state", STATE]])).toEqual({ kind: "malformed", reason: "invalid_code" });
    expect(malformed([["error", "Not A Token"], ["state", STATE]])).toEqual({ kind: "malformed", reason: "invalid_error" });
    expect(malformed({ code: "c", state: STATE })).toEqual({ kind: "malformed", reason: "invalid_query" });
    expect(malformed([["code", 7], ["state", STATE]])).toEqual({ kind: "malformed", reason: "invalid_query" });
  });

  it("maps unknown provider errors to other, and never surfaces error_description", () => {
    const outcome = parseSimulatorCallback([["error", "server_error"], ["error_description", "desc-leak-marker"], ["error_description", "again"], ["state", STATE]]);
    expect(outcome).toEqual({ kind: "denied", state: STATE, reason: "other" });
    expect(`${JSON.stringify(outcome)} ${inspect(outcome)}`).not.toContain("desc-leak-marker");
  });

  it("a code outcome renders its code redacted", async () => {
    const { outcome } = await authorize();
    const code = codeOf(outcome).expose();
    expect(JSON.stringify(outcome)).toContain("[redacted]");
    expect(`${JSON.stringify(outcome)} ${inspect(outcome, { depth: 5 })} ${String(codeOf(outcome))}`).not.toContain(code);
  });
});

describe("simulated consent screen", () => {
  it("refuses authorization URLs it didn't build or that were tampered with", async () => {
    const { url } = await port.authorizationRequest({ state: STATE, redirectUri: SIM_REDIRECT_URI, pkce: null });
    for (const tampered of [
      url.replace("simulator.invalid", "elsewhere.invalid"),
      url.replace("client_id=sim-client-baseline", "client_id=other-client"),
      `${url}&state=${STATE}`,
      `${url}&code_challenge_method=plain`,
      url.replace(/&state=[^&]+/, ""),
    ]) {
      expect(() => simulateConsent(world, tampered, CONSENT.grant)).toThrow(TypeError);
    }
    expect(() => simulateConsent(world, url, { kind: "grant", grant: "no_such_grant" })).toThrow(TypeError);
  });

  it("redirects exactly to the requested redirect URI with the code or the error, and the state", async () => {
    const { redirect } = await authorize();
    expect(redirect).toBe(`${SIM_REDIRECT_URI}?code=sim-code-baseline-1&state=${STATE}`);
    const denied = await authorize({ consent: CONSENT.cancel });
    expect(denied.redirect).toBe(`${SIM_REDIRECT_URI}?error=user_cancelled&state=${STATE}`);
  });
});

describe("scenario isolation and hygiene", () => {
  it("reset forgets issued codes and issued credentials", async () => {
    const { outcome } = await authorize();
    const credential = (await exchange(codeOf(outcome))).data.credential;
    const second = await authorize({ state: syntheticState(3) });
    world.reset();
    await expect(exchange(codeOf(second.outcome))).rejects.toMatchObject({ kind: "credential_invalid", reason: "unknown" });
    const read = createSimulatorReadPort(world, { webhookSigningKey: SIM_SIGNING_KEY });
    await expect(read.discoverAssets(credential)).rejects.toMatchObject({ kind: "credential_invalid" });
  });

  it("a code issued by one world is unknown to another", async () => {
    const other = createAuthorizationSimulator();
    const { outcome } = await authorize();
    await expect(exchange(codeOf(outcome), null, SIM_REDIRECT_URI, other.port)).rejects.toMatchObject({ kind: "credential_invalid", reason: "unknown" });
  });

  it("the journal records operation and outcome only: no code, verifier, state or token", async () => {
    const pair = pkcePair("journal-verifier");
    const { outcome } = await authorize({ pkce: pair.challenge });
    const result = (await exchange(codeOf(outcome), pair.verifier)).data;
    await exchange(codeOf(outcome), pair.verifier).catch(() => undefined);
    const journal = JSON.stringify(world.journal);
    for (const secret of [codeOf(outcome).expose(), pair.raw, STATE, result.credential.secret.expose()]) expect(journal).not.toContain(secret);
    expect(world.journal.every((entry) => entry.targets.length === 0)).toBe(true);
  });

  it("a scenario without an authorization server can't build the port", () => {
    expect(() => createSimulatorAuthorizationPort(new SimulatorWorld(loadScenario("unreported-budget")))).toThrow(TypeError);
  });
});

describe("authorization fixture validation", () => {
  const withAuthorization = (patch: Record<string, unknown>) => {
    const raw = rawScenario("baseline");
    return { ...raw, authorization: { ...(raw["authorization"] as Record<string, unknown>), ...patch } };
  };

  it("rejects an unknown PKCE mode (no 'plain'), unknown fields, dangling assets and duplicate scopes", () => {
    expect(() => parseScenario(withAuthorization({ pkce: "plain" }))).toThrow(/authorization\.pkce/);
    expect(() => parseScenario(withAuthorization({ redirectUris: [] }))).toThrow(/authorization\.redirectUris/);
    expect(() => parseScenario(withAuthorization({ grants: [{ id: "g", assets: ["missing_asset"], scopes: [] }] }))).toThrow(/grants\.g\.assets/);
    expect(() => parseScenario(withAuthorization({ grants: [{ id: "g", assets: [], scopes: ["a", "a"] }] }))).toThrow(ScenarioError);
    expect(() => parseScenario(withAuthorization({ requestedScopes: ["has space"] }))).toThrow(ScenarioError);
  });
});

describe("no network", () => {
  const connect = vi.spyOn(net.Socket.prototype, "connect");
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  afterEach(() => {
    connect.mockClear();
    fetchSpy.mockClear();
  });

  it("a full authorize → consent → callback → exchange cycle opens no socket and calls no fetch", async () => {
    const pair = pkcePair("network-check");
    const { outcome } = await authorize({ pkce: pair.challenge });
    await exchange(codeOf(outcome), pair.verifier);
    expect(connect).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("response lost after the exchange (simulator contract behavior)", () => {
  it("is OutcomeUnknown after one call; the code was redeemed, so a replay is not evidence that retrying is safe", async () => {
    const { outcome } = await authorize();
    world.applyFaultPreset("exchange_response_lost");
    const error = await exchange(codeOf(outcome)).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "outcome_unknown", operation: "exchangeCode", retry: "verify_first" });
    expect(world.journal.map((e) => [e.operation, e.outcome])).toEqual([["exchangeCode", "outcome_unknown"]]);
    expect(world.authorizationCode(codeOf(outcome).expose())?.consumed).toBe(true);
    await expect(exchange(codeOf(outcome))).rejects.toMatchObject({ kind: "credential_invalid", reason: "revoked" });
  });

  it("leaves a previously issued credential valid (re-authorization of an existing connection)", async () => {
    const first = await authorize();
    const existing = (await exchange(codeOf(first.outcome))).data.credential;
    const again = await authorize({ state: syntheticState(4) });
    world.applyFaultPreset("exchange_response_lost");
    await expect(exchange(codeOf(again.outcome))).rejects.toMatchObject({ kind: "outcome_unknown" });
    const read = createSimulatorReadPort(world, { webhookSigningKey: SIM_SIGNING_KEY });
    await expect(read.discoverAssets(existing)).resolves.toBeDefined();
  });

  it("the error carries no code, verifier, state or the credential the provider issued", async () => {
    const pair = pkcePair("lost-response-verifier");
    const { outcome } = await authorize({ pkce: pair.challenge });
    world.applyFaultPreset("exchange_response_lost");
    const error = await exchange(codeOf(outcome), pair.verifier).catch((e: unknown) => e);
    const issued = world.credential("sim-cred-2").secret.expose();
    const rendered = `${JSON.stringify(error)} ${String(error)} ${inspect(error, { showHidden: true })} ${(error as Error).stack ?? ""}`;
    for (const secret of [codeOf(outcome).expose(), pair.raw, STATE, issued]) expect(rendered).not.toContain(secret);
    expect(JSON.stringify(world.journal)).not.toContain(issued);
  });

  it("ambiguity faults are accepted only where an outcome can be ambiguous", () => {
    expect(parseFaultRule({ operation: "exchangeCode", on: 1, fault: { kind: "outcome_unknown" } })).toBeDefined();
    expect(parseFaultRule({ operation: "exchangeCode", on: 1, fault: { kind: "timeout_before_send" } })).toBeUndefined();
    expect(parseFaultRule({ operation: "authorizationRequest", on: 1, fault: { kind: "outcome_unknown" } })).toBeUndefined();
    expect(parseFaultRule({ operation: "listContent", on: 1, fault: { kind: "outcome_unknown" } })).toBeUndefined();
  });
});

describe("redirect URIs with a query component", () => {
  it("callback parameters are appended to the registered query, which is kept exactly", async () => {
    const request = await port.authorizationRequest({ state: STATE, redirectUri: SIM_QUERY_REDIRECT_URI, pkce: null });
    expect(new URL(request.url).searchParams.get("redirect_uri")).toBe(SIM_QUERY_REDIRECT_URI);
    const redirect = simulateConsent(world, request.url, CONSENT.grant);
    expect(redirect).toBe(`${SIM_QUERY_REDIRECT_URI}&code=sim-code-baseline-1&state=${STATE}`);
    const outcome = port.parseCallback([...new URL(redirect).searchParams]);
    await expect(exchange(codeOf(outcome), null, SIM_REDIRECT_URI)).rejects.toMatchObject({ kind: "permanent_rejected", reasonCode: "invalid_request" });
    await expect(exchange(codeOf(outcome), null, SIM_QUERY_REDIRECT_URI)).resolves.toBeDefined();
  });

  it("a registered query that repeats a callback parameter makes the callback fail closed", async () => {
    const colliding = parseRedirectUri("https://app.example.test/api/oauth/simulator/callback?state=registered-value-0000000000000000");
    if (colliding === undefined) throw new Error("invalid test URI");
    const request = await port.authorizationRequest({ state: STATE, redirectUri: colliding, pkce: null });
    const redirect = simulateConsent(world, request.url, CONSENT.grant);
    expect(port.parseCallback([...new URL(redirect).searchParams])).toEqual({ kind: "malformed", reason: "duplicate_parameter" });
  });
});
