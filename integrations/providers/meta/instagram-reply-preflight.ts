/**
 * Instagram reply PREFLIGHT / OBSERVE reader (Step 7B-14C1; 7B-14B design §6) — READ-ONLY Graph facts about ONE managed
 * Instagram professional account and ONE of its comments, for the operator diagnostic that must run before (preflight)
 * and after (observe) the first controlled public reply. It is NOT a capability read, NOT evidence for the catalog and
 * NOT a mutation: it holds a narrowed view of the READ transport (the allowlist below), never the write transport,
 * never the mutation port, and every request is one Graph GET.
 *
 *   preflight (at most META_INSTAGRAM_REPLY_PREFLIGHT_MAX_REQUESTS GETs, in this order):
 *     1. listPermissions        me/permissions                       required + conditional permissions (granted only)
 *     2. getInstagramAccount    {ig-user-id}?fields=id,username      the managed account answers with its own id
 *     3. listPages              me/accounts?fields=id,name           ONE page (id only is used; names never kept)
 *     4. getPageInstagram ×≤3   {page-id}?fields=instagram_business_account   exactly one checked Page links the account
 *     5. getInstagramComment    {ig-comment-id}?fields=…             identity, parent_id, hidden, from, media
 *     6. getInstagramMedia      {ig-media-id}?fields=…               owner, media type and product type
 *     7. listInstagramComments  {ig-media-id}/comments (ONE page)    the media's top-level edge lists the comment
 *     8. listInstagramCommentReplies {ig-comment-id}/replies (ONE page)  replies baseline
 *   observe (3 GETs): getInstagramAccount, getInstagramComment, listInstagramCommentReplies.
 *
 * Classification is closed and fail-closed: a check is VERIFIED only on a positive, complete, documented observation;
 * an absent field, an incomplete listing, an ambiguity or any read failure is NOT_VERIFIED; a definite contrary
 * observation (nested, hidden, own author, another owner, unlinked, a missing permission, an invalid credential, a
 * comment Graph says does not exist) is BLOCKED. A credential failure or a rate limit stops the sequence (no further
 * request is made). The token type a future POST requires is NOT observable with reads (7B-14B: the official pages
 * disagree), so it is always reported NOT_VERIFIED.
 *
 * Privacy: the report carries closed values, counts, booleans and reply timestamps of the MANAGED account only — never
 * a token, Page access token, comment or reply text, username, Page name or provider id. Usernames are compared in
 * memory and dropped.
 */
import type { ProviderCredential } from "../contract/credential";
import type { IsoInstant, ProviderObjectId } from "../contract/identity";
import { META_GRAPH_VERSION } from "./endpoints";
import { metaGraphReadError } from "./errors";
import { createMetaGraphTransport, type MetaGraphOutcome, type MetaGraphTransport } from "./graph-transport";

/** The ONLY transport operations this reader may call: Graph GETs, no write, no Page-token derivation, no content paging. */
export const INSTAGRAM_REPLY_PREFLIGHT_OPERATIONS = [
  "listPermissions",
  "getInstagramAccount",
  "listPages",
  "getPageInstagram",
  "getInstagramComment",
  "getInstagramMedia",
  "listInstagramComments",
  "listInstagramCommentReplies",
] as const;
export type InstagramReplyPreflightOperation = (typeof INSTAGRAM_REPLY_PREFLIGHT_OPERATIONS)[number];
export type InstagramReplyPreflightTransport = Pick<MetaGraphTransport, InstagramReplyPreflightOperation>;

/** Pages of `me/accounts` whose Instagram link is checked; more Pages make the link NOT_VERIFIED (incomplete), never guessed. */
export const META_INSTAGRAM_REPLY_PREFLIGHT_PAGE_CHECKS = 3;
export const META_INSTAGRAM_REPLY_PREFLIGHT_MAX_REQUESTS = 7 + META_INSTAGRAM_REPLY_PREFLIGHT_PAGE_CHECKS;
export const META_INSTAGRAM_REPLY_OBSERVE_MAX_REQUESTS = 3;

