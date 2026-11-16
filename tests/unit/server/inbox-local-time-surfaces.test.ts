/**
 * Comments 2.1 (Step 7B-17T) — every ordinary time the Comments pages show goes through the local-time element
 * (ui/time/local-time.tsx), so with JavaScript it reads in the browser's zone. That includes the two surfaces 17R left in
 * UTC: the screen-reader name of an entry's disclosures ("Comment by …, {time}") and the exceptional validation notice
 * ("… until {time}"). The element is replaced here by a visible marker carrying its instant, so the server HTML shows
 * exactly which times are local: none may still be a fixed UTC reading, and the only "UTC" left is the <noscript> note.
 * The element itself (UTC on the server, hydration without a mismatch, local afterwards) is tested in
 * tests/unit/ui/local-time.test.ts. Synthetic data only.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConversationDetail, ConversationViewState, InboxListState } from "@/server/inbox/inbox";
import { displayTime } from "@/server/inbox/inbox";
import { t } from "@/server/i18n";

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const ANCHOR = "a1111111-1111-4111-8111-111111111111";
const SECOND = "a4444444-4444-4444-8444-444444444444";
const T = new Date("2026-11-13T12:37:00.000Z");
const EDITED = new Date("2026-11-13T12:40:00.000Z");
const EARLIER_READ = new Date("2026-11-13T12:38:00.000Z");
const EXPIRES = new Date("2026-11-13T13:22:54.000Z");

vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-14T12:00:00Z") });
const env = vi.hoisted((): { list: unknown; detail: unknown } => ({ list: undefined, detail: undefined }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("@/server/inbox/runtime", () => ({
  currentInboxPage: () => Promise.resolve(env.list),
  currentConversation: () => Promise.resolve(env.detail),
  currentReplyDraftScope: () => Promise.resolve("scope-local-time"),
  inboxPipeline: () => undefined,
}));
// The local-time element, made visible: "⟦full 2026-…Z⟧" wherever a time is read in the browser's zone.
vi.mock("@/ui/time/local-time", async () => {
  const { createElement } = await import("react");
  return {
    LocalTime: ({ iso, form }: { readonly iso: string; readonly form: string }) => `⟦${form} ${iso}⟧`,
    LocalTimeStamp: ({ iso, className }: { readonly iso: string; readonly className?: string }) => createElement("time", { dateTime: iso, className }, `⟦stamp ${iso}⟧`),
  };
});

const { default: ListPage } = await import("@/app/workspaces/[workspaceId]/inbox/page");
const { default: DetailPage } = await import("@/app/workspaces/[workspaceId]/inbox/[conversationId]/page");

const escape = (message: string): string => message.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const iso = (date: Date): string => date.toISOString().replace(".000Z", "Z");
const local = (date: Date): string => `⟦full ${iso(date)}⟧`;
/** The page without its <noscript> note: what a reader with JavaScript is shown. */
const withScript = (html: string): string => html.replace(/<noscript>[\s\S]*?<\/noscript>/g, "");

