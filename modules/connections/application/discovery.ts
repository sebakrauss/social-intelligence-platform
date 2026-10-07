/**
 * Asset discovery / validation of a connection, job side (Step 5D; TA §39; Model §53-D). One run handles exactly
 * one workspace and one connection, in three steps — the provider call is OUTSIDE any database transaction:
 *
 *   1 scoped tx    load the connection and its ACTIVE credential envelope (nothing to do if gone or credential-free)
 *   2 no tx        open the envelope through the single credential-access function → discoverAssets (Step 4 port)
 *   3 scoped tx    R6 claim per outbox row → refuse an obsolete result (active credential changed) → upsert the
 *                  normalized assets → CONNECTING/DEGRADED/FAILED → ACTIVE, or the narrow failure transition
 *
 * Failures (closed codes only, never provider text):
 *   credential_invalid (revoked/expired/other), permission_missing, rejected/not found → definite: the initial
 *     validation FAILS the connection, a working one DEGRADES. The credential is kept (definitive shredding on
 *     invalidation is Step 5H, D8).
 *   envelope unreadable → CREDENTIAL_UNREADABLE, same transition.
 *   transient / rate_limited / outcome_unknown / keyring outage → rethrown: the job's retry policy handles it and
 *     nothing is changed or destroyed.
 * No raw provider response is stored: only identifiers, platform, class and a sanitized display name.
 */
import type { ConnectionStatus } from "@/domain/connections";
import { AppError } from "@/domain/errors";
import type { CorrelationId } from "@/domain/correlation";
import type { WorkspaceId } from "@/domain/ids";
import { recordAuditEvent } from "@/modules/audit";
import { isProviderError, type SocialAssetDto } from "@/integrations/providers/contract";
import {
  statusAfterDiscoveryFailure,
  validationReason,
  type Connection,
  type ConnectionEventReason,
  type ConnectionProblemCode,
} from "../domain/model";
import { CredentialUnreadableError, type ConnectionWorkerStore, type DiscoveryProviders, type ProviderCredentialAccess } from "./ports";

export const DISCOVER_ASSETS_TASK = "connections.discover_assets";

export interface DiscoveryDependencies {
  /** Runs `work` in a fresh worker transaction bound to the job's single workspace. */
  readonly inScope: <T>(work: (store: ConnectionWorkerStore) => Promise<T>) => Promise<T>;
  readonly access: ProviderCredentialAccess;
  readonly providers: DiscoveryProviders;
  readonly clock: () => Date;
  readonly newId: () => string;
}

export interface DiscoveryInput {
  readonly workspaceId: WorkspaceId;
  readonly connectionId: string;
  readonly outboxId: string;
  readonly correlationId: CorrelationId;
}

export type DiscoveryOutcome =
  | { readonly kind: "skipped"; readonly reason: "not_found" | "no_credential" | "obsolete" | "already_applied" }
  | { readonly kind: "validated"; readonly status: ConnectionStatus; readonly assets: number }
  | { readonly kind: "failed"; readonly status: ConnectionStatus; readonly problem: DiscoveryProblem };

/** The definite discovery problems: each is both a connection problem code and a connection event reason. */
export type DiscoveryProblem = Extract<ConnectionProblemCode, ConnectionEventReason>;

const DISPLAY_NAME_MAX = 200;

/** Display names are untrusted provider text: control characters removed, bounded, never empty. */
export function sanitizeDisplayName(name: string, fallback: string): string {
  const cleaned = name.replace(/\p{Cc}/gu, " ").trim().slice(0, DISPLAY_NAME_MAX).trim();
  return cleaned === "" ? fallback.slice(0, DISPLAY_NAME_MAX) : cleaned;
}

/** Definite failures → closed problem code. Anything else (retryable or unknown) → undefined: rethrow. */
export function problemFor(error: unknown): DiscoveryProblem | undefined {
  if (error instanceof CredentialUnreadableError) return "CREDENTIAL_UNREADABLE";
  if (!isProviderError(error)) return undefined;
  switch (error.kind) {
    case "credential_invalid":
      return error.toJSON().details["reason"] === "revoked" ? "CREDENTIAL_REVOKED" : error.toJSON().details["reason"] === "expired" ? "CREDENTIAL_EXPIRED" : "CREDENTIAL_INVALID";
    case "permission_missing":
      return "PERMISSION_MISSING";
    case "permanent_rejected":
    case "target_not_found":
    case "target_not_eligible":
      return "DISCOVERY_FAILED";
    case "transient":
    case "rate_limited":
    case "outcome_unknown":
      return undefined;
  }
}

