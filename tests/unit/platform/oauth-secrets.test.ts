/**
 * OAuth round-trip secrets (Step 5D, decisions B1/B3): versioned state with a 256-bit nonce, SHA-256 digest, and
 * the stateless HMAC-SHA256 PKCE verifier derivation with a strict 32-byte web key. No secret ever renders.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OAUTH_PKCE_DERIVATION_DOMAIN,
  OAuthSecretError,
  createPkceDeriver,
  newOAuthState,
  oauthStateDigest,
  parsePkceDerivationKey,
  pkceDeriverFromEnvironment,
} from "@/platform/crypto/oauth";
import { parseOAuthState, parsePkceChallenge, parsePkceVerifier } from "@/integrations/providers/contract";

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const KEY = randomBytes(32);

describe("OAuth state (v1, routing prefix + 256-bit nonce)", () => {
  it("has the versioned shape, fits the contract's OAuthState and never repeats", () => {
    const a = newOAuthState(WS);
    const b = newOAuthState(WS);
    expect(a).toMatch(new RegExp(`^v1\\.${WS}\\.[A-Za-z0-9_-]{43}$`));
    expect(Buffer.from(a.split(".")[2] ?? "", "base64url")).toHaveLength(32);
    expect(parseOAuthState(a)).toBe(a);
    expect(a).not.toBe(b);
    expect(() => newOAuthState("not-a-uuid")).toThrow(OAuthSecretError);
  });

  it("is persisted only as SHA-256 of the FULL state (64 lowercase hex)", () => {
    const state = newOAuthState(WS);
    expect(oauthStateDigest(state)).toBe(createHash("sha256").update(state).digest("hex"));
    expect(oauthStateDigest(state)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => oauthStateDigest("short")).toThrow(OAuthSecretError);
  });
});

describe("stateless PKCE derivation (B1)", () => {
  it("derives a 43-char RFC 7636 verifier with domain separation and a length prefix, and its S256 challenge", () => {
    const deriver = createPkceDeriver(KEY);
    const state = newOAuthState(WS);
    const verifier = deriver.verifier(state);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(state.length);
    const expected = createHmac("sha256", KEY)
      .update(Buffer.concat([Buffer.from(OAUTH_PKCE_DERIVATION_DOMAIN), Buffer.from([0]), length, Buffer.from(state)]))
      .digest("base64url");
    expect(verifier).toBe(expected);
    expect(verifier).toHaveLength(43);
    expect(parsePkceVerifier(verifier)).toBeDefined();
    expect(deriver.challenge(state)).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(parsePkceChallenge(deriver.challenge(state))).toBeDefined();
  });

  it("is deterministic per (key, state), different across states and keys, and not a plain HMAC of the state", () => {
    const state = newOAuthState(WS);
    expect(createPkceDeriver(KEY).verifier(state)).toBe(createPkceDeriver(KEY).verifier(state));
    expect(createPkceDeriver(KEY).verifier(newOAuthState(WS))).not.toBe(createPkceDeriver(KEY).verifier(state));
    expect(createPkceDeriver(randomBytes(32)).verifier(state)).not.toBe(createPkceDeriver(KEY).verifier(state));
    expect(createPkceDeriver(KEY).verifier(state)).not.toBe(createHmac("sha256", KEY).update(state).digest("base64url"));
  });

  it("copies the key, refuses after destroy, and rejects non-state input", () => {
    const key = Buffer.from(KEY);
    const deriver = createPkceDeriver(key);
    const state = newOAuthState(WS);
    const before = deriver.verifier(state);
    key.fill(0);
    expect(deriver.verifier(state)).toBe(before);
    expect(() => deriver.verifier("has spaces in it and is long enough to pass length")).toThrow(OAuthSecretError);
    deriver.destroy();
    expect(() => deriver.verifier(state)).toThrow(expect.objectContaining({ code: "PKCE_KEY_UNAVAILABLE" }));
    expect(() => createPkceDeriver(new Uint8Array(31))).toThrow(OAuthSecretError);
  });
});

describe("OAUTH_PKCE_DERIVATION_KEY configuration", () => {
  it("accepts exactly 32 bytes as canonical unpadded base64url; anything else fails closed (no default, no derivation)", () => {
    const text = KEY.toString("base64url");
    expect(parsePkceDerivationKey(text).equals(KEY)).toBe(true);
    for (const bad of [undefined, "", "short", `${text}=`, randomBytes(31).toString("base64url"), randomBytes(33).toString("base64url"), "correct horse battery staple correct horse x", 42]) {
      expect(() => parsePkceDerivationKey(bad)).toThrow(OAuthSecretError);
    }
    expect(() => pkceDeriverFromEnvironment({})).toThrow(expect.objectContaining({ code: "INVALID_PKCE_KEY_CONFIGURATION" }));
    expect(() => pkceDeriverFromEnvironment({ OAUTH_PKCE_DERIVATION_KEY: "" })).toThrow(OAuthSecretError);
    expect(pkceDeriverFromEnvironment({ OAUTH_PKCE_DERIVATION_KEY: text }).verifier(newOAuthState(WS))).toHaveLength(43);
  });

  it("errors carry a fixed code only: never the key, a state or a verifier", () => {
    const text = KEY.toString("base64url");
    const error = (() => {
      try {
        parsePkceDerivationKey(`${text.slice(0, 42)}!`);
      } catch (caught) {
        return caught as OAuthSecretError;
      }
      throw new Error("expected failure");
    })();
    expect(JSON.stringify(error)).toBe('{"code":"INVALID_PKCE_KEY_CONFIGURATION"}');
    expect(`${error.message} ${String(error)} ${error.stack ?? ""}`).not.toContain(text.slice(0, 20));
  });
});
