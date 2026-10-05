/**
 * Provider credentials at the adapter boundary (TA §39). A credential reaches an adapter only for the duration
 * of one provider call, decrypted by the credential-access function (Step 5). Inside the contract it is opaque:
 * `id` is a safe identifier for diagnostics; the secret material is wrapped so it can't leak through logging,
 * serialization, string interpolation or error messages by accident.
 */

const REDACTED = "[redacted]";

/** Secret material that refuses to render itself. Only adapters call `expose()`, at the moment of the call. */
export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    if (value.length === 0) throw new TypeError("empty secret");
    this.#value = value;
  }

  expose(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

export interface ProviderCredential {
  /** Safe, non-secret identifier of the credential (for diagnostics and receipts). */
  readonly id: string;
  readonly secret: SecretValue;
}

export function providerCredential(id: string, secret: string): ProviderCredential {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) throw new TypeError("invalid credential id");
  return Object.freeze({ id, secret: new SecretValue(secret) });
}
