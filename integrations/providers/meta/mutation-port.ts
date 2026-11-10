/**
 * Meta MUTATION port — Instagram public reply only (Step 7B-11; TA §15.1, §26; R6). It implements the contract port
 * for exactly ONE operation on exactly ONE platform: `replyPublicly` on an Instagram comment, as
 * `POST /{ig-comment-id}/replies` (`message`) with the User token of the managed Instagram professional account
 * (Instagram API with Facebook Login: instagram_basic + instagram_manage_comments + pages_read_engagement). Everything
 * else — Facebook targets, private replies, hide/unhide/delete/block — is refused BEFORE any request, with a
 * TargetNotEligibleError (unsupported for this provider today), never a silent no-op and never a different call.
 *
 * What this adapter decides: nothing about the product. Availability (catalog, profile, connection health, workspace
 * mode, the mutation switch, the target's authority) is the executor's guard chain; this port only turns one approved
 * intent into one platform request and one normalized result:
 *   - a 2xx with an id → PublicReplyReceipt with the created reply's identity (the provider says so);
 *   - a recognizable Graph error → the write mapping (meta/errors.ts, review F1): a definite failure ONLY for an
 *     HTTP 4xx with a listed pre-processing code and `is_transient` not true; anything else is OutcomeUnknown;
 *   - anything else once the request may have left (timeout, network, redirect, unreadable or unrecognized response)
 *     → OutcomeUnknownError with the transport's reason. The caller reconciles; it never resends.
 * Exactly one request per call. The idempotency hint is accepted and ignored: Meta offers no idempotency key on this
 * edge, so domain idempotency (the intent) stays the only authority (R6).
 *
 * The port holds the WRITE transport only (review F2): it cannot read, and no read consumer can hold this write.
 *
 * Secrets: the token is unwrapped only inside the transport, at the moment of the request; this file never reads,
 * logs or returns it. Text limits are re-checked here (empty or over the platform cap never leaves) although the
 * executor already enforces them.
 */
import type { ProviderAccess } from "../contract/dto";
import { OutcomeUnknownError, PermanentRejectedError, TargetNotEligibleError, type MutationOperation } from "../contract/errors";
import { isoInstant, parseProviderObjectId, providerObjectRef, rawReference, type ProviderObjectId, type ProviderObjectRef } from "../contract/identity";
import type { BlockReceipt, PrivateReplyReceipt, ProviderMutationPort, PublicReplyReceipt, StateChangeReceipt } from "../contract/mutation-port";
import { BUDGET_NOT_REPORTED, type ProviderResult } from "../contract/pagination";
import { META_GRAPH_VERSION } from "./endpoints";
import { metaGraphWriteError } from "./errors";
import { createMetaGraphWriteTransport, META_INSTAGRAM_REPLY_MAX_CHARS, type MetaGraphWriteTransport } from "./graph-transport";

export interface MetaMutationPortOptions {
  readonly transport?: MetaGraphWriteTransport;
  readonly clock?: () => Date;
}

/** The managed Instagram account of `access`, re-checked at runtime: the ref is data, whatever its static type says. */
function managedInstagramAccount(access: ProviderAccess, operation: MutationOperation): ProviderObjectId {
  const { platform, kind, id } = access.account;
  const account = parseProviderObjectId(id);
  if (platform !== "instagram" || (kind as string) !== "asset" || account === undefined) throw new PermanentRejectedError(operation, "invalid_request");
  return account;
}

/** The Instagram comment the reply answers: an interaction ref of the SAME platform as the account, with a provider id. */
function instagramComment(target: ProviderObjectRef<"interaction">, operation: MutationOperation): ProviderObjectId {
  if (target.platform !== "instagram" || (target.kind as string) !== "interaction") throw new TargetNotEligibleError(operation, "unsupported_for_target");
  const id = parseProviderObjectId(target.id);
  if (id === undefined) throw new PermanentRejectedError(operation, "invalid_request");
  return id;
}

export function createMetaMutationPort(options: MetaMutationPortOptions = {}): ProviderMutationPort {
  const transport = options.transport ?? createMetaGraphWriteTransport();
  const clock = options.clock ?? (() => new Date());
  const unsupported = <T>(operation: MutationOperation): Promise<ProviderResult<T>> => Promise.reject(new TargetNotEligibleError(operation, "unsupported_for_target"));

  return Object.freeze({
    provider: "meta",

    async replyPublicly(access, target, text): Promise<ProviderResult<PublicReplyReceipt>> {
      // Every refusal below happens before any request: nothing has left, so a definite error is honest.
      const operation: MutationOperation = "replyPublicly";
      managedInstagramAccount(access, operation);
      const commentId = instagramComment(target, operation);
      if (text.trim().length === 0 || text.length > META_INSTAGRAM_REPLY_MAX_CHARS) throw new PermanentRejectedError(operation, "invalid_request");

      // ONE request. From here on, an uncertain result is OutcomeUnknown — the platform may have published.
      const outcome = await transport.createInstagramCommentReply(access.credential.secret, commentId, text);
      if (outcome.kind === "unknown") throw new OutcomeUnknownError(operation, outcome.reason);
      if (outcome.kind === "graph_error") throw metaGraphWriteError(operation, outcome.error, "reply_public");
      const receipt: PublicReplyReceipt = Object.freeze({
        kind: "public_reply",
        target,
        createdInteraction: providerObjectRef("instagram", "interaction", outcome.value.id),
        confirmedAt: isoInstant(clock()),
        rawReference: rawReference("meta", META_GRAPH_VERSION, `instagram:comment:${outcome.value.id}`),
      });
      return Object.freeze({ data: receipt, budget: BUDGET_NOT_REPORTED });
    },

    replyPrivately: (): Promise<ProviderResult<PrivateReplyReceipt>> => unsupported("replyPrivately"),
    hide: (): Promise<ProviderResult<StateChangeReceipt>> => unsupported("hide"),
    unhide: (): Promise<ProviderResult<StateChangeReceipt>> => unsupported("unhide"),
    delete: (): Promise<ProviderResult<StateChangeReceipt>> => unsupported("delete"),
    block: (): Promise<ProviderResult<BlockReceipt>> => unsupported("block"),
  } satisfies ProviderMutationPort);
}
