/**
 * Step 5D connection commands and queries (TA §8, §10.6, §39). Connection management is configuration, not a
 * platform mutation: no command here requires Standard mode, so a Monitor-only workspace can still connect,
 * re-authorize and remove (S7 restricts platform mutations, not configuration).
 *
 * The four authorization commands are SERVER-INTERNAL steps of the callback orchestration
 * (server/connections/authorization.ts), never exposed to clients: their inputs carry a state digest, an attempt
 * id or a sealed envelope, never a raw state, code, verifier or credential. Audit drafts carry IDs and closed
 * codes only; the attempt itself is not an audit target.
 */
import { isUuid } from "@/domain/ids";
import { object, oneOf, optional, parsed } from "@/domain/validation";
import {
  AUTHORIZABLE_PROVIDERS,
  EXCHANGE_FAILURE_CODES,
  completeExchange,
  failExchange,
  getConnection,
  listConnections,
  removeConnection,
  startAuthorization,
  verifyCallback,
  type AuthorizationProviders,
  type ClaimedExchange,
  type CompletionOutput,
  type ConnectionDetail,
  type ConnectionSummary,
  type ExchangeFailureCode,
  type OAuthSecrets,
  type RemovalOutput,
  type StartedAuthorization,
  type WorkspaceScope,
} from "@/modules/connections";
import type { AuditDraft, WorkspaceCommand, WorkspaceContext } from "@/server/pipeline";

export const DISCOVER_ASSETS_TOPIC = "connections.discover_assets";

const uuid = parsed((value) => (isUuid(value) ? value : undefined));
const digest = parsed((value) => (typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : undefined));
const envelope = parsed((value) => (value instanceof Uint8Array && value.byteLength >= 46 && value.byteLength <= 70_000 ? value : undefined));
const instantOrNull = parsed((value) => (value === null || (value instanceof Date && !Number.isNaN(value.getTime())) ? { value } : undefined));

const scopeOf = (context: WorkspaceContext): WorkspaceScope => ({
  workspaceId: context.workspaceId,
  organizationId: context.organizationId,
  userId: context.userId,
});

export interface ConnectionCommandDependencies {
  readonly secrets: OAuthSecrets;
  readonly providers: AuthorizationProviders;
}

