/**
 * Logical KEK references (Step 7B; ADR-64, TA §39 rotation). An envelope's `keyRef` names WHICH logical
 * key-encryption key wrapped its data key — "local-v1" today, a stable label such as "kms-provider-credentials-v1"
 * for KMS envelopes — never a physical key. It is authenticated in every AAD, so it stays fixed for the envelope's
 * lifetime: a KEK migration (KMS ReEncrypt) replaces the physical key behind the wrapped data key without touching
 * the header or the payload. Which physical keys may unwrap a logical reference is keyring-adapter configuration,
 * outside the envelope. Physical identifiers (ARNs, aliases, key IDs) are refused so they can't reach the
 * authenticated header by mistake.
 */

export const LOGICAL_KEY_REF_MAX_LENGTH = 64;

/** Lowercase alphanumeric segments joined by single hyphens, starting with a letter. */
const LOGICAL_KEY_REF = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Shapes of physical key identifiers: ARNs, aliases, multi-Region key IDs and single-Region key IDs. */
const PHYSICAL_KEY_IDENTIFIERS: readonly RegExp[] = [
  /^arn:/i,
  /^alias\//i,
  /^mrk-[0-9a-f]{32}$/i,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
];

export function looksLikePhysicalKeyIdentifier(value: string): boolean {
  return PHYSICAL_KEY_IDENTIFIERS.some((shape) => shape.test(value));
}

export function isLogicalKeyRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= LOGICAL_KEY_REF_MAX_LENGTH &&
    LOGICAL_KEY_REF.test(value) &&
    !looksLikePhysicalKeyIdentifier(value)
  );
}