/** The permissions the implemented path (Instagram API with Facebook Login; 7B-14A/B doc review) is documented to need. */
export const INSTAGRAM_REPLY_REQUIRED_PERMISSIONS = ["instagram_basic", "instagram_manage_comments", "pages_read_engagement", "pages_show_list"] as const;
/** Documented only when the Page role comes through Business Manager: reported, never part of the verdict. */
export const INSTAGRAM_REPLY_CONDITIONAL_PERMISSIONS = ["ads_management", "ads_read"] as const;
export type InstagramReplyPermission = (typeof INSTAGRAM_REPLY_REQUIRED_PERMISSIONS)[number] | (typeof INSTAGRAM_REPLY_CONDITIONAL_PERMISSIONS)[number];
/** `me/permissions` is read granted-only: declined and expired are both `not_granted`. */
export type InstagramReplyPermissionState = "granted" | "not_granted" | "not_verified";

export type InstagramReplyPreflightMode = "preflight" | "observe";
export type InstagramReplyCheckState = "VERIFIED" | "NOT_VERIFIED" | "BLOCKED";

/** Why a check is not VERIFIED (or what a read failed with): closed codes only. */
export const INSTAGRAM_REPLY_CHECK_REASONS = [
  "not_granted",
  "mismatch",
  "not_found",
  "not_linked",
  "nested",
  "hidden",
  "own_author",
  "other_owner",
  "incomplete_listing",
  "ambiguous",
  /** A listed reply's author is neither provably the managed account nor provably someone else (Step 7B-14C3, F2). */
  "author_ambiguous",
  "field_absent",
  "credential_invalid",
  "permission_missing",
  "rate_limited",
  "transient",
  "unreadable",
  "provider_error",
  "not_attempted",
] as const;
export type InstagramReplyCheckReason = (typeof INSTAGRAM_REPLY_CHECK_REASONS)[number];

export interface InstagramReplyCheck {
  readonly state: InstagramReplyCheckState;
  readonly reason: InstagramReplyCheckReason | null;
}

/** The read failure classes a stage may end with (closed; never provider prose). */
export type InstagramReplyReadFailure = Extract<InstagramReplyCheckReason, "credential_invalid" | "permission_missing" | "rate_limited" | "transient" | "unreadable" | "provider_error" | "not_found">;

export interface InstagramReplyStageError {
  readonly operation: InstagramReplyPreflightOperation;
  readonly failure: InstagramReplyReadFailure;
}

/** The stored identities to check against Meta, resolved by the caller from canonical storage (never operator input). */
export interface InstagramReplyPreflightTarget {
  readonly instagramAccountId: ProviderObjectId;
  readonly commentId: ProviderObjectId;
  readonly mediaId: ProviderObjectId;
}

/** Closed facts, no identifiers, no text. */
export interface InstagramReplyPreflightFacts {
  readonly mode: InstagramReplyPreflightMode;
  readonly graphVersion: typeof META_GRAPH_VERSION;
  /** GETs actually made, and the mode's bound. */
  readonly requests: number;
  readonly maxRequests: number;
  /** null in observe mode (not read). */
  readonly permissions: Readonly<Record<InstagramReplyPermission, InstagramReplyPermissionState>> | null;
  readonly checks: {
    readonly permissions: InstagramReplyCheck;
    readonly account: InstagramReplyCheck;
    readonly pageLink: InstagramReplyCheck;
    readonly commentExists: InstagramReplyCheck;
    readonly commentOnStoredMedia: InstagramReplyCheck;
    readonly commentTopLevel: InstagramReplyCheck;
    readonly commentVisible: InstagramReplyCheck;
    readonly commentAuthorExternal: InstagramReplyCheck;
    readonly mediaOwnedByAccount: InstagramReplyCheck;
    readonly repliesListing: InstagramReplyCheck;
  };
  readonly media: {
    /** `media_type` / `media_product_type` as Graph reports them (bounded upper-case enums); null when not read or absent. */
    readonly mediaType: string | null;
    readonly productType: string | null;
  };
  readonly replies: {
    /** Replies on the ONE page read; null when the listing was not read. */
    readonly listed: number | null;
    /** True when Graph reported no further page. */
    readonly complete: boolean | null;
    /**
     * Replies proven to be by the managed account (by id or username), and those proven to be by anyone else — exact
     * counts, so null whenever any listed reply is unattributed (or the listing was not read).
     */
    readonly byManagedAccount: number | null;
    readonly byOthers: number | null;
    /** Listed replies whose author could not be attributed either way (repliesListing NOT_VERIFIED author_ambiguous when > 0). */
    readonly unattributed: number | null;
    /** Every listed reply names the target comment as its parent (null when any omits parent_id). */
    readonly allNameTargetAsParent: boolean | null;
    /**
     * Creation instants of the replies PROVEN to be the managed account's (ascending) — the OBSERVE evidence; never ids or
     * text. Never identifies which reply a given send produced (OBSERVE_DOES_NOT_IDENTIFY_A_SPECIFIC_REPLY).
     */
    readonly managedAccountReplyTimestamps: readonly IsoInstant[];
  };
  readonly errors: readonly InstagramReplyStageError[];
  /** A credential failure or rate limit stopped the sequence. */
  readonly stoppedEarly: boolean;
  /** Always NOT_VERIFIED: reads cannot prove which token type `POST /{ig-comment-id}/replies` accepts (7B-14B). */
  readonly tokenTypeForReplyPost: "NOT_VERIFIED";
  readonly limitations: readonly InstagramReplyLimitation[];
  readonly status: InstagramReplyCheckState;
}

