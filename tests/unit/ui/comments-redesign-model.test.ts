/**
 * Comments experience redesign (Step 7B-17V) — the prototype's rules, as pure functions over synthetic fixtures: who
 * may do what (COMMENTS-2.1-CONTRACT §D.4), the manual label rules (§D.3), the filter (a conversation is listed when at
 * least one of its comments carries the label), Previous / Next, and how the brand's own account is named without
 * inventing an identity. Step 7B-17V-UX: the comment-action resolver (role → Monitor-only → Wrenkind today → platform
 * → connection → the comment's state), the platform rules from the Meta research (7B-17V-META), the simulated
 * operations and the private-reply window. Development-only prototype code; nothing here touches the product.
 */
import { describe, expect, it } from "vitest";
import { THEMES, THEME_NAMES, contrastRatio, type SemanticToken } from "@/ui/foundations/tokens";
import { ACCOUNTS, CONVERSATIONS, POSTS, SEED_ASSESSMENTS, SEED_ASSIGNMENTS, SEED_LABELS, type Post } from "@/app/dev/ui-reference/comments-redesign/fixtures";
import {
  CAPABILITIES,
  EMPTY_SIM,
  LABELS_PER_WORKSPACE,
  ORDERED,
  abilitiesOf,
  answerOp,
  availabilityOf,
  contextNotice,
  labelSummary,
  openOpOn,
  opAvailability,
  opSentence,
  previewOf,
  privateReplyWindow,
  replyTargetOf,
  startOp,
  viewOf,
  type ActionId,
  type ActionInput,
  type SimState,
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
    const all = { reply: true, replyPrivately: true, hide: true, delete: true, block: true, like: true };
    const none = { reply: false, replyPrivately: false, hide: false, delete: false, block: false, like: false };
    for (const role of ["owner", "admin", "manager"] as const) expect(abilitiesOf(role)).toEqual({ view: true, assign: true, create: true, ...all });
    // The product's Responder defaults (platform/permissions/catalog.ts): no delete, no block without a grant.
    expect(abilitiesOf("agent")).toEqual({ view: true, assign: true, create: false, ...all, delete: false, block: false });
    expect(abilitiesOf("analyst")).toEqual({ view: true, assign: false, create: false, ...none });
    expect(abilitiesOf("guest")).toEqual({ view: false, assign: false, create: false, ...none });
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
    const post = (kind: Post["kind"], source: Post["source"]): Post => ({ id: "p", accountId: "a", kind, source, caption: null, surface: "feed", owner: null });
    expect(sourceTag(post("Ad", "paid"))).toBe("Ad");
    expect(sourceTag(post("Post", "mixed"))).toBe("Organic and paid");
    expect(sourceTag(post("Post", "unknown"))).toBeUndefined();
    expect(sourceTag(post("Post", "organic"))).toBeUndefined();
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

/* ───────────── Step 7B-17V-UX: comment actions ───────────── */

const conversation = (id: string) => {
  const found = CONVERSATIONS.find((item) => item.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};
const ACTIONS: readonly ActionId[] = ["reply", "hide", "delete", "like", "block", "private_reply"];
const input = (conversationId: string, index: number, overrides: Partial<ActionInput> = {}): Omit<ActionInput, "action"> => {
  const item = conversation(conversationId);
  const comment = item.comments[index];
  if (comment === undefined) throw new Error(`${conversationId}#${String(index)}`);
  return { role: "manager", mode: "standard", actions: "simulate", accountHealth: "healthy", conversation: item, comment, sim: EMPTY_SIM, ...overrides };
};
const kinds = (base: Omit<ActionInput, "action">): Record<string, string> => Object.fromEntries(ACTIONS.map((action) => [action, availabilityOf({ ...base, action }).kind]));
const reasonOf = (base: Omit<ActionInput, "action">, action: ActionId): string => {
  const result = availabilityOf({ ...base, action });
  return result.kind === "unavailable" ? `${result.cause}: ${result.reason}` : result.kind;
};

describe("capability matrix (7B-17V-META): documentation, Wrenkind and the prototype are three separate facts", () => {
  it("every action has one row per platform; Instagram Like and Block are not documented and not offered", () => {
    for (const action of ACTIONS) for (const platform of ["facebook", "instagram"] as const) expect(CAPABILITIES.filter((row) => row.action === action && row.platform === platform), `${action}/${platform}`).toHaveLength(1);
    const ig = (action: ActionId) => CAPABILITIES.find((row) => row.action === action && row.platform === "instagram");
    expect(ig("like")).toMatchObject({ meta: "not_documented", simulation: "not_offered" });
    expect(ig("block")).toMatchObject({ meta: "not_documented", simulation: "not_offered" });
  });

  it("Wrenkind has built only the Instagram public reply (turned off); nothing is enabled", () => {
    expect(CAPABILITIES.filter((row) => row.wrenkind === "implemented_disabled").map((row) => `${row.action}/${row.platform}`)).toEqual(["reply/instagram"]);
    expect(CAPABILITIES.filter((row) => row.wrenkind === "not_implemented")).toHaveLength(CAPABILITIES.length - 1);
  });
});

describe("the action resolver: one decision, in the product's order (IA §18)", () => {
  it("Facebook offers Reply, Hide, Delete, Like, Block and Private reply; Instagram never draws Like or Block", () => {
    expect(kinds(input("cv-03", 0))).toEqual({ reply: "available", hide: "available", delete: "available", like: "available", block: "available", private_reply: "available" });
    expect(kinds(input("cv-01", 0))).toEqual({ reply: "available", hide: "available", delete: "available", like: "hidden", block: "hidden", private_reply: "available" });
  });

  it("the role decides first: an Agent has no Delete or Block (grant-only); an Analyst has no platform action at all", () => {
    expect(kinds(input("cv-03", 0, { role: "agent" }))).toMatchObject({ reply: "available", hide: "available", delete: "hidden", block: "hidden", like: "available" });
    expect(Object.values(kinds(input("cv-03", 0, { role: "analyst" })))).toEqual(ACTIONS.map(() => "hidden"));
  });

  it("Monitor-only, then Wrenkind today, then the platform, then the connection — one reason each", () => {
    // A live video on an unhealthy connection in a Monitor-only workspace: Monitor-only is the one reason.
    expect(reasonOf(input("cv-27", 0, { mode: "monitor", accountHealth: "needs_attention" }), "hide")).toBe("mode: This workspace is Monitor-only.");
    expect(reasonOf(input("cv-01", 0, { actions: "today" }), "reply")).toBe("wrenkind: Public replies aren't enabled in Wrenkind yet for this content.");
    expect(reasonOf(input("cv-03", 0, { actions: "today" }), "reply")).toBe("wrenkind: Not available in Wrenkind yet.");
    // Platform before connection: a capability restriction is never presented as a connection problem, or the reverse.
    expect(reasonOf(input("cv-27", 0, { accountHealth: "needs_attention" }), "hide")).toBe("platform: Comments on live videos can only be managed in the Instagram app.");
    expect(reasonOf(input("cv-06", 0, { accountHealth: "needs_attention" }), "hide")).toBe("connection: Reconnect Lumen Coffee Eventos to act on its comments.");
  });

  it("Instagram live video and story ad: nothing can be done from another app", () => {
    for (const id of ["cv-27", "cv-23"]) for (const action of ["reply", "hide", "delete", "private_reply"] as const) expect(availabilityOf({ ...input(id, 0), action }).kind, `${id}/${action}`).toBe("unavailable");
    expect(reasonOf(input("cv-23", 0), "reply")).toBe("platform: Comments on story ads can only be managed in the Instagram app.");
  });

  it("a post another account owns: no Hide or Delete for the tagged brand; replying there is unconfirmed", () => {
    expect(reasonOf(input("cv-35", 0), "delete")).toBe("platform: Only @brunch.club.ba, who posted this, can hide or delete its comments.");
    expect(reasonOf(input("cv-35", 0), "hide")).toBe("platform: Only @brunch.club.ba, who posted this, can hide or delete its comments.");
    expect(reasonOf(input("cv-35", 0), "reply")).toBe("platform: Not available yet on posts your account doesn't own.");
  });

  it("ads (an Instagram ad, a Facebook ad that never ran as a Page post): moderation is not assumed; replies are simulated", () => {
    for (const id of ["cv-19", "cv-28"]) {
      expect(reasonOf(input(id, 0), "hide")).toBe("platform: Not available yet for comments on ads.");
      expect(reasonOf(input(id, 0), "delete")).toBe("platform: Not available yet for comments on ads.");
      expect(availabilityOf({ ...input(id, 0), action: "reply" }).kind).toBe("available");
    }
    expect(reasonOf(input("cv-28", 0), "block")).toBe("platform: Not available yet for comments on ads.");
  });

  it("the account's own comment: only Delete; a comment no longer on the platform: nothing", () => {
    expect(kinds(input("cv-05", 1))).toEqual({ reply: "hidden", hide: "hidden", delete: "available", like: "hidden", block: "hidden", private_reply: "hidden" });
    expect(Object.values(kinds(input("cv-16", 0)))).toEqual(ACTIONS.map(() => "hidden"));
  });

  it("a hidden comment offers Unhide, not a reply; an unknown author cannot be blocked", () => {
    expect(kinds(input("cv-09", 0))).toMatchObject({ hide: "available", reply: "unavailable", private_reply: "unavailable" });
    expect(reasonOf(input("cv-09", 0), "reply")).toBe("state: Unhide this comment before replying to it.");
    const facebookUnknown = { ...conversation("cv-03"), comments: [{ ...conversation("cv-03").comments[0], author: { kind: "unknown" } } as never] };
    expect(reasonOf({ ...input("cv-03", 0), conversation: facebookUnknown, comment: facebookUnknown.comments[0] as never }, "block")).toBe("state: This comment's author isn't known, so they can't be blocked.");
  });
});

describe("Instagram replies keep the root: a reply to a reply goes under the top-level comment and names the person", () => {
  it("Instagram: nested → root with the person answered; Facebook: the comment itself", () => {
    const thread = conversation("cv-19");
    expect(replyTargetOf(thread, thread.comments[4] as never, "instagram")).toEqual({ commentId: "cv-19-m00", answering: "renata.soto" });
    expect(replyTargetOf(thread, thread.comments[0] as never, "instagram")).toEqual({ commentId: "cv-19-m00" });
    const facebook = conversation("cv-03");
    expect(replyTargetOf(facebook, facebook.comments[2] as never, "facebook")).toEqual({ commentId: "cv-03-m02" });
  });
});

describe("simulated operations: Sending until a person answers; the effect only on Sent", () => {
  it("hide → Sending (nothing changes) → Sent (hidden, marked simulated) → unhide → Sent (visible again)", () => {
    const comment = conversation("cv-03").comments[0];
    if (comment === undefined) throw new Error("fixture");
    const started = startOp(EMPTY_SIM, { kind: "hide", conversationId: "cv-03", commentId: comment.id });
    expect(viewOf(started.sim, "acc-fb-main", comment).presence).toBe("present");
    expect(openOpOn(started.sim, comment.id)?.status).toBe("sending");
    const hidden = answerOp(started.sim, started.id, "sent");
    expect(viewOf(hidden, "acc-fb-main", comment)).toMatchObject({ presence: "hidden", simulated: true });
    const again = startOp(hidden, { kind: "unhide", conversationId: "cv-03", commentId: comment.id });
    expect(viewOf(answerOp(again.sim, again.id, "sent"), "acc-fb-main", comment)).toMatchObject({ presence: "present", simulated: false });
  });

  it("Failed and Stopped change nothing; No answer → Checking, which resolves only to Sent or Failed", () => {
    const comment = conversation("cv-03").comments[0];
    if (comment === undefined) throw new Error("fixture");
    const started = startOp(EMPTY_SIM, { kind: "delete", conversationId: "cv-03", commentId: comment.id });
    for (const answer of ["failed", "blocked"] as const) expect(viewOf(answerOp(started.sim, started.id, answer), "acc-fb-main", comment).presence).toBe("present");
    const checking = answerOp(started.sim, started.id, "checking");
    expect(answerOp(checking, started.id, "blocked")).toBe(checking);
    expect(viewOf(answerOp(checking, started.id, "sent"), "acc-fb-main", comment).presence).toBe("deleted");
    // A settled operation takes no further answer.
    const settled = answerOp(checking, started.id, "failed");
    expect(answerOp(settled, started.id, "sent")).toBe(settled);
  });

  it("REPLY_IN_FLIGHT: while a reply to a comment is Sending or Checking, another reply to it is refused; after the outcome it is not", () => {
    const base = input("cv-19", 4); // renata.soto's reply-to-a-reply: on Instagram the reply goes to cv-19-m00
    const started = startOp(EMPTY_SIM, { kind: "reply", conversationId: "cv-19", commentId: "cv-19-m00", text: "On it.", answering: "renata.soto" });
    expect(reasonOf({ ...base, sim: started.sim }, "reply")).toBe("state: A reply to this comment is on its way or being checked. You can write another once its outcome is known.");
    expect(reasonOf({ ...input("cv-19", 0), sim: started.sim }, "reply")).toMatch(/^state: A reply to this comment is on its way/);
    const checking = answerOp(started.sim, started.id, "checking");
    expect(availabilityOf({ ...base, sim: checking, action: "reply" }).kind).toBe("unavailable");
    expect(availabilityOf({ ...base, sim: answerOp(checking, started.id, "sent"), action: "reply" }).kind).toBe("available");
  });

  it("every sentence says it was simulated and never that the platform did it", () => {
    let sim: SimState = EMPTY_SIM;
    const started = startOp(sim, { kind: "reply", conversationId: "cv-01", commentId: "cv-01-m00", text: "x" });
    sim = started.sim;
    for (const answer of ["sent", "failed", "checking", "blocked"] as const) {
      const op = answerOp(sim, started.id, answer).ops[0];
      if (op === undefined) throw new Error("op");
      expect(opSentence(op, "Instagram")).toMatch(/^Simulated .*Nothing was sent to Instagram\.$/);
      expect(opSentence(op, "Instagram")).not.toMatch(/^(Published|Sent|Hidden|Deleted)/);
    }
    expect(opSentence(started.sim.ops[0] as never, "Instagram")).toBe("Publishing this reply… Simulated — nothing is sent to Instagram.");
  });

  it("blocking is about the author, not the comment: every comment by that person on that account is marked", () => {
    const thread = conversation("cv-03"); // Martina Gómez wrote m00 and m02
    const [first, , third] = thread.comments;
    if (first === undefined || third === undefined) throw new Error("fixture");
    const started = startOp(EMPTY_SIM, { kind: "block", conversationId: "cv-03", commentId: first.id, author: "acc-fb-main|Martina Gómez" });
    const blocked = answerOp(started.sim, started.id, "sent");
    expect(viewOf(blocked, "acc-fb-main", third)).toMatchObject({ authorBlocked: true, presence: "present" });
    expect(availabilityOf({ ...input("cv-03", 2), sim: blocked, action: "delete" }).kind).toBe("available");
  });
});

describe("private replies: one per comment, within seven days", () => {
  it("open within seven days of the comment, closed after", () => {
    expect(privateReplyWindow(conversation("cv-01").comments[0] as never).open).toBe(true);
    expect(privateReplyWindow(conversation("cv-34").comments[0] as never)).toEqual({ open: true, closesAt: "2026-11-18T12:41:00Z" });
    expect(reasonOf(input("cv-36", 0), "private_reply")).toBe("state: Private replies can only be sent within 7 days of the comment.");
  });

  it("after one is sent (or while it is on its way) no second one is offered; a failed one can be written again", () => {
    const started = startOp(EMPTY_SIM, { kind: "private_reply", conversationId: "cv-03", commentId: "cv-03-m00", text: "Hola Martina" });
    expect(availabilityOf({ ...input("cv-03", 0), sim: started.sim, action: "private_reply" }).kind).toBe("unavailable");
    expect(reasonOf({ ...input("cv-03", 0), sim: answerOp(started.sim, started.id, "sent") }, "private_reply")).toBe("state: A private reply was already sent for this comment. Only one is allowed.");
    expect(availabilityOf({ ...input("cv-03", 0), sim: answerOp(started.sim, started.id, "failed"), action: "private_reply" }).kind).toBe("available");
  });
});

describe("context said once, and labels summarized without spreading them to the thread", () => {
  it("one notice per conversation, in the same order as the resolver", () => {
    expect(contextNotice(conversation("cv-27"), "healthy", "simulate", "standard")?.cause).toBe("platform");
    expect(contextNotice(conversation("cv-06"), "needs_attention", "simulate", "standard")?.text).toMatch(/^Lumen Coffee Eventos needs to be reconnected/);
    expect(contextNotice(conversation("cv-06"), "needs_attention", "simulate", "monitor")?.cause).toBe("mode");
    expect(contextNotice(conversation("cv-01"), "healthy", "simulate", "standard")).toBeUndefined();
  });

  it("a conversation's label summary counts the comments that carry each label", () => {
    expect(labelSummary(START, conversation("cv-19")).map((item) => `${item.label.name}:${String(item.comments)}`)).toEqual(["Delivery:3", "Refund request:1"]);
  });
});

describe("source preview (UX2): shape and words only, the source said plainly, never media", () => {
  it("each kind takes its shape; the source is explicit; a restricting context is named", () => {
    const post = (id: string) => POSTS.find((item) => item.id === id);
    expect(previewOf(post("post-1"))).toEqual({ shape: "portrait", kind: "Reel", source: "Organic", context: undefined });
    expect(previewOf(post("post-2"))).toMatchObject({ shape: "square", source: "Paid" });
    expect(previewOf(post("post-4"))).toMatchObject({ shape: "landscape", source: "Organic and paid" });
    expect(previewOf(post("post-7"))).toMatchObject({ source: "Source not reported" });
    expect(previewOf(post("post-10"))).toMatchObject({ shape: "landscape", context: "Managed in the Instagram app" });
    expect(previewOf(post("post-12"))).toMatchObject({ context: "Posted by @brunch.club.ba" });
    expect(previewOf(undefined)).toBeUndefined();
  });
});

describe("fixtures for the action rules", () => {
  it("cover every context the rules distinguish, and assessments are synthetic examples on audience comments only", () => {
    const surfaces = new Set(POSTS.map((post) => post.surface));
    expect([...surfaces].sort()).toEqual(["dark_post", "feed", "live", "story_ad"]);
    expect(POSTS.some((post) => post.owner !== null)).toBe(true);
    expect(ACCOUNTS.filter((item) => item.health === "needs_attention").map((item) => item.id)).toEqual(["acc-fb-events"]);
    expect(CONVERSATIONS).toHaveLength(36);
    for (const id of Object.keys(SEED_ASSESSMENTS)) {
      const found = CONVERSATIONS.flatMap((item) => item.comments).find((comment) => comment.id === id);
      expect(found?.author.kind, id).toBe("audience");
    }
  });
});

describe("UX3: the prototype's color pairs meet WCAG AA in both themes (tokens only, no palette of its own)", () => {
  // Every text-on-background pair the prototype draws (4.5:1), and its graphics and boundaries that carry meaning (3:1).
  const TEXT: readonly (readonly [SemanticToken, SemanticToken])[] = [
    ...(["text.primary", "text.secondary", "text.tertiary"] as const).flatMap((fg) => (["bg.canvas", "bg.surface", "bg.raised", "bg.hover"] as const).map((bg) => [fg, bg] as const)),
    ["danger.fg", "bg.canvas"],
    ["danger.fg", "bg.surface"],
    ["danger.fg", "bg.raised"],
    ["bg.canvas", "danger.fg"], // the Delete / Block confirmation button
    ["warning.fg", "warning.bg"], // the connection notice
    ["success.fg", "success.bg"], // the Sent pill
    ["interactive.link", "bg.canvas"],
    ["interactive.link", "bg.surface"],
    ["action.primary-fg", "action.primary-bg"],
  ];
  const GRAPHICS: readonly (readonly [SemanticToken, SemanticToken])[] = [
    ["interactive.focus", "bg.canvas"],
    ["interactive.focus", "bg.surface"],
    ["interactive.focus", "bg.hover"],
    ["text.primary", "bg.hover"], // the selected row's bar
  ];
  for (const theme of THEME_NAMES) {
    it(`${theme}: text 4.5:1, graphics 3:1`, () => {
      for (const [fg, bg] of TEXT) expect(contrastRatio(THEMES[theme][fg], THEMES[theme][bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      for (const [fg, bg] of GRAPHICS) expect(contrastRatio(THEMES[theme][fg], THEMES[theme][bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
    });
  }

  it("known gap, reported for a design-system decision: the input border (border.strong) is below 3:1 on the canvas in both themes", () => {
    for (const theme of THEME_NAMES) expect(contrastRatio(THEMES[theme]["border.strong"], THEMES[theme]["bg.canvas"])).toBeLessThan(3);
  });
});

describe("UX4 H-1: opAvailability — the decision start() makes at the moment of acting", () => {
  it("refuses in Monitor-only, for a role without the permission, and 'as in Wrenkind today'", () => {
    expect(opAvailability(input("cv-03", 0, { mode: "monitor" }), "hide")).toMatchObject({ kind: "unavailable", cause: "mode" });
    expect(opAvailability(input("cv-03", 0, { role: "agent" }), "delete")).toEqual({ kind: "hidden" });
    expect(opAvailability(input("cv-03", 0, { role: "analyst" }), "reply")).toEqual({ kind: "hidden" });
    expect(opAvailability(input("cv-03", 0, { actions: "today" }), "like")).toMatchObject({ kind: "unavailable", cause: "wrenkind" });
  });

  it("refuses an operation whose direction no longer fits the comment (hide twice, unhide a visible one, unblock an unblocked author)", () => {
    const started = startOp(EMPTY_SIM, { kind: "hide", conversationId: "cv-03", commentId: "cv-03-m00" });
    const hidden = answerOp(started.sim, started.id, "sent");
    expect(opAvailability({ ...input("cv-03", 0), sim: hidden }, "hide")).toMatchObject({ kind: "unavailable", reason: "This comment changed in the meantime. Nothing was done." });
    expect(opAvailability({ ...input("cv-03", 0), sim: hidden }, "unhide").kind).toBe("available");
    expect(opAvailability(input("cv-03", 0), "unhide").kind).toBe("unavailable");
    expect(opAvailability(input("cv-03", 0), "unblock").kind).toBe("unavailable");
    expect(opAvailability(input("cv-03", 0), "unlike").kind).toBe("unavailable");
  });

  it("refuses a second operation while one is waiting (double confirmation)", () => {
    const started = startOp(EMPTY_SIM, { kind: "delete", conversationId: "cv-03", commentId: "cv-03-m00" });
    expect(opAvailability({ ...input("cv-03", 0), sim: started.sim }, "delete")).toMatchObject({ kind: "unavailable", cause: "state" });
  });
});
