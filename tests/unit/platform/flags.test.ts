/**
 * Operational switch contracts (TA §66): registry invariants, resolution semantics, fail-safe behavior and
 * the cached reader. The database side (RLS visibility, audited writes) is proven by T-27 cases 19–20.
 */
import { describe, expect, it } from "vitest";
import { SWITCHES, SWITCH_KEYS, createSwitchReader, resolveSwitch, type SwitchRowInput } from "@/platform/flags";
import { SwitchChangeError, validateTarget } from "../../../tools/ops/switches";

const ORG = "1d0f7a3e-2b4c-4d5e-8f60-718293a4b5c6";
const WS = "2e1a8b4f-3c5d-4e6f-9a71-8293a4b5c6d7";

const row = (overrides: Partial<SwitchRowInput> & Pick<SwitchRowInput, "switchKey" | "value">): SwitchRowInput => ({
  qualifier: "*",
  scope: "global",
  organizationId: null,
  workspaceId: null,
  ...overrides,
});

describe("switch registry", () => {
  it("declares the seven TA §66 switches", () => {
    expect([...SWITCH_KEYS].sort()).toEqual([
      "ai.task_kill", "ai.task_routing", "automation.global_kill", "automation.release_gate",
      "ingestion.provider_pause", "mutation.provider_action", "provider.rollout",
    ]);
  });

  it("every fail-safe value is the restrictive one", () => {
    expect(SWITCHES["automation.global_kill"].failSafe).toEqual({ active: true });
    expect(SWITCHES["automation.release_gate"].failSafe).toEqual({ open: false });
    expect(SWITCHES["mutation.provider_action"].failSafe).toEqual({ enabled: false });
    expect(SWITCHES["provider.rollout"].failSafe).toEqual({ enabled: false });
    expect(SWITCHES["ai.task_kill"].failSafe).toEqual({ active: true });
    expect(SWITCHES["ingestion.provider_pause"].failSafe).toEqual({ paused: true });
    expect(SWITCHES["ai.task_routing"].failSafe).toEqual(SWITCHES["ai.task_routing"].defaultValue);
  });

  it("safety gates default closed: no release gate or rollout is open without configuration", () => {
    expect(resolveSwitch([], "automation.release_gate", { qualifier: "tiktok:obvious_spam" }).value.open).toBe(false);
    expect(resolveSwitch([], "provider.rollout", { qualifier: "tiktok" }).value.enabled).toBe(false);
    expect(resolveSwitch([], "automation.global_kill").value.active).toBe(false);
  });

  it("overrides exist only where TA §66.2 permits them", () => {
    for (const key of SWITCH_KEYS) {
      const scopes = SWITCHES[key].scopes;
      if (key === "provider.rollout") expect(scopes).toEqual(["global", "organization"]);
      else if (key === "ai.task_routing") expect(scopes).toEqual(["global", "workspace"]);
      else expect(scopes).toEqual(["global"]);
    }
  });
});

