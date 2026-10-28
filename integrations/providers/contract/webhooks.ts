/**
 * Webhook parsing at the adapter boundary (TA §14.2, §40; design H6-F0). A verified webhook becomes EVENT HINTS:
 * identifiers that something may have changed, never authoritative state. Ingestion records the receipt, deduplicates
 * and re-reads the authoritative objects through the provider READ port; nothing here changes product state.
 *
 * Fail closed: a missing, malformed or invalid signature, an unsupported signature scheme, a stale timestamp, an
 * over-sized body, an unsupported top-level object, too many changes or a malformed envelope rejects the whole
 * delivery. Entries of a verified delivery that the adapter doesn't recognize are counted and ignored, never guessed
 * at. Duplicate deliveries keep the same `deliveryId`/`eventId`; out-of-order deliveries keep their provider
 * `occurredAt`/`sequence`, so consumers can detect both. Hints carry no text, names or handles.
 *
 * Signatures are computed over the EXACT bytes the provider sent (`rawBody`): a string is accepted for simulated and
 * test deliveries (its UTF-8 encoding is the body); an HTTP receiver hands over the received bytes untouched. Nothing
 * here parses, decodes or re-serializes a body before it has been verified.
 */
import type { IsoInstant, ProviderName, ProviderObjectRef } from "./identity";

export interface WebhookRequest {
  /** Header names lower-cased. */
  readonly headers: Readonly<Record<string, string>>;
  /** The exact body as received (bytes, or a string whose UTF-8 encoding is the body); signatures are computed over it. */
  readonly rawBody: string | Uint8Array;
  readonly receivedAt: IsoInstant;
}

/** The exact body bytes of a request (a string body is its UTF-8 encoding). Never decodes or re-serializes. */
export function webhookRawBytes(request: Pick<WebhookRequest, "rawBody">): Uint8Array {
  return typeof request.rawBody === "string" ? new TextEncoder().encode(request.rawBody) : request.rawBody;
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
  /** The parent interaction of a reply, when the provider says (never inferred). */
  readonly parent: ProviderObjectRef<"interaction"> | null;
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

/**
 * The closed routing classification of a hint (design H6-F0 §12), derived from the target kind and the change — never
 * an authority: a removal signal is an urgent re-read request, not a tombstone.
 */
export const WEBHOOK_HINT_CLASSES = ["interaction_created", "interaction_changed", "interaction_removed", "content_created", "content_changed", "content_removed"] as const;
export type WebhookHintClass = (typeof WEBHOOK_HINT_CLASSES)[number];

export function classifyWebhookHint(hint: Pick<WebhookEventHint, "target" | "change">): WebhookHintClass {
  const subject = hint.target.kind === "interaction" ? "interaction" : "content";
  if (hint.change === "created") return `${subject}_created`;
  if (hint.change === "removed") return `${subject}_removed`;
  return `${subject}_changed`;
}

export const WEBHOOK_REJECTION_REASONS = [
  "missing_signature",
  "malformed_signature",
  "unsupported_signature_scheme",
  "invalid_signature",
  "stale_timestamp",
  "body_too_large",
  "malformed_payload",
  "unsupported_object",
  "too_many_changes",
] as const;
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

/** A query value as an HTTP layer may hand it over: absent, one value, or several (ambiguous → refused). */
export type WebhookQueryValue = string | readonly string[] | undefined;

export interface WebhookHandshakeQuery {
  readonly mode: WebhookQueryValue;
  readonly verifyToken: WebhookQueryValue;
  readonly challenge: WebhookQueryValue;
}

export const WEBHOOK_HANDSHAKE_FAILURES = ["mode_invalid", "token_missing", "token_mismatch", "challenge_missing", "challenge_invalid", "ambiguous_value"] as const;
export type WebhookHandshakeFailure = (typeof WEBHOOK_HANDSHAKE_FAILURES)[number];

/** The pure outcome of a subscription handshake: the challenge to echo, or a reason code (never the token). */
export type WebhookHandshakeResult = { readonly ok: true; readonly challenge: string } | { readonly ok: false; readonly reason: WebhookHandshakeFailure };

/**
 * The provider WEBHOOK port (design H6-F0 §6): verification and parsing only, composed where the provider's webhook
 * secret legitimately lives (the hosted web). It performs no HTTP, no persistence, no tenant lookup and no provider
 * call; its result is signal, never source authority.
 */
export interface ProviderWebhookPort {
  readonly provider: ProviderName;
  /** The subscription handshake: the challenge to echo when the mode and the verify token match, else a reason. */
  verifyHandshake(query: WebhookHandshakeQuery): WebhookHandshakeResult;
  /** Verify (signature over the exact bytes) then parse into identifier-only hints. Fails closed with WebhookRejectedError. */
  parseWebhook(request: WebhookRequest): Promise<WebhookParseResult>;
}
