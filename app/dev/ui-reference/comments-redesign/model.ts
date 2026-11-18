/**
 * Comments experience redesign (Step 7B-17V) — DEVELOPMENT ONLY. The prototype's rules as pure functions over the
 * synthetic fixtures, so they can be tested without a page: who may do what (COMMENTS-2.1-CONTRACT §D.4), the manual
 * label rules (§D.3: names 1–40 characters, unique ignoring case, at most 50, flat, one filter at a time), the filter
 * (a conversation is listed under a label when at least one of its comments carries it), Previous / Next, and how the
 * brand's own account is named without inventing an identity. All state is the caller's (React state in the page);
 * nothing is read from or written to a server, a database, browser storage or a platform.
 *
 * Step 7B-17V-UX adds the comment actions: what Meta documents for each one (7B-17V-META), what Wrenkind implements
 * today, and what this prototype only SIMULATES; one resolver that decides, in the product's order (IA §18), whether
 * an action is drawn, unavailable with one reason, or offered; and the simulated operations themselves (Sending →
 * Sent / Failed / Checking / Blocked), advanced only by a person pressing a prototype control.
 */
import { THEME_ATTRIBUTE } from "@/ui/foundations/theme";
import type { ThemeName } from "@/ui/foundations/tokens";
import { localFull, localShort } from "@/ui/time/local-time-format";
import {
  ACCOUNTS,
  AS_OF,
  CONVERSATIONS,
  ME,
  MEMBERS,
  POSTS,
  SEED_ASSESSMENTS,
  SEED_CHECKING_REPLY,
  SEED_FLOWS,
  type Account,
  type Assessment,
  type Comment,
  type Conversation,
  type Label,
  type Marker,
  type Member,
  type Platform,
  type Post,
  type SeedResolution,
  type SentReply,
} from "./fixtures";

/* ───────────── theme (UX3): the product's own mechanism, never a second palette ───────────── */

/**
 * "system" follows the operating system (the product's policy today: ui/foundations/theme.ts); "light" / "dark" are
 * the explicit override the tokens already honor through `data-theme` on <html>. The prototype sets it only while it is
 * open and puts back whatever was there when it leaves; nothing is persisted.
 */
export type ThemeChoice = "system" | ThemeName;
export const THEME_CHOICES: readonly { readonly id: ThemeChoice; readonly name: string }[] = [
  { id: "system", name: "System (product default)" },
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
];
export { THEME_ATTRIBUTE };

/* ───────────── roles (COMMENTS-2.1-CONTRACT §D.4) ───────────── */

export type Role = "owner" | "admin" | "manager" | "agent" | "analyst" | "guest";

export const ROLES: readonly { readonly id: Role; readonly name: string }[] = [
  { id: "owner", name: "Owner" },
  { id: "admin", name: "Admin" },
  { id: "manager", name: "Manager" },
  { id: "agent", name: "Agent" },
  { id: "analyst", name: "Analyst" },
  { id: "guest", name: "Client guest" },
];

export interface Abilities {
  /** Comments are shown at all (`workspace.read_operational`; a client guest has no projection). */
  readonly view: boolean;
  /** Assign and remove existing labels (`workflow.internal`). */
  readonly assign: boolean;
  /** Create labels (the proposed `labels.manage`). */
  readonly create: boolean;
  /** Public reply (`reply.public`). */
  readonly reply: boolean;
  /** Private reply (`reply.private`). */
  readonly replyPrivately: boolean;
  /** Hide and unhide (`moderate.hide_unhide`). */
  readonly hide: boolean;
  /** Delete (`moderate.delete`: Owner, Admin, Manager; a Responder only by an explicit grant). */
  readonly delete: boolean;
  /** Block and unblock an author (`moderate.block`: as delete). */
  readonly block: boolean;
  /**
   * Like and unlike. No permission exists for it (Like is not in Wrenkind's vocabulary): the prototype follows
   * `reply.public`, an assumption for the Product Owner to confirm.
   */
  readonly like: boolean;
  /**
   * Conversation management (UX-04): assign, Urgent, escalate, notes, Done and Reopen — internal to Wrenkind, the
   * product's `workflow.internal`, so it stays available in a Monitor-only workspace.
   */
  readonly manage: boolean;
}

/** The role defaults of platform/permissions/catalog.ts (an Agent is the product's Responder, with no grants). */
export function abilitiesOf(role: Role): Abilities {
  switch (role) {
    case "owner":
    case "admin":
    case "manager":
      return { view: true, assign: true, create: true, reply: true, replyPrivately: true, hide: true, delete: true, block: true, like: true, manage: true };
    case "agent":
      return { view: true, assign: true, create: false, reply: true, replyPrivately: true, hide: true, delete: false, block: false, like: true, manage: true };
    case "analyst":
      return { view: true, assign: false, create: false, reply: false, replyPrivately: false, hide: false, delete: false, block: false, like: false, manage: false };
    case "guest":
      return { view: false, assign: false, create: false, reply: false, replyPrivately: false, hide: false, delete: false, block: false, like: false, manage: false };
  }
}

/* ───────────── manual labels (COMMENTS-2.1-CONTRACT §D.3) ───────────── */

export const LABEL_NAME_MAX = 40;
export const LABELS_PER_WORKSPACE = 50;

export interface LabelState {
  readonly labels: readonly Label[];
  /** comment id → label ids, in the order they were added. */
  readonly assignments: Readonly<Record<string, readonly string[]>>;
  /** Next synthetic id number for a created label. */
  readonly nextId: number;
}

export type NameProblem = "empty" | "too_long" | "duplicate" | "limit";

export const NAME_PROBLEMS: { readonly [P in NameProblem]: string } = {
  empty: "Write a name for the label.",
  too_long: `Use ${String(LABEL_NAME_MAX)} characters or fewer.`,
  duplicate: "A label with this name already exists.",
  limit: `This workspace already has ${String(LABELS_PER_WORKSPACE)} labels, the most it can have.`,
};

/** Spaces collapse and the ends are trimmed; the comparison key ignores case. */
export const normalizeName = (raw: string): string => raw.replace(/\s+/g, " ").trim();
const nameKey = (name: string): string => normalizeName(name).toLocaleLowerCase("en");

export function findLabelByName(labels: readonly Label[], raw: string): Label | undefined {
  const key = nameKey(raw);
  return labels.find((label) => nameKey(label.name) === key);
}

export function nameProblem(labels: readonly Label[], raw: string): NameProblem | undefined {
  const name = normalizeName(raw);
  if (name === "") return "empty";
  if (Array.from(name).length > LABEL_NAME_MAX) return "too_long";
  if (findLabelByName(labels, name) !== undefined) return "duplicate";
  if (labels.length >= LABELS_PER_WORKSPACE) return "limit";
  return undefined;
}

export const labelsOn = (state: LabelState, commentId: string): readonly string[] => state.assignments[commentId] ?? [];

/** Assign or remove one label on one comment (idempotent in each direction). Refused without `assign`. */
export function setAssigned(state: LabelState, role: Role, commentId: string, labelId: string, assigned: boolean): LabelState {
  if (!abilitiesOf(role).assign || !state.labels.some((label) => label.id === labelId)) return state;
  const current = labelsOn(state, commentId);
  const has = current.includes(labelId);
  if (has === assigned) return state;
  const next = assigned ? [...current, labelId] : current.filter((id) => id !== labelId);
  return { ...state, assignments: { ...state.assignments, [commentId]: next } };
}

export type CreateResult = { readonly ok: true; readonly state: LabelState; readonly label: Label } | { readonly ok: false; readonly problem: NameProblem | "not_allowed" | "marker_unknown" };

/**
 * Create a label from a comment and assign it to that comment in the same step (the PO's requirement). Without the
 * create ability nothing changes. With no comment (`undefined`), the label is only created (sidebar "New label").
 * Its color is a palette identifier, gray unless chosen; anything outside the approved palette is refused.
 */
export function createLabel(state: LabelState, role: Role, raw: string, commentId: string | undefined, marker: string = "gray"): CreateResult {
  if (!abilitiesOf(role).create) return { ok: false, problem: "not_allowed" };
  const problem = nameProblem(state.labels, raw);
  if (problem !== undefined) return { ok: false, problem };
  if (!isMarker(marker)) return { ok: false, problem: "marker_unknown" };
  const label: Label = { id: `lbl-new-${String(state.nextId)}`, name: normalizeName(raw), marker };
  const created: LabelState = { ...state, labels: [...state.labels, label], nextId: state.nextId + 1 };
  return { ok: true, label, state: commentId === undefined ? created : setAssigned(created, role, commentId, label.id, true) };
}

/** Labels sorted for display: by name, ignoring case. */
export const sortedLabels = (labels: readonly Label[]): readonly Label[] => [...labels].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

/* ───────────── conversations, filter, navigation ───────────── */

export const accountOf = (id: string): Account | undefined => ACCOUNTS.find((account) => account.id === id);
export const postOf = (id: string | null): Post | undefined => (id === null ? undefined : POSTS.find((post) => post.id === id));

/** The latest activity in a conversation (a comment written or a reply published). */
export function latestOf(conversation: Conversation): string {
  const times = [...conversation.comments.map((comment) => comment.at), ...conversation.sent.map((reply) => reply.publishedAt)];
  return times.reduce((latest, at) => (at > latest ? at : latest), times[0] ?? "");
}

/** Every conversation, newest activity first. */
export const ORDERED: readonly Conversation[] = [...CONVERSATIONS].sort((a, b) => (latestOf(a) < latestOf(b) ? 1 : latestOf(a) > latestOf(b) ? -1 : a.id.localeCompare(b.id)));

/** The labels carried by any comment of a conversation, in the order first met. */
export function conversationLabels(state: LabelState, conversation: Conversation): readonly string[] {
  const seen: string[] = [];
  for (const comment of conversation.comments) for (const id of labelsOn(state, comment.id)) if (!seen.includes(id)) seen.push(id);
  return seen.filter((id) => state.labels.some((label) => label.id === id));
}

/** The list under the active filter (one label at a time, or none). A label that no longer exists shows everything. */
export function visibleConversations(state: LabelState, filter: string | undefined): readonly Conversation[] {
  if (filter === undefined || !state.labels.some((label) => label.id === filter)) return ORDERED;
  return ORDERED.filter((conversation) => conversationLabels(state, conversation).includes(filter));
}

/** How many conversations each label lists. */
export function labelCounts(state: LabelState): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const label of state.labels) counts[label.id] = 0;
  for (const conversation of ORDERED) for (const id of conversationLabels(state, conversation)) counts[id] = (counts[id] ?? 0) + 1;
  return counts;
}

export interface Position {
  readonly index: number;
  readonly count: number;
  readonly previous: string | undefined;
  readonly next: string | undefined;
}

