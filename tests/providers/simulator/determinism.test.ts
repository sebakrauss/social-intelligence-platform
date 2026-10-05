/**
 * Simulator determinism, failure injection, credentials, rate budgets, scenario validation and the absence of
 * network access.
 */
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialInvalidError, RateLimitedError, providerCredential, providerObjectRef, type InteractionDto } from "@/integrations/providers/contract";
import { FaultConfigError, ScenarioError, SimulatorWorld, createSimulatorReadPort, parseFaultRule, parseScenario } from "@/integrations/providers/simulator";
import { createSimulatorMutationPort } from "@/integrations/providers/simulator/mutation-port";
import { loadScenario, rawScenario, stableSerialize } from "../support/fixtures";
import { FULL_WINDOW, SIM_SIGNING_KEY, createBaselineSimulator } from "../support/simulator-harness";

const sim = createBaselineSimulator();
const { world, read, mutation } = sim;
const fb = sim.access("cred_meta_main", "fb_page_aurora");
const tt = sim.access("cred_tiktok_main", "tt_acct_aurora");

beforeEach(() => {
  world.reset();
});

describe("deterministic reset", () => {
  it("reset restores the scenario exactly after mutations, native actions, faults and clock moves", async () => {
    const snapshot = async () => stableSerialize((await read.listInteractions(fb, { kind: "account" }, FULL_WINDOW, null)).data);
    const initial = await snapshot();
    await mutation.replyPublicly(fb, providerObjectRef("facebook", "interaction", "fb_c_001"), "Hola", { key: "k" });
    await mutation.hide(fb, providerObjectRef("facebook", "interaction", "fb_c_005"));
    world.editInteraction("fb_c_004", "editado");
    world.advanceClock(3600);
    world.injectFaults([{ operation: "listInteractions", on: "every", fault: { kind: "transient", reason: "network" } }]);
    world.reset();
    expect(await snapshot()).toBe(initial);
    expect(world.journal.length).toBe(1);
    expect(world.events).toEqual([]);
    expect(world.privateReplies).toEqual([]);
    expect(world.now()).toBe("2026-09-15T12:00:00.000Z");
  });

  it("two worlds from the same scenario produce identical output, including generated ids", async () => {
    const other = createBaselineSimulator();
    const run = async (s: typeof sim) => {
      const access = s.access("cred_meta_main", "fb_page_aurora");
      const receipt = (await s.mutation.replyPublicly(access, providerObjectRef("facebook", "interaction", "fb_c_001"), "Hola", { key: "k" })).data;
      return stableSerialize({ receipt, events: s.world.events, journal: s.world.journal });
    };
    expect(await run(sim)).toBe(await run(other));
  });
});

describe("deterministic failure injection", () => {
  it("fires exactly on the configured n-th matching call", async () => {
    world.injectFaults([{ operation: "getInteraction", on: 2, fault: { kind: "transient", reason: "server_error" } }]);
    const ref = providerObjectRef("facebook", "interaction", "fb_c_001");
    await expect(read.getInteraction(fb, ref)).resolves.toBeDefined();
    await expect(read.getInteraction(fb, ref)).rejects.toMatchObject({ kind: "transient", reason: "server_error" });
    await expect(read.getInteraction(fb, ref)).resolves.toBeDefined();
  });

  it("can target one object and fire on every call", async () => {
    world.injectFaults([{ operation: "getInteraction", target: "fb_c_005", on: "every", fault: { kind: "target_not_found" } }]);
    await expect(read.getInteraction(fb, providerObjectRef("facebook", "interaction", "fb_c_005"))).rejects.toMatchObject({ kind: "target_not_found" });
    await expect(read.getInteraction(fb, providerObjectRef("facebook", "interaction", "fb_c_005"))).rejects.toMatchObject({ kind: "target_not_found" });
    await expect(read.getInteraction(fb, providerObjectRef("facebook", "interaction", "fb_c_001"))).resolves.toBeDefined();
  });

  it("the same configuration yields the same journal on every run", async () => {
    const runOnce = async () => {
      world.reset();
      world.applyFaultPreset("credential_revoked_mid_listing");
      const outcomes: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        outcomes.push(await read.listInteractions(tt, { kind: "account" }, FULL_WINDOW, null).then(() => "ok", (e: unknown) => (e as { kind: string }).kind));
      }
      return outcomes;
    };
    expect(await runOnce()).toEqual(["ok", "credential_invalid", "ok"]);
    expect(await runOnce()).toEqual(["ok", "credential_invalid", "ok"]);
  });

  it("rejects invalid fault rules, including ambiguity faults on read operations", () => {
    expect(parseFaultRule({ operation: "listContent", on: 1, fault: { kind: "outcome_unknown" } })).toBeUndefined();
    expect(parseFaultRule({ operation: "hide", on: 0, fault: { kind: "transient", reason: "network" } })).toBeUndefined();
    expect(parseFaultRule({ operation: "readMessages", on: 1, fault: { kind: "target_not_found" } })).toBeUndefined();
    expect(() => {
      world.injectFaults([{ operation: "listContent", on: 1, fault: { kind: "timeout_before_send" } }]);
    }).toThrow(FaultConfigError);
  });
});

