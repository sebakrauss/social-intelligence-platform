/**
 * Meta webhooks — the PURE provider boundary (Step H6-F1; design H6-F0 §4–§6, §8; TA §40). Everything here is a
 * function of its inputs: no HTTP, no persistence, no tenant lookup, no provider call, no clock, no environment.
 *
 *   verifyMetaWebhookSignature   `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256(App Secret, EXACT body bytes),
 *                                constant-time compared; SHA-1 (`X-Hub-Signature`) is never accepted; no bypass.
 *   verifyMetaWebhookHandshake   GET `hub.mode=subscribe` + `hub.verify_token` (constant time) → echo `hub.challenge`.
 *   parseMetaWebhook             size cap → signature → UTF-8/JSON → bounded envelope → identifier-only hints.
 *
 * Authority (frozen): a webhook is a SIGNAL. A hint carries provider identifiers, enums and the provider's own times
 * only — never text, author data, `from`, the `value` object or the body — and never becomes a source fact, a removal,
 * a visibility, a coverage or a watermark. Routing happens later, server-side, from stored connection data.
 *
 * Provider shape (official Meta Webhooks reference; shapes without a verbatim official example are VALIDATE):
 *   { object: "page" | "instagram", entry: [{ id, time, changes: [{ field, value }] }] }
 *   page / feed       value.item ∈ comment | post | status | photo | video | … ; value.verb ∈ add | edited | edit | remove |
 *                     delete | hide | unhide | …; value.comment_id, value.post_id, value.parent_id (VALIDATE: a top-level
 *                     comment's parent_id equals its post_id), value.created_time; value.from / value.message are DROPPED.
 *   instagram / comments  value.id (comment), value.media.id, value.parent_id (present only for a reply); value.text /
 *                     value.from are DROPPED. No verb: a comments notification is a creation signal (VALIDATE).
 *   entry.id          the provider asset identity: a Facebook Page, or an Instagram professional account (VALIDATE).
 *   entry.time        UNIX seconds when Meta sent the notification (kept as provider metadata; no wall-clock policy here).
 * Meta sends no delivery id (`deliveryId` is null); duplicates are recognized by the body hash and the hint key.
 *
 * Raw-body retention (D-F4): the verified body may be kept only when EVERY change's field is in the allowlist
 * (`feed` for page, `comments` for instagram). Any other field — `messages`, `mentions`, `reactions`, `live_comments`,
 * a `messaging` entry — makes the whole delivery non-retainable while the allowlisted changes still yield hints; the
 * disallowed change's value is never read beyond classifying it as unsupported.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { SecretValue } from "../contract/credential";
import { parseProviderObjectId, providerObjectRef, type IsoInstant, type ProviderObjectId, type ProviderObjectRef } from "../contract/identity";
import {
  WebhookRejectedError,
  webhookRawBytes,
  type ProviderWebhookPort,
  type VerifiedWebhookDelivery,
  type WebhookEventHint,
  type WebhookHandshakeQuery,
  type WebhookHandshakeResult,
  type WebhookHintChange,
  type WebhookQueryValue,
  type WebhookRejectionReason,
  type WebhookRequest,
} from "../contract/webhooks";

export const META_WEBHOOK_SIGNATURE_HEADER = "x-hub-signature-256";
/** Defense in depth: the receiver enforces the same ceiling before reading; the parser never relies on it. */
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;
/** Meta batches at most 1000 updates per delivery (official); counted across the whole envelope, all-or-nothing. */
export const MAX_WEBHOOK_CHANGES = 1000;
export const META_WEBHOOK_HINT_KEY_VERSION = "v1";
export const META_WEBHOOK_OBJECTS = ["page", "instagram"] as const;
export type MetaWebhookObject = (typeof META_WEBHOOK_OBJECTS)[number];
/** The raw-body allowlist (D-F4) and the only fields whose values are inspected. */
export const META_WEBHOOK_ALLOWED_FIELDS: Readonly<Record<MetaWebhookObject, readonly string[]>> = Object.freeze({
  page: Object.freeze(["feed"]),
  instagram: Object.freeze(["comments"]),
});
/** The contract's platform vocabulary (the adapter never imports the domain directly). */
type PlatformKey = ProviderObjectRef["platform"];
const PLATFORM_OF: Readonly<Record<MetaWebhookObject, PlatformKey>> = Object.freeze({ page: "facebook", instagram: "instagram" });