export function positionOf(list: readonly Conversation[], id: string): Position | undefined {
  const index = list.findIndex((conversation) => conversation.id === id);
  if (index < 0) return undefined;
  return { index: index + 1, count: list.length, previous: list[index - 1]?.id, next: list[index + 1]?.id };
}

/* ───────────── identities (who said what, never confused) ───────────── */

export type ReadModel = "today" | "planned";

const PLATFORM_NAMES = { facebook: "Facebook", instagram: "Instagram" } as const;
const ASSET_NAMES = { facebook: "Facebook Page", instagram: "Instagram account" } as const;

export const platformName = (account: Account): string => PLATFORM_NAMES[account.platform];

export interface OwnIdentity {
  /** What the page shows as the author of the brand's own message. */
  readonly name: string;
  /** Whether `name` is the provider's verified name of the connected account. */
  readonly verified: boolean;
  /** The descriptor read with it: "Your Facebook Page", "Your Instagram account". */
  readonly descriptor: string;
}

/**
 * The connected account as author of the brand's own messages. With the planned read model the provider's own name
 * of the asset is shown (connections.discovered_assets.display_name — readable by every non-guest role, not yet in the
 * Comments read model); today, or when that name is missing, a neutral description — never an invented name.
 */
export function ownIdentity(account: Account, readModel: ReadModel): OwnIdentity {
  const descriptor = `Your ${ASSET_NAMES[account.platform]}`;
  if (readModel === "planned" && account.verifiedName !== null) return { name: account.verifiedName, verified: true, descriptor };
  return { name: descriptor, verified: false, descriptor };
}

/** The person (or the unknown author) who wrote a comment. */
export function commenterName(comment: Comment): string {
  if (comment.author.kind === "audience") return comment.author.name;
  if (comment.author.kind === "unknown") return "Unknown author";
  return "";
}

/**
 * The workspace member who requested a published reply. Member names are not in today's read model, so today the page
 * says only that it was requested in Wrenkind.
 */
export const requesterOf = (reply: SentReply, readModel: ReadModel): string => (readModel === "planned" ? reply.requestedBy : "A member of this workspace");

/* ───────────── source and context (never inferred) ───────────── */

export const SOURCE_TEXT: { readonly [S in Post["source"]]: string } = {
  organic: "Organic",
  paid: "Paid",
  mixed: "Organic and paid",
  unknown: "Not reported by the platform",
};

/** The compact tag the row and the context line show: only a reported paid or mixed source; organic and unknown say nothing. */
export const sourceTag = (post: Post | undefined): string | undefined => (post?.source === "paid" ? "Ad" : post?.source === "mixed" ? "Organic and paid" : undefined);

/* ───────────── threads ───────────── */

export type ThreadEntry =
  | { readonly kind: "comment"; readonly comment: Comment; readonly depth: 0 | 1; readonly replyingTo?: string }
  | { readonly kind: "sent"; readonly reply: SentReply; readonly depth: 0 | 1; readonly replyingTo?: string };

/**
 * The thread in reading order: the first comment, then everything else by time. One level of indentation; an entry
 * that answers someone other than the first comment names who it answers.
 */
export function threadOf(conversation: Conversation): readonly ThreadEntry[] {
  const anchor = conversation.comments[0];
  if (anchor === undefined) return [];
  const byId = new Map(conversation.comments.map((comment) => [comment.id, comment] as const));
  const nameOf = (id: string): string | undefined => {
    const parent = byId.get(id);
    if (parent === undefined) return undefined;
    return parent.author.kind === "own" ? "your account" : commenterName(parent);
  };
  const rest: { readonly at: string; readonly entry: ThreadEntry }[] = [];
  for (const comment of conversation.comments.slice(1)) {
    const replyingTo = comment.parentId !== null && comment.parentId !== anchor.id ? nameOf(comment.parentId) : undefined;
    rest.push({ at: comment.at, entry: { kind: "comment", comment, depth: 1, ...(replyingTo === undefined ? {} : { replyingTo }) } });
  }
  for (const reply of conversation.sent) {
    const replyingTo = reply.parentId !== anchor.id ? nameOf(reply.parentId) : undefined;
    rest.push({ at: reply.publishedAt, entry: { kind: "sent", reply, depth: 1, ...(replyingTo === undefined ? {} : { replyingTo }) } });
  }
  rest.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return [{ kind: "comment", comment: anchor, depth: 0 }, ...rest.map((item) => item.entry)];
}

/** Whether a comment could be answered at all (an audience comment still present on the platform). */
export const answerable = (comment: Comment): boolean => comment.author.kind !== "own" && comment.presence === "present";

/* ───────────── helpers for the client component ─────────────
 * The client prototype stays inside the product-wide client-module rule (tests/architecture/inbox-composer-guards):
 * no computed property access and no Date / Object globals in a client module. Lookups, times and record edits it
 * needs are done here, in a plain module, over values the component passes in. */

/** One value of a string-keyed record (a CSS module, the label counts, the drafts). */
export const valueOf = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined => record[key];

/** The record without one key (a discarded draft). */
export const withoutKey = <T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

export const problemText = (problem: NameProblem): string => NAME_PROBLEMS[problem];
export const sourceText = (source: Post["source"] | undefined): string => SOURCE_TEXT[source ?? "unknown"];
/** A sidebar count: "99+" above 99. */
export const countText = (counts: Readonly<Record<string, number>>, id: string): string => {
  const count = counts[id] ?? 0;
  return count > 99 ? "99+" : String(count);
};

const AS_OF_DATE = new Date(AS_OF);
/** The server (UTC) readings the local-time element starts from: short (relative to the synthetic "now" and the time shown above) and exact. */
export const shortUtc = (iso: string, previous?: string): string => localShort(new Date(iso), AS_OF_DATE, previous === undefined ? undefined : new Date(previous), "UTC");
export const fullUtc = (iso: string): string => localFull(new Date(iso), "UTC");

/* ───────────── comment actions (Step 7B-17V-UX) ─────────────
 * Three different facts, never merged:
 *   1. what Meta DOCUMENTS (7B-17V-META, Graph API v27.0 reference — the repository targets v25.0, and a document is
 *      not evidence that anything works in Wrenkind);
 *   2. what Wrenkind IMPLEMENTS today (MUTATION_KINDS = ["reply_public"]; only the Instagram public reply has a path,
 *      disabled by default);
 *   3. what this prototype SIMULATES in the tab's memory. */

export type ActionId = "reply" | "hide" | "delete" | "like" | "block" | "private_reply";
export type MetaDoc = "documented" | "documented_with_limits" | "not_documented";
export type WrenkindToday = "implemented_disabled" | "not_implemented";

export interface CapabilityRow {
  readonly action: ActionId | "comments_toggle";
  readonly name: string;
  readonly platform: Platform;
  readonly meta: MetaDoc;
  /** The limits Meta documents, in a few words. */
  readonly metaNote: string;
  readonly wrenkind: WrenkindToday;
  /** What this prototype does with it (named `simulation`: client modules may not name "prototype"). */
  readonly simulation: "simulated" | "not_offered";
}

export const META_DOC_TEXT: { readonly [D in MetaDoc]: string } = {
  documented: "Documented",
  documented_with_limits: "Documented, with limits",
  not_documented: "Not documented",
};
export const WRENKIND_TEXT: { readonly [W in WrenkindToday]: string } = {
  implemented_disabled: "Built, turned off",
  not_implemented: "Not built",
};
export const PROTOTYPE_TEXT = { simulated: "Simulated here", not_offered: "Not offered" } as const;

export const CAPABILITIES: readonly CapabilityRow[] = [
  { action: "reply", name: "Public reply", platform: "facebook", meta: "documented", metaNote: "Reply to a comment on the Page's content.", wrenkind: "not_implemented", simulation: "simulated" },
  { action: "reply", name: "Public reply", platform: "instagram", meta: "documented_with_limits", metaNote: "Top-level comments only; not hidden comments; not live video.", wrenkind: "implemented_disabled", simulation: "simulated" },
  { action: "hide", name: "Hide / unhide", platform: "facebook", meta: "documented", metaNote: "Comments on the Page's content.", wrenkind: "not_implemented", simulation: "simulated" },
  { action: "hide", name: "Hide / unhide", platform: "instagram", meta: "documented_with_limits", metaNote: "Not the account's own comments; not live video.", wrenkind: "not_implemented", simulation: "simulated" },
  { action: "delete", name: "Delete", platform: "facebook", meta: "documented", metaNote: "Comments on the Page's content.", wrenkind: "not_implemented", simulation: "simulated" },
  { action: "delete", name: "Delete", platform: "instagram", meta: "documented_with_limits", metaNote: "Only on media the account owns.", wrenkind: "not_implemented", simulation: "simulated" },
  { action: "like", name: "Like / unlike", platform: "facebook", meta: "documented_with_limits", metaNote: "Like is documented; unlike on comments needs a compatibility check.", wrenkind: "not_implemented", simulation: "simulated" },
  { action: "like", name: "Like / unlike", platform: "instagram", meta: "not_documented", metaNote: "Like counts can be read; liking from another app is not documented.", wrenkind: "not_implemented", simulation: "not_offered" },
  { action: "block", name: "Block / unblock author", platform: "facebook", meta: "documented_with_limits", metaNote: "The Page blocks a person. Whether a comment's author ID is accepted is unconfirmed; blocking again soon after unblocking may be refused.", wrenkind: "not_implemented", simulation: "simulated" },
  { action: "block", name: "Block / restrict author", platform: "instagram", meta: "not_documented", metaNote: "Only in the Instagram app.", wrenkind: "not_implemented", simulation: "not_offered" },
  { action: "private_reply", name: "Private reply", platform: "facebook", meta: "documented_with_limits", metaNote: "One message per comment, within 7 days; needs messaging permission.", wrenkind: "not_implemented", simulation: "simulated" },
  { action: "private_reply", name: "Private reply", platform: "instagram", meta: "documented_with_limits", metaNote: "One message per comment, within 7 days; needs messaging permission.", wrenkind: "not_implemented", simulation: "simulated" },
  { action: "comments_toggle", name: "Turn comments on or off for a post", platform: "instagram", meta: "documented", metaNote: "A setting of the post, not of a comment.", wrenkind: "not_implemented", simulation: "not_offered" },
];

export type Mode = "standard" | "monitor";
/** "simulate": the actions Meta documents are offered and simulated; "today": they are shown as Wrenkind has them. */
export type ActionsMode = "simulate" | "today";

/* ───── the simulated record of this tab ───── */

export type OpKind = "reply" | "private_reply" | "hide" | "unhide" | "delete" | "like" | "unlike" | "block" | "unblock";
/** The product's outbound states (inbox.outbound.state.*). */
export type OpStatus = "sending" | "sent" | "failed" | "checking" | "blocked";
export type OpAnswer = Exclude<OpStatus, "sending">;

