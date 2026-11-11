/**
 * Step 7B-14G1 — catalogValidationPending: the ONE narrow capability answer a one-time validation authorization may act
 * on. True ONLY for a current profile whose resolved row is UNKNOWN_NOT_VALIDATED with exactly CATALOG_NOT_VALIDATED, on
 * an ACTIVE account and an ACTIVE connection. Every other state — NOT_AUTHORIZED, UNSUPPORTED, missing or inconsistent
 * account facts, a stale or missing profile, an incoherent row, an unhealthy connection, a usable capability — is false.
 * The effective availability is never changed by it (still UNAVAILABLE / CAPABILITY_NOT_VALIDATED). Profiles here are
 * the REAL evaluator's output over the PRODUCTIVE catalog (reply_public unpublished → UNKNOWN) and the simulator's.
 */
import { describe, expect, it } from "vitest";
import {
  ANY,
  PLATFORM_CATALOG,
  SIMULATOR_CATALOG,
  capabilityAvailability,
  catalogValidationPending,
  evaluateProfile,
  type CapabilityCatalog,
  type CapabilityReadStore,
  type FactsInput,
  type ProfileEntry,
} from "@/modules/capability";
import type { ConnectionStatus } from "@/domain/connections";

const ACCOUNT = "4b9c0a7e-2f31-4d55-8a10-3c2d1e0f9a99";
const T0 = new Date("2026-11-11T12:00:00.000Z");
const IG_FACTS: FactsInput = { kind: "available", assetClass: "content_bearing", grantedPermissions: ["instagram_basic", "instagram_manage_comments", "pages_read_engagement", "pages_show_list"], linkedAdAccountIds: [], accountIdentityKnown: true, obtainedAt: T0 };

const profileOf = (catalog: CapabilityCatalog, facts: FactsInput, platform: "instagram" | "facebook" = "instagram") =>
  evaluateProfile({ catalog, platform, assetClass: "content_bearing", facts, observations: [], evaluatedAt: T0 });

/** `null` header: no stored profile at all. */
function storeWith(entries: readonly ProfileEntry[], header: { readonly catalogId: "platform" | "simulator"; readonly catalogRevision: number } | null = { catalogId: "platform", catalogRevision: PLATFORM_CATALOG.revision }): CapabilityReadStore {
  return {
    header: () => Promise.resolve(header === null ? undefined : { connectedAccountId: ACCOUNT, ...header, facts: IG_FACTS, observations: [], inputsAsOf: T0, inputDigest: "0".repeat(64), evaluatedAt: T0, lastVerifiedAt: T0, revision: 1 }),
    entries: () => Promise.resolve(entries),
  };
}
const ask = (store: CapabilityReadStore, options: { accountStatus?: "ACTIVE" | "INACTIVE"; connection?: ConnectionStatus; provider?: string } = {}) => {
  const input = { connectedAccountId: ACCOUNT, accountStatus: options.accountStatus ?? "ACTIVE", provider: options.provider ?? "meta", capability: "reply_public" as const, contentKind: "post" as const, source: "organic" as const, connection: options.connection ?? "ACTIVE" };
  return Promise.all([catalogValidationPending(store, input), capabilityAvailability(store, input)]);
};

