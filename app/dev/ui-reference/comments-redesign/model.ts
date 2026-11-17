/**
 * Comments experience redesign (Step 7B-17V) — DEVELOPMENT ONLY. The prototype's rules as pure functions over the
 * synthetic fixtures, so they can be tested without a page: who may do what (COMMENTS-2.1-CONTRACT §D.4), the manual
 * label rules (§D.3: names 1–40 characters, unique ignoring case, at most 50, flat, one filter at a time), the filter
 * (a conversation is listed under a label when at least one of its comments carries it), Previous / Next, and how the
 * brand's own account is named without inventing an identity. All state is the caller's (React state in the page);
 * nothing is read from or written to a server, a database, browser storage or a platform.
 */
import { localFull, localShort } from "@/ui/time/local-time-format";
import { ACCOUNTS, AS_OF, CONVERSATIONS, POSTS, type Account, type Comment, type Conversation, type Label, type Post, type SentReply } from "./fixtures";

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
  /** Would be offered a reply composer if replying were available (`reply.public`). */
  readonly reply: boolean;
}

export function abilitiesOf(role: Role): Abilities {
  switch (role) {
    case "owner":
    case "admin":
    case "manager":
      return { view: true, assign: true, create: true, reply: true };
    case "agent":
      return { view: true, assign: true, create: false, reply: true };
    case "analyst":
      return { view: true, assign: false, create: false, reply: false };
    case "guest":
      return { view: false, assign: false, create: false, reply: false };
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