export interface Operation {
  readonly id: string;
  readonly kind: OpKind;
  readonly conversationId: string;
  /**
   * Where the platform receives it: the comment acted on, or — for a reply — the comment the platform attaches it to
   * (on Instagram, the top-level one). What a provider call would address; never the operation's identity on its own.
   */
  readonly commentId: string;
  /**
   * The exact comment a person acted on (UX-05-FINALFIX, audit R-1). For an Instagram reply to a nested comment it
   * differs from `commentId`; everywhere else it is the same. Kept separately so two replies under the same top-level
   * comment — even to the same person — are never mistaken for one another.
   */
  readonly targetId: string;
  readonly status: OpStatus;
  /** Replies only: the text. */
  readonly text?: string;
  /** Replies only: the person answered, when that is not the author of `commentId` (an Instagram reply to a reply). */
  readonly answering?: string;
  /** Block and unblock only: the author key (account + name). */
  readonly author?: string;
  /** When a person started it, on the prototype's synthetic clock (UX-04: attention and the activity history). */
  readonly at?: string;
}

export interface SimState {
  /** comment id → hidden, where a simulated hide or unhide changed what the data says. */
  readonly hidden: Readonly<Record<string, boolean>>;
  readonly deleted: readonly string[];
  readonly liked: readonly string[];
  /** Blocked authors: `${accountId}|${name}`. */
  readonly blocked: readonly string[];
  readonly ops: readonly Operation[];
  readonly nextId: number;
}

export const EMPTY_SIM: SimState = { hidden: {}, deleted: [], liked: [], blocked: [], ops: [], nextId: 1 };

export const authorKey = (accountId: string, comment: Comment): string | undefined => (comment.author.kind === "audience" ? `${accountId}|${comment.author.name}` : undefined);

export interface CommentView {
  /** Present / hidden / removed as the data says, or as a confirmed simulation changed it. */
  readonly presence: Comment["presence"] | "deleted";
  /** True when the visible presence comes from a simulation, not from what the platform reported. */
  readonly simulated: boolean;
  readonly liked: boolean;
  readonly authorBlocked: boolean;
}

export function viewOf(sim: SimState, accountId: string, comment: Comment): CommentView {
  const key = authorKey(accountId, comment);
  const authorBlocked = key !== undefined && sim.blocked.includes(key);
  const liked = sim.liked.includes(comment.id);
  if (sim.deleted.includes(comment.id)) return { presence: "deleted", simulated: true, liked, authorBlocked };
  const override = sim.hidden[comment.id];
  if (override !== undefined && comment.presence !== "removed") {
    const presence = override ? "hidden" : "present";
    return { presence, simulated: presence !== comment.presence, liked, authorBlocked };
  }
  return { presence: comment.presence, simulated: false, liked, authorBlocked };
}

/** The operation still waiting for an answer on a comment (Sending or Checking), if any. */
export const openOpOn = (sim: SimState, commentId: string): Operation | undefined => sim.ops.find((op) => op.commentId === commentId && (op.status === "sending" || op.status === "checking"));

export const privateReplySent = (sim: SimState, commentId: string): boolean => sim.ops.some((op) => op.kind === "private_reply" && op.commentId === commentId && op.status !== "failed" && op.status !== "blocked");

/**
 * Start a simulated operation: it is Sending until a person presses one of the prototype's answers. `targetId` is the
 * exact comment acted on; it defaults to `commentId`, which is right whenever the platform addresses that comment itself.
 */
export function startOp(sim: SimState, op: Omit<Operation, "id" | "status" | "targetId"> & { readonly targetId?: string }): { readonly sim: SimState; readonly id: string } {
  const id = `op-${String(sim.nextId)}`;
  return { id, sim: { ...sim, ops: [...sim.ops, { ...op, targetId: op.targetId ?? op.commentId, id, status: "sending" }], nextId: sim.nextId + 1 } };
}

/**
 * The simulated platform's answer. Sending may become any outcome; Checking (the outcome was unknown) only Sent or
 * Failed, as reconciliation decides. The effect (hidden, deleted, liked, blocked) is applied only on Sent.
 */
export function answerOp(sim: SimState, id: string, answer: OpAnswer): SimState {
  const op = sim.ops.find((item) => item.id === id);
  if (op === undefined) return sim;
  const allowed = op.status === "sending" || (op.status === "checking" && (answer === "sent" || answer === "failed"));
  if (!allowed) return sim;
  const ops = sim.ops.map((item) => (item.id === id ? { ...item, status: answer } : item));
  const next: SimState = { ...sim, ops };
  if (answer !== "sent") return next;
  const without = (list: readonly string[], value: string): readonly string[] => list.filter((item) => item !== value);
  switch (op.kind) {
    case "hide":
      return { ...next, hidden: { ...next.hidden, [op.commentId]: true } };
    case "unhide":
      return { ...next, hidden: { ...next.hidden, [op.commentId]: false } };
    case "delete":
      return { ...next, deleted: [...without(next.deleted, op.commentId), op.commentId] };
    case "like":
      return { ...next, liked: [...without(next.liked, op.commentId), op.commentId] };
    case "unlike":
      return { ...next, liked: without(next.liked, op.commentId) };
    case "block":
      return op.author === undefined ? next : { ...next, blocked: [...without(next.blocked, op.author), op.author] };
    case "unblock":
      return op.author === undefined ? next : { ...next, blocked: without(next.blocked, op.author) };
    case "reply":
    case "private_reply":
      return next;
  }
}

/* ───── private replies: one message per comment, within seven days ───── */

export const PRIVATE_REPLY_DAYS = 7;

export function privateReplyWindow(comment: Comment): { readonly open: boolean; readonly closesAt: string } {
  const closes = new Date(new Date(comment.at).getTime() + PRIVATE_REPLY_DAYS * 86_400_000);
  return { open: closes.getTime() > new Date(AS_OF).getTime(), closesAt: closes.toISOString().replace(".000Z", "Z") };
}

/** The window closes within a day: worth saying before someone writes. */
export const privateReplyClosingSoon = (comment: Comment): boolean => {
  const window = privateReplyWindow(comment);
  return window.open && new Date(window.closesAt).getTime() - new Date(AS_OF).getTime() < 86_400_000;
};

/* ───── where a reply goes ───── */

/**
 * The comment a public reply attaches to. Instagram accepts replies to top-level comments only: answering a reply
 * posts under the top-level comment and names the person answered, so the thread keeps its root.
 */
export function replyTargetOf(conversation: Conversation, comment: Comment, platform: Platform): { readonly commentId: string; readonly answering?: string } {
  const root = conversation.comments[0];
  if (platform === "instagram" && comment.parentId !== null && root !== undefined) {
    const name = comment.author.kind === "audience" ? comment.author.name : undefined;
    return { commentId: root.id, ...(name === undefined ? {} : { answering: name }) };
  }
  return { commentId: comment.id };
}

/* ───── the resolver: one decision per action, in the product's order (IA §18, TA §16.6) ───── */

export type Availability =
  | { readonly kind: "hidden" }
  | { readonly kind: "unavailable"; readonly cause: "mode" | "wrenkind" | "platform" | "connection" | "state"; readonly reason: string }
  | { readonly kind: "available" };

export interface ActionInput {
  readonly action: ActionId;
  readonly role: Role;
  readonly mode: Mode;
  readonly actions: ActionsMode;
  /** The account's connection health ("healthy" when the prototype control says every connection is). */
  readonly accountHealth: Account["health"];
  readonly conversation: Conversation;
  readonly comment: Comment;
  readonly sim: SimState;
}

const ABILITY: { readonly [A in ActionId]: keyof Abilities } = { reply: "reply", hide: "hide", delete: "delete", like: "like", block: "block", private_reply: "replyPrivately" };
const PROVIDER_ACTIONS_ON_OWN: readonly ActionId[] = ["delete"];

export function availabilityOf(input: ActionInput): Availability {
  const { action, role, mode, actions, accountHealth, conversation, comment, sim } = input;
  const account = accountOf(conversation.accountId);
  const post = postOf(conversation.postId);
  if (account === undefined) return { kind: "hidden" };
  const platform = account.platform;
  const view = viewOf(sim, account.id, comment);
  // 1. The role does not allow it → not drawn.
  if (!abilitiesOf(role)[ABILITY[action]]) return { kind: "hidden" };
  // Not an action this comment or platform has at all → not drawn (Instagram: no Like, no Block from other apps;
  // the account's own comment: only Delete; a comment no longer on the platform: nothing).
  if (platform === "instagram" && (action === "like" || action === "block")) return { kind: "hidden" };
  if (comment.author.kind === "own" && !PROVIDER_ACTIONS_ON_OWN.includes(action)) return { kind: "hidden" };
  if (view.presence === "removed" || view.presence === "deleted") return { kind: "hidden" };
  // 2. Monitor-only.
  if (mode === "monitor") return { kind: "unavailable", cause: "mode", reason: "This workspace is Monitor-only." };
  // 3. What Wrenkind has today (the prototype's "as today" setting).
  if (actions === "today") {
    const reason = platform === "instagram" && action === "reply" ? "Public replies aren't enabled in Wrenkind yet for this content." : "Not available in Wrenkind yet.";
    return { kind: "unavailable", cause: "wrenkind", reason };
  }
  // 3. What the platform does not let another app do here.
  const restriction = platformRestriction(action, post);
  if (restriction !== undefined) return { kind: "unavailable", cause: "platform", reason: restriction };
  // 4. The connection needs attention → blocked, with the recovery.
  if (accountHealth === "needs_attention") return { kind: "unavailable", cause: "connection", reason: `Reconnect ${account.verifiedName ?? `your ${platformName(account)} account`} to act on its comments.` };
  // 5. The comment's own state.
  const target = action === "reply" ? replyTargetOf(conversation, comment, platform).commentId : comment.id;
  const open = openOpOn(sim, target) ?? openOpOn(sim, comment.id);
  if (open !== undefined) {
    if (action === "reply" && open.kind === "reply") return { kind: "unavailable", cause: "state", reason: "A reply to this comment is on its way or being checked. You can write another once its outcome is known." };
    return { kind: "unavailable", cause: "state", reason: "Another action on this comment is still waiting for its outcome." };
  }
  if ((action === "reply" || action === "private_reply") && view.presence === "hidden") return { kind: "unavailable", cause: "state", reason: "Unhide this comment before replying to it." };
  if (action === "block" && comment.author.kind !== "audience") return { kind: "unavailable", cause: "state", reason: "This comment's author isn't known, so they can't be blocked." };
  if (action === "private_reply") {
    if (privateReplySent(sim, comment.id)) return { kind: "unavailable", cause: "state", reason: "A private reply was already sent for this comment. Only one is allowed." };
    if (!privateReplyWindow(comment).open) return { kind: "unavailable", cause: "state", reason: `Private replies can only be sent within ${String(PRIVATE_REPLY_DAYS)} days of the comment.` };
  }
  return { kind: "available" };
}

