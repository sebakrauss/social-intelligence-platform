/**
 * Capability reconciliation (Step 7G-H5.5): request an evaluation for every ACTIVE Connected Account of the bound
 * workspace whose profile is missing or rests on another catalog or an older catalog revision — through the SAME
 * request (capability-request.ts) and therefore the same capability.evaluate_account path an activation uses.
 * Provider-neutral: which catalog a profile should rest on comes from the account's connection provider only.
 *
 * Runs in a worker scope bound to one workspace (it reads accounts and profile headers and appends outbox rows; it
 * opens no credential and calls no provider). Bounded and resumable: at most `limit` accounts per call, in id order
 * after `after`; `next` continues where it stopped. Idempotent: every request has a deterministic dispatch key —
 * a missing profile reuses the key of the account's latest activation, so an activation's own pending request is
 * found rather than duplicated; a stale profile is keyed by the target catalog revision. A key already taken is
 * `already_requested` (concurrent reconcilers and activations converge on one row).
 *
 * Deliberately NOT requested:
 *   - INACTIVE accounts (an old profile is history; availability refuses it as ACCOUNT_INACTIVE);
 *   - accounts whose connection is not ACTIVE (REMOVED is terminal; an unhealthy one is recovered by re-authorization,
 *     and availability already overlays its health);
 *   - a profile on a NEWER revision than this code knows (a rolled-back deploy): older code can never replace it, and
 *     availability refuses it as PROFILE_STALE until the newer code runs again.
 * A request whose evaluation then fails or is skipped is not re-requested under the same key: failed runs surface
 * through the job foundation's run-outcome records (R7), never through blind repetition.
 */
import { CATALOGS, catalogIdFor, isCurrentProfile, type CapabilityReadStore } from "@/modules/capability";
import { capabilityEvaluationRequest, type EvaluationReason } from "./capability-request";
import type { CapabilityReconcileStore } from "./ports";

/** The most accounts one reconciliation call examines. */
export const CAPABILITY_RECONCILE_MAX_BATCH = 200;

export interface CapabilityReconcileOutcome {
  readonly scanned: number;
  /** Accounts for which a new evaluation request was appended. */
  readonly requested: readonly string[];
  /** Accounts that needed an evaluation whose request already exists. */
  readonly alreadyRequested: readonly string[];
  readonly current: number;
  readonly skipped: number;
  /** Continue after this account id (null: nothing left in this workspace). */
  readonly next: string | null;
}

export async function requestCapabilityReevaluations(
  stores: { readonly accounts: CapabilityReconcileStore; readonly capability: Pick<CapabilityReadStore, "header"> },
  input: {
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly after: string | null;
    readonly limit: number;
    readonly correlationId: string;
    readonly now: Date;
    readonly newId: () => string;
  },
): Promise<CapabilityReconcileOutcome> {
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), CAPABILITY_RECONCILE_MAX_BATCH);
  const candidates = await stores.accounts.activeAccounts(input.after, limit);
  const requested: string[] = [];
  const alreadyRequested: string[] = [];
  let current = 0;
  let skipped = 0;

  for (const account of candidates) {
    if (account.connectionStatus !== "ACTIVE") {
      skipped += 1;
      continue;
    }
    const header = await stores.capability.header(account.id);
    let reason: EvaluationReason;
    if (header === undefined) {
      const activationId = await stores.accounts.latestActivation(account.id);
      reason = activationId === undefined ? { kind: "unrecorded" } : { kind: "activation", activationId };
    } else if (isCurrentProfile(header, account.provider)) {
      current += 1;
      continue;
    } else {
      const expected = CATALOGS[catalogIdFor(account.provider)];
      if (header.catalogId === expected.id && header.catalogRevision > expected.revision) {
        skipped += 1;
        continue;
      }
      reason = { kind: "catalog", catalogId: expected.id, catalogRevision: expected.revision };
    }
    const outcome = await stores.accounts.requestOnce(
      capabilityEvaluationRequest({
        id: input.newId(),
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        connectedAccountId: account.id,
        reason,
        correlationId: input.correlationId,
        initiator: { type: "system" },
        createdAt: input.now,
      }),
    );
    (outcome === "appended" ? requested : alreadyRequested).push(account.id);
  }

  return { scanned: candidates.length, requested, alreadyRequested, current, skipped, next: candidates.length === limit ? (candidates.at(-1)?.id ?? null) : null };
}
