/**
 * Step 7B-12A — fail-closed mutation authorization (`mutation.provider_action`, resolution `explicit_allow`).
 *
 * The resolver matrix (every platform × action), the compatibility table with the PREVIOUS semantics (old code with
 * the "*" block deny; new code denies with or without it), the cached reader's failure, the ops tool's refusal of a
 * granting wildcard, and the guard decision the three consumers (request, Inbox, executor) read. Nothing here touches
 * a database: the DB side (audited writes, RLS visibility) is T-27.
 */
import { describe, expect, it } from "vitest";
import { MUTATION_ACTIONS, PLATFORMS, SWITCHES, createSwitchReader, resolveSwitch, type SwitchRowInput } from "@/platform/flags";
import { SwitchChangeError, wildcardGrantProblem } from "../../../tools/ops/switches";
import { describeResolution, parseSwitchCommand } from "@/tools/ops/switch-command";

const KEY = "mutation.provider_action";
const row = (qualifier: string, value: unknown, overrides: Partial<SwitchRowInput> = {}): SwitchRowInput => ({
  switchKey: KEY,
  qualifier,
  scope: "global",
  organizationId: null,
  workspaceId: null,
  value,
  ...overrides,
});
const ALL_PAIRS = PLATFORMS.flatMap((platform) => MUTATION_ACTIONS.map((action) => `${platform}:${action}`));
const allowed = (rows: readonly SwitchRowInput[], qualifier: string): boolean => resolveSwitch(rows, KEY, { qualifier }).value.enabled;
const allowedPairs = (rows: readonly SwitchRowInput[]): string[] => ALL_PAIRS.filter((pair) => allowed(rows, pair));

/**
 * The resolution `mutation.provider_action` had before Step 7B-12A (any_restrictive, default enabled), reproduced
 * from the previous registry so the transition table below is executable, not a comment.
 */
function previousSemantics(rows: readonly SwitchRowInput[], qualifier: string): boolean {
  const relevant = rows.filter((r) => r.switchKey === KEY && r.scope === "global" && (r.qualifier === "*" || r.qualifier === qualifier));
  const parsed = relevant.map((r) => SWITCHES[KEY].parse(r.value));
  if (parsed.some((value) => value === undefined)) return false;
  if (parsed.some((value) => value?.enabled === false)) return false;
  return true;
}

describe("Step 7B-12A · registry", () => {
  it("mutation.provider_action is explicit_allow, DENY by default and DENY as fail-safe; the other switches keep their rule", () => {
    expect(SWITCHES[KEY].resolution).toBe("explicit_allow");
    expect(SWITCHES[KEY].defaultValue).toEqual({ enabled: false });
    expect(SWITCHES[KEY].failSafe).toEqual({ enabled: false });
    expect(SWITCHES["automation.global_kill"]).toMatchObject({ resolution: "any_restrictive", defaultValue: { active: false }, failSafe: { active: true } });
    expect(SWITCHES["ai.task_kill"]).toMatchObject({ resolution: "any_restrictive", defaultValue: { active: false }, failSafe: { active: true } });
    expect(SWITCHES["ingestion.provider_pause"].resolution).toBe("any_restrictive");
    expect(SWITCHES["automation.release_gate"].resolution).toBe("most_specific");
    expect(Object.values(SWITCHES).filter((definition) => definition.resolution === "explicit_allow").map((definition) => definition.key)).toEqual([KEY]);
  });
});

