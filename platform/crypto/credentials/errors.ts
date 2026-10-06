/**
 * Normalized credential-crypto failures (Step 5A; TA §39, TA-Q-07). Messages are fixed codes: they never
 * carry key material, plaintext, ciphertext, context values or underlying crypto-library messages, and no
 * `cause` is attached. Callers map codes to their own taxonomy.
 */

export const CREDENTIAL_CRYPTO_ERROR_CODES = [
  "MALFORMED_ENVELOPE",
  "UNSUPPORTED_ENVELOPE_VERSION",
  "INVALID_CONTEXT",
  "INVALID_PLAINTEXT",
  "INTEGRITY_FAILURE",
  "KEYRING_MISMATCH",
  "KEYRING_UNAVAILABLE",
  "INVALID_LOCAL_KEY_CONFIGURATION",
  "LOCAL_KEYRING_FORBIDDEN",
] as const;

export type CredentialCryptoErrorCode = (typeof CREDENTIAL_CRYPTO_ERROR_CODES)[number];

export class CredentialCryptoError extends Error {
  readonly code: CredentialCryptoErrorCode;

  constructor(code: CredentialCryptoErrorCode) {
    super(`credential_crypto_${code.toLowerCase()}`);
    this.name = "CredentialCryptoError";
    this.code = code;
  }

  toJSON(): { readonly code: CredentialCryptoErrorCode } {
    return { code: this.code };
  }
}

export function isCredentialCryptoError(value: unknown): value is CredentialCryptoError {
  return value instanceof CredentialCryptoError;
}
