/**
 * The authority gate of every provider operation the ingestion module plans or performs (Step H6-C3; lifted out of
 * reconciliation.ts in Step H6-F4 so the signal-mark services can share it without an import cycle). Pure re-evaluation
 * from persistence, now: the account, its connection, the provider kill switch, the capability for the exact scope,
 * the evaluated profile and the presence of an active credential (never opened here).
 *
 * `ignorePause` (Step H6-F4) is for the signal classifier only: it evaluates the capability as if the provider were not
 * paused, because a paused provider must RETAIN a valid signal (a deferred mark) rather than lose it. The caller then
 * checks the pause itself; nothing that reads a provider ever passes it.
 */
import { capabilityAvailability, type CapabilityAvailability, type CapabilityKey } from "@/modules/capability";
import type { ConnectedAccount, Connection } from "@/modules/connections";
import type { AvailabilityInput } from "@/modules/coverage";
import { resolveSwitch } from "@/platform/flags";
import type { ReconciliationAuthorityStore } from "./reconciliation-ports";

const readable = (availability: CapabilityAvailability): boolean => availability.state === "AVAILABLE" || availability.state === "AVAILABLE_WITH_LIMITATION";
export const availabilityInput = (availability: CapabilityAvailability): AvailabilityInput => ({ state: availability.state, reason: availability.reason, limitationCode: availability.limitation?.code ?? null });
const failureClassOf = (reason: string): string => reason.toLowerCase();
/** Availability reasons that concern the whole account (the run stops) rather than one content scope. */
const ACCOUNT_LEVEL_REASONS: readonly string[] = [
  "ACCOUNT_PERMISSION_MISSING", "PROFILE_NOT_EVALUATED", "PROFILE_STALE", "ACCOUNT_INACTIVE",
  "CONNECTION_VALIDATING", "CONNECTION_DEGRADED", "CONNECTION_FAILED", "CONNECTION_DISCONNECTED", "CONNECTION_REMOVED",
];

export type Gate =
  | {
    readonly kind: "readable";
    readonly account: ConnectedAccount;
    readonly connection: Connection;
    readonly availability: CapabilityAvailability;
    readonly profile: { readonly catalogRevision: number; readonly revision: number };
  }
  | { readonly kind: "blocked"; readonly failureClass: string; readonly accountLevel: boolean; readonly availability: AvailabilityInput | null };

/** Whether the provider ingestion kill switch pauses this platform now. */
export async function providerPaused(scope: { readonly authority: ReconciliationAuthorityStore }, platform: string): Promise<boolean> {
  return resolveSwitch(await scope.authority.switches(), "ingestion.provider_pause", { qualifier: platform }).value.paused;
}

/** Re-evaluates everything one provider operation rests on, from persistence, now (never from an earlier step). */
export async function gate(
  scope: { readonly authority: ReconciliationAuthorityStore },
  connectedAccountId: string,
  capability: CapabilityKey,
  contentKind: string,
  source: string,
  options: { readonly shareLock?: boolean; readonly ignorePause?: boolean } = {},
): Promise<Gate> {
  const account = await scope.authority.account(connectedAccountId);
  if (account === undefined) return { kind: "blocked", failureClass: "account_not_found", accountLevel: true, availability: null };
  if (account.status !== "ACTIVE") return { kind: "blocked", failureClass: "account_inactive", accountLevel: true, availability: { state: "UNAVAILABLE", reason: "ACCOUNT_INACTIVE", limitationCode: null } };
  const connection = options.shareLock === true ? await scope.authority.connectionForShare(account.connectionId) : await scope.authority.connection(account.connectionId);
  if (connection === undefined || connection.status === "REMOVED") {
    return { kind: "blocked", failureClass: "connection_removed", accountLevel: true, availability: { state: "UNAVAILABLE", reason: "CONNECTION_REMOVED", limitationCode: null } };
  }
  // A paused provider reads nothing; its gap is not described as a provider failure (no coverage record = UNKNOWN).
  if (options.ignorePause !== true && (await providerPaused(scope, account.platform))) return { kind: "blocked", failureClass: "provider_paused", accountLevel: true, availability: null };
  const availability = await capabilityAvailability(scope.authority.capability, {
    connectedAccountId: account.id,
    accountStatus: account.status,
    provider: connection.provider,
    capability,
    contentKind: contentKind as Parameters<typeof capabilityAvailability>[1]["contentKind"],
    source: source as Parameters<typeof capabilityAvailability>[1]["source"],
    connection: connection.status,
  });
  if (!readable(availability)) {
    return { kind: "blocked", failureClass: failureClassOf(availability.reason), accountLevel: ACCOUNT_LEVEL_REASONS.includes(availability.reason), availability: availabilityInput(availability) };
  }
  const header = await scope.authority.capability.header(account.id);
  if (header === undefined) return { kind: "blocked", failureClass: "profile_not_evaluated", accountLevel: true, availability: { state: "UNAVAILABLE", reason: "PROFILE_NOT_EVALUATED", limitationCode: null } };
  if (connection.activeCredentialId === null) return { kind: "blocked", failureClass: "no_credential", accountLevel: true, availability: { state: "TEMPORARILY_UNAVAILABLE", reason: "CONNECTION_FAILED", limitationCode: null } };
  return { kind: "readable", account, connection, availability, profile: { catalogRevision: header.catalogRevision, revision: header.revision } };
}