describe("Step 7B-12A · resolver matrix (3 platforms × 6 actions = 18 pairs)", () => {
  it("no rows → DENY for all 18 pairs (source: default)", () => {
    expect(allowedPairs([])).toEqual([]);
    for (const pair of ALL_PAIRS) expect(resolveSwitch([], KEY, { qualifier: pair }).source, pair).toBe("default");
  });

  it("the wildcard block {enabled:false} → DENY for all 18 pairs", () => {
    expect(allowedPairs([row("*", { enabled: false })])).toEqual([]);
  });

  it("only instagram:public_reply granted → ALLOW exactly that pair; Facebook, TikTok and every other Instagram action stay DENY", () => {
    const rows = [row("instagram:public_reply", { enabled: true })];
    expect(allowedPairs(rows)).toEqual(["instagram:public_reply"]);
    expect(allowed(rows, "facebook:public_reply")).toBe(false);
    expect(allowed(rows, "instagram:delete")).toBe(false);
    expect(allowed(rows, "instagram:private_reply")).toBe(false);
    for (const action of MUTATION_ACTIONS) expect(allowed(rows, `tiktok:${action}`)).toBe(false);
  });

  it("wildcard block + instagram:public_reply granted → DENY (the emergency block always wins)", () => {
    const rows = [row("*", { enabled: false }), row("instagram:public_reply", { enabled: true })];
    expect(allowedPairs(rows)).toEqual([]);
    expect(resolveSwitch(rows, KEY, { qualifier: "instagram:public_reply" })).toMatchObject({ value: { enabled: false }, source: "global", failSafe: false });
  });

  it("a granting wildcard {enabled:true} is invalid → DENY (fail-safe) for all 18 pairs, even next to an exact grant", () => {
    expect(allowedPairs([row("*", { enabled: true })])).toEqual([]);
    expect(allowedPairs([row("*", { enabled: true }), row("instagram:public_reply", { enabled: true })])).toEqual([]);
    expect(resolveSwitch([row("*", { enabled: true })], KEY, { qualifier: "instagram:public_reply" })).toMatchObject({ source: "fail_safe", failSafe: true });
  });

  it("an exact row {enabled:false} → DENY (source: the row, i.e. 'paused')", () => {
    expect(resolveSwitch([row("instagram:public_reply", { enabled: false })], KEY, { qualifier: "instagram:public_reply" })).toMatchObject({ value: { enabled: false }, source: "global" });
  });

  it.each([
    ["unknown platform", "snapchat:public_reply"],
    ["unknown action", "instagram:edit"],
    ["future action spelled like a known one", "instagram:public_replies"],
    ["no action", "instagram"],
    ["extra segment", "instagram:public_reply:x"],
    ["upper case", "Instagram:public_reply"],
    ["the wildcard as a query", "*"],
    ["empty", ""],
  ])("an invalid or unknown query qualifier (%s) → DENY, even when everything valid is granted", (_label, qualifier) => {
    const everything = ALL_PAIRS.map((pair) => row(pair, { enabled: true }));
    expect(allowed(everything, qualifier)).toBe(false);
    expect(resolveSwitch(everything, KEY, { qualifier })).toMatchObject({ source: "fail_safe", failSafe: true });
  });

  it("no qualifier at all → DENY (fail-safe)", () => {
    expect(resolveSwitch([row("instagram:public_reply", { enabled: true })], KEY)).toMatchObject({ value: { enabled: false }, failSafe: true });
  });

  it.each([
    ["enabled as a string", { enabled: "true" }],
    ["enabled as a number", { enabled: 1 }],
    ["an extra key", { enabled: true, note: "x" }],
    ["not an object", true],
    ["null", null],
  ])("an applicable row with an invalid value (%s) → DENY (fail-safe), whatever else is granted", (_label, value) => {
    const rows = [row("instagram:public_reply", value), row("facebook:public_reply", { enabled: true })];
    expect(resolveSwitch(rows, KEY, { qualifier: "instagram:public_reply" })).toMatchObject({ value: { enabled: false }, failSafe: true });
    // An invalid row only taints the queries it applies to: another exact pair is unaffected.
    expect(allowed(rows, "facebook:public_reply")).toBe(true);
  });

  it("an applicable row with a scope the switch doesn't allow → DENY (fail-safe)", () => {
    const rows = [row("instagram:public_reply", { enabled: true }), row("*", { enabled: false }, { scope: "galaxy" })];
    expect(resolveSwitch(rows, KEY, { qualifier: "instagram:public_reply" })).toMatchObject({ failSafe: true, value: { enabled: false } });
  });

  it("two applicable contradictory rows for the same pair → DENY", () => {
    const rows = [row("instagram:public_reply", { enabled: true }), row("instagram:public_reply", { enabled: false })];
    expect(allowed(rows, "instagram:public_reply")).toBe(false);
    expect(allowed([...rows].reverse(), "instagram:public_reply")).toBe(false);
  });

  it("organization or workspace rows never grant (the switch is global; tenant authorization stays in role, mode, capability and ownership)", () => {
    const ORG = "1d0f7a3e-2b4c-4d5e-8f60-718293a4b5c6";
    const WS = "2e1a8b4f-3c5d-4e6f-9a71-8293a4b5c6d7";
    const rows = [
      row("instagram:public_reply", { enabled: true }, { scope: "organization", organizationId: ORG }),
      row("instagram:public_reply", { enabled: true }, { scope: "workspace", workspaceId: WS }),
    ];
    expect(resolveSwitch(rows, KEY, { qualifier: "instagram:public_reply", organizationId: ORG, workspaceId: WS }).value.enabled).toBe(false);
    expect(resolveSwitch(rows, KEY, { qualifier: "instagram:public_reply" }).value.enabled).toBe(false);
  });

  it("rows of other switches never grant a mutation", () => {
    const rows = [row("*", { active: false }, { switchKey: "automation.global_kill" }), row("instagram", { enabled: true }, { switchKey: "provider.rollout" })];
    expect(allowedPairs(rows)).toEqual([]);
  });
});

