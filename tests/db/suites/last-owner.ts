/**
 * T-26 case 28 — the last-Owner invariant survives concurrent transactions (organization and workspace).
 *
 * Mechanism under test (db/migrations/0002_tenancy.sql): demoting or removing an Owner takes a
 * transaction-scoped advisory lock keyed by the organization/workspace and re-counts the other Owners.
 * Two transactions are interleaved deterministically: T1 demotes/removes Owner 1 and stays open; T2 tries
 * the same for Owner 2 and blocks on the lock (observed in pg_locks); T1 commits; T2 must be refused.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";
import { sqlState } from "./helpers";

interface OwnedTenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly owners: readonly [string, string];
}

async function seedTenant(privileged: pg.Pool): Promise<OwnedTenant> {
  const tenant: OwnedTenant = { organizationId: randomUUID(), workspaceId: randomUUID(), owners: [randomUUID(), randomUUID()] };
  const client = await privileged.connect();
  try {
    await client.query("begin");
    await client.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Owners', now())", [tenant.organizationId]);
    await client.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'STANDARD', now())", [tenant.workspaceId, tenant.organizationId]);
    for (const owner of tenant.owners) {
      await client.query("insert into tenancy.organization_memberships values ($1, $2, 'OWNER', now())", [tenant.organizationId, owner]);
      await client.query("insert into tenancy.workspace_memberships values ($1, $2, $3, 'OWNER', '{}', now())", [tenant.organizationId, tenant.workspaceId, owner]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return tenant;
}

async function waitForBlockedAdvisoryLock(privileged: pg.Pool): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const waiting = await privileged.query<{ n: number }>("select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted");
    if ((waiting.rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("second transaction never blocked on the owner lock");
}

export function defineLastOwnerConcurrencySuite(getTarget: () => DbTarget): void {
  let target: DbTarget;
  let privileged: pg.Pool;
  let first: RuntimeDatabase<"web">;
  let second: RuntimeDatabase<"web">;
  const organizations: string[] = [];

  beforeAll(() => {
    target = getTarget();
    privileged = privilegedPool(target, 3);
    first = runtimeDatabase(target, "web", 1);
    second = runtimeDatabase(target, "web", 1);
  });

  afterAll(async () => {
    await Promise.all([first.end(), second.end()]);
    await cleanupWorld(privileged, organizations);
    await privileged.end();
  });

  const tenant = async (): Promise<OwnedTenant> => {
    const seeded = await seedTenant(privileged);
    organizations.push(seeded.organizationId);
    return seeded;
  };

  /** Runs `firstWork` and holds its transaction open until `secondWork` is blocked, then commits it. */
  async function race(
    user1: string,
    user2: string,
    workspace: string | undefined,
    firstWork: (tx: DatabaseTransaction) => Promise<unknown>,
    secondWork: (tx: DatabaseTransaction) => Promise<unknown>,
  ): Promise<{ readonly second: Promise<unknown> }> {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let changed: () => void = () => undefined;
    const firstChanged = new Promise<void>((resolve) => (changed = resolve));
    const t1 = withUserScope(first, { sub: user1 }, workspace, async (tx) => {
      await firstWork(tx);
      changed();
      await gate;
    });
    await firstChanged;
    const t2 = withUserScope(second, { sub: user2 }, workspace, secondWork);
    t2.catch(() => undefined);
    await waitForBlockedAdvisoryLock(privileged);
    release();
    await t1;
    return { second: t2 };
  }

  const owners = async (table: "workspace_memberships" | "organization_memberships", column: string, id: string) =>
    (await privileged.query<{ user_id: string }>(`select user_id::text from tenancy.${table} where ${column} = $1 and role = 'OWNER'`, [id])).rows.map((row) => row.user_id);

  describe("T-26 · 28 · last-Owner invariant under concurrency", () => {
    it("two concurrent workspace Owner demotions can't leave the workspace without an Owner", async () => {
      const t = await tenant();
      const [o1, o2] = t.owners;
      const demote = (user: string) => (tx: DatabaseTransaction) =>
        tx.execute(sql`update tenancy.workspace_memberships set role = 'ADMIN' where workspace_id = ${t.workspaceId} and user_id = ${user}`);
      const { second: t2 } = await race(o1, o2, t.workspaceId, demote(o1), demote(o2));
      expect(await sqlState(t2)).toEqual({ code: "23514", constraint: "workspace_keeps_an_owner" });
      expect(await owners("workspace_memberships", "workspace_id", t.workspaceId)).toEqual([o2]);
    });

    it("two concurrent workspace Owner removals can't leave the workspace without an Owner", async () => {
      const t = await tenant();
      const [o1, o2] = t.owners;
      const remove = (user: string) => (tx: DatabaseTransaction) =>
        tx.execute(sql`delete from tenancy.workspace_memberships where workspace_id = ${t.workspaceId} and user_id = ${user}`);
      const { second: t2 } = await race(o1, o2, t.workspaceId, remove(o1), remove(o2));
      expect(await sqlState(t2)).toEqual({ code: "23514", constraint: "workspace_keeps_an_owner" });
      expect(await owners("workspace_memberships", "workspace_id", t.workspaceId)).toEqual([o2]);
    });

    it("two concurrent organization Owner demotions can't leave the organization without an Owner", async () => {
      const t = await tenant();
      const [o1, o2] = t.owners;
      const demote = (user: string) => (tx: DatabaseTransaction) =>
        tx.execute(sql`update tenancy.organization_memberships set role = 'MEMBER' where organization_id = ${t.organizationId} and user_id = ${user}`);
      const { second: t2 } = await race(o1, o2, undefined, demote(o1), demote(o2));
      expect(await sqlState(t2)).toEqual({ code: "23514", constraint: "organization_keeps_an_owner" });
      expect(await owners("organization_memberships", "organization_id", t.organizationId)).toEqual([o2]);
    });

    it("a concurrent demotion and removal in one organization can't leave it without an Owner", async () => {
      const t = await tenant();
      const [o1, o2] = t.owners;
      // Workspace memberships reference organization membership; demote-vs-remove is exercised on the workspace.
      const { second: t2 } = await race(
        o1,
        o2,
        t.workspaceId,
        (tx) => tx.execute(sql`delete from tenancy.workspace_memberships where workspace_id = ${t.workspaceId} and user_id = ${o1}`),
        (tx) => tx.execute(sql`update tenancy.workspace_memberships set role = 'MANAGER' where workspace_id = ${t.workspaceId} and user_id = ${o2}`),
      );
      expect((await sqlState(t2)).constraint).toBe("workspace_keeps_an_owner");
      expect(await owners("workspace_memberships", "workspace_id", t.workspaceId)).toEqual([o2]);
    });

    it("an unrelated workspace never waits on another workspace's owner lock (no table lock)", async () => {
      const busy = await tenant();
      const other = await tenant();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let changed: () => void = () => undefined;
      const firstChanged = new Promise<void>((resolve) => (changed = resolve));
      const holder = withUserScope(first, { sub: busy.owners[0] }, busy.workspaceId, async (tx) => {
        await tx.execute(sql`update tenancy.workspace_memberships set role = 'ADMIN' where workspace_id = ${busy.workspaceId} and user_id = ${busy.owners[0]}`);
        changed();
        await gate;
      });
      await firstChanged;
      await withUserScope(second, { sub: other.owners[0] }, other.workspaceId, (tx) =>
        tx.execute(sql`update tenancy.workspace_memberships set role = 'ADMIN' where workspace_id = ${other.workspaceId} and user_id = ${other.owners[0]}`));
      release();
      await holder;
      expect(await owners("workspace_memberships", "workspace_id", other.workspaceId)).toEqual([other.owners[1]]);
    });

    it("ownership transfer still works: promote another Owner first, then step down", async () => {
      const t = await tenant();
      const [o1, o2] = t.owners;
      await withUserScope(first, { sub: o2 }, t.workspaceId, (tx) =>
        tx.execute(sql`update tenancy.workspace_memberships set role = 'ADMIN' where workspace_id = ${t.workspaceId} and user_id = ${o2}`));
      const lastStepDown = withUserScope(first, { sub: o1 }, t.workspaceId, (tx) =>
        tx.execute(sql`update tenancy.workspace_memberships set role = 'ADMIN' where workspace_id = ${t.workspaceId} and user_id = ${o1}`));
      expect((await sqlState(lastStepDown)).constraint).toBe("workspace_keeps_an_owner");
      await withUserScope(first, { sub: o1 }, t.workspaceId, async (tx) => {
        await tx.execute(sql`update tenancy.workspace_memberships set role = 'OWNER' where workspace_id = ${t.workspaceId} and user_id = ${o2}`);
        await tx.execute(sql`update tenancy.workspace_memberships set role = 'ADMIN' where workspace_id = ${t.workspaceId} and user_id = ${o1}`);
      });
      expect(await owners("workspace_memberships", "workspace_id", t.workspaceId)).toEqual([o2]);
    });
  });
}
