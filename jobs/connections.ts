/**
 * Job-runtime composition of the connections tasks: discovery (Step 5D; TA §39), the Move saga steps and capability
 * evaluation after an activation (Step 5F). Thin handlers: resolve the run's identifiers, call the application service.
 * This is the ONLY place the provider-credential opener meets the connections module:
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
  activateDestination,
  decodeProviderCredential,
  discoverConnectionAssets,
  refreshAccountCapabilities,
  rejectDestination,
  releaseSource,
  type ActivationResult,
  type CapabilityRefreshOutcome,
  type DiscoveryDependencies,
  type DiscoveryOutcome,
  type DiscoveryProviders,
  type ProviderCredentialAccess,
  type RejectionResult,
  type ReleaseOutcome,
  type SagaStepInput,
} from "@/modules/connections";
import { credentialContext } from "@/platform/crypto/credentials/context";
import { decodeEnvelope } from "@/platform/crypto/credentials/envelope";
import { isCredentialCryptoError } from "@/platform/crypto/credentials/errors";
import { assertNoLocalKeyringOutsideLocal } from "@/platform/crypto/credentials/local-keyring";
import { localCredentialOpenerFromEnvironment } from "@/platform/crypto/credentials/local-opener";
import type { CredentialOpener } from "@/platform/crypto/credentials/open";
import { parseCorrelationId } from "@/domain/correlation";
import { parseUserId, parseWorkspaceId } from "@/domain/ids";
import { NonRetryableJobError, type TenantJobContext, type TenantStepJobContext } from "@/platform/jobs";
import { providerCredential } from "@/integrations/providers/contract";
import { createStagingStubReadPort } from "@/integrations/providers/staging-stub";
import { credentialEnvironmentLabel } from "@/server/connections/environment";
import { providerComposition } from "@/server/connections/provider-mode";
import { localSimulator } from "@/server/connections/simulator";
import { capabilityRefreshStores, connectionWorkerStore } from "@/server/persistence/connections";

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
  const resolved = base ?? (composition ??= composeJobProviders(process.env));
  return discoverConnectionAssets(discoveryDependencies(context, resolved), {
    workspaceId,
    connectionId,
    outboxId: context.payload.outboxId,
    correlationId,
  });
}

/** The common identifiers of a Move saga step (one workspace; IDs only; the move id is the subject). */
function sagaInput(context: TenantJobContext): SagaStepInput {
  const workspaceId = parseWorkspaceId(context.payload.workspaceId);
  const moveId = context.payload.subjectIds["move_id"];
  const correlationId = parseCorrelationId(context.payload.correlationId);
  if (workspaceId === undefined || moveId === undefined || correlationId === undefined) throw new NonRetryableJobError("invalid_payload");
  return { workspaceId, moveId, outboxId: context.payload.outboxId, correlationId, now: new Date(), newId: randomUUID };
}

/** connections.move.release_source (source workspace). Routed only by connections.route_move_step, for a human initiator. */
export async function runReleaseSource(context: TenantJobContext): Promise<ReleaseOutcome> {
  const input = sagaInput(context);
  const connectedAccountId = context.payload.subjectIds["connected_account_id"];
  const destinationWorkspaceId = parseWorkspaceId(context.payload.subjectIds["counterpart_workspace_id"]);
  const initiator = context.payload.initiator.type === "user" ? parseUserId(context.payload.initiator.userId) : undefined;
  if (connectedAccountId === undefined || destinationWorkspaceId === undefined || initiator === undefined) throw new NonRetryableJobError("invalid_payload");
  return releaseSource(connectionWorkerStore(context), { ...input, connectedAccountId, destinationWorkspaceId, initiator });
}

/** connections.move.activate_destination (destination workspace): after a release, or a human retry. */
export async function runActivateDestination(context: TenantJobContext): Promise<ActivationResult> {
  return activateDestination(connectionWorkerStore(context), sagaInput(context));
}

/** connections.move.reject_destination (destination workspace): after the source refused. */
export async function runRejectDestination(context: TenantJobContext): Promise<RejectionResult> {
  return rejectDestination(connectionWorkerStore(context), sagaInput(context));
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
