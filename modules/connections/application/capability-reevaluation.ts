/**
 * Explicit capability re-evaluation (Step 7G-H5.5-P2-B1): the provider-neutral recovery core. An Owner/Admin asks for
 * a NEW evaluation of one ACTIVE Connected Account whose capability profile can't be relied on (none yet, stale, or
 * current but resting on unavailable facts). An accepted request creates a NEW authority: a REEVALUATION_REQUESTED
 * account event and, in the same transaction, the ONE capability.evaluate_account request keyed by that event
 * (capability.evaluate_account:{account}:reeval.{event}). The existing worker then evaluates exactly as after an
 * activation. A consumed authority (any earlier request, whatever its run outcome) is never re-armed or reused: no
 * outbox row is read, updated or re-dispatched here.
 *
 * In ONE transaction, in this order (the first failing check decides the refusal):
 *   1  lock the account FOR UPDATE (requests about one account serialize; a waiting one re-reads after the lock)
 *   2  the account is ACTIVE                                      else ACCOUNT_INACTIVE
 *   3  its connection is ACTIVE (share-locked)                    else CONNECTION_NOT_ACTIVE
 *   4  the stored profile header (read only)
 *   5  eligibility:  no profile → eligible; stale (older revision or another catalog) → eligible;
 *                    current with facts unavailable → eligible;
 *                    current with a NOT_AUTHORIZED row → eligible (Step 7G-H5.5-P4-C: after the connection is
 *                      re-authorized, a Re-check is the supported way to re-read the provider facts — it never grants
 *                      any authorization itself; automatic evaluation after REAUTHORIZED is NOT implemented);
 *                    current with usable facts → PROFILE_CURRENT; newer revision than this code → PROFILE_NEWER_THAN_CODE
 *   6  cooldown: no LINKED, MOVED_IN or REEVALUATION_REQUESTED of this account in the last 30 minutes (server clock):
 *                    elapsed < 30:00 → REEVALUATION_TOO_SOON; exactly 30:00 → eligible
 *   7  append REEVALUATION_REQUESTED (the user, reason USER_REQUESTED_REEVALUATION, no move)
 *   8  append the evaluation request (identifiers only), keyed by the new event
 * The caller's action pipeline then writes the audit record in the same transaction. A refusal writes nothing.
 *
 * No provider, credential, job runtime or availability decision is reached: capabilityAvailability stays the only
 * authority on availability, and the worker alone calls the provider. Nothing schedules or repeats this request.
 */
import { AppError } from "@/domain/errors";
import { CATALOGS, catalogIdFor, isCurrentProfile, profileLacksAuthorization, type CapabilityReadStore, type ProfileEntry, type StoredProfileHeader } from "@/modules/capability";
import type { OutboxWriter } from "@/platform/outbox";
import type { AccountEventType } from "../domain/model";
import type { WorkspaceScope } from "./authorization";
import { capabilityEvaluationDispatchKey, capabilityEvaluationRequest } from "./capability-request";
import type { ConnectionStore } from "./ports";

/** Server-side cooldown between activations / re-evaluation requests of one account (invariant 13). */
export const CAPABILITY_REEVALUATION_COOLDOWN_MS = 30 * 60 * 1000;

/** The account events that start (or restart) the cooldown: each one already requested an evaluation. */
export const REEVALUATION_COOLDOWN_EVENTS: readonly AccountEventType[] = ["LINKED", "MOVED_IN", "REEVALUATION_REQUESTED"];

export const REEVALUATION_REFUSALS = ["PROFILE_CURRENT", "PROFILE_NEWER_THAN_CODE", "ACCOUNT_INACTIVE", "CONNECTION_NOT_ACTIVE", "REEVALUATION_TOO_SOON"] as const;
export type ReevaluationRefusal = (typeof REEVALUATION_REFUSALS)[number];

/** Why a profile may be re-evaluated (informational; never shown as availability). */
export type ReevaluationBasis = "NO_PROFILE" | "PROFILE_STALE" | "FACTS_UNAVAILABLE" | "AUTHORIZATION_MISSING";

export type ProfileEligibility =
  | { readonly eligible: true; readonly basis: ReevaluationBasis }
  | { readonly eligible: false; readonly reason: Extract<ReevaluationRefusal, "PROFILE_CURRENT" | "PROFILE_NEWER_THAN_CODE"> };

/**
 * Whether the stored profile header (if any) may be re-evaluated by the code running now. Pure and provider-neutral:
 * the catalog a profile SHOULD rest on comes only from the connection provider (catalogIdFor), exactly like
 * reconciliation; a profile on a newer revision than this code knows (a rolled-back deploy) is never replaced.
 */