type Ready = Extract<InboxListState, { kind: "ready" }>;
const list: Ready = {
  kind: "ready",
  workspaceId: WS as never,
  page: {
    items: [{ conversationId: CONVERSATION, workflowState: "open", platform: "instagram", source: "organic", contentKind: "post", anchor: { observed: true, author: "audience", authorLabel: "Selected Person", excerpt: "excerpt", presence: "present" }, latestActivityAt: T, observedCount: 2, notYetReadCount: 0, anyHidden: false, anyRemovedAtSource: false }],
    nextCursor: null,
    asOf: T,
    coverage: [],
    coverageOmitted: false,
    emptyReason: null,
  },
};
const member = (interactionId: string, over: Partial<ConversationDetail["thread"][number]> = {}): ConversationDetail["thread"][number] => ({
  interactionId,
  parentInteractionId: null,
  kind: "comment",
  observed: true,
  author: "audience",
  authorLabel: "Selected Person",
  text: `text of ${interactionId.slice(0, 2)}`,
  presence: "present",
  providerCreatedAt: T,
  providerEditedAt: null,
  textObservedAt: T,
  earlierVersions: [],
  olderVersionsOmitted: false,
  facts: [],
  ...over,
});
const conversation = (reply: ConversationDetail["reply"]): Extract<ConversationViewState, { kind: "ready" }> => ({
  kind: "ready",
  workspaceId: WS as never,
  detail: {
    conversationId: CONVERSATION,
    workflowState: "open",
    platform: "instagram",
    source: "organic",
    contentKind: "post",
    anchorInteractionId: ANCHOR,
    truncated: false,
    reply,
    outbound: [{ intentId: "b-sent", parentInteractionId: ANCHOR, text: "earlier reply", state: "sent", outcomeCode: null, createdAt: T, confirmedAt: EDITED }],
    thread: [member(ANCHOR, { providerEditedAt: EDITED, earlierVersions: [{ text: "first words", observedAt: EARLIER_READ, providerEditedAt: null }] }), member(SECOND, { authorLabel: "Second Person" })],
  },
});
const VALIDATION: ConversationDetail["reply"] = { kind: "validation", connectedAccountId: "66666666-6666-4666-8666-666666666666", platform: "instagram", maxChars: 2200, targets: [{ targetInteractionId: SECOND, expiresAt: EXPIRES }] };

async function renderConversation(state: ConversationViewState): Promise<string> {
  env.detail = state;
  env.list = list;
  return renderToStaticMarkup(await DetailPage({ params: Promise.resolve({ workspaceId: WS, conversationId: CONVERSATION }), searchParams: Promise.resolve({ reply: SECOND }) }));
}

describe("Comments 2.1 (Step 7B-17T): every ordinary time reads in the browser's zone", () => {
  it("the screen-reader name of an entry's disclosures carries a local time, not a fixed UTC reading", async () => {
    const html = await renderConversation(conversation(VALIDATION));
    const context = escape(t("inbox.thread.entry_label", { kind: t("inbox.thread.comment"), author: "Selected Person", time: local(T) }));
    const names = [...html.matchAll(/<summary class="[^"]*memberDetailsSummary[^"]*">([\s\S]*?)<\/summary>/g)].map((match) => match[1] ?? "");
    // The exact-times disclosure and the earlier-versions disclosure of the edited comment both name it the same way.
    expect(names.filter((name) => name.includes(`<span class="wk-sr-only">${context}</span>`))).toHaveLength(2);
    expect(html).not.toContain(escape(t("inbox.thread.entry_label", { kind: t("inbox.thread.comment"), author: "Selected Person", time: displayTime(T) })));
  });

  it("the exceptional validation notice reads its expiry locally; its words are otherwise unchanged", async () => {
    const html = await renderConversation(conversation(VALIDATION));
    expect(html).toContain(escape(t("inbox.reply.validation_notice", { time: local(EXPIRES) })));
    expect(html).not.toContain(displayTime(EXPIRES));
  });

  it("no fixed UTC reading is left with JavaScript: every time is a local element; 'UTC' only in the no-script note", async () => {
    for (const html of [await renderConversation(conversation(VALIDATION)), await renderConversation(conversation({ kind: "unavailable", reason: "platform_unavailable", platform: "instagram" }))]) {
      expect(withScript(html)).not.toMatch(/\bUTC\b/);
      expect(html).toContain(`<noscript>`);
      for (const date of [T, EDITED, EARLIER_READ]) expect(withScript(html)).not.toContain(displayTime(date));
      // The record's times (posted, edited, read, the earlier version, the Sent reply's times) are all local elements.
      for (const date of [T, EDITED, EARLIER_READ]) expect(html).toContain(local(date));
      // Every <time> keeps its canonical ISO instant.
      expect(html).toContain(`dateTime="${iso(T)}"`);
    }
    env.list = list;
    const listHtml = renderToStaticMarkup(await ListPage({ params: Promise.resolve({ workspaceId: WS }), searchParams: Promise.resolve({}) }));
    expect(withScript(listHtml)).not.toMatch(/\bUTC\b/);
    expect(listHtml).toContain(`dateTime="${iso(T)}"`);
  });
});
