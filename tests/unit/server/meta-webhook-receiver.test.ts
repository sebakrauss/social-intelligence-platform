/**
 * Step H6-F3 — the Meta webhook HTTP receiver (server/webhooks/meta-receiver.ts) with the REAL H6-F1 port composed from
 * synthetic secrets, and injected record/nudge seams. No database, no network, no provider.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SecretValue, type ProviderWebhookPort, type VerifiedWebhookDelivery } from "@/integrations/providers/contract";
import { MAX_WEBHOOK_BODY_BYTES, createMetaWebhookPort } from "@/integrations/providers/meta/webhooks";
import { createLogger } from "@/platform/observability";
import { MAX_WEBHOOK_REQUEST_BYTES, handleMetaWebhookGet, handleMetaWebhookPost, type MetaReceiverDependencies, type WebhookReceipt } from "@/server/webhooks/meta-receiver";

const SECRET = "synthetic-meta-app-secret-for-tests";
const TOKEN = "synthetic-verify-token-0001";
const FIXTURES = path.resolve(import.meta.dirname, "../../../fixtures/providers/meta-webhooks");
const URL_BASE = "https://wrenkind.example.test/api/webhooks/meta";
const bytesOf = (name: string): Uint8Array => new Uint8Array(readFileSync(path.join(FIXTURES, `${name}.json`)));
const sign = (bytes: Uint8Array, secret = SECRET): string => `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`;

interface Harness {
  readonly deps: MetaReceiverDependencies;
  readonly recorded: { delivery: VerifiedWebhookDelivery; bytes: Uint8Array }[];
  readonly nudged: string[];
  readonly lines: string[];
}

function harness(options: { port?: ProviderWebhookPort | "throw" | undefined; record?: (delivery: VerifiedWebhookDelivery) => Promise<WebhookReceipt>; nudge?: () => Promise<void> } = {}): Harness {
  const recorded: Harness["recorded"] = [];
  const nudged: string[] = [];
  const lines: string[] = [];
  const port = "port" in options ? options.port : createMetaWebhookPort({ appSecret: new SecretValue(SECRET), verifyToken: new SecretValue(TOKEN) });
  return {
    recorded, nudged, lines,
    deps: {
      port: () => {
        if (port === "throw") throw new Error("PROVIDER_META_WEBHOOK_VERIFY_TOKEN invalid");
        return port;
      },
      record: async (delivery, bytes) => {
        recorded.push({ delivery, bytes });
        return options.record === undefined ? { outcome: "recorded", receiptId: "00000000-0000-4000-8000-0000000000a1", newHintCount: delivery.hints.length } : options.record(delivery);
      },
      nudge: async (receiptId) => {
        nudged.push(receiptId);
        if (options.nudge !== undefined) await options.nudge();
      },
      afterResponse: (work) => { void work(); },
      logger: createLogger({ sink: (line) => lines.push(line), now: () => new Date("2026-10-28T12:00:00.000Z") }),
      now: () => new Date("2026-10-28T12:00:00.000Z"),
    },
  };
}

const get = (query: string, h: Harness) => handleMetaWebhookGet(new Request(`${URL_BASE}${query}`), h.deps);
const post = (h: Harness, body: Uint8Array | string, headers: Record<string, string> = {}) => {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return handleMetaWebhookPost(new Request(URL_BASE, { method: "POST", body: bytes as Uint8Array<ArrayBuffer>, headers: { "content-type": "application/json", "x-hub-signature-256": sign(bytes), ...headers } }), h.deps);
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const noCookies = (response: Response) => {
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
};

describe("GET — subscription handshake", () => {
  it("1. subscribe + the right token → 200 with exactly the challenge (text/plain), no cookie", async () => {
    const h = harness();
    const response = get(`?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=1158201444`, h);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("1158201444");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    noCookies(response);
  });
  it("2–3, 5. wrong token, missing token, wrong mode → 403 with no body and no echo", async () => {
    const h = harness();
    for (const query of [`?hub.mode=subscribe&hub.verify_token=wrong-token-0000000&hub.challenge=1`, `?hub.mode=subscribe&hub.challenge=1`, `?hub.mode=unsubscribe&hub.verify_token=${TOKEN}&hub.challenge=1`]) {
      const response = get(query, h);
      expect(response.status, query).toBe(403);
      expect(await response.text()).toBe("");
    }
    expect(h.lines.join("\n")).not.toContain(TOKEN);
  });
  it("4. a duplicated parameter is ambiguous → 400 (never the first value)", () => {
    const h = harness();
    expect(get(`?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.verify_token=${TOKEN}&hub.challenge=1`, h).status).toBe(400);
    expect(get(`?hub.mode=subscribe&hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=1`, h).status).toBe(400);
    expect(get(`?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=<x>`, h).status).toBe(400);
  });
  it("6. receiver not configured (or invalid configuration) → 503", () => {
    expect(get(`?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=1`, harness({ port: undefined })).status).toBe(503);
    expect(get(`?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=1`, harness({ port: "throw" })).status).toBe(503);
  });
});

describe("POST — security and ordering", () => {
  it("8, 18. a valid signed delivery is recorded with its EXACT bytes and acknowledged 200 (empty body, no cookie)", async () => {
    const h = harness();
    const bytes = bytesOf("page-comment-add");
    const response = await post(h, bytes);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    noCookies(response);
    expect(h.recorded).toHaveLength(1);
    expect(Buffer.from(h.recorded[0]?.bytes ?? []).equals(Buffer.from(bytes))).toBe(true);
    expect(h.recorded[0]?.delivery).toMatchObject({ provider: "meta", object: "page", rawBodyRetainable: true });
  });
  it("9, 23. a duplicate receipt → 200 and NO nudge", async () => {
    const h = harness({ record: () => Promise.resolve({ outcome: "duplicate", receiptId: "00000000-0000-4000-8000-0000000000a1", newHintCount: 0 }) });
    expect((await post(h, bytesOf("page-comment-add"))).status).toBe(200);
    await flush();
    expect(h.nudged).toEqual([]);
  });
  it("10–12. missing, invalid or SHA-1 signature → 401 and nothing recorded", async () => {
    const h = harness();
    const bytes = bytesOf("page-comment-add");
    expect((await post(h, bytes, { "x-hub-signature-256": "" })).status).toBe(401);
    expect((await post(h, bytes, { "x-hub-signature-256": sign(bytes, "another-secret") })).status).toBe(401);
    expect((await post(h, bytes, { "x-hub-signature-256": `sha1=${createHmac("sha1", SECRET).update(bytes).digest("hex")}` })).status).toBe(401);
    const unsigned = await handleMetaWebhookPost(new Request(URL_BASE, { method: "POST", body: bytes as Uint8Array<ArrayBuffer>, headers: { "content-type": "application/json" } }), h.deps);
    expect(unsigned.status).toBe(401);
    expect(h.recorded).toEqual([]);
  });
  it("13, 16. malformed JSON or an unsupported object (validly signed) → 400, nothing recorded", async () => {
    const h = harness();
    expect((await post(h, "{not json")).status).toBe(400);
    expect((await post(h, bytesOf("user-object"))).status).toBe(400);
    expect(h.recorded).toEqual([]);
  });
  it("14. over 1 MiB → 413, by declared length (body never read) and by streamed size (declared length absent)", async () => {
    expect(MAX_WEBHOOK_REQUEST_BYTES).toBe(MAX_WEBHOOK_BODY_BYTES);
    const h = harness();
    const declared = await handleMetaWebhookPost(new Request(URL_BASE, { method: "POST", body: "{}", headers: { "content-type": "application/json", "content-length": String(MAX_WEBHOOK_REQUEST_BYTES + 1), "x-hub-signature-256": "sha256=00" } }), h.deps);
    expect(declared.status).toBe(413);
    const big = new Uint8Array(MAX_WEBHOOK_REQUEST_BYTES + 1).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < big.length; i += 65_536) controller.enqueue(big.subarray(i, i + 65_536)); controller.close(); } });
    const streamed = await handleMetaWebhookPost(new Request(URL_BASE, { method: "POST", body: stream, duplex: "half", headers: { "content-type": "application/json", "x-hub-signature-256": sign(big) } } as RequestInit), h.deps);
    expect(streamed.status).toBe(413);
    expect(h.recorded).toEqual([]);
  });
  it("15. a non-JSON content type → 415 before reading", async () => {
    const h = harness();
    expect((await post(h, bytesOf("page-comment-add"), { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(h, bytesOf("page-comment-add"), { "content-type": "application/json; charset=utf-8" })).status).toBe(200);
  });
  it("17. allowed feed + messaging → recorded with rawBodyRetainable=false (decided by H6-F1, honored here)", async () => {
    const h = harness();
    expect((await post(h, bytesOf("page-feed-plus-messaging"))).status).toBe(200);
    expect(h.recorded[0]?.delivery).toMatchObject({ rawBodyRetainable: false, unsupportedChangeCount: 1 });
    expect(h.recorded[0]?.delivery.hints).toHaveLength(1);
  });
  it("19. the receiver never parses or re-serializes JSON itself, and passes only the signature header", () => {
    const code = readFileSync(path.resolve(import.meta.dirname, "../../../server/webhooks/meta-receiver.ts"), "utf8");
    expect(code).not.toMatch(/request\.json\(|JSON\.parse|JSON\.stringify|request\.text\(|request\.arrayBuffer\(/);
    expect(code).toMatch(/headers: signature === null \? \{\} : \{ \[META_SIGNATURE_HEADER\]: signature \}/);
  });
  it("20. a receipt failure before commit → 503 (Meta retries), no nudge", async () => {
    const h = harness({ record: () => Promise.reject(new Error("connection reset")) });
    expect((await post(h, bytesOf("page-comment-add"))).status).toBe(503);
    await flush();
    expect(h.nudged).toEqual([]);
  });
  it("config unavailable → 503 before reading", async () => {
    expect((await post(harness({ port: undefined }), bytesOf("page-comment-add"))).status).toBe(503);
  });
});

describe("POST — after the receipt commits", () => {
  it("21. a new receipt with new hints → exactly one nudge, keyed by its receipt", async () => {
    const h = harness();
    expect((await post(h, bytesOf("page-comment-add"))).status).toBe(200);
    await flush();
    expect(h.nudged).toEqual(["00000000-0000-4000-8000-0000000000a1"]);
  });
  it("22. a failing nudge never changes the 200 (the cron drains anyway)", async () => {
    const h = harness({ nudge: () => Promise.reject(new Error("trigger down")) });
    expect((await post(h, bytesOf("page-comment-add"))).status).toBe(200);
    await flush();
    expect(h.lines.some((line) => line.includes("webhook.router.nudge_failed"))).toBe(true);
  });
  it("24. a receipt with zero new hints → no nudge", async () => {
    const h = harness({ record: () => Promise.resolve({ outcome: "recorded", receiptId: "00000000-0000-4000-8000-0000000000a2", newHintCount: 0 }) });
    expect((await post(h, bytesOf("page-messaging-only"))).status).toBe(200);
    await flush();
    expect(h.nudged).toEqual([]);
  });
  it("logs carry event names and counts only: no body, text, signature, token or secret", async () => {
    const h = harness();
    const bytes = bytesOf("page-comment-add");
    await post(h, bytes);
    await post(h, bytes, { "x-hub-signature-256": sign(bytes, "another-secret") });
    get(`?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=7`, h);
    await flush();
    const all = h.lines.join("\n");
    const providerIds = [...new Set(new TextDecoder().decode(bytes).match(/\d{6,}(?:_\d{6,})?/g) ?? [])];
    expect(providerIds.length).toBeGreaterThan(0);
    for (const needle of [SECRET, TOKEN, sign(bytes), "Synthetic comment text", "Synthetic Person", ...providerIds]) expect(all, needle).not.toContain(needle);
    expect(all).toMatch(/webhook\.receipt\.recorded/);
    expect(all).toMatch(/webhook\.rejected\.invalid_signature/);
  });
});
