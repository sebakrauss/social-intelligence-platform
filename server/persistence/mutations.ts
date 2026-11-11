/**
 * The REQUEST side of the Platform Mutation Executor over ONE scoped transaction (Step 7B-1; TA §26.3 left column):
 * the web's user scope (authenticated, sealed workspace). It composes the intent and reply stores (RLS: the member
 * inserts PENDING only), the reply target issued by the interactions persistence layer, and the request-time guards
 * read from the owner modules (connections, capability, switches). No execution path, no transition, no provider port.
 *
 * The helpers are shared with the job composition (jobs/mutations.ts), which adds the worker's transition stores,
 * the live initiator and mode re-checks and the audit record — this file never imports the executor.
 *
 * Capability is the real resolver over the stored profile (never inferred); the `mutation.provider_action` switch is
 * read per `<platform>:public_reply` and fails safe (disabled).
 *
 * Step 7B-14G1: the validation reads of 0028 (read-only, RLS-scoped: a member sees ONLY the authorization naming them as
 * initiator in the bound workspace) and the capability module's narrow "catalog not validated" answer. Nothing here
 * issues, revokes, binds or consumes an authorization.
 */
import { capabilityAvailability, catalogValidationPending, type CapabilityReadStore } from "@/modules/capability";
import { createPostgresCapabilityStore } from "@/modules/capability/persistence";
import type { ConnectedAccount, Connection } from "@/modules/connections";
import { createPostgresConnectionStore } from "@/modules/connections/persistence";
import { createPostgresContentItemReadStore } from "@/modules/content/persistence";
import { CAPABILITY_CONTENT_KINDS, CAPABILITY_SOURCES, type CapabilityContentKind, type CapabilitySource } from "@/modules/capability";
import { loadInteractionReplyTarget, type InteractionReplyTargetRow } from "@/modules/interactions/persistence";
import { createPostgresIntentStore, createPostgresOutboundReplyStore, currentWorkspace, readValidationAuthorizationForAdmission } from "@/mutations/persistence";
import type { MutationRequestSources, ReplyTarget, ReplyTargets, RequestGuards, ValidationAuthorityReads } from "@/mutations/request";
import { readSwitchRows, type DatabaseTransaction } from "@/platform/db";
import { resolveSwitch } from "@/platform/flags";

const WORKSPACE_UNBOUND = "mutation_workspace_unbound";

/** The bound workspace's id, from the transaction's sealed context (never from a caller). */
export async function boundWorkspace(tx: DatabaseTransaction): Promise<string> {
  const workspace = await currentWorkspace(tx);
  if (workspace === undefined) throw new Error(WORKSPACE_UNBOUND);
  return workspace;
}

/** The canonical row's last observed state as the executor's closed presence (anything not clearly present refuses). */
export function toReplyTarget(row: InteractionReplyTargetRow, content: { readonly contentKind: string; readonly reportedSource: string }): ReplyTarget {
  return {
    interactionId: row.id,
    workspaceId: row.workspaceId,
    connectedAccountId: row.connectedAccountId,
    platform: row.platform,
    providerInteractionId: row.providerInteractionId,
    providerAssetId: row.providerAssetId,
    providerContentId: row.providerContentId,
    contentItemId: row.contentItemId,
    contentKind: content.contentKind,
    reportedSource: content.reportedSource,
    parentProviderInteractionId: row.parentProviderInteractionId,
    kind: row.kind,
    observed: row.observed,
    presence: !row.observed ? "unknown" : row.availability === "removed_at_source" ? "removed_at_source" : row.visibility === "visible" ? "present" : row.visibility === "hidden" ? "hidden" : "unknown",
    ownAccount: row.authorRole === "account_identity",
  };
}

export function replyTargets(tx: DatabaseTransaction): ReplyTargets {
  const content = createPostgresContentItemReadStore(tx);
  return {
    async load(interactionId) {
      const row = await loadInteractionReplyTarget(tx, await boundWorkspace(tx), interactionId);
      if (row === undefined) return undefined;
      // The content's kind and reported source come from the content module's own read port (never inferred).
      const item = (await content.findManyById([row.contentItemId])).find((candidate) => candidate.id === row.contentItemId);
      if (item === undefined || item.connectedAccountId !== row.connectedAccountId) return undefined;
      return toReplyTarget(row, { contentKind: item.contentKind, reportedSource: item.reportedSource });
    },
  };
}

