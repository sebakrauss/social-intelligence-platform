/**
 * Simulator MUTATION behavior: explicit simulated state transitions, the one-shot private reply (no DM model),
 * and ambiguity preservation (OutcomeUnknown applies the change but loses the response; a timeout before
 * sending applies nothing). No product guard is exercised here: that is the executor's job (Step 9).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { OutcomeUnknownError, TargetNotEligibleError, TargetNotFoundError, TransientError, isDefiniteFailure, providerObjectRef } from "@/integrations/providers/contract";
import { FULL_WINDOW, createBaselineSimulator } from "../support/simulator-harness";

const sim = createBaselineSimulator();
const { world, read, mutation } = sim;
const fb = sim.access("cred_meta_main", "fb_page_aurora");
const comment = (id: string) => providerObjectRef("facebook", "interaction", id);

beforeEach(() => {
  world.reset();
});

describe("public reply", () => {
  it("creates a brand-authored reply interaction under the target", async () => {
    const before = world.interactionCount();
    const receipt = (await mutation.replyPublicly(fb, comment("fb_c_001"), "¡Hola! Te respondemos en un momento.", { key: "intent-1" })).data;
    expect(world.interactionCount()).toBe(before + 1);
    expect(receipt.createdInteraction).not.toBeNull();
    const created = (await read.getInteraction(fb, receipt.createdInteraction ?? comment("x"))).data;
    expect(created).toMatchObject({ interactionKind: "reply", parent: comment("fb_c_001"), author: { role: "account_identity" }, text: "¡Hola! Te respondemos en un momento." });
  });

  it("provider idempotency hints are not honored: domain idempotency must stay authoritative (R6)", async () => {
    await mutation.replyPublicly(fb, comment("fb_c_001"), "Una vez", { key: "same-key" });
    await mutation.replyPublicly(fb, comment("fb_c_001"), "Una vez", { key: "same-key" });
    const replies = world.journal.filter((e) => e.operation === "replyPublicly" && e.outcome === "ok");
    expect(replies).toHaveLength(2);
  });

  it("rejects an empty reply and replies to missing targets as not found", async () => {
    await expect(mutation.replyPublicly(fb, comment("fb_c_001"), "   ", { key: "k" })).rejects.toMatchObject({ kind: "permanent_rejected", reasonCode: "invalid_request" });
    await expect(mutation.replyPublicly(fb, comment("fb_c_008"), "Hola", { key: "k" })).rejects.toBeInstanceOf(TargetNotFoundError);
  });
});

describe("private reply (one-shot, outbound only — S9)", () => {
  it("records a receipt and creates NO interaction, thread or inbound object", async () => {
    const before = world.interactionCount();
    const listedBefore = (await read.listInteractions(fb, { kind: "account" }, FULL_WINDOW, null)).data.items.length;
    const receipt = (await mutation.replyPrivately(fb, comment("fb_c_001"), "Te escribimos el detalle por privado.", { key: "intent-p1" })).data;
    expect(receipt).toMatchObject({ kind: "private_reply", target: comment("fb_c_001") });
    expect(receipt.providerReceiptId).toMatch(/^sim-pr-/);
    expect(world.interactionCount()).toBe(before);
    expect((await read.listInteractions(fb, { kind: "account" }, FULL_WINDOW, null)).data.items.length).toBe(listedBefore);
    expect(world.privateReplies).toEqual([{ receiptId: receipt.providerReceiptId, account: "fb_page_aurora", target: "fb_c_001", at: receipt.confirmedAt, textLength: 37 }]);
    expect(world.events.filter((e) => e.target.id === receipt.providerReceiptId)).toEqual([]);
  });

  it("a timeout before sending applies nothing and is a definite (transient) failure", async () => {
    world.applyFaultPreset("private_reply_timeout_before_send");
    const error = await mutation.replyPrivately(fb, comment("fb_c_001"), "Hola", { key: "k" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransientError);
    expect((error as TransientError).reason).toBe("timeout_before_send");
    expect(isDefiniteFailure(error as TransientError)).toBe(true);
    expect(world.privateReplies).toEqual([]);
  });
});

describe("hide / unhide / delete / block", () => {
  it("hide and unhide change simulated visibility and report no-op repeats", async () => {
    expect((await mutation.hide(fb, comment("fb_c_001"))).data.changed).toBe(true);
    expect(world.interactionState("fb_c_001")?.visibility).toBe("hidden");
    expect((await mutation.hide(fb, comment("fb_c_001"))).data.changed).toBe(false);
    expect((await read.getCurrentState(fb, comment("fb_c_001"))).data.visibility).toBe("hidden");
    expect((await mutation.unhide(fb, comment("fb_c_001"))).data.changed).toBe(true);
    expect(world.interactionState("fb_c_001")?.visibility).toBe("visible");
  });

  it("delete removes at source (observable), and a second delete is not found", async () => {
    expect((await mutation.delete(fb, comment("fb_c_011"))).data).toMatchObject({ kind: "delete", changed: true });
    expect((await read.getCurrentState(fb, comment("fb_c_011"))).data.presence).toBe("removed_at_source");
    await expect(mutation.delete(fb, comment("fb_c_011"))).rejects.toBeInstanceOf(TargetNotFoundError);
  });

  it("block records the author as blocked in the account context only", async () => {
    const author = providerObjectRef("facebook", "author", "fb_user_04");
    expect((await mutation.block(fb, author)).data).toMatchObject({ kind: "block", changed: true, account: fb.account });
    expect((await read.getCurrentState(fb, author)).data.blocked).toBe(true);
    expect(world.isBlocked("fb_page_aurora", "fb_user_04")).toBe(true);
    expect((await mutation.block(fb, author)).data.changed).toBe(false);
    await expect(mutation.block(fb, providerObjectRef("facebook", "author", "fb_author_aurora"))).rejects.toBeInstanceOf(TargetNotEligibleError);
  });

  it("a simulated restriction refuses the operation as not eligible (a safety net, not a capability claim)", async () => {
    await expect(mutation.hide(fb, comment("fb_c_010"))).rejects.toMatchObject({ kind: "target_not_eligible", reason: "unsupported_for_target" });
    expect(world.interactionState("fb_c_010")?.visibility).toBe("visible");
  });

  it("an account without the simulated permission is refused before any target lookup", async () => {
    const limited = sim.access("cred_meta_main", "ig_acct_limited");
    await expect(mutation.hide(limited, providerObjectRef("instagram", "interaction", "ig_c_020"))).rejects.toMatchObject({ kind: "permission_missing", capability: "hide" });
  });
});

describe("ambiguity is preserved (R6)", () => {
  it("a reply that times out after sending EXISTS on the platform, yet the call reports OutcomeUnknown", async () => {
    world.applyFaultPreset("reply_timeout_after_send");
    const before = world.interactionCount();
    const error = await mutation.replyPublicly(fb, comment("fb_c_001"), "Respuesta ambigua", { key: "k" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeUnknownError);
    expect(isDefiniteFailure(error as OutcomeUnknownError)).toBe(false);
    expect(world.interactionCount()).toBe(before + 1);
    const created = world.interactions().filter((i) => i.parent === "fb_c_001" && i.text === "Respuesta ambigua");
    expect(created).toHaveLength(1);
    // Reconciliation (Step 9) can find it through the read port, so it must never be resent blindly.
    const found = (await read.getInteraction(fb, comment(created[0]?.id ?? "missing"))).data;
    expect(found).toMatchObject({ parent: comment("fb_c_001"), author: { role: "account_identity" } });
  });

  it("a hide that times out after sending is applied but unconfirmed", async () => {
    world.applyFaultPreset("hide_timeout_after_send");
    await expect(mutation.hide(fb, comment("fb_c_001"))).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(world.interactionState("fb_c_001")?.visibility).toBe("hidden");
  });

  it("a definite rejection applies nothing", async () => {
    world.applyFaultPreset("permanent_reply_rejection");
    const before = world.interactionCount();
    await expect(mutation.replyPublicly(fb, comment("fb_c_001"), "Hola", { key: "k" })).rejects.toMatchObject({ kind: "permanent_rejected", reasonCode: "content_policy" });
    expect(world.interactionCount()).toBe(before);
  });
});
