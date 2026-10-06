/**
 * Step 5B — connections and credential foundation (migration 0007) on the real database, through the real
 * runtime roles (web login → authenticated + claims + sealed workspace; worker login → app_worker + sealed
 * workspace; system login → app_system). Synthetic data only.
 *
 *   isolation     every Step 5B table: other workspace / other organization / unbound / guest / system → nothing
 *   credentials   no table privilege for any runtime role; definer API: web stores (Owner/Admin), worker loads
 *                 (bound workspace only), shred is workspace-bound; envelope bytes only; plaintext never stored;
 *                 the active pointer can't cross connection or workspace; 5A open fails under another workspace
 *   M-01          content-bearing asset: one ACTIVE workspace per organization (index name asserted)
 *   TA-Q-02       TEMPORARY ad-account rule: separate index, separately droppable, cross-organization independent
 *   moves         side/status shape, same-organization counterpart, one REQUESTED incoming per asset
 *   attempts      state digest only, PKCE only as an envelope (paired, cleared on close), TTL bound
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withUserScope, withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { withSystemScope } from "@/platform/db/system-scope";
import { credentialContext } from "@/platform/crypto/credentials/context";
import { decodeEnvelope, encodeEnvelope } from "@/platform/crypto/credentials/envelope";
import { CredentialCryptoError } from "@/platform/crypto/credentials/errors";
import { createLocalKeyring, type LocalKeyring } from "@/platform/crypto/credentials/local-keyring";
import { createCredentialOpener } from "@/platform/crypto/credentials/open";
import { createCredentialSealer } from "@/platform/crypto/credentials/seal";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES } from "@/modules/audit";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld, seedWorld, type World } from "../support/world";
import { count, sqlState } from "./helpers";

const STEP5B_TABLES = [
  "connections.connections",
  "connections.connection_events",
  "connections.connect_attempts",
  "connections.discovered_assets",
  "connections.connected_accounts",
  "connections.connected_account_events",
  "connections.asset_moves",
] as const;

const MARKER = `SIP-SYNTHETIC-PROVIDER-TOKEN-${randomUUID()}`;
const REDIRECT = "https://app.example.test/api/connections/callback/simulator";
const digest = (): string => createHash("sha256").update(randomBytes(32)).digest("hex");

export function defineConnectionsSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let system: RuntimeDatabase<"system">;
  let world: World;
  let keyring: LocalKeyring;

  const asUser = <T>(user: string, workspace: string | undefined, work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> =>
    withUserScope(web, { sub: user, role: "authenticated" }, workspace, work);
  const asWorker = <T>(workspace: string, work: (tx: DatabaseTransaction) => Promise<T>): Promise<T> => withWorkspaceJobScope(worker, workspace, work);
  const orgOf = (workspace: string): string => (workspace === world.B1 ? world.orgB : world.orgA);
  const ownerOf = (workspace: string): string => (workspace === world.B1 ? world.users.ownerB : world.users.ownerA);

  /** Seals the synthetic marker with the 5A boundary under (workspace, credential) and returns the v1 bytes. */
  const sealFor = async (workspace: string, credential: string): Promise<Buffer> => {
    const envelope = await createCredentialSealer(keyring.generator).seal(
      new Uint8Array(Buffer.from(MARKER, "utf8")),
      credentialContext({ purpose: "provider-credential", env: "test", workspaceId: workspace, credentialId: credential }),
    );
    return Buffer.from(encodeEnvelope(envelope));
  };

  const insertConnection = (workspace: string, status = "CONNECTING"): Promise<string> => {
    const id = randomUUID();
    const user = ownerOf(workspace);
    return asUser(user, workspace, async (tx) => {
      await tx.execute(sql`insert into connections.connections
        (id, organization_id, workspace_id, provider, status, authorized_by, authorized_at, created_at, updated_at)
        values (${id}, ${orgOf(workspace)}, ${workspace}, 'simulator', ${status}, ${user}, now(), now(), now())`);
      return id;
    });
  };

  const storeCredential = async (workspace: string, connection: string, version = 1, activate = true): Promise<string> => {
    const credential = randomUUID();
    const envelope = await sealFor(workspace, credential);
    await asUser(ownerOf(workspace), workspace, async (tx) => {
      await tx.execute(sql`select credentials.store_envelope(${connection}::uuid, ${credential}::uuid, ${version}::int, ${envelope}::bytea, null)`);
      if (activate) await tx.execute(sql`update connections.connections set active_credential_id = ${credential} where id = ${connection}`);
    });
    return credential;
  };

  const discover = (workspace: string, connection: string, assetId: string, assetClass: "content_bearing" | "ad_account", platform = "facebook"): Promise<void> =>
    asWorker(workspace, async (tx) => {
      await tx.execute(sql`insert into connections.discovered_assets
        (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
        values (${randomUUID()}, ${orgOf(workspace)}, ${workspace}, ${connection}, ${platform}, ${assetId}, ${assetClass}, 'Synthetic asset', now(), now(), now())`);
    });

  const link = (workspace: string, connection: string, assetId: string, assetClass: string, platform = "facebook"): Promise<string> => {
    const id = randomUUID();
    return asUser(ownerOf(workspace), workspace, async (tx) => {
      await tx.execute(sql`insert into connections.connected_accounts
        (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
        values (${id}, ${orgOf(workspace)}, ${workspace}, ${connection}, ${platform}, ${assetId}, ${assetClass}, 'ACTIVE', now(), now(), now())`);
      return id;
    });
  };

  // One complete chain per workspace, written through the runtime roles (policies exercised on the way).
  const chains: Record<string, { connection: string; credential: string; account: string }> = {};

  beforeAll(async () => {
    const target = getTarget();
    privileged = privilegedPool(target);
    web = runtimeDatabase(target, "web", 1);
    worker = runtimeDatabase(target, "worker", 1);
    system = runtimeDatabase(target, "system", 1);
    world = await seedWorld(privileged);
    keyring = createLocalKeyring(randomBytes(32), { NODE_ENV: "test" });

    for (const workspace of [world.A1, world.A2, world.B1]) {
      const connection = await insertConnection(workspace);
      const credential = await storeCredential(workspace, connection);
      await discover(workspace, connection, `chain_asset_${workspace.slice(0, 8)}`, "content_bearing");
      const account = await link(workspace, connection, `chain_asset_${workspace.slice(0, 8)}`, "content_bearing");
      await asUser(ownerOf(workspace), workspace, async (tx) => {
        await tx.execute(sql`insert into connections.connection_events
          (id, organization_id, workspace_id, connection_id, previous_status, new_status, reason_code, actor_type, actor_user_id, occurred_at)
          values (${randomUUID()}, ${orgOf(workspace)}, ${workspace}, ${connection}, null, 'CONNECTING', 'AUTHORIZED', 'user', ${ownerOf(workspace)}, now())`);
        await tx.execute(sql`insert into connections.connect_attempts
          (id, organization_id, workspace_id, provider, created_by, state_digest, redirect_uri, status, expires_at, created_at)
          values (${randomUUID()}, ${orgOf(workspace)}, ${workspace}, 'simulator', ${ownerOf(workspace)}, ${digest()}, ${REDIRECT}, 'PENDING', now() + interval '10 minutes', now())`);
        await tx.execute(sql`insert into connections.connected_account_events
          (id, organization_id, workspace_id, connected_account_id, event_type, reason_code, actor_type, actor_user_id, occurred_at)
          values (${randomUUID()}, ${orgOf(workspace)}, ${workspace}, ${account}, 'LINKED', 'USER_LINKED', 'user', ${ownerOf(workspace)}, now())`);
      });
      chains[workspace] = { connection, credential, account };
    }
    // Move rows: incoming in A1 (counterpart A2) by the Owner; outgoing in A2 (counterpart A1) by the worker.
    const moveId = randomUUID();
    await asUser(world.users.ownerA, world.A1, (tx) =>
      tx.execute(sql`insert into connections.asset_moves
        (organization_id, workspace_id, move_id, side, counterpart_workspace_id, connection_id, platform, provider_asset_id, initiator_user_id, status, created_at, updated_at)
        values (${world.orgA}, ${world.A1}, ${moveId}, 'INCOMING', ${world.A2}, ${chains[world.A1]?.connection ?? ""}, 'facebook', 'chain_moved_asset', ${world.users.ownerA}, 'REQUESTED', now(), now())`));
    await asWorker(world.A2, (tx) =>
      tx.execute(sql`insert into connections.asset_moves
        (organization_id, workspace_id, move_id, side, counterpart_workspace_id, connected_account_id, platform, initiator_user_id, status, created_at, updated_at)
        values (${world.orgA}, ${world.A2}, ${moveId}, 'OUTGOING', ${world.A1}, ${chains[world.A2]?.account ?? ""}, 'facebook', ${world.users.ownerA}, 'RELEASED', now(), now())`));
  });

  afterAll(async () => {
    keyring.destroy();
    await cleanupWorld(privileged, [world.orgA, world.orgB]);
    await Promise.all([web.end(), worker.end(), system.end()]);
    await privileged.end();
  });

  describe("isolation of every Step 5B table", () => {
    it("the Owner reads exactly the bound workspace's rows (and the move row of that side)", async () => {
      for (const table of STEP5B_TABLES) {
        const own = await asUser(world.users.ownerA, world.A1, (tx) => count(tx, table, sql`workspace_id = ${world.A1}`));
        const total = await asUser(world.users.ownerA, world.A1, (tx) => count(tx, table));
        expect(own, table).toBeGreaterThan(0);
        expect(total, `${table}: only the bound workspace`).toBe(own);
      }
    });

    it("another organization, another workspace of the same organization, and an unbound user see nothing of A1", async () => {
      for (const table of STEP5B_TABLES) {
        const where = sql`workspace_id = ${world.A1}`;
        expect(await asUser(world.users.ownerB, world.B1, (tx) => count(tx, table, where)), `${table} ownerB@B1`).toBe(0);
        expect(await asUser(world.users.ownerA, world.A2, (tx) => count(tx, table, where)), `${table} ownerA@A2`).toBe(0);
        expect(await asUser(world.users.ownerA, undefined, (tx) => count(tx, table)), `${table} unbound`).toBe(0);
        expect(await asUser(world.users.orgOnly, world.A1, (tx) => count(tx, table)), `${table} org-only member`).toBe(0);
      }
    });

    it("Client Guests read none of these operational tables", async () => {
      for (const table of STEP5B_TABLES) {
        expect(await asUser(world.users.guest, world.A1, (tx) => count(tx, table)), table).toBe(0);
      }
    });

    it("non-guest members read operational rows; connect attempts stay creator-only (Owner/Admin)", async () => {
      expect(await asUser(world.users.a1, world.A1, (tx) => count(tx, "connections.connections"))).toBeGreaterThan(0);
      expect(await asUser(world.users.a12, world.A1, (tx) => count(tx, "connections.connected_accounts"))).toBeGreaterThan(0);
      expect(await asUser(world.users.a1, world.A1, (tx) => count(tx, "connections.connect_attempts"))).toBe(0);
    });

    it("a worker sees only its bound workspace", async () => {
      for (const table of STEP5B_TABLES.filter((t) => t !== "connections.connect_attempts")) {
        const own = await asWorker(world.A1, (tx) => count(tx, table, sql`workspace_id = ${world.A1}`));
        const total = await asWorker(world.A1, (tx) => count(tx, table));
        expect(total, table).toBe(own);
        expect(await asWorker(world.B1, (tx) => count(tx, table, sql`workspace_id = ${world.A1}`)), table).toBe(0);
      }
      // connect attempts are web-only: the worker has no privilege at all.
      expect((await sqlState(asWorker(world.A1, (tx) => count(tx, "connections.connect_attempts")))).code).toBe("42501");
    });

    it("the system role reaches no Step 5B schema", async () => {
      for (const table of [...STEP5B_TABLES, "credentials.provider_credentials"]) {
        expect((await sqlState(withSystemScope(system, (tx) => count(tx, table)))).code, table).toBe("42501");
      }
    });
  });

  describe("write authority", () => {
    it("only Owners/Admins of the bound workspace create connections, as themselves, in CONNECTING", async () => {
      const insert = (user: string, workspace: string, values: { workspace?: string; status?: string; authorizedBy?: string }) =>
        asUser(user, workspace, (tx) =>
          tx.execute(sql`insert into connections.connections
            (id, organization_id, workspace_id, provider, status, authorized_by, authorized_at, created_at, updated_at)
            values (${randomUUID()}, ${world.orgA}, ${values.workspace ?? workspace}, 'simulator', ${values.status ?? "CONNECTING"},
                    ${values.authorizedBy ?? user}, now(), now(), now())`));
      expect((await sqlState(insert(world.users.a1, world.A1, {}))).code).toBe("42501");
      expect((await sqlState(insert(world.users.guest, world.A1, {}))).code).toBe("42501");
      expect((await sqlState(insert(world.users.ownerA, world.A1, { status: "ACTIVE" }))).code).toBe("42501");
      expect((await sqlState(insert(world.users.ownerA, world.A1, { authorizedBy: world.users.a1 }))).code).toBe("42501");
      expect((await sqlState(insert(world.users.ownerA, world.A1, { workspace: world.A2 }))).code).toBe("42501");
    });

    it("history tables are append-only for every runtime role", async () => {
      for (const table of ["connections.connection_events", "connections.connected_account_events"]) {
        expect((await sqlState(asWorker(world.A1, (tx) => tx.execute(sql`update ${sql.raw(table)} set occurred_at = now()`)))).code, table).toBe("42501");
        expect((await sqlState(asUser(world.users.ownerA, world.A1, (tx) => tx.execute(sql`delete from ${sql.raw(table)}`)))).code, table).toBe("42501");
      }
    });

    it("closed vocabularies reject free text (no raw provider errors)", async () => {
      const connection = chains[world.A1]?.connection ?? "";
      expect((await sqlState(asWorker(world.A1, (tx) =>
        tx.execute(sql`update connections.connections set last_problem_code = 'Error: token xyz rejected', last_problem_at = now() where id = ${connection}`))))
        .code).toBe("23514");
      expect((await sqlState(asWorker(world.A1, (tx) =>
        tx.execute(sql`update connections.connections set status = 'BROKEN' where id = ${connection}`)))).code).toBe("23514");
    });
  });

  describe("credentials (T-21 foundation)", () => {
    it("no runtime role holds any privilege on the credential table", async () => {
      const table = "credentials.provider_credentials";
      expect((await sqlState(asUser(world.users.ownerA, world.A1, (tx) => count(tx, table)))).code).toBe("42501");
      expect((await sqlState(asWorker(world.A1, (tx) => count(tx, table)))).code).toBe("42501");
      expect((await sqlState(asUser(world.users.ownerA, world.A1, (tx) => tx.execute(sql`delete from credentials.provider_credentials`)))).code).toBe("42501");
    });

    it("store: Owner/Admin of the bound workspace only, into that workspace's connections only, envelope bytes only", async () => {
      const { connection } = chains[world.A1] ?? { connection: "" };
      const store = (user: string, workspace: string | undefined, target: string, bytes: Buffer, version: number) =>
        asUser(user, workspace, (tx) => tx.execute(sql`select credentials.store_envelope(${target}::uuid, ${randomUUID()}::uuid, ${version}::int, ${bytes}::bytea, null)`));
      const sealed = await sealFor(world.A1, randomUUID());
      expect((await sqlState(store(world.users.a1, world.A1, connection, sealed, 7))).code).toBe("42501");
      expect((await sqlState(store(world.users.guest, world.A1, connection, sealed, 7))).code).toBe("42501");
      expect((await sqlState(store(world.users.ownerA, undefined, connection, sealed, 7))).code).toBe("42501");
      expect((await sqlState(store(world.users.ownerA, world.A1, chains[world.A2]?.connection ?? "", sealed, 7))).code).toBe("P0002");
      expect((await sqlState(store(world.users.ownerA, world.A1, randomUUID(), sealed, 7))).code).toBe("P0002");
      expect((await sqlState(store(world.users.ownerA, world.A1, connection, Buffer.from(MARKER, "utf8"), 7))).code).toBe("23514");
      expect((await sqlState(store(world.users.ownerA, world.A1, connection, sealed, 1))).code).toBe("23505");
      await store(world.users.ownerA, world.A1, connection, sealed, 7);
    });

    it("load: the job runtime of the bound workspace only; the web can't even call it", async () => {
      const { credential } = chains[world.A1] ?? { credential: "" };
      const load = (workspace: string) => asWorker(workspace, async (tx) =>
        (await tx.execute<{ envelope: Buffer }>(sql`select envelope from credentials.load_envelope(${credential}::uuid)`)).rows);
      expect(await load(world.A1)).toHaveLength(1);
      expect(await load(world.A2)).toEqual([]);
      expect(await load(world.B1)).toEqual([]);
      expect((await sqlState(asUser(world.users.ownerA, world.A1, (tx) =>
        tx.execute(sql`select * from credentials.load_envelope(${credential}::uuid)`)))).code).toBe("42501");
    });

    it("the stored envelope opens only under its own workspace and credential (5A boundary, end to end)", async () => {
      const { credential } = chains[world.A1] ?? { credential: "" };
      const [row] = await asWorker(world.A1, async (tx) =>
        (await tx.execute<{ envelope: Buffer }>(sql`select envelope from credentials.load_envelope(${credential}::uuid)`)).rows);
      const envelope = decodeEnvelope(new Uint8Array(row?.envelope ?? Buffer.alloc(0)));
      const opener = createCredentialOpener(keyring.unwrapper);
      const context = (workspace: string, id = credential) => credentialContext({ purpose: "provider-credential", env: "test", workspaceId: workspace, credentialId: id });
      expect(await opener.open(envelope, context(world.A1), (p) => Buffer.from(p).toString("utf8"))).toBe(MARKER);
      for (const wrong of [context(world.A2), context(world.A1, randomUUID())]) {
        const error = await opener.open(envelope, wrong, () => 0).then(() => undefined, (e: unknown) => e);
        expect(error).toBeInstanceOf(CredentialCryptoError);
        expect((error as CredentialCryptoError).code).toBe("INTEGRITY_FAILURE");
      }
    });

    it("the synthetic plaintext never appears anywhere in the Step 5B data", async () => {
      const markerHex = Buffer.from(MARKER, "utf8").toString("hex");
      for (const table of [...STEP5B_TABLES, "credentials.provider_credentials"]) {
        const rows = (await privileged.query<{ row: string }>(`select row_to_json(t)::text as row from ${table} t`)).rows.map((r) => r.row).join("\n");
        expect(rows.includes(MARKER), table).toBe(false);
        expect(rows.toLowerCase().includes(markerHex), table).toBe(false);
      }
      const envelopes = (await privileged.query<{ envelope: Buffer }>("select envelope from credentials.provider_credentials")).rows;
      expect(envelopes.length).toBeGreaterThan(0);
      for (const { envelope } of envelopes) expect(envelope.includes(Buffer.from(MARKER, "utf8"))).toBe(false);
    });

    it("no existence oracle: identifiers used in another workspace never collide (composite primary keys)", async () => {
      const b1 = chains[world.B1] ?? { connection: "", credential: "" };
      // A1 reuses B1's connection and credential IDs: both succeed, revealing nothing about B1.
      await asUser(world.users.ownerA, world.A1, (tx) => tx.execute(sql`insert into connections.connections
        (id, organization_id, workspace_id, provider, status, authorized_by, authorized_at, created_at, updated_at)
        values (${b1.connection}, ${world.orgA}, ${world.A1}, 'simulator', 'CONNECTING', ${world.users.ownerA}, now(), now(), now())`));
      const envelope = await sealFor(world.A1, b1.credential);
      await asUser(world.users.ownerA, world.A1, (tx) =>
        tx.execute(sql`select credentials.store_envelope(${b1.connection}::uuid, ${b1.credential}::uuid, 1, ${envelope}::bytea, null)`));
      // B1's own credential is untouched and still opens only under B1.
      const [row] = await asWorker(world.B1, async (tx) =>
        (await tx.execute<{ envelope: Buffer }>(sql`select envelope from credentials.load_envelope(${b1.credential}::uuid)`)).rows);
      const opened = await createCredentialOpener(keyring.unwrapper).open(
        decodeEnvelope(new Uint8Array(row?.envelope ?? Buffer.alloc(0))),
        credentialContext({ purpose: "provider-credential", env: "test", workspaceId: world.B1, credentialId: b1.credential }),
        (p) => Buffer.from(p).toString("utf8"));
      expect(opened).toBe(MARKER);
    });

    it("the active pointer can't name another connection's or another workspace's credential", async () => {
      const a1 = chains[world.A1] ?? { connection: "", credential: "" };
      const second = await insertConnection(world.A1);
      const secondCredential = await storeCredential(world.A1, second, 1, false);
      const point = (credential: string) => asUser(world.users.ownerA, world.A1, (tx) =>
        tx.execute(sql`update connections.connections set active_credential_id = ${credential} where id = ${a1.connection}`));
      expect((await sqlState(point(secondCredential))).constraint).toBe("connections_active_credential_same_connection");
      expect((await sqlState(point(chains[world.A2]?.credential ?? ""))).constraint).toBe("connections_active_credential_same_connection");
      expect((await sqlState(point(chains[world.B1]?.credential ?? ""))).constraint).toBe("connections_active_credential_same_connection");
      expect((await sqlState(asUser(world.users.ownerA, world.A1, (tx) =>
        tx.execute(sql`update connections.connections set status = 'REMOVED' where id = ${a1.connection}`)))).constraint).toBe("connections_no_credential_when_gone");
    });

    it("delete (crypto-shred) is workspace-bound and refuses an active credential until the pointer is cleared", async () => {
      const connection = await insertConnection(world.A1);
      const credential = await storeCredential(world.A1, connection);
      const shred = (workspace: string) => asWorker(workspace, async (tx) =>
        (await tx.execute<{ deleted: boolean }>(sql`select credentials.delete_envelope(${credential}::uuid) as deleted`)).rows[0]?.deleted);
      expect(await shred(world.B1)).toBe(false);
      expect(await shred(world.A2)).toBe(false);
      expect((await sqlState(asUser(world.users.a1, world.A1, (tx) => tx.execute(sql`select credentials.delete_envelope(${credential}::uuid)`)))).code).toBe("42501");
      expect((await sqlState(shred(world.A1))).code).toBe("23503");
      const deleted = await asWorker(world.A1, async (tx) => {
        await tx.execute(sql`update connections.connections set active_credential_id = null, status = 'DISCONNECTED' where id = ${connection}`);
        return (await tx.execute<{ deleted: boolean }>(sql`select credentials.delete_envelope(${credential}::uuid) as deleted`)).rows[0]?.deleted;
      });
      expect(deleted).toBe(true);
      expect(await asWorker(world.A1, async (tx) => (await tx.execute(sql`select * from credentials.load_envelope(${credential}::uuid)`)).rows)).toEqual([]);
    });
  });

  describe("M-01 and the TEMPORARY TA-Q-02 rule are distinct", () => {
    const setup = async (assetId: string, assetClass: "content_bearing" | "ad_account") => {
      for (const workspace of [world.A1, world.A2, world.B1]) await discover(workspace, chains[workspace]?.connection ?? "", assetId, assetClass);
    };

    it("M-01: a content-bearing asset is ACTIVE in one workspace per organization; other organizations are independent", async () => {
      await setup("m01_page", "content_bearing");
      const accountA1 = await link(world.A1, chains[world.A1]?.connection ?? "", "m01_page", "content_bearing");
      const conflict = await sqlState(link(world.A2, chains[world.A2]?.connection ?? "", "m01_page", "content_bearing"));
      expect(conflict).toEqual({ code: "23505", constraint: "connected_accounts_m01_active_content_asset" });
      await link(world.B1, chains[world.B1]?.connection ?? "", "m01_page", "content_bearing");
      await asUser(world.users.ownerA, world.A1, (tx) =>
        tx.execute(sql`update connections.connected_accounts set status = 'INACTIVE', deactivated_at = now(), deactivation_reason = 'UNLINKED' where id = ${accountA1}`));
      await link(world.A2, chains[world.A2]?.connection ?? "", "m01_page", "content_bearing");
    });

    it("TA-Q-02 (temporary): an ad account is ACTIVE in one workspace per organization — attributed to its own index", async () => {
      await setup("taq02_ads", "ad_account");
      await link(world.A1, chains[world.A1]?.connection ?? "", "taq02_ads", "ad_account");
      const conflict = await sqlState(link(world.A2, chains[world.A2]?.connection ?? "", "taq02_ads", "ad_account"));
      expect(conflict).toEqual({ code: "23505", constraint: "connected_accounts_taq02_tmp_ad_account_single_workspace" });
      await link(world.B1, chains[world.B1]?.connection ?? "", "taq02_ads", "ad_account");
    });

    it("dropping ONLY the TA-Q-02 index relaxes ad accounts and leaves M-01 intact (rolled back)", async () => {
      await setup("indep_page", "content_bearing");
      await setup("indep_ads", "ad_account");
      const client = await privileged.connect();
      const insert = (workspace: string, assetId: string, assetClass: string) => client.query(
        `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
         values ($1, $2, $3, $4, 'facebook', $5, $6, 'ACTIVE', now(), now(), now())`,
        [randomUUID(), world.orgA, workspace, chains[workspace]?.connection, assetId, assetClass]);
      try {
        await client.query("begin");
        await client.query("drop index connections.connected_accounts_taq02_tmp_ad_account_single_workspace");
        await insert(world.A1, "indep_ads", "ad_account");
        await insert(world.A2, "indep_ads", "ad_account");
        await insert(world.A1, "indep_page", "content_bearing");
        await client.query("savepoint m01");
        const error = await insert(world.A2, "indep_page", "content_bearing").then(() => undefined, (e: unknown) => e as { code?: string; constraint?: string });
        expect(error).toMatchObject({ code: "23505", constraint: "connected_accounts_m01_active_content_asset" });
      } finally {
        await client.query("rollback");
        client.release();
      }
      const indexes = (await privileged.query<{ indexname: string }>(
        "select indexname from pg_indexes where schemaname = 'connections' and indexname like 'connected_accounts_%' order by 1")).rows.map((r) => r.indexname);
      expect(indexes).toEqual(expect.arrayContaining(["connected_accounts_m01_active_content_asset", "connected_accounts_taq02_tmp_ad_account_single_workspace"]));
    });

    it("the index definitions and comments name exactly their rule", async () => {
      const rows = (await privileged.query<{ name: string; definition: string; comment: string }>(
        `select c.relname as name, pg_get_indexdef(c.oid) as definition, obj_description(c.oid, 'pg_class') as comment
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'connections' and c.relname in ('connected_accounts_m01_active_content_asset', 'connected_accounts_taq02_tmp_ad_account_single_workspace')
          order by 1`)).rows;
      expect(rows).toHaveLength(2);
      const [m01, taq02] = rows;
      expect(m01?.definition).toMatch(/UNIQUE INDEX .*\(organization_id, platform, provider_asset_id\).*'ACTIVE'.*'content_bearing'/);
      expect(m01?.comment).toMatch(/^M-01 \(LOCKED/);
      expect(taq02?.definition).toMatch(/UNIQUE INDEX .*\(organization_id, platform, provider_asset_id\).*'ACTIVE'.*'ad_account'/);
      expect(taq02?.comment).toMatch(/^TEMPORARY TA-Q-02/);
    });

    it("only a discovered asset of the same connection, platform and class can be linked; never across workspaces", async () => {
      await discover(world.A1, chains[world.A1]?.connection ?? "", "fk_page", "content_bearing", "instagram");
      const a1 = chains[world.A1]?.connection ?? "";
      expect((await sqlState(link(world.A1, a1, "fk_page", "ad_account", "instagram"))).code).toBe("23503");
      expect((await sqlState(link(world.A1, a1, "fk_page", "content_bearing", "facebook"))).code).toBe("23503");
      expect((await sqlState(link(world.A1, a1, "never_discovered", "content_bearing", "instagram"))).code).toBe("23503");
      expect((await sqlState(link(world.A1, chains[world.A2]?.connection ?? "", "fk_page", "content_bearing", "instagram"))).code).toBe("23503");
      await link(world.A1, a1, "fk_page", "content_bearing", "instagram");
    });
  });

  describe("durable Move foundation", () => {
    const move = (workspace: string, values: Record<string, string | null>, as: "owner" | "worker" = "worker") => {
      const run = (tx: DatabaseTransaction) => tx.execute(sql`insert into connections.asset_moves
        (organization_id, workspace_id, move_id, side, counterpart_workspace_id, connection_id, connected_account_id, platform, provider_asset_id,
         initiator_user_id, status, reason_code, created_at, updated_at)
        values (${values["organization"] ?? world.orgA}, ${workspace}, ${values["move"] ?? randomUUID()}, ${values["side"] ?? "INCOMING"},
                ${values["counterpart"] ?? world.A2}, ${values["connection"] === undefined ? chains[workspace]?.connection ?? null : values["connection"]},
                ${values["account"] ?? null}, 'facebook', ${values["asset"] === undefined ? `move_${randomUUID().slice(0, 8)}` : values["asset"]},
                ${world.users.ownerA}, ${values["status"] ?? "REQUESTED"}, ${values["reason"] ?? null}, now(), now())`);
      return as === "owner" ? asUser(world.users.ownerA, workspace, run) : asWorker(workspace, run);
    };

    it("side/status combinations, required shape and failure reasons are enforced", async () => {
      expect((await sqlState(move(world.A1, { status: "RELEASED" }))).constraint).toBe("asset_moves_side_status");
      expect((await sqlState(move(world.A1, { side: "OUTGOING", status: "COMPLETED", account: chains[world.A1]?.account ?? null }))).constraint).toBe("asset_moves_side_status");
      expect((await sqlState(move(world.A1, { status: "ACTIVATION_FAILED" }))).constraint).toBe("asset_moves_failure_reason");
      expect((await sqlState(move(world.A1, { side: "OUTGOING", status: "RELEASED", connection: null }))).constraint).toBe("asset_moves_outgoing_shape");
      expect((await sqlState(move(world.A1, { asset: null }))).constraint).toBe("asset_moves_incoming_shape");
      await move(world.A1, { status: "ACTIVATION_FAILED", reason: "DESTINATION_CONNECTION_UNHEALTHY" });
      await move(world.A1, { side: "OUTGOING", status: "REJECTED", reason: "AUTHORITY_REVOKED", connection: null, account: chains[world.A1]?.account ?? null });
    });

    it("the counterpart is another workspace of the SAME organization", async () => {
      expect((await sqlState(move(world.A1, { counterpart: world.B1 }))).constraint).toBe("asset_moves_counterpart_same_organization");
      expect((await sqlState(move(world.A1, { counterpart: world.A1 }))).constraint).toBe("asset_moves_counterpart_other");
    });

    it("one REQUESTED incoming move per asset per destination; completed moves don't block a new request", async () => {
      const first = randomUUID();
      await move(world.A1, { move: first, asset: "dup_asset" }, "owner");
      expect((await sqlState(move(world.A1, { asset: "dup_asset" }, "owner")))).toEqual({ code: "23505", constraint: "asset_moves_one_requested_incoming_per_asset" });
      await asWorker(world.A1, (tx) => tx.execute(sql`update connections.asset_moves set status = 'COMPLETED' where move_id = ${first} and side = 'INCOMING'`));
      await move(world.A1, { asset: "dup_asset" }, "owner");
    });

    it("the web may only re-request (retry) an incoming move; every other transition belongs to the saga", async () => {
      const failed = randomUUID();
      await move(world.A1, { move: failed, asset: "retry_asset", status: "ACTIVATION_FAILED", reason: "ACTIVATION_RETRIES_EXHAUSTED" });
      const update = (status: string, reason: string | null) => asUser(world.users.ownerA, world.A1, (tx) =>
        tx.execute(sql`update connections.asset_moves set status = ${status}, reason_code = ${reason}, updated_at = now() where move_id = ${failed} and side = 'INCOMING'`));
      expect((await sqlState(update("COMPLETED", null))).code).toBe("42501");
      expect((await sqlState(update("REJECTED", "AUTHORITY_REVOKED"))).code).toBe("42501");
      await update("REQUESTED", null);
    });

    it("the web may only open an INCOMING request as itself; outgoing rows are written by the worker", async () => {
      expect((await sqlState(move(world.A1, { side: "OUTGOING", status: "RELEASED", connection: null, account: chains[world.A1]?.account ?? null }, "owner"))).code).toBe("42501");
      expect((await sqlState(asUser(world.users.a1, world.A1, (tx) => tx.execute(sql`insert into connections.asset_moves
        (organization_id, workspace_id, move_id, side, counterpart_workspace_id, connection_id, platform, provider_asset_id, initiator_user_id, status, created_at, updated_at)
        values (${world.orgA}, ${world.A1}, ${randomUUID()}, 'INCOMING', ${world.A2}, ${chains[world.A1]?.connection ?? ""}, 'facebook', 'x_asset', ${world.users.a1}, 'REQUESTED', now(), now())`)))).code).toBe("42501");
    });
  });

  describe("connect attempts", () => {
    const attempt = (values: Record<string, unknown>) => asUser(world.users.ownerA, world.A1, (tx) => tx.execute(sql`insert into connections.connect_attempts
      (id, organization_id, workspace_id, provider, created_by, state_digest, redirect_uri, pkce_secret_id, pkce_envelope, status, expires_at, created_at, closed_at)
      values (${values["id"] ?? randomUUID()}, ${world.orgA}, ${world.A1}, 'simulator', ${world.users.ownerA}, ${values["digest"] ?? digest()}, ${values["redirect"] ?? REDIRECT},
              ${values["pkceId"] ?? null}, ${values["pkce"] ?? null}, ${values["status"] ?? "PENDING"},
              now() + ${values["ttl"] ?? "10 minutes"}::interval, now(), ${values["closedAt"] ?? null})`));

    it("stores the state digest only (unique, hex) and no plaintext state or verifier column exists", async () => {
      const shared = digest();
      await attempt({ digest: shared });
      expect((await sqlState(attempt({ digest: shared }))).code).toBe("23505");
      expect((await sqlState(attempt({ digest: "raw-state-value" }))).code).toBe("23514");
      const columns = (await privileged.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema = 'connections' and table_name = 'connect_attempts'")).rows.map((r) => r.column_name);
      expect(columns).not.toContain("state");
      expect(columns).not.toContain("pkce_verifier");
      expect(columns).toEqual(expect.arrayContaining(["state_digest", "pkce_secret_id", "pkce_envelope"]));
    });

    it("the PKCE verifier exists only as a paired v1 envelope, and is gone once the attempt closes", async () => {
      const sealed = await sealFor(world.A1, randomUUID());
      expect((await sqlState(attempt({ pkceId: randomUUID(), pkce: Buffer.from("plaintext-verifier-value-0123456789abcdefghijklmnop", "utf8") }))).code).toBe("23514");
      expect((await sqlState(attempt({ pkce: sealed }))).constraint).toBe("connect_attempts_pkce_paired");
      const id = randomUUID();
      await attempt({ id, pkceId: randomUUID(), pkce: sealed });
      const close = (clearPkce: boolean) => asUser(world.users.ownerA, world.A1, (tx) => tx.execute(clearPkce
        ? sql`update connections.connect_attempts set status = 'COMPLETED', closed_at = now(), pkce_secret_id = null, pkce_envelope = null where id = ${id}`
        : sql`update connections.connect_attempts set status = 'COMPLETED', closed_at = now() where id = ${id}`));
      expect((await sqlState(close(false))).constraint).toBe("connect_attempts_pkce_cleared_when_closed");
      expect((await sqlState(asUser(world.users.ownerA, world.A1, (tx) =>
        tx.execute(sql`update connections.connect_attempts set status = 'EXPIRED' where id = ${id}`)))).constraint).toBe("connect_attempts_closed_recorded");
      await close(true);
    });

    it("TTL is bounded, the redirect URI is constrained, and only Owners/Admins open attempts", async () => {
      expect((await sqlState(attempt({ ttl: "2 hours" }))).code).toBe("23514");
      expect((await sqlState(attempt({ redirect: "http://evil.example/callback" }))).code).toBe("23514");
      expect((await sqlState(attempt({ status: "COMPLETED", closedAt: null }))).code).toBe("42501");
      expect((await sqlState(asUser(world.users.a1, world.A1, (tx) => tx.execute(sql`insert into connections.connect_attempts
        (id, organization_id, workspace_id, provider, created_by, state_digest, redirect_uri, status, expires_at, created_at)
        values (${randomUUID()}, ${world.orgA}, ${world.A1}, 'simulator', ${world.users.a1}, ${digest()}, ${REDIRECT}, 'PENDING', now() + interval '5 minutes', now())`)))).code).toBe("42501");
    });
  });

  describe("schema hygiene", () => {
    it("no column in the Step 5B schemas is shaped to hold plaintext secrets", async () => {
      const columns = (await privileged.query<{ name: string }>(
        `select table_schema || '.' || table_name || '.' || column_name as name from information_schema.columns
          where table_schema in ('connections', 'credentials')`)).rows.map((r) => r.name);
      const suspicious = columns.filter((name) => /(token|secret|password|plaintext|verifier|access|refresh|(^|\.)state$)/i.test(name.split(".").pop() ?? ""));
      expect(suspicious.sort()).toEqual(["connections.connect_attempts.pkce_secret_id"]);
    });

    it("no role was created: the application roles are unchanged", async () => {
      const roles = (await privileged.query<{ rolname: string }>("select rolname from pg_roles where rolname like 'app\\_%' order by 1")).rows.map((r) => r.rolname);
      expect(roles).toEqual(["app_owner", "app_system", "app_worker"]);
    });

    it("the audit vocabulary constraints are validated and match the application's closed vocabulary exactly", async () => {
      const rows = (await privileged.query<{ name: string; validated: boolean; definition: string }>(
        `select conname as name, convalidated as validated, pg_get_constraintdef(oid) as definition from pg_constraint
          where conrelid = 'audit.audit_events'::regclass and conname in ('audit_events_action_check', 'audit_events_target_type_check') order by 1`)).rows;
      const values = (definition: string) => [...definition.matchAll(/'([^']+)'::text/g)].map((m) => m[1]).sort();
      expect(rows.map((r) => [r.name, r.validated])).toEqual([["audit_events_action_check", true], ["audit_events_target_type_check", true]]);
      expect(values(rows[0]?.definition ?? "")).toEqual([...AUDIT_ACTIONS].sort());
      expect(values(rows[1]?.definition ?? "")).toEqual([...AUDIT_TARGET_TYPES].sort());
    });

    it("the audit ledger accepts the Step 5 vocabulary (closed) and rejects anything else", async () => {
      const append = (action: string, target: string, change: unknown) => asWorker(world.A1, (tx) => tx.execute(sql`insert into audit.audit_events
        (id, occurred_at, action, actor_type, organization_id, workspace_id, target_type, target_id, correlation_id, outcome, change)
        values (${randomUUID()}, now(), ${action}, 'system', ${world.orgA}, ${world.A1}, ${target}, ${chains[world.A1]?.connection ?? ""},
                'corr-step5b-0001', 'succeeded', ${change === null ? null : JSON.stringify(change)}::jsonb)`));
      await append("connection.status_changed", "connection", { kind: "connection_status", previous: "ACTIVE", current: "DEGRADED" });
      await append("connected_account.moved_out", "connected_account", null);
      await append("connected_account.move_requested", "asset_move", null);
      expect((await sqlState(append("connection.status_changed", "connection", { kind: "connection_status", previous: "ACTIVE", current: "BROKEN" }))).code).toBe("23514");
      expect((await sqlState(append("connection.token_printed", "connection", null))).code).toBe("23514");
      expect((await sqlState(append("connection.created", "credential", null))).code).toBe("23514");
    });
  });
}
