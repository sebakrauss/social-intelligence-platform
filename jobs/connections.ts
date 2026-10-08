/**
 * Job-runtime composition of the INTEGRATION-plane connections tasks (Step 7E.4B.3): discovery (Step 5D; TA §39) and
 * capability evaluation after an activation (Step 5F) — the only tasks that open a provider credential. The Move saga
 * steps open nothing and run in the main plane (jobs/moves.ts). Thin handlers: resolve the run's identifiers, call the
 * application service; the services re-read every authority (connection, account, active credential) from the
 * database under the run's single bound workspace, so a trigger's identifiers can never redirect decryption.
 * This is the ONLY place the provider-credential opener meets the connections module:
 *   - the local-keyring startup guard runs first (LOCAL_KEYRING_KEY outside development/test aborts);
 *   - the credential-access function opens one envelope under its exact (env, workspace, credential) context,
 *     decodes it into a normalized ProviderCredential for one provider call, and lets the opener zero the
 *     plaintext afterwards. Tampered, foreign or malformed envelopes become CredentialUnreadableError; a keyring
 *     outage propagates (retryable); a denied or misconfigured keyring is a non-retryable operational failure,
 *     never "credential unreadable" (Step 7D). Nothing is cached.
 *   - the opener is the local keyring's in development/test, the KMS Decrypt opener where KMS is configured
 *     (Step 7D), whose AWS identity is the integration worker's assumed role (Step 7E.4C: bootstrap IAM user →
 *     STS AssumeRole → temporary credentials, jobs/integration-aws-identity.ts) — Decrypt only, never sealing.
 */
import { randomUUID } from "node:crypto";
import {
  CredentialCodecError,
  CredentialUnreadableError,
  decodeProviderCredential,
  discoverConnectionAssets,
  refreshAccountCapabilities,
  type CapabilityRefreshOutcome,
  type DiscoveryDependencies,
  type DiscoveryOutcome,
  type DiscoveryProviders,
  type ProviderCredentialAccess,
} from "@/modules/connections";
import { credentialContext } from "@/platform/crypto/credentials/context";
import { decodeEnvelope } from "@/platform/crypto/credentials/envelope";
import { createKmsClient, type KmsCredentialSource } from "@/platform/crypto/credentials/aws-kms-client";
import { kmsCredentialOpener } from "@/platform/crypto/credentials/aws-kms-opener";
import type { CredentialContextEnv } from "@/platform/crypto/credentials/context";
import { isCredentialCryptoError, isRetryableCredentialCryptoError, type CredentialCryptoErrorCode } from "@/platform/crypto/credentials/errors";
import { assertNoLocalKeyringOutsideLocal } from "@/platform/crypto/credentials/local-keyring";
import { localCredentialOpenerFromEnvironment } from "@/platform/crypto/credentials/local-opener";
import type { CredentialOpener } from "@/platform/crypto/credentials/open";
import { parseCorrelationId } from "@/domain/correlation";
import { parseWorkspaceId } from "@/domain/ids";
import { NonRetryableJobError, type TenantStepJobContext } from "@/platform/jobs";
import { providerCredential } from "@/integrations/providers/contract";
import { createStagingStubReadPort } from "@/integrations/providers/staging-stub";
import { readKmsKeyringConfig, selectCredentialCrypto } from "@/server/connections/environment";
import { createIntegrationWorkerAwsCredentials } from "./integration-aws-identity";
import { providerComposition } from "@/server/connections/provider-mode";
import { localSimulator } from "@/server/connections/simulator";
import { capabilityRefreshStores, connectionWorkerStore } from "@/server/persistence/connections";

type Environment = Readonly<Record<string, string | undefined>>;

/** Envelope-level failures: this credential can't be read (tampered, foreign, wrong keyring, malformed). */
const UNREADABLE_CODES: readonly CredentialCryptoErrorCode[] = ["INTEGRITY_FAILURE", "KEYRING_MISMATCH", "MALFORMED_ENVELOPE", "UNSUPPORTED_ENVELOPE_VERSION", "INVALID_CONTEXT"];

/**
 * A credential-access failure BEFORE the provider call, as the job sees it (Step 7D). Retryability comes only from
 * the credential-crypto table (errors.ts): a keyring outage is rethrown unchanged and the job retries. Envelope-level
 * failures are CredentialUnreadableError. Every other crypto failure — access denied, misconfigured keyring, or any
 * code not listed — is a non-retryable OPERATIONAL failure with a fixed class: it says nothing about the credential
 * and carries no key-service detail.
 */
export function credentialAccessFailure(error: unknown): unknown {
  if (error instanceof CredentialCodecError) return new CredentialUnreadableError();
  if (!isCredentialCryptoError(error)) return error;
  if (isRetryableCredentialCryptoError(error)) return error;
  if (UNREADABLE_CODES.includes(error.code)) return new CredentialUnreadableError();
  return new NonRetryableJobError(error.code === "KEYRING_ACCESS_DENIED" ? "credential_keyring_access_denied" : "credential_keyring_misconfigured");
}

export function createCredentialAccess(opener: CredentialOpener, env: string): ProviderCredentialAccess {
  return {
    async withCredential(input, use) {
      let envelope;
      let context;
      try {
        envelope = decodeEnvelope(input.envelope);
        context = credentialContext({ purpose: "provider-credential", env, workspaceId: input.workspaceId, credentialId: input.credentialId });
      } catch {
        throw new CredentialUnreadableError();
      }
      const progress = { decoded: false };
      try {
        return await opener.open(envelope, context, (plaintext) => {
          const credential = decodeProviderCredential(plaintext);
          progress.decoded = true;
          return use(credential);
        });
      } catch (error) {
        // Only failures BEFORE the provider call are about the envelope; provider errors pass through untouched.
        if (progress.decoded) throw error;
        throw credentialAccessFailure(error);
      }
    },
  };
}

