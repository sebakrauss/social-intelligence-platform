/**
 * Comments experience redesign (Step 7B-17V) — the prototype's rules, as pure functions over synthetic fixtures: who
 * may do what (COMMENTS-2.1-CONTRACT §D.4), the manual label rules (§D.3), the filter (a conversation is listed when at
 * least one of its comments carries the label), Previous / Next, and how the brand's own account is named without
 * inventing an identity. Development-only prototype code; nothing here touches the product.
 */
import { describe, expect, it } from "vitest";
import { ACCOUNTS, CONVERSATIONS, SEED_ASSIGNMENTS, SEED_LABELS } from "@/app/dev/ui-reference/comments-redesign/fixtures";
import {
  LABELS_PER_WORKSPACE,
  ORDERED,
  abilitiesOf,
  conversationLabels,
  createLabel,
  labelCounts,
  labelsOn,
  latestOf,
  nameProblem,
  ownIdentity,
  positionOf,
  requesterOf,
  setAssigned,
  sourceTag,
  threadOf,
  visibleConversations,
  type LabelState,
} from "@/app/dev/ui-reference/comments-redesign/model";

const START: LabelState = { labels: SEED_LABELS, assignments: SEED_ASSIGNMENTS, nextId: 1 };
const account = (id: string) => {
  const found = ACCOUNTS.find((item) => item.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};

describe("synthetic fixtures", () => {
  it("are realistic in volume and shape: 25–50 conversations, several accounts, long threads, published replies, unknown context", () => {
    expect(CONVERSATIONS.length).toBeGreaterThanOrEqual(25);
    expect(CONVERSATIONS.length).toBeLessThanOrEqual(50);
    expect(new Set(CONVERSATIONS.map((conversation) => conversation.accountId)).size).toBe(4);
    expect(Math.max(...CONVERSATIONS.map((conversation) => conversation.comments.length))).toBeGreaterThanOrEqual(12);
    expect(CONVERSATIONS.filter((conversation) => conversation.sent.length > 0).length).toBeGreaterThanOrEqual(5);
    expect(CONVERSATIONS.some((conversation) => conversation.postId === null)).toBe(true);
    expect(CONVERSATIONS.some((conversation) => conversation.comments.some((comment) => comment.parentId !== null && comment.parentId !== conversation.comments[0]?.id))).toBe(true);
    expect(Object.values(SEED_ASSIGNMENTS).some((ids) => ids.length > 1)).toBe(true);
  });

  it("are listed newest activity first", () => {
    for (let index = 1; index < ORDERED.length; index += 1) expect(latestOf(ORDERED[index - 1] as never) >= latestOf(ORDERED[index] as never)).toBe(true);
  });
});

describe("roles (§D.4)", () => {
  it("Owner, Admin and Manager create and assign; Agent assigns existing labels; Analyst views and filters; Client guest is denied", () => {
    for (const role of ["owner", "admin", "manager"] as const) expect(abilitiesOf(role)).toEqual({ view: true, assign: true, create: true, reply: true });
    expect(abilitiesOf("agent")).toEqual({ view: true, assign: true, create: false, reply: true });
    expect(abilitiesOf("analyst")).toEqual({ view: true, assign: false, create: false, reply: false });
    expect(abilitiesOf("guest")).toEqual({ view: false, assign: false, create: false, reply: false });
  });

  it("a role without the ability changes nothing", () => {
    expect(setAssigned(START, "analyst", "cv-01-m00", "lbl-praise", true)).toBe(START);
    expect(createLabel(START, "agent", "Urgent", "cv-01-m00")).toEqual({ ok: false, problem: "not_allowed" });
    expect(createLabel(START, "guest", "Urgent", undefined)).toEqual({ ok: false, problem: "not_allowed" });
  });
});

describe("manual labels (§D.3)", () => {
  it("creating from a comment assigns the new label to that comment in the same step", () => {
    const result = createLabel(START, "manager", "  Press   inquiry ", "cv-06-m00");
    if (!result.ok) throw new Error(result.problem);
    expect(result.label.name).toBe("Press inquiry");
    expect(result.state.labels).toHaveLength(SEED_LABELS.length + 1);
    expect(labelsOn(result.state, "cv-06-m00")).toEqual([result.label.id]);
    // Created from the sidebar: no comment receives it.
    const bare = createLabel(START, "owner", "Press inquiry", undefined);
    if (!bare.ok) throw new Error(bare.problem);
    expect(Object.values(bare.state.assignments).flat()).not.toContain(bare.label.id);
  });

  it("names are 1–40 characters, unique ignoring case, at most 50 per workspace", () => {
    expect(nameProblem(SEED_LABELS, "   ")).toBe("empty");
    expect(nameProblem(SEED_LABELS, "x".repeat(41))).toBe("too_long");
    expect(nameProblem(SEED_LABELS, "x".repeat(40))).toBeUndefined();
    expect(nameProblem(SEED_LABELS, "delivery")).toBe("duplicate");
    expect(nameProblem(SEED_LABELS, " REFUND  request ")).toBe("duplicate");
    const full = Array.from({ length: LABELS_PER_WORKSPACE }, (_, index) => ({ id: `l${String(index)}`, name: `Label ${String(index)}` }));
    expect(nameProblem(full, "One more")).toBe("limit");
  });

  it("a comment carries several labels; assign and remove are idempotent", () => {
    const once = setAssigned(START, "agent", "cv-01-m00", "lbl-praise", true);
    expect(labelsOn(once, "cv-01-m00")).toEqual(["lbl-delivery", "lbl-follow", "lbl-praise"]);
    expect(setAssigned(once, "agent", "cv-01-m00", "lbl-praise", true)).toBe(once);
    const removed = setAssigned(once, "agent", "cv-01-m00", "lbl-delivery", false);
    expect(labelsOn(removed, "cv-01-m00")).toEqual(["lbl-follow", "lbl-praise"]);
    expect(setAssigned(removed, "agent", "cv-01-m00", "lbl-delivery", false)).toBe(removed);
    expect(setAssigned(START, "agent", "cv-01-m00", "lbl-does-not-exist", true)).toBe(START);
  });

  it("the filter lists a conversation when at least one of its comments carries the label; a missing label shows everything", () => {
    const refund = visibleConversations(START, "lbl-refund");
    expect(refund.map((conversation) => conversation.id).sort()).toEqual(["cv-04", "cv-10", "cv-19", "cv-26", "cv-34"]);
    // cv-19: the label is on a reply deep in the thread, not on its first comment.
    expect(labelsOn(START, "cv-19-m00")).not.toContain("lbl-refund");
    expect(conversationLabels(START, CONVERSATIONS.find((conversation) => conversation.id === "cv-19") as never)).toContain("lbl-refund");
    expect(labelCounts(START)["lbl-refund"]).toBe(5);
    expect(visibleConversations(START, "lbl-gone")).toBe(ORDERED);
    expect(visibleConversations(START, undefined)).toBe(ORDERED);
  });
});

describe("navigation", () => {
  it("Previous / Next move inside the visible list", () => {
    const list = visibleConversations(START, "lbl-refund");
    const first = positionOf(list, list[0]?.id ?? "");
    expect(first).toMatchObject({ index: 1, count: 5, previous: undefined, next: list[1]?.id });
    const last = positionOf(list, list[4]?.id ?? "");
    expect(last).toMatchObject({ index: 5, next: undefined });
    expect(positionOf(list, "cv-02")).toBeUndefined();
  });
});

describe("identities: commenter, connected account and Wrenkind member are never confused", () => {
  it("the connected account shows its verified name only when the read model has it; otherwise a neutral description", () => {
    expect(ownIdentity(account("acc-ig-main"), "planned")).toEqual({ name: "@lumen.coffee", verified: true, descriptor: "Your Instagram account" });
    expect(ownIdentity(account("acc-fb-main"), "planned")).toEqual({ name: "Lumen Coffee", verified: true, descriptor: "Your Facebook Page" });
    expect(ownIdentity(account("acc-ig-main"), "today")).toEqual({ name: "Your Instagram account", verified: false, descriptor: "Your Instagram account" });
    // No verified name: never invented, even with the planned read model.
    expect(ownIdentity(account("acc-ig-roastery"), "planned")).toEqual({ name: "Your Instagram account", verified: false, descriptor: "Your Instagram account" });
  });

  it("the member who requested a reply is named only with the planned read model", () => {
    const reply = CONVERSATIONS.find((conversation) => conversation.id === "cv-02")?.sent[0];
    if (reply === undefined) throw new Error("fixture");
    expect(requesterOf(reply, "planned")).toBe("Ana Ruiz");
    expect(requesterOf(reply, "today")).toBe("A member of this workspace");
  });

  it("unknown organic/paid source is never shown as organic or paid; only a reported paid or mixed source gets a tag", () => {
    expect(sourceTag({ id: "p", accountId: "a", kind: "Ad", source: "paid", caption: null })).toBe("Ad");
    expect(sourceTag({ id: "p", accountId: "a", kind: "Post", source: "mixed", caption: null })).toBe("Organic and paid");
    expect(sourceTag({ id: "p", accountId: "a", kind: "Post", source: "unknown", caption: null })).toBeUndefined();
    expect(sourceTag({ id: "p", accountId: "a", kind: "Post", source: "organic", caption: null })).toBeUndefined();
    expect(sourceTag(undefined)).toBeUndefined();
  });
});

describe("threads", () => {
  it("reading order: the first comment, then everything by time; a reply to a reply names who it answers", () => {
    const long = CONVERSATIONS.find((conversation) => conversation.id === "cv-19");
    if (long === undefined) throw new Error("fixture");
    const entries = threadOf(long);
    expect(entries).toHaveLength(long.comments.length + long.sent.length);
    expect(entries[0]).toMatchObject({ kind: "comment", depth: 0 });
    const times = entries.slice(1).map((entry) => (entry.kind === "comment" ? entry.comment.at : entry.reply.publishedAt));
    expect([...times].sort()).toEqual(times);
    const answer = entries.find((entry) => entry.kind === "comment" && entry.comment.id === "cv-19-m04");
    expect(answer).toMatchObject({ replyingTo: "your account" });
    const sent = entries.find((entry) => entry.kind === "sent");
    expect(sent).toMatchObject({ replyingTo: "renata.soto" });
  });
});
