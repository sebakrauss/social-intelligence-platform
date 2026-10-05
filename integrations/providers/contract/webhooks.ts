/**
 * Webhook parsing at the adapter boundary (TA §14.2, §40). A verified webhook becomes EVENT HINTS: identifiers
 * that something may have changed, never authoritative state. Ingestion (Step 6) records the raw event,
 * deduplicates and re-fetches the authoritative objects; nothing here changes product state.
 *
 * Fail closed: a missing or invalid signature, a stale timestamp or a malformed envelope rejects the whole
 * delivery. Entries of a verified delivery that the adapter doesn't recognize are counted and ignored, never
 * guessed at. Duplicate deliveries keep the same `deliveryId`/`eventId`; out-of-order deliveries keep their
 * provider `occurredAt`/`sequence`, so consumers can detect both. Hints carry no text, names or handles.
 */
import type { IsoInstant, ProviderObjectRef } from "./identity";

export interface WebhookRequest {
  /** Header names lower-cased. */
  readonly headers: Readonly<Record<string, string>>;
  /** The exact body as received; signatures are computed over it. */
  readonly rawBody: string;
  readonly receivedAt: IsoInstant;
}

export const WEBHOOK_HINT_CHANGES = ["created", "edited", "removed", "hidden", "unhidden", "updated"] as const;
export type WebhookHintChange = (typeof WEBHOOK_HINT_CHANGES)[number];

export interface WebhookEventHint {
  /** Provider event identity (or a deterministic derivation): stable across duplicate deliveries. */
  readonly eventId: string;
  readonly deliveryId: string | null;
  readonly account: ProviderObjectRef<"asset">;
  readonly target: ProviderObjectRef<"content" | "interaction">;
  /** The content the target belongs to, when the provider says. */
  readonly content: ProviderObjectRef<"content"> | null;
  /** What the provider says changed: a hint to re-fetch, never a state to apply. */
  readonly change: WebhookHintChange;
  readonly occurredAt: IsoInstant | null;
  /** Provider ordering or version marker, where exposed. */
  readonly sequence: string | null;
}

export interface WebhookParseResult {
  readonly deliveryId: string | null;
  readonly hints: readonly WebhookEventHint[];
  /** Entries of a verified delivery this adapter doesn't handle: counted, never processed. */
  readonly ignoredEventCount: number;
}

export const WEBHOOK_REJECTION_REASONS = ["missing_signature", "invalid_signature", "stale_timestamp", "malformed_payload"] as const;
export type WebhookRejectionReason = (typeof WEBHOOK_REJECTION_REASONS)[number];

/** The delivery is rejected as a whole; nothing in it may be processed. Message = reason code only. */
export class WebhookRejectedError extends Error {
  override readonly name = "WebhookRejectedError";
  readonly reason: WebhookRejectionReason;

  constructor(reason: WebhookRejectionReason) {
    super(`webhook_rejected_${reason}`);
    this.reason = reason;
  }

  toJSON(): { readonly reason: WebhookRejectionReason } {
    return { reason: this.reason };
  }
}
