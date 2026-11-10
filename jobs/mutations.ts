/**
 * Job-runtime composition of the INTEGRATION-plane task `mutations.execute_intent` (Step 7B-1): the Platform Mutation
 * Executor (TA §26) for ONE persisted intent. This is the ONLY place a provider MUTATION port is obtained (TA §6.3
 * rule 3; §26.1–§26.2): the local simulator's, in development/test, built from the simulator world the read side
 * already uses; and (Step 7B-13A) Meta's, for INSTAGRAM accounts only — the Instagram public-reply port of 7B-11.
 * Facebook, TikTok and every other provider/platform have no mutation port: the executor records BLOCKED
 * (PROVIDER_MUTATION_UNSUPPORTED) before any credential is opened. Having a port decides nothing: the executor's guard
 * chain (role, mode, account, the exact mutation.provider_action grant, connection, target authority, capability) runs
 * first, and today the Meta catalog publishes no reply_public and no grant exists. The credential is opened only
 * through this plane's credential access (jobs/connections.ts), once, between transactions, for one call.
 *
 * Thin handler: resolve the two identifiers, run the executor; every outcome is recorded by the executor itself and
 * the run completes (single attempt by registry: a lost run is reconciled, never re-sent).
 */
import { randomUUID } from "node:crypto";
import type { DiscoveryProviders, ProviderCredentialAccess } from "@/modules/connections";
import { createMetaMutationPort } from "@/integrations/providers/meta/mutation-port";
import { createSimulatorMutationPort } from "@/integrations/providers/simulator/mutation-port";
import type { ProviderMutationPort } from "@/integrations/providers/contract/mutation-port";
import { providerObjectRef, type ProviderAccess } from "@/integrations/providers/contract";
import { isPlatformKey } from "@/domain/platforms";
import { CredentialUnreadable, executeIntent, type ExecutionResult } from "@/mutations/executor/execute";
import { reconcileIntent, type ReconcileResult } from "@/mutations/executor/reconcile";
import { createReadPortReplyLookup } from "@/mutations/executor/reply-lookup";
import type { CredentialUse, MutationClock, MutationProviders } from "@/mutations/ports";
import { NonRetryableJobError, type TenantStepJobContext } from "@/platform/jobs";
import { providerComposition } from "@/server/connections/provider-mode";
import { isLocalSimulatorRuntime, localSimulator } from "@/server/connections/simulator";
import { credentialAuthority, executorStores } from "@/server/persistence/mutation-execution";
import { composeJobProviders } from "./connections";

export const EXECUTE_INTENT_TASK = "mutations.execute_intent";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Opens the account's active credential for ONE provider call (TA §39): the connection, the account and the stored
 * envelope are re-read in a worker transaction; the opener runs OUTSIDE it. An unreadable credential becomes the
 * executor's CredentialUnreadable (recorded as BLOCKED); a provider error passes through untouched.
 */
export function credentialUse(context: Pick<TenantStepJobContext, "inScope">, access: ProviderCredentialAccess): CredentialUse {
  return {
    async withAccess(input, use) {
      const authority = await context.inScope((scope) => credentialAuthority(scope.tx, input));
      if (authority === undefined || !isPlatformKey(authority.platform)) throw new CredentialUnreadable();
      const account = providerObjectRef(authority.platform, "asset", authority.providerAssetId);
      const progress = { opened: false };
      try {
        return await access.withCredential({ workspaceId: authority.workspaceId, credentialId: authority.credentialId, envelope: authority.envelope }, (credential) => {
          progress.opened = true;
          const providerAccess: ProviderAccess = { credential, account };
          return use(providerAccess);
        });
      } catch (error) {
        // Only a failure BEFORE the provider call is about the credential; a provider error passes through untouched.
        if (progress.opened) throw error;
        throw new CredentialUnreadable();
      }
    },
  };
}

export interface MutationComposition {
  readonly access: ProviderCredentialAccess;
  readonly providers: MutationProviders;
  readonly reads: DiscoveryProviders;
}

