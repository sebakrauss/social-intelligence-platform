/**
 * Step 5D connections, without a database: state routing, transition rules, the credential byte codec, the
 * exchange/discovery error mappings, display-name sanitizing, and the composition guards (local keyring startup
 * guard on both runtimes; the web composes a sealer only). The database behavior is proven in
 * tests/db/suites/connection-lifecycle.ts.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  CredentialInvalidError,
  OutcomeUnknownError,
  PermanentRejectedError,
  PermissionMissingError,
  RateLimitedError,
  TargetNotFoundError,
  TransientError,
  providerCredential,
} from "@/integrations/providers/contract";
import {
  CredentialCodecError,
  CredentialUnreadableError,
  decodeProviderCredential,
  encodeProviderCredential,
  problemFor,
  sanitizeDisplayName,
  stateWorkspace,
} from "@/modules/connections";
import { isClaimable, isStaleExchange, statusAfterDiscoveryFailure, statusAfterReauthorization, type ConnectAttempt } from "@/modules/connections/domain/model";
import { exchangeOutcome } from "@/server/connections/authorization";
import { connectionAuthorizationRuntime } from "@/server/connections/runtime";
import { credentialEnvironmentLabel } from "@/server/connections/environment";
import { codeOf } from "../../support/source-scan";

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const NONCE = "A".repeat(43);

describe("state routing (B3)", () => {
  it("routes only a well-formed v1 state, and only to a UUID workspace", () => {
    expect(stateWorkspace(`v1.${WS}.${NONCE}`)).toBe(WS);
    for (const bad of [`v2.${WS}.${NONCE}`, `v1.${WS}.${NONCE}x`, `v1.not-a-uuid.${NONCE}`, `v1.${WS}`, `${WS}.${NONCE}`, ""]) expect(stateWorkspace(bad)).toBeUndefined();
  });
});

describe("transition rules", () => {
  const attempt = (patch: Partial<ConnectAttempt>): ConnectAttempt =>
    ({ status: "PENDING", expiresAt: new Date(10_000), exchangeStartedAt: null, ...patch }) as ConnectAttempt;

  it("only an unexpired PENDING attempt is claimable; EXCHANGING becomes stale after 2 minutes", () => {
    expect(isClaimable(attempt({}), new Date(9_999))).toBe(true);
    expect(isClaimable(attempt({}), new Date(10_000))).toBe(false);
    for (const status of ["EXCHANGING", "COMPLETED", "DENIED", "EXPIRED", "CANCELLED", "EXCHANGE_FAILED", "OUTCOME_UNKNOWN"] as const) {
      expect(isClaimable(attempt({ status }), new Date(0))).toBe(false);
    }
    const exchanging = attempt({ status: "EXCHANGING", exchangeStartedAt: new Date(0) });
    expect(isStaleExchange(exchanging, new Date(119_999))).toBe(false);
    expect(isStaleExchange(exchanging, new Date(120_000))).toBe(true);
  });

  it("re-authorization keeps a working connection's status; discovery failure fails a new one and degrades a working one", () => {
    expect([statusAfterReauthorization("ACTIVE"), statusAfterReauthorization("DEGRADED"), statusAfterReauthorization("FAILED"), statusAfterReauthorization("CONNECTING")])
      .toEqual(["ACTIVE", "DEGRADED", "CONNECTING", "CONNECTING"]);
    expect([statusAfterDiscoveryFailure("CONNECTING"), statusAfterDiscoveryFailure("FAILED"), statusAfterDiscoveryFailure("ACTIVE"), statusAfterDiscoveryFailure("DEGRADED")])
      .toEqual(["FAILED", "FAILED", "DEGRADED", "DEGRADED"]);
  });
});

describe("credential byte codec", () => {
  it("round-trips a normalized credential; zeroed bytes no longer decode", () => {
    const credential = providerCredential("sim-cred-7", "synthetic-token-ñ-✓-marker");
    const bytes = encodeProviderCredential(credential);
    expect(bytes[0]).toBe(1);
    const decoded = decodeProviderCredential(bytes);
    expect(decoded.id).toBe("sim-cred-7");
    expect(decoded.secret.expose()).toBe("synthetic-token-ñ-✓-marker");
    expect(`${JSON.stringify(decoded)} ${inspect(decoded)}`).not.toContain("marker");
    bytes.fill(0);
    expect(() => decodeProviderCredential(bytes)).toThrow(CredentialCodecError);
  });

  it("rejects malformed plaintext with a fixed message", () => {
    for (const bad of [new Uint8Array([]), new Uint8Array([2, 1, 65, 66]), new Uint8Array([1, 0, 65]), new Uint8Array([1, 5, 65, 66]), new Uint8Array([1, 1, 65, 0xff])]) {
      expect(() => decodeProviderCredential(bad)).toThrow("credential_codec_malformed");
    }
  });
});

describe("error mappings (closed codes only)", () => {
  it("exchange: definite failures → EXCHANGE_FAILED codes; ambiguous or unknown → OUTCOME_UNKNOWN; transient never retried", () => {
    expect(exchangeOutcome(new CredentialInvalidError("exchangeCode", "unknown"))).toBe("CREDENTIAL_INVALID");
    expect(exchangeOutcome(new PermissionMissingError("exchangeCode", "discover_assets"))).toBe("PERMISSION_MISSING");
    expect(exchangeOutcome(new PermanentRejectedError("exchangeCode", "invalid_request"))).toBe("REQUEST_REJECTED");
    expect(exchangeOutcome(new TransientError("exchangeCode", "provider_unavailable"))).toBe("PROVIDER_UNAVAILABLE");
    expect(exchangeOutcome(new RateLimitedError("exchangeCode", 60))).toBe("RATE_LIMITED");
    expect(exchangeOutcome(new OutcomeUnknownError("exchangeCode"))).toBe("OUTCOME_UNKNOWN");
    expect(exchangeOutcome(new Error("socket hang up"))).toBe("OUTCOME_UNKNOWN");
  });

  it("discovery: definite problems map to closed codes; retryable ones are rethrown (undefined)", () => {
    expect(problemFor(new CredentialInvalidError("discoverAssets", "revoked"))).toBe("CREDENTIAL_REVOKED");
    expect(problemFor(new CredentialInvalidError("discoverAssets", "expired"))).toBe("CREDENTIAL_EXPIRED");
    expect(problemFor(new CredentialInvalidError("discoverAssets", "malformed"))).toBe("CREDENTIAL_INVALID");
    expect(problemFor(new PermissionMissingError("discoverAssets", "discover_assets"))).toBe("PERMISSION_MISSING");
    expect(problemFor(new TargetNotFoundError("discoverAssets"))).toBe("DISCOVERY_FAILED");
    expect(problemFor(new CredentialUnreadableError())).toBe("CREDENTIAL_UNREADABLE");
    for (const retryable of [new TransientError("discoverAssets", "network"), new RateLimitedError("discoverAssets", null), new Error("keyring")]) {
      expect(problemFor(retryable)).toBeUndefined();
    }
  });

  it("display names are untrusted text: control characters removed, bounded, never empty", () => {
    expect(sanitizeDisplayName("Aurora\u0000 Page\n", "id")).toBe("Aurora  Page");
    expect(sanitizeDisplayName("x".repeat(500), "id")).toHaveLength(200);
    expect(sanitizeDisplayName("\u0007\u0008", "fallback_id")).toBe("fallback_id");
  });
});

describe("composition guards", () => {
  it("the credential environment label exists only where a keyring exists (development/test)", () => {
    expect(credentialEnvironmentLabel({ NODE_ENV: "test" })).toBe("test");
    expect(credentialEnvironmentLabel({ NODE_ENV: "development" })).toBe("local");
    expect(() => credentialEnvironmentLabel({ NODE_ENV: "production" })).toThrow();
  });

  it("the web runtime refuses to compose when local keyring material is present outside development/test", () => {
    expect(() => connectionAuthorizationRuntime({ getVerifiedUser: () => Promise.resolve(undefined) }, { NODE_ENV: "production", LOCAL_KEYRING_KEY: "A".repeat(43) }))
      .toThrow(expect.objectContaining({ code: "LOCAL_KEYRING_FORBIDDEN" }));
  });

  it("both composition roots call the startup guard first; the web composes a sealer and never an opener", () => {
    const web = codeOf("server/connections/runtime.ts");
    const jobs = codeOf("jobs/connections.ts");
    expect(web.indexOf("assertNoLocalKeyringOutsideLocal(environment)")).toBeGreaterThan(-1);
    expect(web.indexOf("assertNoLocalKeyringOutsideLocal(environment)")).toBeLessThan(web.indexOf("localCredentialSealerFromEnvironment(environment)"));
    expect(web).not.toMatch(/opener|Opener|unwrap|local-keyring"|\/open"/);
    expect(jobs.indexOf("assertNoLocalKeyringOutsideLocal(environment)")).toBeGreaterThan(-1);
    expect(jobs.indexOf("assertNoLocalKeyringOutsideLocal(environment)")).toBeLessThan(jobs.indexOf("localCredentialOpenerFromEnvironment(environment)"));
    expect(jobs).not.toMatch(/platform\/crypto\/oauth|OAUTH_PKCE/);
  });

  it("nothing in the connections module can write the reserved 0007 PKCE columns (B1: the verifier is never stored)", () => {
    for (const file of ["modules/connections/persistence/tables.ts", "modules/connections/persistence/store.ts"]) expect(codeOf(file)).not.toMatch(/pkce/i);
  });
});