export const META_SIGNATURE_FAILURES = ["missing_signature", "malformed_signature", "unsupported_signature_scheme", "invalid_signature"] as const;
export type MetaSignatureFailure = (typeof META_SIGNATURE_FAILURES)[number];
export type MetaSignatureVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: MetaSignatureFailure };

const SIGNATURE_HEADER = /^([a-z0-9]{1,16})=([0-9a-fA-F]*)$/;
const SHA256_HEX_LENGTH = 64;
const CHALLENGE = /^[A-Za-z0-9_-]{1,128}$/;
/** UNIX seconds: a safe non-negative integer well below any plausible date (no wall-clock comparison here). */
const UNIX_SECONDS_MAX = 2 ** 40;

/**
 * Verifies `X-Hub-Signature-256` against the exact body bytes. The secret is explicit material passed by the caller:
 * nothing here opens configuration. Never logs or returns the signature, the digest or the secret.
 */
export function verifyMetaWebhookSignature(appSecret: string, rawBody: Uint8Array, header: string | undefined): MetaSignatureVerdict {
  if (header === undefined || header === "") return { ok: false, reason: "missing_signature" };
  const match = SIGNATURE_HEADER.exec(header);
  if (match === null) return { ok: false, reason: "malformed_signature" };
  if (match[1] !== "sha256") return { ok: false, reason: "unsupported_signature_scheme" };
  const digest = match[2] ?? "";
  if (digest.length !== SHA256_HEX_LENGTH) return { ok: false, reason: "malformed_signature" };
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const presented = Buffer.from(digest, "hex");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return { ok: false, reason: "invalid_signature" };
  return { ok: true };
}

/** A query parameter given more than once is ambiguous and refused as a whole (never "the first one"). */
const AMBIGUOUS: unique symbol = Symbol("ambiguous");
const single = (value: WebhookQueryValue): string | undefined | typeof AMBIGUOUS => {
  if (value === undefined || typeof value === "string") return value;
  if (value.length === 0) return undefined;
  return value.length === 1 ? value[0] : AMBIGUOUS;
};

/** The subscription handshake, pure: mode must be `subscribe`, the token must match (constant time), the challenge is echoed. */
export function verifyMetaWebhookHandshake(query: WebhookHandshakeQuery, verifyToken: string): WebhookHandshakeResult {
  const mode = single(query.mode);
  const token = single(query.verifyToken);
  const challenge = single(query.challenge);
  if (mode === AMBIGUOUS || token === AMBIGUOUS || challenge === AMBIGUOUS) return { ok: false, reason: "ambiguous_value" };
  if (mode !== "subscribe") return { ok: false, reason: "mode_invalid" };
  if (token === undefined || token === "") return { ok: false, reason: "token_missing" };
  const presented = Buffer.from(token, "utf8");
  const expected = Buffer.from(verifyToken, "utf8");
  if (verifyToken === "" || presented.length !== expected.length || !timingSafeEqual(presented, expected)) return { ok: false, reason: "token_mismatch" };
  if (challenge === undefined || challenge === "") return { ok: false, reason: "challenge_missing" };
  if (!CHALLENGE.test(challenge)) return { ok: false, reason: "challenge_invalid" };
  return { ok: true, challenge };
}

/** The delivery dedupe key: SHA-256 over the exact verified bytes (deterministic; no time, no randomness). */
export function metaDeliveryHash(rawBody: Uint8Array): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

/**
 * The hint dedupe key (design H6-F0 §8): SHA-256 over a length-prefixed tuple of normalized facts — version, provider,
 * object, asset, field, item class, verb, target, parent, content, provider time. Never text, authors, receipt time,
 * randomness, workspace or account.
 */
export function metaHintKey(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of [META_WEBHOOK_HINT_KEY_VERSION, ...parts]) hash.update(`${String(Buffer.byteLength(part, "utf8"))}:${part}`, "utf8");
  return hash.digest("hex");
}

/** The contract's verified delivery, narrowed to Meta's provider and object classes (H6-F3). */
export interface MetaWebhookDelivery extends VerifiedWebhookDelivery {
  readonly provider: "meta";
  readonly object: MetaWebhookObject;
}

type Json = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const rejected = (reason: WebhookRejectionReason): never => {
  throw new WebhookRejectedError(reason);
};

/** UNIX seconds as Meta sends `time`: a safe non-negative integer, else undefined (absent) or rejected (nonsensical). */
function parseUnixSeconds(value: unknown): IsoInstant | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > UNIX_SECONDS_MAX) return rejected("malformed_payload");
  return new Date(value * 1000).toISOString() as IsoInstant;
}

