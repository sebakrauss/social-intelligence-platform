/**
 * Step 5F commands: Connected Account linking, unlinking and the web side of the Move saga (TA §8; PD D-50; D4).
 * Configuration, not platform mutation: no command requires Standard mode (S7 restricts platform mutations), and no
 * provider is called here — capability evaluation and the cross-workspace saga steps run in the job runtime.
 *
 * M-01 presentation: when an asset is already active in another workspace of the organization, the caller learns
 * which one only if their OWN live membership there may read it (workspace.read_operational); otherwise only that it
 * is "active in another workspace in your organization". Nothing is ever said about other organizations: their
 * links are invisible to connections.locate_active_link and never conflict (M-01 is per organization).
 */
import { isUuid, type WorkspaceId } from "@/domain/ids";
import { object, parsed } from "@/domain/validation";
import {
  CAPABILITY_EVALUATION_TOPIC,
  linkAccount,
  listConnectedAccounts,
  requestMove,
  retryMove,
  unlinkAccount,
  type ConnectedAccountSummary,
  type LinkOutput,
  type MoveRequestOutput,
  type SingleWorkspaceRule,
  type UnlinkOutput,
  type WorkspaceScope,
} from "@/modules/connections";
import { loadWorkspaceAccess, type TenancyStore } from "@/modules/tenancy";
import { effectivePermissions } from "@/platform/permissions";
import type { WorkspaceCommand, WorkspaceContext } from "@/server/pipeline";

const uuid = parsed((value) => (isUuid(value) ? value : undefined));

const scopeOf = (context: WorkspaceContext): WorkspaceScope => ({
  workspaceId: context.workspaceId,
  organizationId: context.organizationId,
  userId: context.userId,
});

/** Where the asset is active, as this user may see it. */
export type ActiveLocation = { readonly kind: "identified"; readonly workspaceId: WorkspaceId; readonly workspaceName: string } | { readonly kind: "organization" };

export type LinkResult =
  | { readonly kind: "linked" | "already_linked"; readonly connectedAccountId: string }
  | { readonly kind: "active_elsewhere"; readonly rule: SingleWorkspaceRule; readonly location: ActiveLocation };

/** The user's OWN live access to another workspace of the same organization (memberships they can read about themselves). */
async function ownPermissions(tenancy: TenancyStore, workspaceId: WorkspaceId, context: WorkspaceContext) {
  const access = await loadWorkspaceAccess(tenancy, workspaceId, context.userId);
  if (access?.workspace.organizationId !== context.organizationId) return undefined;
  return { workspace: access.workspace, permissions: effectivePermissions(access.membership.role, access.membership.grants) };
}

async function present(tenancy: TenancyStore, context: WorkspaceContext, workspaceId: WorkspaceId | null): Promise<ActiveLocation> {
  if (workspaceId === null) return { kind: "organization" };
  const own = await ownPermissions(tenancy, workspaceId, context);
  return own?.permissions.has("workspace.read_operational") === true
    ? { kind: "identified", workspaceId: own.workspace.id, workspaceName: own.workspace.name }
    : { kind: "organization" };
}

