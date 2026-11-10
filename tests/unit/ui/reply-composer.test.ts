/**
 * Step 7B-3 — the contextual reply composer and the conversation view around it, rendered statically: the closed
 * affordance, the write stage (label, counter, limit), the review stage posting EXACTLY the shown text as the hidden
 * field with the page's identifiers, the unavailable line with one reason, the outbound rows with their real states,
 * and what never appears (an action on the brand's own or hidden messages, an optimistic "Sent", raw HTML).
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversationDetail } from "@/server/inbox/inbox";
import { t } from "@/server/i18n";
import { ReplyComposer, type ReplyComposerLabels } from "@/ui/inbox/reply-composer";
import { ConversationView, replyOutcomeMessages } from "@/app/workspaces/[workspaceId]/inbox/views";

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const TARGET = "a1111111-1111-4111-8111-111111111111";
const HOSTILE = "<script>alert(1)</script> & <img src=x onerror=alert(2)>";
const escape = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const action = () => Promise.resolve({ kind: "idle" as const });

const labels: ReplyComposerLabels = {
  open: "Reply",
  heading: "Reply publicly",
  to: "Replying to caro.m",
  as: "As your Instagram account, visible to everyone",
  note: "On Instagram, replies attach to the top-level comment.",
  fieldLabel: "Your reply",
  fieldHelp: "Up to 2200 characters.",
  remaining: "{count} characters left",
  overLimit: "{count} characters over the limit",
  empty: "Write something before reviewing.",
  cancel: "Cancel",
  review: "Review reply",
  edit: "Edit",
  reviewHeading: "Review before publishing",
  reviewTextLabel: "This exact text will be published",
  reviewNote: "Publishing posts this reply on the platform.",
  publish: "Publish reply",
  publishing: "Publishing…",
};
const fields = { workspaceId: WS, conversationId: CONVERSATION, targetInteractionId: TARGET, idempotencyKey: "rk-11111111-2222-4333-8444-555555555555" };
const render = (stage: "closed" | "write" | "review", text = ""): string => renderToStaticMarkup(h(ReplyComposer, { action, fields, maxChars: 2200, labels, outcomes: replyOutcomeMessages(), initialStage: stage, initialText: text }));

describe("7B-3: the composer", () => {
  it("a requested reply is reported as a request, never as a delivery: neutral tone and the honest copy", () => {
    expect(t("inbox.reply.requested")).toBe("Reply requested. Delivery isn't confirmed yet.");
    expect(replyOutcomeMessages()["requested"]).toBe(t("inbox.reply.requested"));
  });

  it("closed: one discreet Reply button, no form, no textarea", () => {
    const html = render("closed");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>.*Reply<\/button>/);
    expect(html).not.toMatch(/<form|<textarea/);
  });

  it("write: a labelled textarea with the real limit, the counter, Cancel and Review — and still no form that posts", () => {
    const html = render("write", "Hola");
    expect(html).toMatch(/<label for="[^"]+"[^>]*>Your reply<\/label>/);
    expect(html).toMatch(/<textarea[^>]*aria-describedby="[^"]*"[^>]*>Hola<\/textarea>/);
    expect(html).toContain("2196 characters left");
    expect(html).toContain("Cancel");
    expect(html).toContain("Review reply");
    expect(html).not.toMatch(/<form/);
    const over = render("write", "x".repeat(2201));
    expect(over).toContain("1 characters over the limit");
    expect(over).toMatch(/aria-invalid="true"/);
    expect(over).toMatch(/<button[^>]*disabled=""[^>]*>Review reply<\/button>/);
  });

  it("review: the exact text is shown and is the hidden field; the form carries only the page's five identifiers; Publish is the only submit", () => {
    const text = `Gracias ${HOSTILE}\n\nSaludos`;
    const html = render("review", text);
    expect(html).toMatch(/<blockquote class="[^"]*">/);
    // The review shows the text (escaped as text) and posts the very same string as the hidden field.
    expect(html).toContain(`>${escape(text)}</blockquote>`);
    expect(html).toContain(`<input type="hidden" name="text" value="${escape(text)}"`);
    const names = [...html.matchAll(/<input type="hidden" name="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(["workspaceId", "conversationId", "targetInteractionId", "idempotencyKey", "text"]);
    expect(html).not.toMatch(/name="(connectedAccountId|platform|provider|accountId)"/);
    expect([...html.matchAll(/type="submit"/g)]).toHaveLength(1);
    expect(html).toContain("Publish reply");
    expect(html).toContain("This exact text will be published");
    // React's static render of a server-action form appends its own progressive-enhancement script; OUR text never
    // reaches the page unescaped (the only "<script>" in the markup is React's, and it does not contain the text).
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("alert(1)</script>");
  });
});

const detail = (reply: ConversationDetail["reply"], outbound: ConversationDetail["outbound"] = []): ConversationDetail => ({
  conversationId: CONVERSATION,
  workflowState: "open",
  platform: "instagram",
  source: "paid",
  contentKind: "post",
  anchorInteractionId: TARGET,
  truncated: false,
  reply,
  outbound,
  thread: [
    { interactionId: TARGET, parentInteractionId: null, kind: "comment", observed: true, author: "audience", authorLabel: "caro.m", text: "Hola", presence: "present", providerCreatedAt: new Date("2026-11-08T22:50:00Z"), providerEditedAt: null, textObservedAt: null, earlierVersions: [], olderVersionsOmitted: false, facts: [] },
    { interactionId: "a2222222-2222-4222-8222-222222222222", parentInteractionId: TARGET, kind: "reply", observed: true, author: "own_account", authorLabel: null, text: "Nuestra respuesta", presence: "present", providerCreatedAt: new Date("2026-11-08T23:05:00Z"), providerEditedAt: null, textObservedAt: null, earlierVersions: [], olderVersionsOmitted: false, facts: [] },
    { interactionId: "a3333333-3333-4333-8333-333333333333", parentInteractionId: TARGET, kind: "reply", observed: true, author: "audience", authorLabel: "caro.m", text: "ok", presence: "present", providerCreatedAt: new Date("2026-11-08T23:10:00Z"), providerEditedAt: null, textObservedAt: null, earlierVersions: [], olderVersionsOmitted: false, facts: [] },
    { interactionId: "a4444444-4444-4444-8444-444444444444", parentInteractionId: null, kind: "comment", observed: true, author: "audience", authorLabel: "lucas", text: "oculto", presence: "hidden", providerCreatedAt: new Date("2026-11-08T23:12:00Z"), providerEditedAt: null, textObservedAt: null, earlierVersions: [], olderVersionsOmitted: false, facts: [] },
  ],
});
const view = (d: ConversationDetail): string => renderToStaticMarkup(h(ConversationView, { workspaceId: WS, detail: d, cursor: undefined, replyAction: action }));

describe("7B-3: the conversation view", () => {
  it("hidden: no Reply affordance, no form, no unavailable line (the read side of Step 7A unchanged)", () => {
    const html = view(detail({ kind: "hidden" }));
    expect(html).not.toMatch(/<form|<button|<textarea|Reply not available/);
  });

  it("unavailable: the one reason in outcome language, and still no control", () => {
    const html = view(detail({ kind: "unavailable", reason: "platform_unavailable", platform: "instagram" }));
    expect(html).toContain(t("inbox.reply.unavailable_label"));
    expect(html).toContain(escape(t("inbox.reply.reason.platform_unavailable")));
    expect(t("inbox.reply.reason.platform_unavailable")).toBe("Public replies aren't enabled in Wrenkind yet.");
    expect(html).not.toMatch(/not available for this platform|not available on Instagram/);
    expect(html).not.toMatch(/<form|<button|<textarea/);
    expect(view(detail({ kind: "unavailable", reason: "monitor_only", platform: "instagram" }))).toContain(t("inbox.reply.reason.monitor_only"));
  });

  it("available: exactly one Reply affordance per eligible member — the top-level audience comment, never the brand's own reply, the Instagram reply-to-reply or the hidden comment", () => {
    const html = view(detail({ kind: "available", connectedAccountId: "acc", platform: "instagram", maxChars: 2200, limitation: null }));
    expect([...html.matchAll(/>Reply<\/button>/g)]).toHaveLength(1);
    expect(html).not.toMatch(/<form/);
    const facebook = view({ ...detail({ kind: "available", connectedAccountId: "acc", platform: "facebook", maxChars: 2200, limitation: null }), platform: "facebook" });
    // Facebook: the audience reply-to-reply is eligible too (2 affordances); own and hidden still are not.
    expect([...facebook.matchAll(/>Reply<\/button>/g)]).toHaveLength(2);
  });

  it("outbound replies appear under their comment with their REAL state, text as text, and never as a canonical member", () => {
    const html = view(
      detail({ kind: "available", connectedAccountId: "acc", platform: "instagram", maxChars: 2200, limitation: null }, [
        { intentId: "b1", parentInteractionId: TARGET, text: `Enviando ${HOSTILE}`, state: "sending", outcomeCode: null, createdAt: new Date("2026-11-09T10:00:00Z"), confirmedAt: null },
        { intentId: "b2", parentInteractionId: TARGET, text: "Confirmada", state: "sent", outcomeCode: null, createdAt: new Date("2026-11-09T10:01:00Z"), confirmedAt: new Date("2026-11-09T10:01:30Z") },
        { intentId: "b3", parentInteractionId: TARGET, text: "Perdida", state: "checking", outcomeCode: "RESPONSE_LOST", createdAt: new Date("2026-11-09T10:02:00Z"), confirmedAt: null },
        { intentId: "b4", parentInteractionId: TARGET, text: "Fallida", state: "failed", outcomeCode: "TARGET_NOT_FOUND", createdAt: new Date("2026-11-09T10:03:00Z"), confirmedAt: null },
        { intentId: "b5", parentInteractionId: TARGET, text: "Bloqueada", state: "blocked", outcomeCode: "MODE_NOT_STANDARD", createdAt: new Date("2026-11-09T10:04:00Z"), confirmedAt: null },
      ]),
    );
    for (const state of ["sending", "sent", "failed", "checking", "blocked"] as const) expect(html).toContain(t(`inbox.outbound.state.${state}`));
    expect(html).toContain(escape(`Enviando ${HOSTILE}`));
    expect(html).not.toContain("<script>");
    expect(html).toContain(escape(t("inbox.outbound.checking_note")));
    expect(html).toContain(escape(t("inbox.outbound.failed_note")));
    expect(html).toContain(escape(t("inbox.outbound.blocked_note")));
    // Sent only where the platform confirmed; the sending row carries no "Published" time.
    expect([...html.matchAll(new RegExp(t("inbox.outbound.state.sent"), "g"))]).toHaveLength(1);
    expect([...html.matchAll(/Published /g)]).toHaveLength(1);
    expect(html).not.toContain("RESPONSE_LOST");
  });
});
