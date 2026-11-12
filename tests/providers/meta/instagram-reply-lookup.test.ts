/**
 * Step 7B-14I2 — the Instagram OWN-reply lookup over the REAL Graph read transport on a fake fetch: GET only, the fixed
 * reconciliation whitelist, bounded cursor paging, and a closed, fail-closed classification (unique_match / none /
 * ambiguous / incomplete). A failed or unfinished read never becomes a match or an absence; nothing but a reply id leaves.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { providerCredential, type ProviderObjectId } from "@/integrations/providers/contract";
import { META_INSTAGRAM_RECONCILIATION_REPLY_FIELDS, createMetaGraphTransport, type MetaGraphFetch } from "@/integrations/providers/meta/graph-transport";
import { META_INSTAGRAM_REPLY_LOOKUP_MAX_PAGES, createInstagramReplyLookup } from "@/integrations/providers/meta/instagram-reply-lookup";

const IG = "17841400000000001" as ProviderObjectId;
const COMMENT = "17900000000000001" as ProviderObjectId;
const OTHER_COMMENT = "17900000000000002";
const TOKEN = "synthetic-lookup-user-token-marker";
const TEXT = "Gracias por escribirnos (7B-14I2).";
const MANAGED = "synthetic_managed";
const since = new Date("2026-11-12T15:00:00.000Z");
const at = (offsetSeconds: number) => new Date(since.getTime() + offsetSeconds * 1000).toISOString().replace(".000Z", "+0000");

interface Reply { readonly id: string; readonly from?: { readonly id: string; readonly username?: string }; readonly text?: string; readonly timestamp?: string; readonly parent_id?: string | undefined }
const ours = (over: Partial<Reply> = {}): Reply => ({ id: "17999000000000001", from: { id: IG, username: MANAGED }, text: TEXT, timestamp: at(5), parent_id: COMMENT, ...over });

/** A Graph world: the account node and a sequence of reply pages (cursor-linked); every request recorded. */
function world(pages: readonly (readonly Reply[] | { readonly status: number; readonly body: unknown })[], options: { readonly accountStatus?: number; readonly endless?: boolean } = {}) {
  const calls: { readonly method: string; readonly path: string; readonly fields: string | null; readonly after: string | null; readonly body: boolean }[] = [];
  const json = (status: number, body: unknown): Promise<Response> => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  const fetch: MetaGraphFetch = (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname.split("/").slice(2).join("/");
    calls.push({ method: init.method ?? "GET", path, fields: parsed.searchParams.get("fields"), after: parsed.searchParams.get("after"), body: init.body !== undefined && init.body !== null });
    if (path === IG) return options.accountStatus === undefined ? json(200, { id: IG, username: MANAGED }) : json(options.accountStatus, { error: { code: 190, message: "synthetic" } });
    if (path === `${COMMENT}/replies`) {
      const index = Number(parsed.searchParams.get("after")?.replace("cur", "") ?? "0");
      const page = pages[Math.min(index, pages.length - 1)];
      if (page === undefined) return json(500, {});
      if (!Array.isArray(page)) return json((page as { status: number }).status, (page as { body: unknown }).body);
      const more = options.endless === true || index + 1 < pages.length;
      return json(200, { data: page, ...(more ? { paging: { cursors: { after: `cur${String(index + 1)}` }, next: "https://graph.facebook.com/next" } } : {}) });
    }
    return json(400, { error: { code: 100, message: "unexpected" } });
  };
  return { calls, lookup: createInstagramReplyLookup({ transport: createMetaGraphTransport({ fetch }) }) };
}
const find = (w: ReturnType<typeof world>) => w.lookup.find(providerCredential("cred-synthetic", TOKEN), { instagramAccountId: IG, commentId: COMMENT }, TEXT, since);

describe("7B-14I2: Instagram own-reply lookup", () => {
  it("ONE reply of ours (managed author, exact parent, exact text, after the attempt) → unique_match; GETs only, the fixed whitelist", async () => {
    const w = world([[ours(), { id: "17999000000000002", from: { id: "17841400000000999", username: "someone" }, text: "otro texto", timestamp: at(1), parent_id: COMMENT }]]);
    expect(await find(w)).toEqual({ kind: "unique_match", replyId: "17999000000000001" });
    expect(w.calls.map((call) => [call.method, call.path, call.body])).toEqual([["GET", IG, false], ["GET", `${COMMENT}/replies`, false]]);
    expect(w.calls[1]?.fields).toBe(META_INSTAGRAM_RECONCILIATION_REPLY_FIELDS);
  });

  it("pages through the cursor to the end; a match on a later page counts", async () => {
    const w = world([[], [], [ours()]]);
    expect(await find(w)).toEqual({ kind: "unique_match", replyId: "17999000000000001" });
    expect(w.calls.filter((call) => call.path.endsWith("/replies")).map((call) => call.after)).toEqual([null, "cur1", "cur2"]);
  });

  it("a complete listing with nothing of ours → none (also: same text by someone provably else, an older identical reply)", async () => {
    expect(await find(world([[]]))).toEqual({ kind: "none" });
    expect(await find(world([[ours({ from: { id: "17841400000000999", username: "someone_else" } })]]))).toEqual({ kind: "none" });
    expect(await find(world([[ours({ timestamp: at(-3600) })]]))).toEqual({ kind: "none" });
    expect(await find(world([[ours({ text: "Otro texto" })]]))).toEqual({ kind: "none" });
  });

  it.each([
    ["two of ours", [[ours(), ours({ id: "17999000000000003" })]]],
    ["our text by an unattributable author (other id, no usernames)", [[ours({ from: { id: "17841400000000999" } })]]],
    ["our text naming another parent under this edge", [[ours({ parent_id: OTHER_COMMENT })]]],
    ["our text with no parent stated", [[ours({ parent_id: undefined })]]],
  ] as const)("ambiguous: %s", async (_name, pages) => {
    expect(await find(world(pages as never))).toEqual({ kind: "ambiguous" });
  });

  it.each([
    ["the account read fails (invalid token)", world([[ours()]], { accountStatus: 400 })],
    ["a replies page fails", world([{ status: 500, body: {} }])],
    ["a malformed page (a reply without an author)", world([[{ id: "17999000000000001", text: TEXT, timestamp: at(5), parent_id: COMMENT }]])],
    ["more pages than the bound", world([[]], { endless: true })],
  ] as const)("incomplete: %s — never a match, never an absence", async (_name, w) => {
    expect(await find(w)).toEqual({ kind: "incomplete" });
    expect(w.calls.length).toBeLessThanOrEqual(1 + META_INSTAGRAM_REPLY_LOOKUP_MAX_PAGES);
    for (const call of w.calls) expect([call.method, call.body]).toEqual(["GET", false]);
  });

  it("the result carries a reply id at most: never the text, a username or the token", async () => {
    const w = world([[ours()]]);
    const rendered = inspect(await find(w), { depth: 5 });
    for (const secret of [TEXT, MANAGED, TOKEN]) expect(rendered).not.toContain(secret);
  });
});
