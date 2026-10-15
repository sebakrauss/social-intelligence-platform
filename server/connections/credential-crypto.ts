/**
 * Seal-side credential-crypto composition (Step 7D; TA §39, ADR-64) for the web and, when refresh flows need fresh
 * envelopes, the integration worker. It returns a CredentialSealer and its context env — never an opener, so no
 * decrypt capability exists on this path.
 *
 * Local/test: the local keyring. KMS-configured runtimes: KMSClient → GenerateDataKey generator → sealer, which needs
 * the runtime's AWS identity supplied explicitly; without it (no identity mechanism before 7E) composition fails
 * closed. Selection rules: ./environment.ts.
 *
 * AWS retries (Step 7E.10-B): the product web composition passes no attempt bound, so the KMS client keeps the SDK's
 * default retry behavior; only the web KMS identity diagnostic passes AwsSingleAttempt (one GenerateDataKey attempt).
 */
import { createKmsClient, type AwsSingleAttempt, type KmsCredentialSource } from "@/platform/crypto/credentials/aws-kms-client";
import { kmsCredentialSealer } from "@/platform/crypto/credentials/aws-kms-sealer";
import type { CredentialContextEnv } from "@/platform/crypto/credentials/context";
import { localCredentialSealerFromEnvironment } from "@/platform/crypto/credentials/local-sealer";
import type { CredentialSealer } from "@/platform/crypto/credentials/seal";
import { selectCredentialCrypto } from "./environment";

type Environment = Readonly<Record<string, string | undefined>>;

export interface ComposedCredentialSealer {
  readonly sealer: CredentialSealer;
  readonly contextEnv: CredentialContextEnv;
}

export function composeCredentialSealer(environment: Environment, awsCredentials?: KmsCredentialSource, attempts?: AwsSingleAttempt): ComposedCredentialSealer {
  const selection = selectCredentialCrypto(environment);
  if (selection.kind === "local") return { sealer: localCredentialSealerFromEnvironment(environment), contextEnv: selection.contextEnv };
  return { sealer: kmsCredentialSealer(createKmsClient(selection.config, awsCredentials, attempts), selection.config), contextEnv: selection.config.contextEnv };
}
