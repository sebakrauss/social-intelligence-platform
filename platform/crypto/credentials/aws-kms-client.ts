/**
 * The KMS client factory (Step 7D; TA §39, ADR-64) — the ONLY place a concrete AWS client is constructed.
 *
 *   region       derived from the validated current key ARN (no AWS_REGION, no shared config)
 *   credentials  supplied EXPLICITLY by the runtime's composition (7E: the web's federated identity, the worker's
 *                decrypt-scoped identity) and REQUIRED: without them nothing is built. With explicit credentials the
 *                SDK never consults its default chain (environment variables, shared files, SSO, instance or container
 *                metadata), so there is no ambient discovery. The provider stays lazy: constructing the client does
 *                not resolve it.
 *   endpoint     endpoint URLs from environment variables and shared config are ignored (public SDK option); the
 *                regional KMS endpoint is used
 *   attempts     OPTIONAL, explicit, call-site only (Step 7E.7-B-R1): AwsSingleAttempt bounds this one client to a
 *                single attempt (no SDK retry). Absent → the client is built exactly as before, with the SDK's default
 *                retry behavior. Only the integration KMS worker-auth diagnostic passes it.
 *
 * Construction makes no network call. The client is handed to the generator/unwrapper as their narrow sender.
 */
import { KMSClient } from "@aws-sdk/client-kms";
import type { AwsCredentialProvider } from "@/platform/aws/identity";
import { kmsKeyArnRegion, type KmsKeyringConfig } from "./aws-kms-config";
import { CredentialCryptoError } from "./errors";

/**
 * The AWS identity a runtime supplies explicitly: a lazy credential provider (platform/aws/identity.ts), never a
 * static identity and never discovered ambiently. It is first invoked when a KMS operation needs credentials.
 */
export type KmsCredentialSource = AwsCredentialProvider;

/**
 * The only retry setting a caller can pass to an AWS client of this application: exactly one attempt. It can only
 * remove SDK retries, never add capability; it is a function argument, never environment or shared configuration.
 */
export interface AwsSingleAttempt {
  readonly maxAttempts: 1;
}

export function createKmsClient(config: KmsKeyringConfig, credentials: KmsCredentialSource | undefined, attempts?: AwsSingleAttempt): KMSClient {
  if (credentials === undefined) throw new CredentialCryptoError("KEYRING_MISCONFIGURED");
  const region = kmsKeyArnRegion(config.currentKeyArn);
  if (region !== config.region) throw new CredentialCryptoError("KEYRING_MISCONFIGURED");
  return new KMSClient({
    region,
    credentials,
    ignoreConfiguredEndpointUrls: true,
    ...(attempts === undefined ? {} : { maxAttempts: 1 }),
  });
}
