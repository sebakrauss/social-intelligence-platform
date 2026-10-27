/**
 * The organization of the workspace the transaction is bound to (Step H6-B), through the reviewed 0005 definer
 * `app.current_workspace_organization()`: undefined when no workspace is bound (or it does not exist) — callers fail
 * closed. Reads no tenant table directly and accepts no workspace argument: the sealed binding is the only input.
 */
import { sql } from "drizzle-orm";
import type { DatabaseTransaction } from "@/platform/db";

export async function boundWorkspaceOrganization(tx: DatabaseTransaction): Promise<string | undefined> {
  const result = await tx.execute<{ organization_id: string | null }>(sql`select app.current_workspace_organization() as organization_id`);
  return result.rows[0]?.organization_id ?? undefined;
}
