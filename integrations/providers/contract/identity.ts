/**
 * Provider identity primitives (TA §15.2, §18.1). Every provider-derived DTO carries the identity of the
 * object as the provider knows it, so the same external object is recognized across webhooks, polling,
 * backfill and reconciliation. Internal (product) identities are separate and never derived from these.
 *
 * Identity = (platform, kind, provider object id). The platform is product vocabulary (domain/platforms);
 * for paid-context objects it is the platform the ad account was retrieved through, not a claim about where
 * ads are delivered. Provider ids are opaque: never parsed for meaning, never used to infer capability.
 */
import { isPlatformKey, type PlatformKey } from "../../../domain/platforms";

/** Adapter identities. Only the simulator is implemented in Step 4; real adapters arrive after API validation. */
export const PROVIDER_NAMES = ["meta", "tiktok", "simulator"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export const PROVIDER_OBJECT_KINDS = ["asset", "content", "interaction", "author", "campaign", "ad_group", "ad"] as const;
export type ProviderObjectKind = (typeof PROVIDER_OBJECT_KINDS)[number];

declare const providerIdBrand: unique symbol;
/** An opaque provider object identifier: printable, bounded, no whitespace. */
export type ProviderObjectId = string & { readonly [providerIdBrand]: true };

const PROVIDER_OBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function parseProviderObjectId(value: unknown): ProviderObjectId | undefined {
  return typeof value === "string" && PROVIDER_OBJECT_ID.test(value) ? (value as ProviderObjectId) : undefined;
}

export interface ProviderObjectRef<K extends ProviderObjectKind = ProviderObjectKind> {
  readonly platform: PlatformKey;
  readonly kind: K;
  readonly id: ProviderObjectId;
}

export function providerObjectRef<K extends ProviderObjectKind>(platform: PlatformKey, kind: K, id: string): ProviderObjectRef<K> {
  const parsed = parseProviderObjectId(id);
  if (!isPlatformKey(platform) || parsed === undefined) throw new TypeError("invalid provider object reference");
  return Object.freeze({ platform, kind, id: parsed });
}

/** Same external object? (Identity equality; never compares internal ids.) */
export function sameProviderObject(a: ProviderObjectRef, b: ProviderObjectRef): boolean {
  return a.platform === b.platform && a.kind === b.kind && a.id === b.id;
}

/** A stable, log-safe key for an identity (identifiers only). */
export function providerObjectKey(ref: ProviderObjectRef): string {
  return `${ref.platform}:${ref.kind}:${ref.id}`;
}

declare const instantBrand: unique symbol;
/** A UTC instant in ISO-8601 form with milliseconds (`2026-09-01T12:00:00.000Z`). Deterministic to serialize. */
export type IsoInstant = string & { readonly [instantBrand]: true };

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseIsoInstant(value: unknown): IsoInstant | undefined {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) || new Date(time).toISOString() !== value ? undefined : (value as IsoInstant);
}

export function isoInstant(date: Date): IsoInstant {
  return date.toISOString() as IsoInstant;
}

/** Provider timestamps as reported. `null` means the provider didn't report it, never "now". */
export interface ProviderTimestamps {
  readonly createdAt: IsoInstant | null;
  readonly updatedAt: IsoInstant | null;
}

/**
 * Opaque pointer to the raw provider payload an object was normalized from (TA §15.2, §15.4), for debugging
 * and replay. It is a reference, never the payload: raw payload persistence belongs to ingestion (Step 6).
 * `apiVersion` records the provider API version the adapter pinned; simulator references say "simulator-v1",
 * which is not a real provider API version.
 */
export interface RawReference {
  readonly provider: ProviderName;
  readonly apiVersion: string;
  readonly ref: string;
}

const RAW_REF = /^[A-Za-z0-9][A-Za-z0-9_.:/#@=-]{0,255}$/;
const API_VERSION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

export function rawReference(provider: ProviderName, apiVersion: string, ref: string): RawReference {
  if (!API_VERSION.test(apiVersion) || !RAW_REF.test(ref)) throw new TypeError("invalid raw reference");
  return Object.freeze({ provider, apiVersion, ref });
}
