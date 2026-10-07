/**
 * OAuth round-trip secrets for the WEB application (Step 5D; decisions B1 and B3; TA §38.7, §39).
 *
 *   state     `v1.<workspace uuid>.<nonce>`: a fresh 256-bit random nonce, unpadded base64url. The workspace UUID
 *             is ROUTING information only (which workspace to bind at the callback); it never authenticates
 *             anything. Only SHA-256(full state) is persisted; the plaintext state is never stored.
 *   PKCE      the verifier is NEVER persisted. It is derived statelessly from the state with a dedicated
 *             web-server secret, and derived again at the callback from the returned state:
 *               verifier  = base64url(HMAC-SHA256(OAUTH_PKCE_DERIVATION_KEY, domain ‖ 0x00 ‖ u32be(len) ‖ state))
 *               challenge = base64url(SHA-256(verifier))                                  (S256, RFC 7636)
 *             The domain constant separates this use of the key from any other; the length prefix makes the
 *             encoding unambiguous. A 32-byte HMAC output gives exactly 43 verifier characters.
 *
 * The derivation key is a web application secret (not a KMS key; TA-Q-07 / ADR-64 unchanged): exactly 32 bytes
 * given as 43 unpadded base64url characters. No passphrase derivation, no generated default, no fallback:
 * absent or malformed configuration fails closed. The key and every derived verifier are never logged,
 * returned to clients, persisted or handed to provider adapters (boundary rule: only server/ imports this file).
 */
import { createHash, createHmac, randomBytes } from "node:crypto";

export const OAUTH_PKCE_DERIVATION_KEY_ENV = "OAUTH_PKCE_DERIVATION_KEY";
export const OAUTH_PKCE_DERIVATION_DOMAIN = "social-intelligence-platform:oauth-pkce:v1";
export const OAUTH_STATE_VERSION = "v1";

const KEY_BYTES = 32;
const NONCE_BYTES = 32;
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATE_CHARS = /^[A-Za-z0-9._~-]{32,512}$/;

export const OAUTH_SECRET_ERROR_CODES = ["INVALID_PKCE_KEY_CONFIGURATION", "PKCE_KEY_UNAVAILABLE", "INVALID_STATE"] as const;
export type OAuthSecretErrorCode = (typeof OAUTH_SECRET_ERROR_CODES)[number];

/** Fixed-code failures: never carry key material, states or verifiers. */
export class OAuthSecretError extends Error {
  readonly code: OAuthSecretErrorCode;

  constructor(code: OAuthSecretErrorCode) {
    super(`oauth_secret_${code.toLowerCase()}`);
    this.name = "OAuthSecretError";
    this.code = code;
  }

  toJSON(): { readonly code: OAuthSecretErrorCode } {
    return { code: this.code };
  }
}

/** A fresh state for `workspaceId`: `v1.<uuid>.<43-char nonce>` (256 random bits). */
export function newOAuthState(workspaceId: string): string {
  if (!UUID.test(workspaceId)) throw new OAuthSecretError("INVALID_STATE");
  return `${OAUTH_STATE_VERSION}.${workspaceId}.${randomBytes(NONCE_BYTES).toString("base64url")}`;
}

/** SHA-256 of the FULL state, lowercase hex (what connect_attempts.state_digest stores). */
export function oauthStateDigest(state: string): string {
  if (!STATE_CHARS.test(state)) throw new OAuthSecretError("INVALID_STATE");
  return createHash("sha256").update(state, "ascii").digest("hex");
}

/** Strict parse: 43 unpadded base64url characters decoding to exactly 32 bytes (canonical form only). */
export function parsePkceDerivationKey(value: unknown): Buffer {
  if (typeof value !== "string" || !KEY_TEXT.test(value)) throw new OAuthSecretError("INVALID_PKCE_KEY_CONFIGURATION");
  const key = Buffer.from(value, "base64url");
  if (key.length !== KEY_BYTES || key.toString("base64url") !== value) {
    key.fill(0);
    throw new OAuthSecretError("INVALID_PKCE_KEY_CONFIGURATION");
  }
  return key;
}

export interface PkceDeriver {
  /** The PKCE verifier for `state` (43 chars). Sensitive: callers wrap it as a secret and never log it. */
  verifier(state: string): string;
  /** The S256 challenge for `state`'s verifier (not secret). */
  challenge(state: string): string;
  /** Zeroes the key; every later derivation fails with PKCE_KEY_UNAVAILABLE. */
  destroy(): void;
}

function canonicalInput(state: string): Buffer {
  if (!STATE_CHARS.test(state)) throw new OAuthSecretError("INVALID_STATE");
  const domain = Buffer.from(OAUTH_PKCE_DERIVATION_DOMAIN, "ascii");
  const value = Buffer.from(state, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([domain, Buffer.from([0]), length, value]);
}

/** Copies the 32-byte key (the caller zeroes its own copy). */
export function createPkceDeriver(key: Uint8Array): PkceDeriver {
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) throw new OAuthSecretError("INVALID_PKCE_KEY_CONFIGURATION");
  const secret = Buffer.alloc(KEY_BYTES);
  secret.set(key);
  let destroyed = false;

  const verifier = (state: string): string => {
    if (destroyed) throw new OAuthSecretError("PKCE_KEY_UNAVAILABLE");
    const mac = createHmac("sha256", secret).update(canonicalInput(state)).digest();
    try {
      return mac.toString("base64url");
    } finally {
      mac.fill(0);
    }
  };

  return Object.freeze({
    verifier,
    challenge: (state: string) => createHash("sha256").update(verifier(state), "ascii").digest("base64url"),
    destroy() {
      secret.fill(0);
      destroyed = true;
    },
  });
}

/** Reads OAUTH_PKCE_DERIVATION_KEY (required); the decoded copy is zeroed after the deriver copies it. */
export function pkceDeriverFromEnvironment(environment: Readonly<Record<string, string | undefined>>): PkceDeriver {
  const value = environment[OAUTH_PKCE_DERIVATION_KEY_ENV];
  if (value === undefined || value === "") throw new OAuthSecretError("INVALID_PKCE_KEY_CONFIGURATION");
  const key = parsePkceDerivationKey(value);
  try {
    return createPkceDeriver(key);
  } finally {
    key.fill(0);
  }
}