interface JobComposition {
  readonly access: ProviderCredentialAccess;
  readonly providers: DiscoveryProviders;
}

let composition: JobComposition | undefined;

/**
 * staging_stub only (Step 5K): lends ONE fixed synthetic, valueless credential to the synthetic staging adapter.
 * It never opens, decodes or even reads the stored envelope, and no real or simulator adapter exists in this mode,
 * so nothing it lends can reach a provider.
 */
export function createStagingStubCredentialAccess(): ProviderCredentialAccess {
  const synthetic = providerCredential("staging-stub", "synthetic-staging-stub-credential");
  return { withCredential: (_input, use) => use(synthetic) };
}

/**
 * The job runtime's provider adapters, chosen ONLY at this composition boundary (server/connections/provider-mode.ts).
 * The application services and task handlers are identical in every mode. The local-keyring guard runs first in
 * every mode (LOCAL_KEYRING_KEY outside development/test aborts).
 */
export function composeJobProviders(environment: Environment): JobComposition {
  assertNoLocalKeyringOutsideLocal(environment);
  const selected = providerComposition(environment);
  if (selected.kind === "staging_stub") {
    const clock = (): Date => new Date();
    return { access: createStagingStubCredentialAccess(), providers: { read: (provider) => createStagingStubReadPort(provider, clock) } };
  }
  const read = localSimulator(environment).read;
  const opening = composeCredentialOpener(environment, integrationWorkerAwsCredentials(environment));
  return {
    access: createCredentialAccess(opening.opener, opening.contextEnv),
    providers: { read: (provider) => (provider === "simulator" ? read : undefined) },
  };
}

/**
 * The integration worker's AWS credential provider where KMS is configured; undefined in local/test (the local keyring
 * needs none). Lazy: building it reads nothing and calls nothing — STS is first asked when the KMS opener needs
 * credentials. Missing bootstrap configuration then fails closed (KEYRING_MISCONFIGURED), never falling back.
 */
export function integrationWorkerAwsCredentials(environment: Environment): KmsCredentialSource | undefined {
  const kms = readKmsKeyringConfig(environment);
  return kms === undefined ? undefined : createIntegrationWorkerAwsCredentials(kms);
}

export interface ComposedCredentialOpener {
  readonly opener: CredentialOpener;
  readonly contextEnv: CredentialContextEnv;
}

/**
 * The integration worker's opener (Step 7D): the local keyring's in development/test; where KMS is configured,
 * KMSClient → Decrypt unwrapper → opener, which needs the worker's AWS identity supplied explicitly (7E). Never a
 * fallback from KMS to the local keyring. Selection rules: server/connections/environment.ts.
 */
export function composeCredentialOpener(environment: Environment, awsCredentials?: KmsCredentialSource): ComposedCredentialOpener {
  const selection = selectCredentialCrypto(environment);
  if (selection.kind === "local") return { opener: localCredentialOpenerFromEnvironment(environment), contextEnv: selection.contextEnv };
  return { opener: kmsCredentialOpener(createKmsClient(selection.config, awsCredentials), selection.config), contextEnv: selection.config.contextEnv };
}

/** Discovery dependencies for one run: the composed access/providers and this run's scoped steps. */
export function discoveryDependencies(context: TenantStepJobContext, base: JobComposition): DiscoveryDependencies {
  return {
    inScope: (work) => context.inScope((scope) => work(connectionWorkerStore(scope))),
    access: base.access,
    providers: base.providers,
    clock: () => new Date(),
    newId: randomUUID,
  };
}

/** The connections.discover_assets handler: thin — resolve the run's identifiers, call the application service. */
export async function runDiscoverAssets(context: TenantStepJobContext, base?: JobComposition): Promise<DiscoveryOutcome> {
  const workspaceId = parseWorkspaceId(context.payload.workspaceId);
  const connectionId = context.payload.subjectIds["connection_id"];
  const correlationId = parseCorrelationId(context.payload.correlationId);
  if (workspaceId === undefined || connectionId === undefined || correlationId === undefined) throw new NonRetryableJobError("invalid_payload");
  const resolved = base ?? (composition ??= composeJobProviders(process.env));
  return discoverConnectionAssets(discoveryDependencies(context, resolved), {
    workspaceId,
    connectionId,
    outboxId: context.payload.outboxId,
    correlationId,
  });
}

/** capability.evaluate_account: refreshAccountCapabilities for one activated account (provider call between steps). */
export async function runEvaluateAccountCapabilities(context: TenantStepJobContext, base?: JobComposition): Promise<CapabilityRefreshOutcome> {
  const workspaceId = parseWorkspaceId(context.payload.workspaceId);
  const connectedAccountId = context.payload.subjectIds["connected_account_id"];
  if (workspaceId === undefined || connectedAccountId === undefined) throw new NonRetryableJobError("invalid_payload");
  const resolved = base ?? (composition ??= composeJobProviders(process.env));
  return refreshAccountCapabilities(
    {
      inScope: (work) => context.inScope((scope) => work(capabilityRefreshStores(scope))),
      access: resolved.access,
      providers: resolved.providers,
      clock: () => new Date(),
      environment: process.env,
    },
    { workspaceId, connectedAccountId },
  );
}
