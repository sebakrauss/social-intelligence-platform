/**
 * Whether the Connections page should OFFER "Re-check capabilities" for one managed account (Step 7G-H5.5-P2-B2). A
 * read-only, provider-neutral presentation signal, composed only from the recovery core's own exported pieces
 * (profileEligibility, withinReevaluationCooldown, REEVALUATION_COOLDOWN_EVENTS): no eligibility rule is restated here.
 * It is never authority: connections.account.request_capability_reevaluation re-checks permission, lifecycle, the
 * profile, the cooldown and concurrency in its own transaction, whatever the page showed.
 *
 * Eligible reasons reuse the capability module's vocabulary: availability's PROFILE_NOT_EVALUATED / PROFILE_STALE /
 * ACCOUNT_PERMISSION_MISSING and the profile reason code ACCOUNT_FACTS_UNAVAILABLE. The refusals are the command's.
 * Precedence follows the command's order.
 */
import type { CapabilityReadStore } from "@/modules/capability";
import type { ConnectedAccount, Connection } from "../domain/model";
import { REEVALUATION_COOLDOWN_EVENTS, profileEligibility, withinReevaluationCooldown, type ReevaluationBasis, type ReevaluationRefusal } from "./capability-reevaluation";
import type { ConnectionStore } from "./ports";

export const REEVALUATION_OFFER_REASONS = ["PROFILE_NOT_EVALUATED", "PROFILE_STALE", "ACCOUNT_FACTS_UNAVAILABLE", "ACCOUNT_PERMISSION_MISSING"] as const;
export type ReevaluationOfferReason = (typeof REEVALUATION_OFFER_REASONS)[number];

export type CapabilityReevaluationView =
  | { readonly allowed: true; readonly reason: ReevaluationOfferReason }
  | { readonly allowed: false; readonly reason: ReevaluationRefusal };

const OFFER_REASON: { readonly [B in ReevaluationBasis]: ReevaluationOfferReason } = {
  NO_PROFILE: "PROFILE_NOT_EVALUATED",
  PROFILE_STALE: "PROFILE_STALE",
  FACTS_UNAVAILABLE: "ACCOUNT_FACTS_UNAVAILABLE",
  AUTHORIZATION_MISSING: "ACCOUNT_PERMISSION_MISSING",
};

export interface ReevaluationViewStores {
  readonly accountEvents: Pick<ConnectionStore["accountEvents"], "latestOccurredAt">;
  readonly capability: CapabilityReadStore;
}

/** The offer for one account of one connection (both as the caller's transaction reads them; nothing is locked). */
export async function capabilityReevaluationView(
  stores: ReevaluationViewStores,
  input: { readonly account: Pick<ConnectedAccount, "id" | "status">; readonly connection: Pick<Connection, "provider" | "status">; readonly now: Date },
): Promise<CapabilityReevaluationView> {
  if (input.account.status !== "ACTIVE") return { allowed: false, reason: "ACCOUNT_INACTIVE" };
  if (input.connection.status !== "ACTIVE") return { allowed: false, reason: "CONNECTION_NOT_ACTIVE" };
  const header = await stores.capability.header(input.account.id);
  const eligibility = profileEligibility(header, input.connection.provider, header === undefined ? [] : await stores.capability.entries(input.account.id));
  if (!eligibility.eligible) return { allowed: false, reason: eligibility.reason };
  if (withinReevaluationCooldown(await stores.accountEvents.latestOccurredAt(input.account.id, REEVALUATION_COOLDOWN_EVENTS), input.now)) {
    return { allowed: false, reason: "REEVALUATION_TOO_SOON" };
  }
  return { allowed: true, reason: OFFER_REASON[eligibility.basis] };
}