/* ───── revalidation at the moment of acting (UX4, audit H-1) ───── */

const ACTION_OF_OP: { readonly [K in OpKind]: ActionId } = {
  reply: "reply",
  private_reply: "private_reply",
  hide: "hide",
  unhide: "hide",
  delete: "delete",
  like: "like",
  unlike: "like",
  block: "block",
  unblock: "block",
};

export const actionOfOp = (kind: OpKind): ActionId => ACTION_OF_OP[kind];

/**
 * Whether an operation may START now, decided again from the current state at the moment a person confirms it — never
 * from what a panel, a menu or a "Try again" button showed earlier. The same resolver (role → Monitor-only → Wrenkind
 * today → platform → connection → the comment's state), then the direction: Hide only a visible comment, Unhide only a
 * hidden one, Like only an unliked one, Block only an unblocked author (and the reverse).
 */
export function opAvailability(input: Omit<ActionInput, "action">, kind: OpKind): Availability {
  const result = availabilityOf({ ...input, action: actionOfOp(kind) });
  if (result.kind !== "available") return result;
  const view = viewOf(input.sim, input.conversation.accountId, input.comment);
  const changed = { kind: "unavailable", cause: "state", reason: "This comment changed in the meantime. Nothing was done." } as const;
  if (kind === "hide" && view.presence !== "present") return changed;
  if (kind === "unhide" && view.presence !== "hidden") return changed;
  if (kind === "like" && view.liked) return changed;
  if (kind === "unlike" && !view.liked) return changed;
  if (kind === "block" && view.authorBlocked) return changed;
  if (kind === "unblock" && !view.authorBlocked) return changed;
  return result;
}

/** Where the platform itself does not let another app act: the reason, in outcome language; undefined when it does. */
export function platformRestriction(action: ActionId, post: Post | undefined): string | undefined {
  // Outcome language for the person at work; the API detail behind each reason lives in the capability reference.
  if (post?.surface === "live") return "Comments on live videos can only be managed in the Instagram app.";
  if (post?.surface === "story_ad") return "Comments on story ads can only be managed in the Instagram app.";
  if (post !== undefined && post.owner !== null) {
    if (action === "hide" || action === "delete") return `Only ${post.owner}, who posted this, can hide or delete its comments.`;
    return "Not available yet on posts your account doesn't own.";
  }
  // Ads (UX-05 M-2): what Meta documents for a Page's or an account's own posts is not evidence for comments on ads.
  // Until replying and moderating there are validated, they are unavailable, never offered as if they worked.
  if (isAdContext(post)) return action === "reply" || action === "private_reply" ? "Replying to comments on ads isn't validated in Wrenkind yet." : "Not available yet for comments on ads.";
  return undefined;
}

/**
 * A comment on an ad: a paid post, an ad that never ran as a Page post, or a post reported as an Ad. A post reported
 * as both organic and paid is the Page's own post (it is not treated as an ad here — an open question in the decision
 * register, H-17).
 */
export const isAdContext = (post: Post | undefined): boolean => post !== undefined && (post.source === "paid" || post.surface === "dark_post" || post.surface === "story_ad" || post.kind === "Ad");

/** One line about the conversation's context, said once above its comments when it restricts every action. */
export function contextNotice(conversation: Conversation, accountHealth: Account["health"], actions: ActionsMode, mode: Mode): { readonly cause: "platform" | "connection" | "mode"; readonly text: string } | undefined {
  const account = accountOf(conversation.accountId);
  const post = postOf(conversation.postId);
  if (account === undefined) return undefined;
  if (mode === "monitor") return { cause: "mode", text: "This workspace is Monitor-only: nothing is done on the platform from here." };
  if (actions === "today") return undefined;
  if (post?.surface === "live") return { cause: "platform", text: "Comments on live videos can only be managed in the Instagram app. You can read and label them here." };
  if (post?.surface === "story_ad") return { cause: "platform", text: "Comments on story ads can only be managed in the Instagram app. You can read and label them here." };
  if (post !== undefined && post.owner !== null) return { cause: "platform", text: `${post.owner} posted this and tagged your account. Only they can hide or delete its comments.` };
  if (isAdContext(post)) return { cause: "platform", text: "This conversation is on an ad. Replying and moderating there aren't validated in Wrenkind yet: you can read, label and manage it here." };
  if (accountHealth === "needs_attention") return { cause: "connection", text: `${account.verifiedName ?? `Your ${platformName(account)} account`} needs to be reconnected. Until then, actions on its comments are blocked. Reconnect it in Settings › Connections.` };
  return undefined;
}

/* ───── how an operation reads ───── */

const VERB: { readonly [K in OpKind]: readonly [doing: string, done: string, failed: string] } = {
  reply: ["Publishing this reply", "Published", "This reply was not published."],
  private_reply: ["Sending this private reply", "Sent", "This private reply was not sent."],
  hide: ["Hiding this comment", "Hidden", "The comment was not hidden."],
  unhide: ["Unhiding this comment", "Unhidden", "The comment is still hidden."],
  delete: ["Deleting this comment", "Deleted", "The comment was not deleted."],
  like: ["Liking this comment", "Liked", "The comment was not liked."],
  unlike: ["Removing the like", "Like removed", "The like is still there."],
  block: ["Blocking this author", "Author blocked", "The author was not blocked."],
  unblock: ["Unblocking this author", "Author unblocked", "The author is still blocked."],
};

export const STATUS_TEXT: { readonly [S in OpStatus]: string } = { sending: "Sending", sent: "Sent", failed: "Failed", checking: "Checking", blocked: "Blocked" };
export const STATUS_TONE: { readonly [S in OpStatus]: "neutral" | "success" | "warning" | "danger" } = { sending: "neutral", sent: "success", failed: "danger", checking: "warning", blocked: "danger" };

/**
 * The sentence under a simulated operation: what the product would say, framed as a simulation — never that the
 * platform did it.
 */
export function opSentence(op: Operation, platform: string): string {
  const [doing, done, failed] = VERB[op.kind];
  switch (op.status) {
    case "sending":
      return `${doing}… Simulated — nothing is sent to ${platform}.`;
    case "sent":
      return `Simulated outcome: ${done.toLowerCase()}. Nothing was sent to ${platform}.`;
    case "failed":
      return `Simulated failure: ${failed} Nothing was sent to ${platform}.`;
    case "checking":
      return `Simulated unknown outcome: in the product, Wrenkind checks with ${platform} before anything is tried again. Nothing was sent to ${platform}.`;
    case "blocked":
      return `Simulated stop before reaching ${platform} (for example, the workspace became Monitor-only). Nothing was sent to ${platform}.`;
  }
}

export const opStatusText = (status: OpStatus): string => STATUS_TEXT[status];
export const opStatusTone = (status: OpStatus): "neutral" | "success" | "warning" | "danger" => STATUS_TONE[status];
/** A state-setting action that failed may be tried again; a reply never is (it is written again, by a person). */
export const retryable = (op: Operation): boolean => op.status === "failed" && op.kind !== "reply" && op.kind !== "private_reply";

/* ───── synthetic assessments ───── */

export const assessmentOf = (commentId: string): Assessment | undefined => SEED_ASSESSMENTS[commentId];

/** The labels of a conversation with how many of its comments carry each (never "the whole thread"). */
export function labelSummary(state: LabelState, conversation: Conversation): readonly { readonly label: Label; readonly comments: number }[] {
  return conversationLabels(state, conversation).flatMap((id) => {
    const label = state.labels.find((item) => item.id === id);
    if (label === undefined) return [];
    return [{ label, comments: conversation.comments.filter((comment) => labelsOn(state, comment.id).includes(id)).length }];
  });
}

export const capabilityRows = (action: CapabilityRow["action"]): readonly CapabilityRow[] => CAPABILITIES.filter((row) => row.action === action);
export const metaDocText = (doc: MetaDoc): string => META_DOC_TEXT[doc];
export const wrenkindText = (today: WrenkindToday): string => WRENKIND_TEXT[today];

/* ───── the source publication, as a compact preview (UX2) ───── */

export interface SourcePreview {
  /** The shape the tile takes: no media is drawn — Wrenkind has not retrieved any, and the prototype invents none. */
  readonly shape: "square" | "portrait" | "landscape";
  readonly kind: string;
  /** Organic / Paid / Organic and paid / Source not reported — said explicitly in the preview, never inferred. */
  readonly source: string;
  /** Where moderation is limited by the context itself (live, story ad, someone else's post). */
  readonly context: string | undefined;
}

const SOURCE_SHORT: { readonly [S in Post["source"]]: string } = { organic: "Organic", paid: "Paid", mixed: "Organic and paid", unknown: "Source not reported" };

export function previewOf(post: Post | undefined): SourcePreview | undefined {
  if (post === undefined) return undefined;
  const shape = post.kind === "Reel" || post.kind === "Story ad" ? "portrait" : post.kind === "Video" || post.kind === "Live video" ? "landscape" : "square";
  const context = post.surface === "live" || post.surface === "story_ad" ? "Managed in the Instagram app" : post.owner !== null ? `Posted by ${post.owner}` : isAdContext(post) ? "Ad · replies and moderation not validated yet" : undefined;
  return { shape, kind: post.kind, source: SOURCE_SHORT[post.source], context };
}

/* ═════════════ UX-04: the interactive workspace — workflow, attention, views, filters, label management ═════════════
 * Development-prototype HYPOTHESES (design/phase-7b/comments-redesign/UX04-DECISION-REGISTER.md): Needs attention as a
 * view, a person's Urgent flag, no automatic Done after a reply, Labels (manual) vs Signals (future Intelligence). Every
 * rule is a pure function over the synthetic fixtures and the caller's state; nothing is stored, sent or read. */

/* ───── the synthetic clock: every recorded change moves it one minute after AS_OF ───── */

const plusMinutes = (iso: string, delta: number): string => new Date(new Date(iso).getTime() + delta * 60_000).toISOString().replace(".000Z", "Z");
const minutesBetween = (from: string, to: string): number => Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000));

/** "40 min", "4 h", "2 h 10 min", "3 d". */
export function durationText(minutes: number): string {
  if (minutes < 60) return `${String(minutes)} min`;
  if (minutes < 1440) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return hours < 3 && rest > 0 ? `${String(hours)} h ${String(rest)} min` : `${String(hours)} h`;
  }
  return `${String(Math.floor(minutes / 1440))} d`;
}

/* ───── the team ───── */

