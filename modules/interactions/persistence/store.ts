/**
 * Interaction persistence (Step H6-B). Runs inside the caller's workspace-scoped transaction (RLS binds the workspace).
 * Canonical rows are looked up by (platform, provider interaction id) — the workspace is the bound scope — and locked
 * for update so concurrent ingestion of one interaction serializes. Source text versions and state observations are
 * append-only (INSERT only; no UPDATE/DELETE grant). Identity and scope columns are never updated (no grant; scope guard
 * trigger for the rest).
 *
 * Ancestry (Step H6-C1): `subtree` and `attachSubtree` walk parent links within the bound workspace with a recursive
 * query capped at ANCESTRY_MAX_DEPTH (cycle-safe: the depth bound ends any loop; a cycle reads as depth exceeded).
 *
 * `loadStoredInteractionAuthority` is the persistence-side issuer of stored provenance (H6-A1, TL decision 1): it reads
 * the canonical OBSERVED row in this transaction's workspace and issues an authority from it. Nothing else may.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { WorkspaceId } from "@/domain/ids";
import { parseInstant } from "@/domain/instant";
import { isPlatformKey } from "@/domain/platforms";
import { parseProviderId } from "@/domain/provider-identity";
import type { DatabaseTransaction } from "@/platform/db";
import { ANCESTRY_MAX_DEPTH } from "../domain/relation";
import { issueStoredInteractionAuthority, type StoredInteractionAuthority } from "../domain/stored-authority";
import { isInteractionKind } from "../domain/vocabulary";
import type { InteractionStore, InteractionTextReader, NewInteractionRow, ObservedFields } from "../application/ports";
import { authors, interactionRows, sourceTextVersions, stateObservations } from "./tables";









export function createPostgresInteractionStore(tx: DatabaseTransaction): InteractionStore {
  const pointerColumns = { id: sourceTextVersions.id, textHash: sourceTextVersions.textHash, providerEditedAt: sourceTextVersions.providerEditedAt, observedAt: sourceTextVersions.observedAt };
  return {
    async ensureAuthor(author) {
      const inserted = await tx
        .insert(authors)
        .values({ id: author.id, organizationId: author.organizationId, workspaceId: author.workspaceId, platform: author.platform, providerAuthorId: author.providerAuthorId,
          role: author.role, label: author.label, createdAt: author.now, updatedAt: author.now })
        .onConflictDoNothing({ target: [authors.workspaceId, authors.platform, authors.providerAuthorId] })
        .returning({ id: authors.id });
      if (inserted[0] !== undefined) return inserted[0].id;
      const existing = (await tx.select({ id: authors.id, label: authors.label }).from(authors)
        .where(and(eq(authors.platform, author.platform), eq(authors.providerAuthorId, author.providerAuthorId))).limit(1))[0];
      if (existing === undefined) throw new Error("ingestion_author_missing");
      if (author.label !== null && author.label !== existing.label) await tx.update(authors).set({ label: author.label, updatedAt: author.now }).where(eq(authors.id, existing.id));
      return existing.id;
    },
    async findByKey(platform, providerInteractionId) {
      return (await tx.select().from(interactionRows)
        .where(and(eq(interactionRows.platform, platform), eq(interactionRows.providerInteractionId, providerInteractionId))).limit(1).for("update"))[0];
    },
    async exists(id) {
      return (await tx.select({ id: interactionRows.id }).from(interactionRows).where(eq(interactionRows.id, id)).limit(1)).length === 1;
    },
    async findById(id) {
      return (await tx.select().from(interactionRows).where(eq(interactionRows.id, id)).limit(1).for("update"))[0];
    },
    async insertPlaceholder(row) {
      await tx.insert(interactionRows).values({ ...base(row), observed: false });
    },
    async insertObserved(row, fields) {
      await tx.insert(interactionRows).values({ ...base(row), ...observedValues(fields) });
    },
    async completePlaceholder(id, fields) {
      await tx.update(interactionRows).set({ ...observedValues(fields), updatedAt: fields.observedAt }).where(and(eq(interactionRows.id, id), eq(interactionRows.observed, false)));
    },
    async updateCurrent(id, update, now) {
      const set: Partial<typeof interactionRows.$inferInsert> = { updatedAt: now };
      if (update.currentSourceTextVersionId !== undefined) set.currentSourceTextVersionId = update.currentSourceTextVersionId;
      if (update.textObservedAt !== undefined) set.textObservedAt = update.textObservedAt;
      if (update.providerEditedAt !== undefined) set.providerEditedAt = update.providerEditedAt;
      if (update.visibility !== undefined) set.currentVisibility = update.visibility;
      if (update.availability !== undefined) set.currentAvailability = update.availability;
      if (update.removalBasis !== undefined) set.currentRemovalBasis = update.removalBasis;
      if (update.stateObservedAt !== undefined) set.stateObservedAt = update.stateObservedAt;
      if (update.latestObservedAt !== undefined) set.latestObservedAt = update.latestObservedAt;
      await tx.update(interactionRows).set(set).where(eq(interactionRows.id, id));
    },
    async subtree(rootId) {
      const result = await tx.execute<{ id: string; conversation_id: string | null; depth: number; deepest: number }>(sql`
        with recursive descendants (id, workspace_id, depth) as (
          select i.id, i.workspace_id, 0 from interactions.interactions i where i.id = ${rootId}
          union all
          select c.id, c.workspace_id, d.depth + 1
            from interactions.interactions c
            join descendants d on c.workspace_id = d.workspace_id and c.parent_interaction_id = d.id
           where d.depth <= ${ANCESTRY_MAX_DEPTH}
        )
        select i.id, i.conversation_id, min(d.depth)::int as depth, max(d.depth)::int as deepest
          from descendants d join interactions.interactions i on i.workspace_id = d.workspace_id and i.id = d.id
         group by i.id, i.conversation_id
         order by 3, 1`);
      // Lock what was found (a recursive CTE cannot carry FOR UPDATE itself); serial per account, but never assumed.
      const ids = result.rows.map((row) => row.id);
      if (ids.length > 0) await tx.select({ id: interactionRows.id }).from(interactionRows).where(inArray(interactionRows.id, ids)).for("update");
      return {
        members: result.rows.filter((row) => row.depth <= ANCESTRY_MAX_DEPTH).map((row) => ({ id: row.id, conversationId: row.conversation_id, depth: row.depth })),
        // A member reached again below the cap (a cycle) or a chain deeper than the cap: never assumed resolved.
        depthExceeded: result.rows.some((row) => row.deepest > ANCESTRY_MAX_DEPTH),
      };
    },
    async attachSubtree(rootId, conversationId, now) {
      // One statement: the composite (parent, conversation) foreign key is checked at its end, so a whole thread moves
      // from no conversation to `conversationId` at once; rows that already have a conversation are never touched.
      const result = await tx.execute(sql`
        with recursive descendants (id, workspace_id, depth) as (
          select i.id, i.workspace_id, 0 from interactions.interactions i where i.id = ${rootId}
          union all
          select c.id, c.workspace_id, d.depth + 1
            from interactions.interactions c
            join descendants d on c.workspace_id = d.workspace_id and c.parent_interaction_id = d.id
           where d.depth < ${ANCESTRY_MAX_DEPTH}
        )
        update interactions.interactions i
           set conversation_id = ${conversationId}, updated_at = ${now}
          from (select distinct id, workspace_id from descendants) d
         where i.workspace_id = d.workspace_id and i.id = d.id and i.conversation_id is null`);
      return result.rowCount ?? 0;
    },
    async textVersion(id) {
      return (await tx.select(pointerColumns).from(sourceTextVersions).where(eq(sourceTextVersions.id, id)).limit(1))[0];
    },
    async textVersionByHash(interactionId, textHash) {
      return (await tx.select(pointerColumns).from(sourceTextVersions)
        .where(and(eq(sourceTextVersions.interactionId, interactionId), eq(sourceTextVersions.textHash, textHash))).limit(1))[0];
    },
    async appendTextVersion(version) {
      await tx.insert(sourceTextVersions).values({ ...version, createdAt: version.observedAt });
    },
    async appendStateObservation(observation) {
      await tx.insert(stateObservations).values({ ...observation, createdAt: observation.observedAt })
        .onConflictDoNothing({ target: [stateObservations.workspaceId, stateObservations.interactionId, stateObservations.observedAt, stateObservations.visibility, stateObservations.availability] });
    },
  };
}

const base = (row: NewInteractionRow) => ({
  id: row.id,
  organizationId: row.organizationId,
  workspaceId: row.workspaceId,
  platform: row.platform,
  providerInteractionId: row.providerInteractionId,
  connectedAccountId: row.connectedAccountId,
  providerAssetId: row.providerAssetId,
  contentItemId: row.contentItemId,
  providerContentId: row.providerContentId,
  createdAt: row.now,
  updatedAt: row.now,
});

const observedValues = (fields: ObservedFields) => ({
  observed: true,
  parentInteractionId: fields.parentInteractionId,
  kind: fields.kind,
  authorId: fields.authorId,
  authorRole: fields.authorRole,
  currentVisibility: fields.visibility,
  currentAvailability: fields.availability,
  currentRemovalBasis: fields.removalBasis,
  providerCreatedAt: fields.providerCreatedAt,
  providerEditedAt: fields.providerEditedAt,
  stateObservedAt: fields.observedAt,
  firstObservedAt: fields.observedAt,
  latestObservedAt: fields.observedAt,
});

/**
 * Stored provenance (persistence side): the authority of the canonical OBSERVED interaction (platform, provider id) in
 * this transaction's workspace, or undefined (unknown here, a placeholder, or another workspace's — RLS hides it).
 */
