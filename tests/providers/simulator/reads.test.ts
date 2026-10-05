/**
 * Simulator READ behavior on the baseline scenario: source dimensions, paid context, re-fetch, current state
 * vs absence, edits, native brand replies, removal semantics. Simulated behavior only; none of this claims
 * what a real platform supports (PD OQ-18, OQ-19 stay VALIDATE).
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  TargetNotFoundError,
  providerObjectKey,
  providerObjectRef,
  type ContentDto,
  type InteractionDto,
  type Page,
  type PageCursor,
  type PaidContextItem,
  type ProviderResult,
} from "@/integrations/providers/contract";
import { FULL_WINDOW, createBaselineSimulator } from "../support/simulator-harness";

const sim = createBaselineSimulator();
const { world, read } = sim;
const fb = sim.access("cred_meta_main", "fb_page_aurora");
const ig = sim.access("cred_meta_main", "ig_acct_aurora");
const tt = sim.access("cred_tiktok_main", "tt_acct_aurora");
const fbRef = <K extends "content" | "interaction" | "author">(kind: K, id: string) => providerObjectRef("facebook", kind, id);

async function all<T>(fetch: (cursor: PageCursor | null) => Promise<ProviderResult<Page<T>>>): Promise<T[]> {
  const items: T[] = [];
  let cursor: PageCursor | null = null;
  for (;;) {
    const page: Page<T> = (await fetch(cursor)).data;
    items.push(...page.items);
    if (page.next.kind === "end") return items;
    cursor = page.next.cursor;
  }
}

const contentOf = async (access: typeof fb): Promise<ContentDto[]> => all((cursor) => read.listContent(access, FULL_WINDOW, cursor));
const interactionsOf = async (access: typeof fb, content: string): Promise<InteractionDto[]> =>
  all((cursor) => read.listInteractions(access, { kind: "content", content: providerObjectRef(access.account.platform, "content", content) }, FULL_WINDOW, cursor));

beforeEach(() => {
  world.reset();
});

describe("source dimensions (PD C-05)", () => {
  it("represents organic, paid, mixed and unknown as reported, without inventing precision", async () => {
    const sources = new Map([...(await contentOf(fb)), ...(await contentOf(ig)), ...(await contentOf(tt))].map((c): [string, string] => [c.ref.id, c.reportedSource]));
    expect(sources.get("fb_post_organic_01")).toBe("organic");
    expect(sources.get("ig_ad_only_10")).toBe("paid");
    expect(sources.get("fb_post_boosted_02")).toBe("mixed");
    expect(sources.get("ig_post_unknown_11")).toBe("unknown");
  });

  it("paid-only content is content too (an ad creative), with its own interactions", async () => {
    const ad = (await contentOf(ig)).find((c) => c.ref.id === "ig_ad_only_10");
    expect(ad).toMatchObject({ contentKind: "ad_creative", reportedSource: "paid" });
    expect((await interactionsOf(ig, "ig_ad_only_10")).map((i) => i.ref.id).sort()).toEqual(["ig_c_001", "ig_c_002", "ig_c_003"]);
  });
});

describe("paid context (Model §9)", () => {
  it("one content item can be distributed by several ads without duplicating its interactions", async () => {
    const items: PaidContextItem[] = await all((cursor) => read.retrievePaidContext(sim.access("cred_tiktok_main", "tt_adv_200"), FULL_WINDOW, cursor));
    const ads = items.filter((i) => i.type === "ad");
    expect(ads.filter((ad) => ad.content?.id === "tt_video_multi_20").map((ad) => ad.ref.id).sort()).toEqual(["ad_tt_01", "ad_tt_02"]);
    const interactions = await interactionsOf(tt, "tt_video_multi_20");
    const keys = interactions.map((i) => providerObjectKey(i.ref));
    expect(keys.length).toBe(9);
    expect(new Set(keys).size).toBe(9);
  });

  it("keeps the campaign → ad group → ad hierarchy, cross-platform content links and unknown links honest", async () => {
    const items: PaidContextItem[] = await all((cursor) => read.retrievePaidContext(sim.access("cred_meta_main", "act_meta_100"), FULL_WINDOW, cursor));
    expect(items.map((i) => i.type)).toEqual(["campaign", "ad_group", "ad", "ad", "ad"]);
    const byId = new Map(items.map((i): [string, (typeof items)[number]] => [i.ref.id, i]));
    const boost = byId.get("ad_meta_01");
    const igAd = byId.get("ad_meta_02");
    const unlinked = byId.get("ad_meta_03");
    expect(boost?.type === "ad" ? boost.content : undefined).toEqual(fbRef("content", "fb_post_boosted_02"));
    expect(igAd?.type === "ad" ? igAd.content : undefined).toEqual(providerObjectRef("instagram", "content", "ig_ad_only_10"));
    expect(unlinked?.type === "ad" ? unlinked.content : "missing").toBeNull();
  });
});

describe("threads, brand replies and edits", () => {
  it("comments and replies are interactions; nested audience replies keep their parent", async () => {
    const items = await interactionsOf(fb, "fb_post_organic_01");
    const byId = new Map(items.map((i): [string, (typeof items)[number]] => [i.ref.id, i]));
    expect(byId.get("fb_c_001")).toMatchObject({ interactionKind: "comment", parent: null });
    expect(byId.get("fb_c_002")?.parent).toEqual(fbRef("interaction", "fb_c_001"));
    expect(byId.get("fb_c_003")).toMatchObject({ interactionKind: "reply", parent: fbRef("interaction", "fb_c_002") });
    expect(byId.get("fb_c_003")?.author.role).toBe("user");
  });

  it("a native brand reply is observable as an account-identity author", async () => {
    const account = (await read.describeAccount(fb)).data;
    const brandReply = (await read.getInteraction(fb, fbRef("interaction", "fb_c_002"))).data;
    expect(brandReply.author.role).toBe("account_identity");
    expect(brandReply.author.ref).toEqual(account.accountIdentity);
    const created = world.nativeBrandReply("fb_c_005", "¡Hola! Vuelve el lunes (sintético).");
    const fetched = (await read.getInteraction(fb, fbRef("interaction", created))).data;
    expect(fetched).toMatchObject({ interactionKind: "reply", parent: fbRef("interaction", "fb_c_005"), author: { role: "account_identity" } });
  });

  it("an edit keeps the identity and shows a new revision; a re-fetch returns the authoritative text", async () => {
    const before = (await read.getInteraction(fb, fbRef("interaction", "fb_c_001"))).data;
    world.advanceClock(60);
    world.editInteraction("fb_c_001", "¿Cuánto sale el envío a Valparaíso y a Viña?");
    const after = (await read.getInteraction(fb, fbRef("interaction", "fb_c_001"))).data;
    expect(after.ref).toEqual(before.ref);
    expect(after.timestamps.createdAt).toBe(before.timestamps.createdAt);
    expect(after.textRevision).not.toBe(before.textRevision);
    expect(after.editedAt).toBe("2026-09-15T12:01:00.000Z");
    expect(after.text).toBe("¿Cuánto sale el envío a Valparaíso y a Viña?");
    expect(after.rawReference.ref).not.toBe(before.rawReference.ref);
    // The fixture also carries an already-edited comment.
    expect((await read.getInteraction(fb, fbRef("interaction", "fb_c_004"))).data).toMatchObject({ textRevision: "r2", editedAt: "2026-09-11T08:00:00.000Z" });
  });
});

describe("state observations: removal is a signal, absence is not deletion", () => {
  it("a signaled removal is observable as removed_at_source (tombstone, no text)", async () => {
    const tombstone = (await read.getInteraction(fb, fbRef("interaction", "fb_c_007"))).data;
    expect(tombstone).toMatchObject({ availability: "removed_at_source", text: null });
    expect((await read.getCurrentState(fb, fbRef("interaction", "fb_c_007"))).data).toMatchObject({ presence: "removed_at_source", basis: "provider_signal" });
  });

  it("an object the provider simply doesn't return is not_returned, never 'deleted'", async () => {
    await expect(read.getInteraction(fb, fbRef("interaction", "fb_c_008"))).rejects.toBeInstanceOf(TargetNotFoundError);
    expect((await read.getCurrentState(fb, fbRef("interaction", "fb_c_008"))).data).toMatchObject({ presence: "not_returned", basis: "direct_fetch" });
  });

  it("deletion between a listing and the re-fetch is observed, not inferred", async () => {
    const listed = (await interactionsOf(fb, "fb_post_organic_01")).map((i) => i.ref.id);
    expect(listed).toContain("fb_c_005");
    world.removeAtSource("fb_c_005", { signaled: true });
    expect((await read.getInteraction(fb, fbRef("interaction", "fb_c_005"))).data.availability).toBe("removed_at_source");
    expect((await interactionsOf(fb, "fb_post_organic_01")).map((i) => i.ref.id)).not.toContain("fb_c_005");
  });

  it("current state is distinct from a failed call: a failure is an error, never an observation", async () => {
    world.injectFaults([{ operation: "getCurrentState", on: 1, fault: { kind: "transient", reason: "network" } }]);
    await expect(read.getCurrentState(fb, fbRef("interaction", "fb_c_001"))).rejects.toMatchObject({ kind: "transient" });
    expect((await read.getCurrentState(fb, fbRef("interaction", "fb_c_001"))).data).toMatchObject({ presence: "present", visibility: "visible" });
  });

  it("a native hide is observable on list, re-fetch and current state", async () => {
    expect((await read.getInteraction(fb, fbRef("interaction", "fb_c_006"))).data.visibility).toBe("hidden");
    world.nativeUnhide("fb_c_006");
    expect((await read.getCurrentState(fb, fbRef("interaction", "fb_c_006"))).data.visibility).toBe("visible");
    world.nativeHide("fb_c_006");
    expect((await interactionsOf(fb, "fb_post_organic_01")).find((i) => i.ref.id === "fb_c_006")?.visibility).toBe("hidden");
  });

  it("removed content is a tombstone on re-fetch and is not listed", async () => {
    expect((await read.getContent(tt, providerObjectRef("tiktok", "content", "tt_video_removed_21"))).data).toMatchObject({ availability: "removed_at_source", caption: null });
    expect((await contentOf(tt)).map((c) => c.ref.id)).not.toContain("tt_video_removed_21");
  });
});

describe("timestamps, raw references and identity stability", () => {
  it("DTOs preserve provider timestamps and simulator raw references (never a real API version)", async () => {
    const content = (await read.getContent(fb, fbRef("content", "fb_post_organic_01"))).data;
    expect(content.publishedAt).toBe("2026-09-10T15:00:00.000Z");
    expect(content.rawReference).toEqual({ provider: "simulator", apiVersion: "simulator-v1", ref: "sim://baseline/content/fb_post_organic_01" });
    const interaction = (await read.getInteraction(fb, fbRef("interaction", "fb_c_001"))).data;
    expect(interaction.timestamps.createdAt).toBe("2026-09-10T16:00:00.000Z");
    expect(interaction.rawReference.ref).toBe("sim://baseline/interaction/fb_c_001@r1");
  });

  it("identities are stable across listing, re-fetch and reset", async () => {
    const listed = (await interactionsOf(fb, "fb_post_organic_01")).map((i) => providerObjectKey(i.ref));
    world.reset();
    expect((await interactionsOf(fb, "fb_post_organic_01")).map((i) => providerObjectKey(i.ref))).toEqual(listed);
    expect(listed).toContain("facebook:interaction:fb_c_001");
  });

  it("orders listings newest first with a stable id tiebreak", async () => {
    const ids = (await interactionsOf(tt, "tt_video_multi_20")).map((i) => i.ref.id);
    expect(ids).toEqual(["tt_c_009", "tt_c_008", "tt_c_007", "tt_c_006", "tt_c_005", "tt_c_004", "tt_c_003", "tt_c_002", "tt_c_001"]);
  });
});