export const memberOf = (id: string | undefined): Member | undefined => (id === undefined ? undefined : MEMBERS.find((member) => member.id === id));
/** The person using the prototype (Ana Ruiz); the prototype bar changes her role, not who she is. */
export const ME_MEMBER: Member = memberOf(ME) ?? { id: ME, name: "You", initials: "—", team: "Management" };

/* ───── workflow (IA-04: Open / Done with a resolution; hypotheses: Urgent flag, no automatic Done) ───── */

export type Resolution = SeedResolution | "reviewed";

export const RESOLUTIONS: readonly { readonly id: Resolution; readonly name: string; readonly monitorOnly?: true }[] = [
  { id: "replied_publicly", name: "Replied publicly" },
  { id: "replied_privately", name: "Replied privately" },
  { id: "replied_on_platform", name: "Replied on the platform" },
  { id: "no_reply_needed", name: "No reply needed" },
  { id: "moderated", name: "Moderated" },
  { id: "reviewed", name: "Reviewed", monitorOnly: true },
];

export const resolutionName = (id: Resolution | undefined): string => RESOLUTIONS.find((item) => item.id === id)?.name ?? "Done";
/** "Reviewed" exists for a Monitor-only workspace (replies happen outside Wrenkind); the rest everywhere. */
export const resolutionsFor = (mode: Mode): readonly { readonly id: Resolution; readonly name: string }[] => RESOLUTIONS.filter((item) => item.monitorOnly !== true || mode === "monitor");

export interface Flow {
  readonly status: "open" | "done";
  readonly resolution?: Resolution;
  /** Member id. */
  readonly assignee?: string;
  /** A person's Urgent flag (never set by Wrenkind); cleared on Done, kept in the history. */
  readonly urgent?: { readonly by: string; readonly at: string };
  /** A hand-off to someone outside the first answer; independent from Urgent. */
  readonly escalation?: { readonly to: string; readonly by: string; readonly at: string; readonly note?: string };
}

export interface ActivityEntry {
  readonly id: string;
  readonly conversationId: string;
  readonly at: string;
  /** A member's name, an author's name, or "Wrenkind" for an automatic change. */
  readonly by: string;
  readonly text: string;
}

export interface Workflow {
  readonly flows: Readonly<Record<string, Flow>>;
  readonly activity: readonly ActivityEntry[];
  /** Audience comments a person made arrive with the prototype control (conversation id → comments). */
  readonly arrived: Readonly<Record<string, readonly Comment[]>>;
  /** Minutes after AS_OF on the synthetic clock. */
  readonly clock: number;
  readonly nextId: number;
}

export const OPEN_FLOW: Flow = { status: "open" };

/** A flow without some of its optional parts (unassigned, no longer urgent…). */
const omit = (flow: Flow, ...keys: readonly (keyof Flow)[]): Flow => Object.fromEntries(Object.entries(flow).filter(([key]) => !keys.some((item) => item === key))) as unknown as Flow;
export const flowOf = (wf: Workflow, conversationId: string): Flow => wf.flows[conversationId] ?? OPEN_FLOW;
export const nowOf = (wf: Workflow): string => plusMinutes(AS_OF, wf.clock);

/** The starting workflow: the seeds' Open / Done, assignees, Urgent and escalation, each with its history entry. */
export const SEED_WORKFLOW: Workflow = (() => {
  const flows: Record<string, Flow> = {};
  const activity: ActivityEntry[] = [];
  let next = 1;
  const log = (conversationId: string, at: string, text: string, by = "Ana Ruiz"): void => {
    activity.push({ id: `a-${String(next)}`, conversationId, at, by, text });
    next += 1;
  };
  for (const conversation of CONVERSATIONS) {
    const seed = SEED_FLOWS[conversation.id];
    if (seed === undefined) continue;
    const anchor = conversation.comments[0]?.at ?? AS_OF;
    const flow: { -readonly [K in keyof Flow]: Flow[K] } = { status: seed.done === undefined ? "open" : "done" };
    if (seed.assignee !== undefined) {
      flow.assignee = seed.assignee;
      log(conversation.id, plusMinutes(anchor, 3), `Assigned to ${memberOf(seed.assignee)?.name ?? "a member"}`);
    }
    if (seed.urgent === true) {
      flow.urgent = { by: "Ana Ruiz", at: plusMinutes(anchor, 4) };
      log(conversation.id, plusMinutes(anchor, 4), "Marked urgent");
    }
    if (seed.escalated !== undefined) {
      flow.escalation = { to: seed.escalated, by: "Ana Ruiz", at: plusMinutes(anchor, 5) };
      log(conversation.id, plusMinutes(anchor, 5), `Escalated to ${seed.escalated}`);
    }
    if (seed.done !== undefined) {
      flow.resolution = seed.done;
      log(conversation.id, plusMinutes(anchor, 30), `Marked done · ${resolutionName(seed.done)}`);
    }
    flows[conversation.id] = flow;
  }
  return { flows, activity, arrived: {}, clock: 0, nextId: next };
})();

/** The seeded simulation: one public reply whose outcome is still being checked (attention: "Reply not confirmed"). */
export const SEED_SIM: SimState = {
  ...EMPTY_SIM,
  ops: [{ id: "op-seed", kind: "reply", conversationId: SEED_CHECKING_REPLY.conversationId, commentId: SEED_CHECKING_REPLY.commentId, targetId: SEED_CHECKING_REPLY.commentId, status: "checking", text: SEED_CHECKING_REPLY.text, at: SEED_CHECKING_REPLY.at }],
};

/** A conversation with the audience comments a person made arrive in the prototype. */
export function liveOf(conversation: Conversation, wf: Workflow): Conversation {
  const extra = wf.arrived[conversation.id];
  return extra === undefined || extra.length === 0 ? conversation : { ...conversation, comments: [...conversation.comments, ...extra] };
}

export type WorkflowResult = { readonly ok: true; readonly wf: Workflow; readonly message: string } | { readonly ok: false; readonly reason: string };

const NOT_ALLOWED = "Your role can't manage conversations.";

/** Record one change: the flow, its history entry, one minute on the clock. */
function change(wf: Workflow, conversationId: string, flow: Flow, text: string, by: string = ME_MEMBER.name): Workflow {
  const at = plusMinutes(AS_OF, wf.clock + 1);
  return {
    ...wf,
    flows: { ...wf.flows, [conversationId]: flow },
    activity: [...wf.activity, { id: `a-${String(wf.nextId)}`, conversationId, at, by, text }],
    clock: wf.clock + 1,
    nextId: wf.nextId + 1,
  };
}

/** A history entry with no change to the flow (a comment action, a label, a note). */
export function logActivity(wf: Workflow, conversationId: string, text: string, by: string = ME_MEMBER.name): Workflow {
  return change(wf, conversationId, flowOf(wf, conversationId), text, by);
}

export function assignConversation(wf: Workflow, role: Role, conversationId: string, memberId: string | undefined): WorkflowResult {
  if (!abilitiesOf(role).manage) return { ok: false, reason: NOT_ALLOWED };
  const flow = flowOf(wf, conversationId);
  if (flow.assignee === memberId) return { ok: false, reason: memberId === undefined ? "It isn't assigned." : `It's already assigned to ${memberOf(memberId)?.name ?? "them"}.` };
  const member = memberOf(memberId);
  if (memberId !== undefined && member === undefined) return { ok: false, reason: "That person isn't in this workspace." };
  const rest = omit(flow, "assignee");
  const next: Flow = member === undefined ? rest : { ...rest, assignee: member.id };
  const text = member === undefined ? "Unassigned" : `Assigned to ${member.name}`;
  return { ok: true, wf: change(wf, conversationId, next, text), message: text };
}

export function setUrgent(wf: Workflow, role: Role, conversationId: string, on: boolean): WorkflowResult {
  if (!abilitiesOf(role).manage) return { ok: false, reason: NOT_ALLOWED };
  const flow = flowOf(wf, conversationId);
  if (flow.status === "done") return { ok: false, reason: "Reopen the conversation to mark it urgent." };
  if ((flow.urgent !== undefined) === on) return { ok: false, reason: on ? "It's already urgent." : "It isn't urgent." };
  const rest = omit(flow, "urgent");
  const next: Flow = on ? { ...rest, urgent: { by: ME_MEMBER.name, at: plusMinutes(AS_OF, wf.clock + 1) } } : rest;
  const text = on ? "Marked urgent" : "Removed urgent";
  return { ok: true, wf: change(wf, conversationId, next, text), message: text };
}

export function escalateConversation(wf: Workflow, role: Role, conversationId: string, to: string, note: string): WorkflowResult {
  if (!abilitiesOf(role).manage) return { ok: false, reason: NOT_ALLOWED };
  const flow = flowOf(wf, conversationId);
  if (flow.status === "done") return { ok: false, reason: "Reopen the conversation to escalate it." };
  if (to.trim() === "") return { ok: false, reason: "Choose who to escalate to." };
  const trimmed = note.replace(/\s+/g, " ").trim();
  const escalation = { to, by: ME_MEMBER.name, at: plusMinutes(AS_OF, wf.clock + 1), ...(trimmed === "" ? {} : { note: trimmed }) };
  const text = `Escalated to ${to}${trimmed === "" ? "" : ` — “${trimmed}”`}`;
  return { ok: true, wf: change(wf, conversationId, { ...flow, escalation }, text), message: `Escalated to ${to}` };
}

export function closeEscalation(wf: Workflow, role: Role, conversationId: string): WorkflowResult {
  if (!abilitiesOf(role).manage) return { ok: false, reason: NOT_ALLOWED };
  const flow = flowOf(wf, conversationId);
  if (flow.escalation === undefined) return { ok: false, reason: "It isn't escalated." };
  const { escalation, ...rest } = flow;
  const text = `Escalation to ${escalation.to} closed`;
  return { ok: true, wf: change(wf, conversationId, rest, text), message: text };
}

/**
 * Done always needs a resolution. Urgent and an open escalation end with it (their history stays). A reply never does
 * this on its own: only a person marks a conversation Done (hypothesis H-1 of the decision register).
 *
 * UX-05 H-2: decided again from the current simulated record at the moment it is applied — never while an operation
 * on the conversation is Sending or Checking (whether it reached the platform isn't known), and never "Replied publicly"
 * or "Replied privately" without a reply of that kind confirmed Sent. Choosing a resolution records what a person
 * says; it never marks any reply as delivered.
 */