export const INSTAGRAM_REPLY_LIMITATIONS = [
  /** Successful reads with the stored credential say nothing about the token type the reply POST requires. */
  "TOKEN_TYPE_FOR_REPLY_POST_NOT_VERIFIED",
  /** No debug_token (it needs an app token; the App Secret is web-only): expiry and data-access expiry are not observable. */
  "TOKEN_EXPIRY_NOT_OBSERVABLE",
  /** `me/permissions` is read granted-only: declined and expired are not distinguished. */
  "PERMISSION_STATUS_GRANTED_ONLY",
  /** `from.id` is Instagram-scoped; authorship is compared by id AND username, and undocumented semantics stay a limitation. */
  "AUTHOR_IDENTITY_COMPARED_BY_ID_AND_USERNAME",
  /**
   * Step 7B-14C3 (F3): a VERIFIED replies listing means the read was complete and attributable — never that a specific
   * POST is confirmed. No reply id is compared or reported; pre-existing replies by the managed account are counted too.
   */
  "OBSERVE_DOES_NOT_IDENTIFY_A_SPECIFIC_REPLY",
] as const;
export type InstagramReplyLimitation = (typeof INSTAGRAM_REPLY_LIMITATIONS)[number];

export interface InstagramReplyPreflight {
  inspect(credential: ProviderCredential, target: InstagramReplyPreflightTarget, mode: InstagramReplyPreflightMode): Promise<InstagramReplyPreflightFacts>;
}

/** Graph code 100 / subcode 33: the object does not exist or cannot be reached with this token (the read port's rule). */
const PARAMETER_CODE = 100;
const OBJECT_MISSING_SUBCODE = 33;

/**
 * One non-ok read outcome as a closed failure class, with EXACTLY the read port's precedence (Step 7B-14C3, F1): 100/33
 * first (the read port's object-missing rule), then the shared Graph READ normalizer (metaGraphReadError: subcode 492,
 * rate limit, 10/200–299, temporary 1/2, policy, and only then 102/190/OAuthException) — so a missing permission, a
 * missing Page role or a temporary error that Graph types as OAuthException is never reported as an invalid credential.
 * The normalizer's operation and capability only label the discarded error object; its `kind` is all that is kept.
 */
export function readFailureOf(outcome: Exclude<MetaGraphOutcome<unknown>, { readonly kind: "ok" }>): InstagramReplyReadFailure {
  if (outcome.kind === "transient") return "transient";
  if (outcome.kind === "unreadable") return "unreadable";
  if (outcome.error.code === PARAMETER_CODE && outcome.error.subcode === OBJECT_MISSING_SUBCODE) return "not_found";
  switch (metaGraphReadError("getInteraction", outcome.error, "read_interactions").kind) {
    case "rate_limited":
      return "rate_limited";
    case "permission_missing":
      return "permission_missing";
    case "transient":
      return "transient";
    case "credential_invalid":
      return "credential_invalid";
    // permanent_rejected (policy 368 or an unlisted code) — and the kinds the read normalizer never returns.
    case "permanent_rejected":
    case "target_not_found":
    case "target_not_eligible":
    case "outcome_unknown":
      return "provider_error";
  }
}

