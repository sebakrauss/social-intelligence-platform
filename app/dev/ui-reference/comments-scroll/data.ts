/**
 * COMMENTS-UX-07A — DEVELOPMENT ONLY. The scroll comparison's data: the approved prototype's synthetic fixtures
 * (app/dev/ui-reference/comments-redesign/fixtures.ts, imported read-only and never changed) shaped once into what the
 * three scroll models draw. All three draw exactly this: the same 48 conversations, in the same order (most recent
 * activity first, D-2), the same threads and the same labels. Times are computed here, against the fixtures' synthetic
 * "now", so the client module stays free of clock and formatting globals. Nothing is read from or sent to anywhere.
 *
 * Labels (UX-07A §3): a manual label belongs to the CONVERSATION — the root comment and its replies — never to a single
 * reply and never to every conversation on the same post. Since UX-07B the prototype's fixtures seed them that way
 * (conversation id → label ids), so the comparison reads them as they are.
 */
import { ACCOUNTS, AS_OF, CONVERSATIONS, POSTS, SEED_ASSIGNMENTS, SEED_LABELS, type Author, type Conversation } from "../comments-redesign/fixtures";

export interface ScrollLabel {
  readonly id: string;
  readonly name: string;
}

export interface ScrollEntry {
  readonly id: string;
  /** 0 is the root comment; replies count up from 1. */
  readonly depth: number;
  readonly author: string;
  /** The brand's own reply (from Wrenkind or directly on the platform). */
  readonly own: boolean;
  readonly text: string;
  readonly time: string;
  /** For a reply: the author it answers. */
  readonly replyingTo: string | null;
  readonly presence: "present" | "hidden" | "removed";
}

export interface ScrollConversation {
  readonly id: string;
  /** Position in the list, from 1. */
  readonly position: number;
  readonly author: string;
  readonly platform: "Facebook" | "Instagram";
  readonly account: string;
  readonly postKind: string;
  readonly postCaption: string | null;
  /** How many OTHER conversations hang from the same post (each keeps its own labels). */
  readonly siblings: number;
  readonly excerpt: string;
  readonly time: string;
  readonly replies: number;
  readonly entries: readonly ScrollEntry[];
  readonly seedLabels: readonly string[];
}

const NOW = Date.parse(AS_OF);

/** "12 min", "3 h", "2 d", or the day and month for anything older than a week. */
export function relativeTime(at: string): string {
  const minutes = Math.max(0, Math.round((NOW - Date.parse(at)) / 60_000));
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} h`;
  const days = Math.round(hours / 24);
  if (days <= 7) return `${String(days)} d`;
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(at));
}

function accountName(accountId: string): string {
  const account = ACCOUNTS.find((item) => item.id === accountId);
  if (account === undefined) return "Connected account";
  return account.verifiedName ?? (account.platform === "facebook" ? "Connected Facebook Page" : "Connected Instagram account");
}

function authorName(author: Author, accountId: string): string {
  if (author.kind === "audience") return author.name;
  if (author.kind === "own") return accountName(accountId);
  return "Author not available";
}

/** The thread in reading order: each comment followed by its replies, depth first; replies sent through Wrenkind included. */
function entriesOf(conversation: Conversation): ScrollEntry[] {
  interface Node {
    readonly id: string;
    readonly parentId: string | null;
    readonly at: string;
    readonly entry: Omit<ScrollEntry, "depth" | "replyingTo">;
  }
  const nodes: Node[] = [
    ...conversation.comments.map((comment) => ({
      id: comment.id,
      parentId: comment.parentId,
      at: comment.at,
      entry: { id: comment.id, author: authorName(comment.author, conversation.accountId), own: comment.author.kind === "own", text: comment.text, time: relativeTime(comment.at), presence: comment.presence },
    })),
    ...conversation.sent.map((sent) => ({
      id: sent.id,
      parentId: sent.parentId,
      at: sent.publishedAt,
      entry: { id: sent.id, author: accountName(conversation.accountId), own: true, text: sent.text, time: relativeTime(sent.publishedAt), presence: "present" as const },
    })),
  ];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = (parentId: string | null): Node[] => nodes.filter((node) => node.parentId === parentId).sort((a, b) => a.at.localeCompare(b.at));
  const out: ScrollEntry[] = [];
  const walk = (node: Node, depth: number): void => {
    const parent = node.parentId === null ? undefined : byId.get(node.parentId);
    out.push({ ...node.entry, depth, replyingTo: parent === undefined ? null : parent.entry.author });
    for (const child of children(node.id)) walk(child, depth + 1);
  };
  for (const root of children(null)) walk(root, 0);
  return out;
}

const latestOf = (conversation: Conversation): string =>
  [...conversation.comments.map((comment) => comment.at), ...conversation.sent.map((sent) => sent.publishedAt)].sort().at(-1) ?? AS_OF;

export const SCROLL_LABELS: readonly ScrollLabel[] = [...SEED_LABELS].map((label) => ({ id: label.id, name: label.name })).sort((a, b) => a.name.localeCompare(b.name, "en"));

export const SCROLL_CONVERSATIONS: readonly ScrollConversation[] = [...CONVERSATIONS]
  .sort((a, b) => latestOf(b).localeCompare(latestOf(a)))
  .map((conversation, index) => {
    const post = POSTS.find((item) => item.id === conversation.postId);
    const account = ACCOUNTS.find((item) => item.id === conversation.accountId);
    const entries = entriesOf(conversation);
    const root = entries[0];
    const seedLabels: readonly string[] = SEED_ASSIGNMENTS[conversation.id] ?? [];
    return {
      id: conversation.id,
      position: index + 1,
      author: root?.author ?? "Author not available",
      platform: account?.platform === "facebook" ? "Facebook" : "Instagram",
      account: accountName(conversation.accountId),
      postKind: post?.kind ?? "Post",
      postCaption: post?.caption ?? null,
      siblings: conversation.postId === null ? 0 : CONVERSATIONS.filter((other) => other.postId === conversation.postId && other.id !== conversation.id).length,
      excerpt: root === undefined ? "" : root.presence === "removed" ? "Comment removed on the platform" : root.text,
      time: relativeTime(latestOf(conversation)),
      replies: entries.length - 1,
      entries,
      seedLabels,
    } satisfies ScrollConversation;
  });

/** The conversations the comparison opens by name in its guide: the long thread, a short one, and the first. */
export const LONG_THREAD_ID = [...SCROLL_CONVERSATIONS].sort((a, b) => b.entries.length - a.entries.length)[0]?.id ?? "";
export const SHORT_THREAD_ID = SCROLL_CONVERSATIONS.find((conversation) => conversation.entries.length === 1 && conversation.position > 20)?.id ?? "";

/** One value of a string-keyed record (a CSS module), so the client module never indexes with a computed key. */
export const classOf = (styles: Readonly<Record<string, string>>, name: string): string => styles[name] ?? "";
