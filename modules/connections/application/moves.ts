/**
 * The Move saga (Step 5F; decision D4; PD D-50). Moving an asset that is ACTIVE in a source workspace S to a
 * destination workspace D of the SAME organization. There is no cross-workspace transaction: every step below runs
 * in ONE transaction bound to ONE workspace, and each workspace keeps its own asset_moves row (one per side).
 *
 *   D  web     requestMove        INCOMING REQUESTED + audit move_requested (user)  ──route release_source──▶ S
 *   S  worker  releaseSource      authority re-check (live Owner/Admin of the stored initiator in S)
 *                                   ACTIVE + authorized → account INACTIVE (MOVED) + OUTGOING RELEASED + MOVED_OUT
 *                                                         + audit moved_out          ──route activate_destination──▶ D
 *                                   otherwise          → OUTGOING REJECTED (closed reason) + audit move_rejected
 *                                                                                    ──route reject_destination──▶ D
 *   D  worker  activateDestination  re-checks (REQUESTED, authority, Connection ACTIVE, asset discovered, nothing
 *                                   active elsewhere) → insert/reactivate (the unique indexes are the final arbiter)
 *                                   → MOVED_IN + COMPLETED + audit moved_in + capability evaluation enqueued here;
 *                                   a definite failure → ACTIVATION_FAILED (closed reason) + audit move_failed.
 *                                   The source is NEVER reactivated.
 *   D  worker  rejectDestination  INCOMING REJECTED with the generic SOURCE_RELEASE_REJECTED (G4): the source's precise
 *                                 reason stays on the source side; the destination's accounts are untouched
 *   D  web     retryMove          a NEW durable local activation attempt (routed by the definer) + ACTIVATION_FAILED →
 *                                 REQUESTED (same move); the source is never restored
 *
 * Every saga outbox row is created ONLY by connections.route_move_step (closed transitions, counterpart derived from
 * the local row, identifier-only payload, deterministic dispatch key, same transaction as the state change); web and
 * worker can't append saga topics themselves (G6). A newly routed row is reported for the post-commit relay wake-up;
 * the dispatch sweeper only recovers lost wake-ups (G5). Saga
 * audit is attributed to the human initiator through connections.record_move_audit (TA §41.1); the job runtime
 * never writes a `user` audit row directly. Every worker step claims an R6 effect key in its own transaction and is
 * also guarded by its state transition under a row lock, so redelivery and crash recovery apply it exactly once.
 */
import { AppError } from "@/domain/errors";
import type { CorrelationId } from "@/domain/correlation";
import type { UserId, WorkspaceId } from "@/domain/ids";
import {
  CAPABILITY_EVALUATION_TOPIC,
  activeElsewhereReason,
  isRetryable,
  singleWorkspaceRule,
  type MoveReasonCode,
} from "../domain/model";
import type { WorkspaceScope } from "./authorization";
import { loadLinkableAsset } from "./linking";
import type { ConnectionStore, ConnectionWorkerStore } from "./ports";

// ── Destination, web ──────────────────────────────────────────────────────────────────────────────────────────

export type MoveRequestOutput =
  /** routedOutboxId: the release row inserted by this call (null for a reused request), for the post-commit wake-up. */
  | { readonly kind: "requested"; readonly moveId: string; readonly reused: boolean; readonly routedOutboxId: string | null }
  /** Nothing to move: the asset isn't active in another workspace of this organization (link it instead). */
  | { readonly kind: "not_active_elsewhere" }
  | { readonly kind: "already_here"; readonly connectedAccountId: string };

