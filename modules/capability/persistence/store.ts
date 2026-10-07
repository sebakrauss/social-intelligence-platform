/**
 * PostgreSQL capability profile store, inside a tenant-scoped transaction under forced RLS. The worker writes; the
 * web only reads (it has no write grant). Rows are parsed strictly: a value outside the closed vocabularies is
 * corruption, never passed on.
 *
 * Write = one atomic step per evaluation: insert the header if none exists; otherwise lock it (FOR UPDATE) and apply
 * the semantic freshness rule (compareFreshness: catalog revision, then inputs_as_of; the digest only for equality):
 *   newer → new revision, entries replaced · same_content_newer → only last-verified bookkeeping advances
 *   same → nothing · stale → nothing · conflict (same revision and time, different content) → nothing, reported.
 * The lock serializes concurrent writers; it never replaces the freshness rule, which runs after it.
 */
import { and, asc, eq } from "drizzle-orm";
import type { DatabaseTransaction } from "@/platform/db";
import { compareFreshness, type CapabilityProfileStore, type ProfileWrite, type StoredProfileHeader } from "../application/ports";
import { CATALOG_IDS } from "../domain/catalog";
import { factsObservedAt, type CapabilityObservation, type FactsInput, type ProfileEntry } from "../domain/profile";
import {
  CAPABILITY_ASSET_CLASSES,
  CAPABILITY_CONTENT_KINDS,
  CAPABILITY_KEYS,
  CAPABILITY_REASON_CODES,
  CAPABILITY_SOURCES,
  CAPABILITY_STATES,
  LIMITATION_CODES,
  VALIDATION_STATUSES,
  ANY,
  isCapabilityContentKind,
  isCapabilityKey,
  isCapabilitySource,
} from "../domain/vocabulary";
import { accountProfiles, profileEntries } from "./tables";

function corrupt(table: string): never {
  throw new TypeError(`capability persistence: unexpected value in ${table}`);
}

function closed<T extends string>(values: readonly T[], value: unknown, table: string): T {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : corrupt(table);
}

const SCOPE_KINDS = [...CAPABILITY_CONTENT_KINDS, ANY] as const;
const SCOPE_SOURCES = [...CAPABILITY_SOURCES, ANY] as const;
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function observationsToJson(observations: readonly CapabilityObservation[]): unknown[] {
  return observations.map((o) => ({ ...o, observedAt: o.observedAt.toISOString() }));
}

function observationsFromJson(value: unknown): CapabilityObservation[] {
  const table = "account_profiles.observations";
  if (!Array.isArray(value)) corrupt(table);
  return value.map((raw: unknown): CapabilityObservation => {
    if (typeof raw !== "object" || raw === null) corrupt(table);
    const o = raw as Record<string, unknown>;
    const observedAt = typeof o["observedAt"] === "string" ? new Date(o["observedAt"]) : corrupt(table);
    const ref = typeof o["ref"] === "string" && REF.test(o["ref"]) ? o["ref"] : corrupt(table);
    if (!isCapabilityKey(o["capability"])) corrupt(table);
    const capability = o["capability"];
    if (o["kind"] === "permission_missing") return { kind: "permission_missing", capability, observedAt, ref };
    if (o["kind"] === "target_not_eligible" && isCapabilityContentKind(o["contentKind"]) && isCapabilitySource(o["source"])) {
      return { kind: "target_not_eligible", capability, contentKind: o["contentKind"], source: o["source"], observedAt, ref };
    }
    return corrupt(table);
  });
}

function toHeader(row: typeof accountProfiles.$inferSelect): StoredProfileHeader {
  const table = "account_profiles";
  const facts: FactsInput = row.factsAvailable
    ? {
        kind: "available",
        assetClass: closed(CAPABILITY_ASSET_CLASSES, row.factsAssetClass, table),
        grantedPermissions: row.factsGrantedPermissions,
        linkedAdAccountIds: row.factsLinkedAdAccountIds,
        accountIdentityKnown: row.factsAccountIdentityKnown ?? corrupt(table),
        obtainedAt: row.factsObservedAt,
      }
    : { kind: "unavailable", observedAt: row.factsObservedAt };
  return {
    connectedAccountId: row.connectedAccountId,
    catalogId: closed(CATALOG_IDS, row.catalogId, table),
    catalogRevision: row.catalogRevision,
    facts,
    observations: observationsFromJson(row.observations),
    inputsAsOf: row.inputsAsOf,
    inputDigest: row.inputDigest,
    evaluatedAt: row.evaluatedAt,
    lastVerifiedAt: row.lastVerifiedAt,
    revision: row.revision,
  };
}

function toEntry(row: typeof profileEntries.$inferSelect): ProfileEntry {
  const table = "profile_entries";
  return {
    capability: closed(CAPABILITY_KEYS, row.capability, table),
    contentKind: closed(SCOPE_KINDS, row.contentKind, table),
    source: closed(SCOPE_SOURCES, row.source, table),
    state: closed(CAPABILITY_STATES, row.state, table),
    reasons: row.reasonCodes.map((code) => closed(CAPABILITY_REASON_CODES, code, table)),
    limitation: row.limitationCode === null ? null : { code: closed(LIMITATION_CODES, row.limitationCode, table), value: row.limitationValue },
    catalogValidation: closed(VALIDATION_STATUSES, row.catalogValidation, table),
    evidence: row.evidenceRef,
    observationRefs: row.observationRefs,
  };
}