describe("Step 7B-12A · the cached reader", () => {
  it("a store that can't be read → DENY (fail-safe) for every pair, until a later read succeeds", async () => {
    let fail = true;
    let t = 0;
    const reader = createSwitchReader({
      load: () => (fail ? Promise.reject(new Error("db down")) : Promise.resolve([row("instagram:public_reply", { enabled: true })])),
      ttlMs: 1000,
      now: () => t,
    });
    for (const pair of ALL_PAIRS) expect((await reader.get(KEY, { qualifier: pair })).value.enabled, pair).toBe(false);
    expect((await reader.get(KEY, { qualifier: "instagram:public_reply" })).source).toBe("fail_safe");
    fail = false;
    t = 5000;
    expect((await reader.get(KEY, { qualifier: "instagram:public_reply" })).value.enabled).toBe(true);
    expect((await reader.get(KEY, { qualifier: "facebook:public_reply" })).value.enabled).toBe(false);
  });
});

describe("Step 7B-12A · transition compatibility (old code = any_restrictive + default enabled)", () => {
  const WILDCARD_BLOCK = [row("*", { enabled: false })];
  const ONLY_INSTAGRAM = [row("instagram:public_reply", { enabled: true })];

  it("old code + the wildcard block → DENY for all 18 pairs (today's DEV state is safe for every running version)", () => {
    expect(ALL_PAIRS.filter((pair) => previousSemantics(WILDCARD_BLOCK, pair))).toEqual([]);
  });

  it("new code + the wildcard block → DENY for all 18 pairs", () => {
    expect(allowedPairs(WILDCARD_BLOCK)).toEqual([]);
  });

  it("new code + empty configuration → DENY for all 18 pairs (removing the block is safe ONLY once no old consumer remains)", () => {
    expect(allowedPairs([])).toEqual([]);
    // The reason the block may not be removed while old code runs: the previous semantics allow EVERY pair here.
    expect(ALL_PAIRS.filter((pair) => previousSemantics([], pair))).toEqual(ALL_PAIRS);
  });

  it("new code + instagram:public_reply granted without the block → ALLOW only that pair (old code would allow all 18)", () => {
    expect(allowedPairs(ONLY_INSTAGRAM)).toEqual(["instagram:public_reply"]);
    expect(ALL_PAIRS.filter((pair) => previousSemantics(ONLY_INSTAGRAM, pair))).toHaveLength(18);
  });
});

