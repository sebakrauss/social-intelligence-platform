/**
 * MESSAGES-UX-01 — synthetic prototype model (iteration 02). Types, the in-memory state (a reducer), browser routing
 * and formatting. Prototype only: nothing here is product code, nothing is read from or sent to any provider, and
 * nothing persists beyond the browser tab (drafts and demo sends live in memory, like the Comments Phase 1 drafts).
 */

export type Platform = "instagram" | "messenger";
export type Lang = "en" | "es" | "pt";
export type View = "open" | "done" | "all";
export type Scenario = "normal" | "empty" | "loading" | "disconnected";
/** Sending experiences compared in iteration 02: A = fast human send · B = review only when context warrants it. */
export type SendMode = "fast" | "contextual";

export interface Account {
  readonly id: string;
  readonly platform: Platform;
  readonly name: string;
  readonly handle: string;
}

export interface Teammate {
  readonly id: string;
  readonly name: string;
  readonly initials: string;
}

export interface Attachment {
  readonly kind: "image" | "file" | "audio";
  readonly name: string;
  readonly detail: string;
  /** False when the provider reference expired: shown as unavailable, never as content. */
  readonly available: boolean;
}

/** in = the person · out = sent from Wrenkind · native = sent by the business from another app (e.g. the Instagram app). */
export type Direction = "in" | "out" | "native";

export interface Message {
  readonly id: string;
  readonly dir: Direction;
  readonly at: string;
  readonly text?: string;
  readonly lang?: Lang;
  /** Illustrative fixtures only — written by hand, never generated. */
  readonly translations?: { readonly [L in Lang]?: string };
  readonly replyTo?: string;
  readonly attachments?: readonly Attachment[];
  readonly reaction?: string;
  readonly receipt?: "sent" | "delivered" | "seen";
  readonly sender?: string;
  readonly app?: string;
  readonly edited?: boolean;
  readonly unsent?: boolean;
  readonly demo?: boolean;
}

export interface Note {
  readonly id: string;
  readonly at: string;
  readonly author: string;
  readonly text: string;
}

/** Things Wrenkind records about the conversation itself (assignment, state, escalation) — never platform messages. */
export interface SystemEvent {
  readonly id: string;
  readonly at: string;
  readonly text: string;
}

export interface Escalation {
  readonly reason: string;
  readonly to: string | null;
  readonly note: string;
}

/** Illustrative only (FUTURE DESIGN): hand-written for this prototype; no analysis ever ran. */
export interface FutureInsight {
  readonly intent: string;
  readonly urgency: "Low" | "Medium" | "High";
  readonly tone: string;
  readonly summary: string;
  readonly reasons: readonly string[];
  readonly suggestion?: string;
}

export interface Conversation {
  readonly id: string;
  readonly accountId: string;
  readonly participant: { readonly name: string; readonly handle?: string; readonly initials: string };
  /** The language the person writes in (used to pick a Saved Reply variant first). */
  readonly lang: Lang;
  readonly request: boolean;
  readonly state: "open" | "done";
  readonly assignee: string | null;
  /** Internal, per-teammate unread: who hasn't opened the latest activity in Wrenkind. Never a platform read receipt. */
  readonly unreadFor: readonly string[];
  readonly escalation: Escalation | null;
  readonly messages: readonly Message[];
  readonly notes: readonly Note[];
  readonly events: readonly SystemEvent[];
  readonly partialHistory: boolean;
  readonly presence: { readonly who: string; readonly doing: "viewing" | "replying" } | null;
  /** A synthetic high-risk marker used to demonstrate contextual review (Variant B). */
  readonly risk: string | null;
  readonly future: FutureInsight | null;
}

export interface SavedReplyVariant {
  readonly lang: Lang;
  readonly text: string;
}

/** One saved reply family with language variants (direction only: PD OQ-23 stays open). */
export interface SavedReply {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  /** null = every account in the workspace; otherwise one connected account. */
  readonly account: string | null;
  readonly shortcut: string;
  readonly variants: readonly SavedReplyVariant[];
  readonly local?: boolean;
}

