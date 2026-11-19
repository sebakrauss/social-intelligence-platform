/**
 * Comments workspace (Step UX-04) — the interactive prototype's workflow rules as pure functions: conversation
 * management (assign, Urgent, escalate, notes, Done with a resolution, Reopen, auto-reopen), Needs attention derived
 * from four explainable facts in a fixed precedence, views, filters, search, sort, the pinned selection that keeps its
 * place (A1 → A2 → A3), label management (rename, marker, delete) and the confirmation a destructive retry needs.
 * Development-only prototype code; these are HYPOTHESES under review (UX04-DECISION-REGISTER.md), not product rules.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONVERSATIONS, SEED_ASSIGNMENTS, SEED_LABELS, type Conversation } from "@/app/dev/ui-reference/comments-redesign/fixtures";
import {
  EMPTY_SIM,
  NO_FILTERS,
  SEED_SIM,
  SEED_WORKFLOW,
  activeFilters,
  addNote,
  answerOp,
  assignConversation,
  attentionOf,
  audienceWritesAgain,
  availabilityOf,
  doneBlocker,
  closeEscalation,
  confirmsBeforeRetry,
  DEFAULT_MARKER,
  MARKERS,
  conversationsWithLabel,
  createLabel,
  deleteLabel,
  durationText,
  escalateConversation,
  flowOf,
  historyOf,
  inView,
  labelUsage,
  isMarker,
  labelsOn,
  leavingNote,
  listOf,
  liveOf,
  manageProblemText,
  markerOf,
  markDone,
  matchesQuery,
  menuFilterCount,
  nowOf,
  opAvailability,
  quietStateOf,
  renameLabel,
  replyIdentity,
  replyTargetOf,
  reopenConversation,
  resolutionAfterReply,
  resolutionChoices,
  resolutionsFor,
  setMarker,
  setUrgent,
  startOp,
  unresolvedReplies,
  updateLabel,
  viewCounts,
  withFilter,
  withPin,
  withoutFilter,
  type LabelState,
  type OpKind,
  type SimState,
  type WorkContext,
  type Workflow,
} from "@/app/dev/ui-reference/comments-redesign/model";

const LABELS: LabelState = { labels: SEED_LABELS, assignments: SEED_ASSIGNMENTS, nextId: 1 };
const CTX: WorkContext = { labels: LABELS, wf: SEED_WORKFLOW, sim: SEED_SIM, allHealthy: false, target: 240 };
const conv = (id: string): Conversation => {
  const found = CONVERSATIONS.find((item) => item.id === id);
  if (found === undefined) throw new Error(id);
  return found;
};
const ok = (result: ReturnType<typeof setUrgent>): Workflow => {
  if (!result.ok) throw new Error(result.reason);
  return result.wf;
};
const ids = (list: readonly Conversation[]): string[] => list.map((item) => item.id);

describe("Needs attention: four explainable facts, one reason, in a fixed order", () => {
  it("each seeded scenario has the reason the design names", () => {
    expect(attentionOf(conv("cv-07"), CTX)).toMatchObject({ reason: "waiting", text: "Waiting 4 h · over target" }); // A: nina, 250 min
    expect(attentionOf(conv("cv-10"), CTX)).toMatchObject({ reason: "new_reply", text: "New reply · 40 min" }); // B: Ramiro wrote again
    expect(attentionOf(conv("cv-05"), CTX)).toMatchObject({ reason: "new_reply" }); // C: Diego answered the brand
    expect(attentionOf(conv("cv-04"), CTX)).toMatchObject({ reason: "reply_unconfirmed", text: "Reply not confirmed", warn: true });
    expect(attentionOf(conv("cv-06"), CTX)).toMatchObject({ reason: "connection", warn: true });
  });

  it("a fresh unanswered comment inside the target is Open, not attention; labels, Urgent and AI never create it", () => {
    for (const id of ["cv-37", "cv-38", "cv-39"]) {
      expect(attentionOf(conv(id), CTX), id).toBeUndefined();
      expect(inView(conv(id), "open", CTX)).toBe(true);
      expect(quietStateOf(conv(id), CTX)).toMatch(/^No reply yet · \d+ min$/);
    }
    // cv-38 carries no label; adding Urgent to an in-target conversation does not make it attention.
    const urgent = ok(setUrgent(SEED_WORKFLOW, "manager", "cv-38", true));
    expect(attentionOf(conv("cv-38"), { ...CTX, wf: urgent })).toBeUndefined();
  });

  it("the target is a test value: 1 hour puts more conversations in Needs attention, 8 hours fewer", () => {
    const at = (target: number): number => viewCounts({ ...CTX, target }).attention;
    expect(at(60)).toBeGreaterThan(at(240));
    expect(at(240)).toBeGreaterThan(at(480));
  });

  it("precedence: an unconfirmed reply wins over the connection, which wins over a new reply and waiting", () => {
    const failing = startOp(EMPTY_SIM, { kind: "reply", conversationId: "cv-06", commentId: "cv-06-m00", text: "x", at: nowOf(SEED_WORKFLOW) });
    const failed = answerOp(failing.sim, failing.id, "failed");
    expect(attentionOf(conv("cv-06"), { ...CTX, sim: failed })).toMatchObject({ reason: "reply_unconfirmed", text: "Reply failed" });
    expect(attentionOf(conv("cv-06"), { ...CTX, allHealthy: true })).toMatchObject({ reason: "waiting" });
  });

  it("A2: a confirmed reply clears waiting; the conversation stays Open; a Done one needs no attention", () => {
    const wf = SEED_WORKFLOW;
    const started = startOp(SEED_SIM, { kind: "reply", conversationId: "cv-07", commentId: "cv-07-m00", text: "Both!", at: nowOf({ ...wf, clock: 1 }) });
    expect(attentionOf(conv("cv-07"), { ...CTX, sim: started.sim })).toMatchObject({ reason: "waiting" }); // Sending is not an answer yet
    const sent = answerOp(started.sim, started.id, "sent");
    const after = { ...CTX, sim: sent, wf: { ...wf, clock: 2 } };
    expect(attentionOf(conv("cv-07"), after)).toBeUndefined();
    expect(flowOf(after.wf, "cv-07").status).toBe("open");
    expect(quietStateOf(conv("cv-07"), after)).toBe("You replied · 1 min");
    expect(resolutionAfterReply("cv-07", sent)).toBe("replied_publicly");
    // An unknown outcome is attention ("Reply not confirmed"), never a resolved conversation.
    const unknown = answerOp(started.sim, started.id, "checking");
    expect(attentionOf(conv("cv-07"), { ...CTX, sim: unknown })).toMatchObject({ reason: "reply_unconfirmed" });
    const done = ok(markDone(wf, "manager", "standard", "cv-10", "replied_publicly", SEED_SIM));
    expect(attentionOf(conv("cv-10"), { ...CTX, wf: done })).toBeUndefined();
  });

  it("the author writing again after the brand's reply is a new reply, at once (no target)", () => {
    const wf = audienceWritesAgain(SEED_WORKFLOW, conv("cv-08"));
    const live = liveOf(conv("cv-08"), wf);
    expect(live.comments.at(-1)?.author).toEqual({ kind: "audience", name: "tomas.brews" });
    expect(attentionOf(live, { ...CTX, wf })).toMatchObject({ reason: "new_reply" });
    expect(attentionOf(live, { ...CTX, wf })?.text).toMatch(/^New reply · [01] min$/);
  });

  it("durations read the way people say them", () => {
    expect([durationText(0), durationText(40), durationText(70), durationText(240), durationText(250), durationText(3000)]).toEqual(["0 min", "40 min", "1 h 10 min", "4 h", "4 h", "2 d"]);
  });
});

describe("conversation management (hypotheses: Urgent ≠ Escalate; Done needs a person and a resolution)", () => {
  it("assign and unassign record who did it; Analyst cannot manage; the same assignee twice changes nothing", () => {
    const assigned = ok(assignConversation(SEED_WORKFLOW, "agent", "cv-07", "m-carla"));
    expect(flowOf(assigned, "cv-07").assignee).toBe("m-carla");
    expect(assigned.activity.at(-1)).toMatchObject({ conversationId: "cv-07", by: "Ana Ruiz", text: "Assigned to Carla Méndez" });
    expect(assignConversation(assigned, "agent", "cv-07", "m-carla")).toEqual({ ok: false, reason: "It's already assigned to Carla Méndez." });
    expect(flowOf(ok(assignConversation(assigned, "manager", "cv-07", undefined)), "cv-07").assignee).toBeUndefined();
    expect(assignConversation(SEED_WORKFLOW, "analyst", "cv-07", "m-carla")).toEqual({ ok: false, reason: "Your role can't manage conversations." });
    expect(assignConversation(SEED_WORKFLOW, "manager", "cv-07", "m-nobody").ok).toBe(false);
  });

  it("Urgent is a person's flag; escalation is a hand-off; each exists without the other", () => {
    const urgent = ok(setUrgent(SEED_WORKFLOW, "agent", "cv-07", true));
    expect(flowOf(urgent, "cv-07")).toMatchObject({ urgent: { by: "Ana Ruiz" } });
    expect(flowOf(urgent, "cv-07").escalation).toBeUndefined();
    const escalated = ok(escalateConversation(SEED_WORKFLOW, "agent", "cv-07", "Finance", "  refund over limit "));
    expect(flowOf(escalated, "cv-07")).toMatchObject({ escalation: { to: "Finance", note: "refund over limit" } });
    expect(flowOf(escalated, "cv-07").urgent).toBeUndefined();
    expect(escalated.activity.at(-1)?.text).toBe("Escalated to Finance — “refund over limit”");
    expect(flowOf(ok(closeEscalation(escalated, "agent", "cv-07")), "cv-07").escalation).toBeUndefined();
    expect(setUrgent(urgent, "agent", "cv-07", true).ok).toBe(false);
  });

  it("Mark done needs a resolution; it clears Urgent and the escalation but keeps their record; Reopen brings it back", () => {
    const urgent = ok(escalateConversation(ok(setUrgent(SEED_WORKFLOW, "manager", "cv-07", true)), "manager", "cv-07", "Product", ""));
    const done = ok(markDone(urgent, "agent", "standard", "cv-07", "no_reply_needed", SEED_SIM));
    // UX-08A: Done records when (the simulated clock, the moment of its history entry); Reopen removes it.
    expect(flowOf(done, "cv-07")).toEqual({ status: "done", resolution: "no_reply_needed", resolvedAt: "2026-11-17T15:05:00Z" });
    expect(done.activity.at(-1)?.at).toBe("2026-11-17T15:05:00Z");
    expect(done.activity.filter((entry) => entry.conversationId === "cv-07").map((entry) => entry.text)).toEqual(["Marked urgent", "Escalated to Product", "Urgent cleared when marked done", "Escalation to Product closed when marked done", "Marked done · No reply needed"]);
    expect(markDone(done, "agent", "standard", "cv-07", "replied_publicly", SEED_SIM)).toEqual({ ok: false, reason: "It's already done." });
    expect(setUrgent(done, "agent", "cv-07", true)).toEqual({ ok: false, reason: "Reopen the conversation to mark it urgent." });
    expect(flowOf(ok(reopenConversation(done, "agent", "cv-07")), "cv-07")).toEqual({ status: "open" });
  });

  it("'Reviewed' is a resolution of a Monitor-only workspace only; management itself is allowed in Monitor-only", () => {
    expect(resolutionsFor("standard").map((item) => item.id)).not.toContain("reviewed");
    expect(resolutionsFor("monitor").map((item) => item.id)).toContain("reviewed");
    expect(markDone(SEED_WORKFLOW, "manager", "standard", "cv-07", "reviewed", SEED_SIM).ok).toBe(false);
    expect(markDone(SEED_WORKFLOW, "manager", "monitor", "cv-07", "reviewed", SEED_SIM).ok).toBe(true);
  });

  it("a new reply reopens a Done conversation by itself, recorded as Wrenkind's change", () => {
    const wf = audienceWritesAgain(SEED_WORKFLOW, conv("cv-02"));
    expect(flowOf(SEED_WORKFLOW, "cv-02").status).toBe("done");
    expect(flowOf(wf, "cv-02").status).toBe("open");
    expect(wf.activity.at(-1)).toMatchObject({ by: "Wrenkind", text: "Reopened automatically: joaquin.rv wrote again" });
  });

  it("notes are internal, trimmed and bounded", () => {
    expect(addNote(SEED_WORKFLOW, "agent", "cv-07", "   ").ok).toBe(false);
    expect(addNote(SEED_WORKFLOW, "agent", "cv-07", "x".repeat(501)).ok).toBe(false);
    expect(ok(addNote(SEED_WORKFLOW, "agent", "cv-07", " sent to sales ")).activity.at(-1)?.text).toBe("Note: “sent to sales”");
  });

  it("the activity of a conversation lists recorded changes and earlier published replies, newest first", () => {
    const entries = historyOf(conv("cv-10"), SEED_WORKFLOW, "planned");
    expect(entries.map((entry) => entry.text).sort()).toEqual(["Assigned to Bruno Díaz", "Marked urgent", "Replied publicly from Wrenkind · Sent"]);
    for (let index = 1; index < entries.length; index += 1) expect((entries[index - 1]?.at ?? "") >= (entries[index]?.at ?? "")).toBe(true);
    // Member names are planned read-model data: today the published reply says only who in general requested it.
    expect(historyOf(conv("cv-10"), SEED_WORKFLOW, "today").find((entry) => entry.text.startsWith("Replied publicly"))?.by).toBe("A member of this workspace");
  });
});

describe("views, filters, search and sort", () => {
  it("views: Needs attention ⊂ Open; Assigned to me is Ana's open work; Escalated and Done are workflow", () => {
    const attention = listOf("attention", NO_FILTERS, "", "attention", CTX);
    const open = listOf("open", NO_FILTERS, "", "attention", CTX);
    for (const item of attention) expect(ids(open)).toContain(item.id);
    expect(attention.length).toBeLessThan(open.length);
    expect(ids(listOf("mine", NO_FILTERS, "", "newest", CTX)).sort()).toEqual(["cv-03", "cv-04", "cv-51"]);
    expect(ids(listOf("escalated", NO_FILTERS, "", "newest", CTX))).toEqual(["cv-03"]);
    expect(listOf("done", NO_FILTERS, "", "attention", CTX).every((item) => flowOf(SEED_WORKFLOW, item.id).status === "done")).toBe(true);
  });

  it("attention first: a person's Urgent leads, then the reason's precedence, then the longest wait", () => {
    const attention = ids(listOf("attention", NO_FILTERS, "", "attention", CTX));
    expect(attention[0]).toBe("cv-10"); // Urgent
    expect(attention[1]).toBe("cv-04"); // Reply not confirmed
    expect(attention.indexOf("cv-07")).toBe(attention.length - 1); // the shortest wait past the target
  });

  it("filters combine; each chip removes one criterion; the Filters badge counts only its own", () => {
    let filters = withFilter(NO_FILTERS, "label", "lbl-wholesale");
    filters = withFilter(filters, "platform", "facebook");
    filters = { ...filters, accounts: ["acc-fb-main"] };
    // cv-49 (UX-08A: received in October, never answered) is still Open work: an operational view lists it at all dates.
    expect(ids(listOf("open", filters, "", "newest", CTX)).sort()).toEqual(["cv-05", "cv-22", "cv-42", "cv-49"]);
    filters = withFilter(filters, "assignee", "m-carla");
    expect(ids(listOf("open", filters, "", "newest", CTX)).sort()).toEqual(["cv-05", "cv-22", "cv-42"]);
    expect(activeFilters(filters, LABELS).map((chip) => `${chip.name}: ${chip.value}`)).toEqual(["Platform: Facebook", "Label: Wholesale lead", "Account: Lumen Coffee", "Assignee: Carla Méndez"]);
    expect(menuFilterCount(filters)).toBe(2);
    expect(withoutFilter(filters, "account:acc-fb-main").accounts).toEqual([]);
    expect(withoutFilter(filters, "assignee").assignee).toBeUndefined();
    expect(withFilter(filters, "label", undefined).label).toBeUndefined();
    expect(ids(listOf("open", withFilter(NO_FILTERS, "assignee", "unassigned"), "", "newest", CTX))).not.toContain("cv-05");
    expect(ids(listOf("attention", withFilter(NO_FILTERS, "reason", "connection"), "", "attention", CTX)).sort()).toEqual(["cv-06", "cv-24", "cv-33"]);
  });

  it("search finds words of a comment or an author, ignoring case and accents; no match is an empty list", () => {
    expect(matchesQuery(conv("cv-10"), "PLATA", EMPTY_SIM)).toBe(true);
    expect(matchesQuery(conv("cv-03"), "lactosa martina", EMPTY_SIM)).toBe(true);
    expect(matchesQuery(conv("cv-41"), "laura sanchez", EMPTY_SIM)).toBe(true); // "Laura Sánchez"
    expect(listOf("open", NO_FILTERS, "nothing matches this", "newest", CTX)).toEqual([]);
  });

  it("the pinned selection keeps its place after it leaves the view, and is gone once unpinned", () => {
    const list = listOf("attention", NO_FILTERS, "", "attention", CTX);
    const index = ids(list).indexOf("cv-07");
    const done = ok(markDone(SEED_WORKFLOW, "manager", "standard", "cv-07", "no_reply_needed", SEED_SIM));
    const after = listOf("attention", NO_FILTERS, "", "attention", { ...CTX, wf: done });
    expect(ids(after)).not.toContain("cv-07");
    expect(ids(withPin(after, { id: "cv-07", index }, done)).indexOf("cv-07")).toBe(index);
    expect(withPin(after, undefined, done)).toBe(after);
    expect(new Set(ids(withPin(list, { id: "cv-07", index: 0 }, SEED_WORKFLOW))).size).toBe(list.length); // never a duplicate row
  });
});

describe("label management (Settings › Labels, the proposed labels.manage)", () => {
  it("rename follows the name rules against the other labels; only managers manage", () => {
    const renamed = renameLabel(LABELS, "manager", "lbl-follow", "  Follow up  later ");
    expect(renamed.ok && renamed.state.labels.find((label) => label.id === "lbl-follow")?.name).toBe("Follow up later");
    expect(renameLabel(LABELS, "manager", "lbl-follow", "delivery")).toEqual({ ok: false, problem: "duplicate" });
    expect(renameLabel(LABELS, "manager", "lbl-follow", " ")).toEqual({ ok: false, problem: "empty" });
    expect(renameLabel(LABELS, "manager", "lbl-follow", "Follow up Monday").ok).toBe(true); // its own name is not a duplicate
    expect(renameLabel(LABELS, "agent", "lbl-follow", "Later")).toEqual({ ok: false, problem: "not_allowed" });
  });

  it("the approved palette (Amendment 2): five identifiers, gray the default; Brown and color values are refused", () => {
    expect(MARKERS.map((item) => item.id)).toEqual(["gray", "teal", "plum", "magenta", "olive"]);
    expect(DEFAULT_MARKER).toBe("gray");
    for (const id of ["gray", "teal", "plum", "magenta", "olive"]) expect(setMarker(LABELS, "manager", "lbl-follow", id).ok, id).toBe(true);
    for (const bad of ["brown", "#7E5A44", "Teal", "", "red"]) expect(setMarker(LABELS, "manager", "lbl-follow", bad), bad).toEqual({ ok: false, problem: "marker_unknown" });
    expect(isMarker("brown")).toBe(false);
  });

  it("a color belongs to the workspace label (an identifier, never a value): every conversation carrying it follows; reset is gray", () => {
    const teal = setMarker(LABELS, "manager", "lbl-follow", "teal");
    if (!teal.ok) throw new Error("not set");
    const label = teal.state.labels.find((item) => item.id === "lbl-follow");
    expect(label?.marker).toBe("teal");
    expect(teal.state.assignments).toBe(LABELS.assignments); // no conversation changes: the label carries the color
    for (const [conversationId, ids] of Object.entries(teal.state.assignments)) if (ids.includes("lbl-follow")) expect(labelsOn(teal.state, conversationId)).toContain("lbl-follow");
    const reset = setMarker(teal.state, "manager", "lbl-follow", DEFAULT_MARKER);
    expect(reset.ok && markerOf(reset.state.labels.find((item) => item.id === "lbl-follow") ?? { id: "", name: "" })).toBe("gray");
    // Seeded labels with no color are gray; the four configured ones keep theirs.
    expect(LABELS.labels.map((item) => `${item.name}:${markerOf(item)}`)).toEqual(["Delivery:gray", "Refund request:magenta", "Praise:plum", "Wholesale lead:teal", "Follow up Monday:gray", "Allergens:olive"]);
  });

  it("only label managers change colors, create with a color, or save name and color together — all or nothing", () => {
    for (const role of ["agent", "analyst", "guest"] as const) {
      expect(setMarker(LABELS, role, "lbl-follow", "teal"), role).toEqual({ ok: false, problem: "not_allowed" });
      expect(createLabel(LABELS, role, "New", undefined, "teal"), role).toEqual({ ok: false, problem: "not_allowed" });
    }
    const created = createLabel(LABELS, "manager", "Supplier inquiry", "cv-07", "plum");
    expect(created.ok && created.label).toMatchObject({ name: "Supplier inquiry", marker: "plum" });
    expect(createLabel(LABELS, "manager", "Supplier inquiry", undefined).ok && "gray").toBe("gray");
    expect(createLabel(LABELS, "manager", "Supplier inquiry", undefined, "brown")).toEqual({ ok: false, problem: "marker_unknown" });
    const both = updateLabel(LABELS, "owner", "lbl-follow", "Follow up later", "olive");
    expect(both.ok && both.state.labels.find((item) => item.id === "lbl-follow")).toMatchObject({ name: "Follow up later", marker: "olive" });
    expect(updateLabel(LABELS, "owner", "lbl-follow", "Delivery", "olive")).toEqual({ ok: false, problem: "duplicate" }); // nothing applied
    expect(updateLabel(LABELS, "owner", "lbl-follow", "Later", "brown")).toEqual({ ok: false, problem: "marker_unknown" });
    expect(manageProblemText("marker_unknown")).toBe("Choose one of the label colors.");
  });

  it("a color is presentation only: it changes no list, count, filter, attention or order", () => {
    const magenta = setMarker(LABELS, "manager", "lbl-follow", "magenta");
    if (!magenta.ok) throw new Error("not set");
    const after: WorkContext = { ...CTX, labels: magenta.state };
    for (const view of ["attention", "open", "done"] as const) expect(ids(listOf(view, NO_FILTERS, "", "attention", after)), view).toEqual(ids(listOf(view, NO_FILTERS, "", "attention", CTX)));
    expect(viewCounts(after)).toEqual(viewCounts(CTX));
    expect(ids(listOf("open", withFilter(NO_FILTERS, "label", "lbl-follow"), "", "newest", after))).toEqual(ids(listOf("open", withFilter(NO_FILTERS, "label", "lbl-follow"), "", "newest", CTX)));
  });

  it("deleting a label removes it from every conversation and deletes no conversation or comment; they are named for the record", () => {
    expect(labelUsage(LABELS, "lbl-refund")).toBe(5);
    expect(conversationsWithLabel(LABELS, "lbl-refund")).toEqual(["cv-04", "cv-10", "cv-19", "cv-26", "cv-34"]);
    const deleted = deleteLabel(LABELS, "manager", "lbl-refund");
    if (!deleted.ok) throw new Error("not deleted");
    expect(deleted.removedFrom).toHaveLength(5);
    expect(deleted.state.labels.some((label) => label.id === "lbl-refund")).toBe(false);
    expect(labelsOn(deleted.state, "cv-10")).toEqual(["lbl-delivery"]);
    expect(CONVERSATIONS.find((item) => item.id === "cv-10")?.comments.length).toBe(3);
    expect(deleteLabel(LABELS, "agent", "lbl-refund").ok).toBe(false);
  });
});

describe("destructive retries", () => {
  it("a failed Delete or Block is offered again only through its confirmation; Hide may simply be tried again", () => {
    expect(confirmsBeforeRetry("delete")).toBe(true);
    expect(confirmsBeforeRetry("block")).toBe(true);
    expect(confirmsBeforeRetry("unblock")).toBe(true);
    expect(confirmsBeforeRetry("hide")).toBe(false);
  });
});

/* ───────────── UX-05: independent audit remediation ───────────── */

