/**
 * Step 7G-H5.5 — the availability resolver is the ONE downstream gate, and it fails closed on lifecycle and currency
 * before any stored row is read as authority: an inactive account, a missing profile and a profile on another catalog
 * or revision are never available, however permissive the stored rows. One available capability never implies
 * another. The stored profile here is the REAL evaluator's output over the simulator catalog (which supports reads).
 * The same rules on PostgreSQL: tests/db/suites/managed-accounts.ts.
 */
import { describe, expect, it } from "vitest";
import {
  ANY,
  CATALOGS,
  PLATFORM_CATALOG,
  SIMULATOR_CATALOG,
  capabilityAvailability,
  catalogIdFor,
  evaluateProfile,
  isCurrentProfile,
  type CapabilityKey,
  type CapabilityReadStore,
} from "@/modules/capability";
import type { ConnectionStatus } from "@/domain/connections";

const ACCOUNT = "4b9c0a7e-2f31-4d55-8a10-3c2d1e0f9a88";
const T0 = new Date("2026-10-19T12:00:00.000Z");

/** A current simulator profile whose account was granted the read permissions only. */
const profile = evaluateProfile({
  catalog: SIMULATOR_CATALOG,
  platform: "facebook",
  assetClass: "content_bearing",
  facts: { kind: "available", assetClass: "content_bearing", grantedPermissions: ["sim.read_content", "sim.read_interactions"], linkedAdAccountIds: [], accountIdentityKnown: true, obtainedAt: T0 },
  observations: [],
  evaluatedAt: T0,
});

function storeWith(header: { readonly catalogId: "platform" | "simulator"; readonly catalogRevision: number } | undefined): CapabilityReadStore {
  return {
    header: () =>
      Promise.resolve(
        header === undefined
          ? undefined
          : { connectedAccountId: ACCOUNT, ...header, facts: { kind: "unavailable", observedAt: T0 }, observations: [], inputsAsOf: T0, inputDigest: "0".repeat(64), evaluatedAt: T0, lastVerifiedAt: T0, revision: 1 },
      ),
    entries: () => Promise.resolve(profile.entries),
  };
}
const CURRENT = { catalogId: "simulator", catalogRevision: SIMULATOR_CATALOG.revision } as const;

const ask = (store: CapabilityReadStore, capability: CapabilityKey, options: { accountStatus?: "ACTIVE" | "INACTIVE"; connection?: ConnectionStatus; provider?: string } = {}) =>
  capabilityAvailability(store, {
    connectedAccountId: ACCOUNT,
    accountStatus: options.accountStatus ?? "ACTIVE",
    provider: options.provider ?? "simulator",
    capability,
    contentKind: ANY,
    source: ANY,
    connection: options.connection ?? "ACTIVE",
  });

describe("catalog currency (the existing revision mechanism, no second freshness concept)", () => {
  it("a provider maps to exactly one catalog; a profile is current only on that catalog's exact revision", () => {
    expect([catalogIdFor("meta"), catalogIdFor("tiktok"), catalogIdFor("simulator"), catalogIdFor("linkedin")]).toEqual(["platform", "platform", "simulator", "platform"]);
    expect(CATALOGS).toEqual({ platform: PLATFORM_CATALOG, simulator: SIMULATOR_CATALOG });
    expect(isCurrentProfile({ catalogId: "platform", catalogRevision: PLATFORM_CATALOG.revision }, "meta")).toBe(true);
    expect(isCurrentProfile({ catalogId: "platform", catalogRevision: PLATFORM_CATALOG.revision - 1 }, "meta")).toBe(false);
    expect(isCurrentProfile({ catalogId: "platform", catalogRevision: PLATFORM_CATALOG.revision + 1 }, "meta")).toBe(false);
    expect(isCurrentProfile({ catalogId: "simulator", catalogRevision: SIMULATOR_CATALOG.revision }, "meta")).toBe(false);
  });
});

describe("capabilityAvailability fails closed on lifecycle and currency", () => {
  it("ACTIVE + current profile: a read capability the profile supports is AVAILABLE — that capability only", async () => {
    const store = storeWith(CURRENT);
    expect(await ask(store, "read_content")).toMatchObject({ state: "AVAILABLE", reason: "CAPABILITY_SUPPORTED" });
    expect(await ask(store, "read_interactions")).toMatchObject({ state: "AVAILABLE", reason: "CAPABILITY_SUPPORTED" });
    // Not granted → UNSUPPORTED (permission missing); never implied by the reads being available.
    for (const capability of ["reply_public", "hide", "delete", "block"] as const) {
      expect(await ask(store, capability), capability).toMatchObject({ state: "UNAVAILABLE", reason: "ACCOUNT_PERMISSION_MISSING" });
    }
    expect(await ask(store, "detect_native_replies")).toMatchObject({ state: "UNAVAILABLE", reason: "CAPABILITY_NOT_VALIDATED" });
  });

  it("ACTIVE + no profile → PROFILE_NOT_EVALUATED", async () => {
    expect(await ask(storeWith(undefined), "read_content")).toMatchObject({ state: "UNAVAILABLE", reason: "PROFILE_NOT_EVALUATED", baseState: null });
  });

  it("ACTIVE + profile on an older revision, a newer one, or the wrong catalog → PROFILE_STALE, whatever its rows say", async () => {
    for (const header of [
      { catalogId: "simulator", catalogRevision: SIMULATOR_CATALOG.revision - 1 },
      { catalogId: "simulator", catalogRevision: SIMULATOR_CATALOG.revision + 1 },
      { catalogId: "platform", catalogRevision: PLATFORM_CATALOG.revision },
    ] as const) {
      expect(await ask(storeWith(header), "read_content"), JSON.stringify(header)).toMatchObject({ state: "UNAVAILABLE", reason: "PROFILE_STALE", baseState: null, recovery: null });
    }
    // A simulator profile can never stand for a real provider.
    expect(await ask(storeWith(CURRENT), "read_content", { provider: "meta" })).toMatchObject({ state: "UNAVAILABLE", reason: "PROFILE_STALE" });
  });

  it("INACTIVE + a previously available profile → ACCOUNT_INACTIVE (history, not authority)", async () => {
    for (const capability of ["read_content", "read_interactions", "hide"] as const) {
      expect(await ask(storeWith(CURRENT), capability, { accountStatus: "INACTIVE" })).toMatchObject({ state: "UNAVAILABLE", reason: "ACCOUNT_INACTIVE", baseState: null });
    }
  });

  it("REMOVED connection + a previously available profile → CONNECTION_REMOVED; an unhealthy one is temporarily unavailable", async () => {
    expect(await ask(storeWith(CURRENT), "read_content", { connection: "REMOVED" })).toMatchObject({ state: "UNAVAILABLE", reason: "CONNECTION_REMOVED" });
    expect(await ask(storeWith(CURRENT), "read_content", { connection: "DEGRADED" })).toMatchObject({ state: "TEMPORARILY_UNAVAILABLE", reason: "CONNECTION_DEGRADED" });
  });
});
