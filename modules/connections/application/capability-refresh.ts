/**
 * Capability refresh for one Connected Account, job side (Step 5E; TA §16.1 "evaluated on connect, on permission
 * change, on observed errors, and periodically"). The connections module owns accounts and credentials; it asks the
 * provider for normalized account FACTS and hands them to the capability module, which alone evaluates (connections
 * depends on capability, never the reverse). Three steps — the provider call is outside any transaction:
 *
 *   1 scoped tx   the Connected Account, its Connection and the active credential envelope
 *   2 no tx       open the credential (single credential-access function) → describeAccount (Step 4 read port)
 *   3 scoped tx   capability.evaluateAndStore (pure evaluation, stale-safe current-state write)
 *
 * Fail closed, never optimistic: a definite provider answer that facts can't be read (permission missing, invalid
 * credential, unreadable envelope…) is a DATED input ("facts unavailable" observed now) → nothing can be SUPPORTED. Transient, rate-limited and
 * ambiguous outcomes are rethrown for the job's retry policy and never rewrite the profile. No data volume is read.
 * Linking an account (Step 5F) will call this after activation; Step 5E exposes it without a scheduler or task.
 */
import type { WorkspaceId } from "@/domain/ids";
import { AppError } from "@/domain/errors";
import { isProviderError, providerObjectRef, type AccountDescriptionDto } from "@/integrations/providers/contract";
import {
  evaluateAndStore,
  factsFromDescription,
  selectCatalog,
  type CapabilityObservation,
  type FactsInput,
  type CapabilityProfile,
  type CapabilityProfileStore,
  type ProfileWriteOutcome,
} from "@/modules/capability";
import { CredentialUnreadableError, type ConnectionWorkerStore, type DiscoveryProviders, type ProviderCredentialAccess } from "./ports";

export interface CapabilityRefreshDependencies {
  readonly inScope: <T>(work: (stores: { readonly connections: ConnectionWorkerStore; readonly capability: CapabilityProfileStore }) => Promise<T>) => Promise<T>;
  readonly access: ProviderCredentialAccess;
  readonly providers: DiscoveryProviders;
  readonly clock: () => Date;
  /** Selects the catalog: the simulator catalog only in development/test. */
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export type CapabilityRefreshOutcome =
  | { readonly kind: "skipped"; readonly reason: "not_found" | "inactive" | "no_credential" }
  | { readonly kind: "evaluated"; readonly factsAvailable: boolean; readonly profile: CapabilityProfile; readonly write: ProfileWriteOutcome };

/** Definite "facts can't be obtained" answers (→ evaluate without facts); anything else is rethrown. */
function definiteFactsFailure(error: unknown): boolean {
  if (error instanceof CredentialUnreadableError) return true;
  if (!isProviderError(error)) return false;
  return !["transient", "rate_limited", "outcome_unknown"].includes(error.kind);
}

export async function refreshAccountCapabilities(
  deps: CapabilityRefreshDependencies,
  input: { readonly workspaceId: WorkspaceId; readonly connectedAccountId: string; readonly observations?: readonly CapabilityObservation[] },
): Promise<CapabilityRefreshOutcome> {
  const loaded = await deps.inScope(async ({ connections }) => {
    const account = await connections.connectedAccounts.get(input.connectedAccountId);
    if (account === undefined) return "not_found" as const;
    if (account.status !== "ACTIVE") return "inactive" as const;
    const connection = await connections.connections.get(account.connectionId);
    if (connection === undefined || connection.status === "REMOVED") return "not_found" as const;
    if (connection.activeCredentialId === null) return "no_credential" as const;
    const credential = await connections.credentials.load(connection.activeCredentialId);
    if (credential?.connectionId !== connection.id) return "no_credential" as const;
    return { account, connection, credentialId: connection.activeCredentialId, envelope: credential.envelope };
  });
  if (typeof loaded === "string") return { kind: "skipped", reason: loaded };

  const catalog = selectCatalog(loaded.connection.provider, deps.environment);
  const port = deps.providers.read(loaded.connection.provider);
  if (port === undefined) throw new AppError("NOT_FOUND", {});

  let facts: FactsInput;
  try {
    const description: AccountDescriptionDto = await deps.access.withCredential(
      { workspaceId: input.workspaceId, credentialId: loaded.credentialId, envelope: loaded.envelope },
      async (credential) =>
        (await port.describeAccount({ credential, account: providerObjectRef(loaded.account.platform, "asset", loaded.account.providerAssetId) })).data,
    );
    facts = factsFromDescription(description, deps.clock());
  } catch (error) {
    if (!definiteFactsFailure(error)) throw error;
    facts = { kind: "unavailable", observedAt: deps.clock() };
  }

  return deps.inScope(async ({ capability }) => {
    const { profile, outcome } = await evaluateAndStore(capability, {
      organizationId: loaded.account.organizationId,
      workspaceId: input.workspaceId,
      connectedAccountId: loaded.account.id,
      catalog,
      platform: loaded.account.platform,
      assetClass: loaded.account.assetClass,
      facts,
      observations: input.observations ?? [],
      evaluatedAt: deps.clock(),
    });
    return { kind: "evaluated", factsAvailable: facts.kind === "available", profile, write: outcome } as const;
  });
}