describe("Step 7B-12A · ops:switch refuses a granting wildcard (before anything is contacted)", () => {
  const ATTR = ["--operator", "claude-code:test", "--reason", "test"];
  const base = ["set", "--target", "development", "--key", KEY, "--scope", "global"];

  it("the CLI refuses '*' {enabled:true} and accepts '*' {enabled:false} as the global block", () => {
    const grant = parseSwitchCommand([...base, "--qualifier", "*", "--value", '{"enabled":true}', ...ATTR]);
    expect(grant).toMatchObject({ ok: false });
    expect(grant.ok ? "" : grant.problem).toMatch(/may only block mutation\.provider_action/);
    expect(parseSwitchCommand([...base, "--qualifier", "*", "--value", '{"enabled":false}', ...ATTR])).toMatchObject({ ok: true });
  });

  it("an exact platform:action may be set to true or false; an unknown qualifier is refused", () => {
    expect(parseSwitchCommand([...base, "--qualifier", "instagram:public_reply", "--value", '{"enabled":true}', ...ATTR])).toMatchObject({ ok: true });
    expect(parseSwitchCommand([...base, "--qualifier", "instagram:public_reply", "--value", '{"enabled":false}', ...ATTR])).toMatchObject({ ok: true });
    for (const qualifier of ["snapchat:public_reply", "instagram:edit", "instagram", "Instagram:public_reply"]) {
      expect(parseSwitchCommand([...base, "--qualifier", qualifier, "--value", '{"enabled":true}', ...ATTR]), qualifier).toMatchObject({ ok: false });
    }
  });

  it("`show` on '*' reports the emergency block and every pair the runtime would allow (one read verifies all 18)", () => {
    const target = { key: KEY, qualifier: "*", scope: "global" } as const;
    const stored = (qualifier: string, value: unknown) => ({ switchKey: KEY, qualifier, scope: "global", organizationId: null, workspaceId: null, value });
    expect(describeResolution([stored("*", { enabled: false })], target)).toMatch(/emergency block .*ACTIVE[\s\S]*runtime allows +none \(of 18/);
    expect(describeResolution([], target)).toMatch(/emergency block .*absent[\s\S]*runtime allows +none/);
    expect(describeResolution([stored("instagram:public_reply", { enabled: true })], target)).toMatch(/runtime allows +instagram:public_reply \(of 18/);
    expect(describeResolution([stored("*", { enabled: false }), stored("instagram:public_reply", { enabled: true })], target)).toMatch(/ACTIVE[\s\S]*runtime allows +none/);
    // An exact pair is described as before: its own resolution.
    expect(describeResolution([stored("instagram:public_reply", { enabled: true })], { key: KEY, qualifier: "instagram:public_reply", scope: "global" })).toMatch(/→ \{"enabled":true\} \(source: global\)/);
  });

  it("the write helper refuses the same wildcard grant (defense in depth for setSwitch callers)", () => {
    expect(wildcardGrantProblem(KEY, "*", { enabled: true })).toMatch(/may only block/);
    expect(wildcardGrantProblem(KEY, "*", { enabled: false })).toBeUndefined();
    expect(wildcardGrantProblem(KEY, "instagram:public_reply", { enabled: true })).toBeUndefined();
    // Other switches are untouched: a kill switch's "*" value is whatever its shape allows.
    expect(wildcardGrantProblem("automation.global_kill", "*", { active: true })).toBeUndefined();
    expect(wildcardGrantProblem("ai.task_kill", "*", { active: false })).toBeUndefined();
    expect(new SwitchChangeError("x")).toBeInstanceOf(Error);
  });
});
