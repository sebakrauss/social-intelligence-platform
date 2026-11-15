/**
 * Step 7B-15U (audit 7B-15T, P2) — the year of a short time. A date in the CURRENT UTC calendar year reads compact
 * ("08 NOV 23:14"); a date from any other year always shows its year — also when everything on the page is from that
 * year (the defect: the year was compared with the newest time on the page, so a wholly historical conversation showed
 * none). Rendered through the real pages with the read model replaced in-process and the clock FROZEN, for the list and
 * for the open conversation; the exact UTC form (screen readers, hover, the record) and the machine-readable instant
 * are checked beside every short one.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ConversationDetail, ConversationViewState, InboxListState } from "@/server/inbox/inbox";
import { displayTime } from "@/server/inbox/inbox";
import { t } from "@/server/i18n";

const NOW = new Date("2026-11-14T12:00:00.000Z");
vi.useFakeTimers({ toFake: ["Date"], now: NOW });
afterAll(() => vi.useRealTimers());

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const uuid = (n: number): string => `a${String(n).padStart(7, "0")}-1111-4111-8111-111111111111`;

const env = vi.hoisted((): { list: unknown; detail: unknown } => ({ list: undefined, detail: undefined }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("@/server/inbox/runtime", () => ({ currentInboxPage: () => Promise.resolve(env.list), currentConversation: () => Promise.resolve(env.detail), currentReplyDraftScope: () => Promise.resolve(undefined), inboxPipeline: () => undefined }));

const { default: ListPage } = await import("@/app/workspaces/[workspaceId]/inbox/page");
const { default: DetailPage } = await import("@/app/workspaces/[workspaceId]/inbox/[conversationId]/page");
const { shortTime } = await import("@/app/workspaces/[workspaceId]/inbox/views");

type Ready = Extract<InboxListState, { kind: "ready" }>;
type Member = ConversationDetail["thread"][number];
const row = (conversationId: string, latest: string): Ready["page"]["items"][number] => ({ conversationId, workflowState: "open", platform: "facebook", source: "organic", contentKind: "post", anchor: { observed: true, author: "audience", authorLabel: "Person", excerpt: "excerpt", presence: "present" }, latestActivityAt: new Date(latest), observedCount: 1, notYetReadCount: 0, anyHidden: false, anyRemovedAtSource: false });
const list = (rows: readonly (readonly [string, string])[]): Ready => ({ kind: "ready", workspaceId: WS as never, page: { items: rows.map(([id, latest]) => row(id, latest)), nextCursor: null, asOf: NOW, coverage: [], coverageOmitted: false, emptyReason: null } });
const member = (n: number, parent: number | null, iso: string | null, author = `person-${String(n)}`): Member => ({ interactionId: uuid(n), parentInteractionId: parent === null ? null : uuid(parent), kind: parent === null ? "comment" : "reply", observed: true, author: "audience", authorLabel: author, text: `text-${String(n)}`, presence: "present", providerCreatedAt: iso === null ? null : new Date(iso), providerEditedAt: null, textObservedAt: null, earlierVersions: [], olderVersionsOmitted: false, facts: [] });
const ready = (thread: readonly Member[], outbound: ConversationDetail["outbound"] = []): ConversationViewState => ({ kind: "ready", workspaceId: WS as never, detail: { conversationId: CONVERSATION, workflowState: "open", platform: "facebook", source: "organic", contentKind: "post", anchorInteractionId: uuid(0), truncated: false, reply: { kind: "hidden" }, outbound: [...outbound], thread: [...thread] } });

async function renderList(state: InboxListState): Promise<string> {
  env.list = state;
  return renderToStaticMarkup(await ListPage({ params: Promise.resolve({ workspaceId: WS }), searchParams: Promise.resolve({}) }));
}
async function renderConversation(state: ConversationViewState, listState: InboxListState): Promise<string> {
  env.detail = state;
  env.list = listState;
  return renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ workspaceId: WS, conversationId: CONVERSATION }), searchParams: Promise.resolve({}) }));
}
/** Every <time> drawn after `from`: its machine-readable instant, the short label the eye reads, the exact form. */
const times = (html: string, from = 0): { iso: string; short: string; exact: string; title: string }[] =>
  [...html.slice(from).matchAll(/<time class="[^"]*" dateTime="([^"]+)" title="([^"]+)"><span aria-hidden="true">([^<]+)<\/span><span class="wk-sr-only">([^<]+)<\/span><\/time>/g)].map((m) => ({ iso: m[1] ?? "", title: m[2] ?? "", short: m[3] ?? "", exact: m[4] ?? "" }));
const threadTimes = (html: string) => times(html, html.indexOf('id="thread"'));
/** Every short label says the same instant as its exact form: the exact form names the year, the clock and UTC. */
const consistent = (entries: ReturnType<typeof times>): void => {
  for (const entry of entries) {
    const at = new Date(entry.iso);
    expect(entry.exact).toBe(displayTime(at));
    expect(entry.title).toBe(displayTime(at));
    expect(entry.exact).toMatch(/^\d{2} [A-Z]{3} \d{4} · \d{2}:\d{2} UTC$/);
    expect(entry.exact).toContain(entry.short.slice(-5)); // the same clock
  }
};

describe("the year of a short time (frozen clock: 14 NOV 2026 UTC)", () => {
  it("a conversation entirely in 2024 shows 2024 — the 15T defect: nothing on the page is from this year, and the year is still said", async () => {
    const html = await renderConversation(ready([member(0, null, "2024-03-05T09:00:00Z"), member(1, 0, "2024-03-05T09:30:00Z"), member(2, 0, "2024-03-07T18:45:00Z")]), list([[CONVERSATION, "2024-03-07T18:45:00Z"]]));
    const thread = threadTimes(html);
    expect(thread.map((entry) => entry.short)).toEqual(["05 MAR 2024 09:00", "09:30", "07 MAR 2024 18:45"]);
    consistent(thread);
    // The open row (the list) says the year as well.
    expect(times(html)[0]?.short).toBe("07 MAR 2024 18:45");
    // No date without a year anywhere among the short labels (a bare clock inherits the dated label above it).
    expect(times(html).filter((entry) => /^\d{2} [A-Z]{3} \d{2}:\d{2}$/.test(entry.short))).toEqual([]);
  });

  it("a conversation entirely in 2025 shows 2025", async () => {
    const html = await renderConversation(ready([member(0, null, "2025-08-20T10:00:00Z"), member(1, 0, "2025-08-21T11:00:00Z")]), list([[CONVERSATION, "2025-08-21T11:00:00Z"]]));
    expect(threadTimes(html).map((entry) => entry.short)).toEqual(["20 AUG 2025 10:00", "21 AUG 2025 11:00"]);
    consistent(times(html));
  });

  it("a conversation in the current year (2026) keeps the compact form, with no year", async () => {
    const html = await renderConversation(ready([member(0, null, "2026-11-08T22:50:00Z"), member(1, 0, "2026-11-08T23:05:00Z"), member(2, 0, "2026-11-09T08:00:00Z")]), list([[CONVERSATION, "2026-11-09T08:00:00Z"]]));
    expect(threadTimes(html).map((entry) => entry.short)).toEqual(["08 NOV 22:50", "23:05", "09 NOV 08:00"]);
    expect(times(html)[0]?.short).toBe("09 NOV 08:00");
    consistent(times(html));
  });

  it("a mixed 2024 / 2025 / 2026 conversation: each past year is said, this year is compact — in the thread, in the request times and in 'Replying to'", async () => {
    const thread = [member(0, null, "2024-12-30T10:00:00Z", "Marta"), member(1, 0, "2025-06-01T10:00:00Z", "Marta"), member(2, 1, "2026-02-01T10:00:00Z", "Lucas"), member(3, 0, "2026-02-01T11:00:00Z", "Ana")];
    const outbound: ConversationDetail["outbound"] = [{ intentId: "b1", parentInteractionId: uuid(0), text: "request-b1", state: "sent", outcomeCode: null, createdAt: new Date("2025-06-02T09:00:00Z"), confirmedAt: new Date("2025-06-02T09:00:30Z") }];
    const html = await renderConversation(ready(thread, outbound), list([[CONVERSATION, "2026-02-01T11:00:00Z"]]));
    expect(threadTimes(html).map((entry) => entry.short)).toEqual(["30 DEC 2024 10:00", "01 JUN 2025 10:00", "01 FEB 10:00", "11:00"]);
    consistent(times(html));
    // The request made in 2025: year shown for the eye, the exact form for assistive technology.
    expect(html).toContain(`<span aria-hidden="true">${t("inbox.outbound.requested_at", { time: "02 JUN 2025 09:00" })}</span><span class="wk-sr-only">${t("inbox.outbound.requested_at", { time: "02 JUN 2025 · 09:00 UTC" })}</span>`);
    expect(html).toContain(`<span aria-hidden="true">${t("inbox.outbound.confirmed_at", { time: "09:00" })}</span><span class="wk-sr-only">${t("inbox.outbound.confirmed_at", { time: "02 JUN 2025 · 09:00 UTC" })}</span>`);
    // "Replying to Marta (…)": Marta wrote twice, so the parent's time is said — with ITS year (2025), not this one.
    expect(html).toContain(t("inbox.reply.to_at", { author: "Marta", time: "01 JUN 2025 10:00" }));
  });

  it("31 December → 1 January: the old year is said, the new one is compact; the same UTC day never crosses the boundary", async () => {
    const html = await renderConversation(ready([member(0, null, "2025-12-31T23:59:00Z"), member(1, 0, "2026-01-01T00:00:00Z"), member(2, 0, "2026-01-01T00:01:00Z")]), list([[CONVERSATION, "2026-01-01T00:01:00Z"]]));
    expect(threadTimes(html).map((entry) => entry.short)).toEqual(["31 DEC 2025 23:59", "01 JAN 00:00", "00:01"]);
    consistent(times(html));
    // And seen from the other side of a year change: on 1 January 2027, 31 December 2026 is last year.
    expect(shortTime(new Date("2026-12-31T23:59:00Z"), new Date("2027-01-01T00:00:00Z"))).toBe("31 DEC 2026 23:59");
    expect(shortTime(new Date("2026-12-31T23:59:00Z"), new Date("2026-12-31T23:59:59Z"))).toBe("31 DEC 23:59");
    // The day shown above never hides a year: 31 DEC 2025 and 31 DEC 2026 are different days.
    expect(shortTime(new Date("2025-12-31T10:00:00Z"), NOW, new Date("2026-12-31T09:00:00Z"))).toBe("31 DEC 2025 10:00");
  });

  it("missing timestamps: an undated entry draws no time and never changes what the dated ones show", async () => {
    const html = await renderConversation(ready([member(0, null, "2024-05-01T10:00:00Z"), member(1, 0, null), member(2, 0, "2024-05-01T10:30:00Z"), member(3, 0, null)]), list([[CONVERSATION, "2024-05-01T10:30:00Z"]]));
    expect(threadTimes(html).map((entry) => entry.short)).toEqual(["01 MAY 2024 10:00", "10:30"]);
    const undated = html.slice(html.indexOf(`id="member-${uuid(1)}"`), html.indexOf(`id="member-${uuid(2)}"`));
    expect(undated).not.toContain("<time");
    // A conversation with no time at all still renders.
    const none = await renderConversation(ready([member(0, null, null), member(1, 0, null)]), list([[CONVERSATION, "2024-05-01T10:30:00Z"]]));
    expect(threadTimes(none)).toEqual([]);
    expect(none).toContain("text-1");
  });

  it("the list: rows from other years show their year, rows from this year are compact, and every row keeps its exact time", async () => {
    const html = await renderList(list([[CONVERSATION, "2026-11-08T23:14:00Z"], [OTHER, "2025-12-31T23:59:00Z"], ["33333333-3333-4333-8333-333333333333", "2024-02-29T08:00:00Z"]]));
    const rows = times(html);
    expect(rows.map((entry) => entry.short)).toEqual(["08 NOV 23:14", "31 DEC 2025 23:59", "29 FEB 2024 08:00"]);
    expect(rows.map((entry) => entry.iso)).toEqual(["2026-11-08T23:14:00Z", "2025-12-31T23:59:00Z", "2024-02-29T08:00:00Z"]);
    consistent(rows);
    // A list wholly from 2024 (the defect, on the list): every row says 2024.
    const old = times(await renderList(list([[CONVERSATION, "2024-03-07T18:45:00Z"], [OTHER, "2024-03-01T10:00:00Z"]])));
    expect(old.map((entry) => entry.short)).toEqual(["07 MAR 2024 18:45", "01 MAR 2024 10:00"]);
  });

  it("the record keeps every exact time in UTC, whatever the short form shows", async () => {
    const html = await renderConversation(ready([member(0, null, "2024-03-05T09:00:00Z")]), list([[CONVERSATION, "2024-03-05T09:00:00Z"]]));
    expect(html).toContain(t("inbox.thread.posted", { time: "05 MAR 2024 · 09:00 UTC" }));
    expect(html).toContain(t("inbox.thread.entry_label", { kind: t("inbox.thread.comment"), author: "person-0", time: "05 MAR 2024 · 09:00 UTC" }));
  });
});
