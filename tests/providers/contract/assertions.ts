/**
 * Shape assertions for normalized provider output. Adapter-agnostic: they check the contract's guarantees
 * (identity, closed vocabularies, timestamps, raw references, budget signals), not any provider's data.
 */
import { expect } from "vitest";
import { PLATFORM_KEYS } from "@/domain/platforms";
import {
  AUTHOR_ROLES,
  CONTENT_AVAILABILITY,
  CONTENT_KINDS,
  CONTENT_SOURCES,
  INTERACTION_AVAILABILITY,
  INTERACTION_KINDS,
  INTERACTION_VISIBILITY,
  PAID_STATUSES,
  PROVIDER_NAMES,
  parseIsoInstant,
  parseProviderObjectId,
  type ContentDto,
  type InteractionDto,
  type PaidContextItem,
  type ProviderObjectKind,
  type ProviderObjectRef,
  type ProviderResult,
  type RateBudgetSignal,
  type RawReference,
} from "@/integrations/providers/contract";

export function expectRef(ref: ProviderObjectRef, kind: ProviderObjectKind): void {
  expect(Object.keys(ref).sort()).toEqual(["id", "kind", "platform"]);
  expect(PLATFORM_KEYS).toContain(ref.platform);
  expect(ref.kind).toBe(kind);
  expect(parseProviderObjectId(ref.id)).toBe(ref.id);
}

export function expectInstantOrNull(value: unknown): void {
  if (value !== null) expect(parseIsoInstant(value)).toBe(value);
}

export function expectRaw(raw: RawReference, provider: string): void {
  expect(Object.keys(raw).sort()).toEqual(["apiVersion", "provider", "ref"]);
  expect(PROVIDER_NAMES).toContain(raw.provider);
  expect(raw.provider).toBe(provider);
  expect(raw.apiVersion.length).toBeGreaterThan(0);
  expect(raw.ref.length).toBeGreaterThan(0);
}

export function expectBudget(budget: RateBudgetSignal): void {
  if (budget.kind === "not_reported") {
    expect(Object.keys(budget)).toEqual(["kind"]);
    return;
  }
  expect(budget.kind).toBe("reported");
  expect(["app", "account", "endpoint", "unknown"]).toContain(budget.scope);
  if (budget.usedRatio !== null) expect(budget.usedRatio).toBeGreaterThanOrEqual(0);
  if (budget.usedRatio !== null) expect(budget.usedRatio).toBeLessThanOrEqual(1);
  if (budget.remainingCalls !== null) expect(Number.isInteger(budget.remainingCalls) && budget.remainingCalls >= 0).toBe(true);
  expectInstantOrNull(budget.resetAt);
}

export function expectResult<T>(result: ProviderResult<T>): T {
  expect(Object.keys(result).sort()).toEqual(["budget", "data"]);
  expectBudget(result.budget);
  return result.data;
}

export function expectContent(dto: ContentDto, provider: string): void {
  expectRef(dto.ref, "content");
  expectRef(dto.account, "asset");
  expect(CONTENT_KINDS).toContain(dto.contentKind);
  expect(CONTENT_SOURCES).toContain(dto.reportedSource);
  expect(CONTENT_AVAILABILITY).toContain(dto.availability);
  expectInstantOrNull(dto.publishedAt);
  expectInstantOrNull(dto.timestamps.createdAt);
  expectInstantOrNull(dto.timestamps.updatedAt);
  expectRaw(dto.rawReference, provider);
}

export function expectInteraction(dto: InteractionDto, provider: string): void {
  expectRef(dto.ref, "interaction");
  expectRef(dto.content, "content");
  if (dto.parent !== null) expectRef(dto.parent, "interaction");
  expect(INTERACTION_KINDS).toContain(dto.interactionKind);
  expect(dto.interactionKind === "reply").toBe(dto.parent !== null);
  expectRef(dto.author.ref, "author");
  expect(AUTHOR_ROLES).toContain(dto.author.role);
  expect(INTERACTION_VISIBILITY).toContain(dto.visibility);
  expect(INTERACTION_AVAILABILITY).toContain(dto.availability);
  if (dto.availability === "removed_at_source") expect(dto.text).toBeNull();
  expectInstantOrNull(dto.editedAt);
  expectInstantOrNull(dto.timestamps.createdAt);
  expectInstantOrNull(dto.timestamps.updatedAt);
  expectRaw(dto.rawReference, provider);
  // Same platform for the interaction, its content and its author.
  expect(dto.content.platform).toBe(dto.ref.platform);
  expect(dto.author.ref.platform).toBe(dto.ref.platform);
}

export function expectPaidItem(item: PaidContextItem, provider: string): void {
  expect(["campaign", "ad_group", "ad"]).toContain(item.type);
  expectRef(item.ref, item.type);
  expectRef(item.adAccount, "asset");
  expect(PAID_STATUSES).toContain(item.status);
  expectRaw(item.rawReference, provider);
  if (item.type === "ad") {
    if (item.content !== null) expectRef(item.content, "content");
    if (item.adGroup !== null) expectRef(item.adGroup, "ad_group");
    if (item.campaign !== null) expectRef(item.campaign, "campaign");
  }
}

/** No secret value appears anywhere in a value's serialized form or message. */
export function expectNoSecrets(value: unknown, secrets: readonly string[]): void {
  const rendered = `${JSON.stringify(value)} ${value instanceof Error ? `${value.message} ${String(value)}` : String(value)}`;
  for (const secret of secrets) expect(rendered).not.toContain(secret);
}