let composition: MutationComposition | undefined;

/** The composed mutation ports; undefined where none may exist. */
export interface MutationPorts {
  readonly simulator: ProviderMutationPort | undefined;
  /** Meta's Instagram public-reply port (Step 7B-13A); never served for any other platform. */
  readonly instagram: ProviderMutationPort | undefined;
}

/**
 * Which port serves an account (Step 7B-13A): the simulator's for simulator accounts; Meta's for an account whose
 * provider is "meta" AND whose platform is "instagram" — exactly that pair; nothing else (Meta/Facebook, TikTok,
 * unknown) gets a port, so the executor blocks before any credential is opened.
 */
export function selectMutationPorts(ports: MutationPorts): MutationProviders {
  return {
    mutation: (provider, platform) => {
      if (provider === "simulator") return ports.simulator;
      if (provider === "meta" && platform === "instagram") return ports.instagram;
      return undefined;
    },
  };
}

/**
 * The ONLY provider mutation composition: the local simulator's port where its own rule allows it (development/test),
 * and Meta's Instagram public-reply port (with its own Graph write transport) wherever the Meta read port is composed —
 * never under the synthetic staging stub. Credential access and read ports are the integration plane's
 * (composeJobProviders), so reconciliation reads through exactly the opener the reads use.
 */
export function composeMutationProviders(environment: Environment): MutationComposition {
  const base = composeJobProviders(environment);
  const simulator: ProviderMutationPort | undefined = isLocalSimulatorRuntime(environment) ? createSimulatorMutationPort(localSimulator(environment).world) : undefined;
  const instagram: ProviderMutationPort | undefined = providerComposition(environment).kind === "staging_stub" ? undefined : createMetaMutationPort();
  return { access: base.access, reads: base.providers, providers: selectMutationPorts({ simulator, instagram }) };
}

function clockOf(options: { readonly clock?: MutationClock }): MutationClock {
  return options.clock ?? { newId: randomUUID, now: () => new Date() };
}

/** The mutations.execute_intent handler: thin — resolve the run's identifiers, run the executor. */
export async function runExecuteIntent(context: TenantStepJobContext, base?: MutationComposition, options: { readonly clock?: MutationClock } = {}): Promise<ExecutionResult> {
  const intentId = context.payload.subjectIds["mutation_intent_id"];
  const connectedAccountId = context.payload.subjectIds["connected_account_id"];
  if (intentId === undefined || connectedAccountId === undefined) throw new NonRetryableJobError("invalid_payload");
  const resolved = base ?? (composition ??= composeMutationProviders(process.env));
  const clock = clockOf(options);
  return executeIntent(
    {
      inScope: (work) => context.inScope((scope) => work(executorStores(scope, clock.newId))),
      credentials: credentialUse(context, resolved.access),
      providers: resolved.providers,
      clock,
    },
    { workspaceId: context.payload.workspaceId, intentId, runReference: context.run.runId },
  );
}

/**
 * Reconciliation of one intent left OUTCOME_UNKNOWN (or EXECUTING without an outcome): LOOK through the provider READ
 * port, never resend. Not a registered task yet (no schedule exists in 7B-1): the entry point operator tooling and a
 * later sweeper call.
 */
export async function runReconcileIntent(context: TenantStepJobContext, base: MutationComposition, input: { readonly intentId: string; readonly provider: string }, options: { readonly clock?: MutationClock } = {}): Promise<ReconcileResult> {
  const clock = clockOf(options);
  const provider = input.provider;
  return reconcileIntent(
    {
      inScope: (work) => context.inScope((scope) => work(executorStores(scope, clock.newId))),
      credentials: credentialUse(context, base.access),
      lookup: createReadPortReplyLookup({ read: (name) => (name === provider ? base.reads.read(provider as never) : undefined) }, provider, clock.now),
      clock,
    },
    { workspaceId: context.payload.workspaceId, intentId: input.intentId, runReference: context.run.runId },
  );
}
