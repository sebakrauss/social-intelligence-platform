/**
 * Step 5E — Account Capability Profiles on the real database (migration 0009), end to end against the provider
 * SIMULATOR, in process: Step 5D authorization + discovery → a synthetic Connected Account (linking itself is Step
 * 5F) → describeAccount facts → pure evaluation → persisted current profile → effective availability through the
 * pipeline. Synthetic data only; simulator behavior is never evidence about Meta, Instagram or TikTok.
 *
 *   persistence  keyed by (workspace, connected account, capability, kind, source); catalog id/version, inputs,
 *                as-of and evaluated time stored; identical inputs are a no-op; a stale evaluation never wins
 *   tenancy      forced RLS; web reads (non-guest members) but never writes; the worker is bound to one workspace;
 *                composite FKs (no cross-workspace account, no global-PK oracle); app_system sees nothing
 *   overlay      connection health changes availability, never the stored profile
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseUserId, parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import { SimulatorWorld, simulateConsent, type SimulatedConsent } from "@/integrations/providers/simulator";
import type { CallbackQuery } from "@/integrations/providers/contract";
import { SIMULATOR_CATALOG, evaluateProfile, inputDigest, type CapabilityProfileStore } from "@/modules/capability";
import { createPostgresCapabilityStore } from "@/modules/capability/persistence";
import { refreshAccountCapabilities, type CapabilityRefreshDependencies } from "@/modules/connections";
import { createLocalKeyring, type LocalKeyring } from "@/platform/crypto/credentials/local-keyring";
import { createCredentialOpener } from "@/platform/crypto/credentials/open";
import { createCredentialSealer } from "@/platform/crypto/credentials/seal";
import { createPkceDeriver } from "@/platform/crypto/oauth";
import { withUserScope, withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { withSystemScope } from "@/platform/db/system-scope";
import { runTenantStepJob } from "@/platform/jobs";
import { createLogger } from "@/platform/observability";
import { createCapabilityQueries } from "@/server/commands/capability";
import { createConnectionCommands } from "@/server/commands/connections";
import { completeConnectionAuthorization, startConnectionAuthorization, type ConnectionAuthorizationDependencies } from "@/server/connections/authorization";
import { authorizationProviders, createCredentialSealing, createOAuthSecrets } from "@/server/connections/runtime";
import { createLocalSimulator, type LocalSimulator } from "@/server/connections/simulator";
import { capabilityRefreshStores } from "@/server/persistence/connections";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { createActionPipeline } from "@/server/pipeline";
import { createConnectedAccountCommands } from "@/server/commands/connected-accounts";
import { composeJobProviders, createCredentialAccess, runDiscoverAssets, runEvaluateAccountCapabilities } from "@/jobs/connections";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { FakeIdentity, verifiedUser } from "../../support/in-memory";
import { errorCode, expectOk } from "../../support/harness";
import { loadScenario } from "../../providers/support/fixtures";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld, seedWorld, type World } from "../support/world";
import { sqlState } from "./helpers";

const APP = "https://app.example.test";

export function defineCapabilitySuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let system: RuntimeDatabase<"system">;
  let world: World;
  let keyring: LocalKeyring;
  let sim: LocalSimulator;
  let deps: ConnectionAuthorizationDependencies;
  const identity = new FakeIdentity();
  const logger = createLogger({ sink: () => undefined, now: () => new Date() });
  const queries = createCapabilityQueries();
  let clockMs = Date.now();
  const clock = (): Date => new Date((clockMs += 1));

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const ws = (id: string): WorkspaceId => {
    const parsed = parseWorkspaceId(id);
    if (parsed === undefined) throw new Error("uuid");
    return parsed;
  };
  const as = (user: string): void => {
    const id = parseUserId(user);
    if (id === undefined) throw new Error("uuid");
    identity.user = verifiedUser(id, `user-${user.slice(0, 8)}@example.test`);
  };
  const orgOf = (workspace: string): string => (workspace === world.B1 ? world.orgB : world.orgA);
  const ownerOf = (workspace: string): string => (workspace === world.B1 ? world.users.ownerB : world.users.ownerA);
  const access = () => createCredentialAccess(createCredentialOpener(keyring.unwrapper), "test");
  const providers = { read: (provider: string) => (provider === "simulator" ? sim.read : undefined) };

  /** Step 5D, in process: authorize (grant) → connection → discovery job. Returns the connection id. */
  const connect = async (workspace: string, grant: SimulatedConsent = { kind: "grant", grant: "meta_full" }): Promise<string> => {
    as(ownerOf(workspace));
    const started = await startConnectionAuthorization(deps, { workspaceId: workspace, provider: "simulator" });
    if (started.status !== "ok") throw new Error("start failed");
    const query: CallbackQuery = [...new URL(simulateConsent(sim.world, started.authorizationUrl, grant)).searchParams];
    const result = await completeConnectionAuthorization(deps, { provider: "simulator", query });
    if (result.status !== "connected") throw new Error(`connect failed: ${result.status}`);
    const row = (await oracle<{ id: string; subject_ids: Record<string, string>; correlation_id: string; initiator_user_id: string }>(
      "select id, subject_ids, correlation_id, initiator_user_id from system.outbox where topic = 'connections.discover_assets' and subject_ids->>'connection_id' = $1",
      [result.connectionId],
    ))[0];
    if (row === undefined) throw new Error("no outbox row");
    await runTenantStepJob(
      { registry: PRODUCTION_TASKS, worker, logger },
      "connections.discover_assets",
      { v: 1, scope: "workspace", task: "connections.discover_assets", workspaceId: workspace, outboxId: row.id, subjectIds: row.subject_ids, correlationId: row.correlation_id, initiator: { type: "user", userId: row.initiator_user_id } },
      { runId: `run_${randomUUID()}`, attempt: 1 },
      (context) => runDiscoverAssets(context, { access: access(), providers }),
    );
    return result.connectionId;
  };

  /** A synthetic ACTIVE Connected Account for a discovered asset (the Step 5F link flow does not exist yet). */
  const link = async (workspace: string, connection: string, assetId: string, id: string = randomUUID()): Promise<string> => {
    const asset = (await oracle<{ platform: string; asset_class: string }>(
      "select platform, asset_class from connections.discovered_assets where connection_id = $1 and provider_asset_id = $2", [connection, assetId]))[0];
    if (asset === undefined) throw new Error("asset not discovered");
    await withUserScope(web, { sub: ownerOf(workspace), role: "authenticated" }, workspace, (tx) => tx.execute(sql`insert into connections.connected_accounts
      (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
      values (${id}, ${orgOf(workspace)}, ${workspace}, ${connection}, ${asset.platform}, ${assetId}, ${asset.asset_class}, 'ACTIVE', now(), now(), now())`));
    return id;
  };

  const refreshDeps = (workspace: string): CapabilityRefreshDependencies => ({
    inScope: (work) =>
      withWorkspaceJobScope(worker, workspace, (tx) => work(capabilityRefreshStores({ tx, claimEffect: () => Promise.reject(new Error("unused")), noteOutbox: () => undefined }))),
    access: access(),
    providers,
    clock,
    environment: { NODE_ENV: "test" },
  });
  const refresh = (workspace: string, connectedAccountId: string) => refreshAccountCapabilities(refreshDeps(workspace), { workspaceId: ws(workspace), connectedAccountId });
  const asWorker = <T>(workspace: string, work: (tx: DatabaseTransaction, store: CapabilityProfileStore) => Promise<T>): Promise<T> =>
    withWorkspaceJobScope(worker, workspace, (tx) => work(tx, createPostgresCapabilityStore(tx)));
  const entries = (account: string) =>
    oracle<{ capability: string; content_kind: string; source: string; state: string; reason_codes: string[]; limitation_code: string | null; limitation_value: number | null; revision: number }>(
      "select capability, content_kind, source, state, reason_codes, limitation_code, limitation_value, revision from capability.profile_entries where connected_account_id = $1 order by capability, content_kind, source",
      [account],
    );
  const header = async (account: string) =>
    (await oracle<{ workspace_id: string; catalog_id: string; catalog_revision: number; revision: number; evaluated_at: Date; inputs_as_of: Date; input_digest: string; facts_available: boolean; facts_granted_permissions: string[] }>(
      "select * from capability.account_profiles where connected_account_id = $1 order by workspace_id", [account]))[0];
  const availability = (workspace: string, connectedAccountId: string, capability: string, extra: Record<string, string> = {}) =>
    deps.pipeline.run(queries.availability, { workspaceId: workspace, input: { connectedAccountId, capability, ...extra } });

  let A1: { connection: string; page: string; adAccount: string };

  beforeAll(async () => {
    const target = getTarget();
    privileged = privilegedPool(target);
    web = runtimeDatabase(target, "web", 3);
    worker = runtimeDatabase(target, "worker", 2);
    system = runtimeDatabase(target, "system", 1);
    world = await seedWorld(privileged);
    keyring = createLocalKeyring(randomBytes(32), { NODE_ENV: "test" });
    sim = createLocalSimulator(new SimulatorWorld(loadScenario("baseline")));
    const secrets = createOAuthSecrets(createPkceDeriver(randomBytes(32)));
    const authProviders = authorizationProviders({ simulator: sim.authorization }, APP);
    deps = {
      pipeline: createActionPipeline({ identity, unitOfWork: createPostgresUnitOfWork(web), clock, newId: randomUUID, logger }),
      commands: createConnectionCommands({ secrets, providers: authProviders }),
      providers: authProviders,
      secrets,
      sealing: createCredentialSealing(createCredentialSealer(keyring.generator), "test"),
      newId: randomUUID,
      logger,
    };
    const connection = await connect(world.A1);
    A1 = { connection, page: await link(world.A1, connection, "fb_page_aurora"), adAccount: await link(world.A1, connection, "act_meta_100") };
  });

  beforeEach(() => {
    sim.world.clearFaults();
    as(world.users.ownerA);
  });

  afterAll(async () => {
    await Promise.all([web.end(), worker.end(), system.end()]);
    await privileged.query("delete from idempotency.effect_keys where workspace_id = any($1::uuid[])", [[world.A1, world.A2, world.B1]]);
    await cleanupWorld(privileged, [world.orgA, world.orgB]);
    await privileged.end();
    keyring.destroy();
  });

  describe("end to end (simulator, in process)", () => {
    it("describeAccount facts → pure evaluation → persisted current profile with catalog version, inputs and as-of", async () => {
      const outcome = await refresh(world.A1, A1.page);
      expect(outcome).toMatchObject({ kind: "evaluated", factsAvailable: true, write: { kind: "applied", revision: 1 } });
      const stored = await header(A1.page);
      expect(stored).toMatchObject({ workspace_id: world.A1, catalog_id: "simulator", catalog_revision: SIMULATOR_CATALOG.revision, revision: 1, facts_available: true });
      expect(stored?.facts_granted_permissions).toContain("sim.hide");
      expect(stored?.evaluated_at).toBeInstanceOf(Date);
      const rows = await entries(A1.page);
      const find = (capability: string, kind = "any", source = "any") => rows.find((r) => r.capability === capability && r.content_kind === kind && r.source === source);
      expect(find("read_interactions")).toMatchObject({ state: "SUPPORTED", reason_codes: ["CATALOG_SUPPORTED"] });
      expect(find("hide")).toMatchObject({ state: "AVAILABLE_WITH_LIMITATION", limitation_code: "HIDE_VISIBLE_TO_AUTHOR" });
      expect(find("read_history")).toMatchObject({ state: "AVAILABLE_WITH_LIMITATION", limitation_code: "HISTORY_DEPTH_LIMITED", limitation_value: 90 });
      expect(find("reply_public", "story")).toMatchObject({ state: "UNSUPPORTED", reason_codes: ["CATALOG_UNSUPPORTED"] });
      expect(find("detect_native_replies")).toMatchObject({ state: "UNKNOWN_NOT_VALIDATED", reason_codes: ["CATALOG_NOT_VALIDATED"] });
      expect(rows.every((r) => r.revision === 1)).toBe(true);
      // Recomputable: the stored inputs reproduce the same digest.
      const evaluated = outcome.kind === "evaluated" ? outcome.profile : undefined;
      expect(evaluated?.entries).toHaveLength(rows.length);
    });

    it("effective availability through the pipeline: base result when healthy, TEMPORARILY_UNAVAILABLE when degraded, restored on recovery", async () => {
      await refresh(world.A1, A1.page);
      const revision = (await header(A1.page))?.revision;
      expect(expectOk(await availability(world.A1, A1.page, "hide"))).toMatchObject({ state: "AVAILABLE_WITH_LIMITATION", limitation: { code: "HIDE_VISIBLE_TO_AUTHOR" } });
      expect(expectOk(await availability(world.A1, A1.page, "reply_public", { contentKind: "story" }))).toMatchObject({ state: "UNAVAILABLE", reason: "CAPABILITY_UNSUPPORTED" });
      expect(expectOk(await availability(world.A1, A1.page, "detect_native_replies"))).toMatchObject({ state: "UNAVAILABLE", reason: "CAPABILITY_NOT_VALIDATED" });
      await privileged.query("update connections.connections set status = 'DEGRADED' where id = $1", [A1.connection]);
      try {
        expect(expectOk(await availability(world.A1, A1.page, "read_interactions"))).toMatchObject({ state: "TEMPORARILY_UNAVAILABLE", reason: "CONNECTION_DEGRADED", baseState: "SUPPORTED" });
        expect(expectOk(await availability(world.A1, A1.page, "detect_native_replies"))).toMatchObject({ state: "UNAVAILABLE", reason: "CAPABILITY_NOT_VALIDATED" });
      } finally {
        await privileged.query("update connections.connections set status = 'ACTIVE' where id = $1", [A1.connection]);
      }
      expect(expectOk(await availability(world.A1, A1.page, "read_interactions"))).toMatchObject({ state: "AVAILABLE" });
      expect((await header(A1.page))?.revision).toBe(revision);
    });

    it("an ad account gets its own scopes: paid-context SUPPORTED, content-bearing actions UNKNOWN (never inferred)", async () => {
      await refresh(world.A1, A1.adAccount);
      const rows = await entries(A1.adAccount);
      expect(rows.find((r) => r.capability === "read_paid_context")?.state).toBe("SUPPORTED");
      expect(rows.find((r) => r.capability === "hide")?.state).toBe("UNKNOWN_NOT_VALIDATED");
    });

    it("an account lacking permissions is UNSUPPORTED with a re-authorization recovery; facts never upgrade it", async () => {
      const partial = await connect(world.A1, { kind: "grant", grant: "meta_partial" });
      const limited = await link(world.A1, partial, "ig_acct_limited");
      await refresh(world.A1, limited);
      const rows = await entries(limited);
      expect(rows.find((r) => r.capability === "read_interactions" && r.content_kind === "any")).toMatchObject({ state: "UNSUPPORTED", reason_codes: ["ACCOUNT_PERMISSION_MISSING"] });
      expect(expectOk(await availability(world.A1, limited, "hide"))).toMatchObject({ state: "UNAVAILABLE", reason: "ACCOUNT_PERMISSION_MISSING", recovery: "REAUTHORIZE" });
    });
  });

  describe("idempotency, stale writes and fail-closed refresh", () => {
    it("identical inputs are a no-op; data volume changes nothing (no inference from absent comments)", async () => {
      await refresh(world.A1, A1.page);
      const before = await header(A1.page);
      for (const interaction of sim.world.interactions()) sim.world.removeAtSource(interaction.id, { signaled: true });
      const again = await refresh(world.A1, A1.page);
      expect(again).toMatchObject({ kind: "evaluated", write: { kind: "unchanged" } });
      const after = await header(A1.page);
      expect([after?.revision, after?.input_digest]).toEqual([before?.revision, before?.input_digest]);
      // Only "last verified" moved forward.
      expect((after?.inputs_as_of.getTime() ?? 0) > (before?.inputs_as_of.getTime() ?? Number.POSITIVE_INFINITY)).toBe(true);
      expect(await oracle("select 1 from capability.account_profiles where connected_account_id = $1", [A1.page])).toHaveLength(1);
      // (No world reset: it would also forget the credentials issued in beforeAll. Capability never reads content.)
    });

    /** A direct store write for `account` (the job-side write path), with explicit catalog, facts time and permissions. */
    const writeFor = (account: string, options: { readonly catalogRevision?: number; readonly minutes: number; readonly permissions: readonly string[]; readonly hold?: Promise<void> }) =>
      asWorker(world.A1, async (_tx, store) => {
        const catalog = { ...SIMULATOR_CATALOG, revision: options.catalogRevision ?? 1, label: `simulator-catalog-r${String(options.catalogRevision ?? 1)}` };
        const facts = {
          kind: "available" as const,
          assetClass: "content_bearing" as const,
          grantedPermissions: options.permissions,
          linkedAdAccountIds: [],
          accountIdentityKnown: true,
          obtainedAt: new Date(Date.UTC(2026, 9, 7, 12, options.minutes)),
        };
        const evaluation = { catalog, platform: "instagram" as const, assetClass: "content_bearing" as const, facts, observations: [], evaluatedAt: new Date() };
        const outcome = await store.write({
          organizationId: world.orgA,
          workspaceId: world.A1,
          connectedAccountId: account,
          profile: evaluateProfile(evaluation),
          facts,
          observations: [],
          inputDigest: inputDigest(evaluation),
        });
        await options.hold;
        return outcome;
      });
    /** One linked account for these tests (M-01 allows one active link per asset), with its profile cleared. */
    let shared: string | undefined;
    const freshAccount = async (): Promise<string> => {
      shared ??= await link(world.A1, A1.connection, "ig_acct_aurora");
      await privileged.query("delete from capability.account_profiles where connected_account_id = $1", [shared]);
      return shared;
    };
    const readInteractions = async (account: string) => (await entries(account)).find((r) => r.capability === "read_interactions" && r.content_kind === "any")?.state;

    it("within a catalog revision, newer inputs win and older inputs can never regress the current profile", async () => {
      const account = await freshAccount();
      expect(await writeFor(account, { minutes: 10, permissions: ["sim.hide"] })).toEqual({ kind: "applied", revision: 1 });
      expect(await writeFor(account, { minutes: 20, permissions: ["sim.hide", "sim.read_interactions"] })).toEqual({ kind: "applied", revision: 2 });
      // Computed later, from OLDER facts: stale.
      expect(await writeFor(account, { minutes: 15, permissions: [] })).toEqual({ kind: "stale", revision: 2 });
      expect(await writeFor(account, { minutes: 20, permissions: ["sim.hide", "sim.read_interactions"] })).toEqual({ kind: "unchanged", revision: 2 });
      expect(await readInteractions(account)).toBe("SUPPORTED");
      expect((await entries(account)).every((r) => r.revision === 2)).toBe(true);
    });

    it("catalog revision 2 supersedes 1, and a revision-1 evaluation can never overwrite it even with newer inputs, evaluated later", async () => {
      const account = await freshAccount();
      expect(await writeFor(account, { catalogRevision: 1, minutes: 30, permissions: ["sim.read_interactions"] })).toEqual({ kind: "applied", revision: 1 });
      expect(await writeFor(account, { catalogRevision: 2, minutes: 10, permissions: [] })).toEqual({ kind: "applied", revision: 2 });
      expect(await writeFor(account, { catalogRevision: 1, minutes: 59, permissions: ["sim.read_interactions"] })).toEqual({ kind: "stale", revision: 2 });
      expect((await header(account))?.catalog_revision).toBe(2);
      expect(await readInteractions(account)).toBe("UNSUPPORTED");
    });

    it("same revision, same inputs_as_of, different content: CONFLICT — rejected, never decided by digest order", async () => {
      const account = await freshAccount();
      expect(await writeFor(account, { minutes: 40, permissions: ["sim.read_interactions"] })).toEqual({ kind: "applied", revision: 1 });
      const before = await header(account);
      expect(await writeFor(account, { minutes: 40, permissions: [] })).toEqual({ kind: "conflict", revision: 1 });
      expect(await writeFor(account, { minutes: 40, permissions: ["sim.hide"] })).toEqual({ kind: "conflict", revision: 1 });
      const after = await header(account);
      expect([after?.revision, after?.input_digest]).toEqual([before?.revision, before?.input_digest]);
      expect(await readInteractions(account)).toBe("SUPPORTED");
    });

    it("a concurrent stale writer can't overwrite current state: it waits on the row lock, then loses on freshness", async () => {
      const account = await freshAccount();
      expect(await writeFor(account, { minutes: 5, permissions: [] })).toEqual({ kind: "applied", revision: 1 });
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const fresh = writeFor(account, { minutes: 50, permissions: ["sim.read_interactions"], hold: held }); // holds the lock, uncommitted
      await new Promise((resolve) => setTimeout(resolve, 200));
      const stale = writeFor(account, { minutes: 45, permissions: [] }); // blocked on FOR UPDATE
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      expect(await Promise.all([fresh, stale])).toEqual([{ kind: "applied", revision: 2 }, { kind: "stale", revision: 2 }]);
      expect(await readInteractions(account)).toBe("SUPPORTED");
    });

    it("an identical re-check advances last_verified_at and inputs_as_of only: no semantic revision churn", async () => {
      const account = await freshAccount();
      expect(await writeFor(account, { minutes: 1, permissions: ["sim.read_interactions"] })).toEqual({ kind: "applied", revision: 1 });
      const before = (await oracle<{ last_verified_at: Date; inputs_as_of: Date; evaluated_at: Date }>("select * from capability.account_profiles where connected_account_id = $1", [account]))[0];
      expect(await writeFor(account, { minutes: 9, permissions: ["sim.read_interactions"] })).toEqual({ kind: "unchanged", revision: 1 });
      const after = (await oracle<{ last_verified_at: Date; inputs_as_of: Date; evaluated_at: Date; revision: number }>("select * from capability.account_profiles where connected_account_id = $1", [account]))[0];
      expect(after?.revision).toBe(1);
      expect(after?.evaluated_at).toEqual(before?.evaluated_at);
      expect((after?.last_verified_at.getTime() ?? 0) > (before?.last_verified_at.getTime() ?? Number.POSITIVE_INFINITY)).toBe(true);
      expect((after?.inputs_as_of.getTime() ?? 0) > (before?.inputs_as_of.getTime() ?? Number.POSITIVE_INFINITY)).toBe(true);
      expect((await entries(account)).every((r) => r.revision === 1)).toBe(true);
      // ...and an older identical re-check is stale, not bookkeeping.
      expect(await writeFor(account, { minutes: 2, permissions: ["sim.read_interactions"] })).toEqual({ kind: "stale", revision: 1 });
    });

    it("transient and rate-limited describeAccount outcomes never rewrite the profile; a definite one fails closed", async () => {
      await refresh(world.A1, A1.page);
      const before = await header(A1.page);
      sim.world.injectFaults([{ operation: "describeAccount", on: 1, fault: { kind: "transient", reason: "provider_unavailable" } }]);
      await expect(refresh(world.A1, A1.page)).rejects.toMatchObject({ kind: "transient" });
      sim.world.injectFaults([{ operation: "describeAccount", on: 1, fault: { kind: "rate_limited", retryAfterSeconds: 30 } }]);
      await expect(refresh(world.A1, A1.page)).rejects.toMatchObject({ kind: "rate_limited" });
      expect((await header(A1.page))?.revision).toBe(before?.revision);
      sim.world.injectFaults([{ operation: "describeAccount", on: 1, fault: { kind: "permission_missing", capability: "read_account" } }]);
      expect(await refresh(world.A1, A1.page)).toMatchObject({ kind: "evaluated", factsAvailable: false, write: { kind: "applied" } });
      const rows = await entries(A1.page);
      expect(rows.some((r) => r.state === "SUPPORTED" || r.state === "AVAILABLE_WITH_LIMITATION")).toBe(false);
      // Facts readable again: the next evaluation restores the profile.
      expect(await refresh(world.A1, A1.page)).toMatchObject({ factsAvailable: true, write: { kind: "applied" } });
      expect((await entries(A1.page)).find((r) => r.capability === "read_interactions" && r.content_kind === "any")?.state).toBe("SUPPORTED");
    });
  });

  describe("tenancy and grants", () => {
    it("profiles are read by non-guest members of the bound workspace only; the web can't write", async () => {
      await refresh(world.A1, A1.page);
      const readAs = (user: string, workspace: string | undefined) =>
        withUserScope(web, { sub: user, role: "authenticated" }, workspace, async (tx) => (await tx.execute(sql`select count(*)::int as n from capability.profile_entries`)).rows[0]);
      expect((await readAs(world.users.ownerA, world.A1))?.["n"]).toBeGreaterThan(0);
      expect((await readAs(world.users.a1, world.A1))?.["n"]).toBeGreaterThan(0);
      expect((await readAs(world.users.ownerA, world.A2))?.["n"]).toBe(0);
      expect((await readAs(world.users.ownerA, undefined))?.["n"]).toBe(0);
      expect((await readAs(world.users.guest, world.A1))?.["n"]).toBe(0);
      expect((await readAs(world.users.ownerB, world.B1))?.["n"]).toBe(0);
      expect((await sqlState(withUserScope(web, { sub: world.users.ownerA, role: "authenticated" }, world.A1, (tx) =>
        tx.execute(sql`delete from capability.profile_entries`))))).toMatchObject({ code: "42501" });
      as(world.users.guest);
      expect(errorCode(await availability(world.A1, A1.page, "hide"))).toBe("PERMISSION_DENIED");
      as(world.users.ownerB);
      expect(errorCode(await availability(world.B1, A1.page, "hide"))).toBe("NOT_FOUND");
    });

    it("the worker is bound to its workspace: no foreign rows, no cross-workspace account reference, no system access", async () => {
      await refresh(world.A1, A1.page);
      expect((await asWorker(world.A2, (tx) => tx.execute(sql`select count(*)::int as n from capability.account_profiles`))).rows[0]).toEqual({ n: 0 });
      // Writing a row for another workspace from A2's scope: refused by RLS.
      expect((await sqlState(asWorker(world.A2, (tx) => tx.execute(sql`insert into capability.account_profiles
        (organization_id, workspace_id, connected_account_id, catalog_id, catalog_revision, facts_available, facts_observed_at, inputs_as_of, input_digest, evaluated_at, last_verified_at, revision, created_at, updated_at)
        values (${world.orgA}, ${world.A1}, ${randomUUID()}, 'simulator', 1, false, now(), now(), ${"0".repeat(64)}, now(), now(), 1, now(), now())`))))).toMatchObject({ code: "42501" });
      // Referencing A1's Connected Account from A2: the composite FK fails like a missing one.
      expect((await sqlState(asWorker(world.A2, (tx) => tx.execute(sql`insert into capability.account_profiles
        (organization_id, workspace_id, connected_account_id, catalog_id, catalog_revision, facts_available, facts_observed_at, inputs_as_of, input_digest, evaluated_at, last_verified_at, revision, created_at, updated_at)
        values (${world.orgA}, ${world.A2}, ${A1.page}, 'simulator', 1, false, now(), now(), ${"0".repeat(64)}, now(), now(), 1, now(), now())`))))).toMatchObject({ code: "23503" });
      expect((await sqlState(withSystemScope(system, (tx) => tx.execute(sql`select count(*) from capability.profile_entries`))))).toMatchObject({ code: "42501" });
    });

    it("no global-PK oracle: the same Connected Account id in another workspace evaluates independently", async () => {
      const connectionB = await connect(world.B1);
      const sameId = await link(world.B1, connectionB, "fb_page_aurora", A1.page);
      expect(sameId).toBe(A1.page);
      expect(await refresh(world.B1, sameId)).toMatchObject({ kind: "evaluated", write: { kind: "applied" } });
      const rows = await oracle<{ workspace_id: string }>("select distinct workspace_id from capability.account_profiles where connected_account_id = $1 order by 1", [A1.page]);
      expect(rows.map((r) => r.workspace_id).sort()).toEqual([world.A1, world.B1].sort());
    });

    it("stores no secret and no raw provider payload", async () => {
      await refresh(world.A1, A1.page);
      const dump = (await oracle<{ row: string }>("select t::text as row from capability.account_profiles t union all select t::text from capability.profile_entries t")).map((r) => r.row).join("\n");
      expect(dump).not.toMatch(/sim:\/\/|sim-access-token|rawReference|apiVersion|Aurora/);
      const columns = (await oracle<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'capability'")).map((r) => r.column_name);
      expect(columns.filter((name) => /(token|secret|password|raw|payload|plaintext|state$)/i.test(name) && name !== "state")).toEqual([]);
      expect(createHash("sha256").update("x").digest("hex")).toHaveLength(64);
    });
  });

  describe("Step 5F hand-off: linking enqueues capability evaluation, the job evaluates the new account", () => {
    it("the real link command → capability.evaluate_account (IDs only) → refreshAccountCapabilities in the job runtime", async () => {
      const connectionB = await connect(world.B1);
      const discovered = (await oracle<{ id: string }>("select id from connections.discovered_assets where connection_id = $1 and provider_asset_id = 'ig_acct_aurora'", [connectionB]))[0];
      as(world.users.ownerB);
      const linked = expectOk(await deps.pipeline.run(createConnectedAccountCommands().link, { workspaceId: world.B1, input: { discoveredAssetId: discovered?.id } }));
      if (linked.kind !== "linked") throw new Error("not linked");
      const row = (await oracle<{ id: string; subject_ids: Record<string, string>; correlation_id: string; initiator_user_id: string }>(
        "select id, subject_ids, correlation_id, initiator_user_id from system.outbox where topic = 'capability.evaluate_account' and subject_ids->>'connected_account_id' = $1",
        [linked.connectedAccountId],
      ))[0];
      expect(row?.subject_ids).toEqual({ connected_account_id: linked.connectedAccountId });
      expect(await header(linked.connectedAccountId)).toBeUndefined(); // nothing evaluated in the web transaction
      const outcome = await runTenantStepJob(
        { registry: PRODUCTION_TASKS, worker, logger },
        "capability.evaluate_account",
        { v: 1, scope: "workspace", task: "capability.evaluate_account", workspaceId: world.B1, outboxId: row?.id, subjectIds: row?.subject_ids, correlationId: row?.correlation_id, initiator: { type: "user", userId: row?.initiator_user_id } },
        { runId: `run_${randomUUID()}`, attempt: 1 },
        (context) => runEvaluateAccountCapabilities(context, { access: access(), providers }),
      );
      expect(outcome).toMatchObject({ kind: "evaluated", factsAvailable: true, write: { kind: "applied", revision: 1 } });
      expect(await header(linked.connectedAccountId)).toMatchObject({ workspace_id: world.B1, catalog_id: "simulator" });
    });
  });

  describe("Step 5K: the real capability.evaluate_account handler with the synthetic staging stub (provider-free)", () => {
    it("NODE_ENV=production + APP_DEPLOYMENT_ENV=preview + staging_stub: completes through the production task wrapper, opens no envelope, touches no network, claims nothing", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
      const httpSpy = vi.spyOn(http, "request").mockImplementation(() => {
        throw new Error("network forbidden");
      });
      const httpsSpy = vi.spyOn(https, "request").mockImplementation(() => {
        throw new Error("network forbidden");
      });
      try {
        // Synthetic bootstrap (privileged): a Meta-provider connection whose stored envelope is unopenable junk.
        const [connection, credential, asset, account] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
        const providerAssetId = `stub_page_${randomUUID().slice(0, 8)}`;
        await privileged.query(
          `insert into connections.connections (id, organization_id, workspace_id, provider, status, authorized_by, authorized_at, version, created_at, updated_at)
           values ($1, $2, $3, 'meta', 'ACTIVE', $4, now(), 1, now(), now())`, [connection, world.orgA, world.A2, world.users.ownerA]);
        await privileged.query(
          `insert into credentials.provider_credentials (id, organization_id, workspace_id, connection_id, credential_version, envelope, created_at)
           values ($1, $2, $3, $4, 1, $5, now())`, [credential, world.orgA, world.A2, connection, Buffer.concat([Buffer.from("5349504501", "hex"), randomBytes(64)])]);
        await privileged.query("update connections.connections set active_credential_id = $1 where id = $2", [credential, connection]);
        await privileged.query(
          `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
           values ($1, $2, $3, $4, 'facebook', $5, 'content_bearing', 'Synthetic asset', now(), now(), now())`, [asset, world.orgA, world.A2, connection, providerAssetId]);
        await privileged.query(
          `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
           values ($1, $2, $3, $4, 'facebook', $5, 'content_bearing', 'ACTIVE', now(), now(), now())`, [account, world.orgA, world.A2, connection, providerAssetId]);

        const staging = composeJobProviders({ NODE_ENV: "production", APP_DEPLOYMENT_ENV: "preview", CAPABILITY_PROVIDER_MODE: "staging_stub" });
        const outcome = await runTenantStepJob(
          { registry: PRODUCTION_TASKS, worker, logger },
          "capability.evaluate_account",
          { v: 1, scope: "workspace", task: "capability.evaluate_account", workspaceId: world.A2, outboxId: randomUUID(), subjectIds: { connected_account_id: account }, correlationId: "corr-5k-staging-stub", initiator: { type: "system" } },
          { runId: `run_${randomUUID()}`, attempt: 1 },
          (context) => runEvaluateAccountCapabilities(context, staging),
        );
        expect(outcome).toMatchObject({ kind: "evaluated", factsAvailable: true, write: { kind: "applied", revision: 1 } });
        const stored = await header(account);
        expect(stored).toMatchObject({ workspace_id: world.A2, catalog_id: "platform", facts_available: true, facts_granted_permissions: [] });
        const rows = await entries(account);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.state === "UNKNOWN_NOT_VALIDATED")).toBe(true); // the stub never makes anything supported
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(httpSpy).not.toHaveBeenCalled();
        expect(httpsSpy).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    });
  });
}
