/**
 * Step 7G-H5.5-P12-D2a — the REPLIES_NOT_READ limitation code in the capability domain: it is one more closed
 * limitation of an AVAILABLE_WITH_LIMITATION row, kept through evaluation and the availability overlay exactly like
 * the existing codes, never a state, never non-support. A synthetic catalog exercises it (no real catalog names it yet:
 * catalog r5 is a later gate). The PostgreSQL CHECK (0016) is proven in tests/db/suites/capability.ts.
 */
import { describe, expect, it } from "vitest";
import {
  ANY,
  CATALOG_STATES,
  LIMITATION_CODES,
  PLATFORM_CATALOG,
  PROFILE_STATES,
  SIMULATOR_CATALOG,
  effectiveAvailability,
  evaluateProfile,
  isCoherentProfileShape,
  type CapabilityCatalog,
  type EvaluationInput,
} from "@/modules/capability";

const T0 = new Date("2026-10-27T10:00:00.000Z");
const LIMITED = { code: "REPLIES_NOT_READ", value: null } as const;
/** A synthetic, test-only catalog: one read_interactions entry limited by REPLIES_NOT_READ. Never a real platform catalog. */
const catalog: CapabilityCatalog = Object.freeze({
  id: "simulator",
  revision: 99,
  label: "synthetic-replies-not-read",
  entries: Object.freeze([
    Object.freeze({ platform: ANY, assetClass: "content_bearing", capability: "read_interactions", contentKind: "post", source: "unknown", state: "AVAILABLE_WITH_LIMITATION", limitation: LIMITED, requiredPermissions: Object.freeze(["synthetic.read"]), validation: "validated", evidence: "simulator:synthetic" }),
  ]),
} as const);
const input = (granted: readonly string[]): EvaluationInput => ({
  catalog,
  platform: "instagram",
  assetClass: "content_bearing",
  facts: { kind: "available", assetClass: "content_bearing", grantedPermissions: granted, linkedAdAccountIds: [], accountIdentityKnown: true, obtainedAt: T0 },
  observations: [],
  evaluatedAt: new Date(T0.getTime() + 60_000),
});
const row = (granted: readonly string[]) => evaluateProfile(input(granted)).entries.find((e) => e.capability === "read_interactions" && e.contentKind === "post" && e.source === "unknown");

describe("REPLIES_NOT_READ is a limitation, not a state", () => {
  it("is in the closed limitation vocabulary; no state was added", () => {
    expect(LIMITATION_CODES).toContain("REPLIES_NOT_READ");
    expect(CATALOG_STATES).not.toContain("REPLIES_NOT_READ" as never);
    expect(PROFILE_STATES).not.toContain("REPLIES_NOT_READ" as never);
  });

  it("an authorized account gets AVAILABLE_WITH_LIMITATION / CATALOG_LIMITATION carrying the code; the row is coherent", () => {
    const entry = row(["synthetic.read"]);
    expect(entry).toMatchObject({ state: "AVAILABLE_WITH_LIMITATION", reasons: ["CATALOG_LIMITATION"], limitation: LIMITED });
    expect(entry !== undefined && isCoherentProfileShape(entry)).toBe(true);
  });

  it("a missing permission is NOT_AUTHORIZED without a limitation — never UNSUPPORTED", () => {
    expect(row([])).toMatchObject({ state: "NOT_AUTHORIZED", reasons: ["ACCOUNT_PERMISSION_MISSING"], limitation: null });
  });

  it("the overlay keeps the limitation visible while healthy and while temporarily unavailable", () => {
    const entry = row(["synthetic.read"]);
    expect(effectiveAvailability(entry, "ACTIVE", "read_interactions", T0)).toMatchObject({ state: "AVAILABLE_WITH_LIMITATION", reason: "CAPABILITY_LIMITATION", limitation: LIMITED });
    expect(effectiveAvailability(entry, "DEGRADED", "read_interactions", T0)).toMatchObject({ state: "TEMPORARILY_UNAVAILABLE", limitation: LIMITED });
  });

  it("a row carrying the code with any other state is incoherent and never trusted", () => {
    for (const state of ["SUPPORTED", "NOT_AUTHORIZED", "UNSUPPORTED", "UNKNOWN_NOT_VALIDATED"] as const) {
      expect(isCoherentProfileShape({ state, reasons: ["CATALOG_SUPPORTED"], limitation: LIMITED })).toBe(false);
    }
  });

  it("neither real catalog names it yet (catalog r5 is a later gate)", () => {
    expect([...PLATFORM_CATALOG.entries, ...SIMULATOR_CATALOG.entries].some((entry) => entry.limitation?.code === "REPLIES_NOT_READ")).toBe(false);
  });
});