export async function requestMove(
  store: ConnectionStore,
  input: {
    readonly scope: WorkspaceScope;
    readonly discoveredAssetId: string;
    /** Whether the requesting user is Owner/Admin of the source workspace (their own membership, read live). */
    readonly canManageSource: (sourceWorkspaceId: WorkspaceId) => Promise<boolean>;
    readonly correlationId: CorrelationId;
    readonly now: Date;
    readonly newId: () => string;
  },
): Promise<MoveRequestOutput> {
  const asset = await loadLinkableAsset(store, input.discoveredAssetId);
  const located = await store.links.locateActive(asset.id);
  if (located === undefined) return { kind: "not_active_elsewhere" };
  if (located.workspaceId === input.scope.workspaceId) return { kind: "already_here", connectedAccountId: located.connectedAccountId };
  if (!(await input.canManageSource(located.workspaceId))) throw new AppError("PERMISSION_DENIED", {});

  const pending = await store.moves.findRequested(asset.platform, asset.providerAssetId);
  if (pending !== undefined) {
    // A duplicate request reuses the move; routing is idempotent (same dispatch key).
    const routed = await store.moves.routeRelease(pending.moveId, input.correlationId, input.now);
    if (!routed.routed) throw new AppError("CONFLICT", {});
    return { kind: "requested", moveId: pending.moveId, reused: true, routedOutboxId: routed.outboxId };
  }
  const moveId = input.newId();
  await store.moves.insertIncoming({
    organizationId: input.scope.organizationId,
    workspaceId: input.scope.workspaceId,
    moveId,
    side: "INCOMING",
    counterpartWorkspaceId: located.workspaceId,
    connectionId: asset.connectionId,
    connectedAccountId: null,
    platform: asset.platform,
    providerAssetId: asset.providerAssetId,
    initiatorUserId: input.scope.userId,
    status: "REQUESTED",
    reasonCode: null,
    createdAt: input.now,
    updatedAt: input.now,
  });
  // The source must still hold the active link when the request is routed; otherwise nothing is committed.
  const routed = await store.moves.routeRelease(moveId, input.correlationId, input.now);
  if (!routed.routed) throw new AppError("CONFLICT", {});
  return { kind: "requested", moveId, reused: false, routedOutboxId: routed.outboxId };
}

/**
 * Human retry of a failed activation: same move, no source restoration. The definer routes a NEW durable activation
 * attempt (its own outbox row, hence its own R6 effect key) while the move is still ACTIVATION_FAILED; only then does
 * the move go back to REQUESTED, in the same transaction.
 */
export async function retryMove(
  store: ConnectionStore,
  input: { readonly moveId: string; readonly correlationId: CorrelationId; readonly now: Date },
): Promise<{ readonly moveId: string; readonly routedOutboxId: string }> {
  const move = await store.moves.getIncoming(input.moveId);
  if (move === undefined) throw new AppError("NOT_FOUND", {});
  if (!isRetryable(move)) throw new AppError("STALE_STATE", {});
  const routed = await store.moves.routeRetry(move.moveId, input.correlationId, input.now);
  if (routed.outboxId === null || !(await store.moves.retry(move.moveId, input.now))) throw new AppError("STALE_STATE", {});
  return { moveId: move.moveId, routedOutboxId: routed.outboxId };
}

// ── Worker steps ───────────────────────────────────────────────────────────────────────────────────────────────

export interface SagaStepInput {
  readonly workspaceId: WorkspaceId;
  readonly moveId: string;
  readonly outboxId: string;
  readonly correlationId: CorrelationId;
  readonly now: Date;
  readonly newId: () => string;
}

export type SagaSkip = { readonly kind: "skipped"; readonly reason: "already_applied" | "not_pending" };

export type ReleaseOutcome = SagaSkip | { readonly kind: "released" } | { readonly kind: "rejected"; readonly reason: MoveReasonCode };