export async function discoverConnectionAssets(deps: DiscoveryDependencies, input: DiscoveryInput): Promise<DiscoveryOutcome> {
  // 1. Load (scoped transaction).
  const loaded = await deps.inScope(async (store) => {
    const connection = await store.connections.get(input.connectionId);
    if (connection === undefined || connection.status === "REMOVED" || connection.status === "DISCONNECTED") return "not_found" as const;
    if (connection.activeCredentialId === null) return "no_credential" as const;
    const credential = await store.credentials.load(connection.activeCredentialId);
    if (credential?.connectionId !== connection.id) return "no_credential" as const;
    return { connection, credentialId: connection.activeCredentialId, envelope: credential.envelope };
  });
  if (typeof loaded === "string") return { kind: "skipped", reason: loaded };

  // 2. Provider call, outside any transaction.
  const port = deps.providers.read(loaded.connection.provider);
  // A provider the job runtime doesn't compose is a configuration error, not a provider answer: never retried.
  if (port === undefined) throw new AppError("NOT_FOUND", {});
  let result: { readonly ok: true; readonly assets: readonly SocialAssetDto[] } | { readonly ok: false; readonly problem: DiscoveryProblem };
  try {
    const discovered = await deps.access.withCredential(
      { workspaceId: input.workspaceId, credentialId: loaded.credentialId, envelope: loaded.envelope },
      (credential) => port.discoverAssets(credential),
    );
    result = { ok: true, assets: discovered.data };
  } catch (error) {
    const problem = problemFor(error);
    if (problem === undefined) throw error;
    result = { ok: false, problem };
  }

  // 3. Persist (scoped transaction, once per outbox row).
  return deps.inScope(async (store) => {
    if ((await store.claimEffect(`${DISCOVER_ASSETS_TASK}:${input.outboxId}`)) === "already_applied") return { kind: "skipped", reason: "already_applied" } as const;
    const connection = await store.connections.get(input.connectionId);
    if (connection === undefined || connection.status === "REMOVED" || connection.activeCredentialId !== loaded.credentialId) {
      return { kind: "skipped", reason: "obsolete" } as const;
    }
    const now = deps.clock();
    const record = async (next: Connection, reason: ConnectionEventReason, actions: readonly ("connection.validated" | "connection.status_changed")[]): Promise<void> => {
      if (!(await store.connections.update(next, connection.version))) throw new Error("connections: concurrent update, retry");
      if (next.status !== connection.status) {
        await store.events.append({
          id: deps.newId(),
          organizationId: connection.organizationId,
          workspaceId: connection.workspaceId,
          connectionId: connection.id,
          previousStatus: connection.status,
          newStatus: next.status,
          reasonCode: reason,
          actor: { type: "system" },
          occurredAt: now,
        });
      }
      for (const action of actions) {
        await recordAuditEvent(store.audit, {
          id: deps.newId(),
          occurredAt: now,
          action,
          actorType: "system",
          organizationId: connection.organizationId,
          workspaceId: connection.workspaceId,
          targetType: "connection",
          targetId: connection.id,
          correlationId: input.correlationId,
          outcome: "succeeded",
          ...(action === "connection.status_changed" ? { change: { kind: "connection_status", previous: connection.status, current: next.status } } : {}),
        });
      }
    };

    if (!result.ok) {
      const status = statusAfterDiscoveryFailure(connection.status);
      await record(
        { ...connection, status, lastProblemCode: result.problem, lastProblemAt: now, version: connection.version + 1, updatedAt: now },
        result.problem,
        status === connection.status ? [] : ["connection.status_changed"],
      );
      return { kind: "failed", status, problem: result.problem };
    }

    for (const asset of result.assets) {
      await store.discoveredAssets.upsert({
        id: deps.newId(),
        organizationId: connection.organizationId,
        workspaceId: connection.workspaceId,
        connectionId: connection.id,
        platform: asset.ref.platform,
        providerAssetId: asset.ref.id,
        assetClass: asset.assetClass,
        displayName: sanitizeDisplayName(asset.displayName, asset.ref.id),
        lastSeenAt: now,
      });
    }
    const changed = connection.status !== "ACTIVE";
    await record(
      { ...connection, status: "ACTIVE", lastSuccessAt: now, lastProblemCode: null, lastProblemAt: null, version: connection.version + 1, updatedAt: now },
      validationReason(connection.status),
      changed ? ["connection.validated", "connection.status_changed"] : ["connection.validated"],
    );
    return { kind: "validated", status: "ACTIVE", assets: result.assets.length };
  });
}
