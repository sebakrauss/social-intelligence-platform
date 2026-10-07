/**
 * Step 5D — connection authorization lifecycle on the real database, end to end against the provider SIMULATOR:
 * the real action pipeline and PostgreSQL unit of work (web login → authenticated + claims + sealed workspace),
 * the real orchestration, the local keyring (seal in the web, open only through the job-side credential-access
 * function), and the discovery job through the real tenant step wrapper (worker login → app_worker + sealed
 * workspace). Synthetic data only; simulator behavior is never evidence about Meta or TikTok.
 *
 *   start        state never stored (digest only), verifier never stored (derived, B1), S256 challenge, roles
 *   callback     digest + creator + workspace + provider + PENDING + unexpired; replay/concurrency exactly once
 *   exchange     every normalized outcome; exactly one provider exchange; OutcomeUnknown never replayed
 *   credential   bytes → seal → envelope only; no plaintext anywhere (tables, outbox, audit, logs); bound context
 *   discovery    one workspace, one connection; idempotent per outbox row; CONNECTING → ACTIVE / FAILED
 *   removal      REMOVED + pointer cleared + crypto-shred; idempotent; cross-workspace NOT_FOUND
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseUserId } from "@/domain/ids";
import { SimulatorWorld, simulateConsent, type SimulatedConsent } from "@/integrations/providers/simulator";
import type { CallbackQuery } from "@/integrations/providers/contract";
import { CredentialUnreadableError } from "@/modules/connections";
import { createPostgresConnectionStore } from "@/modules/connections/persistence";
import { createLocalKeyring, type LocalKeyring } from "@/platform/crypto/credentials/local-keyring";
import { createCredentialOpener } from "@/platform/crypto/credentials/open";
import { createCredentialSealer } from "@/platform/crypto/credentials/seal";
import { createPkceDeriver, type PkceDeriver } from "@/platform/crypto/oauth";
import { withUserScope, type RuntimeDatabase } from "@/platform/db";
import { runTenantStepJob } from "@/platform/jobs";
import { createLogger, type Logger } from "@/platform/observability";
import { createConnectionCommands, type ConnectionCommands } from "@/server/commands/connections";
import { completeConnectionAuthorization, startConnectionAuthorization, type ConnectionAuthorizationDependencies } from "@/server/connections/authorization";
import { authorizationProviders, createCredentialSealing, createOAuthSecrets } from "@/server/connections/runtime";
import { createLocalSimulator, type LocalSimulator } from "@/server/connections/simulator";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { createActionPipeline } from "@/server/pipeline";
import { createCredentialAccess, runDiscoverAssets } from "@/jobs/connections";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { FakeIdentity, verifiedUser } from "../../support/in-memory";
import { errorCode, expectOk } from "../../support/harness";
import { loadScenario } from "../../providers/support/fixtures";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld, seedWorld, type World } from "../support/world";
import { sqlState } from "./helpers";

const APP = "https://app.example.test";
const REDIRECT = `${APP}/api/oauth/simulator/callback`;
const sha256 = (value: string): string => createHash("sha256").update(value, "ascii").digest("hex");
const queryOf = (url: string): CallbackQuery => [...new URL(url).searchParams];

interface OutboxRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly subject_ids: Record<string, string>;
  readonly correlation_id: string;
  readonly initiator_user_id: string;
}

export function defineConnectionLifecycleSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let world: World;
  let keyring: LocalKeyring;
  let deriver: PkceDeriver;
  let sim: LocalSimulator;
  let commands: ConnectionCommands;
  let deps: ConnectionAuthorizationDependencies;
  let logger: Logger;
  const identity = new FakeIdentity();
  const logLines: string[] = [];
  let clockMs = Date.now();
  /** Strictly monotonic (1 ms per read): rows written by successive commands never tie on time. */
  const clock = (): Date => new Date((clockMs += 1));

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const as = (user: string): void => {
    const id = parseUserId(user);
    if (id === undefined) throw new Error("uuid");
    identity.user = verifiedUser(id, `user-${user.slice(0, 8)}@example.test`);
  };
  const exchanges = (): number => sim.world.journal.filter((entry) => entry.operation === "exchangeCode").length;

  const begin = async (workspace: string, reconnectConnectionId?: string): Promise<{ readonly url: string; readonly state: string }> => {
    const started = await startConnectionAuthorization(deps, { workspaceId: workspace, provider: "simulator", ...(reconnectConnectionId === undefined ? {} : { reconnectConnectionId }) });
    if (started.status !== "ok") throw new Error(`start failed: ${JSON.stringify(started)}`);
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    if (state === null) throw new Error("no state");
    return { url: started.authorizationUrl, state };
  };
  const consent = (url: string, decision: SimulatedConsent = { kind: "grant", grant: "meta_full" }): CallbackQuery => queryOf(simulateConsent(sim.world, url, decision));
  const callback = (query: CallbackQuery, provider = "simulator") => completeConnectionAuthorization(deps, { provider, query });
  const attemptByState = async (state: string) =>
    (await oracle<{ id: string; status: string; failure_code: string | null; exchange_started_at: Date | null; closed_at: Date | null; pkce_envelope: Buffer | null; pkce_secret_id: string | null; state_digest: string; redirect_uri: string; expires_at: Date; created_at: Date }>(
      "select * from connections.connect_attempts where state_digest = $1", [sha256(state)]))[0];
  const connectionRow = async (id: string) =>
    (await oracle<{ status: string; active_credential_id: string | null; last_problem_code: string | null; version: number }>("select * from connections.connections where id = $1", [id]))[0];
  const credentialRows = (connection: string) =>
    oracle<{ id: string; credential_version: number; envelope: Buffer }>("select id, credential_version, envelope from credentials.provider_credentials where connection_id = $1 order by credential_version", [connection]);
  const latestDiscovery = async (connection: string): Promise<OutboxRow> => {
    const row = (await oracle<OutboxRow>(
      "select id, workspace_id, subject_ids, correlation_id, initiator_user_id from system.outbox where topic = 'connections.discover_assets' and subject_ids->>'connection_id' = $1 order by created_at desc, id limit 1",
      [connection],
    ))[0];
    if (row === undefined) throw new Error("no discovery outbox row");
    return row;
  };
  const jobBase = () => ({
    access: createCredentialAccess(createCredentialOpener(keyring.unwrapper), "test"),
    providers: { read: (provider: string) => (provider === "simulator" ? sim.read : undefined) },
  });
  const discover = (row: OutboxRow, workspace = row.workspace_id) =>
    runTenantStepJob(
      { registry: PRODUCTION_TASKS, worker, logger },
      "connections.discover_assets",
      { v: 1, scope: "workspace", task: "connections.discover_assets", workspaceId: workspace, outboxId: row.id, subjectIds: row.subject_ids, correlationId: row.correlation_id, initiator: { type: "user", userId: row.initiator_user_id } },
      { runId: `run_${randomUUID()}`, attempt: 1 },
      (context) => runDiscoverAssets(context, jobBase()),
    );

  /** A fresh, connected (CONNECTING) simulator connection in `workspace`. */
  const connectFresh = async (workspace: string, decision?: SimulatedConsent): Promise<{ readonly connectionId: string; readonly state: string; readonly query: CallbackQuery }> => {
    const { url, state } = await begin(workspace);
    const query = consent(url, decision);
    const result = await callback(query);
    if (result.status !== "connected") throw new Error(`connect failed: ${JSON.stringify(result)}`);
    return { connectionId: result.connectionId, state, query };
  };

  /** Every row of the schemas that could ever hold a secret, as text (bytea rendered as hex). */
  const everything = async (): Promise<string> => {
    const tables = await oracle<{ name: string }>(
      `select table_schema || '.' || table_name as name from information_schema.tables
        where table_schema in ('connections', 'credentials', 'audit', 'system', 'idempotency') and table_type = 'BASE TABLE'`);
    const dumps: string[] = [];
    for (const { name } of tables) dumps.push(...(await oracle<{ row: string }>(`select t::text as row from ${name} t`)).map((r) => r.row));
    return dumps.join("\n");
  };
  const hex = (value: string): string => Buffer.from(value, "utf8").toString("hex");
  const expectAbsent = (haystack: string, secrets: readonly string[]): void => {
    for (const secret of secrets) {
      expect(haystack).not.toContain(secret);
      expect(haystack).not.toContain(hex(secret));
    }
  };

  beforeAll(async () => {
    const target = getTarget();
    privileged = privilegedPool(target);
    web = runtimeDatabase(target, "web", 3);
    worker = runtimeDatabase(target, "worker", 2);
    world = await seedWorld(privileged);
    await privileged.query("update tenancy.workspaces set mode = 'MONITOR_ONLY' where id = $1", [world.A2]);
    keyring = createLocalKeyring(randomBytes(32), { NODE_ENV: "test" });
    deriver = createPkceDeriver(randomBytes(32));
    sim = createLocalSimulator(new SimulatorWorld(loadScenario("baseline")));
    const secrets = createOAuthSecrets(deriver);
    const providers = authorizationProviders({ simulator: sim.authorization }, APP);
    commands = createConnectionCommands({ secrets, providers });
    logger = createLogger({ sink: (line) => logLines.push(line), now: clock });
    deps = {
      pipeline: createActionPipeline({ identity, unitOfWork: createPostgresUnitOfWork(web), clock, newId: randomUUID, logger }),
      commands,
      providers,
      secrets,
      sealing: createCredentialSealing(createCredentialSealer(keyring.generator), "test"),
      newId: randomUUID,
      logger,
    };
  });

  beforeEach(() => {
    sim.world.reset();
    clockMs = Date.now();
    as(world.users.ownerA);
  });

  afterAll(async () => {
    await Promise.all([web.end(), worker.end()]);
    await privileged.query("delete from idempotency.effect_keys where workspace_id = any($1::uuid[])", [[world.A1, world.A2, world.B1]]);
    await cleanupWorld(privileged, [world.orgA, world.orgB]);
    await privileged.end();
    keyring.destroy();
    deriver.destroy();
  });

  describe("start authorization", () => {
    it("stores only the state digest, never the state or a verifier, and sends an S256 challenge of the derived verifier", async () => {
      const { url, state } = await begin(world.A1);
      const params = new URL(url).searchParams;
      expect(params.get("redirect_uri")).toBe(REDIRECT);
      expect(state).toMatch(new RegExp(`^v1\\.${world.A1}\\.[A-Za-z0-9_-]{43}$`));
      const verifier = deriver.verifier(state);
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(params.get("code_challenge")).toBe(createHash("sha256").update(verifier, "ascii").digest("base64url"));
      expect(params.get("code_challenge_method")).toBe("S256");
      expect(url).not.toContain(verifier);
      const attempt = await attemptByState(state);
      expect(attempt).toMatchObject({ status: "PENDING", redirect_uri: REDIRECT, pkce_envelope: null, pkce_secret_id: null, exchange_started_at: null });
      expect((attempt?.expires_at.getTime() ?? 0) - (attempt?.created_at.getTime() ?? 0)).toBe(10 * 60 * 1000);
      expectAbsent(await everything(), [state, verifier, state.split(".")[2] ?? "missing"]);
      expectAbsent(logLines.join("\n"), [state, verifier]);
    });

    it("is refused to Managers, guests and non-members; allowed in a Monitor-only workspace (configuration, not a mutation)", async () => {
      as(world.users.a1);
      expect(await startConnectionAuthorization(deps, { workspaceId: world.A1, provider: "simulator" })).toEqual({ status: "error", code: "PERMISSION_DENIED" });
      as(world.users.guest);
      expect(await startConnectionAuthorization(deps, { workspaceId: world.A1, provider: "simulator" })).toEqual({ status: "error", code: "PERMISSION_DENIED" });
      as(world.users.ownerB);
      expect(await startConnectionAuthorization(deps, { workspaceId: world.A1, provider: "simulator" })).toEqual({ status: "error", code: "NOT_FOUND" });
      as(world.users.ownerA);
      expect((await startConnectionAuthorization(deps, { workspaceId: world.A2, provider: "simulator" })).status).toBe("ok");
      expect(await startConnectionAuthorization(deps, { workspaceId: world.A1, provider: "meta" })).toEqual({ status: "error", code: "INVALID_INPUT" });
    });
  });

  describe("callback verification", () => {
    it("a valid callback connects once: one exchange, COMPLETED attempt, CONNECTING connection with an active credential", async () => {
      const { url, state } = await begin(world.A1);
      const result = await callback(consent(url));
      expect(result.status).toBe("connected");
      expect(exchanges()).toBe(1);
      const attempt = await attemptByState(state);
      expect(attempt).toMatchObject({ status: "COMPLETED", failure_code: null });
      expect(attempt?.exchange_started_at).not.toBeNull();
      if (result.status !== "connected") return;
      const connection = await connectionRow(result.connectionId);
      expect(connection).toMatchObject({ status: "CONNECTING", version: 2 });
      const credentials = await credentialRows(result.connectionId);
      expect(credentials.map((c) => [c.id, c.credential_version])).toEqual([[connection?.active_credential_id, 1]]);
      const events = await oracle<{ reason_code: string; new_status: string; actor_type: string }>("select reason_code, new_status, actor_type from connections.connection_events where connection_id = $1", [result.connectionId]);
      expect(events).toEqual([{ reason_code: "AUTHORIZED", new_status: "CONNECTING", actor_type: "user" }]);
      const audit = await oracle<{ action: string; actor_type: string }>("select action, actor_type from audit.audit_events where target_id = $1", [result.connectionId]);
      expect(audit).toEqual([{ action: "connection.created", actor_type: "user" }]);
      const outbox = await latestDiscovery(result.connectionId);
      expect(outbox.subject_ids).toEqual({ connection_id: result.connectionId });
    });

    it("rejects a modified state, an unknown routing prefix and a foreign workspace prefix — without side effects", async () => {
      const { url, state } = await begin(world.A1);
      const query = consent(url);
      const nonce = state.split(".")[2] ?? "";
      const tamper = (value: string): CallbackQuery => query.map(([k, v]) => [k, k === "state" ? value : v] as const);
      const flipped = `${nonce.slice(0, -1)}${nonce.endsWith("A") ? "B" : "A"}`;
      expect(await callback(tamper(`v1.${world.A1}.${flipped}`))).toEqual({ status: "restart_required", reason: "not_found" });
      expect(await callback(tamper(`v1.${randomUUID()}.${nonce}`))).toEqual({ status: "restart_required", reason: "not_found" });
      expect(await callback(tamper(`v1.${world.A2}.${nonce}`))).toEqual({ status: "restart_required", reason: "not_found" });
      expect(await callback(tamper(`x${state}`))).toEqual({ status: "restart_required", reason: "not_found" });
      expect(exchanges()).toBe(0);
      expect((await attemptByState(state))?.status).toBe("PENDING");
      expect((await callback(query)).status).toBe("connected");
    });

    it("rejects an expired attempt without touching it", async () => {
      const { url, state } = await begin(world.A1);
      clockMs += 11 * 60 * 1000;
      expect(await callback(consent(url))).toEqual({ status: "restart_required", reason: "not_found" });
      expect(exchanges()).toBe(0);
      expect((await attemptByState(state))?.status).toBe("PENDING");
    });

    it("a replayed callback can't exchange again, and concurrent duplicates resolve to exactly one connection", async () => {
      const { url } = await begin(world.A1);
      const query = consent(url);
      expect((await callback(query)).status).toBe("connected");
      expect(await callback(query)).toEqual({ status: "restart_required", reason: "not_found" });
      expect(exchanges()).toBe(1);

      const second = await begin(world.A1);
      const duplicate = consent(second.url);
      const before = exchanges();
      const results = await Promise.all([callback(duplicate), callback(duplicate), callback(duplicate)]);
      expect(results.filter((r) => r.status === "connected")).toHaveLength(1);
      expect(results.filter((r) => r.status === "restart_required")).toHaveLength(2);
      expect(exchanges() - before).toBe(1);
      const connected = results.find((r) => r.status === "connected");
      if (connected?.status === "connected") expect(await credentialRows(connected.connectionId)).toHaveLength(1);
    });

    it("the claim itself is a conditional UPDATE: of two racing transactions exactly one wins, and a closed attempt can't be claimed", async () => {
      const { state } = await begin(world.A1);
      const attempt = await attemptByState(state);
      if (attempt === undefined) throw new Error("no attempt");
      const claimIn = (hold?: Promise<void>) =>
        withUserScope(web, { sub: world.users.ownerA, role: "authenticated" }, world.A1, async (tx) => {
          const won = await createPostgresConnectionStore(tx).attempts.claim(attempt.id, new Date());
          await hold;
          return won;
        });
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const first = claimIn(held);
      await new Promise((resolve) => setTimeout(resolve, 200)); // the first claim now holds the row lock, uncommitted
      const second = claimIn();
      await new Promise((resolve) => setTimeout(resolve, 200)); // the second claim is blocked on that lock
      release();
      expect(await Promise.all([first, second])).toEqual([true, false]);
      expect((await attemptByState(state))?.status).toBe("EXCHANGING");
      expect(await claimIn()).toBe(false);
    });

    it("a denial is verified first, closes the attempt DENIED, and creates nothing", async () => {
      const { url, state } = await begin(world.A1);
      const connectionsBefore = (await oracle("select id from connections.connections where workspace_id = $1", [world.A1])).length;
      expect(await callback(consent(url, { kind: "deny", error: "user_cancelled" }))).toEqual({ status: "denied" });
      expect((await attemptByState(state))?.status).toBe("DENIED");
      expect((await oracle("select id from connections.connections where workspace_id = $1", [world.A1])).length).toBe(connectionsBefore);
      expect(exchanges()).toBe(0);
      // A forged denial for someone else's state changes nothing either.
      expect(await callback([["error", "access_denied"], ["state", `v1.${world.A1}.${"A".repeat(43)}`]])).toEqual({ status: "restart_required", reason: "not_found" });
    });

    it("a malformed callback or an unknown provider path stops before any lookup", async () => {
      const { url, state } = await begin(world.A1);
      const query = consent(url);
      expect(await callback([...query, ["state", state]])).toEqual({ status: "restart_required", reason: "invalid_callback" });
      expect(await callback(query, "meta")).toEqual({ status: "restart_required", reason: "invalid_callback" });
      expect(await callback([["state", state]])).toEqual({ status: "restart_required", reason: "invalid_callback" });
      expect(exchanges()).toBe(0);
      expect((await attemptByState(state))?.status).toBe("PENDING");
    });

    it("another user of the same workspace can't complete someone else's attempt", async () => {
      await privileged.query("update tenancy.workspace_memberships set role = 'ADMIN' where workspace_id = $1 and user_id = $2", [world.A1, world.users.a1]);
      try {
        const { url, state } = await begin(world.A1);
        as(world.users.a1);
        expect(await callback(consent(url))).toEqual({ status: "restart_required", reason: "not_found" });
        expect((await attemptByState(state))?.status).toBe("PENDING");
        expect(exchanges()).toBe(0);
      } finally {
        await privileged.query("update tenancy.workspace_memberships set role = 'MANAGER' where workspace_id = $1 and user_id = $2", [world.A1, world.users.a1]);
      }
    });
  });

  describe("code exchange outcomes (exactly one provider call each, never retried)", () => {
    const failed = async (prepare: () => void, decision: SimulatedConsent | undefined, expected: { status: string; failure: string | null }, reason: string) => {
      const { url, state } = await begin(world.A1);
      const query = consent(url, decision);
      prepare();
      expect(await callback(query)).toEqual({ status: "restart_required", reason });
      expect(exchanges()).toBe(1);
      expect(await attemptByState(state)).toMatchObject({ status: expected.status, failure_code: expected.failure });
      return state;
    };

    it.each([
      ["permission missing", (): void => undefined, { kind: "grant", grant: "tiktok_without_discovery" } as const, "EXCHANGE_FAILED", "PERMISSION_MISSING", "exchange_failed"],
      ["transient (not retried with the same code)", (): void => { sim.world.applyFaultPreset("exchange_transient"); }, undefined, "EXCHANGE_FAILED", "PROVIDER_UNAVAILABLE", "exchange_failed"],
      ["rate limited", (): void => { sim.world.applyFaultPreset("exchange_rate_limited"); }, undefined, "EXCHANGE_FAILED", "RATE_LIMITED", "exchange_failed"],
      ["outcome unknown (fresh connection)", (): void => { sim.world.applyFaultPreset("exchange_response_lost"); }, undefined, "OUTCOME_UNKNOWN", null, "outcome_unknown"],
    ] as const)("%s: closed with a closed code, no connection, no credential", async (_label, prepare, decision, status, failure, reason) => {
      const before = await oracle("select id from connections.connections where workspace_id = $1", [world.A1]);
      await failed(prepare, decision, { status, failure }, reason);
      expect(await oracle("select id from connections.connections where workspace_id = $1", [world.A1])).toHaveLength(before.length);
    });

    it("an invalid code is a definite failure", async () => {
      const { url, state } = await begin(world.A1);
      const query = consent(url).map(([k, v]) => [k, k === "code" ? "sim-code-baseline-forged-0001" : v] as const);
      expect(await callback(query)).toEqual({ status: "restart_required", reason: "exchange_failed" });
      expect(await attemptByState(state)).toMatchObject({ status: "EXCHANGE_FAILED", failure_code: "CREDENTIAL_INVALID" });
      expect(exchanges()).toBe(1);
    });

    it("a sealing failure after a successful exchange stores nothing and never replays the code", async () => {
      const { url, state } = await begin(world.A1);
      const failing = { ...deps, sealing: { seal: () => Promise.reject(new Error("keyring unavailable")) } };
      expect(await completeConnectionAuthorization(failing, { provider: "simulator", query: consent(url) })).toEqual({ status: "restart_required", reason: "not_stored" });
      expect(await attemptByState(state)).toMatchObject({ status: "EXCHANGE_FAILED", failure_code: "CREDENTIAL_NOT_STORED" });
      expect(exchanges()).toBe(1);
    });

    it("a stale EXCHANGING attempt is recovered as OUTCOME_UNKNOWN by the next start, and its late result is refused", async () => {
      const { url, state } = await begin(world.A1);
      const query = consent(url);
      // Claim without exchanging (as if the process died right after the claim).
      const claimed = expectOk(await deps.pipeline.run(commands.verify, { workspaceId: world.A1, input: { provider: "simulator", stateDigest: sha256(state), kind: "code" } }));
      if (claimed === "denied") throw new Error("unexpected");
      clockMs += 3 * 60 * 1000;
      await begin(world.A1);
      expect((await attemptByState(state))?.status).toBe("OUTCOME_UNKNOWN");
      // A late completion for the obsolete attempt writes nothing.
      const late = await deps.pipeline.run(commands.complete, {
        workspaceId: world.A1,
        input: { attemptId: claimed.attemptId, credentialId: randomUUID(), envelope: new Uint8Array(64).fill(1), expiresAt: null },
      });
      expect(errorCode(late)).toBe("CONFLICT");
      expect(expectOk(await deps.pipeline.run(commands.fail, { workspaceId: world.A1, input: { attemptId: claimed.attemptId, outcome: "OUTCOME_UNKNOWN" } }))).toBe(false);
      // And the original callback can never exchange that code now.
      expect(await callback(query)).toEqual({ status: "restart_required", reason: "not_found" });
      expect(exchanges()).toBe(0);
    });
  });

  describe("attempt state shape (0008: EXCHANGING is open; closed_at only on terminal transitions)", () => {
    const shape = async (state: string) => {
      const row = await attemptByState(state);
      if (row === undefined) throw new Error("no attempt");
      const closed = row.closed_at;
      return { status: row.status, started: row.exchange_started_at !== null, closed: closed !== null, failure: row.failure_code, closedAt: closed, startedAt: row.exchange_started_at };
    };

    it("PENDING → EXCHANGING → COMPLETED: claim sets exchange_started_at only; completion sets closed_at", async () => {
      const { url, state } = await begin(world.A1);
      expect(await shape(state)).toMatchObject({ status: "PENDING", started: false, closed: false, failure: null });
      consent(url);
      expectOk(await deps.pipeline.run(commands.verify, { workspaceId: world.A1, input: { provider: "simulator", stateDigest: sha256(state), kind: "code" } }));
      expect(await shape(state)).toMatchObject({ status: "EXCHANGING", started: true, closed: false, failure: null });
      // The orchestration path completes a fresh attempt the same way (claim → exchange → COMPLETED).
      const fresh = await begin(world.A1);
      expect((await callback(consent(fresh.url))).status).toBe("connected");
      expect(await shape(fresh.state)).toMatchObject({ status: "COMPLETED", started: true, closed: true, failure: null });
    });

    it("EXCHANGE_FAILED and OUTCOME_UNKNOWN carry both timestamps; DENIED and EXPIRED carry closed_at only", async () => {
      const failing = await begin(world.A1);
      const failingQuery = consent(failing.url);
      sim.world.applyFaultPreset("exchange_transient");
      await callback(failingQuery);
      expect(await shape(failing.state)).toMatchObject({ status: "EXCHANGE_FAILED", started: true, closed: true, failure: "PROVIDER_UNAVAILABLE" });

      const lost = await begin(world.A1);
      const lostQuery = consent(lost.url);
      sim.world.applyFaultPreset("exchange_response_lost");
      await callback(lostQuery);
      expect(await shape(lost.state)).toMatchObject({ status: "OUTCOME_UNKNOWN", started: true, closed: true, failure: null });

      const denied = await begin(world.A1);
      await callback(consent(denied.url, { kind: "deny", error: "access_denied" }));
      expect(await shape(denied.state)).toMatchObject({ status: "DENIED", started: false, closed: true, failure: null });

      const expiring = await begin(world.A1);
      clockMs += 11 * 60 * 1000;
      await begin(world.A1);
      expect(await shape(expiring.state)).toMatchObject({ status: "EXPIRED", started: false, closed: true, failure: null });
    });

    it("a stale EXCHANGING attempt gets closed_at only when recovery converts it to OUTCOME_UNKNOWN", async () => {
      const { state } = await begin(world.A1);
      expectOk(await deps.pipeline.run(commands.verify, { workspaceId: world.A1, input: { provider: "simulator", stateDigest: sha256(state), kind: "code" } }));
      clockMs += 60 * 1000;
      await begin(world.A1); // not stale yet: untouched, still open
      expect(await shape(state)).toMatchObject({ status: "EXCHANGING", started: true, closed: false });
      clockMs += 2 * 60 * 1000;
      await begin(world.A1);
      const recovered = await shape(state);
      expect(recovered).toMatchObject({ status: "OUTCOME_UNKNOWN", started: true, closed: true, failure: null });
      expect((recovered.closedAt?.getTime() ?? 0) > (recovered.startedAt?.getTime() ?? Number.POSITIVE_INFINITY)).toBe(true);
    });

    it("the revised constraints accept exactly the valid (status, exchange_started_at, closed_at) shapes — identical for pre-0008 statuses", async () => {
      const client = await privileged.connect();
      const outcomes: Record<string, string> = {};
      try {
        await client.query("begin");
        const statuses = ["PENDING", "EXCHANGING", "COMPLETED", "DENIED", "EXPIRED", "CANCELLED", "EXCHANGE_FAILED", "OUTCOME_UNKNOWN"];
        const all = statuses.flatMap((status) => [false, true].flatMap((started) => [false, true].map((closed) => [status, started, closed, status === "EXCHANGE_FAILED" ? "PROVIDER_UNAVAILABLE" : null] as const)));
        for (const [status, started, closed, failure] of all) {
          await client.query("savepoint shape");
          try {
            await client.query(
              `insert into connections.connect_attempts (id, organization_id, workspace_id, provider, created_by, state_digest, redirect_uri, status, expires_at, created_at, closed_at, exchange_started_at, failure_code)
               values ($1, $2, $3, 'simulator', $4, $5, $6, $7, now() + interval '5 minutes', now() - interval '1 minute', $8, $9, $10)`,
              [randomUUID(), world.orgA, world.A1, world.users.ownerA, sha256(randomUUID()), REDIRECT, status, closed ? new Date() : null, started ? new Date(Date.now() - 30_000) : null, failure],
            );
            outcomes[`${status}:${String(started)}:${String(closed)}`] = "ok";
          } catch (error) {
            outcomes[`${status}:${String(started)}:${String(closed)}`] = (error as { constraint?: string }).constraint ?? "error";
          }
          await client.query("rollback to savepoint shape");
        }
      } finally {
        await client.query("rollback");
        client.release();
      }
      const accepted = Object.entries(outcomes).filter(([, outcome]) => outcome === "ok").map(([key]) => key).sort();
      expect(accepted).toEqual([
        "CANCELLED:false:true",
        "COMPLETED:true:true",
        "DENIED:false:true",
        "EXCHANGE_FAILED:true:true",
        "EXCHANGING:true:false",
        "EXPIRED:false:true",
        "OUTCOME_UNKNOWN:true:true",
        "PENDING:false:false",
      ]);
      // Pre-0008 statuses: closed_recorded behaves exactly as in 0007 (open ⇔ PENDING).
      expect(outcomes["PENDING:false:true"]).toBe("connect_attempts_closed_recorded");
      for (const status of ["DENIED", "EXPIRED", "CANCELLED"]) expect(outcomes[`${status}:false:false`]).toBe("connect_attempts_closed_recorded");
      // The only expansion: EXCHANGING is open.
      expect(outcomes["EXCHANGING:true:true"]).toBe("connect_attempts_closed_recorded");
      expect(outcomes["COMPLETED:true:false"]).toBe("connect_attempts_closed_recorded");
      expect(outcomes["EXCHANGING:false:false"]).toBe("connect_attempts_exchange_recorded");
      expect(outcomes["DENIED:true:true"]).toBe("connect_attempts_exchange_recorded");
      const definition = await oracle<{ def: string }>(
        "select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'connections.connect_attempts'::regclass and conname = 'connect_attempts_closed_recorded' and convalidated");
      expect(definition[0]?.def).toMatch(/status = ANY \(ARRAY\['PENDING'::text, 'EXCHANGING'::text\]\)\) = \(closed_at IS NULL\)/);
    });
  });

  describe("credentials", () => {
    it("no plaintext credential, code, state or verifier reaches any table, the outbox, the audit log or the logs", async () => {
      const { connectionId, state, query } = await connectFresh(world.A1);
      const code = query.find(([k]) => k === "code")?.[1] ?? "missing";
      const active = (await connectionRow(connectionId))?.active_credential_id;
      const tokens = sim.world.scenario.credentials.map((c) => c.secret);
      const issuedSecrets = [...Array(5).keys()].map((n) => `sim-access-token-baseline-${String(n + 1)}`);
      const dump = await everything();
      expectAbsent(dump, [state, deriver.verifier(state), code, ...issuedSecrets, ...tokens]);
      expect(dump).not.toContain("sim://");
      expectAbsent(logLines.join("\n"), [state, deriver.verifier(state), code, ...issuedSecrets]);
      expect(active).toBeDefined();
    });

    it("the envelope opens only for its own workspace and credential, only through the job-side access function", async () => {
      const { connectionId } = await connectFresh(world.A1);
      const credentialId = (await connectionRow(connectionId))?.active_credential_id ?? "";
      const envelope = new Uint8Array((await credentialRows(connectionId))[0]?.envelope ?? Buffer.alloc(0));
      const access = jobBase().access;
      const id = await access.withCredential({ workspaceId: world.A1 as never, credentialId, envelope }, (credential) => Promise.resolve(credential.id));
      expect(id).toMatch(/^sim-cred-/);
      await expect(access.withCredential({ workspaceId: world.A2 as never, credentialId, envelope }, () => Promise.resolve("opened"))).rejects.toBeInstanceOf(CredentialUnreadableError);
      await expect(access.withCredential({ workspaceId: world.A1 as never, credentialId: randomUUID(), envelope }, () => Promise.resolve("opened"))).rejects.toBeInstanceOf(CredentialUnreadableError);
      // The web role can't load envelopes at all (no EXECUTE on load_envelope; seal-only web, TA §39).
      expect((await sqlState(withUserScope(web, { sub: world.users.ownerA, role: "authenticated" }, world.A1, (tx) =>
        tx.execute(sql`select * from credentials.load_envelope(${credentialId}::uuid)`))))).toMatchObject({ code: "42501" });
    });
  });

  describe("discovery job", () => {
    it("validates the connection: normalized assets, CONNECTING → ACTIVE, event and system audit; idempotent per outbox row", async () => {
      const { connectionId } = await connectFresh(world.A1);
      const row = await latestDiscovery(connectionId);
      expect(await discover(row)).toEqual({ kind: "validated", status: "ACTIVE", assets: 3 });
      const assets = await oracle<{ platform: string; provider_asset_id: string; asset_class: string }>(
        "select platform, provider_asset_id, asset_class from connections.discovered_assets where connection_id = $1 order by provider_asset_id", [connectionId]);
      expect(assets).toEqual([
        { platform: "facebook", provider_asset_id: "act_meta_100", asset_class: "ad_account" },
        { platform: "facebook", provider_asset_id: "fb_page_aurora", asset_class: "content_bearing" },
        { platform: "instagram", provider_asset_id: "ig_acct_aurora", asset_class: "content_bearing" },
      ]);
      expect(await connectionRow(connectionId)).toMatchObject({ status: "ACTIVE", last_problem_code: null });
      const audit = await oracle<{ action: string; actor_type: string }>("select action, actor_type from audit.audit_events where target_id = $1 order by occurred_at, action", [connectionId]);
      expect(audit.filter((a) => a.actor_type === "system").map((a) => a.action).sort()).toEqual(["connection.status_changed", "connection.validated"]);
      // Redelivery of the same outbox row: no second effect.
      expect(await discover(row)).toEqual({ kind: "skipped", reason: "already_applied" });
      expect(await oracle("select id from connections.discovered_assets where connection_id = $1", [connectionId])).toHaveLength(3);
    });

    it("runs in exactly the payload's workspace: a foreign workspace sees nothing", async () => {
      const { connectionId } = await connectFresh(world.A1);
      const row = await latestDiscovery(connectionId);
      expect(await discover(row, world.A2)).toEqual({ kind: "skipped", reason: "not_found" });
      expect((await connectionRow(connectionId))?.status).toBe("CONNECTING");
    });

    it("a definite credential failure FAILS the initial validation and keeps the credential; transient failures retry without changes", async () => {
      const { connectionId } = await connectFresh(world.A1);
      const row = await latestDiscovery(connectionId);
      sim.world.injectFaults([{ operation: "discoverAssets", on: 1, fault: { kind: "transient", reason: "provider_unavailable" } }]);
      await expect(discover(row)).rejects.toMatchObject({ kind: "transient" });
      expect((await connectionRow(connectionId))?.status).toBe("CONNECTING");
      sim.world.injectFaults([{ operation: "discoverAssets", on: 1, fault: { kind: "credential_invalid", reason: "revoked" } }]);
      expect(await discover(row)).toEqual({ kind: "failed", status: "FAILED", problem: "CREDENTIAL_REVOKED" });
      expect(await connectionRow(connectionId)).toMatchObject({ status: "FAILED", last_problem_code: "CREDENTIAL_REVOKED" });
      expect(await credentialRows(connectionId)).toHaveLength(1);
    });
  });

  describe("re-authorization", () => {
    it("swaps the active credential atomically, shreds only the superseded envelope, keeps the connection id", async () => {
      const { connectionId } = await connectFresh(world.A1);
      await discover(await latestDiscovery(connectionId));
      const old = (await connectionRow(connectionId))?.active_credential_id;
      const { url } = await begin(world.A1, connectionId);
      expect(await callback(consent(url))).toEqual({ status: "reauthorized", connectionId });
      const after = await connectionRow(connectionId);
      expect(after?.status).toBe("ACTIVE");
      expect(after?.active_credential_id).not.toBe(old);
      const credentials = await credentialRows(connectionId);
      expect(credentials.map((c) => c.id)).toEqual([after?.active_credential_id]);
      expect(credentials[0]?.credential_version).toBeGreaterThan(1);
      const audit = await oracle<{ action: string }>("select action from audit.audit_events where target_id = $1 and actor_type = 'user'", [connectionId]);
      expect(audit.map((a) => a.action).sort()).toEqual(["connection.created", "connection.credential_replaced"]);
      expect((await discover(await latestDiscovery(connectionId))).kind).toBe("validated");
    });

    it("OutcomeUnknown during re-authorization leaves the connection and its active credential untouched", async () => {
      const { connectionId } = await connectFresh(world.A1);
      await discover(await latestDiscovery(connectionId));
      const before = await connectionRow(connectionId);
      const envelopes = (await credentialRows(connectionId)).map((c) => c.id);
      const { url, state } = await begin(world.A1, connectionId);
      const query = consent(url);
      sim.world.applyFaultPreset("exchange_response_lost");
      expect(await callback(query)).toEqual({ status: "restart_required", reason: "outcome_unknown" });
      expect(await connectionRow(connectionId)).toEqual(before);
      expect((await credentialRows(connectionId)).map((c) => c.id)).toEqual(envelopes);
      expect((await attemptByState(state))?.status).toBe("OUTCOME_UNKNOWN");
    });

    it("a re-authorization target in another workspace, or removed, is NOT_FOUND at start", async () => {
      const { connectionId } = await connectFresh(world.A1);
      expect(await startConnectionAuthorization(deps, { workspaceId: world.A2, provider: "simulator", reconnectConnectionId: connectionId })).toEqual({ status: "error", code: "NOT_FOUND" });
      expectOk(await deps.pipeline.run(commands.remove, { workspaceId: world.A1, input: { connectionId } }));
      expect(await startConnectionAuthorization(deps, { workspaceId: world.A1, provider: "simulator", reconnectConnectionId: connectionId })).toEqual({ status: "error", code: "NOT_FOUND" });
    });
  });

  describe("removal", () => {
    it("REMOVED, pointer cleared, envelope crypto-shredded, event and audit; repeating is a no-op; discovery then skips", async () => {
      const { connectionId } = await connectFresh(world.A1);
      const row = await latestDiscovery(connectionId);
      expect(expectOk(await deps.pipeline.run(commands.remove, { workspaceId: world.A1, input: { connectionId } }))).toEqual({ changed: true });
      expect(await connectionRow(connectionId)).toMatchObject({ status: "REMOVED", active_credential_id: null });
      expect(await credentialRows(connectionId)).toEqual([]);
      const events = await oracle<{ reason_code: string }>("select reason_code from connections.connection_events where connection_id = $1 order by occurred_at", [connectionId]);
      expect(events.map((e) => e.reason_code)).toEqual(["AUTHORIZED", "REMOVED_BY_USER"]);
      expect(expectOk(await deps.pipeline.run(commands.remove, { workspaceId: world.A1, input: { connectionId } }))).toEqual({ changed: false });
      expect(await oracle("select 1 from audit.audit_events where target_id = $1 and action = 'connection.removed'", [connectionId])).toHaveLength(1);
      expect(await discover(row)).toEqual({ kind: "skipped", reason: "not_found" });
    });

    it("is NOT_FOUND across workspaces and organizations, and refused to Managers", async () => {
      const { connectionId } = await connectFresh(world.A1);
      expect(errorCode(await deps.pipeline.run(commands.remove, { workspaceId: world.A2, input: { connectionId } }))).toBe("NOT_FOUND");
      as(world.users.ownerB);
      expect(errorCode(await deps.pipeline.run(commands.remove, { workspaceId: world.B1, input: { connectionId } }))).toBe("NOT_FOUND");
      as(world.users.a1);
      expect(errorCode(await deps.pipeline.run(commands.remove, { workspaceId: world.A1, input: { connectionId } }))).toBe("PERMISSION_DENIED");
      expect((await connectionRow(connectionId))?.status).toBe("CONNECTING");
      expect(await credentialRows(connectionId)).toHaveLength(1);
    });
  });

  describe("read models", () => {
    it("members see status and closed codes only; guests see nothing", async () => {
      const { connectionId } = await connectFresh(world.A1);
      await discover(await latestDiscovery(connectionId));
      as(world.users.a1);
      const detail = expectOk(await deps.pipeline.run(commands.get, { workspaceId: world.A1, input: { connectionId } }));
      expect(detail).toMatchObject({ id: connectionId, provider: "simulator", status: "ACTIVE", hasCredential: true });
      expect(Object.keys(detail).sort()).toEqual(["authorizedAt", "discoveredAssets", "hasCredential", "id", "lastProblemCode", "lastSuccessAt", "provider", "status"]);
      expect(JSON.stringify(detail)).not.toMatch(/credential_id|envelope|sim-access-token/);
      as(world.users.guest);
      expect(errorCode(await deps.pipeline.run(commands.list, { workspaceId: world.A1, input: {} }))).toBe("PERMISSION_DENIED");
    });
  });
}