export function markDone(wf: Workflow, role: Role, mode: Mode, conversationId: string, resolution: Resolution, sim: SimState): WorkflowResult {
  if (!abilitiesOf(role).manage) return { ok: false, reason: NOT_ALLOWED };
  const flow = flowOf(wf, conversationId);
  if (flow.status === "done") return { ok: false, reason: "It's already done." };
  const blocker = doneBlocker(conversationId, sim);
  if (blocker !== undefined) return { ok: false, reason: blocker };
  const choice = resolutionChoices(mode, conversationId, sim).find((item) => item.id === resolution);
  if (choice === undefined) return { ok: false, reason: "Choose how it was resolved." };
  if (choice.unavailable !== undefined) return { ok: false, reason: choice.unavailable };
  let next = wf;
  if (flow.urgent !== undefined) next = change(next, conversationId, flowOf(next, conversationId), "Urgent cleared when marked done");
  if (flow.escalation !== undefined) next = change(next, conversationId, flowOf(next, conversationId), `Escalation to ${flow.escalation.to} closed when marked done`);
  const rest = omit(flow, "urgent", "escalation");
  const text = `Marked done · ${resolutionName(resolution)}`;
  return { ok: true, wf: change(next, conversationId, { ...rest, status: "done", resolution }, text), message: text };
}

export function reopenConversation(wf: Workflow, role: Role, conversationId: string): WorkflowResult {
  if (!abilitiesOf(role).manage) return { ok: false, reason: NOT_ALLOWED };
  const flow = flowOf(wf, conversationId);
  if (flow.status === "open") return { ok: false, reason: "It's already open." };
  return { ok: true, wf: change(wf, conversationId, { ...omit(flow, "resolution"), status: "open" }, "Reopened"), message: "Reopened" };
}

export const NOTE_MAX = 500;

export function addNote(wf: Workflow, role: Role, conversationId: string, raw: string): WorkflowResult {
  if (!abilitiesOf(role).manage) return { ok: false, reason: NOT_ALLOWED };
  const text = raw.replace(/\s+/g, " ").trim();
  if (text === "") return { ok: false, reason: "Write the note first." };
  if (Array.from(text).length > NOTE_MAX) return { ok: false, reason: `Use ${String(NOTE_MAX)} characters or fewer.` };
  return { ok: true, wf: logActivity(wf, conversationId, `Note: “${text}”`), message: "Note added" };
}

/**
 * Prototype control: the conversation's author writes again (synthetic text). A Done conversation reopens by itself
 * (IA-04 auto-reopen), recorded as Wrenkind's change; an Open one gains "New reply" attention when the brand had answered.
 */
export function audienceWritesAgain(wf: Workflow, conversation: Conversation): Workflow {
  const live = liveOf(conversation, wf);
  const root = live.comments[0];
  const author = [...live.comments].reverse().find((comment) => comment.author.kind === "audience")?.author ?? root?.author;
  if (root === undefined || author === undefined || author.kind !== "audience") return wf;
  const at = plusMinutes(AS_OF, wf.clock + 1);
  const index = (wf.arrived[conversation.id]?.length ?? 0) + 1;
  const comment: Comment = { id: `${conversation.id}-n${String(index).padStart(2, "0")}`, parentId: root.id, author, text: "Any news on this? Still waiting for an answer.", at, editedAt: null, readAt: plusMinutes(at, 1), presence: "present" };
  const arrived = { ...wf.arrived, [conversation.id]: [...(wf.arrived[conversation.id] ?? []), comment] };
  let next = logActivity({ ...wf, arrived }, conversation.id, `New reply from ${author.name}`, author.name);
  const flow = flowOf(next, conversation.id);
  if (flow.status === "done") {
    next = change(next, conversation.id, { ...omit(flow, "resolution"), status: "open" }, `Reopened automatically: ${author.name} wrote again`, "Wrenkind");
  }
  return next;
}

/* ───── outgoing replies: what is still unknown or unresolved (UX-05 H-1, H-2) ───── */

const OUTBOUND: readonly OpKind[] = ["reply", "private_reply"];

/**
 * One outgoing reply's identity: its kind and the EXACT comment it answers (`targetId`). Not the top-level comment the
 * platform attaches it to, and not the person answered: on Instagram two replies under one top-level comment — even to
 * two comments by the same person — are different replies (audit R-1). A later reply resolves an earlier failure only
 * when it has the same identity and is confirmed Sent.
 */
export const replyIdentity = (op: Operation): string => `${op.kind}|${op.targetId}`;

/**
 * The conversation's outgoing replies whose outcome still needs a person, oldest first: every reply being Checked
 * (the outcome is unknown until reconciliation answers), and every Failed or Stopped reply that no later reply with
 * the same identity has replaced with a confirmed Sent. A reply still Sending is in flight, not yet unresolved; a new
 * one never hides an earlier failure, and a reply to one comment never resolves another comment's failure.
 */
export function unresolvedReplies(conversationId: string, sim: SimState): readonly Operation[] {
  const ops = sim.ops.filter((op) => op.conversationId === conversationId && OUTBOUND.includes(op.kind));
  return ops.filter((op, index) => {
    if (op.status === "checking") return true;
    if (op.status !== "failed" && op.status !== "blocked") return false;
    return !ops.slice(index + 1).some((later) => later.status === "sent" && replyIdentity(later) === replyIdentity(op));
  });
}

/** Simulated operations on the conversation whose outcome is not known yet (Sending or Checking), any kind. */
export const operationsInFlight = (conversationId: string, sim: SimState): readonly Operation[] => sim.ops.filter((op) => op.conversationId === conversationId && (op.status === "sending" || op.status === "checking"));

/** Why the conversation can't be marked Done right now, or undefined when it can. */
export function doneBlocker(conversationId: string, sim: SimState): string | undefined {
  const flying = operationsInFlight(conversationId, sim);
  if (flying.length === 0) return undefined;
  const reply = flying.find((op) => OUTBOUND.includes(op.kind));
  if (reply === undefined) return "An action on one of its comments is still waiting for its outcome. Mark it done once that outcome is known.";
  return reply.status === "checking"
    ? "A reply's outcome is still being checked: it isn't known whether it reached the platform. Mark it done once it's confirmed sent or has failed."
    : "A reply is still being sent. Mark it done once it's confirmed sent or has failed.";
}

/** Whether a reply of this kind from Wrenkind is confirmed Sent in the conversation (published earlier, or simulated here). */
export function replyConfirmed(conversationId: string, kind: "reply" | "private_reply", sim: SimState): boolean {
  const seeded = kind === "reply" && (CONVERSATIONS.find((item) => item.id === conversationId)?.sent.length ?? 0) > 0;
  return seeded || sim.ops.some((op) => op.conversationId === conversationId && op.kind === kind && op.status === "sent");
}

/**
 * The resolutions a person may choose now. "Replied publicly" and "Replied privately" stay listed but unavailable,
 * with the reason, until a reply of that kind is confirmed Sent. "Replied on the platform" is a person's statement about
 * something done outside Wrenkind: it is recorded as said, and no reply is assumed from it.
 */
export function resolutionChoices(mode: Mode, conversationId: string, sim: SimState): readonly { readonly id: Resolution; readonly name: string; readonly unavailable?: string }[] {
  return resolutionsFor(mode).map((item) => {
    if (item.id === "replied_publicly" && !replyConfirmed(conversationId, "reply", sim)) return { ...item, unavailable: "No public reply from Wrenkind is confirmed sent in this conversation." };
    if (item.id === "replied_privately" && !replyConfirmed(conversationId, "private_reply", sim)) return { ...item, unavailable: "No private reply from Wrenkind is confirmed sent in this conversation." };
    return item;
  });
}

/* ───── attention: explainable operational facts, never meaning (hypothesis H-2) ───── */

export type AttentionReason = "reply_unconfirmed" | "connection" | "new_reply" | "waiting";

/** In precedence order: one reason is shown, the first that applies. */
export const ATTENTION_REASONS: readonly { readonly id: AttentionReason; readonly name: string }[] = [
  { id: "reply_unconfirmed", name: "A reply of yours isn't confirmed" },
  { id: "connection", name: "The account needs reconnecting" },
  { id: "new_reply", name: "They wrote again after your reply" },
  { id: "waiting", name: "Waiting over the response target" },
];

export interface Attention {
  readonly reason: AttentionReason;
  readonly text: string;
  /** Since when (ordering: the longest-waiting first). */
  readonly since: string;
  /** A failure to act on (amber), rather than a fact about time. */
  readonly warn: boolean;
}

/** What the list, views and attention read from the prototype's state. */
export interface WorkContext {
  readonly labels: LabelState;
  readonly wf: Workflow;
  readonly sim: SimState;
  /** The prototype control that makes every connection healthy. */
  readonly allHealthy: boolean;
  /** The response target in minutes: a synthetic test value (4 h by default), never a product SLA. */
  readonly target: number;
}

export const TARGETS: readonly { readonly minutes: number; readonly name: string }[] = [
  { minutes: 60, name: "1 hour" },
  { minutes: 240, name: "4 hours" },
  { minutes: 480, name: "8 hours" },
];

/** The latest moment the brand answered: its own comments, replies published earlier, simulated replies confirmed Sent. */
export function latestBrand(conversation: Conversation, sim: SimState): string | undefined {
  const times = [
    ...conversation.comments.filter((comment) => comment.author.kind === "own").map((comment) => comment.at),
    ...conversation.sent.map((reply) => reply.publishedAt),
    ...sim.ops.filter((op) => op.conversationId === conversation.id && OUTBOUND.includes(op.kind) && op.status === "sent" && op.at !== undefined).map((op) => op.at ?? ""),
  ];
  return times.reduce<string | undefined>((latest, at) => (latest === undefined || at > latest ? at : latest), undefined);
}

/** The latest audience comment still visible on the platform (a hidden, removed or deleted one asks for no answer). */
export function latestAudience(conversation: Conversation, sim: SimState): string | undefined {
  const times = conversation.comments.filter((comment) => comment.author.kind !== "own" && viewOf(sim, conversation.accountId, comment).presence === "present").map((comment) => comment.at);
  return times.reduce<string | undefined>((latest, at) => (latest === undefined || at > latest ? at : latest), undefined);
}

const healthy = (conversation: Conversation, allHealthy: boolean): boolean => allHealthy || accountOf(conversation.accountId)?.health !== "needs_attention";

/**
 * Why an Open conversation needs a person now — or undefined. Only four facts count, in this order: an outgoing reply
 * not confirmed (Checking, Failed, Stopped), a connection to repair, the audience writing again after the brand's
 * latest answer, waiting beyond the response target. A fresh unanswered comment inside the target is not attention;
 * labels, Urgent, sentiment and AI never are. A Done conversation needs none.
 */
