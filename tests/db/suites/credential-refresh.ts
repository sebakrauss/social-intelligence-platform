/**
 * Step 7G-H5.5-P12-C0-R1 — capability refresh after a re-authorization, on the real database, end to end against the
 * provider SIMULATOR: the real action pipeline and web unit of work for authorization and re-authorization, the real
 * discovery and capability.evaluate_account handlers through the tenant step wrapper (worker login → app_worker + one
 * sealed workspace), system.outbox's unique dispatch key and the R6 effect claim. Its own seeded world, so its links
 * never collide with another suite's (M-01). Synthetic data only; simulator behavior is never evidence about Meta.
 *
 *   origin       the initial authorization and an ordinary rediscovery carry no continuation and request nothing; a
 *                successful re-authorization's discovery carries its credential and, once validated, requests ONE
 *                evaluation per ACTIVE account of the connection (never an INACTIVE one, another connection's or
 *                another workspace's); a non-validated one requests nothing
 *   idempotency  the same row redelivered is applied once; another authority for the same credential finds the keys
 *                taken; another credential gets its own
 *   staleness    a discovery whose credential was replaced requests nothing; a credential-bound evaluation whose
 *                credential was replaced loads, opens, reads and writes nothing; a current one evaluates normally
 */
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { parseUserId } from "@/domain/ids";
import { SimulatorWorld, simulateConsent } from "@/integrations/providers/simulator";
import type { CallbackQuery, ProviderReadPort } from "@/integrations/providers/contract";
import type { ProviderCredentialAccess } from "@/modules/connections";
import { createLocalKeyring, type LocalKeyring } from "@/platform/crypto/credentials/local-keyring";
import { createCredentialOpener } from "@/platform/crypto/credentials/open";
import { createCredentialSealer } from "@/platform/crypto/credentials/seal";
import { createPkceDeriver } from "@/platform/crypto/oauth";
import { withUserScope, type RuntimeDatabase } from "@/platform/db";
import { runTenantStepJob } from "@/platform/jobs";
import { createLogger } from "@/platform/observability";
import { createConnectionCommands } from "@/server/commands/connections";
import { completeConnectionAuthorization, startConnectionAuthorization, type ConnectionAuthorizationDependencies } from "@/server/connections/authorization";
import { authorizationProviders, createCredentialSealing, createOAuthSecrets } from "@/server/connections/runtime";
import { createLocalSimulator, type LocalSimulator } from "@/server/connections/simulator";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { createActionPipeline } from "@/server/pipeline";
import { createCredentialAccess, runDiscoverAssets, runEvaluateAccountCapabilities } from "@/jobs/connections";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { FakeIdentity, verifiedUser } from "../../support/in-memory";
import { loadScenario } from "../../providers/support/fixtures";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld, seedWorld, type World } from "../support/world";

const APP = "https://app.example.test";
const REFRESH = "capability_refresh_credential_id";

interface OutboxRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly subject_ids: Record<string, string>;
  readonly correlation_id: string;
  readonly initiator_user_id: string | null;
  readonly initiator_type: string;
  readonly dispatch_key: string;
}