/** Source side (S). The payload's account id and counterpart were derived by the routing definer, never a caller. */
export async function releaseSource(
  store: ConnectionWorkerStore,
  input: SagaStepInput & { readonly connectedAccountId: string; readonly destinationWorkspaceId: WorkspaceId; readonly initiator: UserId },
): Promise<ReleaseOutcome> {
  if ((await store.claimEffect(`connections.move.release:${input.moveId}`)) === "already_applied") return { kind: "skipped", reason: "already_applied" };
  if ((await store.moves.lockOutgoing(input.moveId)) !== undefined) return { kind: "skipped", reason: "not_pending" };
  const account = await store.connectedAccounts.lock(input.connectedAccountId);
  // The routing definer derived this id from an ACTIVE row of this workspace; rows are never deleted.
  if (account === undefined) throw new AppError("NOT_FOUND", {});

  // Fail closed: the outgoing row is recorded as a refusal first; only a verified release turns it into RELEASED.
  const refusal: MoveReasonCode = account.status === "ACTIVE" ? "AUTHORITY_REVOKED" : "SOURCE_NOT_ACTIVE";
  await store.moves.insertOutgoing({
    organizationId: account.organizationId,
    workspaceId: input.workspaceId,
    moveId: input.moveId,
    side: "OUTGOING",
    counterpartWorkspaceId: input.destinationWorkspaceId,
    connectedAccountId: account.id,
    platform: account.platform,
    initiatorUserId: input.initiator,
    status: "REJECTED",
    reasonCode: refusal,
    createdAt: input.now,
    updatedAt: input.now,
  });

  if (account.status === "ACTIVE" && (await store.moves.initiatorCanManage(input.moveId))) {
    if (!(await store.connectedAccounts.release(account.id, input.moveId, input.now))) throw new Error("connections: concurrent release, retry");
    await store.moves.setOutgoing(input.moveId, "RELEASED", null, input.now);
    await store.accountEvents.append({
      id: input.newId(),
      organizationId: account.organizationId,
      workspaceId: input.workspaceId,
      connectedAccountId: account.id,
      eventType: "MOVED_OUT",
      moveId: input.moveId,
      reasonCode: "MOVE",
      actor: { type: "system" },
      occurredAt: input.now,
    });
    await store.moves.recordAudit(input.moveId, "moved_out", input.correlationId);
    if (!(await store.moves.route(input.moveId, "activate_destination", input.correlationId, input.now)).routed) throw new Error("connections: move routing refused");
    return { kind: "released" };
  }
  await store.moves.recordAudit(input.moveId, "move_rejected", input.correlationId);
  if (!(await store.moves.route(input.moveId, "reject_destination", input.correlationId, input.now)).routed) throw new Error("connections: move routing refused");
  return { kind: "rejected", reason: refusal };
}

/**
 * converged: the asset was already ACTIVE here (linked independently) — the move completes on that account, recorded
 * once in the saga audit (moved_in), with no second resource event (MOVED_IN) and no second capability evaluation.
 */
export type ActivationResult =
  | SagaSkip
  | { readonly kind: "completed"; readonly connectedAccountId: string; readonly evaluationEnqueued: boolean; readonly converged: boolean }
  | { readonly kind: "failed"; readonly reason: MoveReasonCode };

