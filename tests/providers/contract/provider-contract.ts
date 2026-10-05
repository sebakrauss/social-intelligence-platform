/**
 * PROVIDER CONTRACT SUITE (TA §53, §54). One reusable suite every adapter must pass: the simulator now, real
 * Meta and TikTok adapters later (with recorded, sanitized fixtures). It asserts only what the contract
 * guarantees; simulator-specific behavior lives in tests/providers/simulator.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  MUTATION_OPERATIONS,
  PROVIDER_ERROR_KINDS,
  PROVIDER_NAMES,
  READ_OPERATIONS,
  ProviderError,
  SecretValue,
  WebhookRejectedError,
  isDefiniteFailure,
  providerObjectKey,
  type ContentDto,
  type InteractionDto,
  type Page,
  type PageCursor,
  type PaidContextItem,
  type ProviderResult,
  type WebhookParseResult,
} from "@/integrations/providers/contract";
import { expectBudget, expectContent, expectInteraction, expectNoSecrets, expectPaidItem, expectRaw, expectRef, expectResult } from "./assertions";
import type { ProviderContractHarness } from "./harness";

const DM_LIKE = /message|inbox|thread|conversation|\bdm\b|direct/i;

async function collectPages<T>(fetch: (cursor: PageCursor | null) => Promise<ProviderResult<Page<T>>>): Promise<{ readonly items: T[]; readonly pages: number }> {
  const items: T[] = [];
  let cursor: PageCursor | null = null;
  let pages = 0;
  for (;;) {
    const page: Page<T> = expectResult(await fetch(cursor));
    pages += 1;
    items.push(...page.items);
    if (page.next.kind === "end") return { items, pages };
    cursor = page.next.cursor;
    if (pages > 100) throw new Error("pagination did not terminate");
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

export function defineProviderContractSuite(makeHarness: () => ProviderContractHarness): void {
  const h = makeHarness();

  describe(`provider contract · ${h.name}`, () => {
    beforeEach(async () => {
      await h.reset();
    });

    const contentInteractions = (content = h.paginatedContent) =>
      collectPages((cursor) => h.read.listInteractions(h.contentAccess, { kind: "content", content }, h.window, cursor));

    describe("1 · read port shape", () => {
      it("implements every read operation and names a known provider", () => {
        expect(PROVIDER_NAMES).toContain(h.read.provider);
        expect(h.read.provider).toBe(h.provider);
        for (const operation of READ_OPERATIONS) expect(typeof h.read[operation]).toBe("function");
      });
    });

    describe("2 · normalized identity", () => {
      it("discovered assets carry valid, stable provider identities", async () => {
        const first = expectResult(await h.read.discoverAssets(h.discoveryCredential));
        const second = expectResult(await h.read.discoverAssets(h.discoveryCredential));
        expect(first.length).toBeGreaterThan(0);
        for (const asset of first) {
          expectRef(asset.ref, "asset");
          expect(["content_bearing", "ad_account"]).toContain(asset.assetClass);
          for (const related of asset.relatedAssets) expectRef(related, "asset");
          expectRaw(asset.rawReference, h.provider);
        }
        expect(second.map((a) => providerObjectKey(a.ref))).toEqual(first.map((a) => providerObjectKey(a.ref)));
      });

      it("describes the account it was asked about, with facts only", async () => {
        const account = expectResult(await h.read.describeAccount(h.contentAccess));
        expect(account.asset).toEqual(h.contentAccess.account);
        if (account.accountIdentity !== null) expectRef(account.accountIdentity, "author");
        expect(Array.isArray(account.grantedPermissions)).toBe(true);
        expectRaw(account.rawReference, h.provider);
      });

      it("re-fetching an interaction returns the same identity", async () => {
        const fetched = expectResult(await h.read.getInteraction(h.contentAccess, h.mutationTarget));
        expect(fetched.ref).toEqual(h.mutationTarget);
        expect(expectResult(await h.read.getInteraction(h.contentAccess, h.mutationTarget)).ref).toEqual(fetched.ref);
      });
    });

    describe("3 · timestamps and raw references", () => {
      it("content and interactions preserve provider timestamps and a raw reference", async () => {
        const contents = await collectPages((cursor) => h.read.listContent(h.contentAccess, h.window, cursor));
        expect(contents.items.length).toBeGreaterThan(0);
        for (const content of contents.items) expectContent(content, h.provider);
        const interactions = await contentInteractions();
        for (const interaction of interactions.items) {
          expectInteraction(interaction, h.provider);
          expect(interaction.timestamps.createdAt).not.toBeNull();
        }
      });
    });

    describe("4 · pagination", () => {
      it("walks every page of a multi-page listing without duplicates", async () => {
        const { items, pages } = await contentInteractions();
        expect(pages).toBeGreaterThanOrEqual(3);
        const keys = items.map((i) => providerObjectKey(i.ref));
        expect(new Set(keys).size).toBe(keys.length);
      });
    });

    describe("5 · stable cursors and terminal pages", () => {
      it("the same cursor returns the same page; the last page says end", async () => {
        const first = expectResult(await h.read.listInteractions(h.contentAccess, { kind: "content", content: h.paginatedContent }, h.window, null));
        expect(first.next.kind).toBe("more");
        if (first.next.kind !== "more") return;
        const a = expectResult(await h.read.listInteractions(h.contentAccess, { kind: "content", content: h.paginatedContent }, h.window, first.next.cursor));
        const b = expectResult(await h.read.listInteractions(h.contentAccess, { kind: "content", content: h.paginatedContent }, h.window, first.next.cursor));
        expect(b.items.map((i) => i.ref)).toEqual(a.items.map((i) => i.ref));
      });

      it("an empty listing is an explicit end, never an inferred one", async () => {
        const page = expectResult(await h.read.listInteractions(h.contentAccess, { kind: "content", content: h.emptyContent }, h.window, null));
        expect(page.items).toEqual([]);
        expect(page.next).toEqual({ kind: "end" });
      });

      it("a cursor from another scope is rejected, never reinterpreted", async () => {
        const first = expectResult(await h.read.listInteractions(h.contentAccess, { kind: "content", content: h.paginatedContent }, h.window, null));
        if (first.next.kind !== "more") throw new Error("expected more pages");
        const error = await rejection(h.read.listContent(h.contentAccess, h.window, first.next.cursor));
        expect(error).toBeInstanceOf(ProviderError);
        expect((error as ProviderError).kind).toBe("permanent_rejected");
      });
    });

    describe("6 · content → interaction relationships", () => {
      it("interactions belong to their content; replies point to a parent in the same content", async () => {
        const { items } = await contentInteractions();
        const keys = new Set(items.map((i) => providerObjectKey(i.ref)));
        for (const interaction of items) {
          expect(interaction.content).toEqual(h.paginatedContent);
          if (interaction.parent !== null) expect(keys.has(providerObjectKey(interaction.parent))).toBe(true);
        }
        expect(items.some((i) => i.interactionKind === "comment")).toBe(true);
      });
    });

    describe("7 · paid-context relationships", () => {
      it("ads point to the content they distribute; shared content is not duplicated", async () => {
        const { items } = await collectPages((cursor) => h.read.retrievePaidContext(h.adAccess, h.window, cursor));
        for (const item of items) {
          expectPaidItem(item, h.provider);
          expect(item.adAccount).toEqual(h.adAccess.account);
        }
        const ads = items.filter((i): i is Extract<PaidContextItem, { type: "ad" }> => i.type === "ad");
        const sharing = ads.filter((ad) => ad.content !== null && providerObjectKey(ad.content) === providerObjectKey(h.sharedContent));
        expect(sharing.length).toBeGreaterThanOrEqual(2);
        // Interactions attach to the content only: listing them once yields each exactly once.
        const interactions = await contentInteractions(h.sharedContent);
        const keys = interactions.items.map((i: InteractionDto) => providerObjectKey(i.ref));
        expect(new Set(keys).size).toBe(keys.length);
        for (const interaction of interactions.items) expect(Object.keys(interaction)).not.toContain("ad");
      });
    });

    describe("8 · error normalization", () => {
      it("covers every normalized error kind", () => {
        expect(new Set(h.errorCases.map((c) => c.kind))).toEqual(new Set(PROVIDER_ERROR_KINDS));
      });

      for (const errorCase of h.errorCases) {
        it(`${errorCase.kind}: ${errorCase.name}`, async () => {
          const error = await rejection(errorCase.invoke());
          expect(error).toBeInstanceOf(ProviderError);
          const providerError = error as ProviderError;
          expect(providerError.kind).toBe(errorCase.kind);
          expect(providerError.message).toBe(`provider_${errorCase.kind}`);
          const serialized = providerError.toJSON();
          expect(Object.keys(serialized).sort()).toEqual(["details", "kind", "operation", "retry"]);
          for (const value of Object.values(serialized.details)) expect(value === null || ["string", "number"].includes(typeof value)).toBe(true);
          expectNoSecrets(providerError, h.secrets);
          if (providerError.kind === "rate_limited") expect("retryAfterSeconds" in serialized.details).toBe(true);
        });
      }
    });

    describe("9 · rate-budget signal normalization", () => {
      it("every call reports a well-formed budget signal", async () => {
        expectBudget((await h.read.describeAccount(h.contentAccess)).budget);
        expectBudget((await h.read.listContent(h.contentAccess, h.window, null)).budget);
        expectBudget((await h.read.getCurrentState(h.contentAccess, h.mutationTarget)).budget);
        expectBudget((await h.mutation.hide(h.contentAccess, h.mutationTarget)).budget);
      });
    });

    describe("10 · webhook parsing and verification", () => {
      const parse = (request: ReturnType<typeof h.webhooks.valid>): Promise<WebhookParseResult> => h.read.parseWebhook(request);
      const rejectedWith = async (request: ReturnType<typeof h.webhooks.valid>, reason: WebhookRejectedError["reason"]) => {
        const error = await rejection(parse(request));
        expect(error).toBeInstanceOf(WebhookRejectedError);
        expect((error as WebhookRejectedError).reason).toBe(reason);
      };

      it("accepts a valid signed delivery as identifier-only hints", async () => {
        const result = await parse(h.webhooks.valid());
        expect(result.hints.length).toBeGreaterThan(0);
        for (const hint of result.hints) {
          expect(Object.keys(hint).sort()).toEqual(["account", "change", "content", "deliveryId", "eventId", "occurredAt", "sequence", "target"]);
          expectRef(hint.account, "asset");
          expect(["content", "interaction"]).toContain(hint.target.kind);
        }
      });

      it("rejects a tampered signature", () => rejectedWith(h.webhooks.tampered(), "invalid_signature"));
      it("rejects an unsigned delivery", () => rejectedWith(h.webhooks.unsigned(), "missing_signature"));
      it("rejects a delivery outside the replay tolerance", () => rejectedWith(h.webhooks.stale(), "stale_timestamp"));
      it("rejects a malformed envelope", () => rejectedWith(h.webhooks.malformed(), "malformed_payload"));

      it("keeps duplicate deliveries identifiable", async () => {
        const request = h.webhooks.valid();
        const [a, b] = [await parse(request), await parse(request)];
        expect(b.deliveryId).toBe(a.deliveryId);
        expect(b.hints.map((x) => x.eventId)).toEqual(a.hints.map((x) => x.eventId));
      });

      it("keeps out-of-order deliveries identifiable by provider time", async () => {
        const [late, early] = h.webhooks.outOfOrder();
        const lateHint = (await parse(late)).hints[0];
        const earlyHint = (await parse(early)).hints[0];
        expect(lateHint?.target).toEqual(earlyHint?.target);
        expect(lateHint?.occurredAt).not.toBeNull();
        expect(earlyHint?.occurredAt).not.toBeNull();
        expect(String(lateHint?.occurredAt) > String(earlyHint?.occurredAt)).toBe(true);
      });

      it("counts unknown event types and never turns them into hints", async () => {
        const result = await parse(h.webhooks.withUnknownEvent());
        expect(result.ignoredEventCount).toBeGreaterThan(0);
        expect(result.hints.length).toBeGreaterThan(0);
      });
    });

    describe("11 · subscription lifecycle", () => {
      it("subscribe / unsubscribe are idempotent and report changes", async () => {
        const on = expectResult(await h.read.subscribe(h.subscribable));
        expect(on.state).toBe("subscribed");
        expect(expectResult(await h.read.subscribe(h.subscribable)).changed).toBe(false);
        const off = expectResult(await h.read.unsubscribe(h.subscribable));
        expect(off).toMatchObject({ state: "unsubscribed", changed: true });
        expect(expectResult(await h.read.unsubscribe(h.subscribable)).changed).toBe(false);
      });
    });

    describe("12 · credential refresh result shape", () => {
      it("returns a closed status; a refreshed credential keeps its secret wrapped", async () => {
        const result = expectResult(await h.read.refreshCredential(h.refreshable));
        expect(["refreshed", "not_needed", "not_supported"]).toContain(result.status);
        if (result.status === "refreshed") {
          expect(result.credential.secret).toBeInstanceOf(SecretValue);
          expect(JSON.stringify(result)).toContain("[redacted]");
        }
        expectNoSecrets(result, h.secrets);
      });
    });

    describe("13 · mutation port result shape", () => {
      it("implements every mutation operation", () => {
        expect(PROVIDER_NAMES).toContain(h.mutation.provider);
        for (const operation of MUTATION_OPERATIONS) expect(typeof h.mutation[operation]).toBe("function");
      });

      it("public reply returns a receipt for the target (and the created reply when known)", async () => {
        const receipt = expectResult(await h.mutation.replyPublicly(h.contentAccess, h.mutationTarget, "Gracias por escribirnos (test)", { key: "contract-public-1" }));
        expect(receipt.kind).toBe("public_reply");
        expect(receipt.target).toEqual(h.mutationTarget);
        if (receipt.createdInteraction !== null) expectRef(receipt.createdInteraction, "interaction");
      });

      it("hide / unhide / delete return state-change receipts", async () => {
        const hidden = expectResult(await h.mutation.hide(h.contentAccess, h.mutationTarget));
        expect(hidden).toMatchObject({ kind: "hide", target: h.mutationTarget });
        const visible = expectResult(await h.mutation.unhide(h.contentAccess, h.mutationTarget));
        expect(visible).toMatchObject({ kind: "unhide", target: h.mutationTarget });
        const deleted = expectResult(await h.mutation.delete(h.contentAccess, h.mutationTarget));
        expect(deleted).toMatchObject({ kind: "delete", target: h.mutationTarget });
      });

      it("block returns a receipt in the account context", async () => {
        const receipt = expectResult(await h.mutation.block(h.contentAccess, h.blockableAuthor));
        expect(receipt).toMatchObject({ kind: "block", author: h.blockableAuthor, account: h.contentAccess.account });
      });
    });

    describe("14 · OutcomeUnknown preservation", () => {
      it("an ambiguous mutation stays ambiguous: never a definite failure", async () => {
        const unknownCase = h.errorCases.find((c) => c.kind === "outcome_unknown");
        if (unknownCase === undefined) throw new Error("missing outcome_unknown case");
        const error = (await rejection(unknownCase.invoke())) as ProviderError;
        expect(error.kind).toBe("outcome_unknown");
        expect(error.retry).toBe("verify_first");
        expect(isDefiniteFailure(error)).toBe(false);
        for (const other of h.errorCases.filter((c) => c.kind !== "outcome_unknown")) expect(other.kind).not.toBe("outcome_unknown");
      });
    });

    describe("15 · no direct-message read surface", () => {
      it("no port operation reads, lists or subscribes to private messages", () => {
        const operations = [...Object.keys(h.read), ...Object.keys(h.mutation)].filter((k) => k !== "provider");
        expect(operations.filter((name) => DM_LIKE.test(name))).toEqual([]);
        expect([...READ_OPERATIONS].filter((name) => DM_LIKE.test(name))).toEqual([]);
      });

      it("a private reply returns a one-shot receipt: no interaction, thread or conversation", async () => {
        const receipt = expectResult(await h.mutation.replyPrivately(h.contentAccess, h.mutationTarget, "Te escribimos por privado (test)", { key: "contract-private-1" }));
        expect(receipt.kind).toBe("private_reply");
        expect(Object.keys(receipt).sort()).toEqual(["confirmedAt", "kind", "providerReceiptId", "rawReference", "target"]);
        // Nothing new appears among the account's public interactions.
        const after = await contentInteractions(h.paginatedContent);
        for (const interaction of after.items as readonly InteractionDto[]) expect(interaction.text).not.toBe("Te escribimos por privado (test)");
        const contents: readonly ContentDto[] = (await collectPages((cursor) => h.read.listContent(h.contentAccess, h.window, cursor))).items;
        expect(contents.length).toBeGreaterThan(0);
      });
    });
  });
}
