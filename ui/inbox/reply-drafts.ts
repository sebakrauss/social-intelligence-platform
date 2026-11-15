/**
 * Unsent public-reply drafts (Step 7B-15F). A person who moves the ONE reply composer to another comment of the same
 * conversation (an in-page navigation) finds what they wrote when they come back to the first one (UX §2 P3).
 *
 * Storage contract — memory only:
 * - WHERE: a module-level Map in this browser tab's JavaScript realm. Never localStorage, sessionStorage, IndexedDB,
 *   cookies, the URL, logs, analytics or the server. On the server (SSR) every function here is a no-op, so the Map is
 *   never written outside a browser.
 * - KEY: an opaque per-person scope (derived on the server from the verified user, never the user id itself) +
 *   workspace + conversation + target comment. A draft is only offered back to the composer with that exact key;
 *   a write under one scope drops every entry kept under another (another person signed in on this tab).
 * - RETENTION: until the person empties the text, cancels, presses Publish, signs out (Step 7B-15H: every signed-out
 *   surface clears the whole store — reply-drafts-boundary.tsx), or the page is reloaded, closed or left by a full
 *   navigation (the realm ends). At most MAX_DRAFTS entries; the oldest is dropped first.
 * - PUBLISHING: pressing Publish takes the text out of the drafts BEFORE the request, and while that request is in
 *   flight nothing is kept for its key (Step 7B-15H). When the answer arrives: requested, already-existing, unavailable
 *   (outcome unknown) or a failed request leave NO draft for that comment — so an accepted or possibly-accepted reply
 *   can never come back as a new publishable text under a new form key. Only when the server answered that nothing was
 *   created (refused, blocked, signed out) does the submitted text come back — and only if no other request for that
 *   comment is still in flight, no newer draft exists, and nobody signed out meanwhile.
 * - UNKNOWN OUTCOME (Step 7B-15J): after `unavailable` or a failed request the reply may already exist. From then on this
 *   tab keeps NO draft for that comment (until sign-out or a reload), so nothing written afterwards can come back under a
 *   NEW form key. Across reloads, tabs and sessions the server is the authority: the conversation view draws no composer
 *   for a comment whose reply is still sending or being checked (views.tsx). Retrying in the SAME composer reuses its form
 *   key, so the server answers `existing` (or refuses a changed text) instead of creating a second reply.
 * - LEAVING: while any draft is kept, the browser's native "leave this page?" confirmation guards full navigations
 *   (reload, closing the tab, another conversation). It carries no content.
 *
 * Draft text is the person's own words, never an authorization: restoring it seeds at most the write stage. Whether a
 * composer exists, its mode (ordinary or validation), its target and its form key always come from the server's render.
 */
import type { ReplyAction, ReplyActionState } from "@/server/inbox/reply-state";

const MAX_DRAFTS = 20;
const SEPARATOR = "\u0000";
const drafts = new Map<string, string>();
/** Step 7B-15H: requests in flight per key (a key with a pending request keeps no draft). */
const pending = new Map<string, number>();
/** Step 7B-15J: keys whose last request may have been accepted (unknown outcome): they keep no draft any more. */
const uncertain = new Set<string>();
/** Step 7B-15H: bumped by clearReplyDrafts (sign-out): an answer that arrives later never refills the store. */
let generation = 0;

const inBrowser = (): boolean => typeof window !== "undefined";
const scopeOf = (key: string): string => key.slice(0, key.indexOf(SEPARATOR));

let guarding = false;
function warnBeforeLeaving(event: BeforeUnloadEvent): void {
  event.preventDefault();
}

/** The native leave confirmation follows the store: on while any draft is kept, off when none is. Fails safe (no guard). */
function syncLeaveGuard(): void {
  const wanted = drafts.size > 0;
  if (wanted === guarding) return;
  try {
    if (wanted) window.addEventListener("beforeunload", warnBeforeLeaving);
    else window.removeEventListener("beforeunload", warnBeforeLeaving);
    guarding = wanted;
  } catch {
    // No leave guard available: the draft is still kept in memory for in-page navigation.
  }
}

