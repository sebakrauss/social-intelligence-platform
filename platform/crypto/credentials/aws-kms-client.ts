/**
 * The KMS client factory (Step 7D; TA §39, ADR-64) — the ONLY place a concrete AWS client is constructed.
 *
 *   region       derived from the validated current key ARN (no AWS_REGION, no shared config)
 *   credentials  supplied EXPLICITLY by the runtime's composition (7E: the web's federated identity, the worker's
 *                decrypt-scoped identity) and REQUIRED: without them nothing is built. With explicit credentials the
 *                SDK never consults its default chain (environment variables, shared files, SSO, instance or container
 *                metadata), so there is no ambient discovery.
 *   endpoint     endpoint URLs from environment variables and shared config are ignored (public SDK option); the
 *                regional KMS endpoint is used
 *
 * Construction makes no network call. The client is handed to the generator/unwrapper as their narrow sender.
 */
import { KMSClient, type KMSClientConfig } from "@aws-sdk/client-kms";
import { kmsKeyArnRegion, type KmsKeyringConfig } from "./aws-kms-config";
import { CredentialCryptoError } from "./errors";

/** The AWS identity a runtime supplies explicitly (a static identity or a provider). Never discovered ambiently. */
export type KmsCredentialSource = NonNullable<KMSClientConfig["credentials"]>;

export function createKmsClient(config: KmsKeyringConfig, credentials: KmsCredentialSource | undefined): KMSClient {
  if (credentials === undefined) throw new CredentialCryptoError("KEYRING_MISCONFIGURED");
  const region = kmsKeyArnRegion(config.currentKeyArn);
  if (region !== config.region) throw new CredentialCryptoError("KEYRING_MISCONFIGURED");
  return new KMSClient({
    region,
    credentials,
    ignoreConfiguredEndpointUrls: true,
  });
}