describe("resolution", () => {
  it("most_specific: workspace > organization > global, then exact qualifier > '*'", () => {
    const rows = [
      row({ switchKey: "ai.task_routing", value: { route: "global_any", percentage: 100 } }),
      row({ switchKey: "ai.task_routing", qualifier: "classify", value: { route: "global_exact", percentage: 100 } }),
      row({ switchKey: "ai.task_routing", scope: "workspace", workspaceId: WS, value: { route: "workspace_any", percentage: 20 } }),
    ];
    expect(resolveSwitch(rows, "ai.task_routing", { qualifier: "classify" })).toEqual({ value: { route: "global_exact", percentage: 100 }, source: "global", failSafe: false });
    expect(resolveSwitch(rows, "ai.task_routing", { qualifier: "summarize" }).value.route).toBe("global_any");
    expect(resolveSwitch(rows, "ai.task_routing", { qualifier: "classify", workspaceId: WS })).toEqual({ value: { route: "workspace_any", percentage: 20 }, source: "workspace", failSafe: false });
    expect(resolveSwitch(rows, "ai.task_routing", { qualifier: "classify", workspaceId: ORG }).value.route).toBe("global_exact");
  });

  it("provider rollout: an organization override wins over the global value for that organization only", () => {
    const rows = [
      row({ switchKey: "provider.rollout", qualifier: "tiktok", value: { enabled: false } }),
      row({ switchKey: "provider.rollout", qualifier: "tiktok", scope: "organization", organizationId: ORG, value: { enabled: true } }),
    ];
    expect(resolveSwitch(rows, "provider.rollout", { qualifier: "tiktok", organizationId: ORG }).value.enabled).toBe(true);
    expect(resolveSwitch(rows, "provider.rollout", { qualifier: "tiktok", organizationId: WS }).value.enabled).toBe(false);
  });

  it("any_restrictive: one applicable restrictive row wins, whatever its specificity", () => {
    const rows = [
      row({ switchKey: "mutation.provider_action", value: { enabled: false } }),
      row({ switchKey: "mutation.provider_action", qualifier: "tiktok:hide", value: { enabled: true } }),
    ];
    expect(resolveSwitch(rows, "mutation.provider_action", { qualifier: "tiktok:hide" }).value.enabled).toBe(false);
    const narrow = [row({ switchKey: "mutation.provider_action", qualifier: "tiktok:hide", value: { enabled: false } })];
    expect(resolveSwitch(narrow, "mutation.provider_action", { qualifier: "tiktok:hide" }).value.enabled).toBe(false);
    expect(resolveSwitch(narrow, "mutation.provider_action", { qualifier: "tiktok:unhide" }).value.enabled).toBe(true);
  });

  it.each([
    ["a wrong value type", row({ switchKey: "automation.global_kill", value: { active: "false" } })],
    ["an extra value key", row({ switchKey: "automation.global_kill", value: { active: false, note: "x" } })],
    ["a non-object value", row({ switchKey: "automation.global_kill", value: false })],
    ["a scope the switch doesn't allow", row({ switchKey: "automation.global_kill", scope: "workspace", workspaceId: WS, value: { active: false } })],
    ["an unknown scope", row({ switchKey: "automation.global_kill", scope: "region", value: { active: false } })],
  ])("an applicable row with %s resolves to the fail-safe", (_label, invalid) => {
    expect(resolveSwitch([invalid], "automation.global_kill", { workspaceId: WS })).toEqual({ value: { active: true }, source: "fail_safe", failSafe: true });
  });

  it("an invalid row for another key or qualifier doesn't affect unrelated switches", () => {
    const rows = [row({ switchKey: "ingestion.provider_pause", qualifier: "tiktok", value: { paused: "yes" } })];
    expect(resolveSwitch(rows, "ingestion.provider_pause", { qualifier: "tiktok" }).failSafe).toBe(true);
    expect(resolveSwitch(rows, "ingestion.provider_pause", { qualifier: "facebook" }).value.paused).toBe(false);
    expect(resolveSwitch(rows, "automation.global_kill").value.active).toBe(false);
  });

  it("AI routing values are bounded", () => {
    for (const value of [{ route: "x", percentage: 101 }, { route: "x", percentage: 1.5 }, { route: "Bad Route", percentage: 1 }]) {
      expect(resolveSwitch([row({ switchKey: "ai.task_routing", value })], "ai.task_routing").failSafe).toBe(true);
    }
  });
});

describe("cached reader", () => {
  it("reloads at most once per TTL and fails safe while the store is unreadable", async () => {
    let clock = 0;
    let loads = 0;
    let broken = false;
    const reader = createSwitchReader({
      ttlMs: 1_000,
      now: () => clock,
      load: () => {
        loads += 1;
        return broken ? Promise.reject(new Error("store down")) : Promise.resolve([row({ switchKey: "automation.global_kill", value: { active: false } })]);
      },
    });
    expect((await reader.get("automation.global_kill")).value.active).toBe(false);
    await reader.get("automation.global_kill");
    expect(loads).toBe(1);
    broken = true;
    clock = 1_000;
    expect(await reader.get("automation.global_kill")).toEqual({ value: { active: true }, source: "fail_safe", failSafe: true });
    expect((await reader.get("mutation.provider_action", { qualifier: "facebook:hide" })).value.enabled).toBe(false);
    broken = false;
    clock = 2_000;
    expect((await reader.get("automation.global_kill")).value.active).toBe(false);
    expect(loads).toBe(3);
  });
});

describe("operator tool validation", () => {
  it.each([
    [{ key: "automation.kill_everything", qualifier: "*", scope: "global" }],
    [{ key: "automation.global_kill", qualifier: "tiktok", scope: "global" }],
    [{ key: "automation.global_kill", qualifier: "*", scope: "workspace", workspaceId: WS }],
    [{ key: "automation.release_gate", qualifier: "tiktok:abuse", scope: "global" }],
    [{ key: "provider.rollout", qualifier: "tiktok", scope: "organization" }],
    [{ key: "provider.rollout", qualifier: "tiktok", scope: "organization", organizationId: "not-a-uuid" }],
    [{ key: "ai.task_routing", qualifier: "*", scope: "global", workspaceId: WS }],
  ])("refuses %j", (target) => {
    expect(() => validateTarget(target)).toThrow(SwitchChangeError);
  });

  it("accepts a valid override target", () => {
    expect(validateTarget({ key: "provider.rollout", qualifier: "tiktok:comments", scope: "organization", organizationId: ORG })).toEqual({
      key: "provider.rollout", qualifier: "tiktok:comments", scope: "organization", organizationId: ORG,
    });
  });
});