const FEED_COMMENT_VERBS: Readonly<Record<string, WebhookHintChange>> = Object.freeze({
  add: "created",
  edited: "edited",
  edit: "edited",
  remove: "removed",
  delete: "removed",
  hide: "hidden",
  unhide: "unhidden",
});
const FEED_CONTENT_ITEMS: readonly string[] = Object.freeze(["post", "status", "photo", "video"]);
const FEED_CONTENT_VERBS: Readonly<Record<string, WebhookHintChange>> = Object.freeze({ add: "created", edited: "updated", edit: "updated", remove: "removed", delete: "removed" });

interface NormalizedChange {
  readonly item: string;
  readonly verb: string;
  readonly target: ProviderObjectRef<"content" | "interaction">;
  readonly content: ProviderObjectRef<"content"> | null;
  readonly parent: ProviderObjectRef<"interaction"> | null;
  readonly change: WebhookHintChange;
}

/** A Page `feed` change → the minimum identifiers, or "ignored" (unrecognized item/verb, or a required id missing). */
function normalizeFeed(value: Json): NormalizedChange | "ignored" {
  const item = value["item"];
  const verb = value["verb"];
  if (typeof item !== "string" || typeof verb !== "string") return "ignored";
  const postId = parseProviderObjectId(value["post_id"]);
  if (item === "comment") {
    const change = FEED_COMMENT_VERBS[verb];
    const commentId = parseProviderObjectId(value["comment_id"]);
    if (change === undefined || commentId === undefined || postId === undefined) return "ignored";
    const parentId = parseProviderObjectId(value["parent_id"]);
    return {
      item,
      verb,
      target: providerObjectRef("facebook", "interaction", commentId),
      content: providerObjectRef("facebook", "content", postId),
      // A parent that is the post itself means a top-level comment (VALIDATE); only a distinct parent names a reply.
      parent: parentId === undefined || parentId === postId ? null : providerObjectRef("facebook", "interaction", parentId),
      change,
    };
  }
  if (FEED_CONTENT_ITEMS.includes(item)) {
    const change = FEED_CONTENT_VERBS[verb];
    if (change === undefined || postId === undefined) return "ignored";
    return { item, verb, target: providerObjectRef("facebook", "content", postId), content: null, parent: null, change };
  }
  return "ignored";
}

/** An Instagram `comments` change → the comment, its media and (only when supplied) its parent; no verb exists. */
function normalizeInstagramComment(value: Json): NormalizedChange | "ignored" {
  const commentId = parseProviderObjectId(value["id"]);
  if (commentId === undefined) return "ignored";
  const media = value["media"];
  const mediaId = isRecord(media) ? parseProviderObjectId(media["id"]) : undefined;
  const parentId = parseProviderObjectId(value["parent_id"]);
  return {
    item: "comment",
    verb: "add",
    target: providerObjectRef("instagram", "interaction", commentId),
    content: mediaId === undefined ? null : providerObjectRef("instagram", "content", mediaId),
    parent: parentId === undefined ? null : providerObjectRef("instagram", "interaction", parentId),
    change: "created",
  };
}

/**
 * Verifies (size, signature over the exact bytes) and parses one Meta delivery into identifier-only hints. Throws
 * WebhookRejectedError; never returns partial structure. Pure: the secret is explicit material.
 */
