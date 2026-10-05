/**
 * Golden fixtures (TA §53): fixture input → simulator → normalized DTO → small, reviewed, stably serialized
 * files under fixtures/providers/golden. A diff in review makes any semantic change of the normalized output
 * visible. Regenerate locally with UPDATE_GOLDEN=1 and review the diff; CI never regenerates.
 */
import { beforeEach, describe, it } from "vitest";
import { ProviderError, providerObjectRef, type PageCursor, type Page, type ProviderResult } from "@/integrations/providers/contract";
import { expectGolden } from "./support/fixtures";
import { FULL_WINDOW, createBaselineSimulator, signedFixture, simulatorContractHarness } from "./support/simulator-harness";

const sim = createBaselineSimulator();
const { world, read, mutation } = sim;
const fb = sim.access("cred_meta_main", "fb_page_aurora");

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

beforeEach(() => {
  world.reset();
});

describe("golden normalized output (simulator, baseline scenario)", () => {
  it("discovered assets", async () => {
    expectGolden("discover-assets", (await read.discoverAssets(world.credential("cred_meta_main"))).data);
  });

  it("account description", async () => {
    expectGolden("account-description", (await read.describeAccount(fb)).data);
  });

  it("content listing with organic, mixed and paid sources", async () => {
    expectGolden("content-facebook", await all((cursor) => read.listContent(fb, FULL_WINDOW, cursor)));
  });

  it("an organic post's thread: comments, nested replies, brand reply, edit, native hide, tombstone excluded", async () => {
    const content = providerObjectRef("facebook", "content", "fb_post_organic_01");
    expectGolden("interactions-organic-post", await all((cursor) => read.listInteractions(fb, { kind: "content", content }, FULL_WINDOW, cursor)));
  });

  it("paid context: hierarchy, cross-platform content link, unexposed link", async () => {
    expectGolden("paid-context-meta", await all((cursor) => read.retrievePaidContext(sim.access("cred_meta_main", "act_meta_100"), FULL_WINDOW, cursor)));
  });

  it("current-state observations: present, hidden, removed, not returned", async () => {
    const at = (id: string) => providerObjectRef("facebook", "interaction", id);
    const observations = [];
    for (const id of ["fb_c_001", "fb_c_006", "fb_c_007", "fb_c_008"]) observations.push((await read.getCurrentState(fb, at(id))).data);
    expectGolden("state-observations", observations);
  });

  it("webhook batch with an unknown event", async () => {
    expectGolden("webhook-batch", await read.parseWebhook(signedFixture("batch_with_unknown")));
  });

  it("mutation receipts", async () => {
    const target = providerObjectRef("facebook", "interaction", "fb_c_001");
    expectGolden("mutation-receipts", [
      await mutation.replyPublicly(fb, target, "¡Gracias por escribirnos!", { key: "golden-1" }),
      await mutation.replyPrivately(fb, target, "Te escribimos por privado.", { key: "golden-2" }),
      await mutation.hide(fb, target),
      await mutation.unhide(fb, target),
      await mutation.block(fb, providerObjectRef("facebook", "author", "fb_user_04")),
    ]);
  });

  it("normalized errors", async () => {
    const harness = simulatorContractHarness();
    const serialized = [];
    for (const errorCase of harness.errorCases) {
      await harness.reset();
      const error = await errorCase.invoke().then(() => undefined, (e: unknown) => e);
      serialized.push({ case: errorCase.name, error: error instanceof ProviderError ? error.toJSON() : "unexpected" });
    }
    expectGolden("errors", serialized);
  });
});
