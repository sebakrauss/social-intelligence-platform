/**
 * Inbox read access to the interactions tables (Step 7A). Runs inside the caller's USER-scoped transaction: the sealed
 * workspace and 0017's member_read policies decide what is visible (non-guest members of the bound workspace only);
 * this file adds no role logic and never widens a query beyond the bound workspace. Read-only: no insert, update or
 * lock. Every result is bounded by the caller's limit.
 *
 * Text is personal audience content (TA §38.11 class P): it is returned to the server view model, never logged here.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DatabaseTransaction } from "@/platform/db";
import type { ConversationActivityRow, InteractionReadStore, TextVersionRow } from "../application/ports";
import { authors, interactionRows, sourceTextVersions } from "./tables";

const MAX_LIMIT = 500;
/** Upper bound of retained text versions read per interaction (the Inbox asks for far fewer). */
const MAX_VERSIONS_PER_INTERACTION = 50;
/** Canonical UUID shape: anything else never reaches a `::uuid` cast (RFC 4122 variants, versions 1–8). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function bounded(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RangeError("interactions read: limit out of bounds");
  return limit;
}

const summaryColumns = {
  id: interactionRows.id,
  conversationId: interactionRows.conversationId,
  contentItemId: interactionRows.contentItemId,
  connectedAccountId: interactionRows.connectedAccountId,
  platform: interactionRows.platform,
  observed: interactionRows.observed,
  kind: interactionRows.kind,
  parentInteractionId: interactionRows.parentInteractionId,
  authorRole: interactionRows.authorRole,
  authorLabel: authors.label,
  currentSourceTextVersionId: interactionRows.currentSourceTextVersionId,
  currentText: sourceTextVersions.sourceText,
  currentVisibility: interactionRows.currentVisibility,
  currentAvailability: interactionRows.currentAvailability,
  providerCreatedAt: interactionRows.providerCreatedAt,
  providerEditedAt: interactionRows.providerEditedAt,
  textObservedAt: interactionRows.textObservedAt,
  firstObservedAt: interactionRows.firstObservedAt,
  latestObservedAt: interactionRows.latestObservedAt,
};

export function createPostgresInteractionReadStore(tx: DatabaseTransaction): InteractionReadStore {
  const summaryQuery = () =>
    tx
      .select(summaryColumns)
      .from(interactionRows)
      .leftJoin(authors, and(eq(authors.workspaceId, interactionRows.workspaceId), eq(authors.id, interactionRows.authorId)))
      .leftJoin(
        sourceTextVersions,
        and(eq(sourceTextVersions.workspaceId, interactionRows.workspaceId), eq(sourceTextVersions.interactionId, interactionRows.id), eq(sourceTextVersions.id, interactionRows.currentSourceTextVersionId)),
      );
  return {
    async listConversationActivity(input) {
      const limit = bounded(input.limit);
      // Millisecond precision on purpose: PostgreSQL keeps microseconds, a keyset position (a JavaScript Date) carries
      // milliseconds. Ordering and the position compare the SAME truncated value, so rows apart only below the
      // millisecond are ordered by id and are never skipped or repeated between pages.
      const activity = sql`date_trunc('milliseconds', max(coalesce(${interactionRows.providerCreatedAt}, ${interactionRows.firstObservedAt}, ${interactionRows.createdAt})))`;
      const before = input.before;
      const result = await tx.execute<{ conversation_id: string; latest: Date; observed_count: number; placeholder_count: number; any_hidden: boolean; any_removed: boolean }>(sql`
        select ${interactionRows.conversationId} as conversation_id,
               ${activity} as latest,
               count(*) filter (where ${interactionRows.observed})::int as observed_count,
               count(*) filter (where not ${interactionRows.observed})::int as placeholder_count,
               bool_or(${interactionRows.currentVisibility} = 'hidden') as any_hidden,
               bool_or(${interactionRows.currentAvailability} = 'removed_at_source') as any_removed
          from ${interactionRows}
         where ${interactionRows.conversationId} is not null
         group by ${interactionRows.conversationId}
        ${before === null ? sql`` : sql`having (${activity}, ${interactionRows.conversationId}) < (${before.latestActivityAt}, ${before.conversationId}::uuid)`}
         order by 2 desc, 1 desc
         limit ${limit}`);
      return result.rows.map((row): ConversationActivityRow => ({
        conversationId: row.conversation_id,
        latestActivityAt: new Date(row.latest),
        observedCount: row.observed_count,
        placeholderCount: row.placeholder_count,
        anyHidden: row.any_hidden,
        anyRemovedAtSource: row.any_removed,
      }));
    },
    async summaries(interactionIds) {
      if (interactionIds.length === 0) return [];
      return summaryQuery().where(inArray(interactionRows.id, [...new Set(interactionIds)].slice(0, MAX_LIMIT)));
    },
    async thread(conversationId, limit) {
      return summaryQuery()
        .where(eq(interactionRows.conversationId, conversationId))
        .orderBy(sql`${interactionRows.providerCreatedAt} asc nulls last`, asc(interactionRows.firstObservedAt), asc(interactionRows.id))
        .limit(bounded(limit));
    },
    async textVersions(interactionIds, newestPerInteraction) {
      if (!Number.isInteger(newestPerInteraction) || newestPerInteraction < 1 || newestPerInteraction > MAX_VERSIONS_PER_INTERACTION) throw new RangeError("interactions read: versions per interaction out of bounds");
      const ids = [...new Set(interactionIds)].filter((id) => UUID.test(id)).slice(0, MAX_LIMIT);
      if (ids.length === 0) return [];
      // Newest N per interaction (a window per interaction, never a global cap), then oldest first for the reader.
      const result = await tx.execute<{ id: string; interaction_id: string; source_text: string; provider_edited_at: Date | null; observed_at: Date }>(sql`
        select id, interaction_id, source_text, provider_edited_at, observed_at
          from (select ${sourceTextVersions.id} as id, ${sourceTextVersions.interactionId} as interaction_id, ${sourceTextVersions.sourceText} as source_text,
                       ${sourceTextVersions.providerEditedAt} as provider_edited_at, ${sourceTextVersions.observedAt} as observed_at,
                       row_number() over (partition by ${sourceTextVersions.interactionId} order by ${sourceTextVersions.observedAt} desc, ${sourceTextVersions.id} desc) as newest_rank
                  from ${sourceTextVersions}
                 where ${sourceTextVersions.interactionId} in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})) ranked
         where newest_rank <= ${newestPerInteraction}
         order by observed_at asc, id asc`);
      return result.rows.map((row): TextVersionRow => ({
        id: row.id,
        interactionId: row.interaction_id,
        sourceText: row.source_text,
        providerEditedAt: row.provider_edited_at === null ? null : new Date(row.provider_edited_at),
        observedAt: new Date(row.observed_at),
      }));
    },
  };
}
