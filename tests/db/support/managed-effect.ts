/** The durable domain effect written by the managed Trigger.dev test task (synthetic fixture row; no content). */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DatabaseTransaction } from "@/platform/db";

export async function recordManagedEffect(tx: DatabaseTransaction, workspaceId: string, itemId: string): Promise<void> {
  await tx.execute(sql`insert into t26_fixture.conversations (id, workspace_id, title) values (${randomUUID()}, ${workspaceId}, ${`managed effect ${itemId}`})`);
}
