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
import { ACCOUNTS, AS_OF, CONVERSATIONS, POSTS, SEED_ASSESSMENTS, type Account, type Assessment, type Comment, type Conversation, type Label, type Platform, type Post, type SentReply } from "./fixtures";

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
}

/** The role defaults of platform/permissions/catalog.ts (an Agent is the product's Responder, with no grants). */
export function abilitiesOf(role: Role): Abilities {
  switch (role) {
    case "owner":
    case "admin":
    case "manager":
      return { view: true, assign: true, create: true, reply: true, replyPrivately: true, hide: true, delete: true, block: true, like: true };
    case "agent":
      return { view: true, assign: true, create: false, reply: true, replyPrivately: true, hide: true, delete: false, block: false, like: true };
    case "analyst":
      return { view: true, assign: false, create: false, reply: false, replyPrivately: false, hide: false, delete: false, block: false, like: false };
    case "guest":
      return { view: false, assign: false, create: false, reply: false, replyPrivately: false, hide: false, delete: false, block: false, like: false };
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

export type CreateResult = { readonly ok: true; readonly state: LabelState; readonly label: Label } | { readonly ok: false; readonly problem: NameProblem | "not_allowed" };

/**
 * Create a label from a comment and assign it to that comment in the same step (the PO's requirement). Without the
 * create ability nothing changes. With no comment (`undefined`), the label is only created (sidebar "New label").
 */
export function createLabel(state: LabelState, role: Role, raw: string, commentId: string | undefined): CreateResult {
  if (!abilitiesOf(role).create) return { ok: false, problem: "not_allowed" };
  const problem = nameProblem(state.labels, raw);
  if (problem !== undefined) return { ok: false, problem };
  const label: Label = { id: `lbl-new-${String(state.nextId)}`, name: normalizeName(raw) };
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
  /** The comment acted on. For a reply, the comment the platform attaches it to (on Instagram, the top-level one). */
  readonly commentId: string;
  readonly status: OpStatus;
  /** Replies only: the text. */
  readonly text?: string;
  /** Replies only: the person answered, when that is not the author of `commentId` (an Instagram reply to a reply). */
  readonly answering?: string;
  /** Block and unblock only: the author key (account + name). */
  readonly author?: string;
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

/** Start a simulated operation: it is Sending until a person presses one of the prototype's answers. */
export function startOp(sim: SimState, op: Omit<Operation, "id" | "status">): { readonly sim: SimState; readonly id: string } {
  const id = `op-${String(sim.nextId)}`;
  return { id, sim: { ...sim, ops: [...sim.ops, { ...op, id, status: "sending" }], nextId: sim.nextId + 1 } };
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
const MODERATION: readonly ActionId[] = ["hide", "delete", "like", "block"];

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
  const restriction = platformRestriction(action, platform, post);
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
export function platformRestriction(action: ActionId, platform: Platform, post: Post | undefined): string | undefined {
  // Outcome language for the person at work; the API detail behind each reason lives in the capability reference.
  if (post?.surface === "live") return "Comments on live videos can only be managed in the Instagram app.";
  if (post?.surface === "story_ad") return "Comments on story ads can only be managed in the Instagram app.";
  if (post !== undefined && post.owner !== null) {
    if (action === "hide" || action === "delete") return `Only ${post.owner}, who posted this, can hide or delete its comments.`;
    return "Not available yet on posts your account doesn't own.";
  }
  const ad = post?.surface === "dark_post" || (platform === "instagram" && post?.kind === "Ad");
  if (ad && MODERATION.includes(action)) return "Not available yet for comments on ads.";
  return undefined;
}

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
  const context = post.surface === "live" || post.surface === "story_ad" ? "Managed in the Instagram app" : post.owner !== null ? `Posted by ${post.owner}` : undefined;
  return { shape, kind: post.kind, source: SOURCE_SHORT[post.source], context };
}
