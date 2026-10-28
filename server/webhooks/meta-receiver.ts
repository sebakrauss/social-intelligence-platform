/**
 * The Meta webhook HTTP receiver (Step H6-F3; design H6-F0 §4; TA §40). A public route whose trust is the provider's
 * signature, never a browser session: it reads no cookie, sets none, and resolves no user, workspace or tenant.
 *
 * GET  — subscription handshake through the pure H6-F1 primitive (constant-time token, ambiguity refused): 200 with the
 *        challenge as text/plain; 400 malformed or ambiguous; 403 wrong mode or token; 503 not configured. No database.
 * POST — strict order, each step failing closed before the next:
 *          1 configured? (503)  2 content-type JSON (415)  3 declared length ≤ 1 MiB (413)  4 bounded stream read (413)
 *          5 signature over the EXACT bytes + bounded parse (H6-F1; 401 signature, 400 envelope, 413 size)
 *          6 one provider-signal transaction: system.record_provider_webhook (503 on any failure: Meta retries)
 *          7 200 — then, best effort and only for a NEW receipt with new hints, nudge the MAIN router.
 *        Nothing waits for routing, a provider read, ingestion or anything downstream. A failure AFTER the receipt
 *        committed (the nudge) never turns into an HTTP failure: the router's cron guarantees the drain.
 * Responses are bodiless (except the challenge), `Cache-Control: no-store`, and carry no reason detail.
 * Logged: event names, provider/object, counts and stable reason codes only — never a body, header, token or secret.
 */
import { isoInstant, WebhookRejectedError, type ProviderWebhookPort, type VerifiedWebhookDelivery, type WebhookRejectionReason } from "@/integrations/providers/contract";
import type { Logger } from "@/platform/observability";

/** Defense in depth with the H6-F1 parser's own ceiling (pinned equal by test). */
export const MAX_WEBHOOK_REQUEST_BYTES = 1_048_576;
export const META_SIGNATURE_HEADER = "x-hub-signature-256";

export interface WebhookReceipt {
  readonly outcome: "recorded" | "duplicate";
  readonly receiptId: string;
  readonly newHintCount: number;
}

export interface MetaReceiverDependencies {
  /** The composed webhook port, or undefined when the receiver isn't configured. May throw on invalid configuration. */
  port(): ProviderWebhookPort | undefined;
  /** One provider-signal transaction recording the verified delivery (the bytes are passed; the delivery decides retention). */
  record(delivery: VerifiedWebhookDelivery, bytes: Uint8Array): Promise<WebhookReceipt>;
  /** Best-effort router nudge for a new receipt; its failure is swallowed by the receiver. */
  nudge(receiptId: string): Promise<void>;
  /** Schedules post-response work (Next's `after` in the route; immediate in tests). */
  afterResponse(work: () => Promise<void>): void;
  readonly logger: Logger;
  readonly now: () => Date;
}

const respond = (status: number, body: string | null = null, contentType?: string): Response =>
  new Response(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...(contentType === undefined ? {} : { "Content-Type": contentType }) } });

function configuredPort(deps: MetaReceiverDependencies): ProviderWebhookPort | undefined {
  try {
    return deps.port();
  } catch {
    deps.logger.error("webhook.config.invalid", { outcome: "error" });
    return undefined;
  }
}

export function handleMetaWebhookGet(request: Request, deps: MetaReceiverDependencies): Response {
  const port = configuredPort(deps);
  if (port === undefined) return respond(503);
  const query = new URL(request.url).searchParams;
  const values = (name: string): readonly string[] | undefined => {
    const all = query.getAll(name);
    return all.length === 0 ? undefined : all;
  };
  const result = port.verifyHandshake({ mode: values("hub.mode"), verifyToken: values("hub.verify_token"), challenge: values("hub.challenge") });
  if (result.ok) {
    deps.logger.info("webhook.handshake.verified", { outcome: "ok" });
    return respond(200, result.challenge, "text/plain; charset=utf-8");
  }
  deps.logger.warn(`webhook.handshake.${result.reason}`, { outcome: "error" });
  return respond(result.reason === "mode_invalid" || result.reason === "token_missing" || result.reason === "token_mismatch" ? 403 : 400);
}

const STATUS_OF_REJECTION: Readonly<Record<WebhookRejectionReason, number>> = Object.freeze({
  missing_signature: 401,
  malformed_signature: 401,
  unsupported_signature_scheme: 401,
  invalid_signature: 401,
  stale_timestamp: 400,
  body_too_large: 413,
  malformed_payload: 400,
  unsupported_object: 400,
  too_many_changes: 400,
});

type BodyRead = { readonly kind: "ok"; readonly bytes: Uint8Array } | { readonly kind: "too_large" };

/** Reads the body as raw bytes, stopping (and cancelling the stream) as soon as the cap is exceeded. Never decodes. */
async function readBounded(request: Request, limit: number): Promise<BodyRead> {
  const stream = request.body;
  if (stream === null) return { kind: "ok", bytes: new Uint8Array(0) };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return { kind: "too_large" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", bytes };
}

const JSON_CONTENT_TYPE = /^application\/json(\s*;.*)?$/i;

export async function handleMetaWebhookPost(request: Request, deps: MetaReceiverDependencies): Promise<Response> {
  const port = configuredPort(deps);
  if (port === undefined) return respond(503);
  if (!JSON_CONTENT_TYPE.test(request.headers.get("content-type") ?? "")) {
    deps.logger.warn("webhook.rejected.unsupported_media_type", { outcome: "error" });
    return respond(415);
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > MAX_WEBHOOK_REQUEST_BYTES)) {
    deps.logger.warn("webhook.rejected.body_too_large", { outcome: "error" });
    return respond(413);
  }
  const read = await readBounded(request, MAX_WEBHOOK_REQUEST_BYTES);
  if (read.kind === "too_large") {
    deps.logger.warn("webhook.rejected.body_too_large", { outcome: "error" });
    return respond(413);
  }
  // Only the signature header travels to the parser: no cookie, no other header, no session.
  const signature = request.headers.get(META_SIGNATURE_HEADER);
  let delivery: VerifiedWebhookDelivery;
  try {
    delivery = await port.parseWebhook({ headers: signature === null ? {} : { [META_SIGNATURE_HEADER]: signature }, rawBody: read.bytes, receivedAt: isoInstant(deps.now()) });
  } catch (error) {
    if (error instanceof WebhookRejectedError) {
      deps.logger.warn(`webhook.rejected.${error.reason}`, { outcome: "error" });
      return respond(STATUS_OF_REJECTION[error.reason]);
    }
    deps.logger.error("webhook.rejected.parse_failed", { outcome: "error" });
    return respond(400);
  }
  let receipt: WebhookReceipt;
  try {
    receipt = await deps.record(delivery, read.bytes);
  } catch {
    // Nothing committed (one transaction): Meta's retry is the recovery.
    deps.logger.error("webhook.receipt.failed", { outcome: "error" });
    return respond(503);
  }
  deps.logger.info(`webhook.receipt.${receipt.outcome}`, { outcome: "ok", count: receipt.newHintCount });
  if (receipt.outcome === "recorded" && receipt.newHintCount > 0) {
    deps.afterResponse(async () => {
      try {
        await deps.nudge(receipt.receiptId);
        deps.logger.info("webhook.router.nudged", { outcome: "ok" });
      } catch {
        // The cron drains the inbox anyway; a lost nudge only costs latency.
        deps.logger.warn("webhook.router.nudge_failed", { outcome: "error" });
      }
    });
  }
  return respond(200);
}
