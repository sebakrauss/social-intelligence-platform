/**
 * The deployed KMS credential keyring's configuration contract (Step 7D; TA §39, ADR-64). Pure: it receives
 * explicit values (the composition root reads them) and returns an immutable, validated configuration.
 *
 *   contextEnv      CREDENTIAL_CONTEXT_ENV — the cryptographic environment (not the deployment tier); the only
 *                   deployed label with a key policy today is "dev" (TA-Q-07b)
 *   currentKeyArn   CREDENTIAL_KMS_KEY_ARN — the full key ARN new data keys are generated under
 *   allowedKeyArns  CREDENTIAL_KMS_ALLOWED_KEY_ARNS — comma-separated full key ARNs accepted after Decrypt; spaces
 *                   around entries are ignored; empty entries, duplicates and anything but a key ARN are refused;
 *                   the current key must be one of them; all must be in the current key's region
 *   region          derived from the current key ARN (no AWS_REGION)
 *   logicalKeyRef   the protocol constant KMS_PROVIDER_CREDENTIALS_KEY_REF — never configuration
 *
 * Every failure is KEYRING_MISCONFIGURED with a fixed message: no configured value appears in any error.
 */
import { isKmsKeyArn } from "./aws-kms-common";
import { CREDENTIAL_CONTEXT_ENVS, type CredentialContextEnv } from "./context";
import { CredentialCryptoError } from "./errors";
import { isLogicalKeyRef } from "./key-ref";

/** The logical KEK reference of every AWS KMS provider-credential envelope. Protocol identity: physical keys rotate under it. */
export const KMS_PROVIDER_CREDENTIALS_KEY_REF = "kms-provider-credentials-v1";

/** Cryptographic environments that have a KMS key policy today. "local" and "test" are local-keyring only. */
export const KMS_CONTEXT_ENVS: readonly CredentialContextEnv[] = ["dev"];

export interface KmsKeyringConfig {
  readonly contextEnv: CredentialContextEnv;
  readonly logicalKeyRef: string;
  readonly currentKeyArn: string;
  readonly allowedKeyArns: ReadonlySet<string>;
  readonly region: string;
}

export interface KmsKeyringConfigInput {
  readonly contextEnv: string | undefined;
  readonly currentKeyArn: string | undefined;
  readonly allowedKeyArns: string | undefined;
}

const misconfigured = (): never => {
  throw new CredentialCryptoError("KEYRING_MISCONFIGURED");
};

/** The region of a full KMS key ARN (`arn:<partition>:kms:<region>:<account>:key/<id>`); anything else is refused. */
export function kmsKeyArnRegion(arn: unknown): string {
  if (!isKmsKeyArn(arn)) return misconfigured();
  const region = arn.split(":")[3];
  return region !== undefined && /^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region) ? region : misconfigured();
}

/** A Set whose mutators refuse: Object.freeze alone doesn't stop add/delete/clear. */
function immutableSet(values: Iterable<string>): ReadonlySet<string> {
  const set = new Set(values);
  const refuse = (): never => {
    throw new TypeError("immutable");
  };
  Object.defineProperties(set, { add: { value: refuse }, delete: { value: refuse }, clear: { value: refuse } });
  return Object.freeze(set);
}

export function parseKmsKeyringConfig(input: KmsKeyringConfigInput): KmsKeyringConfig {
  const contextEnv = input.contextEnv;
  if (!(CREDENTIAL_CONTEXT_ENVS as readonly unknown[]).includes(contextEnv) || !(KMS_CONTEXT_ENVS as readonly unknown[]).includes(contextEnv)) {
    return misconfigured();
  }
  const region = kmsKeyArnRegion(input.currentKeyArn);
  const currentKeyArn = input.currentKeyArn as string;
  if (typeof input.allowedKeyArns !== "string") return misconfigured();
  const entries = input.allowedKeyArns.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => entry === "")) return misconfigured();
  const allowed = new Set(entries);
  if (allowed.size !== entries.length || !allowed.has(currentKeyArn)) return misconfigured();
  for (const arn of allowed) if (kmsKeyArnRegion(arn) !== region) misconfigured();
  if (!isLogicalKeyRef(KMS_PROVIDER_CREDENTIALS_KEY_REF)) return misconfigured();
  return Object.freeze({
    contextEnv: contextEnv as CredentialContextEnv,
    logicalKeyRef: KMS_PROVIDER_CREDENTIALS_KEY_REF,
    currentKeyArn,
    allowedKeyArns: immutableSet(allowed),
    region,
  });
}
