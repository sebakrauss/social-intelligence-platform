/**
 * AWS KMS keyring — the SDK-free pieces shared by the generator (seal side) and the unwrapper (open side)
 * (Step 7C; TA §39, ADR-64, TA-Q-07b). No KMS client is created here or anywhere in this step: the adapters receive
 * an injected sender, and credentials, region and key configuration are composed later (7D).
 *
 *   encryption context  exactly the six CredentialContext fields, as strings, in canonical order — the shape the
 *                       TA-Q-07b key policy pins; nothing else (no keyRef, no physical key, no deployment metadata)
 *   physical keys       full KMS key ARNs (what KMS returns as KeyId), configured per adapter, never in an envelope
 *   errors              every SDK, service or transport failure becomes one fixed CredentialCryptoError code; no
 *                       message, name or value of the original error is kept
 */
import { parseCredentialContext, type CREDENTIAL_CONTEXT_FIELDS, type CredentialContext } from "./context";
import { DEK_BYTES, type EnvelopeHeader } from "./envelope";
import { CredentialCryptoError, type CredentialCryptoErrorCode } from "./errors";
import { isLogicalKeyRef } from "./key-ref";

export const KMS_KEK_PROVIDER = "aws-kms" as const;

export type KmsEncryptionContext = { readonly [Field in (typeof CREDENTIAL_CONTEXT_FIELDS)[number]]: string };

/** The caller's validated context, field for field, as the KMS encryption context. */
export function kmsEncryptionContext(context: CredentialContext): KmsEncryptionContext {
  const checked = parseCredentialContext(context);
  return Object.freeze({
    app: checked.app,
    purpose: checked.purpose,
    env: checked.env,
    v: checked.v,
    workspace_id: checked.workspace_id,
    credential_id: checked.credential_id,
  });
}

/** A full KMS key ARN (single- or multi-Region key), any AWS partition. Aliases and bare key IDs are not accepted. */
const KMS_KEY_ARN = /^arn:aws(?:-[a-z]+)*:kms:[a-z]{2}(?:-[a-z]+)+-\d:\d{12}:key\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$/;

export function isKmsKeyArn(value: unknown): value is string {
  return typeof value === "string" && KMS_KEY_ARN.test(value);
}

const misconfigured = (): never => {
  throw new CredentialCryptoError("KEYRING_MISCONFIGURED");
};

/** Adapter configuration check: a logical keyRef (never a physical identifier). */
export function checkedLogicalKeyRef(keyRef: unknown): string {
  return isLogicalKeyRef(keyRef) ? keyRef : misconfigured();
}

/** Adapter configuration check: a non-empty set of distinct KMS key ARNs. */
export function checkedKeyArns(keyArns: unknown): ReadonlySet<string> {
  if (!Array.isArray(keyArns) || keyArns.length === 0 || !keyArns.every(isKmsKeyArn)) return misconfigured();
  const set = new Set<string>(keyArns);
  return set.size === keyArns.length ? set : misconfigured();
}

/** The binding must name THIS keyring: the aws-kms provider and its own logical keyRef. */
export function assertOwnHeader(header: EnvelopeHeader, keyRef: string): void {
  if (header.kekProvider !== KMS_KEK_PROVIDER || header.keyRef !== keyRef) throw new CredentialCryptoError("KEYRING_MISMATCH");
}

export function zeroBytes(bytes: Uint8Array | undefined): void {
  bytes?.fill(0);
}

/**
 * The plaintext data key KMS returned, as a Buffer VIEW over the same memory (no copy): zeroing the returned Buffer
 * zeroes what the SDK handed us. Anything but exactly 32 bytes is zeroed and refused.
 */