export function parseMetaWebhook(appSecret: string, request: WebhookRequest): MetaWebhookDelivery {
  const bytes = webhookRawBytes(request);
  if (bytes.byteLength > MAX_WEBHOOK_BODY_BYTES) return rejected("body_too_large");
  const verdict = verifyMetaWebhookSignature(appSecret, bytes, request.headers[META_WEBHOOK_SIGNATURE_HEADER]);
  if (!verdict.ok) return rejected(verdict.reason);

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return rejected("malformed_payload");
  }
  if (!isRecord(body) || typeof body["object"] !== "string" || !Array.isArray(body["entry"])) return rejected("malformed_payload");
  const object = body["object"];
  if (!(META_WEBHOOK_OBJECTS as readonly string[]).includes(object)) return rejected("unsupported_object");
  const metaObject = object as MetaWebhookObject;
  const platform = PLATFORM_OF[metaObject];
  const allowed = META_WEBHOOK_ALLOWED_FIELDS[metaObject];

  // Structure first, all-or-nothing: every entry and change must be well-formed and the total must fit the cap.
  const entries: { readonly asset: ProviderObjectId; readonly time: IsoInstant | null; readonly changes: readonly Json[]; readonly unsupported: number }[] = [];
  let changeCount = 0;
  for (const entry of body["entry"] as readonly unknown[]) {
    if (!isRecord(entry)) return rejected("malformed_payload");
    const asset = parseProviderObjectId(entry["id"]);
    if (asset === undefined) return rejected("malformed_payload");
    const time = parseUnixSeconds(entry["time"]);
    const changes = entry["changes"];
    if (changes === undefined) {
      // A messaging-style entry (Messenger / Instagram messaging) has no `changes`: unsupported, never inspected.
      if (!Array.isArray(entry["messaging"])) return rejected("malformed_payload");
      changeCount += 1;
      if (changeCount > MAX_WEBHOOK_CHANGES) return rejected("too_many_changes");
      entries.push({ asset, time, changes: [], unsupported: 1 });
      continue;
    }
    if (!Array.isArray(changes)) return rejected("malformed_payload");
    changeCount += changes.length;
    if (changeCount > MAX_WEBHOOK_CHANGES) return rejected("too_many_changes");
    const shaped: Json[] = [];
    for (const change of changes as readonly unknown[]) {
      if (!isRecord(change) || typeof change["field"] !== "string" || !isRecord(change["value"])) return rejected("malformed_payload");
      shaped.push(change);
    }
    entries.push({ asset, time, changes: shaped, unsupported: 0 });
  }

  const hints: WebhookEventHint[] = [];
  const seen = new Set<string>();
  let ignoredEventCount = 0;
  let unsupportedChangeCount = 0;
  let duplicateHintCount = 0;
  for (const entry of entries) {
    unsupportedChangeCount += entry.unsupported;
    const account = providerObjectRef(platform, "asset", entry.asset);
    for (const change of entry.changes) {
      const field = change["field"] as string;
      if (!allowed.includes(field)) {
        unsupportedChangeCount += 1; // classified only: its value is never read
        continue;
      }
      const value = change["value"] as Json;
      const normalized = metaObject === "page" ? normalizeFeed(value) : normalizeInstagramComment(value);
      if (normalized === "ignored") {
        ignoredEventCount += 1;
        continue;
      }
      const eventId = metaHintKey([
        "meta",
        metaObject,
        entry.asset,
        field,
        normalized.item,
        normalized.verb,
        normalized.target.id,
        normalized.parent?.id ?? "",
        normalized.content?.id ?? "",
        entry.time ?? "",
      ]);
      if (seen.has(eventId)) {
        duplicateHintCount += 1;
        continue;
      }
      seen.add(eventId);
      hints.push(Object.freeze({
        eventId,
        deliveryId: null,
        account,
        target: normalized.target,
        content: normalized.content,
        parent: normalized.parent,
        change: normalized.change,
        occurredAt: entry.time,
        sequence: null,
      }));
    }
  }

  return Object.freeze({
    provider: "meta",
    object: metaObject,
    deliveryId: null,
    bodySha256: metaDeliveryHash(bytes),
    hints: Object.freeze(hints),
    entryCount: entries.length,
    changeCount,
    ignoredEventCount,
    unsupportedChangeCount,
    duplicateHintCount,
    rawBodyRetainable: unsupportedChangeCount === 0,
  });
}

export interface MetaWebhookPortOptions {
  /** The Meta App Secret (signs deliveries). Opened only inside the HMAC; never stored, logged or returned. */
  readonly appSecret: SecretValue;
  /** The subscription verify token. Opened only inside the constant-time comparison. */
  readonly verifyToken: SecretValue;
}

/**
 * The port-shaped parse: the App Secret is opened here, inside the call, and nowhere else in the Meta tree (the read
 * port's Graph transport opens access tokens only; this module opens the webhook secret only).
 */
export function parseMetaWebhookWith(appSecret: SecretValue, request: WebhookRequest): Promise<MetaWebhookDelivery> {
  try {
    return Promise.resolve(parseMetaWebhook(appSecret.expose(), request));
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new WebhookRejectedError("malformed_payload"));
  }
}

/** The Meta webhook port (design H6-F0 §6): composed where the App Secret legitimately lives — the hosted web. */
export function createMetaWebhookPort(options: MetaWebhookPortOptions): ProviderWebhookPort {
  return Object.freeze({
    provider: "meta",
    verifyHandshake: (query) => verifyMetaWebhookHandshake(query, options.verifyToken.expose()),
    parseWebhook: (request) => parseMetaWebhookWith(options.appSecret, request),
  } satisfies ProviderWebhookPort);
}