describe("credentials", () => {
  it("revoked and expired credentials normalize to CredentialInvalid with a closed reason", async () => {
    await expect(read.describeAccount(sim.access("cred_revoked", "fb_page_aurora"))).rejects.toMatchObject({ kind: "credential_invalid", reason: "revoked" });
    await expect(read.describeAccount(sim.access("cred_expired", "ig_acct_aurora"))).rejects.toMatchObject({ kind: "credential_invalid", reason: "expired" });
  });

  it("a credential revoked during a scenario fails the next call", async () => {
    await expect(read.describeAccount(fb)).resolves.toBeDefined();
    world.revokeCredential("cred_meta_main");
    await expect(read.describeAccount(fb)).rejects.toBeInstanceOf(CredentialInvalidError);
  });

  it("a forged credential (right id, wrong secret) is invalid, and the secret never appears in the error", async () => {
    const wrong = { ...fb, credential: providerCredential("cred_meta_main", "synthetic-wrong-secret") };
    const error = await read.describeAccount(wrong).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "credential_invalid", reason: "malformed" });
    expect(JSON.stringify(error)).not.toContain("synthetic");
  });

  it("refresh: needed → refreshed (new secret, wrapped), far from expiry → not_needed, unsupported → not_supported", async () => {
    const refreshed = (await read.refreshCredential(world.credential("cred_meta_expiring"))).data;
    expect(refreshed.status).toBe("refreshed");
    if (refreshed.status === "refreshed") {
      expect(refreshed.expiresAt).toBe("2026-11-14T12:00:00.000Z");
      expect(String(refreshed.credential.secret)).toBe("[redacted]");
      expect(refreshed.credential.secret.expose()).not.toBe(world.scenario.credentials.find((c) => c.id === "cred_meta_expiring")?.secret);
    }
    expect((await read.refreshCredential(world.credential("cred_meta_main"))).data.status).toBe("not_needed");
    expect((await read.refreshCredential(world.credential("cred_tiktok_main"))).data.status).toBe("not_supported");
  });

  it("an account outside the credential looks exactly like a missing one", async () => {
    await expect(read.describeAccount(sim.access("cred_tiktok_main", "fb_page_aurora"))).rejects.toMatchObject({ kind: "target_not_found" });
  });
});

describe("rate-budget signals", () => {
  it("reports usage, remaining calls and reset time where the simulated provider reports them", async () => {
    const first = (await read.describeAccount(fb)).budget;
    const second = (await read.describeAccount(fb)).budget;
    expect(first).toEqual({ kind: "reported", scope: "account", usedRatio: 0.005, remainingCalls: 199, resetAt: "2026-09-15T13:00:00.000Z" });
    expect(second).toMatchObject({ usedRatio: 0.01, remainingCalls: 198 });
  });

  it("exhausting the budget yields RateLimited with retry-after until the window resets", async () => {
    world.advanceClock(1800);
    for (let i = 0; i < 200; i += 1) await read.describeAccount(fb);
    const error = await read.describeAccount(fb).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAfterSeconds).toBe(1800);
    world.advanceClock(1800);
    await expect(read.describeAccount(fb)).resolves.toMatchObject({ budget: { remainingCalls: 199 } });
  });

  it("a provider that reports nothing usable yields not_reported, never an invented budget", async () => {
    const minimal = new SimulatorWorld(loadScenario("unreported-budget"));
    const port = createSimulatorReadPort(minimal, { webhookSigningKey: SIM_SIGNING_KEY });
    const result = await port.listInteractions({ credential: minimal.credential("cred_min"), account: minimal.assetRef("ig_min") }, { kind: "account" }, FULL_WINDOW, null);
    expect(result.budget).toEqual({ kind: "not_reported" });
    expect(result.data.items.map((i: InteractionDto) => i.textRevision)).toEqual([null]);
  });
});

describe("no network", () => {
  const connect = vi.spyOn(net.Socket.prototype, "connect");
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  afterEach(() => {
    connect.mockClear();
    fetchSpy.mockClear();
  });

  it("a full read + mutation + webhook cycle opens no socket and calls no fetch", async () => {
    const isolated = new SimulatorWorld(loadScenario("baseline"));
    const reads = createSimulatorReadPort(isolated, { webhookSigningKey: SIM_SIGNING_KEY });
    const writes = createSimulatorMutationPort(isolated);
    const access = { credential: isolated.credential("cred_meta_main"), account: isolated.assetRef("fb_page_aurora") };
    await reads.discoverAssets(access.credential);
    await reads.listContent(access, FULL_WINDOW, null);
    await reads.listInteractions(access, { kind: "account" }, FULL_WINDOW, null);
    await writes.replyPublicly(access, providerObjectRef("facebook", "interaction", "fb_c_001"), "Hola", { key: "k" });
    await writes.hide(access, providerObjectRef("facebook", "interaction", "fb_c_005"));
    await reads.refreshCredential(isolated.credential("cred_meta_expiring"));
    expect(connect).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("scenario validation", () => {
  it("the committed fixtures parse", () => {
    expect(parseScenario(rawScenario("baseline")).scenarioId).toBe("baseline");
    expect(parseScenario(rawScenario("unreported-budget")).rateBudget).toEqual({ mode: "not_reported" });
  });

  it("rejects fixtures that aren't marked simulated or claim a non-simulator API version", () => {
    expect(() => parseScenario({ ...rawScenario("baseline"), simulated: false })).toThrow(/\$\.simulated/);
    expect(() => parseScenario({ ...rawScenario("baseline"), apiVersion: "v19.0" })).toThrow(/\$\.apiVersion/);
  });

  it("rejects dangling references and unknown fields", () => {
    const raw = rawScenario("baseline");
    const interactions = raw["interactions"] as Record<string, unknown>[];
    const orphan = { ...interactions[0], id: "orphan_c_1", content: "missing_content" };
    expect(() => parseScenario({ ...raw, interactions: [...interactions, orphan] })).toThrow(/interactions\.orphan_c_1/);
    expect(() => parseScenario({ ...raw, direct_messages: [] })).toThrow(/\$\.direct_messages/);
    expect(() => parseScenario({ ...raw, interactions: [{ ...interactions[0], kind: "direct_message" }] })).toThrow(ScenarioError);
  });
});
