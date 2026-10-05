/**
 * Simulated webhooks: platform events → signed deliveries → identifier-only hints. Parsing is fail-closed and
 * stateless; nothing it returns is authoritative, and it never changes simulated (or product) state.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { WebhookRejectedError, isoInstant, providerObjectRef } from "@/integrations/providers/contract";
import { SIM_DELIVERY_HEADER, signSimulatorDelivery, signedDeliveryOf } from "@/integrations/providers/simulator";
import { stableSerialize } from "../support/fixtures";
import { SIM_SIGNING_KEY, createBaselineSimulator, signedFixture } from "../support/simulator-harness";

const sim = createBaselineSimulator();
const { world, read, mutation } = sim;
const fb = sim.access("cred_meta_main", "fb_page_aurora");

beforeEach(() => {
  world.reset();
});

describe("native platform activity becomes webhook hints", () => {
  it("audience comments, native brand replies, edits, hides and removals produce one hint each", async () => {
    const comment = world.audienceComment("fb_post_organic_01", "fb_user_03", "¿Abren el domingo?");
    world.advanceClock(30);
    world.nativeBrandReply(comment, "¡Sí, de 9 a 14! (sintético)");
    world.advanceClock(30);
    world.editInteraction(comment, "¿Abren el domingo y el lunes feriado?");
    world.nativeHide("fb_c_005");
    world.removeAtSource("fb_c_011", { signaled: true });
    world.removeAtSource("fb_c_010", { signaled: false });

    const result = await read.parseWebhook(signedDeliveryOf(SIM_SIGNING_KEY, "dlv-native-1", world.events, world.now()));
    expect(result.hints.map((h) => [h.target.id, h.change])).toEqual([
      [comment, "created"],
      [expect.stringMatching(/^sim-facebook-int-/), "created"],
      [comment, "edited"],
      ["fb_c_005", "hidden"],
      ["fb_c_011", "removed"],
    ]);
    // A removal the provider doesn't announce produces no hint at all (absence isn't an event).
    expect(result.hints.some((h) => h.target.id === "fb_c_010")).toBe(false);
  });

  it("hints carry identifiers only: no text, names or handles", async () => {
    world.audienceComment("fb_post_organic_01", "fb_user_01", "Texto que no debe viajar en la pista");
    const result = await read.parseWebhook(signedDeliveryOf(SIM_SIGNING_KEY, "dlv-text-1", world.events, world.now()));
    const serialized = stableSerialize(result);
    expect(serialized).not.toContain("Texto que no debe viajar");
    expect(serialized).not.toContain("Camila");
    expect(serialized).not.toContain("sim_camila_cl");
  });

  it("our own mutations are announced like any platform change (to be reconciled, not trusted)", async () => {
    await mutation.hide(fb, providerObjectRef("facebook", "interaction", "fb_c_001"));
    const hints = (await read.parseWebhook(signedDeliveryOf(SIM_SIGNING_KEY, "dlv-own-1", world.events, world.now()))).hints;
    expect(hints).toMatchObject([{ change: "hidden", target: { id: "fb_c_001" } }]);
  });
});

describe("duplicates, ordering and unknown events", () => {
  it("a duplicate delivery parses to the same delivery and event identities", async () => {
    const request = signedFixture("batch_with_unknown");
    const first = await read.parseWebhook(request);
    const again = await read.parseWebhook(request);
    expect(stableSerialize(again)).toBe(stableSerialize(first));
    expect(first.hints.map((h) => h.eventId)).toEqual(["evt-0002", "evt-0004"]);
  });

  it("out-of-order deliveries keep their provider time and sequence", async () => {
    const late = (await read.parseWebhook(signedFixture("edit_late"))).hints[0];
    const early = (await read.parseWebhook(signedFixture("create_early"))).hints[0];
    expect(late).toMatchObject({ change: "edited", occurredAt: "2026-09-11T08:00:00.000Z", sequence: "205" });
    expect(early).toMatchObject({ change: "created", occurredAt: "2026-09-10T18:00:00.000Z", sequence: "104" });
  });

  it("an unknown event type (e.g. a message event) is counted and never processed", async () => {
    const result = await read.parseWebhook(signedFixture("batch_with_unknown"));
    expect(result.ignoredEventCount).toBe(1);
    expect(result.hints.map((h) => h.eventId)).not.toContain("evt-0003");
  });
});

describe("fail closed", () => {
  const reason = async (request: Parameters<typeof read.parseWebhook>[0]) => {
    const error = await read.parseWebhook(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebhookRejectedError);
    return (error as WebhookRejectedError).reason;
  };

  it("rejects a delivery signed with another key", async () => {
    const at = isoInstant(new Date("2026-09-15T12:00:00.000Z"));
    const forged = signSimulatorDelivery("some-other-key", JSON.stringify({ deliveryId: "dlv-x", events: [] }), { sentAt: at, deliveryId: "dlv-x" });
    expect(await reason(forged)).toBe("invalid_signature");
  });

  it("rejects an invalid event inside a valid envelope as a whole", async () => {
    expect(await reason(signedFixture("invalid_platform"))).toBe("malformed_payload");
  });

  it("rejects a delivery whose header delivery id doesn't match the body", async () => {
    const request = signedFixture("single_created");
    expect(await reason({ ...request, headers: { ...request.headers, [SIM_DELIVERY_HEADER]: "dlv-other" } })).toBe("malformed_payload");
  });

  it("parsing never changes simulated state, and rejections are journaled without content", async () => {
    const before = stableSerialize(world.interactions());
    await read.parseWebhook(signedFixture("batch_with_unknown"));
    await read.parseWebhook({ ...signedFixture("single_created"), rawBody: "{}" }).catch(() => undefined);
    expect(stableSerialize(world.interactions())).toBe(before);
    expect(world.journal.map((e) => e.outcome)).toEqual(["ok", "rejected_invalid_signature"]);
  });
});