export async function loadStoredInteractionAuthority(tx: DatabaseTransaction, workspaceId: WorkspaceId, platform: string, providerInteractionId: string): Promise<StoredInteractionAuthority | undefined> {
  const row = (await tx.select().from(interactionRows)
    .where(and(eq(interactionRows.platform, platform), eq(interactionRows.providerInteractionId, providerInteractionId))).limit(1))[0];
  if (row === undefined || !row.observed || row.workspaceId !== workspaceId) return undefined;
  const parent = row.parentInteractionId === null ? null : (await tx.select({ providerInteractionId: interactionRows.providerInteractionId }).from(interactionRows)
    .where(eq(interactionRows.id, row.parentInteractionId)).limit(1))[0];
  const platformKey = row.platform;
  const interactionId = parseProviderId(row.providerInteractionId);
  const assetId = parseProviderId(row.providerAssetId);
  const contentId = parseProviderId(row.providerContentId);
  const parentId = parent === undefined ? undefined : parent === null ? null : parseProviderId(parent.providerInteractionId);
  const persistedAt = parseInstant(row.createdAt.toISOString());
  if (!isPlatformKey(platformKey) || interactionId === undefined || assetId === undefined || contentId === undefined || parentId === undefined || persistedAt === undefined || !isInteractionKind(row.kind)) {
    throw new Error("ingestion_canonical_row_incoherent");
  }
  return issueStoredInteractionAuthority({
    canonicalId: row.id,
    persistedAt,
    workspaceId,
    platform: platformKey,
    interactionId,
    connectedAccountId: row.connectedAccountId,
    providerAssetId: assetId,
    contentId,
    parentId,
    kind: row.kind,
  });
}

/**
 * Step H7-B: the analysis-text reader — one specific source text version joined to ITS OWN interaction in the bound
 * workspace (the composite (workspace, interaction, version) relation), never the current-text pointer. Read-only.
 */
export function createPostgresInteractionTextReader(tx: DatabaseTransaction): InteractionTextReader {
  return {
    async analysisText(interactionId, sourceTextVersionId) {
      const rows = await tx
        .select({
          organizationId: interactionRows.organizationId,
          workspaceId: interactionRows.workspaceId,
          interactionId: interactionRows.id,
          sourceTextVersionId: sourceTextVersions.id,
          observed: interactionRows.observed,
          kind: interactionRows.kind,
          authorRole: interactionRows.authorRole,
          sourceText: sourceTextVersions.sourceText,
        })
        .from(sourceTextVersions)
        .innerJoin(interactionRows, and(eq(interactionRows.workspaceId, sourceTextVersions.workspaceId), eq(interactionRows.id, sourceTextVersions.interactionId)))
        .where(and(eq(sourceTextVersions.id, sourceTextVersionId), eq(sourceTextVersions.interactionId, interactionId)))
        .limit(1);
      return rows[0];
    },
  };
}
