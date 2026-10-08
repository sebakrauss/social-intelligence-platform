/**
 * The web's AWS identity seam (Step 7E.2; TA §39, ADR-64). The hosted web seals with KMS GenerateDataKey under a
 * temporary identity obtained from its own workload identity (7E.3: Vercel OIDC, Team issuer, audience
 * sts.amazonaws.com → AssumeRoleWithWebIdentity into the web role). No long-lived AWS credential exists here.
 *
 *   CREDENTIAL_KMS_WEB_ROLE_ARN  non-secret: the exact IAM role ARN the web assumes. No default; a malformed value
 *                                fails closed (never echoed). Read only here — the job runtime never reads it.
 *   stsRegion                    the region of the validated KMS key (CREDENTIAL_KMS_KEY_ARN): the same deployment
 *                                configuration decides where the web federates; no AWS_REGION, no second variable.
 *   WebAwsIdentityFactory        the adapter (7E.3B: vercel-aws-identity.ts) that turns that configuration into a LAZY
 *                                credential provider.
 *                                It must not resolve anything when called: the OIDC token exists only inside a request,
 *                                so credentials are first resolved when a KMS operation needs them.
 *
 * Without a factory (none exists before 7E.3) or without the role ARN there is no provider, and KMS-configured
 * sealing fails closed at composition. Local/test sealing needs neither.
 */
import { AWS_STS_OIDC_AUDIENCE, AwsIdentityError, parseIamRoleArn, type AwsCredentialProvider } from "@/platform/aws/identity";
import { CredentialCryptoError } from "@/platform/crypto/credentials/errors";
import { readKmsKeyringConfig } from "./environment";

type Environment = Readonly<Record<string, string | undefined>>;

export const CREDENTIAL_KMS_WEB_ROLE_ARN = "CREDENTIAL_KMS_WEB_ROLE_ARN";

export interface WebAwsRoleConfig {
  readonly roleArn: string;
  readonly audience: typeof AWS_STS_OIDC_AUDIENCE;
}

export interface WebAwsIdentityConfig extends WebAwsRoleConfig {
  /** Derived from the validated KMS key ARN; the only source of the STS region. */
  readonly stsRegion: string;
}

/** Builds the web's lazy credential provider from its configuration (7E.3: the Vercel OIDC adapter). */
export type WebAwsIdentityFactory = (config: WebAwsIdentityConfig) => AwsCredentialProvider;

/** The web role configuration: undefined when unset (or empty); a set value must be a full IAM role ARN. */
export function readWebAwsIdentityConfig(environment: Environment): WebAwsRoleConfig | undefined {
  const value = environment[CREDENTIAL_KMS_WEB_ROLE_ARN];
  if (value === undefined || value === "") return undefined;
  try {
    return Object.freeze({ roleArn: parseIamRoleArn(value), audience: AWS_STS_OIDC_AUDIENCE });
  } catch (error) {
    throw error instanceof AwsIdentityError ? new CredentialCryptoError("KEYRING_MISCONFIGURED") : error;
  }
}

/**
 * The web's explicit AWS credential provider, or undefined when no identity can be composed (no role, no adapter, or
 * no KMS configuration — local/test). Resolves nothing.
 */
export function composeWebAwsCredentials(environment: Environment, factory: WebAwsIdentityFactory | undefined): AwsCredentialProvider | undefined {
  const role = readWebAwsIdentityConfig(environment);
  if (role === undefined || factory === undefined) return undefined;
  const kms = readKmsKeyringConfig(environment);
  if (kms === undefined) return undefined;
  return factory(Object.freeze({ ...role, stsRegion: kms.region }));
}
