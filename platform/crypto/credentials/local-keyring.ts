/**
 * LocalKeyring — local development and tests only (Step 5A; D12). It keeps the security semantics of the
 * KMS adapter without reproducing AWS APIs: a fresh per-record data key, wrapped by a local 256-bit KEK
 * with AES-256-GCM under the wrap AAD it derives from the structured binding (dekWrapAad(header, context)), never
 * persisted in plaintext.
 *
 * Key material: exactly 32 bytes. Configuration form: unpadded base64url, exactly 43 characters
 * (`LOCAL_KEYRING_KEY`). No passphrase derivation, no generated default, no fallback: anything else fails
 * closed. Allowed only when NODE_ENV is "development" or "test" (the repository's environment convention);
 * every factory takes the environment explicitly and refuses otherwise. The key is never printed or logged.
 */
import { decrypt, dekWrapAad, encrypt, newDataKey, zero } from "./aead";
import { DEK_BYTES, IV_BYTES, TAG_BYTES, type EnvelopeHeader } from "./envelope";
import { CredentialCryptoError } from "./errors";
import type { DataKeyBinding, DataKeyGenerator, DataKeyUnwrapRequest, DataKeyUnwrapper } from "./keyring";

export const LOCAL_KEYRING_KEY_ENV = "LOCAL_KEYRING_KEY";
export const LOCAL_KEYRING_ALLOWED_NODE_ENVS: readonly string[] = ["development", "test"];
export const LOCAL_KEY_REF = "local-v1";
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;
const WRAPPED_BYTES = IV_BYTES + DEK_BYTES + TAG_BYTES;

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

/** Fails closed unless NODE_ENV is an accepted local/test value. */
export function assertLocalKeyringAllowed(environment: RuntimeEnvironment): void {
  if (!LOCAL_KEYRING_ALLOWED_NODE_ENVS.includes(environment["NODE_ENV"] ?? "")) {
    throw new CredentialCryptoError("LOCAL_KEYRING_FORBIDDEN");
  }
}

/** Startup guard for composition roots: local key material must not even be present outside local/test. */
export function assertNoLocalKeyringOutsideLocal(environment: RuntimeEnvironment): void {
  if (environment[LOCAL_KEYRING_KEY_ENV] !== undefined) assertLocalKeyringAllowed(environment);
}

/** Strict parse: 43 unpadded base64url characters decoding to exactly 32 bytes (canonical form only). */
export function parseLocalKeyringKey(value: unknown): Buffer {
  if (typeof value !== "string" || !KEY_TEXT.test(value)) throw new CredentialCryptoError("INVALID_LOCAL_KEY_CONFIGURATION");
  const key = Buffer.from(value, "base64url");
  if (key.length !== DEK_BYTES || key.toString("base64url") !== value) {
    zero(key);
    throw new CredentialCryptoError("INVALID_LOCAL_KEY_CONFIGURATION");
  }
  return key;
}

export interface LocalKeyring {
  readonly generator: DataKeyGenerator;
  readonly unwrapper: DataKeyUnwrapper;
  /** Zeroes the KEK; every later operation fails with KEYRING_UNAVAILABLE. */
  destroy(): void;
}

/** Copies the 32-byte KEK (the caller zeroes its own copy). */
export function createLocalKeyring(key: Uint8Array, environment: RuntimeEnvironment): LocalKeyring {
  assertLocalKeyringAllowed(environment);
  if (!(key instanceof Uint8Array) || key.byteLength !== DEK_BYTES) throw new CredentialCryptoError("INVALID_LOCAL_KEY_CONFIGURATION");
  const kek = Buffer.alloc(DEK_BYTES);
  kek.set(key);
  let destroyed = false;
  const usable = (): Buffer => {
    if (destroyed) throw new CredentialCryptoError("KEYRING_UNAVAILABLE");
    return kek;
  };
  // Only this keyring's own header: another KEK provider or logical key reference is not ours to wrap or unwrap.
  const ownHeader = (header: EnvelopeHeader): void => {
    if (header.kekProvider !== "local" || header.keyRef !== LOCAL_KEY_REF) throw new CredentialCryptoError("KEYRING_MISMATCH");
  };

  const generator: DataKeyGenerator = Object.freeze({
    kekProvider: "local" as const,
    keyRef: LOCAL_KEY_REF,
    generateDataKey(binding: DataKeyBinding) {
      let dek: Buffer | undefined;
      try {
        const wrappingKey = usable();
        ownHeader(binding.header);
        const additionalData = dekWrapAad(binding.header, binding.context);
        dek = newDataKey();
        const sealed = encrypt(wrappingKey, dek, additionalData);
        return Promise.resolve({ dek, wrappedDek: new Uint8Array(Buffer.concat([sealed.iv, sealed.ciphertext, sealed.authTag])) });
      } catch (error) {
        zero(dek);
        return Promise.reject(error instanceof CredentialCryptoError ? error : new CredentialCryptoError("KEYRING_UNAVAILABLE"));
      }
    },
  });

  const unwrapper: DataKeyUnwrapper = Object.freeze({
    kekProvider: "local" as const,
    unwrapDataKey(request: DataKeyUnwrapRequest) {
      try {
        const wrappingKey = usable();
        ownHeader(request.header);
        if (request.wrappedDek.byteLength !== WRAPPED_BYTES) throw new CredentialCryptoError("INTEGRITY_FAILURE");
        const wrapped = Buffer.from(request.wrappedDek);
        const sealed = {
          iv: wrapped.subarray(0, IV_BYTES),
          ciphertext: wrapped.subarray(IV_BYTES, IV_BYTES + DEK_BYTES),
          authTag: wrapped.subarray(IV_BYTES + DEK_BYTES),
        };
        return Promise.resolve(decrypt(wrappingKey, sealed, dekWrapAad(request.header, request.context)));
      } catch (error) {
        return Promise.reject(error instanceof CredentialCryptoError ? error : new CredentialCryptoError("KEYRING_UNAVAILABLE"));
      }
    },
  });

  return Object.freeze({
    generator,
    unwrapper,
    destroy() {
      zero(kek);
      destroyed = true;
    },
  });
}

/** Reads LOCAL_KEYRING_KEY (required) under the environment guard; the decoded copy is zeroed after use. */
export function localKeyringFromEnvironment(environment: RuntimeEnvironment): LocalKeyring {
  assertLocalKeyringAllowed(environment);
  const value = environment[LOCAL_KEYRING_KEY_ENV];
  if (value === undefined || value === "") throw new CredentialCryptoError("INVALID_LOCAL_KEY_CONFIGURATION");
  const key = parseLocalKeyringKey(value);
  try {
    return createLocalKeyring(key, environment);
  } finally {
    zero(key);
  }
}
