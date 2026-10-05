/**
 * Provider MUTATION port (TA §15.1, §26). Adapters implement it; ONLY the Platform Mutation Executor
 * (`mutations/`, composed in `jobs/`) may obtain it. A dependency rule rejects every other importer of this
 * file and of adapter mutation implementations. Step 4 defines and simulates the port; it does not execute
 * real platform mutations and does not implement the executor or any product guard.
 *
 * Semantics:
 *   - a public reply returns the provider identity of the created reply when available;
 *   - a private reply is one-shot and outbound only: its receipt carries no interaction, thread or
 *     conversation, and nothing in any port reads private messages (S9; PD D-36);
 *   - hide/unhide/block are state-setting (`changed: false` when already in that state); delete is
 *     irreversible on the platform;
 *   - a timeout after sending raises OutcomeUnknownError, never a failure (R6); a definite failure raises
 *     the matching normalized error.
 */
import type { ProviderAccess } from "./dto";
import type { IsoInstant, ProviderName, ProviderObjectRef, RawReference } from "./identity";
import type { ProviderResult } from "./pagination";

/** A provider-side de-duplication hint. Providers may ignore it; domain idempotency stays authoritative (R6). */
export interface IdempotencyHint {
  readonly key: string;
}

export interface PublicReplyReceipt {
  readonly kind: "public_reply";
  readonly target: ProviderObjectRef<"interaction">;
  /** The reply the provider created, when it says. */
  readonly createdInteraction: ProviderObjectRef<"interaction"> | null;
  readonly confirmedAt: IsoInstant;
  readonly rawReference: RawReference | null;
}

/** One outbound message, nothing else: no interaction, no thread, no conversation, no inbound channel. */
export interface PrivateReplyReceipt {
  readonly kind: "private_reply";
  readonly target: ProviderObjectRef<"interaction">;
  readonly providerReceiptId: string | null;
  readonly confirmedAt: IsoInstant;
  readonly rawReference: RawReference | null;
}

export interface StateChangeReceipt {
  readonly kind: "hide" | "unhide" | "delete";
  readonly target: ProviderObjectRef<"interaction">;
  /** False when the target was already in the requested state. */
  readonly changed: boolean;
  readonly confirmedAt: IsoInstant;
  readonly rawReference: RawReference | null;
}

export interface BlockReceipt {
  readonly kind: "block";
  readonly author: ProviderObjectRef<"author">;
  readonly account: ProviderObjectRef<"asset">;
  readonly changed: boolean;
  readonly confirmedAt: IsoInstant;
  readonly rawReference: RawReference | null;
}

export type MutationReceipt = PublicReplyReceipt | PrivateReplyReceipt | StateChangeReceipt | BlockReceipt;

export interface ProviderMutationPort {
  readonly provider: ProviderName;
  replyPublicly(
    access: ProviderAccess,
    target: ProviderObjectRef<"interaction">,
    text: string,
    idempotencyHint: IdempotencyHint,
  ): Promise<ProviderResult<PublicReplyReceipt>>;
  replyPrivately(
    access: ProviderAccess,
    target: ProviderObjectRef<"interaction">,
    text: string,
    idempotencyHint: IdempotencyHint,
  ): Promise<ProviderResult<PrivateReplyReceipt>>;
  hide(access: ProviderAccess, target: ProviderObjectRef<"interaction">): Promise<ProviderResult<StateChangeReceipt>>;
  unhide(access: ProviderAccess, target: ProviderObjectRef<"interaction">): Promise<ProviderResult<StateChangeReceipt>>;
  delete(access: ProviderAccess, target: ProviderObjectRef<"interaction">): Promise<ProviderResult<StateChangeReceipt>>;
  /** Block `author` in the context of the account in `access`. */
  block(access: ProviderAccess, author: ProviderObjectRef<"author">): Promise<ProviderResult<BlockReceipt>>;
}
