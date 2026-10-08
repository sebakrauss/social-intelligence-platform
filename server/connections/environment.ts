/**
 * Credential-crypto selection at the composition boundary (Step 5D; Step 7D; TA §39, ADR-64), shared by the web
 * (seal) and the job runtime (open). Composition roots pass their environment; nothing here reads process.env.
 *
 *   KMS configured   CREDENTIAL_CONTEXT_ENV + CREDENTIAL_KMS_KEY_ARN + CREDENTIAL_KMS_ALLOWED_KEY_ARNS, all three
 *                    valid (aws-kms-config.ts) → the AWS KMS keyring, context env = CREDENTIAL_CONTEXT_ENV ("dev").
 *                    A LOCAL_KEYRING_KEY alongside it is refused: never two keyrings.
 *   none of them     NODE_ENV test → local keyring, env "test"; NODE_ENV development → local keyring, env "local".
 *                    Anything else is a deployed runtime without its key configuration: refused — never a fallback
 *                    to the local keyring.
 *   some of them     incomplete configuration: refused.
 *
 * An empty value counts as unset (the .env convention). The cryptographic environment is its own concept: it is not
 * APP_DEPLOYMENT_ENV, NODE_ENV or a hosting target. Errors are fixed codes; no configured value is ever echoed.
 */
import { parseKmsKeyringConfig, type KmsKeyringConfig } from "@/platform/crypto/credentials/aws-kms-config";
import type { CredentialContextEnv } from "@/platform/crypto/credentials/context";
import { CredentialCryptoError } from "@/platform/crypto/credentials/errors";
import { LOCAL_KEYRING_KEY_ENV } from "@/platform/crypto/credentials/local-sealer";

type Environment = Readonly<Record<string, string | undefined>>;

export const CREDENTIAL_CONTEXT_ENV = "CREDENTIAL_CONTEXT_ENV";
export const CREDENTIAL_KMS_KEY_ARN = "CREDENTIAL_KMS_KEY_ARN";
export const CREDENTIAL_KMS_ALLOWED_KEY_ARNS = "CREDENTIAL_KMS_ALLOWED_KEY_ARNS";
const KMS_VARIABLES = [CREDENTIAL_CONTEXT_ENV, CREDENTIAL_KMS_KEY_ARN, CREDENTIAL_KMS_ALLOWED_KEY_ARNS] as const;

export type CredentialCryptoSelection =
  | { readonly kind: "local"; readonly contextEnv: "local" | "test" }
  | { readonly kind: "kms"; readonly config: KmsKeyringConfig };

const configured = (value: string | undefined): value is string => value !== undefined && value !== "";

/** The KMS keyring configuration: undefined when none of its variables is set; otherwise all must be set and valid. */
export function readKmsKeyringConfig(environment: Environment): KmsKeyringConfig | undefined {
  const present = KMS_VARIABLES.filter((name) => configured(environment[name]));
  if (present.length === 0) return undefined;
  if (present.length !== KMS_VARIABLES.length) throw new CredentialCryptoError("KEYRING_MISCONFIGURED");
  return parseKmsKeyringConfig({
    contextEnv: environment[CREDENTIAL_CONTEXT_ENV],
    currentKeyArn: environment[CREDENTIAL_KMS_KEY_ARN],
    allowedKeyArns: environment[CREDENTIAL_KMS_ALLOWED_KEY_ARNS],
  });
}

export function selectCredentialCrypto(environment: Environment): CredentialCryptoSelection {
  const kms = readKmsKeyringConfig(environment);
  if (kms !== undefined) {
    if (environment[LOCAL_KEYRING_KEY_ENV] !== undefined) throw new CredentialCryptoError("KEYRING_MISCONFIGURED");
    return Object.freeze({ kind: "kms", config: kms });
  }
  const nodeEnv = environment["NODE_ENV"];
  if (nodeEnv === "test") return Object.freeze({ kind: "local", contextEnv: "test" });
  if (nodeEnv === "development") return Object.freeze({ kind: "local", contextEnv: "local" });
  throw new CredentialCryptoError("KEYRING_MISCONFIGURED");
}

/**
 * The credential-context environment label (ADR-64: `env` is part of the authenticated context), so an envelope opens
 * only in the cryptographic environment that sealed it.
 */
export function credentialEnvironmentLabel(environment: Environment): CredentialContextEnv {
  const selection = selectCredentialCrypto(environment);
  return selection.kind === "local" ? selection.contextEnv : selection.config.contextEnv;
}
