/**
 * Step H6-F1 — the pure Meta webhook boundary: signature over exact bytes, handshake, bounded envelope parsing and
 * identifier-only hints (design H6-F0 §4–§6, §8, §12; D-F4). Fixtures are SYNTHETIC Meta-shaped bodies, signed here
 * with a synthetic app secret over the exact file bytes. Nothing here persists, routes or calls a provider.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SecretValue,
  WEBHOOK_HINT_CLASSES,
  WEBHOOK_REJECTION_REASONS,
  WebhookRejectedError,
  classifyWebhookHint,
  isoInstant,
  type WebhookEventHint,
  type WebhookRequest,
} from "@/integrations/providers/contract";
import { createMetaReadPort } from "@/integrations/providers/meta/read-port";
import {
  MAX_WEBHOOK_BODY_BYTES,
  MAX_WEBHOOK_CHANGES,
  META_WEBHOOK_ALLOWED_FIELDS,
  META_WEBHOOK_HINT_KEY_VERSION,
  META_WEBHOOK_OBJECTS,
  META_WEBHOOK_SIGNATURE_HEADER,
  createMetaWebhookPort,
  metaDeliveryHash,
  metaHintKey,
  parseMetaWebhook,
  verifyMetaWebhookHandshake,
  verifyMetaWebhookSignature,
  type MetaWebhookDelivery,
} from "@/integrations/providers/meta/webhooks";
import { stableSerialize } from "../support/fixtures";

const SECRET = "synthetic-meta-app-secret-for-tests";
const OTHER_SECRET = "another-synthetic-secret";
const VERIFY_TOKEN = "synthetic-verify-token";
const FIXTURES = path.resolve(import.meta.dirname, "../../../fixtures/providers/meta-webhooks");
const RECEIVED = isoInstant(new Date("2026-10-28T12:00:00.000Z"));
const HEX64 = /^[0-9a-f]{64}$/;

const bytesOf = (name: string): Uint8Array => new Uint8Array(readFileSync(path.join(FIXTURES, `${name}.json`)));
const sign = (secret: string, body: Uint8Array): string => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const signed = (body: Uint8Array | string, secret = SECRET, header?: string): WebhookRequest => {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const signature = header ?? sign(secret, bytes);
  if (signature !== "") headers[META_WEBHOOK_SIGNATURE_HEADER] = signature;
  return { headers, rawBody: bytes, receivedAt: RECEIVED };
};
const parse = (name: string): MetaWebhookDelivery => parseMetaWebhook(SECRET, signed(bytesOf(name)));
const rejection = (fn: () => unknown): WebhookRejectedError["reason"] => {
  try {
    fn();
  } catch (error) {
    if (error instanceof WebhookRejectedError) return error.reason;
    throw error;
  }
  throw new Error("expected a rejection");
};
const SENSITIVE = ["Synthetic", "synthetic_user", "must never", "live_user", "Mentioner", "example.invalid", "\"message\"", "\"text\"", "\"from\"", "\"username\"", "\"name\""];
const expectNoSocialData = (value: unknown): void => {
  const serialized = stableSerialize(value);
  for (const needle of SENSITIVE) expect(serialized, needle).not.toContain(needle);
};

describe("signature verification (X-Hub-Signature-256 over exact bytes)", () => {
  const body = bytesOf("page-comment-add");

  it("1. accepts a valid signature", () => {
    expect(verifyMetaWebhookSignature(SECRET, body, sign(SECRET, body))).toEqual({ ok: true });
  });
  it("2. rejects a signature made with another secret", () => {
    expect(verifyMetaWebhookSignature(SECRET, body, sign(OTHER_SECRET, body))).toEqual({ ok: false, reason: "invalid_signature" });
  });
  it("3. a one-byte body mutation invalidates the signature", () => {
    const mutated = Uint8Array.from(body);
    mutated[mutated.length - 3] = mutated[mutated.length - 3] === 0x20 ? 0x09 : 0x20;
    expect(verifyMetaWebhookSignature(SECRET, mutated, sign(SECRET, body))).toEqual({ ok: false, reason: "invalid_signature" });
  });
  it("4. a whitespace-only JSON change is a different body: the original signature no longer authenticates it", () => {
    const compact = new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(body))));
    expect(compact).not.toEqual(body);
    expect(verifyMetaWebhookSignature(SECRET, compact, sign(SECRET, body))).toEqual({ ok: false, reason: "invalid_signature" });
    expect(verifyMetaWebhookSignature(SECRET, compact, sign(SECRET, compact))).toEqual({ ok: true });
  });
  it("5. raw-byte differences are respected: an escaped and an unescaped Unicode body are different bodies", () => {
    const escaped = new TextEncoder().encode('{"object":"page","entry":[],"note":"caf\\u00e9"}');
    const literal = new TextEncoder().encode('{"object":"page","entry":[],"note":"café"}');
    expect(JSON.parse(new TextDecoder().decode(escaped))).toEqual(JSON.parse(new TextDecoder().decode(literal)));
    expect(verifyMetaWebhookSignature(SECRET, literal, sign(SECRET, escaped))).toEqual({ ok: false, reason: "invalid_signature" });
    expect(verifyMetaWebhookSignature(SECRET, escaped, sign(SECRET, escaped))).toEqual({ ok: true });
  });
  it("6. an empty body with its correctly computed signature verifies deterministically (and then fails as malformed payload)", () => {
    const empty = new Uint8Array(0);
    expect(verifyMetaWebhookSignature(SECRET, empty, sign(SECRET, empty))).toEqual({ ok: true });
    expect(rejection(() => parseMetaWebhook(SECRET, signed(empty)))).toBe("malformed_payload");
  });
  it("7. a missing header is missing_signature", () => {
    expect(verifyMetaWebhookSignature(SECRET, body, undefined)).toEqual({ ok: false, reason: "missing_signature" });
    expect(verifyMetaWebhookSignature(SECRET, body, "")).toEqual({ ok: false, reason: "missing_signature" });
  });
  it("8. a malformed prefix is malformed_signature", () => {
    const digest = sign(SECRET, body).slice("sha256=".length);
    for (const header of [digest, `sha256:${digest}`, `sha256=${digest}=`, ` sha256=${digest}`, "sha256=", "=abc"]) {
      expect(verifyMetaWebhookSignature(SECRET, body, header), header).toEqual({ ok: false, reason: header === "sha256=" ? "malformed_signature" : "malformed_signature" });
    }
  });
  it("9. the SHA-1 scheme is never accepted, even when its digest is correct", () => {
    const sha1 = `sha1=${createHmac("sha1", SECRET).update(body).digest("hex")}`;
    expect(verifyMetaWebhookSignature(SECRET, body, sha1)).toEqual({ ok: false, reason: "unsupported_signature_scheme" });
    expect(verifyMetaWebhookSignature(SECRET, body, `md5=${"a".repeat(32)}`)).toEqual({ ok: false, reason: "unsupported_signature_scheme" });
  });
  it("10–12. a short, long or non-hex digest is malformed_signature", () => {
    const digest = sign(SECRET, body).slice("sha256=".length);
    expect(verifyMetaWebhookSignature(SECRET, body, `sha256=${digest.slice(0, 63)}`)).toEqual({ ok: false, reason: "malformed_signature" });
    expect(verifyMetaWebhookSignature(SECRET, body, `sha256=${digest}0`)).toEqual({ ok: false, reason: "malformed_signature" });
    expect(verifyMetaWebhookSignature(SECRET, body, `sha256=${"g".repeat(64)}`)).toEqual({ ok: false, reason: "malformed_signature" });
  });
  it("13. a signature computed over re-serialized JSON does not authenticate the raw bytes Meta actually sent", () => {
    const reserialized = new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(body)), null, 4));
    expect(verifyMetaWebhookSignature(SECRET, body, sign(SECRET, reserialized))).toEqual({ ok: false, reason: "invalid_signature" });
    expect(rejection(() => parseMetaWebhook(SECRET, signed(body, SECRET, sign(SECRET, reserialized))))).toBe("invalid_signature");
  });
  it("uppercase hex is accepted as the same digest; a header with whitespace is not", () => {
    const upper = sign(SECRET, body).toUpperCase().replace("SHA256=", "sha256=");
    expect(verifyMetaWebhookSignature(SECRET, body, upper)).toEqual({ ok: true });
    expect(verifyMetaWebhookSignature(SECRET, body, `${sign(SECRET, body)} `)).toEqual({ ok: false, reason: "malformed_signature" });
  });
});

describe("subscription handshake", () => {
  const ok = (challenge: string) => ({ ok: true, challenge });
  it("1. subscribe + the right token echoes the challenge", () => {
    expect(verifyMetaWebhookHandshake({ mode: "subscribe", verifyToken: VERIFY_TOKEN, challenge: "1158201444" }, VERIFY_TOKEN)).toEqual(ok("1158201444"));
  });
  it("2. a wrong token is token_mismatch (also when only the length differs)", () => {
    expect(verifyMetaWebhookHandshake({ mode: "subscribe", verifyToken: "synthetic-verify-tokem", challenge: "1" }, VERIFY_TOKEN)).toEqual({ ok: false, reason: "token_mismatch" });
    expect(verifyMetaWebhookHandshake({ mode: "subscribe", verifyToken: `${VERIFY_TOKEN}x`, challenge: "1" }, VERIFY_TOKEN)).toEqual({ ok: false, reason: "token_mismatch" });
  });
  it("3. a missing token is token_missing", () => {
    expect(verifyMetaWebhookHandshake({ mode: "subscribe", verifyToken: undefined, challenge: "1" }, VERIFY_TOKEN)).toEqual({ ok: false, reason: "token_missing" });
  });
  it("4. a missing challenge is challenge_missing", () => {
    expect(verifyMetaWebhookHandshake({ mode: "subscribe", verifyToken: VERIFY_TOKEN, challenge: undefined }, VERIFY_TOKEN)).toEqual({ ok: false, reason: "challenge_missing" });
  });
  it("5. any mode but subscribe is mode_invalid (including unsubscribe, missing and case variants)", () => {
    for (const mode of ["unsubscribe", "Subscribe", "", undefined, "subscribe "]) {
      expect(verifyMetaWebhookHandshake({ mode, verifyToken: VERIFY_TOKEN, challenge: "1" }, VERIFY_TOKEN), String(mode)).toEqual({ ok: false, reason: "mode_invalid" });
    }
  });
  it("6. a duplicated query value is ambiguous_value, before anything else is checked", () => {
    expect(verifyMetaWebhookHandshake({ mode: ["subscribe", "subscribe"], verifyToken: VERIFY_TOKEN, challenge: "1" }, VERIFY_TOKEN)).toEqual({ ok: false, reason: "ambiguous_value" });
    expect(verifyMetaWebhookHandshake({ mode: "subscribe", verifyToken: [VERIFY_TOKEN, "other"], challenge: "1" }, VERIFY_TOKEN)).toEqual({ ok: false, reason: "ambiguous_value" });
    expect(verifyMetaWebhookHandshake({ mode: "subscribe", verifyToken: VERIFY_TOKEN, challenge: ["1", "2"] }, VERIFY_TOKEN)).toEqual({ ok: false, reason: "ambiguous_value" });
    // A single-element array is one value.
    expect(verifyMetaWebhookHandshake({ mode: ["subscribe"], verifyToken: [VERIFY_TOKEN], challenge: ["42"] }, VERIFY_TOKEN)).toEqual(ok("42"));
  });
  it("7. an empty token is token_missing; an empty configured token never matches", () => {
    expect(verifyMetaWebhookHandshake({ mode: "subscribe", verifyToken: "", challenge: "1" }, VERIFY_TOKEN)).toEqual({ ok: false, reason: "token_missing" });
    expect(verifyMetaWebhookHandshake({ mode: "subscribe", verifyToken: "x", challenge: "1" }, "")).toEqual({ ok: false, reason: "token_mismatch" });
  });
  it("8. an empty challenge is challenge_missing", () => {
    expect(verifyMetaWebhookHandshake({ mode: "subscribe", verifyToken: VERIFY_TOKEN, challenge: "" }, VERIFY_TOKEN)).toEqual({ ok: false, reason: "challenge_missing" });
  });
  it("9. an unusual but bounded challenge is echoed; an unbounded or unsafe one is challenge_invalid", () => {
    expect(verifyMetaWebhookHandshake({ mode: "subscribe", verifyToken: VERIFY_TOKEN, challenge: "a-Z_09" }, VERIFY_TOKEN)).toEqual(ok("a-Z_09"));
    expect(verifyMetaWebhookHandshake({ mode: "subscribe", verifyToken: VERIFY_TOKEN, challenge: "x".repeat(128) }, VERIFY_TOKEN)).toEqual(ok("x".repeat(128)));
    for (const challenge of ["x".repeat(129), "<script>", "1 2", "é", "a\nb"]) {
      expect(verifyMetaWebhookHandshake({ mode: "subscribe", verifyToken: VERIFY_TOKEN, challenge }, VERIFY_TOKEN), challenge).toEqual({ ok: false, reason: "challenge_invalid" });
    }
  });
  it("the result never carries the token", () => {
    expect(stableSerialize(verifyMetaWebhookHandshake({ mode: "subscribe", verifyToken: "wrong", challenge: "1" }, VERIFY_TOKEN))).not.toContain(VERIFY_TOKEN);
  });
});

describe("bounded envelope parsing — generic and security", () => {
  it("1. a valid signed Facebook delivery parses into one identifier-only hint", () => {
    const result = parse("page-comment-add");
    expect(result).toMatchObject({ provider: "meta", object: "page", deliveryId: null, entryCount: 1, changeCount: 1, ignoredEventCount: 0, unsupportedChangeCount: 0, duplicateHintCount: 0, rawBodyRetainable: true });
    expect(result.bodySha256).toMatch(HEX64);
    expect(result.hints).toHaveLength(1);
    const eventId = result.hints[0]?.eventId ?? "";
    expect(eventId).toMatch(HEX64);
    expect(result.hints[0]).toEqual({
      eventId,
      deliveryId: null,
      account: { platform: "facebook", kind: "asset", id: "100000000000001" },
      target: { platform: "facebook", kind: "interaction", id: "300000000000001_400000000000001" },
      content: { platform: "facebook", kind: "content", id: "100000000000001_300000000000001" },
      parent: null,
      change: "created",
      occurredAt: "2025-10-09T08:53:20.000Z", // entry.time 1760000000 (UNIX seconds), kept as provider metadata
      sequence: null,
    });
  });
  it("2. a valid signed Instagram delivery parses into one identifier-only hint", () => {
    const result = parse("instagram-comment");
    expect(result).toMatchObject({ object: "instagram", rawBodyRetainable: true, unsupportedChangeCount: 0 });
    expect(result.hints).toEqual([expect.objectContaining({
      account: { platform: "instagram", kind: "asset", id: "17800000000000001" },
      target: { platform: "instagram", kind: "interaction", id: "17850000000000001" },
      content: { platform: "instagram", kind: "content", id: "17900000000000001" },
      parent: null,
      change: "created",
    })]);
  });
  it("3. an invalid signature is never parsed into hints (rejected before any decoding)", () => {
    expect(rejection(() => parseMetaWebhook(SECRET, signed(bytesOf("page-comment-add"), OTHER_SECRET)))).toBe("invalid_signature");
    expect(rejection(() => parseMetaWebhook(SECRET, signed(bytesOf("page-comment-add"), SECRET, "")))).toBe("missing_signature");
    expect(rejection(() => parseMetaWebhook(SECRET, signed(bytesOf("page-comment-add"), SECRET, `sha1=${"a".repeat(40)}`)))).toBe("unsupported_signature_scheme");
  });
  it("4. malformed JSON and invalid UTF-8 are malformed_payload (after the signature verified)", () => {
    expect(rejection(() => parseMetaWebhook(SECRET, signed("{not json")))).toBe("malformed_payload");
    expect(rejection(() => parseMetaWebhook(SECRET, signed(Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d]))))).toBe("malformed_payload");
    expect(rejection(() => parseMetaWebhook(SECRET, signed("[]")))).toBe("malformed_payload");
    expect(rejection(() => parseMetaWebhook(SECRET, signed('"page"')))).toBe("malformed_payload");
  });
  it("5. a body over 1 MiB is body_too_large before the signature is even computed", () => {
    expect(MAX_WEBHOOK_BODY_BYTES).toBe(1_048_576);
    const big = new Uint8Array(MAX_WEBHOOK_BODY_BYTES + 1).fill(0x20);
    expect(rejection(() => parseMetaWebhook(SECRET, { headers: {}, rawBody: big, receivedAt: RECEIVED }))).toBe("body_too_large");
    const exact = new Uint8Array(MAX_WEBHOOK_BODY_BYTES).fill(0x20);
    expect(rejection(() => parseMetaWebhook(SECRET, signed(exact)))).toBe("malformed_payload");
  });
  it("6. more than 1000 changes across the whole envelope is too_many_changes (all-or-nothing, never truncated)", () => {
    expect(MAX_WEBHOOK_CHANGES).toBe(1000);
    const change = { field: "feed", value: { item: "comment", comment_id: "1_1", post_id: "1_2", verb: "add" } };
    const entries = (per: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: String(100 + i), time: 1760000000 + i, changes: Array.from({ length: per }, () => change) }));
    const over = JSON.stringify({ object: "page", entry: entries(250, 5) });
    expect(rejection(() => parseMetaWebhook(SECRET, signed(over)))).toBe("too_many_changes");
    const atCap = parseMetaWebhook(SECRET, signed(JSON.stringify({ object: "page", entry: entries(250, 4) })));
    expect(atCap.changeCount).toBe(1000);
    expect(atCap.hints).toHaveLength(4); // one distinct hint per entry (the 250 copies within an entry are duplicates)
    expect(atCap.duplicateHintCount).toBe(996);
  });
  it("7. an unknown top-level object is unsupported_object and never a hint", () => {
    expect(rejection(() => parse("user-object"))).toBe("unsupported_object");
    expect(rejection(() => parseMetaWebhook(SECRET, signed('{"object":"permissions","entry":[]}')))).toBe("unsupported_object");
    expect(META_WEBHOOK_OBJECTS).toEqual(["page", "instagram"]);
  });
  it("8. empty entries parse to zero hints", () => {
    expect(parse("page-empty-entries")).toMatchObject({ hints: [], entryCount: 0, changeCount: 0, ignoredEventCount: 0, unsupportedChangeCount: 0, rawBodyRetainable: true });
  });
  it("9. a malformed entry rejects the whole delivery", () => {
    for (const entry of ["null", "[]", '{"time":1}', '{"id":"has space","changes":[]}', '{"id":"1","time":"soon","changes":[]}', '{"id":"1","time":-1,"changes":[]}', '{"id":"1","time":1.5,"changes":[]}', '{"id":"1","time":1e15,"changes":[]}', '{"id":"1","changes":{}}', '{"id":"1"}']) {
      expect(rejection(() => parseMetaWebhook(SECRET, signed(`{"object":"page","entry":[${entry}]}`))), entry).toBe("malformed_payload");
    }
  });
  it("10. a malformed change rejects the whole delivery (even beside a valid one)", () => {
    for (const change of ["null", "1", "{}", '{"field":"feed"}', '{"field":1,"value":{}}', '{"field":"feed","value":[]}', '{"field":"feed","value":"x"}']) {
      const body = `{"object":"page","entry":[{"id":"1","time":1,"changes":[{"field":"feed","value":{"item":"comment","comment_id":"1_1","post_id":"1_2","verb":"add"}},${change}]}]}`;
      expect(rejection(() => parseMetaWebhook(SECRET, signed(body))), change).toBe("malformed_payload");
    }
  });
  it("11. the body hash is deterministic and equals SHA-256 of the exact bytes", () => {
    const body = bytesOf("page-comment-add");
    expect(parse("page-comment-add").bodySha256).toBe(metaDeliveryHash(body));
    expect(parse("page-comment-add").bodySha256).toBe(parse("page-comment-add").bodySha256);
  });
  it("12. the hint key is deterministic across deliveries and re-serializations", () => {
    const original = parse("page-comment-add");
    const reserialized = parseMetaWebhook(SECRET, signed(JSON.stringify(JSON.parse(new TextDecoder().decode(bytesOf("page-comment-add"))))));
    expect(reserialized.hints.map((h) => h.eventId)).toEqual(original.hints.map((h) => h.eventId));
    expect(reserialized.bodySha256).not.toBe(original.bodySha256);
    expect(META_WEBHOOK_HINT_KEY_VERSION).toBe("v1");
  });
  it("13. any byte mutation changes the body hash", () => {
    const body = bytesOf("page-comment-add");
    const mutated = Uint8Array.from(body);
    mutated[mutated.length - 2] = (mutated[mutated.length - 2] ?? 0) ^ 0x01;
    expect(metaDeliveryHash(mutated)).not.toBe(metaDeliveryHash(body));
  });
  it("14. the same normalized hint produces the same key; a different fact (parent, time, verb) a different one", () => {
    const parts = ["meta", "page", "1", "feed", "comment", "add", "1_1", "", "1_2", "2025-10-09T08:26:40.000Z"];
    expect(metaHintKey(parts)).toBe(metaHintKey([...parts]));
    expect(metaHintKey(parts)).toMatch(HEX64);
    expect(metaHintKey(parts)).not.toBe(metaHintKey(parts.map((p, i) => (i === 5 ? "edited" : p))));
    expect(metaHintKey(parts)).not.toBe(metaHintKey(parts.map((p, i) => (i === 7 ? "1_0" : p))));
    expect(metaHintKey(parts)).not.toBe(metaHintKey(parts.map((p, i) => (i === 9 ? "" : p))));
    // Length-prefixed tuple encoding: moving a boundary between parts never collides.
    expect(metaHintKey(["ab", "c"])).not.toBe(metaHintKey(["a", "bc"]));
    expect(metaHintKey(["a:b", "c"])).not.toBe(metaHintKey(["a", "b:c"]));
  });
  it("15. an identical change repeated inside one delivery yields one hint and a duplicate count", () => {
    const result = parse("page-duplicate-changes");
    expect(result.hints).toHaveLength(1);
    expect(result).toMatchObject({ changeCount: 2, duplicateHintCount: 1, ignoredEventCount: 0 });
  });
  it("a missing entry time is kept as null (no wall clock is consulted)", () => {
    const result = parse("page-no-time");
    expect(result.hints[0]?.occurredAt).toBeNull();
  });
});

describe("Facebook feed signals", () => {
  it("16. a new top-level comment: created, parent null (its parent_id is the post), content = post", () => {
    const [hint] = parse("page-comment-add").hints;
    expect(hint).toMatchObject({ change: "created", parent: null, target: { kind: "interaction" }, content: { id: "100000000000001_300000000000001" } });
    expect(classifyWebhookHint(hint as WebhookEventHint)).toBe("interaction_created");
  });
  it("17. a reply: the distinct parent_id is preserved as the parent interaction", () => {
    const [hint] = parse("page-reply-add").hints;
    expect(hint).toMatchObject({ change: "created", parent: { platform: "facebook", kind: "interaction", id: "300000000000001_400000000000001" }, target: { id: "300000000000001_400000000000002" } });
  });
  it("18. an edited comment is a change signal", () => {
    const [hint] = parse("page-comment-edited").hints;
    expect(hint?.change).toBe("edited");
    expect(classifyWebhookHint(hint as WebhookEventHint)).toBe("interaction_changed");
  });
  it("19. hide and unhide are change signals, distinguished by the provider verb", () => {
    const hints = parse("page-comment-hide-unhide").hints;
    expect(hints.map((h) => [h.change, classifyWebhookHint(h)])).toEqual([["hidden", "interaction_changed"], ["unhidden", "interaction_changed"]]);
  });
  it("20. a removal is a SIGNAL only: change removed, nothing that resembles a canonical removal", () => {
    const result = parse("page-comment-remove");
    expect(result.hints[0]?.change).toBe("removed");
    expect(classifyWebhookHint(result.hints[0] as WebhookEventHint)).toBe("interaction_removed");
    const serialized = stableSerialize(result);
    for (const forbidden of ["removed_at_source", "explicit_provider_signal", "direct_fetch_confirmed", "availability", "visibility", "tombstone"]) expect(serialized).not.toContain(forbidden);
  });
  it("21. a post created / edited / removed is a content signal", () => {
    const [created] = parse("page-post-add").hints;
    expect(created).toMatchObject({ change: "created", target: { kind: "content", id: "100000000000001_300000000000001" }, content: null, parent: null });
    expect(parse("page-post-edited-remove").hints.map((h) => [h.target.kind, h.change, classifyWebhookHint(h)])).toEqual([["content", "updated", "content_changed"], ["content", "removed", "content_removed"]]);
  });
  it("22. text and author fields present in the body are absent from the normalized result", () => {
    for (const name of ["page-comment-add", "page-reply-add", "page-comment-edited", "page-post-add", "page-feed-plus-messaging", "page-feed-plus-mention"]) expectNoSocialData(parse(name));
  });
  it("23. a comment change without comment_id yields no guessed hint (ignored and counted)", () => {
    expect(parse("page-comment-missing-id")).toMatchObject({ hints: [], ignoredEventCount: 1, rawBodyRetainable: true });
  });
  it("24. an unknown item or verb is ignored, never a stronger classification", () => {
    expect(parse("page-unknown-verb")).toMatchObject({ hints: [], ignoredEventCount: 1 });
    expect(parse("page-reaction")).toMatchObject({ hints: [], ignoredEventCount: 1, rawBodyRetainable: true });
  });
});

describe("Instagram comment signals", () => {
  it("25. a comment signal: created, media as content", () => {
    const [hint] = parse("instagram-comment").hints;
    expect(hint).toMatchObject({ change: "created", content: { id: "17900000000000001" }, parent: null });
  });
  it("26. the media id is captured only when actually provided", () => {
    expect(parse("instagram-comment-no-media").hints[0]?.content).toBeNull();
  });
  it("27. a reply's parent_id is preserved when the provider supplies it", () => {
    const [hint] = parse("instagram-reply").hints;
    expect(hint).toMatchObject({ target: { id: "17850000000000002" }, parent: { platform: "instagram", kind: "interaction", id: "17850000000000001" } });
  });
  it("28. reply semantics are never inferred when parent information is absent", () => {
    expect(parse("instagram-comment").hints[0]?.parent).toBeNull();
  });
  it("29. text and user data are stripped", () => {
    for (const name of ["instagram-comment", "instagram-reply", "instagram-comment-plus-live"]) expectNoSocialData(parse(name));
  });
  it("30. a comments value without an id is ignored (counted), never a guessed hint", () => {
    expect(parse("instagram-comment-missing-id")).toMatchObject({ hints: [], ignoredEventCount: 1 });
  });
});

describe("allowlist and raw-body retention (D-F4)", () => {
  it("31. an allowed feed change beside a messaging entry: the feed hint is kept, the messaging content is absent, the body is not retainable", () => {
    const result = parse("page-feed-plus-messaging");
    expect(result.hints).toHaveLength(1);
    expect(result).toMatchObject({ unsupportedChangeCount: 1, rawBodyRetainable: false, entryCount: 2 });
    expectNoSocialData(result);
    expect(stableSerialize(result)).not.toContain("m_synthetic");
  });
  it("31b. an allowed feed change beside a disallowed `mention` change behaves the same", () => {
    expect(parse("page-feed-plus-mention")).toMatchObject({ unsupportedChangeCount: 1, rawBodyRetainable: false });
    expect(parse("page-feed-plus-mention").hints).toHaveLength(1);
  });
  it("32. only disallowed fields: zero hints, body not retainable", () => {
    expect(parse("page-messaging-only")).toMatchObject({ hints: [], unsupportedChangeCount: 1, rawBodyRetainable: false });
    expect(parse("instagram-mentions")).toMatchObject({ hints: [], unsupportedChangeCount: 1, rawBodyRetainable: false });
    expect(parse("instagram-comment-plus-live")).toMatchObject({ unsupportedChangeCount: 1, rawBodyRetainable: false });
    expect(parse("instagram-comment-plus-live").hints).toHaveLength(1);
  });
  it("33. all allowed fields: body retainable", () => {
    for (const name of ["page-comment-add", "page-post-add", "instagram-comment", "page-reaction", "page-comment-missing-id"]) expect(parse(name).rawBodyRetainable, name).toBe(true);
    expect(META_WEBHOOK_ALLOWED_FIELDS).toEqual({ page: ["feed"], instagram: ["comments"] });
  });
});

describe("contract and composition", () => {
  it("a hint carries exactly the contract's identifier fields", () => {
    const [hint] = parse("page-reply-add").hints;
    expect(Object.keys(hint ?? {}).sort()).toEqual(["account", "change", "content", "deliveryId", "eventId", "occurredAt", "parent", "sequence", "target"]);
  });
  it("the rejection and class vocabularies are closed", () => {
    expect(WEBHOOK_REJECTION_REASONS).toEqual(["missing_signature", "malformed_signature", "unsupported_signature_scheme", "invalid_signature", "stale_timestamp", "body_too_large", "malformed_payload", "unsupported_object", "too_many_changes"]);
    expect(WEBHOOK_HINT_CLASSES).toEqual(["interaction_created", "interaction_changed", "interaction_removed", "content_created", "content_changed", "content_removed"]);
  });
  it("the webhook port composes the pure functions and exposes neither secret", async () => {
    const port = createMetaWebhookPort({ appSecret: new SecretValue(SECRET), verifyToken: new SecretValue(VERIFY_TOKEN) });
    expect(port.provider).toBe("meta");
    expect(port.verifyHandshake({ mode: "subscribe", verifyToken: VERIFY_TOKEN, challenge: "7" })).toEqual({ ok: true, challenge: "7" });
    const result = await port.parseWebhook(signed(bytesOf("instagram-comment")));
    expect(result.hints).toHaveLength(1);
    await expect(port.parseWebhook(signed(bytesOf("instagram-comment"), OTHER_SECRET))).rejects.toMatchObject({ name: "WebhookRejectedError", reason: "invalid_signature" });
    expect(stableSerialize(port)).not.toContain(SECRET);
    expect(stableSerialize(result)).not.toContain(SECRET);
  });
  it("the Meta READ port parses only when composed with the App Secret; the job-runtime composition (no secret) fails closed", async () => {
    const without = createMetaReadPort({ transport: { get: () => Promise.reject(new Error("no request expected")) } as never });
    await expect(without.parseWebhook(signed(bytesOf("page-comment-add")))).rejects.toMatchObject({ name: "WebhookRejectedError", reason: "invalid_signature" });
    const withSecret = createMetaReadPort({ transport: { get: () => Promise.reject(new Error("no request expected")) } as never, webhookSecret: new SecretValue(SECRET) });
    expect((await withSecret.parseWebhook(signed(bytesOf("page-comment-add")))).hints).toHaveLength(1);
    await expect(withSecret.parseWebhook(signed(bytesOf("page-comment-add"), OTHER_SECRET))).rejects.toMatchObject({ reason: "invalid_signature" });
  });
  it("a string body is its UTF-8 bytes (simulator and tests); the same hints and body hash result", () => {
    const bytes = bytesOf("instagram-comment");
    const asString = parseMetaWebhook(SECRET, { headers: { [META_WEBHOOK_SIGNATURE_HEADER]: sign(SECRET, bytes) }, rawBody: new TextDecoder().decode(bytes), receivedAt: RECEIVED });
    expect(asString.bodySha256).toBe(parse("instagram-comment").bodySha256);
    expect(asString.hints).toEqual(parse("instagram-comment").hints);
  });
});