/** Start a simulated operation and, when given, answer it — the prototype's two steps in one. */
const op = (sim: SimState, kind: OpKind, conversationId: string, commentId: string, answer?: "sent" | "failed" | "checking" | "blocked", extra: { readonly answering?: string; readonly at?: string; readonly targetId?: string } = {}): SimState => {
  const started = startOp(sim, { kind, conversationId, commentId, text: "x", at: extra.at ?? nowOf(SEED_WORKFLOW), ...(extra.answering === undefined ? {} : { answering: extra.answering }), ...(extra.targetId === undefined ? {} : { targetId: extra.targetId }) });
  return answer === undefined ? started.sim : answerOp(started.sim, started.id, answer);
};
const reason = (id: string, sim: SimState) => attentionOf(conv(id), { ...CTX, sim });

describe("UX-05 H-1: every unresolved outgoing reply counts, by its own identity", () => {
  it("a new Sending reply never hides an earlier failure on another comment, and its Sent doesn't resolve it", () => {
    const failed = op(EMPTY_SIM, "reply", "cv-10", "cv-10-m00", "failed");
    const sending = op(failed, "reply", "cv-10", "cv-10-m02");
    expect(reason("cv-10", sending)).toMatchObject({ reason: "reply_unconfirmed", text: "Reply failed" });
    const otherSent = op(failed, "reply", "cv-10", "cv-10-m02", "sent");
    expect(reason("cv-10", otherSent)).toMatchObject({ reason: "reply_unconfirmed", text: "Reply failed" });
    expect(unresolvedReplies("cv-10", otherSent).map((item) => item.commentId)).toEqual(["cv-10-m00"]);
    // Only a reply to the same comment, confirmed Sent, resolves it.
    const fixed = op(otherSent, "reply", "cv-10", "cv-10-m00", "sent");
    expect(unresolvedReplies("cv-10", fixed)).toEqual([]);
    expect(reason("cv-10", fixed)?.reason).not.toBe("reply_unconfirmed");
  });

  it("a retry still Sending, Failed or Stopped leaves the earlier failure unresolved", () => {
    const failed = op(EMPTY_SIM, "reply", "cv-07", "cv-07-m00", "failed");
    for (const next of [undefined, "failed", "blocked"] as const) {
      const after = op(failed, "reply", "cv-07", "cv-07-m00", next);
      expect(unresolvedReplies("cv-07", after).length, String(next)).toBe(next === undefined ? 1 : 2);
      expect(reason("cv-07", after)?.reason).toBe("reply_unconfirmed");
    }
    expect(reason("cv-07", op(EMPTY_SIM, "reply", "cv-07", "cv-07-m00", "blocked"))).toMatchObject({ text: "Reply stopped" });
  });

  it("Checking is resolved only by its own outcome; several unresolved replies are counted and the most uncertain named", () => {
    const checking = op(EMPTY_SIM, "reply", "cv-10", "cv-10-m00", "checking", { at: "2026-11-17T15:01:00Z" });
    const plusSent = op(checking, "reply", "cv-10", "cv-10-m00", "sent");
    expect(unresolvedReplies("cv-10", plusSent).map((item) => item.status)).toEqual(["checking"]);
    const both = op(checking, "private_reply", "cv-10", "cv-10-m02", "failed", { at: "2026-11-17T15:02:00Z" });
    expect(reason("cv-10", both)).toMatchObject({ reason: "reply_unconfirmed", text: "2 replies not confirmed", since: "2026-11-17T15:01:00Z", warn: true });
    const checkingId = both.ops.find((item) => item.status === "checking")?.id ?? "";
    expect(reason("cv-10", answerOp(both, checkingId, "sent"))).toMatchObject({ text: "Reply failed" });
  });

  it("identity is the kind and the exact comment answered (a public reply never resolves a private one)", () => {
    const privateFailed = op(EMPTY_SIM, "private_reply", "cv-07", "cv-07-m00", "failed");
    expect(unresolvedReplies("cv-07", op(privateFailed, "reply", "cv-07", "cv-07-m00", "sent"))).toHaveLength(1);
  });

  it("a failed moderation action is not a reply; precedence still puts an unconfirmed reply above the connection", () => {
    expect(unresolvedReplies("cv-10", op(EMPTY_SIM, "hide", "cv-10", "cv-10-m00", "failed"))).toEqual([]);
    expect(reason("cv-06", op(EMPTY_SIM, "reply", "cv-06", "cv-06-m00", "checking"))).toMatchObject({ reason: "reply_unconfirmed" });
    expect(reason("cv-04", SEED_SIM)).toMatchObject({ reason: "reply_unconfirmed", text: "Reply not confirmed" });
  });
});

