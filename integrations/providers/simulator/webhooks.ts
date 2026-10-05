/**
 * Simulated webhooks (TA §40, §52). The simulator signs deliveries with HMAC-SHA256 over
 * `<timestamp>.<raw body>` using a signing key supplied at construction (a synthetic test key, never a
 * production secret). Parsing is stateless and fails closed, like a real adapter's would:
 *   missing headers → missing_signature · bad MAC → invalid_signature · timestamp outside tolerance →
 *   stale_timestamp · body not the expected envelope → malformed_payload.
 * Event types the simulator doesn't know are counted and ignored. Hints carry identifiers only.
 *
 * The signature scheme is the simulator's own; real providers' schemes are VALIDATE per provider.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { PLATFORM_KEYS, type PlatformKey } from "../../../domain/platforms";
import { isoInstant, parseIsoInstant, parseProviderObjectId, providerObjectRef, type IsoInstant } from "../contract/identity";
import { WebhookRejectedError, type WebhookEventHint, type WebhookHintChange, type WebhookParseResult, type WebhookRequest } from "../contract/webhooks";
import type { SimulatedEvent, SimulatedEventType } from "./world";

export const SIM_SIGNATURE_HEADER = "x-sim-signature";
export const SIM_TIMESTAMP_HEADER = "x-sim-timestamp";
export const SIM_DELIVERY_HEADER = "x-sim-delivery";

const CHANGE_BY_TYPE: Readonly<Record<SimulatedEventType, WebhookHintChange>> = {
  "interaction.created": "created",
  "interaction.edited": "edited",
  "interaction.removed": "removed",
  "interaction.hidden": "hidden",
  "interaction.unhidden": "unhidden",
  "content.created": "created",
  "content.updated": "updated",
  "content.removed": "removed",
};

function mac(signingKey: string, timestamp: string, rawBody: string): string {
  return `v1=${createHmac("sha256", signingKey).update(`${timestamp}.${rawBody}`, "utf8").digest("hex")}`;
}

/** Signs a raw body the way the simulated provider would deliver it. */
export function signSimulatorDelivery(
  signingKey: string,
  rawBody: string,
  options: { readonly sentAt: IsoInstant; readonly deliveryId: string; readonly receivedAt?: IsoInstant },
): WebhookRequest {
  const timestamp = String(Math.floor(Date.parse(options.sentAt) / 1000));
  return {
    headers: {
      [SIM_SIGNATURE_HEADER]: mac(signingKey, timestamp, rawBody),
      [SIM_TIMESTAMP_HEADER]: timestamp,
      [SIM_DELIVERY_HEADER]: options.deliveryId,
      "content-type": "application/json",
    },
    rawBody,
    receivedAt: options.receivedAt ?? options.sentAt,
  };
}

/** The JSON body the simulated provider sends for a set of events. */
export function simulatorDeliveryBody(deliveryId: string, events: readonly SimulatedEvent[]): string {
  return JSON.stringify({ deliveryId, events });
}

function rejected(reason: WebhookRejectedError["reason"]): never {
  throw new WebhookRejectedError(reason);
}

function signatureMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

type Json = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEvent(value: unknown, deliveryId: string): WebhookEventHint | "ignored" {
  if (!isRecord(value)) return rejected("malformed_payload");
  const type = value["type"];
  if (typeof type !== "string") return rejected("malformed_payload");
  if (!Object.hasOwn(CHANGE_BY_TYPE, type)) return "ignored";
  const change = CHANGE_BY_TYPE[type as SimulatedEventType];
  const platform = value["platform"];
  const target = value["target"];
  const eventId = parseProviderObjectId(value["eventId"]);
  const account = parseProviderObjectId(value["account"]);
  const occurredAt = value["occurredAt"] === null ? null : parseIsoInstant(value["occurredAt"]);
  const sequence = value["sequence"];
  const content = value["content"] === null ? null : parseProviderObjectId(value["content"]);
  if (
    typeof platform !== "string" || !(PLATFORM_KEYS as readonly string[]).includes(platform) || eventId === undefined ||
    account === undefined || occurredAt === undefined || content === undefined ||
    !(sequence === null || typeof sequence === "string") || !isRecord(target)
  ) {
    return rejected("malformed_payload");
  }
  const targetKind = target["kind"];
  const targetId = parseProviderObjectId(target["id"]);
  if ((targetKind !== "content" && targetKind !== "interaction") || targetId === undefined) return rejected("malformed_payload");
  const p = platform as PlatformKey;
  return {
    eventId,
    deliveryId,
    account: providerObjectRef(p, "asset", account),
    target: providerObjectRef(p, targetKind, targetId),
    content: content === null ? null : providerObjectRef(p, "content", content),
    change,
    occurredAt,
    sequence,
  };
}

/** Verify (signature, timestamp tolerance) then parse. Pure apart from the HMAC. */
export function parseSimulatorWebhook(signingKey: string, toleranceSeconds: number, request: WebhookRequest): WebhookParseResult {
  const signature = request.headers[SIM_SIGNATURE_HEADER];
  const timestamp = request.headers[SIM_TIMESTAMP_HEADER];
  if (signature === undefined || timestamp === undefined || signature === "" || timestamp === "") return rejected("missing_signature");
  if (!signatureMatches(mac(signingKey, timestamp, request.rawBody), signature)) return rejected("invalid_signature");
  if (!/^\d{1,12}$/.test(timestamp)) return rejected("stale_timestamp");
  const skew = Math.abs(Date.parse(request.receivedAt) / 1000 - Number(timestamp));
  if (!Number.isFinite(skew) || skew > toleranceSeconds) return rejected("stale_timestamp");

  let body: unknown;
  try {
    body = JSON.parse(request.rawBody) as unknown;
  } catch {
    return rejected("malformed_payload");
  }
  if (!isRecord(body) || !Array.isArray(body["events"])) return rejected("malformed_payload");
  const deliveryId = parseProviderObjectId(body["deliveryId"]);
  if (deliveryId === undefined || request.headers[SIM_DELIVERY_HEADER] !== deliveryId) return rejected("malformed_payload");

  const hints: WebhookEventHint[] = [];
  let ignoredEventCount = 0;
  for (const entry of body["events"] as readonly unknown[]) {
    const parsed = parseEvent(entry, deliveryId);
    if (parsed === "ignored") ignoredEventCount += 1;
    else hints.push(parsed);
  }
  return { deliveryId, hints, ignoredEventCount };
}

/** Convenience for tests and local tooling: a signed delivery of `events`, sent "now" in the world's clock. */
export function signedDeliveryOf(
  signingKey: string,
  deliveryId: string,
  events: readonly SimulatedEvent[],
  sentAt: Date | IsoInstant,
): WebhookRequest {
  const at = typeof sentAt === "string" ? sentAt : isoInstant(sentAt);
  return signSimulatorDelivery(signingKey, simulatorDeliveryBody(deliveryId, events), { sentAt: at, deliveryId });
}