export function createConnectedAccountCommands() {
  const link: WorkspaceCommand<{ readonly discoveredAssetId: string }, { readonly output: LinkOutput; readonly result: LinkResult }, LinkResult> = {
    scope: "workspace",
    name: "connections.account.link",
    permission: "connections.manage",
    requiresStandardMode: false,
    validate: object({ discoveredAssetId: uuid }),
    async execute(context, input, tx, env) {
      const output = await linkAccount(tx.connections, { scope: scopeOf(context), discoveredAssetId: input.discoveredAssetId, now: env.now, newId: env.newId });
      if (output.kind === "active_elsewhere") {
        return { output, result: { kind: "active_elsewhere", rule: output.rule, location: await present(tx.tenancy, context, output.workspaceId) } };
      }
      if (output.kind === "linked") {
        // Capability is evaluated after activation, in the job runtime (provider I/O never in this transaction).
        const outboxId = env.newId();
        await tx.outbox.append({
          id: outboxId,
          topic: CAPABILITY_EVALUATION_TOPIC,
          organizationId: context.organizationId,
          workspaceId: context.workspaceId,
          subjectIds: { connected_account_id: output.account.id },
          correlationId: env.correlationId,
          initiator: { type: "user", userId: context.userId },
          dispatchKey: `${CAPABILITY_EVALUATION_TOPIC}:${output.account.id}:${outboxId}`,
          createdAt: env.now,
        });
      }
      return { output, result: { kind: output.kind, connectedAccountId: output.account.id } };
    },
    audit: ({ output }) => (output.kind === "linked" ? { action: "connected_account.linked", targetType: "connected_account", targetId: output.account.id } : undefined),
    respond: ({ result }) => result,
  };

  const unlink: WorkspaceCommand<{ readonly connectedAccountId: string }, UnlinkOutput, { readonly changed: boolean }> = {
    scope: "workspace",
    name: "connections.account.unlink",
    permission: "connections.manage",
    requiresStandardMode: false,
    validate: object({ connectedAccountId: uuid }),
    execute: (context, input, tx, env) => unlinkAccount(tx.connections, { scope: scopeOf(context), connectedAccountId: input.connectedAccountId, now: env.now, newId: env.newId }),
    audit: (output) => (output.changed ? { action: "connected_account.unlinked", targetType: "connected_account", targetId: output.connectedAccountId } : undefined),
    respond: (output) => ({ changed: output.changed }),
  };

  const list: WorkspaceCommand<Record<string, never>, readonly ConnectedAccountSummary[], readonly ConnectedAccountSummary[]> = {
    scope: "workspace",
    name: "connections.account.list",
    permission: "workspace.read_operational",
    requiresStandardMode: false,
    validate: object({}),
    execute: (_context, _input, tx) => listConnectedAccounts(tx.connections),
    audit: () => undefined,
    respond: (accounts) => accounts,
  };

  /** What the caller learns about a move request: never the routed row's identifier. */
  type MoveRequestResult = Exclude<MoveRequestOutput, { readonly kind: "requested" }> | { readonly kind: "requested"; readonly moveId: string; readonly reused: boolean };

  const requestMoveCommand: WorkspaceCommand<{ readonly discoveredAssetId: string }, MoveRequestOutput, MoveRequestResult> = {
    scope: "workspace",
    name: "connections.move.request",
    permission: "connections.manage",
    requiresStandardMode: false,
    validate: object({ discoveredAssetId: uuid }),
    async execute(context, input, tx, env) {
      const output = await requestMove(tx.connections, {
        scope: scopeOf(context),
        discoveredAssetId: input.discoveredAssetId,
        // Owner/Admin of the SOURCE too: read from the user's own membership there, live.
        canManageSource: async (source) => (await ownPermissions(tx.tenancy, source, context))?.permissions.has("connections.manage") === true,
        correlationId: env.correlationId,
        now: env.now,
        newId: env.newId,
      });
      // The release row was inserted by the routing definer: wake the relay after commit like any appended row (G5).
      if (output.kind === "requested" && output.routedOutboxId !== null) tx.outbox.routed({ id: output.routedOutboxId, correlationId: env.correlationId });
      return output;
    },
    audit: (output) =>
      output.kind === "requested" && !output.reused ? { action: "connected_account.move_requested", targetType: "asset_move", targetId: output.moveId } : undefined,
    respond: (output) => (output.kind === "requested" ? { kind: "requested", moveId: output.moveId, reused: output.reused } : output),
  };

  const retry: WorkspaceCommand<{ readonly moveId: string }, { readonly moveId: string }, { readonly moveId: string }> = {
    scope: "workspace",
    name: "connections.move.retry",
    permission: "connections.manage",
    requiresStandardMode: false,
    validate: object({ moveId: uuid }),
    async execute(_context, input, tx, env) {
      // A NEW durable local activation attempt, routed by the definer (web can't append saga rows itself, G6).
      const retried = await retryMove(tx.connections, { moveId: input.moveId, correlationId: env.correlationId, now: env.now });
      tx.outbox.routed({ id: retried.routedOutboxId, correlationId: env.correlationId });
      return { moveId: retried.moveId };
    },
    audit: (output) => ({ action: "connected_account.move_requested", targetType: "asset_move", targetId: output.moveId }),
    respond: (output) => output,
  };

  return { link, unlink, list, requestMove: requestMoveCommand, retry };
}

export type ConnectedAccountCommands = ReturnType<typeof createConnectedAccountCommands>;