describe("UX-05 H-2: Done never while a reply's outcome is unknown, and never claims a reply that isn't confirmed", () => {
  it("Sending and Checking block Done, with the reason; the record is left untouched", () => {
    const sending = op(EMPTY_SIM, "reply", "cv-07", "cv-07-m00");
    const refused = markDone(SEED_WORKFLOW, "manager", "standard", "cv-07", "no_reply_needed", sending);
    expect(refused).toEqual({ ok: false, reason: "A reply is still being sent. Mark it done once it's confirmed sent or has failed." });
    expect(doneBlocker("cv-04", SEED_SIM)).toMatch(/still being checked/);
    expect(markDone(SEED_WORKFLOW, "manager", "standard", "cv-04", "replied_on_platform", SEED_SIM).ok).toBe(false);
    expect(markDone(SEED_WORKFLOW, "manager", "monitor", "cv-04", "reviewed", SEED_SIM).ok).toBe(false);
    // A moderation action in flight blocks it too; any other conversation is unaffected.
    expect(doneBlocker("cv-10", op(EMPTY_SIM, "hide", "cv-10", "cv-10-m00"))).toMatch(/still waiting for its outcome/);
    expect(markDone(SEED_WORKFLOW, "manager", "standard", "cv-07", "no_reply_needed", SEED_SIM).ok).toBe(true);
  });

  it("'Replied publicly' / 'Replied privately' are unavailable until a reply of that kind is confirmed Sent", () => {
    const choice = (sim: SimState, id: "replied_publicly" | "replied_privately") => resolutionChoices("standard", "cv-07", sim).find((item) => item.id === id);
    expect(choice(EMPTY_SIM, "replied_publicly")?.unavailable).toBe("No public reply from Wrenkind is confirmed sent in this conversation.");
    expect(choice(EMPTY_SIM, "replied_privately")?.unavailable).toBeDefined();
    expect(markDone(SEED_WORKFLOW, "manager", "standard", "cv-07", "replied_publicly", EMPTY_SIM)).toEqual({ ok: false, reason: "No public reply from Wrenkind is confirmed sent in this conversation." });
    const failed = op(EMPTY_SIM, "reply", "cv-07", "cv-07-m00", "failed");
    expect(choice(failed, "replied_publicly")?.unavailable).toBeDefined(); // a failed reply is not a reply
    expect(choice(op(EMPTY_SIM, "private_reply", "cv-07", "cv-07-m00", "sent"), "replied_privately")?.unavailable).toBeUndefined();
    expect(choice(op(EMPTY_SIM, "private_reply", "cv-07", "cv-07-m00", "sent"), "replied_publicly")?.unavailable).toBeDefined();
    // A reply published earlier from Wrenkind counts; "Replied on the platform" is the person's statement, always offered.
    expect(resolutionChoices("standard", "cv-10", EMPTY_SIM).find((item) => item.id === "replied_publicly")?.unavailable).toBeUndefined();
    expect(resolutionChoices("standard", "cv-07", EMPTY_SIM).find((item) => item.id === "replied_on_platform")?.unavailable).toBeUndefined();
  });

  it("once the outcome is known, Done is possible — with the resolution the confirmed reply supports, and nothing inferred", () => {
    const checking = op(EMPTY_SIM, "reply", "cv-07", "cv-07-m00", "checking");
    const id = checking.ops[0]?.id ?? "";
    const sent = answerOp(checking, id, "sent");
    const done = markDone(SEED_WORKFLOW, "manager", "standard", "cv-07", "replied_publicly", sent);
    expect(done.ok).toBe(true);
    const failed = answerOp(checking, id, "failed");
    expect(markDone(SEED_WORKFLOW, "manager", "standard", "cv-07", "replied_publicly", failed).ok).toBe(false);
    const closed = ok(markDone(SEED_WORKFLOW, "manager", "standard", "cv-07", "replied_on_platform", failed));
    expect(flowOf(closed, "cv-07")).toEqual({ status: "done", resolution: "replied_on_platform", resolvedAt: "2026-11-17T15:01:00Z" });
    // Choosing a resolution never marks a reply as delivered: the failure stays in the simulated record.
    expect(failed.ops[0]?.status).toBe("failed");
    expect(unresolvedReplies("cv-07", failed)).toHaveLength(1);
    // Reopened, the conversation is in Needs attention again for that failure.
    expect(attentionOf(conv("cv-07"), { ...CTX, sim: failed, wf: ok(reopenConversation(closed, "manager", "cv-07")) })).toMatchObject({ reason: "reply_unconfirmed", text: "Reply failed" });
  });
});

