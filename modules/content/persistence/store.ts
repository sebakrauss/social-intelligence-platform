/**
 * Content item persistence (Step H6-B). Runs inside the caller's workspace-scoped transaction (RLS binds the workspace);
 * the canonical row is unique per (workspace, platform, provider content id), and its account, platform and asset are
 * fixed at creation (no UPDATE grant on them).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DatabaseTransaction } from "@/platform/db";
import type { ContentItemReadStore, ContentItemStore } from "../application/ports";
import { contentItems } from "./tables";




const columns = {
  id: contentItems.id,
  platform: contentItems.platform,
  connectedAccountId: contentItems.connectedAccountId,
  providerAssetId: contentItems.providerAssetId,
  providerContentId: contentItems.providerContentId,
  contentKind: contentItems.contentKind,
  reportedSource: contentItems.reportedSource,
  latestObservedAt: contentItems.latestObservedAt,
};

export function createPostgresContentItemStore(tx: DatabaseTransaction): ContentItemStore {
  return {
    async findByProviderId(platform, providerContentId) {
      const rows = await tx
        .select(columns)
        .from(contentItems)
        .where(and(eq(contentItems.platform, platform), eq(contentItems.providerContentId, providerContentId)))
        .limit(1);
      return rows[0];
    },
    async findById(id) {
      const rows = await tx.select(columns).from(contentItems).where(eq(contentItems.id, id)).limit(1);
      return rows[0];
    },
    async insert(item) {
      await tx.insert(contentItems).values({
        id: item.id,
        organizationId: item.organizationId,
        workspaceId: item.workspaceId,
        platform: item.platform,
        connectedAccountId: item.connectedAccountId,
        providerAssetId: item.providerAssetId,
        providerContentId: item.providerContentId,
        contentKind: item.contentKind,
        reportedSource: item.reportedSource,
        sourceState: "available",
        firstObservedAt: item.observedAt,
        latestObservedAt: item.observedAt,
        createdAt: item.observedAt,
        updatedAt: item.observedAt,
      });
    },
    async noteObserved(id, observedAt) {
      await tx
        .update(contentItems)
        .set({ latestObservedAt: observedAt, updatedAt: observedAt })
        .where(and(eq(contentItems.id, id), sql`${contentItems.latestObservedAt} < ${observedAt}`));
    },
  };
}

/** Step 7A: read-only; RLS (0017 member_read) admits the bound workspace's non-guest members only. */
export function createPostgresContentItemReadStore(tx: DatabaseTransaction): ContentItemReadStore {
  return {
    async findManyById(ids) {
      if (ids.length === 0) return [];
      return tx.select(columns).from(contentItems).where(inArray(contentItems.id, [...new Set(ids)].slice(0, 500)));
    },
  };
}