export interface Draft {
  readonly mode: "reply" | "note";
  readonly reply: string;
  /** The reply before a synthetic translation, so it can be restored; null when not translated. */
  readonly original: string | null;
  readonly translated: { readonly from: Lang; readonly to: Lang } | null;
  /** The internal-note draft: always separate from the reply, never moved into it. */
  readonly note: string;
}

export interface Toast {
  readonly id: number;
  readonly text: string;
  readonly undo: { readonly conversationId: string; readonly state: "open" | "done" } | null;
}

export interface State {
  readonly conversations: readonly Conversation[];
  readonly drafts: Readonly<Record<string, Draft>>;
  readonly savedReplies: readonly SavedReply[];
  readonly toast: Toast | null;
  readonly showFuture: boolean;
  readonly scenario: Scenario;
  readonly sendMode: SendMode;
  readonly seq: number;
}

export const EMPTY_DRAFT: Draft = { mode: "reply", reply: "", original: null, translated: null, note: "" };

/** The prototype's fixed clock: 20 Nov 2026, 11:52 (GMT-3). Every relative time is computed from it. */
export const NOW = Date.parse("2026-11-20T14:52:00Z");
export const ME = "t-mara";
const DAY = 86_400_000;

export const LANG_NAMES: { readonly [L in Lang]: string } = { en: "English", es: "Spanish", pt: "Portuguese" };
export const PLATFORM_NAMES: { readonly [P in Platform]: string } = { instagram: "Instagram", messenger: "Messenger" };

export type Action =
  | { readonly type: "open"; readonly id: string }
  | { readonly type: "markUnread"; readonly id: string }
  | { readonly type: "assign"; readonly id: string; readonly to: string | null; readonly takeOver?: string }
  | { readonly type: "setState"; readonly id: string; readonly state: "open" | "done" }
  | { readonly type: "undo" }
  | { readonly type: "escalate"; readonly id: string; readonly escalation: Escalation | null }
  | { readonly type: "draft"; readonly id: string; readonly draft: Draft }
  | { readonly type: "addNote"; readonly id: string }
  | { readonly type: "sendDemo"; readonly id: string }
  | { readonly type: "addSavedReply"; readonly reply: SavedReply }
  | { readonly type: "toggleFuture" }
  | { readonly type: "scenario"; readonly scenario: Scenario }
  | { readonly type: "sendMode"; readonly mode: SendMode }
  | { readonly type: "dismissToast" }
  | { readonly type: "reset"; readonly state: State };

