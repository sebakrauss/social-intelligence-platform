/**
 * Email addresses. Sensitive identity data: never logged, audited, sent to observability or placed in
 * normalized errors. Comparison is on the normalized (trimmed, lower-cased) form.
 */

declare const verifiedEmailBrand: unique symbol;

/** An address the auth service has verified for the current session's user. */
export type VerifiedEmail = string & { readonly [verifiedEmailBrand]: true };

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trimmed, lower-cased address, or undefined when the shape is invalid. */
export function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length <= 254 && EMAIL_SHAPE.test(normalized) ? normalized : undefined;
}

/**
 * For auth adapters only: brands an address the auth service reported as verified.
 * Application code receives VerifiedEmail exclusively from the pipeline's authenticated identity.
 */
export function asVerifiedEmail(value: unknown): VerifiedEmail | undefined {
  return normalizeEmail(value) as VerifiedEmail | undefined;
}

export function sameEmail(a: string, b: string): boolean {
  const left = normalizeEmail(a);
  return left !== undefined && left === normalizeEmail(b);
}
