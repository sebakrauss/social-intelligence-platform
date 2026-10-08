/**
 * Normalized credential-crypto failures (Step 5A; TA §39, TA-Q-07). Messages are fixed codes: they never
 * carry key material, plaintext, ciphertext, context values or underlying crypto-library or key-service messages,
 * and nothing is chained onto them. Callers map codes to their own taxonomy.
 *
 * Keyring outcomes (Step 7B), the categories a key-service adapter maps its failures to:
 *   KEYRING_UNAVAILABLE    the key service could not be reached or answered transiently (outage, throttling)
 *   KEYRING_ACCESS_DENIED  the runtime's principal may not perform the operation (key policy, credentials)
 *   KEYRING_MISCONFIGURED  the keyring is wired wrongly (unknown/disabled key, key outside the allowlist, bad shape)
 *   KEYRING_MISMATCH       the envelope belongs to another keyring (KEK provider or logical key reference)
 *   INTEGRITY_FAILURE      the material does not authenticate under this context (tampered, foreign or wrong context)
 */

export const CREDENTIAL_CRYPTO_ERROR_CODES = [
  "MALFORMED_ENVELOPE",
  "UNSUPPORTED_ENVELOPE_VERSION",
  "INVALID_CONTEXT",
  "INVALID_PLAINTEXT",
  "INTEGRITY_FAILURE",
  "KEYRING_MISMATCH",
  "KEYRING_UNAVAILABLE",
  "KEYRING_ACCESS_DENIED",
  "KEYRING_MISCONFIGURED",
  "INVALID_LOCAL_KEY_CONFIGURATION",
  "LOCAL_KEYRING_FORBIDDEN",
] as const;

export type CredentialCryptoErrorCode = (typeof CREDENTIAL_CRYPTO_ERROR_CODES)[number];

/**
 * The ONE authoritative retryability table: may the same operation succeed if retried later, unchanged?
 * Only a transient keyring outage. Every other failure is deterministic for the same input and configuration.
 */
export const CREDENTIAL_CRYPTO_RETRYABLE: { readonly [Code in CredentialCryptoErrorCode]: boolean } = Object.freeze({
  MALFORMED_ENVELOPE: false,
  UNSUPPORTED_ENVELOPE_VERSION: false,
  INVALID_CONTEXT: false,
  INVALID_PLAINTEXT: false,
  INTEGRITY_FAILURE: false,
  KEYRING_MISMATCH: false,
  KEYRING_UNAVAILABLE: true,
  KEYRING_ACCESS_DENIED: false,
  KEYRING_MISCONFIGURED: false,
  INVALID_LOCAL_KEY_CONFIGURATION: false,
  LOCAL_KEYRING_FORBIDDEN: false,
});

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

/** True only for a normalized credential-crypto error whose code is retryable; anything else is not. */
export function isRetryableCredentialCryptoError(value: unknown): boolean {
  return isCredentialCryptoError(value) && CREDENTIAL_CRYPTO_RETRYABLE[value.code];
}