/** Destination side (D), after the source released. Each activation outbox row (initial or retry) applies once. */
export async function activateDestination(store: ConnectionWorkerStore, input: SagaStepInput): Promise<ActivationResult> {
  if ((await store.claimEffect(`connections.move.activate:${input.moveId}:${input.outboxId}`)) === "already_applied") {
    return { kind: "skipped", reason: "already_applied" };
  }
  const move = await store.moves.lockIncoming(input.moveId);
  if (move?.status !== "REQUESTED") return { kind: "skipped", reason: "not_pending" };

  const fail = async (reason: MoveReasonCode): Promise<ActivationResult> => {
    await store.moves.setIncoming(move.moveId, "ACTIVATION_FAILED", reason, null, input.now);
    await store.moves.recordAudit(move.moveId, "move_failed", input.correlationId);
    return { kind: "failed", reason };
  };
  const complete = async (connectedAccountId: string, activated: boolean): Promise<ActivationResult> => {
    if (activated) {
      await store.accountEvents.append({
        id: input.newId(),
        organizationId: move.organizationId,
        workspaceId: input.workspaceId,
        connectedAccountId,
        eventType: "MOVED_IN",
        moveId: move.moveId,
        reasonCode: "MOVE",
        actor: { type: "system" },
        occurredAt: input.now,
      });
    }
    await store.moves.setIncoming(move.moveId, "COMPLETED", null, connectedAccountId, input.now);
    await store.moves.recordAudit(move.moveId, "moved_in", input.correlationId);
    if (activated) {
      await store.outbox.append({
        id: input.newId(),
        topic: CAPABILITY_EVALUATION_TOPIC,
        organizationId: move.organizationId,
        workspaceId: input.workspaceId,
        subjectIds: { connected_account_id: connectedAccountId },
        correlationId: input.correlationId,
        initiator: { type: "system" },
        dispatchKey: `${CAPABILITY_EVALUATION_TOPIC}:${connectedAccountId}:${move.moveId}`,
        createdAt: input.now,
      });
    }
    return { kind: "completed", connectedAccountId, evaluationEnqueued: activated, converged: !activated };
  };

  if (!(await store.moves.initiatorCanManage(move.moveId))) return fail("AUTHORITY_REVOKED");
  const connection = await store.connections.get(move.connectionId);
  if (connection?.status !== "ACTIVE") return fail("DESTINATION_CONNECTION_UNHEALTHY");
  const asset = await store.discoveredAssets.find(move.connectionId, move.platform, move.providerAssetId);
  if (asset === undefined) return fail("ASSET_NOT_DISCOVERED");
  const located = await store.links.locateActive(asset.id);
  if (located !== undefined) {
    if (located.workspaceId !== input.workspaceId) return fail(activeElsewhereReason(singleWorkspaceRule(asset.assetClass)));
    // Already active HERE (linked independently): converge only if it is exactly the requested asset; that account
    // already had its own LINKED history and capability evaluation, so neither is repeated.
    const active = await store.connectedAccounts.get(located.connectedAccountId);
    const same = active?.status === "ACTIVE" && active.platform === asset.platform && active.providerAssetId === asset.providerAssetId && active.assetClass === asset.assetClass;
    // locate_active_link matches exactly this identity; anything else is corruption, never a business outcome.
    if (!same) throw new Error("connections: located account does not match the requested asset");
    return complete(located.connectedAccountId, false);
  }

  const existing = await store.connectedAccounts.findForAsset(asset.connectionId, asset.platform, asset.providerAssetId);
  const outcome = await store.connectedAccounts.activate({
    newId: input.newId(),
    reactivateId: existing?.status === "INACTIVE" ? existing.id : null,
    organizationId: move.organizationId,
    workspaceId: input.workspaceId,
    connectionId: asset.connectionId,
    platform: asset.platform,
    providerAssetId: asset.providerAssetId,
    assetClass: asset.assetClass,
    now: input.now,
  });
  if (outcome.kind === "conflict") return fail(activeElsewhereReason(outcome.rule));
  return complete(outcome.account.id, true);
}

export type RejectionResult = SagaSkip | { readonly kind: "rejected"; readonly reason: MoveReasonCode };

/**
 * Destination side (D), after the source refused (G4). The destination records only the closed, non-sensitive
 * SOURCE_RELEASE_REJECTED: the precise reason (AUTHORITY_REVOKED / SOURCE_NOT_ACTIVE) stays on the source's own move
 * row and audit, and nothing about the source's internal state is derived or exposed here.
 */
export async function rejectDestination(store: ConnectionWorkerStore, input: SagaStepInput): Promise<RejectionResult> {
  if ((await store.claimEffect(`connections.move.reject:${input.moveId}`)) === "already_applied") return { kind: "skipped", reason: "already_applied" };
  const move = await store.moves.lockIncoming(input.moveId);
  if (move?.status !== "REQUESTED") return { kind: "skipped", reason: "not_pending" };
  const reason: MoveReasonCode = "SOURCE_RELEASE_REJECTED";
  await store.moves.setIncoming(move.moveId, "REJECTED", reason, null, input.now);
  await store.moves.recordAudit(move.moveId, "move_rejected", input.correlationId);
  return { kind: "rejected", reason };
}