/** The draft key of one composer, or undefined (drafts off) without a scope. */
export function replyDraftKey(scope: string, fields: { readonly workspaceId: string; readonly conversationId: string; readonly targetInteractionId: string }): string | undefined {
  if (scope === "" || scope.includes(SEPARATOR)) return undefined;
  return [scope, fields.workspaceId, fields.conversationId, fields.targetInteractionId].join(SEPARATOR);
}

/** The kept draft for exactly this key, if any. Reads only. */
export function restoreReplyDraft(key: string | undefined): string | undefined {
  if (key === undefined || !inBrowser()) return undefined;
  return drafts.get(key);
}

/** Keep the current text as this key's draft (an empty or blank text forgets it). Called from the person's typing only. */
export function keepReplyDraft(key: string | undefined, text: string): void {
  if (key === undefined || !inBrowser() || pending.has(key) || uncertain.has(key)) return;
  const scope = scopeOf(key);
  for (const other of [...drafts.keys()]) if (scopeOf(other) !== scope) drafts.delete(other);
  drafts.delete(key);
  if (text.trim() !== "") {
    drafts.set(key, text);
    for (const oldest of [...drafts.keys()].slice(0, Math.max(0, drafts.size - MAX_DRAFTS))) drafts.delete(oldest);
  }
  syncLeaveGuard();
}

/** Forget this key's draft (the person cancelled, or pressed Publish). */
export function forgetReplyDraft(key: string | undefined): void {
  if (key === undefined || !inBrowser()) return;
  drafts.delete(key);
  syncLeaveGuard();
}

/**
 * Step 7B-15H: forget EVERY kept draft (all people, all comments) and drop the leave confirmation — called when a
 * signed-out surface is shown (sign-out, an expired session), so no text outlives the session in this tab's memory.
 */
export function clearReplyDrafts(): void {
  if (!inBrowser()) return;
  generation += 1;
  drafts.clear();
  uncertain.clear();
  syncLeaveGuard();
}

function hold(key: string): void {
  pending.set(key, (pending.get(key) ?? 0) + 1);
}

function release(key: string): void {
  const count = (pending.get(key) ?? 1) - 1;
  if (count > 0) pending.set(key, count);
  else pending.delete(key);
}

/** Outcomes after which the server created nothing: the text is still the person's unsent draft. */
const NOTHING_CREATED: ReadonlySet<ReplyActionState["kind"]> = new Set(["refused", "blocked", "signed_out"]);
/** Step 7B-15J: outcomes after which a reply may or may not exist (the server could not say). */
const UNKNOWN_OUTCOME: ReadonlySet<ReplyActionState["kind"]> = new Set(["unavailable"]);

/**
 * The publish action with draft bookkeeping around it, or the action itself without a key. It calls `action` exactly
 * once, with the same arguments, and returns its answer unchanged (an error propagates unchanged): it decides nothing
 * about publishing — it only takes the text out of the drafts first and gives it back when nothing was created.
 */
export function settleReplyDraft(action: ReplyAction, key: string | undefined): ReplyAction {
  if (key === undefined) return action;
  return async (previous, form) => {
    const submitted = form.get("text");
    const started = generation;
    forgetReplyDraft(key);
    hold(key);
    let result: ReplyActionState;
    try {
      result = await action(previous, form);
    } catch (error) {
      release(key);
      uncertain.add(key);
      forgetReplyDraft(key);
      throw error;
    }
    release(key);
    // Created or possibly created: no draft for this comment. Nothing created: the submitted text is the draft again —
    // unless someone signed out meanwhile; and keepReplyDraft itself refuses while another request for it is in flight.
    // (No newer draft can exist here: the store was emptied for this key at submit and kept nothing while it was held.)
    if (UNKNOWN_OUTCOME.has(result.kind)) uncertain.add(key);
    if (!NOTHING_CREATED.has(result.kind)) forgetReplyDraft(key);
    else if (typeof submitted === "string" && started === generation) keepReplyDraft(key, submitted);
    return result;
  };
}
