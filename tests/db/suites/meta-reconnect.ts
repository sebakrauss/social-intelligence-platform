/**
 * Step 7G-H5.5-P12-C0-R2 — Reconnect Meta, the product entry, on the real database: the Settings orchestration
 * (`reconnectMeta`) through the real action pipeline and web unit of work, the real Meta authorization adapter (its
 * token transport is an in-process double: nothing calls Meta), the callback orchestration, and the real discovery
 * handler through the tenant step wrapper. Proves the product reaches the EXISTING re-authorization of the SAME logical
 * connection, and that the R1 continuation stays the backend's: only a successful completion carries it, and a denied,
 * failed or refused reconnect leaves the connection, its credential and the outbox untouched.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseUserId } from "@/domain/ids";
import {
  BUDGET_NOT_REPORTED,
  SecretValue,
  providerObjectRef,
  rawReference,
  type CallbackQuery,
  type ProviderAuthorizationPort,
  type ProviderReadPort,
} from "@/integrations/providers/contract";
import { createMetaAuthorizationPort } from "@/integrations/providers/meta/authorization";
import { META_DIALOG_URL } from "@/integrations/providers/meta/endpoints";
import { createMetaTokenTransport, type MetaTokenOutcome, type MetaTokenTransport } from "@/integrations/providers/meta/oauth-transport";
import type { CredentialSealing, ProviderCredentialAccess } from "@/modules/connections";
import { createLocalKeyring, type LocalKeyring } from "@/platform/crypto/credentials/local-keyring";
import { createCredentialOpener } from "@/platform/crypto/credentials/open";
import { createCredentialSealer } from "@/platform/crypto/credentials/seal";
import { createPkceDeriver } from "@/platform/crypto/oauth";
import type { RuntimeDatabase } from "@/platform/db";
import { runTenantStepJob } from "@/platform/jobs";
import { createLogger, type Logger } from "@/platform/observability";
import { createConnectionCommands } from "@/server/commands/connections";
import { completeConnectionAuthorization, type ConnectionAuthorizationDependencies } from "@/server/connections/authorization";
import { authorizationProviders, createCredentialSealing, createOAuthSecrets } from "@/server/connections/runtime";
import { connectMeta, reconnectMeta, type ConnectOutcome } from "@/server/connections/settings";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { createActionPipeline } from "@/server/pipeline";
import { createCredentialAccess, runDiscoverAssets } from "@/jobs/connections";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { FakeIdentity, verifiedUser } from "../../support/in-memory";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";

const APP = "https://app.example.test";
const CODE_MARKER = "synthetic-meta-auth-code-marker";
const TOKEN_MARKER = "synthetic-meta-access-token-marker";
const REFRESH = "capability_refresh_credential_id";

interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly owner: string;
  readonly manager: string;
}

interface OutboxRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly subject_ids: Record<string, string>;
  readonly correlation_id: string;
  readonly initiator_user_id: string;
}

export function defineMetaReconnectSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let keyring: LocalKeyring;
  let logger: Logger;
  let base: Omit<ConnectionAuthorizationDependencies, "pipeline">;
  let access: ProviderCredentialAccess;
  const organizations: string[] = [];
  let clockMs = Date.now();
  const clock = (): Date => new Date((clockMs += 1));
  let exchanges = 0;
  /** Every log line the web side wrote (sanitized JSON), for the R5-shape event and secrecy checks. */
  const logLines: string[] = [];
  /** The next token exchange's outcome (default: a synthetic token). */
  let nextExchange: MetaTokenOutcome | undefined;
  /** When set, the next exchange runs the REAL token transport over this 200 JSON body (in-process fetch; no request leaves). */
  let nextTokenBody: Record<string, unknown> | undefined;

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const countOf = async (query: string, values: readonly unknown[]): Promise<number> => (await oracle<{ n: number }>(query, values))[0]?.n ?? -1;
  const depsFor = (id: string): ConnectionAuthorizationDependencies => {
    const user = parseUserId(id);
    if (user === undefined) throw new Error("uuid");
    return { ...base, pipeline: createActionPipeline({ identity: new FakeIdentity(verifiedUser(user)), unitOfWork: createPostgresUnitOfWork(web), clock, newId: randomUUID, logger }) };
  };
  const stateOf = (outcome: ConnectOutcome): string => {
    if (outcome.kind !== "authorize") throw new Error(`not started: ${JSON.stringify(outcome)}`);
    expect(outcome.url.startsWith(`${META_DIALOG_URL}?`)).toBe(true);
    const state = new URL(outcome.url).searchParams.get("state");
    if (state === null) throw new Error("no state");
    return state;
  };
  const granted = (state: string): CallbackQuery => [["code", CODE_MARKER], ["state", state]];
  const denied = (state: string): CallbackQuery => [["error", "access_denied"], ["error_reason", "user_denied"], ["state", state]];
  const callback = (id: string, query: CallbackQuery) => completeConnectionAuthorization(depsFor(id), { provider: "meta", query });

  // ── Synthetic tenants (privileged bootstrap) ─────────────────────────────────────────────────────────────────
  const tenant = async (): Promise<Tenant> => {
    const t: Tenant = { organizationId: randomUUID(), workspaceId: randomUUID(), owner: randomUUID(), manager: randomUUID() };
    organizations.push(t.organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Reconnect', now())", [t.organizationId]);
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'STANDARD', now())", [t.workspaceId, t.organizationId]);
    for (const [member, orgRole, role] of [[t.owner, "OWNER", "OWNER"], [t.manager, "MEMBER", "MANAGER"]] as const) {
      await privileged.query("insert into tenancy.organization_memberships values ($1, $2, $3, now())", [t.organizationId, member, orgRole]);
      await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, $4, '{}', now())", [t.organizationId, t.workspaceId, member, role]);
    }
    return t;
  };
  const sibling = async (t: Tenant): Promise<string> => {
    const workspace = randomUUID();
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W2', 'STANDARD', now())", [workspace, t.organizationId]);
    await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, 'OWNER', '{}', now())", [t.organizationId, workspace, t.owner]);
    return workspace;
  };
  const seedAccount = async (t: Tenant, connection: string, status: "ACTIVE" | "INACTIVE"): Promise<string> => {
    const id = randomUUID();
    const providerAssetId = `page-${randomUUID().slice(0, 12)}`;
    await privileged.query(
      `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'facebook', $5, 'content_bearing', 'Synthetic Page', now(), now(), now())`,
      [randomUUID(), t.organizationId, t.workspaceId, connection, providerAssetId],
    );
    await privileged.query(
      `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, deactivated_at, deactivation_reason, created_at, updated_at)
       values ($1, $2, $3, $4, 'facebook', $5, 'content_bearing', $6, now(), $7, $8, now(), now())`,
      [id, t.organizationId, t.workspaceId, connection, providerAssetId, status, status === "ACTIVE" ? null : new Date(), status === "ACTIVE" ? null : "UNLINKED"],
    );
    return id;
  };

  // ── Oracle reads ─────────────────────────────────────────────────────────────────────────────────────────────
  const connectionRow = async (id: string) =>
    (await oracle<{ status: string; active_credential_id: string | null; version: number }>("select status, active_credential_id, version from connections.connections where id = $1", [id]))[0];
  const metaConnections = (workspace: string) => countOf("select count(*)::int as n from connections.connections where workspace_id = $1 and provider = 'meta'", [workspace]);
  const credentials = (connection: string) => countOf("select count(*)::int as n from credentials.provider_credentials where connection_id = $1", [connection]);
  const reconnectAttempts = (connection: string) => countOf("select count(*)::int as n from connections.connect_attempts where reconnect_connection_id = $1", [connection]);
  const discoveryRows = (connection: string) =>
    oracle<OutboxRow>(
      "select id, workspace_id, subject_ids, correlation_id, initiator_user_id from system.outbox where topic = 'connections.discover_assets' and subject_ids->>'connection_id' = $1 order by created_at, id",
      [connection],
    );
  const markedDiscoveries = (connection: string) =>
    countOf("select count(*)::int as n from system.outbox where topic = 'connections.discover_assets' and subject_ids->>'connection_id' = $1 and subject_ids ? $2", [connection, REFRESH]);
  const credentialRequests = (accounts: readonly string[]) =>
    oracle<{ subject_ids: Record<string, string> }>(
      "select subject_ids from system.outbox where topic = 'capability.evaluate_account' and subject_ids->>'connected_account_id' = any($1::text[]) and dispatch_key like '%:credential.%'",
      [accounts],
    );
  const events = (connection: string, reason: string) => countOf("select count(*)::int as n from connections.connection_events where connection_id = $1 and reason_code = $2", [connection, reason]);

  // ── Discovery job (real wrapper, worker login) with an in-process read port ──────────────────────────────────
  const readPort = {
    discoverAssets: () =>
      Promise.resolve({
        data: [{ ref: providerObjectRef("facebook", "asset", "page-reconnect-0001"), assetClass: "content_bearing", displayName: "Synthetic Page", relatedAssets: [], rawReference: rawReference("meta", "v25.0", "facebook:page:page-reconnect-0001") }],
        budget: BUDGET_NOT_REPORTED,
      }),
  } as unknown as ProviderReadPort;
  const discover = (row: OutboxRow) =>
    runTenantStepJob(
      { registry: PRODUCTION_TASKS, worker, logger },
      "connections.discover_assets",
      { v: 1, scope: "workspace", task: "connections.discover_assets", workspaceId: row.workspace_id, outboxId: row.id, subjectIds: row.subject_ids, correlationId: row.correlation_id, initiator: { type: "user", userId: row.initiator_user_id } },
      { runId: `run_${randomUUID()}`, attempt: 1 },
      (context) => runDiscoverAssets(context, { access, providers: { read: (provider: string) => (provider === "meta" ? readPort : undefined) } }),
    );

  /** A real fresh Meta Connection through the product start, validated by its (unmarked) discovery: ACTIVE. */
  const connected = async (t: Tenant): Promise<string> => {
    const result = await callback(t.owner, granted(stateOf(await connectMeta(depsFor(t.owner), t.workspaceId))));
    if (result.status !== "connected") throw new Error(`connect failed: ${JSON.stringify(result)}`);
    const [initial, ...rest] = await discoveryRows(result.connectionId);
    if (initial === undefined || rest.length > 0) throw new Error("expected exactly one discovery row");
    expect(initial.subject_ids).toEqual({ connection_id: result.connectionId });
    expect(await discover(initial)).toMatchObject({ kind: "validated", status: "ACTIVE", capabilityRefresh: null });
    exchanges = 0; // count only what the test itself exchanges
    return result.connectionId;
  };

  beforeAll(() => {
    const target = getTarget();
    privileged = privilegedPool(target, 2);
    web = runtimeDatabase(target, "web", 2);
    worker = runtimeDatabase(target, "worker", 2);
    keyring = createLocalKeyring(randomBytes(32), { NODE_ENV: "test" });
    logger = createLogger({ sink: (line) => logLines.push(line), now: clock });
    access = createCredentialAccess(createCredentialOpener(keyring.unwrapper), "test");
    const transport: MetaTokenTransport = {
      exchange(request) {
        exchanges += 1;
        const body = nextTokenBody;
        nextTokenBody = undefined;
        if (body !== undefined) {
          const fetch = () => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
          return createMetaTokenTransport({ fetch }).exchange(request);
        }
        const outcome = nextExchange ?? { kind: "token", accessToken: new SecretValue(TOKEN_MARKER), expiresInSeconds: 3600 };
        nextExchange = undefined;
        return Promise.resolve(outcome);
      },
    };
    const meta: ProviderAuthorizationPort = createMetaAuthorizationPort(
      { clientId: "synthetic-meta-app-id", configId: "synthetic-meta-config-id", clientSecret: new SecretValue("synthetic-meta-app-secret-marker") },
      { transport },
    );
    const sealing: CredentialSealing = createCredentialSealing(createCredentialSealer(keyring.generator), "test");
    const secrets = createOAuthSecrets(createPkceDeriver(randomBytes(32)));
    const providers = authorizationProviders({ meta }, APP);
    base = { commands: createConnectionCommands({ secrets, providers }), providers, secrets, sealing, newId: randomUUID, logger };
  });

  beforeEach(() => {
    exchanges = 0;
    nextExchange = undefined;
    nextTokenBody = undefined;
  });

  afterAll(async () => {
    await Promise.all([web.end(), worker.end()]);
    await privileged.query("delete from idempotency.effect_keys where workspace_id in (select id from tenancy.workspaces where organization_id = any($1::uuid[]))", [organizations]);
    await cleanupWorld(privileged, organizations);
    await privileged.end();
    keyring.destroy();
  });

  describe("a successful reconnect re-authorizes the SAME connection", () => {
    it("the product start targets the existing connection; completion is `reauthorized`; one logical connection, its credential replaced", async () => {
      const t = await tenant();
      const connection = await connected(t);
      const before = await connectionRow(connection);
      const state = stateOf(await reconnectMeta(depsFor(t.owner), { workspaceId: t.workspaceId, connectionId: connection }));
      expect(await reconnectAttempts(connection)).toBe(1);
      expect(await callback(t.owner, granted(state))).toEqual({ status: "reauthorized", connectionId: connection });
      expect(exchanges).toBe(1);
      const after = await connectionRow(connection);
      expect(after?.status).toBe("ACTIVE");
      expect(after?.active_credential_id).not.toBe(before?.active_credential_id);
      expect(await metaConnections(t.workspaceId)).toBe(1);
      expect(await credentials(connection)).toBe(1); // the old envelope was shredded in the same transaction
      expect(await events(connection, "REAUTHORIZED")).toBe(1);
      // Initial authorization is unchanged: a fresh Connect is still refused while this connection lives.
      expect(await connectMeta(depsFor(t.owner), t.workspaceId)).toEqual({ kind: "status", status: "existing_connection" });
    });

    it("its discovery — and only its — carries the backend continuation for the new credential; validated, it requests one evaluation per ACTIVE account", async () => {
      const t = await tenant();
      const connection = await connected(t);
      const active = await seedAccount(t, connection, "ACTIVE");
      const inactive = await seedAccount(t, connection, "INACTIVE");
      expect(await markedDiscoveries(connection)).toBe(0);
      const state = stateOf(await reconnectMeta(depsFor(t.owner), { workspaceId: t.workspaceId, connectionId: connection }));
      expect(await callback(t.owner, granted(state))).toEqual({ status: "reauthorized", connectionId: connection });
      const credential = (await connectionRow(connection))?.active_credential_id;
      const rows = await discoveryRows(connection);
      expect(rows).toHaveLength(2);
      expect(rows[1]?.subject_ids).toEqual({ connection_id: connection, [REFRESH]: credential });
      expect(await markedDiscoveries(connection)).toBe(1);
      const row = rows[1];
      if (row === undefined) throw new Error("no row");
      expect(await discover(row)).toMatchObject({ kind: "validated", capabilityRefresh: { kind: "requested", requested: 1, alreadyRequested: 0 } });
      expect(await credentialRequests([active, inactive])).toEqual([{ subject_ids: { connected_account_id: active, credential_id: credential } }]);
      // No human re-check is fabricated.
      expect(await countOf("select count(*)::int as n from connections.connected_account_events where connected_account_id = any($1::uuid[]) and event_type = 'REEVALUATION_REQUESTED'", [[active, inactive]])).toBe(0);
    });
  });

  describe("a token without expires_in is accepted with expiry UNKNOWN (Step 7G-H5.5-P12-C0-R5F; real transport parsing)", () => {
    const credentialRows = (connection: string) =>
      oracle<{ id: string; credential_version: number; expires_at: Date | null }>("select id, credential_version, expires_at from credentials.provider_credentials where connection_id = $1 order by credential_version", [connection]);

    it("an initial authorization succeeds, stores the credential with expires_at NULL, and validates normally", async () => {
      const t = await tenant();
      nextTokenBody = { access_token: TOKEN_MARKER, token_type: "bearer" };
      const result = await callback(t.owner, granted(stateOf(await connectMeta(depsFor(t.owner), t.workspaceId))));
      if (result.status !== "connected") throw new Error(`connect failed: ${JSON.stringify(result)}`);
      const rows = await credentialRows(result.connectionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.expires_at).toBeNull();
      expect((await connectionRow(result.connectionId))?.active_credential_id).toBe(rows[0]?.id);
      const [initial] = await discoveryRows(result.connectionId);
      if (initial === undefined) throw new Error("no discovery");
      expect(initial.subject_ids).toEqual({ connection_id: result.connectionId });
      expect(await discover(initial)).toMatchObject({ kind: "validated", status: "ACTIVE", capabilityRefresh: null });
    });

    it("the critical reconnect: reauthorized, SAME connection, ONE new credential (version +1, expires_at NULL), the old one destroyed, REAUTHORIZED, the R1 continuation, and its capability refresh", async () => {
      const t = await tenant();
      const connection = await connected(t); // its credential has a known expiry (expires_in 3600)
      const active = await seedAccount(t, connection, "ACTIVE");
      const inactive = await seedAccount(t, connection, "INACTIVE");
      const before = await connectionRow(connection);
      const [old] = await credentialRows(connection);
      expect(old?.expires_at).not.toBeNull();
      nextTokenBody = { access_token: TOKEN_MARKER, token_type: "bearer" };
      const state = stateOf(await reconnectMeta(depsFor(t.owner), { workspaceId: t.workspaceId, connectionId: connection }));
      expect(await callback(t.owner, granted(state))).toEqual({ status: "reauthorized", connectionId: connection });
      expect(exchanges).toBe(1);
      expect(await metaConnections(t.workspaceId)).toBe(1);
      const rows = await credentialRows(connection);
      expect(rows).toHaveLength(1); // the previous envelope was shredded in the same transaction
      const [fresh] = rows;
      expect(fresh?.id).not.toBe(old?.id);
      expect(fresh?.credential_version).toBe((before?.version ?? 0) + 1);
      expect(fresh?.expires_at).toBeNull();
      expect((await connectionRow(connection))?.active_credential_id).toBe(fresh?.id);
      expect(await events(connection, "REAUTHORIZED")).toBe(1);
      const discoveries = await discoveryRows(connection);
      expect(discoveries).toHaveLength(2);
      const marked = discoveries[1];
      if (marked === undefined) throw new Error("no reconnect discovery");
      expect(marked.subject_ids).toEqual({ connection_id: connection, [REFRESH]: fresh?.id });
      expect(await discover(marked)).toMatchObject({ kind: "validated", capabilityRefresh: { kind: "requested", requested: 1, alreadyRequested: 0 } });
      expect(await credentialRequests([active, inactive])).toEqual([{ subject_ids: { connected_account_id: active, credential_id: fresh?.id } }]);
      expect(await countOf("select count(*)::int as n from connections.connected_account_events where connected_account_id = any($1::uuid[]) and event_type = 'REEVALUATION_REQUESTED'", [[active, inactive]])).toBe(0);
    });
  });

  describe("a reconnect that doesn't complete changes nothing and creates no continuation", () => {
    const unchanged = async (t: Tenant, connection: string, query: (state: string) => CallbackQuery, expected: unknown, exchanged: number) => {
      const before = await connectionRow(connection);
      const discoveries = (await discoveryRows(connection)).length;
      const state = stateOf(await reconnectMeta(depsFor(t.owner), { workspaceId: t.workspaceId, connectionId: connection }));
      expect(await callback(t.owner, query(state))).toEqual(expected);
      expect(exchanges).toBe(exchanged);
      expect(await connectionRow(connection)).toEqual(before);
      expect(await credentials(connection)).toBe(1);
      expect(await discoveryRows(connection)).toHaveLength(discoveries);
      expect(await markedDiscoveries(connection)).toBe(0);
      expect(await events(connection, "REAUTHORIZED")).toBe(0);
    };

    it("cancelled at Meta (denied): no exchange, the connection and its credential untouched, no discovery", async () => {
      const t = await tenant();
      await unchanged(t, await connected(t), denied, { status: "denied" }, 0);
    });

    it("a definite exchange failure, or an ambiguous one: closed restart, nothing stored, no discovery", async () => {
      const t = await tenant();
      const connection = await connected(t);
      nextExchange = { kind: "graph_error", error: { code: 190, subcode: null, oauthException: true } };
      await unchanged(t, connection, granted, { status: "restart_required", reason: "exchange_failed" }, 1);
      exchanges = 0;
      nextExchange = { kind: "ambiguous", reason: "network_error" };
      await unchanged(t, connection, granted, { status: "restart_required", reason: "outcome_unknown" }, 1);
    });

    it("expires_in PRESENT but malformed (real transport parsing): restart_required, the closed `expires_in_invalid` reason logged without secrets, everything preserved, zero downstream authority", async () => {
      const t = await tenant();
      const connection = await connected(t);
      const active = await seedAccount(t, connection, "ACTIVE");
      logLines.length = 0;
      nextTokenBody = { access_token: TOKEN_MARKER, token_type: "bearer", expires_in: "5400" };
      const before = await connectionRow(connection);
      const state = stateOf(await reconnectMeta(depsFor(t.owner), { workspaceId: t.workspaceId, connectionId: connection }));
      expect(await callback(t.owner, granted(state))).toEqual({ status: "restart_required", reason: "outcome_unknown" });
      expect(exchanges).toBe(1); // exactly one exchange, never retried
      expect(await oracle("select status, failure_code from connections.connect_attempts where reconnect_connection_id = $1", [connection])).toEqual([{ status: "OUTCOME_UNKNOWN", failure_code: null }]);
      expect(await connectionRow(connection)).toEqual(before);
      expect(await credentials(connection)).toBe(1);
      expect(await events(connection, "REAUTHORIZED")).toBe(0);
      expect(await discoveryRows(connection)).toHaveLength(1); // the initial one only
      expect(await markedDiscoveries(connection)).toBe(0);
      expect(await credentialRequests([active])).toEqual([]);
      expect(await countOf("select count(*)::int as n from connections.connected_account_events where connected_account_id = $1 and event_type = 'REEVALUATION_REQUESTED'", [active])).toBe(0);
      const events_ = logLines.map((line) => (JSON.parse(line) as { event: string }).event).filter((event) => event.startsWith("connections.authorization.exchange_"));
      expect(events_).toEqual(["connections.authorization.exchange_ambiguous.token_response_expires_in_invalid", "connections.authorization.exchange_closed.outcome_unknown"]);
      const rendered = logLines.join("\n");
      for (const secret of [TOKEN_MARKER, CODE_MARKER, state, "synthetic-meta-app-secret-marker", "client_secret", "access_token="]) expect(rendered).not.toContain(secret);
    });
  });

  describe("reconnect is scoped to the caller's workspace and that workspace's live Meta connection", () => {
    it("another workspace's connection, another organization's caller, a manager, a REMOVED or a non-Meta connection: refused, nothing started", async () => {
      const t = await tenant();
      const connection = await connected(t);
      const other = await tenant();
      const elsewhere = await sibling(t);
      const before = await connectionRow(connection);
      // The same owner, routed through a sibling workspace: the connection isn't that workspace's (RLS + scope).
      expect(await reconnectMeta(depsFor(t.owner), { workspaceId: elsewhere, connectionId: connection })).toEqual({ kind: "status", status: "connection_not_found" });
      // Another organization's owner, through this workspace or their own: the same closed answer, no oracle.
      expect(await reconnectMeta(depsFor(other.owner), { workspaceId: t.workspaceId, connectionId: connection })).toEqual({ kind: "status", status: "connection_not_found" });
      expect(await reconnectMeta(depsFor(other.owner), { workspaceId: other.workspaceId, connectionId: connection })).toEqual({ kind: "status", status: "connection_not_found" });
      // A member without connections.manage.
      expect(await reconnectMeta(depsFor(t.manager), { workspaceId: t.workspaceId, connectionId: connection })).toEqual({ kind: "status", status: "not_allowed" });
      expect(await reconnectAttempts(connection)).toBe(0);
      expect(await connectionRow(connection)).toEqual(before);
      // A REMOVED Meta connection and a simulator connection of this workspace.
      const removed = randomUUID();
      const simulator = randomUUID();
      for (const [id, provider, status] of [[removed, "meta", "REMOVED"], [simulator, "simulator", "ACTIVE"]] as const) {
        await privileged.query(
          `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
           values ($1, $2, $3, $4, $5, null, $6, now(), 1, now(), now())`,
          [id, t.organizationId, t.workspaceId, provider, status, t.owner],
        );
        expect(await reconnectMeta(depsFor(t.owner), { workspaceId: t.workspaceId, connectionId: id })).toEqual({ kind: "status", status: "connection_not_found" });
        expect(await reconnectAttempts(id)).toBe(0);
      }
      expect(exchanges).toBe(0);
    });

    it("a reconnect state can't be completed by another user, even a manager of the same workspace", async () => {
      const t = await tenant();
      const connection = await connected(t);
      const before = await connectionRow(connection);
      const state = stateOf(await reconnectMeta(depsFor(t.owner), { workspaceId: t.workspaceId, connectionId: connection }));
      expect(await callback(t.manager, granted(state))).toEqual({ status: "restart_required", reason: "not_found" });
      expect(exchanges).toBe(0);
      expect(await connectionRow(connection)).toEqual(before);
      expect(await markedDiscoveries(connection)).toBe(0);
    });
  });
}