export function createPostgresCapabilityStore(tx: DatabaseTransaction): CapabilityProfileStore {
  const headerOf = async (connectedAccountId: string, lock: boolean): Promise<StoredProfileHeader | undefined> => {
    const query = tx.select().from(accountProfiles).where(eq(accountProfiles.connectedAccountId, connectedAccountId)).limit(2);
    const rows = lock ? await query.for("update") : await query;
    if (rows.length > 1) corrupt("account_profiles");
    const row = rows[0];
    return row === undefined ? undefined : toHeader(row);
  };

  const headerValues = (write: ProfileWrite, revision: number, now: Date) => {
    const facts = write.facts.kind === "available" ? write.facts : undefined;
    return {
      catalogId: write.profile.catalogId,
      catalogRevision: write.profile.catalogRevision,
      factsAvailable: facts !== undefined,
      factsAssetClass: facts?.assetClass ?? null,
      factsGrantedPermissions: [...(facts?.grantedPermissions ?? [])],
      factsLinkedAdAccountIds: [...(facts?.linkedAdAccountIds ?? [])],
      factsAccountIdentityKnown: facts?.accountIdentityKnown ?? null,
      factsObservedAt: factsObservedAt(write.facts),
      observations: observationsToJson(write.observations),
      inputsAsOf: write.profile.inputsAsOf,
      inputDigest: write.inputDigest,
      evaluatedAt: write.profile.evaluatedAt,
      lastVerifiedAt: write.profile.evaluatedAt,
      revision,
      updatedAt: now,
    };
  };

  const replaceEntries = async (write: ProfileWrite, revision: number): Promise<void> => {
    await tx.delete(profileEntries).where(eq(profileEntries.connectedAccountId, write.connectedAccountId));
    if (write.profile.entries.length === 0) return;
    await tx.insert(profileEntries).values(
      write.profile.entries.map((entry) => ({
        organizationId: write.organizationId,
        workspaceId: write.workspaceId,
        connectedAccountId: write.connectedAccountId,
        capability: entry.capability,
        contentKind: entry.contentKind,
        source: entry.source,
        state: entry.state,
        reasonCodes: [...entry.reasons],
        limitationCode: entry.limitation?.code ?? null,
        limitationValue: entry.limitation?.value ?? null,
        catalogValidation: entry.catalogValidation,
        evidenceRef: entry.evidence,
        observationRefs: [...entry.observationRefs],
        revision,
        evaluatedAt: write.profile.evaluatedAt,
      })),
    );
  };

  return {
    header: (connectedAccountId) => headerOf(connectedAccountId, false),
    async entries(connectedAccountId) {
      const rows = await tx
        .select()
        .from(profileEntries)
        .where(eq(profileEntries.connectedAccountId, connectedAccountId))
        .orderBy(asc(profileEntries.capability), asc(profileEntries.contentKind), asc(profileEntries.source));
      return rows.map(toEntry);
    },
    async write(write) {
      const now = write.profile.evaluatedAt;
      const inserted = await tx
        .insert(accountProfiles)
        .values({ organizationId: write.organizationId, workspaceId: write.workspaceId, connectedAccountId: write.connectedAccountId, createdAt: now, ...headerValues(write, 1, now) })
        .onConflictDoNothing({ target: [accountProfiles.workspaceId, accountProfiles.connectedAccountId] })
        .returning({ revision: accountProfiles.revision });
      if (inserted.length === 1) {
        await replaceEntries(write, 1);
        return { kind: "applied", revision: 1 };
      }
      const stored = await headerOf(write.connectedAccountId, true);
      if (stored === undefined) return corrupt("account_profiles");
      const verdict = compareFreshness(
        { catalogRevision: write.profile.catalogRevision, inputsAsOf: write.profile.inputsAsOf, inputDigest: write.inputDigest },
        stored,
      );
      if (verdict === "stale") return { kind: "stale", revision: stored.revision };
      if (verdict === "conflict") return { kind: "conflict", revision: stored.revision };
      if (verdict === "same") return { kind: "unchanged", revision: stored.revision };
      if (verdict === "same_content_newer") {
        // Identical content re-verified on newer inputs: bookkeeping only — no semantic revision, entries untouched.
        await tx
          .update(accountProfiles)
          .set({
            inputsAsOf: write.profile.inputsAsOf,
            factsObservedAt: factsObservedAt(write.facts),
            lastVerifiedAt: write.profile.evaluatedAt > stored.lastVerifiedAt ? write.profile.evaluatedAt : stored.lastVerifiedAt,
            updatedAt: now,
          })
          .where(and(eq(accountProfiles.connectedAccountId, write.connectedAccountId), eq(accountProfiles.revision, stored.revision)));
        return { kind: "unchanged", revision: stored.revision };
      }
      const revision = stored.revision + 1;
      await tx
        .update(accountProfiles)
        .set(headerValues(write, revision, now))
        .where(and(eq(accountProfiles.connectedAccountId, write.connectedAccountId), eq(accountProfiles.revision, stored.revision)));
      await replaceEntries(write, revision);
      return { kind: "applied", revision };
    },
  };
}