export function createConnectionCommands(deps: ConnectionCommandDependencies) {
  const start: WorkspaceCommand<
    { readonly provider: (typeof AUTHORIZABLE_PROVIDERS)[number]; readonly reconnectConnectionId: string | undefined },
    StartedAuthorization,
    StartedAuthorization
  > = {
    scope: "workspace",
    name: "connections.authorization.start",
    permission: "connections.manage",
    requiresStandardMode: false,
    validate: object({ provider: oneOf(AUTHORIZABLE_PROVIDERS), reconnectConnectionId: optional(uuid) }),
    execute: (context, input, tx, env) =>
      startAuthorization(tx.connections, deps, {
        scope: scopeOf(context),
        provider: input.provider,
        reconnectConnectionId: input.reconnectConnectionId ?? null,
        now: env.now,
        newId: env.newId,
      }),
    audit: () => undefined,
    respond: (started) => started,
  };

  const verify: WorkspaceCommand<
    { readonly provider: (typeof AUTHORIZABLE_PROVIDERS)[number]; readonly stateDigest: string; readonly kind: "code" | "denied" },
    ClaimedExchange | "denied",
    ClaimedExchange | "denied"
  > = {
    scope: "workspace",
    name: "connections.authorization.verify_callback",
    permission: "connections.manage",
    requiresStandardMode: false,
    validate: object({ provider: oneOf(AUTHORIZABLE_PROVIDERS), stateDigest: digest, kind: oneOf(["code", "denied"] as const) }),
    execute: (context, input, tx, env) => verifyCallback(tx.connections, { scope: scopeOf(context), ...input, now: env.now }),
    audit: () => undefined,
    respond: (output) => output,
  };

  const complete: WorkspaceCommand<
    { readonly attemptId: string; readonly credentialId: string; readonly envelope: Uint8Array; readonly expiresAt: { readonly value: Date | null } },
    { readonly output: CompletionOutput; readonly scope: WorkspaceScope },
    CompletionOutput
  > = {
    scope: "workspace",
    name: "connections.authorization.complete",
    permission: "connections.manage",
    requiresStandardMode: false,
    validate: object({ attemptId: uuid, credentialId: uuid, envelope, expiresAt: instantOrNull }),
    async execute(context, input, tx, env) {
      const scope = scopeOf(context);
      const output = await completeExchange(tx.connections, {
        scope,
        attemptId: input.attemptId,
        credentialId: input.credentialId,
        envelope: input.envelope,
        expiresAt: input.expiresAt.value,
        now: env.now,
        newId: env.newId,
      });
      if (output.kind !== "connection_unavailable") {
        // Validation/discovery runs in the job runtime (D5): IDs only, keyed by the credential it validates.
        await tx.outbox.append({
          id: env.newId(),
          topic: DISCOVER_ASSETS_TOPIC,
          organizationId: context.organizationId,
          workspaceId: context.workspaceId,
          subjectIds: { connection_id: output.connection.id },
          correlationId: env.correlationId,
          initiator: { type: "user", userId: context.userId },
          dispatchKey: `${DISCOVER_ASSETS_TOPIC}:${output.connection.id}:${output.credentialId}`,
          createdAt: env.now,
        });
      }
      return { output, scope };
    },
    audit: ({ output }): readonly AuditDraft[] | undefined => {
      if (output.kind === "connection_unavailable") return undefined;
      const target = { targetType: "connection" as const, targetId: output.connection.id };
      if (output.kind === "created") return [{ action: "connection.created", ...target }];
      const drafts: AuditDraft[] = [{ action: "connection.credential_replaced", ...target }];
      if (output.previousStatus !== output.connection.status) {
        drafts.push({ action: "connection.status_changed", ...target, change: { kind: "connection_status", previous: output.previousStatus, current: output.connection.status } });
      }
      return drafts;
    },
    respond: ({ output }) => output,
  };

  const fail: WorkspaceCommand<
    { readonly attemptId: string; readonly outcome: "OUTCOME_UNKNOWN" | ExchangeFailureCode },
    boolean,
    boolean
  > = {
    scope: "workspace",
    name: "connections.authorization.fail",
    permission: "connections.manage",
    requiresStandardMode: false,
    validate: object({ attemptId: uuid, outcome: oneOf(["OUTCOME_UNKNOWN", ...EXCHANGE_FAILURE_CODES] as const) }),
    execute: (_context, input, tx, env) =>
      failExchange(tx.connections, {
        attemptId: input.attemptId,
        outcome: input.outcome === "OUTCOME_UNKNOWN" ? { kind: "outcome_unknown" } : { kind: "failed", code: input.outcome },
        now: env.now,
      }),
    audit: () => undefined,
    respond: (closed) => closed,
  };

  const remove: WorkspaceCommand<{ readonly connectionId: string }, RemovalOutput, { readonly changed: boolean }> = {
    scope: "workspace",
    name: "connections.connection.remove",
    permission: "connections.manage",
    requiresStandardMode: false,
    validate: object({ connectionId: uuid }),
    execute: (context, input, tx, env) => removeConnection(tx.connections, { scope: scopeOf(context), connectionId: input.connectionId, now: env.now, newId: env.newId }),
    audit: (output) => (output.changed ? { action: "connection.removed", targetType: "connection", targetId: output.connectionId } : undefined),
    respond: (output) => ({ changed: output.changed }),
  };

  const list: WorkspaceCommand<Record<string, never>, readonly ConnectionSummary[], readonly ConnectionSummary[]> = {
    scope: "workspace",
    name: "connections.connection.list",
    permission: "workspace.read_operational",
    requiresStandardMode: false,
    validate: object({}),
    execute: (_context, _input, tx) => listConnections(tx.connections),
    audit: () => undefined,
    respond: (summaries) => summaries,
  };

  const get: WorkspaceCommand<{ readonly connectionId: string }, ConnectionDetail, ConnectionDetail> = {
    scope: "workspace",
    name: "connections.connection.get",
    permission: "workspace.read_operational",
    requiresStandardMode: false,
    validate: object({ connectionId: uuid }),
    execute: (_context, input, tx) => getConnection(tx.connections, input.connectionId),
    audit: () => undefined,
    respond: (detail) => detail,
  };

  return { start, verify, complete, fail, remove, list, get };
}

export type ConnectionCommands = ReturnType<typeof createConnectionCommands>;
