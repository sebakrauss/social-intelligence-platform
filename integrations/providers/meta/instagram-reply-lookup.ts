/**
 * Instagram OWN-reply lookup (Step 7B-14I2; reconciliation of ONE uncertain Instagram public reply, TA §18.3, §47; R6).
 * READ-ONLY: it holds a narrowed view of the Graph READ transport (the two operations below) — never the write
 * transport, never a mutation port — and every request is one Graph GET with the managed account's User token:
 *
 *   1. getInstagramAccount                          {ig-user-id}?fields=id,username   the managed account's username
 *   2. listInstagramCommentRepliesForReconciliation {ig-comment-id}/replies, cursor-continued, at most
 *                                                   META_INSTAGRAM_REPLY_LOOKUP_MAX_PAGES pages
 *
 * Classification (closed, fail-closed; a negative is never proof of absence beyond a COMPLETE listing):
 *   unique_match  the complete listing holds EXACTLY ONE reply that is provably the managed account's (from.id equals
 *                 the account id, or both usernames present and equal), names exactly the target comment as its parent,
 *                 carries exactly the text we sent, and was created at or after the attempt (a small skew tolerated) —
 *                 and NO other reply with that text could be ours (author or parent not attributable either way, or no
 *                 creation time);
 *   none          the listing is complete and no reply can be ours;
 *   ambiguous     more than one candidate, or any reply with our text whose authorship or parent cannot be settled;
 *   incomplete    any read failed, a page was malformed, or the listing did not end within the page bound — nothing
 *                 is concluded (the caller keeps the outcome unknown).
 * Nothing is retried here and no error is ever turned into a match. The text is compared in memory and dropped: the
 * result carries a provider reply id at most — never text, usernames or tokens.
 */
import type { ProviderCredential } from "../contract/credential";
import type { ProviderObjectId } from "../contract/identity";
import { createMetaGraphTransport, type MetaGraphCursor, type MetaGraphTransport } from "./graph-transport";

/** The ONLY transport operations this lookup may call: Graph GETs. */
export const INSTAGRAM_REPLY_LOOKUP_OPERATIONS = ["getInstagramAccount", "listInstagramCommentRepliesForReconciliation"] as const;
export type InstagramReplyLookupTransport = Pick<MetaGraphTransport, (typeof INSTAGRAM_REPLY_LOOKUP_OPERATIONS)[number]>;

/** Pages of replies read at most (25 per page): a longer listing is incomplete, never guessed. */
export const META_INSTAGRAM_REPLY_LOOKUP_MAX_PAGES = 8;
/** Provider clocks drift: a reply timestamped up to this long BEFORE the attempt still counts; older ones never. */
export const META_INSTAGRAM_REPLY_LOOKUP_SKEW_MS = 60_000;

export type InstagramReplyLookupResult =
  | { readonly kind: "unique_match"; readonly replyId: ProviderObjectId }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "incomplete" };

export interface InstagramReplyLookupTarget {
  /** The managed Instagram professional account (stored identity). */
  readonly instagramAccountId: ProviderObjectId;
  /** The comment our reply answers (stored identity). */
  readonly commentId: ProviderObjectId;
}

export interface InstagramReplyLookup {
  find(credential: ProviderCredential, target: InstagramReplyLookupTarget, text: string, since: Date): Promise<InstagramReplyLookupResult>;
}

const sameUsername = (a: string | null, b: string | null): boolean => a !== null && b !== null && a !== "" && b !== "" && a.toLowerCase() === b.toLowerCase();

export function createInstagramReplyLookup(options: { readonly transport?: InstagramReplyLookupTransport } = {}): InstagramReplyLookup {
  const transport: InstagramReplyLookupTransport = options.transport ?? createMetaGraphTransport();
  const lookup: InstagramReplyLookup = {
    async find(credential, target, text, since): Promise<InstagramReplyLookupResult> {
      const token = credential.secret;
      const account = await transport.getInstagramAccount(token, target.instagramAccountId);
      if (account.kind !== "ok") return { kind: "incomplete" };
      const managedUsername = account.value.username === "" ? null : account.value.username;
      const earliest = since.getTime() - META_INSTAGRAM_REPLY_LOOKUP_SKEW_MS;
      const candidates: ProviderObjectId[] = [];
      let unsettled = 0;
      let after: MetaGraphCursor | null = null;
      for (let page = 0; page < META_INSTAGRAM_REPLY_LOOKUP_MAX_PAGES; page += 1) {
        const listed = await transport.listInstagramCommentRepliesForReconciliation(token, target.commentId, after);
        if (listed.kind !== "ok") return { kind: "incomplete" };
        for (const reply of listed.value.replies) {
          // Only a reply carrying exactly our text can be ours; any other is irrelevant here.
          if (reply.text !== text) continue;
          const managed = reply.fromId === target.instagramAccountId || sameUsername(reply.fromUsername, managedUsername);
          const other = reply.fromId !== target.instagramAccountId && reply.fromUsername !== null && managedUsername !== null && !sameUsername(reply.fromUsername, managedUsername);
          if (other) continue;
          if (!managed || reply.parentId !== target.commentId) {
            // Our text, but authorship or parent cannot be settled (or names another parent under this edge).
            unsettled += 1;
            continue;
          }
          const created = Date.parse(reply.timestamp);
          if (Number.isNaN(created)) unsettled += 1;
          else if (created >= earliest) candidates.push(reply.id);
        }
        if (listed.value.after === null) {
          if (unsettled > 0) return { kind: "ambiguous" };
          const [single, ...rest] = candidates;
          if (single === undefined) return { kind: "none" };
          return rest.length === 0 ? { kind: "unique_match", replyId: single } : { kind: "ambiguous" };
        }
        after = listed.value.after;
      }
      return { kind: "incomplete" };
    },
  };
  return Object.freeze(lookup);
}