describe("UX-05 M-2: comments on ads — replying and moderating are not validated", () => {
  const avail = (id: string, action: "reply" | "private_reply" | "hide") => {
    const conversation = conv(id);
    const comment = conversation.comments[0];
    if (comment === undefined) throw new Error(id);
    return availabilityOf({ action, role: "manager", mode: "standard", actions: "simulate", accountHealth: "healthy", conversation, comment, sim: EMPTY_SIM });
  };
  it("public and private replies on an ad (Instagram ad, Facebook dark post) are unavailable, with the reason", () => {
    for (const id of ["cv-14", "cv-43", "cv-28", "cv-47"]) {
      expect(avail(id, "reply"), id).toEqual({ kind: "unavailable", cause: "platform", reason: "Replying to comments on ads isn't validated in Wrenkind yet." });
      expect(avail(id, "private_reply"), id).toMatchObject({ kind: "unavailable", cause: "platform" });
      expect(avail(id, "hide"), id).toEqual({ kind: "unavailable", cause: "platform", reason: "Not available yet for comments on ads." });
    }
    // Story ads stay in the Instagram app; ordinary organic posts keep their simulated actions.
    expect(avail("cv-48", "reply")).toMatchObject({ kind: "unavailable", reason: "Comments on story ads can only be managed in the Instagram app." });
    expect(avail("cv-07", "reply")).toEqual({ kind: "available" });
    expect(avail("cv-41", "private_reply")).toEqual({ kind: "available" }); // organic and paid: the Page's own post (H-17)
  });

  it("the revalidation at the moment of acting refuses it too", () => {
    const conversation = conv("cv-43");
    const comment = conversation.comments[0];
    if (comment === undefined) throw new Error("cv-43");
    expect(opAvailability({ role: "owner", mode: "standard", actions: "simulate", accountHealth: "healthy", conversation, comment, sim: EMPTY_SIM }, "reply").kind).toBe("unavailable");
  });
});

