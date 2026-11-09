/**
 * Inbox read sources (Step 7A): each owner module's READ port over its own tables, composed on the web's user-scoped
 * transaction (0017/0024 member_read: the bound workspace's non-guest members only), plus the managed accounts of that
 * workspace. No write path exists here: the connections store is created only to list connected accounts.
 */
import { createPostgresSignalReadStore } from "@/modules/classification/persistence";
import { createPostgresConnectionStore } from "@/modules/connections/persistence";
import { createPostgresContentItemReadStore } from "@/modules/content/persistence";
import { createPostgresConversationReadStore } from "@/modules/conversations/persistence";
import { createPostgresCoverageReadStore } from "@/modules/coverage/persistence";
import { createPostgresInteractionReadStore } from "@/modules/interactions/persistence";
import type { DatabaseTransaction } from "@/platform/db";
import type { InboxReadSources } from "@/server/pipeline";

export function inboxReadSources(tx: DatabaseTransaction): InboxReadSources {
  const connections = createPostgresConnectionStore(tx);
  return {
    conversations: createPostgresConversationReadStore(tx),
    interactions: createPostgresInteractionReadStore(tx),
    content: createPostgresContentItemReadStore(tx),
    coverage: createPostgresCoverageReadStore(tx),
    signals: createPostgresSignalReadStore(tx),
    accounts: async () => (await connections.connectedAccounts.list()).map((account) => ({ id: account.id, platform: account.platform, status: account.status })),
  };
}