const NAMES: Readonly<Record<string, string>> = { "t-mara": "Mara Ortiz", "t-carla": "Carla Méndez", "t-bruno": "Bruno Díaz", "t-ana": "Ana Torres" };
const nameOf = (id: string | null): string => (id === null ? "nobody" : (NAMES[id] ?? "a teammate"));
const update = (state: State, id: string, change: (c: Conversation) => Conversation): readonly Conversation[] => state.conversations.map((c) => (c.id === id ? change(c) : c));
const stamp = (state: State): string => new Date(NOW + (state.seq + 1) * 1000).toISOString();
const event = (state: State, text: string): SystemEvent => ({ id: `e-${String(state.seq + 1)}`, at: stamp(state), text });
const toast = (state: State, text: string, undo: Toast["undo"] = null): Toast => ({ id: state.seq + 1, text, undo });

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "open":
      return { ...state, conversations: update(state, action.id, (c) => (c.unreadFor.includes(ME) ? { ...c, unreadFor: c.unreadFor.filter((u) => u !== ME) } : c)) };
    case "markUnread":
      return { ...state, conversations: update(state, action.id, (c) => ({ ...c, unreadFor: [...c.unreadFor.filter((u) => u !== ME), ME] })), toast: toast(state, "Marked unread for you. Nothing changes on the platform."), seq: state.seq + 1 };
    case "assign": {
      const text = action.takeOver !== undefined ? `${nameOf(ME)} took over handling from ${nameOf(action.takeOver)}` : action.to === null ? `${nameOf(ME)} unassigned the conversation` : action.to === ME ? `${nameOf(ME)} took the conversation` : `${nameOf(ME)} assigned the conversation to ${nameOf(action.to)}`;
      return {
        ...state,
        conversations: update(state, action.id, (c) => ({ ...c, assignee: action.to, presence: action.takeOver !== undefined ? null : c.presence, events: [...c.events, event(state, text)] })),
        toast: toast(state, action.to === null ? "Unassigned." : `Assigned to ${action.to === ME ? "you" : nameOf(action.to)}.`),
        seq: state.seq + 1,
      };
    }
    case "setState": {
      const before = state.conversations.find((c) => c.id === action.id)?.state ?? "open";
      const text = action.state === "done" ? `${nameOf(ME)} marked the conversation done` : `${nameOf(ME)} reopened the conversation`;
      return {
        ...state,
        conversations: update(state, action.id, (c) => ({ ...c, state: action.state, events: [...c.events, event(state, text)] })),
        toast: toast(state, action.state === "done" ? "Marked done." : "Reopened.", { conversationId: action.id, state: before }),
        seq: state.seq + 1,
      };
    }
    case "undo": {
      const undo = state.toast?.undo;
      if (undo === undefined || undo === null) return state;
      return { ...state, conversations: update(state, undo.conversationId, (c) => ({ ...c, state: undo.state, events: c.events.slice(0, -1) })), toast: null };
    }
    case "escalate": {
      const text = action.escalation === null ? `${nameOf(ME)} closed the escalation` : `${nameOf(ME)} escalated to ${nameOf(action.escalation.to)} · ${action.escalation.reason}`;
      return { ...state, conversations: update(state, action.id, (c) => ({ ...c, escalation: action.escalation, events: [...c.events, event(state, text)] })), toast: toast(state, action.escalation === null ? "Escalation closed." : "Escalated."), seq: state.seq + 1 };
    }
    case "draft":
      return { ...state, drafts: { ...state.drafts, [action.id]: action.draft } };
    case "addNote": {
      const draft = state.drafts[action.id] ?? EMPTY_DRAFT;
      if (draft.note.trim() === "") return state;
      const note: Note = { id: `n-${String(state.seq + 1)}`, at: stamp(state), author: ME, text: draft.note.trim() };
      return { ...state, conversations: update(state, action.id, (c) => ({ ...c, notes: [...c.notes, note] })), drafts: { ...state.drafts, [action.id]: { ...draft, note: "" } }, toast: toast(state, "Note added. Only your team can see it."), seq: state.seq + 1 };
    }
    case "sendDemo": {
      const draft = state.drafts[action.id] ?? EMPTY_DRAFT;
      if (draft.reply.trim() === "") return state;
      const message: Message = { id: `demo-${String(state.seq + 1)}`, dir: "out", at: stamp(state), text: draft.reply.trim(), sender: ME, demo: true };
      return {
        ...state,
        conversations: update(state, action.id, (c) => ({ ...c, messages: [...c.messages, message] })),
        drafts: { ...state.drafts, [action.id]: { ...draft, reply: "", original: null, translated: null } },
        toast: toast(state, "Demo reply added locally — nothing was sent. The conversation stays Open."),
        seq: state.seq + 1,
      };
    }
    case "addSavedReply":
      return { ...state, savedReplies: [action.reply, ...state.savedReplies], toast: toast(state, "Saved reply added for this session only."), seq: state.seq + 1 };
    case "toggleFuture":
      return { ...state, showFuture: !state.showFuture };
    case "scenario":
      return { ...state, scenario: action.scenario };
    case "sendMode":
      return { ...state, sendMode: action.mode };
    case "dismissToast":
      return { ...state, toast: null };
    case "reset":
      return action.state;
  }
}

/* ---------- Messaging window (Meta's standard 24-hour window; behaviour per account and setup is still VALIDATE) ---------- */

export interface Window {
  readonly open: boolean;
  /** Until (open) or since (closed), as an instant. */
  readonly at: number;
}

export function windowOf(c: Conversation): Window {
  const lastIn = [...c.messages].reverse().find((m) => m.dir === "in");
  if (lastIn === undefined) return { open: false, at: NOW };
  const until = Date.parse(lastIn.at) + DAY;
  return { open: until > NOW, at: until };
}