export function defineCredentialRefreshSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let world: World;
  let keyring: LocalKeyring;
  let sim: LocalSimulator;
  let deps: ConnectionAuthorizationDependencies;
  const identity = new FakeIdentity();
  const logger = createLogger({ sink: () => undefined, now: () => new Date() });
  let clockMs = Date.now();
  const clock = (): Date => new Date((clockMs += 1));
  /** Counters of what the evaluation path touched (credential openings and describeAccount reads). */
  const touched = { opened: 0, described: 0 };

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const as = (user: string): void => {
    const id = parseUserId(user);
    if (id === undefined) throw new Error("uuid");
    identity.user = verifiedUser(id, `user-${user.slice(0, 8)}@example.test`);
  };
  const ownerOf = (workspace: string): string => (workspace === world.B1 ? world.users.ownerB : world.users.ownerA);
  const orgOf = (workspace: string): string => (workspace === world.B1 ? world.orgB : world.orgA);

  const countingAccess = (): ProviderCredentialAccess => {
    const real = createCredentialAccess(createCredentialOpener(keyring.unwrapper), "test");
    return {
      withCredential: (input, use) => {
        touched.opened += 1;
        return real.withCredential(input, use);
      },
    };
  };
  const providers = {
    read: (provider: string): ProviderReadPort | undefined => {
      if (provider !== "simulator") return undefined;
      return {
        ...sim.read,
        describeAccount: (access) => {
          touched.described += 1;
          return sim.read.describeAccount(access);
        },
      };
    },
  };

  const authorize = async (workspace: string, reconnectConnectionId?: string): Promise<{ readonly status: string; readonly connectionId?: string }> => {
    as(ownerOf(workspace));
    const started = await startConnectionAuthorization(deps, { workspaceId: workspace, provider: "simulator", ...(reconnectConnectionId === undefined ? {} : { reconnectConnectionId }) });
    if (started.status !== "ok") throw new Error(`start failed: ${started.status}`);
    const query: CallbackQuery = [...new URL(simulateConsent(sim.world, started.authorizationUrl, { kind: "grant", grant: "meta_full" })).searchParams];
    return completeConnectionAuthorization(deps, { provider: "simulator", query });
  };
  const activeCredential = async (connection: string): Promise<string> =>
    (await oracle<{ active_credential_id: string }>("select active_credential_id from connections.connections where id = $1", [connection]))[0]?.active_credential_id ?? "";
  const latestDiscovery = async (connection: string): Promise<OutboxRow> => {
    const row = (await oracle<OutboxRow>(
      "select id, workspace_id, subject_ids, correlation_id, initiator_user_id, initiator_type, dispatch_key from system.outbox where topic = 'connections.discover_assets' and subject_ids->>'connection_id' = $1 order by created_at desc, id limit 1",
      [connection],
    ))[0];
    if (row === undefined) throw new Error("no discovery row");
    return row;
  };
  const discover = (row: Pick<OutboxRow, "id" | "workspace_id" | "subject_ids" | "correlation_id">, workspace = row.workspace_id) =>
    runTenantStepJob(
      { registry: PRODUCTION_TASKS, worker, logger },
      "connections.discover_assets",
      { v: 1, scope: "workspace", task: "connections.discover_assets", workspaceId: workspace, outboxId: row.id, subjectIds: row.subject_ids, correlationId: row.correlation_id, initiator: { type: "system" } },
      { runId: `run_${randomUUID()}`, attempt: 1 },
      (context) => runDiscoverAssets(context, { access: countingAccess(), providers }),
    );
  /** The capability.evaluate_account rows keyed by `credential` for these accounts. */
  const credentialRequests = (accounts: readonly string[]) =>
    oracle<OutboxRow>(
      "select id, workspace_id, subject_ids, correlation_id, initiator_user_id, initiator_type, dispatch_key from system.outbox where topic = 'capability.evaluate_account' and subject_ids->>'connected_account_id' = any($1::text[]) and dispatch_key like '%:credential.%' order by dispatch_key",
      [accounts],
    );
  const evaluate = (row: OutboxRow) =>
    runTenantStepJob(
      { registry: PRODUCTION_TASKS, worker, logger },
      "capability.evaluate_account",
      { v: 1, scope: "workspace", task: "capability.evaluate_account", workspaceId: row.workspace_id, outboxId: row.id, subjectIds: row.subject_ids, correlationId: row.correlation_id, initiator: { type: "system" } },
      { runId: `run_${randomUUID()}`, attempt: 1 },
      (context) => runEvaluateAccountCapabilities(context, { access: countingAccess(), providers }),
    );
  const header = async (account: string) =>
    (await oracle<{ revision: number; facts_granted_permissions: string[]; evaluated_at: Date }>("select revision, facts_granted_permissions, evaluated_at from capability.account_profiles where connected_account_id = $1", [account]))[0];
  const link = async (workspace: string, connection: string, providerAssetId: string): Promise<string> => {
    const asset = (await oracle<{ platform: string; asset_class: string }>("select platform, asset_class from connections.discovered_assets where connection_id = $1 and provider_asset_id = $2", [connection, providerAssetId]))[0];
    if (asset === undefined) throw new Error("asset not discovered");
    const id = randomUUID();
    await withUserScope(web, { sub: ownerOf(workspace), role: "authenticated" }, workspace, (tx) => tx.execute(sql`insert into connections.connected_accounts
      (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
      values (${id}, ${orgOf(workspace)}, ${workspace}, ${connection}, ${asset.platform}, ${providerAssetId}, ${asset.asset_class}, 'ACTIVE', now(), now(), now())`));
    return id;
  };

  /** Workspace A1: one connection with FB + IG ACTIVE and one INACTIVE account. Workspace B1: another connection with an ACTIVE account. */
  let A: { connection: string; initial: OutboxRow; initialOutcome: unknown; fb: string; ig: string; inactive: string };
  let B: { connection: string; fb: string };

  beforeAll(async () => {
    const target = getTarget();
    privileged = privilegedPool(target);
    web = runtimeDatabase(target, "web", 2);
    worker = runtimeDatabase(target, "worker", 2);
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
    const created = await authorize(world.A1);
    if (created.status !== "connected" || created.connectionId === undefined) throw new Error("connect failed");
    const initial = await latestDiscovery(created.connectionId);
    const initialOutcome = await discover(initial);
    const fb = await link(world.A1, created.connectionId, "fb_page_aurora");
    const ig = await link(world.A1, created.connectionId, "ig_acct_aurora");
    const inactive = await link(world.A1, created.connectionId, "act_meta_100");
    await privileged.query("update connections.connected_accounts set status = 'INACTIVE', deactivated_at = now(), deactivation_reason = 'UNLINKED' where id = $1", [inactive]);
    A = { connection: created.connectionId, initial, initialOutcome, fb, ig, inactive };
    const other = await authorize(world.B1);
    if (other.status !== "connected" || other.connectionId === undefined) throw new Error("connect failed");
    await discover(await latestDiscovery(other.connectionId));
    B = { connection: other.connectionId, fb: await link(world.B1, other.connectionId, "fb_page_aurora") };
  });

  beforeEach(() => {
    sim.world.clearFaults();
    touched.opened = 0;
    touched.described = 0;
  });

  afterAll(async () => {
    await Promise.all([web.end(), worker.end()]);
    await privileged.query("delete from idempotency.effect_keys where workspace_id = any($1::uuid[])", [[world.A1, world.A2, world.B1]]);
    await cleanupWorld(privileged, [world.orgA, world.orgB]);
    await privileged.end();
    keyring.destroy();
  });

  const ALL = (): string[] => [A.fb, A.ig, A.inactive, B.fb];

  it("the initial authorization's discovery carries no continuation and requests nothing", async () => {
    expect(A.initial.subject_ids).toEqual({ connection_id: A.connection });
    expect(A.initialOutcome).toMatchObject({ kind: "validated", capabilityRefresh: null });
    expect(await credentialRequests(ALL())).toEqual([]);
  });

  it("an ordinary rediscovery (no continuation), with ACTIVE accounts present, requests nothing", async () => {
    const outcome = await discover({ id: randomUUID(), workspace_id: world.A1, subject_ids: { connection_id: A.connection }, correlation_id: randomUUID() });
    expect(outcome).toMatchObject({ kind: "validated", capabilityRefresh: null });
    expect(await credentialRequests(ALL())).toEqual([]);
  });

  it("a successful re-authorization's validated discovery requests ONE evaluation per ACTIVE account of the connection, idempotently", async () => {
    expect(await authorize(world.A1, A.connection)).toEqual({ status: "reauthorized", connectionId: A.connection });
    const credential = await activeCredential(A.connection);
    const row = await latestDiscovery(A.connection);
    expect(row.subject_ids).toEqual({ connection_id: A.connection, [REFRESH]: credential });
    expect(row.dispatch_key).toBe(`connections.discover_assets:${A.connection}:${credential}`);
    expect(await discover(row)).toMatchObject({ kind: "validated", capabilityRefresh: { kind: "requested", requested: 2, alreadyRequested: 0 } });
    const requests = await credentialRequests(ALL());
    expect(requests.map((r) => r.dispatch_key).sort()).toEqual([A.fb, A.ig].map((id) => `capability.evaluate_account:${id}:credential.${credential}`).sort());
    for (const request of requests) {
      expect(request.subject_ids).toEqual({ connected_account_id: request.subject_ids["connected_account_id"], credential_id: credential });
      expect([request.workspace_id, request.initiator_type, request.initiator_user_id]).toEqual([world.A1, "system", null]);
    }
    // No account event and no audit claim a human asked for these evaluations.
    expect(await oracle("select 1 from connections.connected_account_events where connected_account_id = any($1::uuid[]) and event_type = 'REEVALUATION_REQUESTED'", [[A.fb, A.ig]])).toEqual([]);
    // Redelivery of the same row: applied once.
    expect(await discover(row)).toEqual({ kind: "skipped", reason: "already_applied" });
    // Another authority for the SAME credential: the keys are taken, nothing new.
    expect(await discover({ ...row, id: randomUUID() })).toMatchObject({ kind: "validated", capabilityRefresh: { kind: "requested", requested: 0, alreadyRequested: 2 } });
    expect(await credentialRequests(ALL())).toHaveLength(2);
    // Nothing was evaluated by discovery itself.
    expect(touched.described).toBe(0);
  });

  it("the credential-bound evaluation of a CURRENT credential runs the normal path and refreshes the permission facts", async () => {
    const credential = await activeCredential(A.connection);
    const request = (await credentialRequests([A.fb])).find((r) => r.subject_ids["credential_id"] === credential);
    if (request === undefined) throw new Error("no request");
    expect(await evaluate(request)).toMatchObject({ kind: "evaluated", factsAvailable: true, write: { kind: "applied" } });
    expect([touched.opened, touched.described]).toEqual([1, 1]);
    expect((await header(A.fb))?.facts_granted_permissions.length).toBeGreaterThan(0);
  });

  it("after ANOTHER re-authorization, the older credential's evaluation and discovery do nothing; the new credential gets its own requests", async () => {
    const older = await activeCredential(A.connection);
    const pending = (await credentialRequests([A.ig])).find((r) => r.subject_ids["credential_id"] === older);
    if (pending === undefined) throw new Error("no pending request");
    const before = await header(A.ig);
    expect(await authorize(world.A1, A.connection)).toEqual({ status: "reauthorized", connectionId: A.connection });
    const newer = await activeCredential(A.connection);
    expect(newer).not.toBe(older);
    // Stale evaluation: superseded before anything is loaded, opened, read or written.
    expect(await evaluate(pending)).toEqual({ kind: "skipped", reason: "superseded" });
    expect([touched.opened, touched.described]).toEqual([0, 0]);
    expect(await header(A.ig)).toEqual(before);
    // Stale discovery: an authority for the older credential, run now, validates but requests nothing.
    const stale = await discover({ id: randomUUID(), workspace_id: world.A1, subject_ids: { connection_id: A.connection, [REFRESH]: older }, correlation_id: randomUUID() });
    expect(stale).toMatchObject({ kind: "validated", capabilityRefresh: { kind: "superseded" } });
    expect((await credentialRequests([A.fb, A.ig])).filter((r) => r.subject_ids["credential_id"] === older)).toHaveLength(2);
    // The newer credential's own discovery: its own two requests.
    expect(await discover(await latestDiscovery(A.connection))).toMatchObject({ capabilityRefresh: { kind: "requested", requested: 2, alreadyRequested: 0 } });
    const all = await credentialRequests(ALL());
    expect(all.filter((r) => r.subject_ids["credential_id"] === newer).map((r) => r.subject_ids["connected_account_id"]).sort()).toEqual([A.fb, A.ig].sort());
    expect(all.some((r) => r.subject_ids["connected_account_id"] === A.inactive || r.subject_ids["connected_account_id"] === B.fb)).toBe(false);
  });

  it("a re-authorization whose discovery does not validate requests nothing (the new credential stays current)", async () => {
    expect(await authorize(world.B1, B.connection)).toEqual({ status: "reauthorized", connectionId: B.connection });
    const credential = await activeCredential(B.connection);
    sim.world.injectFaults([{ operation: "discoverAssets", on: 1, fault: { kind: "credential_invalid", reason: "revoked" } }]);
    expect(await discover(await latestDiscovery(B.connection))).toMatchObject({ kind: "failed", problem: "CREDENTIAL_REVOKED" });
    expect(await credentialRequests([B.fb])).toEqual([]);
    expect(await activeCredential(B.connection)).toBe(credential);
  });

  it("a discovery run bound to another workspace sees nothing and requests nothing", async () => {
    const row = await latestDiscovery(A.connection);
    const count = (await credentialRequests(ALL())).length;
    expect(await discover({ ...row, id: randomUUID() }, world.B1)).toEqual({ kind: "skipped", reason: "not_found" });
    expect(await credentialRequests(ALL())).toHaveLength(count);
  });
}