describe("UX-05: why the selected conversation leaves the list is said from what is true", () => {
  it("Done, a confirmed reply, another view change, or no longer matching the filters", () => {
    const done = ok(markDone(SEED_WORKFLOW, "manager", "standard", "cv-07", "no_reply_needed", SEED_SIM));
    expect(leavingNote(conv("cv-07"), "attention", { ...CTX, wf: done })).toBe("Done · No reply needed · leaves this list when you move on");
    const replied = op(SEED_SIM, "reply", "cv-07", "cv-07-m00", "sent", { at: "2026-11-17T15:01:00Z" });
    expect(leavingNote(conv("cv-07"), "attention", { ...CTX, sim: replied })).toBe("Reply sent · leaves this list when you move on");
    // Out of Needs attention for another reason (its only comment was hidden): never "Reply sent".
    expect(leavingNote(conv("cv-07"), "attention", { ...CTX, sim: op(SEED_SIM, "hide", "cv-07", "cv-07-m00", "sent") })).toBe("No longer in Needs attention · leaves this list when you move on");
    const moved = ok(assignConversation(SEED_WORKFLOW, "manager", "cv-03", "m-bruno"));
    expect(leavingNote(conv("cv-03"), "mine", { ...CTX, wf: moved })).toBe("No longer in Assigned to me · leaves this list when you move on");
    const closed = ok(closeEscalation(SEED_WORKFLOW, "manager", "cv-03"));
    expect(leavingNote(conv("cv-03"), "escalated", { ...CTX, wf: closed })).toBe("No longer in Escalated · leaves this list when you move on");
    expect(leavingNote(conv("cv-07"), "open", CTX)).toBe("No longer matches · leaves this list when you move on");
  });
});

