/**
 * Test-only PKCE material: a verifier carrying a unique synthetic marker (so leakage tests can search for it)
 * and its S256 challenge. Generating real verifiers is the caller's job (Step 5D), not the provider contract's.
 */
import { createHash } from "node:crypto";
import { SecretValue, parsePkceChallenge, type PkceChallenge } from "@/integrations/providers/contract";

export interface PkcePair {
  readonly verifier: SecretValue;
  readonly challenge: PkceChallenge;
  /** The raw verifier, for leakage assertions only. */
  readonly raw: string;
}

/** `marker` must use RFC 3986 unreserved characters only. */
export function pkcePair(marker: string): PkcePair {
  const raw = `${marker}-${"0123456789abcdefghijklmnopqrstuvwxyz".repeat(2)}`.slice(0, 96);
  const challenge = parsePkceChallenge(createHash("sha256").update(raw, "ascii").digest("base64url"));
  if (challenge === undefined || raw.length < 43) throw new Error("invalid test PKCE pair");
  return { verifier: new SecretValue(raw), challenge, raw };
}
