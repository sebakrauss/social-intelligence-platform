/**
 * Job-runtime composition of connection discovery (Step 5D; TA §39). The ONLY place the provider-credential
 * opener meets the connections module:
 *   - the local-keyring startup guard runs first (LOCAL_KEYRING_KEY outside development/test aborts);
 *   - the credential-access function opens one envelope under its exact (env, workspace, credential) context,
 *     decodes it into a normalized ProviderCredential for one provider call, and lets the opener zero the
 *     plaintext afterwards. Tampered, foreign or malformed envelopes become CredentialUnreadableError; a keyring
 *     outage propagates (retryable). Nothing is cached.
 */
import { randomUUID } from "node:crypto";
import {
  CredentialCodecError,
  CredentialUnreadableError,
  decodeProviderCredential,
  discoverConnectionAssets,
  type DiscoveryDependencies,
  type DiscoveryOutcome,
  type DiscoveryProviders,
  type ProviderCredentialAccess,
} from "@/modules/connections";
import { credentialContext } from "@/platform/crypto/credentials/context";
import { decodeEnvelope } from "@/platform/crypto/credentials/envelope";
import { isCredentialCryptoError } from "@/platform/crypto/credentials/errors";
import { assertNoLocalKeyringOutsideLocal } from "@/platform/crypto/credentials/local-keyring";
import { localCredentialOpenerFromEnvironment } from "@/platform/crypto/credentials/local-opener";
import type { CredentialOpener } from "@/platform/crypto/credentials/open";
import { parseCorrelationId } from "@/domain/correlation";
import { parseWorkspaceId } from "@/domain/ids";
import { NonRetryableJobError, type TenantStepJobContext } from "@/platform/jobs";
import { credentialEnvironmentLabel } from "@/server/connections/environment";
import { localSimulator } from "@/server/connections/simulator";
import { connectionWorkerStore } from "@/server/persistence/connections";

type Environment = Readonly<Record<string, string | undefined>>;

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
        if (isCredentialCryptoError(error) && error.code === "KEYRING_UNAVAILABLE") throw error;
        if (isCredentialCryptoError(error) || error instanceof CredentialCodecError) throw new CredentialUnreadableError();
        throw error;
      }
    },
  };
}

interface JobComposition {
  readonly access: ProviderCredentialAccess;
  readonly providers: DiscoveryProviders;
}

let composition: JobComposition | undefined;

function compose(environment: Environment): JobComposition {
  assertNoLocalKeyringOutsideLocal(environment);
  const read = localSimulator(environment).read;
  return {
    access: createCredentialAccess(localCredentialOpenerFromEnvironment(environment), credentialEnvironmentLabel(environment)),
    providers: { read: (provider) => (provider === "simulator" ? read : undefined) },
  };
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
  const resolved = base ?? (composition ??= compose(process.env));
  return discoverConnectionAssets(discoveryDependencies(context, resolved), {
    workspaceId,
    connectionId,
    outboxId: context.payload.outboxId,
    correlationId,
  });
}