export const lastMessage = (c: Conversation): Message | undefined => c.messages[c.messages.length - 1];
export const lastActivity = (c: Conversation): number => Math.max(...c.messages.map((m) => Date.parse(m.at)));
export const isUnread = (c: Conversation): boolean => c.unreadFor.includes(ME);

/** Why Variant B asks for a review before this send (empty = send directly). Never inferred from a provider capability. */
export function reviewReasons(c: Conversation, draft: Draft): readonly string[] {
  const reasons: string[] = [];
  if (draft.translated !== null) reasons.push(`The draft was translated to ${LANG_NAMES[draft.translated.to]} with an illustrative fixture — check it reads right.`);
  if (c.presence !== null && c.presence.doing === "replying" && c.presence.who !== ME) reasons.push(`${nameOf(c.presence.who)} is also writing a reply to this person.`);
  if (c.escalation !== null) reasons.push(`This conversation is escalated (${c.escalation.reason}).`);
  if (c.risk !== null) reasons.push(c.risk);
  return reasons;
}

/* ---------- Formatting (fixed GMT-3, like the Comments prototype) ---------- */

const TZ = "America/Argentina/Buenos_Aires";
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const dayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short" });
const fullFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const keyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

export const timeOf = (iso: string | number): string => timeFmt.format(new Date(iso));
export const fullOf = (iso: string | number): string => `${fullFmt.format(new Date(iso))} GMT-3`;
const dayKey = (t: number): string => keyFmt.format(new Date(t));

/** List time: today → 11:40, yesterday → Yesterday, earlier → 18 NOV. */
export function shortWhen(t: number): string {
  if (dayKey(t) === dayKey(NOW)) return timeOf(t);
  if (dayKey(t) === dayKey(NOW - DAY)) return "Yesterday";
  return dayFmt.format(new Date(t)).toUpperCase();
}

/** Thread day separators. */
export function dayLabel(t: number): string {
  if (dayKey(t) === dayKey(NOW)) return "Today";
  if (dayKey(t) === dayKey(NOW - DAY)) return "Yesterday";
  return dayFmt.format(new Date(t));
}

export const sameDay = (a: number, b: number): boolean => dayKey(a) === dayKey(b);

export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)} h ${String(minutes % 60)} min`;
  return `${String(Math.floor(hours / 24))} days`;
}

/* ---------- Routing: real browser navigation with the History API ---------- */

export interface Route {
  readonly view: View;
  readonly id: string | null;
}

export const BASE = "/messages";
const VIEWS: readonly View[] = ["open", "done", "all"];

export function parseRoute(path: string, search: string): Route {
  const named = new URLSearchParams(search).getAll("view");
  const view = named.length === 1 ? (VIEWS.find((v) => v === named[0]) ?? "open") : "open";
  const match = /^\/messages\/([a-z0-9-]+)\/?$/.exec(path);
  return { view, id: match?.[1] ?? null };
}

export const hrefOf = (route: Route): string => `${route.id === null ? BASE : `${BASE}/${route.id}`}${route.view === "open" ? "" : `?view=${route.view}`}`;

const listeners = new Set<() => void>();
export function subscribeRoute(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}
export const routeSnapshot = (): string => `${window.location.pathname}${window.location.search}`;
/** Where focus should land after a navigation (kept in the history entry, read once by the screen that appears). */
export interface FocusHint {
  readonly focus?: "previous" | "next";
  readonly focusRow?: string | null;
}
export function navigate(href: string, replace = false, hint: FocusHint | null = null): void {
  if (replace) window.history.replaceState(hint, "", href);
  else window.history.pushState(hint, "", href);
  for (const listener of listeners) listener();
}
export const focusHint = (): FocusHint => (window.history.state as FocusHint | null) ?? {};

/* ---------- Small helpers ---------- */

/** UTF-8 length: Instagram documents a 1,000-byte text limit (official docs, read 2026-11-20). */
export const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

export function insertAt(text: string, insert: string, start: number, end: number): { readonly text: string; readonly caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  return { text: `${before}${insert}${after}`, caret: start + insert.length };
}
