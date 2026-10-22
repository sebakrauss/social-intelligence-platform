/**
 * Step 7G-H5.5-P2-B2, without a database: the Connections read model's "Re-check capabilities" offer. It is composed
 * from the recovery core's own exported eligibility and cooldown functions, uses the capability module's vocabulary for
 * the eligible reasons, follows the command's precedence, reads only (header + latest relevant event time), and is
 * produced only for managed accounts by the connections.manage view command. The real read model is proven on
 * PostgreSQL in tests/db/suites/capability-reevaluation.ts.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AVAILABILITY_REASONS, CAPABILITY_REASON_CODES, PLATFORM_CATALOG, SIMULATOR_CATALOG, type FactsInput, type ProfileEntry, type StoredProfileHeader } from "@/modules/capability";
import {
  REEVALUATION_OFFER_REASONS,
  capabilityReevaluationView,
  viewConnectionSettings,
  type ConnectionStore,
} from "@/modules/connections";
import { connectionSettingsViewCommand } from "@/server/commands/connections";

const T0 = new Date("2026-10-21T12:00:00.000Z");
const MIN = 60_000;
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const available = (): FactsInput => ({ kind: "available", assetClass: "content_bearing", grantedPermissions: [], linkedAdAccountIds: [], accountIdentityKnown: true, obtainedAt: T0 });
const unavailable = (): FactsInput => ({ kind: "unavailable", observedAt: T0 });
type Header = Pick<StoredProfileHeader, "catalogId" | "catalogRevision" | "facts">;

function stores(header: Header | undefined, latest: Date | undefined, entries: readonly Pick<ProfileEntry, "state">[] = []) {
  const reads: string[] = [];
  return {
    reads,
    stores: {
      capability: {
        header: () => {
          reads.push("header");
          return Promise.resolve(header as StoredProfileHeader | undefined);
        },
        entries: () => {
          reads.push("entries");
          return Promise.resolve(entries as readonly ProfileEntry[]);
        },
      },
      accountEvents: {
        latestOccurredAt: (_id: string, types: readonly string[]) => {
          reads.push(`latest:${[...types].sort().join(",")}`);
          return Promise.resolve(latest);
        },
      },
    },
  };
}
const view = (header: Header | undefined, options: { latest?: Date; now?: Date; account?: "ACTIVE" | "INACTIVE"; connection?: "ACTIVE" | "DEGRADED" | "FAILED" | "DISCONNECTED" | "REMOVED" | "CONNECTING"; provider?: "meta" | "tiktok" | "simulator"; entries?: readonly Pick<ProfileEntry, "state">[] } = {}) => {
  const s = stores(header, options.latest, options.entries);
  return capabilityReevaluationView(s.stores, {
    account: { id: randomUUID(), status: options.account ?? "ACTIVE" },
    connection: { provider: options.provider ?? "meta", status: options.connection ?? "ACTIVE" },
    now: options.now ?? T0,
  }).then((result) => ({ result, reads: s.reads }));
};

describe("the re-check offer (view model)", () => {
  it("eligible: PROFILE_NOT_EVALUATED (no profile), PROFILE_STALE (older revision / other catalog), ACCOUNT_FACTS_UNAVAILABLE (current, facts unavailable)", async () => {
    expect((await view(undefined)).result).toEqual({ allowed: true, reason: "PROFILE_NOT_EVALUATED" });
    expect((await view({ catalogId: "platform", catalogRevision: PLATFORM_CATALOG.revision - 1, facts: available() })).result).toEqual({ allowed: true, reason: "PROFILE_STALE" });
    expect((await view({ catalogId: "simulator", catalogRevision: SIMULATOR_CATALOG.revision, facts: available() })).result).toEqual({ allowed: true, reason: "PROFILE_STALE" });
    expect((await view({ catalogId: "platform", catalogRevision: PLATFORM_CATALOG.revision, facts: unavailable() })).result).toEqual({ allowed: true, reason: "ACCOUNT_FACTS_UNAVAILABLE" });
  });

  it("Step 7G-H5.5-P4-C: a current profile with a NOT_AUTHORIZED row offers Re-check as ACCOUNT_PERMISSION_MISSING; cooldown still applies", async () => {
    const current = { catalogId: "platform" as const, catalogRevision: PLATFORM_CATALOG.revision, facts: available() };
    const rows = [{ state: "SUPPORTED" as const }, { state: "NOT_AUTHORIZED" as const }];
    expect(await view(current, { entries: rows })).toEqual({ result: { allowed: true, reason: "ACCOUNT_PERMISSION_MISSING" }, reads: ["header", "entries", "latest:LINKED,MOVED_IN,REEVALUATION_REQUESTED"] });
    expect((await view(current, { entries: [{ state: "SUPPORTED" }] })).result).toEqual({ allowed: false, reason: "PROFILE_CURRENT" });
    expect((await view(current, { entries: rows, latest: T0, now: at(5 * MIN) })).result).toEqual({ allowed: false, reason: "REEVALUATION_TOO_SOON" });
  });

  it("the eligible reasons are the capability module's own vocabulary (availability reasons / reason codes)", () => {
    expect(AVAILABILITY_REASONS).toContain("PROFILE_NOT_EVALUATED");
    expect(AVAILABILITY_REASONS).toContain("PROFILE_STALE");
    expect(CAPABILITY_REASON_CODES).toContain("ACCOUNT_FACTS_UNAVAILABLE");
    for (const reason of REEVALUATION_OFFER_REASONS) expect([...AVAILABILITY_REASONS, ...CAPABILITY_REASON_CODES]).toContain(reason);
  });

  it("not eligible: current usable profile, newer than this code", async () => {
    expect((await view({ catalogId: "platform", catalogRevision: PLATFORM_CATALOG.revision, facts: available() })).result).toEqual({ allowed: false, reason: "PROFILE_CURRENT" });
    expect((await view({ catalogId: "platform", catalogRevision: PLATFORM_CATALOG.revision + 1, facts: unavailable() })).result).toEqual({ allowed: false, reason: "PROFILE_NEWER_THAN_CODE" });
  });

  it("an inactive account or a non-ACTIVE connection offers no recovery, before anything is read", async () => {
    const inactive = await view(undefined, { account: "INACTIVE" });
    expect(inactive).toEqual({ result: { allowed: false, reason: "ACCOUNT_INACTIVE" }, reads: [] });
    for (const connection of ["DEGRADED", "FAILED", "DISCONNECTED", "REMOVED", "CONNECTING"] as const) {
      expect(await view(undefined, { connection })).toEqual({ result: { allowed: false, reason: "CONNECTION_NOT_ACTIVE" }, reads: [] });
    }
  });

  it("cooldown is derived from the same server-side rule: 29:59 → REEVALUATION_TOO_SOON, 30:00 → offered", async () => {
    expect((await view(undefined, { latest: T0, now: at(29 * MIN + 59_000) })).result).toEqual({ allowed: false, reason: "REEVALUATION_TOO_SOON" });
    expect((await view(undefined, { latest: T0, now: at(30 * MIN) })).result).toEqual({ allowed: true, reason: "PROFILE_NOT_EVALUATED" });
    const { reads } = await view(undefined, { latest: T0, now: at(30 * MIN) });
    expect(reads).toEqual(["header", "latest:LINKED,MOVED_IN,REEVALUATION_REQUESTED"]);
  });

  it("the cooldown note's single reason covers every source event: LINKED, MOVED_IN and REEVALUATION_REQUESTED (others don't start it)", async () => {
    const byType = (type: string) => ({
      capability: { header: () => Promise.resolve(undefined), entries: () => Promise.resolve([]) },
      accountEvents: {
        latestOccurredAt: (_id: string, types: readonly string[]) => Promise.resolve(types.includes(type) ? T0 : undefined),
      },
    });
    const at = (type: string) =>
      capabilityReevaluationView(byType(type), { account: { id: randomUUID(), status: "ACTIVE" }, connection: { provider: "meta", status: "ACTIVE" }, now: new Date(T0.getTime() + 5 * MIN) });
    for (const type of ["LINKED", "MOVED_IN", "REEVALUATION_REQUESTED"]) expect(await at(type), type).toEqual({ allowed: false, reason: "REEVALUATION_TOO_SOON" });
    for (const type of ["UNLINKED", "MOVED_OUT", "DEACTIVATED"]) expect(await at(type), type).toEqual({ allowed: true, reason: "PROFILE_NOT_EVALUATED" });
  });

  it("provider-neutral: the same answers for any provider of the platform catalog", async () => {
    for (const provider of ["meta", "tiktok"] as const) {
      expect((await view(undefined, { provider })).result).toEqual({ allowed: true, reason: "PROFILE_NOT_EVALUATED" });
      expect((await view({ catalogId: "platform", catalogRevision: PLATFORM_CATALOG.revision, facts: available() }, { provider })).result).toEqual({ allowed: false, reason: "PROFILE_CURRENT" });
    }
  });
});

describe("the settings read model carries the offer for managed accounts only", () => {
  const connectionId = randomUUID();
  const managedId = randomUUID();
  const fake = (header: Header | undefined) => {
    const store = {
      connections: { list: () => Promise.resolve([{ id: connectionId, provider: "meta", status: "ACTIVE", workspaceId: "w", organizationId: "o", activeCredentialId: null, authorizedBy: "u", authorizedAt: T0, lastSuccessAt: null, lastProblemCode: null, lastProblemAt: null, version: 1, createdAt: T0, updatedAt: T0 }]) },
      connectedAccounts: { list: () => Promise.resolve([{ id: managedId, connectionId, platform: "facebook", providerAssetId: "page-1", status: "ACTIVE" }]) },
      discoveredAssets: {
        list: () =>
          Promise.resolve([
            { id: randomUUID(), connectionId, platform: "facebook", providerAssetId: "page-1", assetClass: "content_bearing", displayName: "Managed" },
            { id: randomUUID(), connectionId, platform: "instagram", providerAssetId: "ig-1", assetClass: "content_bearing", displayName: "Unmanaged" },
          ]),
      },
      accountEvents: { latestOccurredAt: () => Promise.resolve(undefined) },
    } as unknown as ConnectionStore;
    return viewConnectionSettings(store, { capability: { header: () => Promise.resolve(header as StoredProfileHeader | undefined), entries: () => Promise.resolve([]) }, now: T0 });
  };

  it("managed → its account id and offer; unmanaged → no account, no offer", async () => {
    const settings = await fake(undefined);
    expect(settings.manageableAssets.map(({ displayName, managed, connectedAccountId, capabilityReevaluation }) => ({ displayName, managed, connectedAccountId, capabilityReevaluation }))).toEqual([
      { displayName: "Managed", managed: true, connectedAccountId: managedId, capabilityReevaluation: { allowed: true, reason: "PROFILE_NOT_EVALUATED" } },
      { displayName: "Unmanaged", managed: false, connectedAccountId: null, capabilityReevaluation: null },
    ]);
    expect((await fake({ catalogId: "platform", catalogRevision: PLATFORM_CATALOG.revision, facts: available() })).manageableAssets[0]?.capabilityReevaluation).toEqual({ allowed: false, reason: "PROFILE_CURRENT" });
  });

  it("the view command that produces it requires connections.manage: an actor without it gets no read model (no offer, no action)", () => {
    expect(connectionSettingsViewCommand.permission).toBe("connections.manage");
    expect(connectionSettingsViewCommand.audit({ connections: [], metaConnect: "available", manageableAssets: [] })).toBeUndefined();
  });
});
