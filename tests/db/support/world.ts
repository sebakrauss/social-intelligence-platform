/**
 * Synthetic tenant world for the isolation suites (TEST BOOTSTRAP, privileged connection). Fresh random
 * IDs per run, so concurrent or repeated runs against a shared development database never collide, and
 * cleanup deletes exactly this run's rows. No real users, emails or content.
 *
 *   Organization A ── Workspace A1 (3 conversations · 3 interactions · 1 guest projection)
 *                  └─ Workspace A2 (same)
 *   Organization B ── Workspace B1 (same)
 *
 *   ownerA   Org A OWNER · A1 OWNER · A2 OWNER        ownerB  Org B OWNER · B1 OWNER
 *   a1       Org A MEMBER · A1 MANAGER                 b1      Org B MEMBER · B1 MANAGER
 *   a12      Org A MEMBER · A1 RESPONDER · A2 MANAGER  guest   Org A MEMBER · A1 CLIENT_GUEST
 *   orgOnly  Org A MEMBER, no workspace membership     none    no memberships at all
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";

export interface World {
  readonly orgA: string;
  readonly orgB: string;
  readonly A1: string;
  readonly A2: string;
  readonly B1: string;
  readonly users: {
    readonly ownerA: string;
    readonly ownerB: string;
    readonly a1: string;
    readonly a12: string;
    readonly b1: string;
    readonly guest: string;
    readonly orgOnly: string;
    readonly none: string;
  };
  readonly conversations: Readonly<Record<string, readonly string[]>>;
  readonly interactions: Readonly<Record<string, readonly string[]>>;
}

export async function seedWorld(privileged: pg.Pool): Promise<World> {
  const world: World = {
    orgA: randomUUID(),
    orgB: randomUUID(),
    A1: randomUUID(),
    A2: randomUUID(),
    B1: randomUUID(),
    users: {
      ownerA: randomUUID(),
      ownerB: randomUUID(),
      a1: randomUUID(),
      a12: randomUUID(),
      b1: randomUUID(),
      guest: randomUUID(),
      orgOnly: randomUUID(),
      none: randomUUID(),
    },
    conversations: {},
    interactions: {},
  };
  const { orgA, orgB, A1, A2, B1, users: u } = world;
  const conversations: Record<string, string[]> = {};
  const interactions: Record<string, string[]> = {};

  const client = await privileged.connect();
  try {
    await client.query("begin");
    const now = new Date();
    await client.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Organization A', $3), ($2, 'Organization B', $3)", [orgA, orgB, now]);
    await client.query(
      "insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $4, 'A1', 'STANDARD', $6), ($2, $4, 'A2', 'STANDARD', $6), ($3, $5, 'B1', 'STANDARD', $6)",
      [A1, A2, B1, orgA, orgB, now],
    );
    const orgMembers: [string, string, string][] = [
      [orgA, u.ownerA, "OWNER"], [orgA, u.a1, "MEMBER"], [orgA, u.a12, "MEMBER"], [orgA, u.guest, "MEMBER"], [orgA, u.orgOnly, "MEMBER"],
      [orgB, u.ownerB, "OWNER"], [orgB, u.b1, "MEMBER"],
    ];
    for (const [org, user, role] of orgMembers) {
      await client.query("insert into tenancy.organization_memberships (organization_id, user_id, role, created_at) values ($1, $2, $3, $4)", [org, user, role, now]);
    }
    const workspaceMembers: [string, string, string, string][] = [
      [orgA, A1, u.ownerA, "OWNER"], [orgA, A2, u.ownerA, "OWNER"], [orgA, A1, u.a1, "MANAGER"], [orgA, A1, u.a12, "RESPONDER"],
      [orgA, A2, u.a12, "MANAGER"], [orgA, A1, u.guest, "CLIENT_GUEST"], [orgB, B1, u.ownerB, "OWNER"], [orgB, B1, u.b1, "MANAGER"],
    ];
    for (const [org, workspace, user, role] of workspaceMembers) {
      await client.query(
        "insert into tenancy.workspace_memberships (organization_id, workspace_id, user_id, role, grants, created_at) values ($1, $2, $3, $4, '{}', $5)",
        [org, workspace, user, role, now],
      );
    }
    for (const workspace of [A1, A2, B1]) {
      conversations[workspace] = [];
      interactions[workspace] = [];
      for (let n = 1; n <= 3; n += 1) {
        const conversation = randomUUID();
        const interaction = randomUUID();
        await client.query("insert into t26_fixture.conversations (id, workspace_id, title) values ($1, $2, $3)", [conversation, workspace, `synthetic conversation ${String(n)}`]);
        await client.query("insert into t26_fixture.interactions (id, workspace_id, conversation_id, body) values ($1, $2, $3, $4)", [interaction, workspace, conversation, `synthetic comment ${String(n)}`]);
        conversations[workspace].push(conversation);
        interactions[workspace].push(interaction);
      }
      await client.query("insert into t26_fixture.guest_projections (id, workspace_id, statement) values ($1, $2, 'guest-safe statement')", [randomUUID(), workspace]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return { ...world, conversations, interactions };
}

/** Deletes this run's rows only (cascades from the organizations). Never touches roles or schemas (R8). */
export async function cleanupWorld(privileged: pg.Pool, organizationIds: readonly string[]): Promise<void> {
  if (organizationIds.length === 0) return;
  await privileged.query("delete from audit.audit_events where organization_id = any($1::uuid[])", [organizationIds]);
  await privileged.query("delete from system.outbox where organization_id = any($1::uuid[])", [organizationIds]);
  await privileged.query("delete from tenancy.organizations where id = any($1::uuid[])", [organizationIds]);
}