export function attentionOf(conversation: Conversation, ctx: WorkContext): Attention | undefined {
  if (flowOf(ctx.wf, conversation.id).status === "done") return undefined;
  const now = nowOf(ctx.wf);
  // Every unresolved reply counts (UX-05 H-1), not only the latest one: the most uncertain is named, the oldest dates it.
  const unresolved = unresolvedReplies(conversation.id, ctx.sim);
  if (unresolved.length > 0) {
    const named = unresolved.find((op) => op.status === "checking") ?? unresolved.find((op) => op.status === "failed") ?? unresolved[0];
    const one = named?.status === "checking" ? "Reply not confirmed" : named?.status === "failed" ? "Reply failed" : "Reply stopped";
    const text = unresolved.length === 1 ? one : `${String(unresolved.length)} replies not confirmed`;
    const since = unresolved.reduce<string | undefined>((earliest, op) => (op.at !== undefined && (earliest === undefined || op.at < earliest) ? op.at : earliest), undefined) ?? now;
    return { reason: "reply_unconfirmed", text, since, warn: true };
  }
  if (!healthy(conversation, ctx.allHealthy)) return { reason: "connection", text: "Reconnect account", since: now, warn: true };
  const audience = latestAudience(conversation, ctx.sim);
  if (audience === undefined) return undefined;
  const brand = latestBrand(conversation, ctx.sim);
  if (brand !== undefined) return audience > brand ? { reason: "new_reply", text: `New reply · ${durationText(minutesBetween(audience, now))}`, since: audience, warn: false } : undefined;
  const waited = minutesBetween(audience, now);
  return waited > ctx.target ? { reason: "waiting", text: `Waiting ${durationText(waited)} · over target`, since: audience, warn: false } : undefined;
}

/** The quiet line of an Open conversation that needs no attention ("No reply yet · 11 min", "You replied · 2 h"). */
export function quietStateOf(conversation: Conversation, ctx: WorkContext): string | undefined {
  const audience = latestAudience(conversation, ctx.sim);
  const brand = latestBrand(conversation, ctx.sim);
  const now = nowOf(ctx.wf);
  if (brand !== undefined && (audience === undefined || brand >= audience)) return `You replied · ${durationText(minutesBetween(brand, now))}`;
  if (audience !== undefined) return `No reply yet · ${durationText(minutesBetween(audience, now))}`;
  return undefined;
}

/* ───── views, filters, search, sort ───── */

export type View = "attention" | "open" | "mine" | "escalated" | "done";

export const VIEWS: readonly { readonly id: View; readonly name: string }[] = [
  { id: "attention", name: "Needs attention" },
  { id: "open", name: "Open" },
  { id: "mine", name: "Assigned to me" },
  { id: "escalated", name: "Escalated" },
  { id: "done", name: "Done" },
];
export const viewName = (view: View): string => VIEWS.find((item) => item.id === view)?.name ?? "Comments";

export function inView(conversation: Conversation, view: View, ctx: WorkContext): boolean {
  const flow = flowOf(ctx.wf, conversation.id);
  switch (view) {
    case "attention":
      return attentionOf(conversation, ctx) !== undefined;
    case "open":
      return flow.status === "open";
    case "mine":
      return flow.status === "open" && flow.assignee === ME;
    case "escalated":
      return flow.status === "open" && flow.escalation !== undefined;
    case "done":
      return flow.status === "done";
  }
}

export type SourceFilter = Post["source"];
export type DateFilter = "day" | "week";

export interface Filters {
  readonly platform?: Platform;
  readonly label?: string;
  readonly accounts: readonly string[];
  readonly source?: SourceFilter;
  /** A member id, or "unassigned". */
  readonly assignee?: string;
  readonly date?: DateFilter;
  readonly post?: string;
  readonly reason?: AttentionReason;
}
export const NO_FILTERS: Filters = { accounts: [] };

/** The removable chips, in order, with what each says. */
export function activeFilters(filters: Filters, labels: LabelState): readonly { readonly key: keyof Filters | `account:${string}`; readonly name: string; readonly value: string }[] {
  const out: { readonly key: keyof Filters | `account:${string}`; readonly name: string; readonly value: string }[] = [];
  if (filters.platform !== undefined) out.push({ key: "platform", name: "Platform", value: filters.platform === "facebook" ? "Facebook" : "Instagram" });
  if (filters.label !== undefined) out.push({ key: "label", name: "Label", value: labels.labels.find((label) => label.id === filters.label)?.name ?? "Deleted label" });
  for (const id of filters.accounts) {
    const account = accountOf(id);
    out.push({ key: `account:${id}`, name: "Account", value: account?.verifiedName ?? (account === undefined ? "Unknown" : `Your ${platformName(account)} account`) });
  }
  if (filters.source !== undefined) out.push({ key: "source", name: "Organic or paid", value: SOURCE_TEXT[filters.source] });
  if (filters.assignee !== undefined) out.push({ key: "assignee", name: "Assignee", value: filters.assignee === "unassigned" ? "Unassigned" : (memberOf(filters.assignee)?.name ?? "Unknown") });
  if (filters.date !== undefined) out.push({ key: "date", name: "Date", value: filters.date === "day" ? "Last 24 hours" : "Last 7 days" });
  if (filters.post !== undefined) out.push({ key: "post", name: "Post", value: postOf(filters.post)?.caption ?? "Post not read yet" });
  if (filters.reason !== undefined) out.push({ key: "reason", name: "Attention", value: ATTENTION_REASONS.find((item) => item.id === filters.reason)?.name ?? "" });
  return out;
}

/** The filters without one chip's criterion. */
export function withoutFilter(filters: Filters, key: string): Filters {
  if (key.startsWith("account:")) return { ...filters, accounts: filters.accounts.filter((id) => `account:${id}` !== key) };
  return Object.fromEntries(Object.entries(filters).filter(([name]) => name !== key || name === "accounts")) as unknown as Filters;
}

/** How many filters the Filters menu holds (Platform and Label are the quick filters beside it). */
export const menuFilterCount = (filters: Filters): number => filters.accounts.length + [filters.source, filters.assignee, filters.date, filters.post, filters.reason].filter((value) => value !== undefined).length;

const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("en");

/** Search: words of a comment's text or an author's name, ignoring case and accents. */
export function matchesQuery(conversation: Conversation, query: string, sim: SimState): boolean {
  const words = fold(query).split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return true;
  const haystack = fold(
    conversation.comments
      .filter((comment) => {
        const presence = viewOf(sim, conversation.accountId, comment).presence;
        return presence !== "removed" && presence !== "deleted";
      })
      .flatMap((comment) => [comment.text, commenterName(comment)])
      .join(" \n "),
  );
  return words.every((word) => haystack.includes(word));
}

export function matchesFilters(conversation: Conversation, filters: Filters, ctx: WorkContext): boolean {
  const account = accountOf(conversation.accountId);
  const post = postOf(conversation.postId);
  const flow = flowOf(ctx.wf, conversation.id);
  const now = nowOf(ctx.wf);
  if (filters.platform !== undefined && account?.platform !== filters.platform) return false;
  if (filters.label !== undefined && !conversationLabels(ctx.labels, conversation).includes(filters.label)) return false;
  if (filters.accounts.length > 0 && !filters.accounts.includes(conversation.accountId)) return false;
  if (filters.source !== undefined && (post?.source ?? "unknown") !== filters.source) return false;
  if (filters.assignee !== undefined && (filters.assignee === "unassigned" ? flow.assignee !== undefined : flow.assignee !== filters.assignee)) return false;
  if (filters.date !== undefined && minutesBetween(latestOf(conversation), now) > (filters.date === "day" ? 1440 : 7 * 1440)) return false;
  if (filters.post !== undefined && conversation.postId !== filters.post) return false;
  if (filters.reason !== undefined && attentionOf(conversation, ctx)?.reason !== filters.reason) return false;
  return true;
}

export type Sort = "attention" | "newest" | "oldest";
export const SORTS: readonly { readonly id: Sort; readonly name: string }[] = [
  { id: "attention", name: "Attention first" },
  { id: "newest", name: "Newest activity" },
  { id: "oldest", name: "Oldest activity" },
];
export const sortName = (sort: Sort): string => SORTS.find((item) => item.id === sort)?.name ?? "";

const REASON_ORDER: readonly AttentionReason[] = ATTENTION_REASONS.map((item) => item.id);

/**
 * Attention first: conversations that need a person (a person's Urgent first, then the reason's precedence, then the
 * longest waiting), then everything else by newest activity. Done has nothing to attend: newest first.
 */
export function compareFor(sort: Sort, ctx: WorkContext): (a: Conversation, b: Conversation) => number {
  const newest = (a: Conversation, b: Conversation): number => (latestOf(a) < latestOf(b) ? 1 : latestOf(a) > latestOf(b) ? -1 : a.id.localeCompare(b.id));
  if (sort === "newest") return newest;
  if (sort === "oldest") return (a, b) => -newest(a, b);
  return (a, b) => {
    const attA = attentionOf(a, ctx);
    const attB = attentionOf(b, ctx);
    if ((attA === undefined) !== (attB === undefined)) return attA === undefined ? 1 : -1;
    if (attA !== undefined && attB !== undefined) {
      const urgentA = flowOf(ctx.wf, a.id).urgent !== undefined;
      const urgentB = flowOf(ctx.wf, b.id).urgent !== undefined;
      if (urgentA !== urgentB) return urgentA ? -1 : 1;
      const reason = REASON_ORDER.indexOf(attA.reason) - REASON_ORDER.indexOf(attB.reason);
      if (reason !== 0) return reason;
      if (attA.since !== attB.since) return attA.since < attB.since ? -1 : 1;
    }
    return newest(a, b);
  };
}

/** Every conversation as the prototype sees it now (with arrived comments). */
export const liveConversations = (wf: Workflow): readonly Conversation[] => CONVERSATIONS.map((conversation) => liveOf(conversation, wf));

/** The list: the view, then the filters, then the search, in the chosen order. */
export function listOf(view: View, filters: Filters, query: string, sort: Sort, ctx: WorkContext): readonly Conversation[] {
  return liveConversations(ctx.wf)
    .filter((conversation) => inView(conversation, view, ctx) && matchesFilters(conversation, filters, ctx) && matchesQuery(conversation, query, ctx.sim))
    .sort(compareFor(view === "done" && sort === "attention" ? "newest" : sort, ctx));
}

/** How many conversations each view lists (no filter or search). */
export function viewCounts(ctx: WorkContext): Readonly<Record<View, number>> {
  const all = liveConversations(ctx.wf);
  const count = (view: View): number => all.filter((conversation) => inView(conversation, view, ctx)).length;
  return { attention: count("attention"), open: count("open"), mine: count("mine"), escalated: count("escalated"), done: count("done") };
}

/**
 * The selected conversation keeps its place (UX-03.1 A2): it stays where it was while it is selected, even after an
 * action took it out of the view or changed its order. It leaves when the selection moves, the view changes or a
 * filter, search or sort changes — never in the middle of someone's work.
 */
export interface Pin {
  readonly id: string;
  readonly index: number;
}