const verified: InstagramReplyCheck = Object.freeze({ state: "VERIFIED", reason: null });
const notVerified = (reason: InstagramReplyCheckReason): InstagramReplyCheck => Object.freeze({ state: "NOT_VERIFIED", reason });
const blocked = (reason: InstagramReplyCheckReason): InstagramReplyCheck => Object.freeze({ state: "BLOCKED", reason });
const NOT_ATTEMPTED = notVerified("not_attempted");

/** A failed read as a check: definite authorization/credential refusals and a missing object block; anything else is unverified. */
function failedCheck(failure: InstagramReplyReadFailure): InstagramReplyCheck {
  return failure === "credential_invalid" || failure === "permission_missing" || failure === "not_found" ? blocked(failure) : notVerified(failure);
}

/** Usernames compare case-insensitively; an empty or absent one never matches anything. */
function sameUsername(a: string | null, b: string | null): boolean | null {
  if (a === null || b === null || a === "" || b === "") return null;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Who wrote ONE reply (Step 7B-14C3, F2). "managed" on a positive match — `from.id` equal to the managed account's id, or
 * both usernames present and equal. "other" only when the id differs AND both usernames are present and differ: `from.id`
 * is Instagram-scoped (an id mismatch alone is never proof). Anything else — the managed username or the reply's
 * username unknown with a different id — is "ambiguous", never counted on either side.
 */
function replyAuthorOf(fromId: ProviderObjectId, fromUsername: string | null, managedId: ProviderObjectId, managedUsername: string | null): "managed" | "other" | "ambiguous" {
  if (fromId === managedId) return "managed";
  const sameName = sameUsername(fromUsername, managedUsername);
  return sameName === true ? "managed" : sameName === false ? "other" : "ambiguous";
}

export function createInstagramReplyPreflight(options: { readonly transport?: InstagramReplyPreflightTransport } = {}): InstagramReplyPreflight {
  const transport: InstagramReplyPreflightTransport = options.transport ?? createMetaGraphTransport();

  return Object.freeze({
    async inspect(credential: ProviderCredential, target: InstagramReplyPreflightTarget, mode: InstagramReplyPreflightMode): Promise<InstagramReplyPreflightFacts> {
      const token = credential.secret;
      const maxRequests = mode === "preflight" ? META_INSTAGRAM_REPLY_PREFLIGHT_MAX_REQUESTS : META_INSTAGRAM_REPLY_OBSERVE_MAX_REQUESTS;
      const errors: InstagramReplyStageError[] = [];
      let requests = 0;
      let stopped = false;

      /** ONE allowlisted GET, counted; a credential failure or rate limit stops every later stage. */
      async function read<T>(operation: InstagramReplyPreflightOperation, call: () => Promise<MetaGraphOutcome<T>>): Promise<{ readonly value: T } | { readonly failure: InstagramReplyReadFailure } | undefined> {
        if (stopped || requests >= maxRequests) return undefined;
        requests += 1;
        const outcome = await call();
        if (outcome.kind === "ok") return { value: outcome.value };
        const failure = readFailureOf(outcome);
        errors.push(Object.freeze({ operation, failure }));
        if (failure === "credential_invalid" || failure === "rate_limited") stopped = true;
        return { failure };
      }

      // 1. Permissions (preflight only).
      let permissions: Record<InstagramReplyPermission, InstagramReplyPermissionState> | null = null;
      let permissionsCheck: InstagramReplyCheck = NOT_ATTEMPTED;
      if (mode === "preflight") {
        const all = [...INSTAGRAM_REPLY_REQUIRED_PERMISSIONS, ...INSTAGRAM_REPLY_CONDITIONAL_PERMISSIONS];
        const got = await read("listPermissions", () => transport.listPermissions(token));
        if (got !== undefined && "value" in got) {
          const granted = new Set(got.value);
          permissions = Object.fromEntries(all.map((name) => [name, granted.has(name) ? "granted" : "not_granted"])) as Record<InstagramReplyPermission, InstagramReplyPermissionState>;
          permissionsCheck = INSTAGRAM_REPLY_REQUIRED_PERMISSIONS.every((name) => granted.has(name)) ? verified : blocked("not_granted");
        } else {
          permissions = Object.fromEntries(all.map((name) => [name, "not_verified"])) as Record<InstagramReplyPermission, InstagramReplyPermissionState>;
          if (got !== undefined) permissionsCheck = failedCheck(got.failure);
        }
      }

      // 2. The managed account answers with its own id (the transport checks the echo).
      let accountCheck: InstagramReplyCheck = NOT_ATTEMPTED;
      let managedUsername: string | null = null;
      const account = await read("getInstagramAccount", () => transport.getInstagramAccount(token, target.instagramAccountId));
      if (account !== undefined && "value" in account) {
        accountCheck = verified;
        managedUsername = account.value.username === "" ? null : account.value.username;
      } else if (account !== undefined) {
        accountCheck = failedCheck(account.failure);
      }

      // 3–4. Exactly one checked Page links the managed account (preflight only).
      let pageLinkCheck: InstagramReplyCheck = NOT_ATTEMPTED;
      if (mode === "preflight") {
        const pages = await read("listPages", () => transport.listPages(token, null));
        if (pages !== undefined && "value" in pages) {
          const checked = pages.value.pages.slice(0, META_INSTAGRAM_REPLY_PREFLIGHT_PAGE_CHECKS);
          const complete = pages.value.after === null && pages.value.pages.length <= META_INSTAGRAM_REPLY_PREFLIGHT_PAGE_CHECKS;
          let links = 0;
          let unread = false;
          for (const page of checked) {
            const linked = await read("getPageInstagram", () => transport.getPageInstagram(token, page.id));
            // undefined: the sequence was stopped (credential/rate limit) or the bound reached — never "not linked".
            if (linked === undefined) {
              unread = true;
              break;
            }
            if (!("value" in linked)) {
              unread = true;
              continue;
            }
            if (linked.value === target.instagramAccountId) links += 1;
          }
          if (links === 1) pageLinkCheck = verified;
          else if (links > 1) pageLinkCheck = notVerified("ambiguous");
          else if (unread) pageLinkCheck = notVerified(errors.at(-1)?.failure ?? "unreadable");
          else pageLinkCheck = complete ? blocked("not_linked") : notVerified("incomplete_listing");
        } else if (pages !== undefined) {
          pageLinkCheck = failedCheck(pages.failure);
        }
      }

      // 5. The comment node: identity (echo-checked), parent_id, hidden, from, media.
      let commentExists: InstagramReplyCheck = NOT_ATTEMPTED;
      let commentOnStoredMedia: InstagramReplyCheck = NOT_ATTEMPTED;
      let commentTopLevel: InstagramReplyCheck = NOT_ATTEMPTED;
      let commentVisible: InstagramReplyCheck = NOT_ATTEMPTED;
      let commentAuthorExternal: InstagramReplyCheck = NOT_ATTEMPTED;
      let parentAbsent = false;
      const comment = await read("getInstagramComment", () => transport.getInstagramComment(token, target.commentId));
      if (comment !== undefined && "value" in comment) {
        const node = comment.value;
        commentExists = verified;
        commentOnStoredMedia = node.mediaId === null ? notVerified("field_absent") : node.mediaId === target.mediaId ? verified : blocked("mismatch");
        commentVisible = node.hidden === null ? notVerified("field_absent") : node.hidden ? blocked("hidden") : verified;
        // parent_id is documented only for a comment made on another comment: absence alone is never proof — the media's
        // top-level edge must list the comment too (step 7, preflight).
        if (node.parentId !== null) commentTopLevel = blocked("nested");
        else {
          parentAbsent = true;
          // Decided only by the preflight's top-level edge read; observe never decides it.
          commentTopLevel = NOT_ATTEMPTED;
        }
        const sameId = node.fromId === target.instagramAccountId;
        const sameName = sameUsername(node.fromUsername, managedUsername);
        if (sameId || sameName === true) commentAuthorExternal = blocked("own_author");
        else commentAuthorExternal = sameName === false ? verified : notVerified("field_absent");
      } else if (comment !== undefined) {
        const check = failedCheck(comment.failure);
        commentExists = check;
        commentOnStoredMedia = commentTopLevel = commentVisible = commentAuthorExternal = notVerified(comment.failure);
      }

      // 6. Media ownership and type (preflight only).
      let mediaOwnedByAccount: InstagramReplyCheck = NOT_ATTEMPTED;
      let mediaType: string | null = null;
      let productType: string | null = null;
      if (mode === "preflight") {
        const media = await read("getInstagramMedia", () => transport.getInstagramMedia(token, target.mediaId));
        if (media !== undefined && "value" in media) {
          mediaOwnedByAccount = media.value.ownerId === target.instagramAccountId ? verified : blocked("other_owner");
          mediaType = media.value.mediaType;
          productType = media.value.mediaProductType;
        } else if (media !== undefined) {
          mediaOwnedByAccount = failedCheck(media.failure);
        }
      }

      // 7. Top-level corroboration: the media's top-level comments edge (ONE page) lists the comment.
      if (mode === "preflight" && parentAbsent && commentOnStoredMedia.state === "VERIFIED") {
        const edge = await read("listInstagramComments", () => transport.listInstagramComments(token, target.mediaId, null));
        if (edge !== undefined && "value" in edge) {
          const listed = edge.value.comments.some((item) => item.id === target.commentId);
          commentTopLevel = listed ? verified : notVerified(edge.value.after === null ? "ambiguous" : "incomplete_listing");
        } else if (edge !== undefined) {
          commentTopLevel = notVerified(edge.failure);
        }
      }

      // 8. Replies under the comment (ONE page): the baseline (preflight) or the observation (observe).
      let repliesListing: InstagramReplyCheck = NOT_ATTEMPTED;
      let listed: number | null = null;
      let complete: boolean | null = null;
      let byManagedAccount: number | null = null;
      let byOthers: number | null = null;
      let unattributed: number | null = null;
      let allNameTargetAsParent: boolean | null = null;
      let managedAccountReplyTimestamps: IsoInstant[] = [];
      const replies = await read("listInstagramCommentReplies", () => transport.listInstagramCommentReplies(token, target.commentId));
      if (replies !== undefined && "value" in replies) {
        const items = replies.value.replies;
        listed = items.length;
        complete = replies.value.after === null;
        const authors = items.map((item) => ({ item, author: replyAuthorOf(item.fromId, item.fromUsername, target.instagramAccountId, managedUsername) }));
        const managed = authors.filter((entry) => entry.author === "managed").map((entry) => entry.item);
        const others = authors.filter((entry) => entry.author === "other").length;
        unattributed = items.length - managed.length - others;
        // Exact counts only when EVERY listed reply is attributed: an ambiguous author never lets "0 by the managed
        // account" read as a confirmed absence (Step 7B-14C3, F2).
        byManagedAccount = unattributed === 0 ? managed.length : null;
        byOthers = unattributed === 0 ? others : null;
        allNameTargetAsParent = items.some((item) => item.parentId === null) ? null : items.every((item) => item.parentId === target.commentId);
        managedAccountReplyTimestamps = managed.map((item) => item.timestamp).sort();
        repliesListing = !complete
          ? notVerified("incomplete_listing")
          : allNameTargetAsParent === false
            ? notVerified("mismatch")
            : unattributed > 0
              ? notVerified("author_ambiguous")
              : verified;
      } else if (replies !== undefined) {
        repliesListing = failedCheck(replies.failure);
      }

      const checks = Object.freeze({
        permissions: permissionsCheck,
        account: accountCheck,
        pageLink: pageLinkCheck,
        commentExists,
        commentOnStoredMedia,
        commentTopLevel,
        commentVisible,
        commentAuthorExternal,
        mediaOwnedByAccount,
        repliesListing,
      });
      // The checks each mode decides on; the other mode's checks stay NOT_VERIFIED (not_attempted) and are not required.
      const required: readonly InstagramReplyCheck[] =
        mode === "preflight" ? Object.values(checks) : [checks.account, checks.commentExists, checks.repliesListing];
      const status: InstagramReplyCheckState = required.some((check) => check.state === "BLOCKED") ? "BLOCKED" : required.every((check) => check.state === "VERIFIED") ? "VERIFIED" : "NOT_VERIFIED";

      return Object.freeze({
        mode,
        graphVersion: META_GRAPH_VERSION,
        requests,
        maxRequests,
        permissions: permissions === null ? null : Object.freeze(permissions),
        checks,
        media: Object.freeze({ mediaType, productType }),
        replies: Object.freeze({ listed, complete, byManagedAccount, byOthers, unattributed, allNameTargetAsParent, managedAccountReplyTimestamps: Object.freeze(managedAccountReplyTimestamps) }),
        errors: Object.freeze([...errors]),
        stoppedEarly: stopped,
        tokenTypeForReplyPost: "NOT_VERIFIED",
        limitations: INSTAGRAM_REPLY_LIMITATIONS,
        status,
      });
    },
  });
}