describe("7B-14G1: catalogValidationPending", () => {
  it("is true for the productive catalog's unpublished reply_public (UNKNOWN / CATALOG_NOT_VALIDATED) — and availability stays UNAVAILABLE", async () => {
    const entries = profileOf(PLATFORM_CATALOG, IG_FACTS).entries;
    expect(entries.filter((e) => e.capability === "reply_public").map((e) => [e.state, e.reasons])).toEqual([["UNKNOWN_NOT_VALIDATED", ["CATALOG_NOT_VALIDATED"]]]);
    const [pending, availability] = await ask(storeWith(entries));
    expect(pending).toBe(true);
    expect(availability).toMatchObject({ state: "UNAVAILABLE", reason: "CAPABILITY_NOT_VALIDATED" });
  });

  it("is false for an inactive account, an unhealthy connection, another provider's catalog, a stale or missing profile", async () => {
    const entries = profileOf(PLATFORM_CATALOG, IG_FACTS).entries;
    expect((await ask(storeWith(entries), { accountStatus: "INACTIVE" }))[0]).toBe(false);
    for (const connection of ["CONNECTING", "DEGRADED", "FAILED", "DISCONNECTED", "REMOVED"] as const) expect((await ask(storeWith(entries), { connection }))[0], connection).toBe(false);
    expect((await ask(storeWith(entries), { provider: "simulator" }))[0]).toBe(false);
    expect((await ask(storeWith(entries, { catalogId: "platform", catalogRevision: PLATFORM_CATALOG.revision - 1 })))[0]).toBe(false);
    expect((await ask(storeWith(entries, null)))[0]).toBe(false);
    expect((await ask(storeWith([])))[0]).toBe(false);
  });

  it("is false for UNKNOWN because account facts are missing or inconsistent (never only the catalog)", async () => {
    const unavailable = profileOf(PLATFORM_CATALOG, { kind: "unavailable", observedAt: T0 }).entries;
    // The productive catalog's own UNKNOWN wins first; craft the facts-based UNKNOWN rows explicitly.
    const asFactsUnknown = (reason: "ACCOUNT_FACTS_UNAVAILABLE" | "ACCOUNT_FACTS_INCONSISTENT") => unavailable.map((e) => (e.capability === "reply_public" ? { ...e, reasons: [reason] } : e));
    expect((await ask(storeWith(asFactsUnknown("ACCOUNT_FACTS_UNAVAILABLE"))))[0]).toBe(false);
    expect((await ask(storeWith(asFactsUnknown("ACCOUNT_FACTS_INCONSISTENT"))))[0]).toBe(false);
    // Two reasons, one of them CATALOG_NOT_VALIDATED: not "only the catalog".
    expect((await ask(storeWith(unavailable.map((e) => (e.capability === "reply_public" ? { ...e, reasons: ["CATALOG_NOT_VALIDATED", "ACCOUNT_FACTS_UNAVAILABLE"] } : e)))))[0]).toBe(false);
  });

  it("is false for NOT_AUTHORIZED, UNSUPPORTED, an incoherent row and a usable capability", async () => {
    const simulator = (permissions: readonly string[]) => profileOf(SIMULATOR_CATALOG, { ...IG_FACTS, grantedPermissions: [...permissions] }, "facebook").entries;
    const simHeader = { catalogId: "simulator", catalogRevision: SIMULATOR_CATALOG.revision } as const;
    const askSim = (entries: readonly ProfileEntry[]) => ask(storeWith(entries, simHeader), { provider: "simulator" });
    // NOT_AUTHORIZED: the simulator supports reply_public, the account lacks the permission.
    const notAuthorized = simulator(["sim.read_content"]);
    expect(notAuthorized.find((e) => e.capability === "reply_public")?.state).toBe("NOT_AUTHORIZED");
    expect((await askSim(notAuthorized))[0]).toBe(false);
    // SUPPORTED (usable): nothing to stand in for.
    const supported = simulator(["sim.read_content", "sim.read_interactions", "sim.reply_public"]);
    expect((await askSim(supported))[1].state).toBe("AVAILABLE");
    expect((await askSim(supported))[0]).toBe(false);
    // UNSUPPORTED and an incoherent row (state and reasons that can't go together).
    const base = profileOf(PLATFORM_CATALOG, IG_FACTS).entries;
    const swap = (row: Partial<ProfileEntry>) => base.map((e) => (e.capability === "reply_public" ? { ...e, ...row } : e));
    expect((await ask(storeWith(swap({ state: "UNSUPPORTED", reasons: ["CATALOG_UNSUPPORTED"] }))))[0]).toBe(false);
    expect((await ask(storeWith(swap({ state: "UNKNOWN_NOT_VALIDATED", reasons: ["CATALOG_SUPPORTED"] }))))[0]).toBe(false);
    expect((await ask(storeWith(swap({ state: "NOT_AUTHORIZED", reasons: ["ACCOUNT_PERMISSION_MISSING"] }))))[0]).toBe(false);
  });

  it("answers for the TARGET's scope: an (any, any) row is resolved like the availability resolver does", async () => {
    const entries = profileOf(PLATFORM_CATALOG, IG_FACTS).entries.filter((e) => e.capability === "reply_public");
    expect(entries.every((e) => e.contentKind === ANY && e.source === ANY)).toBe(true);
    expect((await ask(storeWith(entries)))[0]).toBe(true);
  });
});
