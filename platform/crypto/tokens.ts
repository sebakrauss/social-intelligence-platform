/**
 * Opaque single-use tokens (e.g. invitations). The raw token is returned once, for delivery; only its
 * SHA-256 digest is ever persisted. Digest comparison is timing-safe.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

declare const digestBrand: unique symbol;
export type TokenDigest = string & { readonly [digestBrand]: true };

export interface IssuedToken {
  /** Deliver once (e.g. inside an invitation link). Never store, log or audit it. */
  readonly raw: string;
  readonly digest: TokenDigest;
}

/** 256 bits of entropy, base64url-encoded (43 characters). */
const RAW_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export function isRawTokenShape(value: unknown): value is string {
  return typeof value === "string" && RAW_TOKEN.test(value);
}

export function digestToken(raw: string): TokenDigest {
  return createHash("sha256").update(raw, "utf8").digest("hex") as TokenDigest;
}

export function issueToken(): IssuedToken {
  const raw = randomBytes(32).toString("base64url");
  return { raw, digest: digestToken(raw) };
}

export function digestsEqual(a: string, b: string): boolean {
  if (!DIGEST.test(a) || !DIGEST.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** Structural implementation of the tenancy module's token port. */
export const opaqueTokens = {
  issue: issueToken,
  digest: digestToken,
  matches: (raw: string, digest: string): boolean => isRawTokenShape(raw) && digestsEqual(digestToken(raw), digest),
};