export function withPin(list: readonly Conversation[], pin: Pin | undefined, wf: Workflow): readonly Conversation[] {
  if (pin === undefined) return list;
  const without = list.filter((conversation) => conversation.id !== pin.id);
  const pinned = CONVERSATIONS.find((conversation) => conversation.id === pin.id);
  if (pinned === undefined) return list;
  const at = Math.min(Math.max(pin.index, 0), without.length);
  return [...without.slice(0, at), liveOf(pinned, wf), ...without.slice(at)];
}

/** Bounded rendering: the list draws this many rows, then "Show more". */
export const PAGE_SIZE = 25;

/** Other conversations by the same author in this workspace (Details › author), newest first. */
export function authorHistory(conversation: Conversation, wf: Workflow): readonly { readonly conversation: Conversation; readonly status: Flow["status"] }[] {
  const anchor = conversation.comments[0];
  if (anchor === undefined || anchor.author.kind !== "audience") return [];
  const name = anchor.author.name;
  return liveConversations(wf)
    .filter((item) => item.id !== conversation.id && item.accountId === conversation.accountId && item.comments.some((comment) => comment.author.kind === "audience" && comment.author.name === name))
    .sort((a, b) => (latestOf(a) < latestOf(b) ? 1 : -1))
    .map((item) => ({ conversation: item, status: flowOf(wf, item.id).status }));
}

/** Everything that happened in a conversation, newest first: the recorded history plus replies published earlier. */
export function historyOf(conversation: Conversation, wf: Workflow, readModel: ReadModel): readonly ActivityEntry[] {
  const sent = conversation.sent.map((reply): ActivityEntry => ({ id: `h-${reply.id}`, conversationId: conversation.id, at: reply.publishedAt, by: requesterOf(reply, readModel), text: "Replied publicly from Wrenkind · Sent" }));
  return [...wf.activity.filter((entry) => entry.conversationId === conversation.id), ...sent].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id.localeCompare(a.id)));
}

/* ───── label management (Settings › Labels; hypothesis: the proposed `labels.manage`) ───── */

/**
 * The approved label palette (Manual v1.1 Amendment 2, PO-approved 2026-11-18), gray — the default — first. Only
 * identifiers live in state; the stylesheet draws each through its theme token. A color is organizational only.
 */
export const MARKERS: readonly { readonly id: Marker; readonly name: string }[] = [
  { id: "gray", name: "Gray" },
  { id: "teal", name: "Teal" },
  { id: "plum", name: "Plum" },
  { id: "magenta", name: "Magenta" },
  { id: "olive", name: "Olive" },
];
export const DEFAULT_MARKER: Marker = "gray";
/** Whether a value is an approved palette identifier (Brown, rejected, or any color value is not). */
export const isMarker = (value: string): value is Marker => MARKERS.some((item) => item.id === value);
export const markerOf = (label: Label): Marker => label.marker ?? DEFAULT_MARKER;
export const markerName = (marker: Marker): string => MARKERS.find((item) => item.id === marker)?.name ?? "Gray";

/** How many comments carry a label. */
export const labelUsage = (state: LabelState, labelId: string): number => Object.values(state.assignments).filter((ids) => ids.includes(labelId)).length;

export type ManageResult = { readonly ok: true; readonly state: LabelState } | { readonly ok: false; readonly problem: NameProblem | "not_allowed" | "missing" | "marker_unknown" };

/** What a refused label change says. */
export function manageProblemText(problem: NameProblem | "not_allowed" | "missing" | "marker_unknown"): string {
  if (problem === "not_allowed") return "Only owners, admins and managers manage labels.";
  if (problem === "missing") return "This label no longer exists.";
  if (problem === "marker_unknown") return "Choose one of the label colors.";
  return NAME_PROBLEMS[problem];
}

/**
 * Settings › Labels › Save: a new name and a color applied together, or nothing (each validated; the name first). A
 * color change is presentation: it changes no comment, conversation, filter or attention.
 */
export function updateLabel(state: LabelState, role: Role, labelId: string, raw: string, marker: string): ManageResult {
  const renamed = renameLabel(state, role, labelId, raw);
  if (!renamed.ok) return renamed;
  return setMarker(renamed.state, role, labelId, marker);
}

/** Rename: the same name rules as creating, compared with every other label. */
export function renameLabel(state: LabelState, role: Role, labelId: string, raw: string): ManageResult {
  if (!abilitiesOf(role).create) return { ok: false, problem: "not_allowed" };
  if (!state.labels.some((label) => label.id === labelId)) return { ok: false, problem: "missing" };
  const others = state.labels.filter((label) => label.id !== labelId);
  const problem = nameProblem(others, raw);
  if (problem !== undefined && problem !== "limit") return { ok: false, problem };
  return { ok: true, state: { ...state, labels: state.labels.map((label) => (label.id === labelId ? { ...label, name: normalizeName(raw) } : label)) } };
}

/**
 * Change a workspace label's color (the proposed `labels.manage`): one of the approved palette identifiers. The color
 * belongs to the label, so every place the label appears follows at once; "gray" is the reset to the default. A value
 * outside the palette (Brown, a color value) is refused and nothing changes.
 */
export function setMarker(state: LabelState, role: Role, labelId: string, marker: string): ManageResult {
  if (!abilitiesOf(role).create) return { ok: false, problem: "not_allowed" };
  if (!state.labels.some((label) => label.id === labelId)) return { ok: false, problem: "missing" };
  if (!isMarker(marker)) return { ok: false, problem: "marker_unknown" };
  return { ok: true, state: { ...state, labels: state.labels.map((label) => (label.id === labelId ? { ...label, marker } : label)) } };
}

/** Delete a label: it leaves every comment that carried it. Comments themselves are never touched. */
export function deleteLabel(state: LabelState, role: Role, labelId: string): ManageResult & { readonly removedFrom?: readonly string[] } {
  if (!abilitiesOf(role).create) return { ok: false, problem: "not_allowed" };
  if (!state.labels.some((label) => label.id === labelId)) return { ok: false, problem: "missing" };
  const removedFrom = Object.entries(state.assignments)
    .filter(([, ids]) => ids.includes(labelId))
    .map(([commentId]) => commentId);
  const assignments = Object.fromEntries(Object.entries(state.assignments).map(([commentId, ids]) => [commentId, ids.filter((id) => id !== labelId)]));
  return { ok: true, removedFrom, state: { ...state, labels: state.labels.filter((label) => label.id !== labelId), assignments } };
}

/** The conversation that holds a comment. */
export const conversationOfComment = (commentId: string): string => commentId.replace(/-[mn]\d+$/, "");

/** Revalidated destructive retry (UX-04): a failed Delete or Block is offered again only through its confirmation. */
export const confirmsBeforeRetry = (kind: OpKind): boolean => kind === "delete" || kind === "block" || kind === "unblock";

/** One record lookup the client module may not do itself (no computed access there). */
export const flowFor = (wf: Workflow, conversationId: string): Flow => flowOf(wf, conversationId);

/* ───── how comment actions read in a conversation's activity ───── */

const OP_NAMES: { readonly [K in OpKind]: string } = {
  reply: "Public reply",
  private_reply: "Private reply",
  hide: "Hide",
  unhide: "Unhide",
  delete: "Delete",
  like: "Like",
  unlike: "Unlike",
  block: "Block author",
  unblock: "Unblock author",
};

/** "Public reply to nina.coffeelab's comment · Sent (simulated)". */
export const opActivityText = (kind: OpKind, status: OpStatus, who: string): string => `${OP_NAMES[kind]} · ${who}'s comment · ${STATUS_TEXT[status]} (simulated)`;

/** Which resolution a person most likely means after replying (the nudge's one-click choice). */
export function resolutionAfterReply(conversationId: string, sim: SimState): Resolution | undefined {
  const sent = sim.ops.filter((op) => op.conversationId === conversationId && OUTBOUND.includes(op.kind) && op.status === "sent").at(-1);
  if (sent === undefined) return undefined;
  return sent.kind === "private_reply" ? "replied_privately" : "replied_publicly";
}

/**
 * Why the selected conversation no longer belongs to the list (the row's "leaves when you move on" note), said only
 * from what is true now: Done; out of Needs attention after a confirmed reply answered the latest comment (and no
 * other reply is still in flight or unresolved); out of the
 * view for another reason; or still in the view but no longer matching the filters or search.
 */
export function leavingNote(conversation: Conversation, view: View, ctx: WorkContext): string {
  const flow = flowOf(ctx.wf, conversation.id);
  const tail = " · leaves this list when you move on";
  if (flow.status === "done") return `Done · ${resolutionName(flow.resolution)}${tail}`;
  if (inView(conversation, view, ctx)) return `No longer matches${tail}`;
  const sent = ctx.sim.ops.filter((op) => op.conversationId === conversation.id && OUTBOUND.includes(op.kind) && op.status === "sent" && op.at !== undefined).at(-1);
  const audience = latestAudience(conversation, ctx.sim);
  // "Reply sent" only while nothing newer is still on its way or unresolved (UX-05-FINALFIX): a reply Sending or being
  // Checked is never described as sent, even when an earlier one was.
  const settled = operationsInFlight(conversation.id, ctx.sim).every((op) => !OUTBOUND.includes(op.kind)) && unresolvedReplies(conversation.id, ctx.sim).length === 0;
  if (view === "attention" && settled && sent?.at !== undefined && (audience === undefined || sent.at >= audience)) return `Reply sent${tail}`;
  return `No longer in ${viewName(view)}${tail}`;
}

/** Whether the selected conversation still belongs to the list it was opened from (the "leaves when you move on" note). */
export const listedIn = (list: readonly Conversation[], conversationId: string): boolean => list.some((conversation) => conversation.id === conversationId);

/** The person a conversation is about: its first comment's author. */
export function conversationAuthor(conversation: Conversation): string {
  const anchor = conversation.comments[0];
  if (anchor === undefined) return "Unknown author";
  return anchor.author.kind === "own" ? "Your account" : commenterName(anchor);
}

/** The view counts, read one at a time (the client module may not index a record). */
export const countOf = (counts: Readonly<Record<View, number>>, view: View): number => counts[view];

/** The conversations whose comments carry a label (the activity of a rename or a deletion is recorded there). */
export function conversationsWithLabel(state: LabelState, labelId: string): readonly string[] {
  const ids = new Set<string>();
  for (const [commentId, labelIds] of Object.entries(state.assignments)) if (labelIds.includes(labelId)) ids.add(conversationOfComment(commentId));
  return [...ids].sort();
}

/** One filter set or cleared (undefined clears it), keeping every other criterion. */
export function withFilter<K extends Exclude<keyof Filters, "accounts">>(filters: Filters, key: K, value: Filters[K] | undefined): Filters {
  const rest = withoutFilter(filters, key);
  return value === undefined ? rest : { ...rest, [key]: value };
}