/** The target's scope as the capability resolver names it; an unknown kind is "other", an unknown source "unknown". */
export function capabilityScopeOf(scope: { readonly contentKind: string; readonly reportedSource: string }): { readonly contentKind: CapabilityContentKind; readonly source: CapabilitySource } {
  const contentKind = (CAPABILITY_CONTENT_KINDS as readonly string[]).includes(scope.contentKind) ? (scope.contentKind as CapabilityContentKind) : "other";
  const source = (CAPABILITY_SOURCES as readonly string[]).includes(scope.reportedSource) ? (scope.reportedSource as CapabilitySource) : "unknown";
  return { contentKind, source };
}

export interface AuthorityReads {
  readonly account: (id: string) => Promise<ConnectedAccount | undefined>;
  readonly connection: (id: string) => Promise<Connection | undefined>;
  readonly capability: CapabilityReadStore;
}

/** The guards both sides share, over the owner modules' reads of this transaction. */
export function sharedGuards(tx: DatabaseTransaction, reads: AuthorityReads): RequestGuards {
  return {
    async providerActionAllowed(platform, action) {
      // Read in THIS transaction, never cached: a revocation is seen by the next request or execution (Step 7B-12A).
      const resolved = resolveSwitch(await readSwitchRows(tx), "mutation.provider_action", { qualifier: `${platform}:${action}` });
      if (resolved.value.enabled && !resolved.failSafe) return "allowed";
      return resolved.source === "default" ? "not_enabled" : "paused";
    },
    async account(connectedAccountId) {
      const account = await reads.account(connectedAccountId);
      if (account === undefined) return undefined;
      const connection = await reads.connection(account.connectionId);
      return {
        status: account.status,
        platform: account.platform,
        provider: connection?.provider ?? "unknown",
        providerAssetId: account.providerAssetId,
        connectionStatus: connection?.status ?? "UNKNOWN",
        credentialId: connection?.activeCredentialId ?? null,
      };
    },
    async replyCapability(connectedAccountId, scope) {
      const account = await reads.account(connectedAccountId);
      const connection = account === undefined ? undefined : await reads.connection(account.connectionId);
      const unavailable = { state: "UNAVAILABLE" as const, catalogId: "none", catalogRevision: 1 };
      if (account === undefined || connection === undefined) return unavailable;
      const { contentKind, source } = capabilityScopeOf(scope);
      const availability = await capabilityAvailability(reads.capability, {
        connectedAccountId,
        accountStatus: account.status,
        provider: connection.provider,
        capability: "reply_public",
        contentKind,
        source,
        connection: connection.status,
      });
      const header = await reads.capability.header(connectedAccountId);
      return { state: availability.state, catalogId: header?.catalogId ?? "none", catalogRevision: header?.catalogRevision ?? 1 };
    },
  };
}

/**
 * Step 7B-14G1 — the validation reads both sides share, over this transaction: the authorization of the BOUND workspace
 * only (another workspace's id answers undefined without a query), with the database's expiry verdict; and whether
 * reply_public is unusable ONLY because the catalog has not validated it (the capability module decides; false on any
 * missing account, connection or profile).
 */
export function validationReads(tx: DatabaseTransaction, reads: AuthorityReads): ValidationAuthorityReads {
  return {
    async authorization(workspaceId, authorizationId) {
      if (workspaceId !== (await currentWorkspace(tx))) return undefined;
      return readValidationAuthorizationForAdmission(tx, workspaceId, authorizationId);
    },
    async catalogValidationPending(connectedAccountId, scope) {
      const account = await reads.account(connectedAccountId);
      const connection = account === undefined ? undefined : await reads.connection(account.connectionId);
      if (account === undefined || connection === undefined) return false;
      const { contentKind, source } = capabilityScopeOf(scope);
      return catalogValidationPending(reads.capability, {
        connectedAccountId,
        accountStatus: account.status,
        provider: connection.provider,
        capability: "reply_public",
        contentKind,
        source,
        connection: connection.status,
      });
    },
  };
}

/** The web's request side (user scope). */
export function mutationRequestSources(tx: DatabaseTransaction): MutationRequestSources {
  const connections = createPostgresConnectionStore(tx);
  const capability = createPostgresCapabilityStore(tx);
  const reads: AuthorityReads = { account: (id) => connections.connectedAccounts.get(id), connection: (id) => connections.connections.get(id), capability: { header: capability.header, entries: capability.entries } };
  return {
    intents: createPostgresIntentStore(tx),
    replies: createPostgresOutboundReplyStore(tx),
    targets: replyTargets(tx),
    guards: sharedGuards(tx, reads),
    validation: validationReads(tx, reads),
  };
}