export function profileEligibility(
  header: Pick<StoredProfileHeader, "catalogId" | "catalogRevision" | "facts"> | undefined,
  provider: string,
  entries: readonly Pick<ProfileEntry, "state">[],
): ProfileEligibility {
  if (header === undefined) return { eligible: true, basis: "NO_PROFILE" };
  if (isCurrentProfile(header, provider)) {
    if (header.facts.kind === "unavailable") return { eligible: true, basis: "FACTS_UNAVAILABLE" };
    return profileLacksAuthorization(entries) ? { eligible: true, basis: "AUTHORIZATION_MISSING" } : { eligible: false, reason: "PROFILE_CURRENT" };
  }
  const expected = CATALOGS[catalogIdFor(provider)];
  if (header.catalogId === expected.id && header.catalogRevision > expected.revision) return { eligible: false, reason: "PROFILE_NEWER_THAN_CODE" };
  return { eligible: true, basis: "PROFILE_STALE" };
}

/**
 * True while the cooldown started by `latest` is still running at `now` (both server-side instants). Elapsed time
 * strictly below 30:00 is too soon (29:59.999 refused); exactly 30:00 or more is eligible. An event dated after `now`
 * (clock skew) is too soon: the request is refused rather than trusted.
 */
export function withinReevaluationCooldown(latest: Date | undefined, now: Date): boolean {
  if (latest === undefined) return false;
  return now.getTime() - latest.getTime() < CAPABILITY_REEVALUATION_COOLDOWN_MS;
}

export type ReevaluationOutput =
  | { readonly kind: "requested"; readonly connectedAccountId: string; readonly eventId: string; readonly dispatchKey: string; readonly basis: ReevaluationBasis }
  | { readonly kind: "refused"; readonly connectedAccountId: string; readonly reason: ReevaluationRefusal };

export interface CapabilityReevaluationStores {
  readonly connections: {
    readonly connectedAccounts: Pick<ConnectionStore["connectedAccounts"], "lock">;
    readonly connections: Pick<ConnectionStore["connections"], "getForShare">;
    readonly accountEvents: ConnectionStore["accountEvents"];
  };
  readonly capability: CapabilityReadStore;
  readonly outbox: Pick<OutboxWriter, "append">;
}

export async function requestCapabilityReevaluation(
  stores: CapabilityReevaluationStores,
  input: { readonly scope: WorkspaceScope; readonly connectedAccountId: string; readonly correlationId: string; readonly now: Date; readonly newId: () => string },
): Promise<ReevaluationOutput> {
  const refused = (reason: ReevaluationRefusal): ReevaluationOutput => ({ kind: "refused", connectedAccountId: input.connectedAccountId, reason });

  // 1. Serialize on the account (RLS: another workspace's account, or one the caller can't manage, is simply absent).
  const account = await stores.connections.connectedAccounts.lock(input.connectedAccountId);
  if (account?.workspaceId !== input.scope.workspaceId) throw new AppError("NOT_FOUND", {});
  // 2–3. Lifecycle: only an ACTIVE account under an ACTIVE connection.
  if (account.status !== "ACTIVE") return refused("ACCOUNT_INACTIVE");
  const connection = await stores.connections.connections.getForShare(account.connectionId);
  if (connection?.status !== "ACTIVE") return refused("CONNECTION_NOT_ACTIVE");
  // 4–5. Eligibility of the stored profile.
  const header = await stores.capability.header(account.id);
  const eligibility = profileEligibility(header, connection.provider, header === undefined ? [] : await stores.capability.entries(account.id));
  if (!eligibility.eligible) return refused(eligibility.reason);
  // 6. Cooldown, read AFTER the lock: a concurrent request that committed first is seen here.
  if (withinReevaluationCooldown(await stores.connections.accountEvents.latestOccurredAt(account.id, REEVALUATION_COOLDOWN_EVENTS), input.now)) {
    return refused("REEVALUATION_TOO_SOON");
  }

  // 7–8. A NEW authority: the event, then the request keyed by it (same transaction).
  const eventId = input.newId();
  const reason = { kind: "reevaluation", eventId } as const;
  const dispatchKey = capabilityEvaluationDispatchKey(account.id, reason);
  await stores.connections.accountEvents.append({
    id: eventId,
    organizationId: input.scope.organizationId,
    workspaceId: input.scope.workspaceId,
    connectedAccountId: account.id,
    eventType: "REEVALUATION_REQUESTED",
    moveId: null,
    reasonCode: "USER_REQUESTED_REEVALUATION",
    actor: { type: "user", userId: input.scope.userId },
    occurredAt: input.now,
  });
  await stores.outbox.append(
    capabilityEvaluationRequest({
      id: input.newId(),
      organizationId: input.scope.organizationId,
      workspaceId: input.scope.workspaceId,
      connectedAccountId: account.id,
      reason,
      correlationId: input.correlationId,
      initiator: { type: "user", userId: input.scope.userId },
      createdAt: input.now,
    }),
  );
  return { kind: "requested", connectedAccountId: account.id, eventId, dispatchKey, basis: eligibility.basis };
}