export function takeDataKey(plaintext: Uint8Array | undefined): Buffer {
  if (!(plaintext instanceof Uint8Array)) return misconfigured();
  if (plaintext.byteLength !== DEK_BYTES) {
    zeroBytes(plaintext);
    return misconfigured();
  }
  return Buffer.from(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
}

/**
 * KMS failure → normalized code. Names are the exception classes @aws-sdk/client-kms 3.1146.0 exports for
 * GenerateDataKey and Decrypt, plus the service-level errors KMS returns without a modeled class (AccessDenied,
 * throttling, authentication) and the SDK's own transport and credential failures.
 *
 *   INTEGRITY_FAILURE      the ciphertext doesn't authenticate under this encryption context (tampered, foreign,
 *                          wrong workspace/credential/env)
 *   KEYRING_ACCESS_DENIED  the principal may not do this, or its request isn't authenticated
 *   KEYRING_MISCONFIGURED  the key or the request is wrong for this keyring (disabled, missing, pending deletion,
 *                          wrong usage, invalid ARN/grant, validation, no credentials configured)
 *   KEYRING_UNAVAILABLE    KMS or the network failed transiently: modeled server faults, throttling, timeouts,
 *                          connection errors, and any error the SDK itself marks retryable or as a server fault
 *
 * Anything else fails closed as KEYRING_MISCONFIGURED: not retryable, so an unknown client-side failure is surfaced
 * to operators instead of being retried forever, and nothing about it (message, name, fields) is kept.
 */
const KMS_ERROR_CODES: Readonly<Record<string, CredentialCryptoErrorCode>> = Object.freeze({
  InvalidCiphertextException: "INTEGRITY_FAILURE",
  IncorrectKeyException: "INTEGRITY_FAILURE",

  AccessDeniedException: "KEYRING_ACCESS_DENIED",
  UnrecognizedClientException: "KEYRING_ACCESS_DENIED",
  InvalidSignatureException: "KEYRING_ACCESS_DENIED",
  IncompleteSignature: "KEYRING_ACCESS_DENIED",
  MissingAuthenticationToken: "KEYRING_ACCESS_DENIED",
  InvalidClientTokenId: "KEYRING_ACCESS_DENIED",
  ExpiredTokenException: "KEYRING_ACCESS_DENIED",

  DisabledException: "KEYRING_MISCONFIGURED",
  NotFoundException: "KEYRING_MISCONFIGURED",
  KMSInvalidStateException: "KEYRING_MISCONFIGURED",
  InvalidKeyUsageException: "KEYRING_MISCONFIGURED",
  InvalidArnException: "KEYRING_MISCONFIGURED",
  InvalidGrantTokenException: "KEYRING_MISCONFIGURED",
  DryRunOperationException: "KEYRING_MISCONFIGURED",
  UnsupportedOperationException: "KEYRING_MISCONFIGURED",
  ValidationException: "KEYRING_MISCONFIGURED",
  CredentialsProviderError: "KEYRING_MISCONFIGURED",

  KMSInternalException: "KEYRING_UNAVAILABLE",
  DependencyTimeoutException: "KEYRING_UNAVAILABLE",
  KeyUnavailableException: "KEYRING_UNAVAILABLE",
  ThrottlingException: "KEYRING_UNAVAILABLE",
  ServiceUnavailableException: "KEYRING_UNAVAILABLE",
  InternalFailure: "KEYRING_UNAVAILABLE",
  RequestTimeout: "KEYRING_UNAVAILABLE",
  RequestTimeoutException: "KEYRING_UNAVAILABLE",
  TimeoutError: "KEYRING_UNAVAILABLE",
});

/** Node network failures that never reached KMS or lost the answer. */
const TRANSIENT_NETWORK_CODES: readonly string[] = ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"];

const own = (value: object, key: string): unknown => (Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined);

export function kmsErrorCode(error: unknown): CredentialCryptoErrorCode {
  if (typeof error !== "object" || error === null) return "KEYRING_MISCONFIGURED";
  const name = (error as { name?: unknown }).name;
  if (typeof name === "string" && Object.hasOwn(KMS_ERROR_CODES, name)) return KMS_ERROR_CODES[name] ?? "KEYRING_MISCONFIGURED";
  const code = own(error, "code");
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.includes(code)) return "KEYRING_UNAVAILABLE";
  if (typeof own(error, "$retryable") === "object" && own(error, "$retryable") !== null) return "KEYRING_UNAVAILABLE";
  if (own(error, "$fault") === "server") return "KEYRING_UNAVAILABLE";
  return "KEYRING_MISCONFIGURED";
}

/** Our own normalized errors pass through; anything else becomes a fresh error carrying only its code. */
export function normalizedKmsFailure(error: unknown): CredentialCryptoError {
  return error instanceof CredentialCryptoError ? error : new CredentialCryptoError(kmsErrorCode(error));
}