describe("UX-05: header menus are sized by themselves, never by the control they open from", () => {
  const css = readFileSync("app/dev/ui-reference/comments-redesign/prototype.module.css", "utf8");
  const rule = (selector: string): string => {
    const start = css.indexOf(`\n${selector} {`);
    if (start < 0) throw new Error(selector);
    return css.slice(start, css.indexOf("}", start));
  };
  it("a header menu has its own width and a window-relative max-width (a % would be a share of a 32px button)", () => {
    expect(rule(".popover")).toMatch(/max-width: 100%;/); // in-flow panels: a share of the comment, which is right
    const head = rule(".headMenu");
    expect(head).toMatch(/position: absolute;/);
    expect(head).toMatch(/width: \d+px;/);
    expect(head).toMatch(/max-width: calc\(100vw - .*\);/);
    expect(head).not.toMatch(/max-width: [\d.]+%/);
    expect(head).toMatch(/overflow-y: auto;/);
    expect(css.indexOf("\n.headMenu {")).toBeGreaterThan(css.indexOf("\n.popover {")); // declared later: it wins
  });
  it("below 1024 px Details hides the page behind it and keeps its title focusable (visually hidden, not removed)", () => {
    const tablet = css.slice(css.indexOf("@media (max-width: 1023px)"), css.indexOf("@media (max-width: 639px)"));
    expect(tablet).toMatch(/\.drawerOpen \{\s*visibility: hidden;/);
    expect(tablet).toMatch(/\.drawerOpen \.drawer \{\s*visibility: visible;/);
    expect(tablet).toMatch(/\.drawerTitle \{[^}]*clip-path: inset\(50%\);/);
    expect(tablet).not.toMatch(/\.drawerTitle[^{]*\{[^}]*display: none/);
    expect(tablet).toMatch(/\.fpillRemove \{\s*width: 44px;\s*height: 44px;/);
  });
});

/* ───────────── UX-05-FINALFIX R-1: an Instagram reply is identified by the exact comment it answers ───────────── */

describe("UX-05-FINALFIX R-1: replies under one Instagram top-level comment never resolve one another", () => {
  // cv-12 (Instagram, organic): valen.cafe m00 (top level) · camila.r m01 · valen.cafe m02 · camila.r m03 · brand m04.
  const thread = conv("cv-12");
  const comment = (index: number) => {
    const found = thread.comments[index];
    if (found === undefined) throw new Error(String(index));
    return found;
  };
  /** A reply as the prototype starts it: the platform's target (the top level on Instagram) and the exact comment. */
  const replyTo = (sim: SimState, index: number, answer?: "sent" | "failed" | "checking" | "blocked"): SimState => {
    const where = replyTargetOf(thread, comment(index), "instagram");
    return op(sim, "reply", "cv-12", where.commentId, answer, { targetId: comment(index).id, ...(where.answering === undefined ? {} : { answering: where.answering }) });
  };

  it("the platform target and the exact comment are kept apart: same root and same person, two identities", () => {
    expect(replyTargetOf(thread, comment(1), "instagram")).toEqual({ commentId: "cv-12-m00", answering: "camila.r" });
    expect(replyTargetOf(thread, comment(3), "instagram")).toEqual({ commentId: "cv-12-m00", answering: "camila.r" });
    const both = replyTo(replyTo(EMPTY_SIM, 1, "failed"), 3, "sent");
    expect(both.ops.map((item) => [item.commentId, item.targetId])).toEqual([["cv-12-m00", "cv-12-m01"], ["cv-12-m00", "cv-12-m03"]]);
    expect(new Set(both.ops.map(replyIdentity)).size).toBe(2);
    // On Facebook, and for anything addressed to the comment itself, the target is the comment.
    expect(op(EMPTY_SIM, "reply", "cv-10", "cv-10-m02").ops[0]?.targetId).toBe("cv-10-m02");
  });

  it("Failed on camila.r's first comment, Sent on her second: the failure stays, and so does the attention", () => {
    const sim = replyTo(replyTo(EMPTY_SIM, 1, "failed"), 3, "sent");
    expect(unresolvedReplies("cv-12", sim).map((item) => item.targetId)).toEqual(["cv-12-m01"]);
    expect(reason("cv-12", sim)).toMatchObject({ reason: "reply_unconfirmed", text: "Reply failed" });
  });

  it("Failed and then Sent to the same exact comment resolves it (the approved rule: a confirmed Sent of the same reply)", () => {
    const sim = replyTo(replyTo(EMPTY_SIM, 1, "failed"), 1, "sent");
    expect(unresolvedReplies("cv-12", sim)).toEqual([]);
    expect(reason("cv-12", sim)?.reason).not.toBe("reply_unconfirmed");
  });

  it("several people in one thread: a reply to valen.cafe never resolves camila.r's, nor the reverse", () => {
    const valenFailed = replyTo(EMPTY_SIM, 2, "failed");
    expect(unresolvedReplies("cv-12", replyTo(replyTo(valenFailed, 1, "sent"), 3, "sent")).map((item) => item.targetId)).toEqual(["cv-12-m02"]);
    const camilaFailed = replyTo(EMPTY_SIM, 3, "failed");
    expect(unresolvedReplies("cv-12", replyTo(replyTo(camilaFailed, 0, "sent"), 2, "sent")).map((item) => item.targetId)).toEqual(["cv-12-m03"]);
  });

  it("Sending, Checking, Failed, Stopped and Sent across the thread: each is resolved only by its own outcome", () => {
    let sim = replyTo(EMPTY_SIM, 1, "failed"); // m01 failed
    sim = replyTo(sim, 2, "blocked"); // m02 stopped
    sim = replyTo(sim, 3, "checking"); // m03 checking
    expect(reason("cv-12", sim)).toMatchObject({ reason: "reply_unconfirmed", text: "3 replies not confirmed" });
    sim = replyTo(sim, 0); // the top-level comment: Sending — counts for nothing yet, hides nothing
    expect(unresolvedReplies("cv-12", sim).map((item) => item.targetId)).toEqual(["cv-12-m01", "cv-12-m02", "cv-12-m03"]);
    sim = answerOp(sim, sim.ops.at(-1)?.id ?? "", "sent"); // the top level Sent: still all three
    expect(unresolvedReplies("cv-12", sim)).toHaveLength(3);
    sim = answerOp(sim, sim.ops.find((item) => item.status === "checking")?.id ?? "", "sent"); // m03's own check: Sent
    sim = replyTo(sim, 2, "sent"); // m02 answered again: Sent
    expect(unresolvedReplies("cv-12", sim).map((item) => item.targetId)).toEqual(["cv-12-m01"]);
    expect(reason("cv-12", sim)).toMatchObject({ text: "Reply failed" });
  });

  it("the existing restrictions hold: one reply in flight per top-level comment on Instagram; one private reply per comment", () => {
    const input = (index: number, sim: SimState) => ({ role: "manager" as const, mode: "standard" as const, actions: "simulate" as const, accountHealth: "healthy" as const, conversation: thread, comment: comment(index), sim });
    const inFlight = replyTo(EMPTY_SIM, 1);
    expect(availabilityOf({ ...input(3, inFlight), action: "reply" })).toMatchObject({ kind: "unavailable", cause: "state" });
    expect(availabilityOf({ ...input(3, replyTo(EMPTY_SIM, 1, "failed")), action: "reply" })).toEqual({ kind: "available" });
    const privately = op(EMPTY_SIM, "private_reply", "cv-12", "cv-12-m01", "sent");
    expect(availabilityOf({ ...input(1, privately), action: "private_reply" })).toMatchObject({ kind: "unavailable", reason: "A private reply was already sent for this comment. Only one is allowed." });
    expect(availabilityOf({ ...input(3, privately), action: "private_reply" })).toEqual({ kind: "available" });
  });

  it("no false 'Reply sent': while a newer reply is Sending, the leaving note names no success", () => {
    const answered = op(SEED_SIM, "reply", "cv-07", "cv-07-m00", "sent", { at: "2026-11-17T15:01:00Z" });
    expect(leavingNote(conv("cv-07"), "attention", { ...CTX, sim: answered })).toBe("Reply sent · leaves this list when you move on");
    const another = op(answered, "reply", "cv-07", "cv-07-m00");
    expect(leavingNote(conv("cv-07"), "attention", { ...CTX, sim: another })).toBe("No longer in Needs attention · leaves this list when you move on");
  });
});
