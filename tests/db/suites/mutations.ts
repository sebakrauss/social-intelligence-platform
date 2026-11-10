/**
 * Step 7B-1 — the Platform Mutation Executor on the real database (migration 0027), simulator only (no Meta, no network):
 *
 *   request      the REAL action pipeline over the REAL PostgreSQL unit of work (web login, `authenticated`, sealed
 *                workspace): a Responder's request writes the PENDING intent, its reply text, ONE web history row, the
 *                member's audit event and the IDs-only outbox row — atomically; a repeated key answers the existing
 *                intent; Analyst/Guest are PERMISSION_DENIED; a member of another workspace is NOT_FOUND
 *   isolation    RLS: another workspace's member and a guest read 0 rows; a member cannot insert a non-PENDING intent,
 *                an intent attributed to someone else, a worker history row, or update an intent at all (no grant);
 *                a cross-workspace target or account fails exactly like a non-existent one (composite FK, 23503); the
 *                idempotency key is unique per workspace (23505); the initiator-role definer answers for the bound
 *                workspace only
 *   execution    the REAL relay → FakeJobRuntime → the REAL INTEGRATION handler (runTenantStepJob → runExecuteIntent)
 *                with the simulator's mutation port: EXECUTING committed before the call, CONFIRMED with the created
 *                reply's provider id, two `system` audit events, three history rows, the reply confirmed; a lost
 *                response → OUTCOME_UNKNOWN → reconciliation through the READ port finds the reply → CONFIRMED (never
 *                a resend: exactly one reply on the platform); Monitor-only at execution time → BLOCKED, nothing sent
 */
import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SimulatorWorld, createSimulatorReadPort, parseScenario } from "@/integrations/providers/simulator";
import { createSimulatorMutationPort } from "@/integrations/providers/simulator/mutation-port";
import { SIMULATOR_CATALOG, evaluateAndStore, type FactsInput } from "@/modules/capability";
import { createPostgresCapabilityStore } from "@/modules/capability/persistence";
import type { DiscoveryProviders, ProviderCredentialAccess } from "@/modules/connections";
import { parseUserId } from "@/domain/ids";
import { withUserScope, withWorkspaceJobScope, type RuntimeDatabase } from "@/platform/db";
import { runTenantStepJob } from "@/platform/jobs";
import { relayPass, sweepRunOutcomes, type DeliveryConfig, type DeliveryDependencies } from "@/platform/outbox/delivery";
import { createLogger, type Logger } from "@/platform/observability";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { createActionPipeline, type ActionPipeline } from "@/server/pipeline";
import { requestPublicReplyCommand } from "@/server/commands/mutations";
import { inboxConversationCommand } from "@/server/queries/inbox";
import { runExecuteIntent, runReconcileIntent, type MutationComposition } from "@/jobs/mutations";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { FakeJobRuntime, type FakeHandler } from "../../support/fake-job-runtime";
import { rawScenario } from "../../providers/support/fixtures";
import { clearSwitch, setSwitch } from "../../../tools/ops/switches";
import { FakeIdentity, verifiedUser } from "../../support/in-memory";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";
import { quietPendingOutbox, sqlState } from "./helpers";

const CONFIG: DeliveryConfig = {
  batchSize: 200,
  leaseSeconds: 30,
  backoff: { baseSeconds: 5, maxSeconds: 60 },
  dispatchSweepMinAgeSeconds: 60,
  dispatchSloSeconds: 120,
  maxRecoveries: 3,
  outcomeBatchSize: 200,
  unknownObservation: { maxChecks: 4, maxSeconds: 600 },
};
const TASK = "mutations.execute_intent";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ROLES = ["OWNER", "RESPONDER", "ANALYST_VIEWER", "CLIENT_GUEST"] as const;
const TEXT = "Gracias por escribirnos (7B-1 DB).";
const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(what);
  return value;
};

/** The baseline scenario moved to the present (the simulator's clock must not precede the request). */
function presentScenario() {
  const raw = rawScenario("baseline");
  const delta = Date.now() + 10 * 60_000 - Date.parse(String(raw["clockStart"]));
  const shift = (value: unknown): unknown => {
    if (typeof value === "string" && ISO.test(value)) return new Date(Date.parse(value) + delta).toISOString();
    if (Array.isArray(value)) return value.map(shift);
    if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shift(inner)]));
    return value;
  };
  return parseScenario(shift(raw));
}

interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly users: Readonly<Record<(typeof ROLES)[number], string>>;
  readonly connection: string;
  readonly account: string;
  readonly content: string;
  /** A canonical, observed, visible audience comment (the simulator's fb_c_010). */
  readonly comment: string;
  /** The brand's own comment (author role account_identity). */
  readonly own: string;
  /** A hidden comment. */
  readonly hidden: string;
  /** The audience author row (for seeding more comments). */
  readonly audience: string;
}

interface SecondAccount {
  readonly account: string;
  readonly content: string;
  readonly comment: string;
}

export function defineMutationsSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let system: RuntimeDatabase<"system">;
  let logger: Logger;
  const organizations: string[] = [];
  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;

  const tenant = async (mode: "STANDARD" | "MONITOR_ONLY" = "STANDARD"): Promise<Tenant> => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    organizations.push(organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Mutations', now())", [organizationId]);
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', $3, now())", [workspaceId, organizationId, mode]);
    const users = {} as Record<(typeof ROLES)[number], string>;
    for (const role of ROLES) {
      const user = randomUUID();
      users[role] = user;
      await privileged.query("insert into tenancy.organization_memberships values ($1, $2, $3, now())", [organizationId, user, role === "OWNER" ? "OWNER" : "MEMBER"]);
      await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, $4, '{}', now())", [organizationId, workspaceId, user, role]);
    }
    const connection = randomUUID();
    const credential = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, 'simulator', 'ACTIVE', null, $4, now(), 1, now(), now())`,
      [connection, organizationId, workspaceId, users.OWNER],
    );
    await privileged.query(
      `insert into credentials.provider_credentials (id, organization_id, workspace_id, connection_id, credential_version, envelope, created_at) values ($1, $2, $3, $4, 1, $5, now())`,
      [credential, organizationId, workspaceId, connection, Buffer.concat([Buffer.from("5349504501", "hex"), randomBytes(64)])],
    );
    await privileged.query("update connections.connections set active_credential_id = $1 where id = $2", [credential, connection]);
    const discovered = randomUUID();
    await privileged.query(
      `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'facebook', 'fb_page_aurora', 'content_bearing', 'Synthetic', now(), now(), now())`,
      [discovered, organizationId, workspaceId, connection],
    );
    const account = randomUUID();
    await privileged.query(
      `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
       select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`,
      [account, discovered],
    );
    const facts: FactsInput = { kind: "available", assetClass: "content_bearing", grantedPermissions: ["sim.read_content", "sim.read_interactions", "sim.reply_public"], linkedAdAccountIds: [], accountIdentityKnown: true, obtainedAt: new Date() };
    await withWorkspaceJobScope(worker, workspaceId, (tx) =>
      evaluateAndStore(createPostgresCapabilityStore(tx), { organizationId, workspaceId, connectedAccountId: account, catalog: SIMULATOR_CATALOG, platform: "facebook", assetClass: "content_bearing", facts, observations: [], evaluatedAt: new Date() }),
    );
    // Canonical rows, as ingestion writes them: one content item, two authors, three observed comments.
    const content = randomUUID();
    await privileged.query(
      `insert into content.content_items (id, organization_id, workspace_id, platform, connected_account_id, provider_asset_id, provider_content_id, content_kind, reported_source, source_state, first_observed_at, latest_observed_at, created_at, updated_at)
       values ($1, $2, $3, 'facebook', $4, 'fb_page_aurora', 'fb_post_boosted_02', 'post', 'mixed', 'available', now(), now(), now(), now())`,
      [content, organizationId, workspaceId, account],
    );
    const audience = randomUUID();
    const brand = randomUUID();
    await privileged.query(`insert into interactions.authors (id, organization_id, workspace_id, platform, provider_author_id, role, label, created_at, updated_at) values ($1, $2, $3, 'facebook', 'fb_u_001', 'user', null, now(), now())`, [audience, organizationId, workspaceId]);
    await privileged.query(`insert into interactions.authors (id, organization_id, workspace_id, platform, provider_author_id, role, label, created_at, updated_at) values ($1, $2, $3, 'facebook', 'fb_page_aurora', 'account_identity', null, now(), now())`, [brand, organizationId, workspaceId]);
    const interaction = async (providerId: string, author: string, visibility: "visible" | "hidden"): Promise<string> => {
      const id = randomUUID();
      await privileged.query(
        `insert into interactions.interactions (id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id, provider_content_id, observed, kind, author_id, author_role,
           current_visibility, current_availability, provider_created_at, state_observed_at, first_observed_at, latest_observed_at, created_at, updated_at)
         values ($1, $2, $3, 'facebook', $4, $5, 'fb_page_aurora', $6, 'fb_post_boosted_02', true, 'comment', $7, (select role from interactions.authors where id = $7), $8, 'available', now() - interval '1 hour', now(), now(), now(), now(), now())`,
        [id, organizationId, workspaceId, providerId, account, content, author, visibility],
      );
      return id;
    };
    const comment = await interaction("fb_c_010", audience, "visible");
    const own = await interaction("fb_c_own_7b1", brand, "visible");
    const hidden = await interaction("fb_c_hidden_7b1", audience, "hidden");
    return { organizationId, workspaceId, users, connection, account, content, comment, own, hidden, audience };
  };

  /** A second ACTIVE account of the same connection and workspace, with its own content and one audience comment. */
  const secondAccount = async (t: Tenant, contentKind: "post" | "story" = "post"): Promise<SecondAccount> => {
    const discovered = randomUUID();
    const asset = `fb_page_beta_${randomUUID().slice(0, 8)}`;
    await privileged.query(
      `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'facebook', $5, 'content_bearing', 'Synthetic B', now(), now(), now())`,
      [discovered, t.organizationId, t.workspaceId, t.connection, asset],
    );
    const account = randomUUID();
    await privileged.query(
      `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
       select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`,
      [account, discovered],
    );
    const facts: FactsInput = { kind: "available", assetClass: "content_bearing", grantedPermissions: ["sim.read_content", "sim.read_interactions", "sim.reply_public"], linkedAdAccountIds: [], accountIdentityKnown: true, obtainedAt: new Date() };
    await withWorkspaceJobScope(worker, t.workspaceId, (tx) =>
      evaluateAndStore(createPostgresCapabilityStore(tx), { organizationId: t.organizationId, workspaceId: t.workspaceId, connectedAccountId: account, catalog: SIMULATOR_CATALOG, platform: "facebook", assetClass: "content_bearing", facts, observations: [], evaluatedAt: new Date() }),
    );
    const content = randomUUID();
    const providerContent = `fb_post_beta_${randomUUID().slice(0, 8)}`;
    await privileged.query(
      `insert into content.content_items (id, organization_id, workspace_id, platform, connected_account_id, provider_asset_id, provider_content_id, content_kind, reported_source, source_state, first_observed_at, latest_observed_at, created_at, updated_at)
       values ($1, $2, $3, 'facebook', $4, $5, $6, $7, 'organic', 'available', now(), now(), now(), now())`,
      [content, t.organizationId, t.workspaceId, account, asset, providerContent, contentKind],
    );
    const comment = randomUUID();
    await privileged.query(
      `insert into interactions.interactions (id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id, provider_content_id, observed, kind, author_id, author_role,
         current_visibility, current_availability, provider_created_at, state_observed_at, first_observed_at, latest_observed_at, created_at, updated_at)
       values ($1, $2, $3, 'facebook', $4, $5, $6, $7, $8, true, 'comment', $9, 'user', 'visible', 'available', now() - interval '1 hour', now(), now(), now(), now(), now())`,
      [comment, t.organizationId, t.workspaceId, `fb_c_beta_${randomUUID().slice(0, 8)}`, account, asset, content, providerContent, t.audience],
    );
    return { account, content, comment };
  };

  const pipelineAs = (user: string): ActionPipeline => {
    const identity = new FakeIdentity(verifiedUser(must(parseUserId(user), "user")));
    return createActionPipeline({ identity, unitOfWork: createPostgresUnitOfWork(web), clock: () => new Date(), newId: randomUUID, logger });
  };
  const request = (t: Tenant, user: string, input: { readonly targetInteractionId: string; readonly text?: string; readonly idempotencyKey?: string }) =>
    pipelineAs(user).run(requestPublicReplyCommand, { workspaceId: t.workspaceId, input: { targetInteractionId: input.targetInteractionId, text: input.text ?? TEXT, idempotencyKey: input.idempotencyKey ?? `form-${randomUUID()}` } });

  interface Harness {
    readonly world: SimulatorWorld;
    readonly base: MutationComposition;
    readonly clock: { readonly newId: () => string; readonly now: () => Date };
    readonly payloads: unknown[];
    /** Step 7B-4: every call that reached the simulator's MUTATION port (the one external effect). */
    readonly providerCalls: string[];
    readonly step: () => Promise<void>;
  }
  const harness = (): Harness => {
    const world = new SimulatorWorld(presentScenario());
    const clock = { newId: randomUUID, now: () => new Date(world.nowMs()) };
    const read = createSimulatorReadPort(world, { webhookSigningKey: "synthetic-webhook-signing-key-for-tests" });
    const providerCalls: string[] = [];
    const simulator = createSimulatorMutationPort(world);
    const mutation: typeof simulator = {
      ...simulator,
      replyPublicly: (access, target, text, hint) => {
        providerCalls.push(`replyPublicly:${target.id}`);
        return simulator.replyPublicly(access, target, text, hint);
      },
    };
    const access: ProviderCredentialAccess = { withCredential: (_input, use) => use(world.credential("cred_meta_main")) };
    const reads: DiscoveryProviders = { read: (provider) => (provider === "simulator" ? read : undefined) };
    const base: MutationComposition = { access, reads, providers: { mutation: (provider) => (provider === "simulator" ? mutation : undefined) } };
    const deps = { registry: PRODUCTION_TASKS, worker, logger };
    const payloads: unknown[] = [];
    const handlers = new Map<string, FakeHandler>([
      [TASK, (payload, run) => {
        payloads.push(payload);
        return runTenantStepJob(deps, TASK, payload, run, (context) => runExecuteIntent(context, base, { clock }));
      }],
    ]);
    const runtime = new FakeJobRuntime(handlers, (task) => PRODUCTION_TASKS.get(task)?.retry ?? { maxAttempts: 1, factor: 2, minDelayMs: 100, maxDelayMs: 1_000, randomize: false });
    const deliveryDeps = (): DeliveryDependencies => ({ system, runtimes: { main: runtime, integration: runtime, intelligence: runtime }, registry: PRODUCTION_TASKS, logger, clock: () => new Date(), config: CONFIG });
    const step = async (): Promise<void> => {
      await relayPass(deliveryDeps());
      await runtime.drain();
      await sweepRunOutcomes(deliveryDeps());
    };
    return { world, base, clock, payloads, providerCalls, step };
  };

  /** Step 7B-4: a conversation anchored on the tenant's comment (as ingestion creates it), so the Inbox can read it. */
  const conversationFor = async (t: Tenant): Promise<string> => {
    const id = randomUUID();
    await privileged.query(
      `insert into conversations.conversations (id, organization_id, workspace_id, anchor_interaction_id, anchor_observed, workflow_state, created_by, created_at, updated_at)
       values ($1, $2, $3, $4, true, 'OPEN', 'system_ingestion', now(), now())`,
      [id, t.organizationId, t.workspaceId, t.comment],
    );
    await privileged.query("update interactions.interactions set conversation_id = $1 where workspace_id = $2 and id = $3", [id, t.workspaceId, t.comment]);
    return id;
  };
  const inboxView = (t: Tenant, user: string, conversationId: string) => pipelineAs(user).run(inboxConversationCommand, { workspaceId: t.workspaceId, input: { conversationId } });

  const intentRow = (workspaceId: string, id: string) => oracle<{ status: string; attempt: number; run_reference: string | null; outcome_code: string | null; initiator_user_id: string }>("select status, attempt, run_reference, outcome_code, initiator_user_id from mutations.mutation_intents where workspace_id = $1 and id = $2", [workspaceId, id]);
  const historyRows = (workspaceId: string, id: string) => oracle<{ from_status: string | null; to_status: string; actor: string; outcome_code: string | null; attempt: number }>("select from_status, to_status, actor, outcome_code, attempt from mutations.mutation_intent_history where workspace_id = $1 and intent_id = $2 order by occurred_at, array_position(array['PENDING', 'EXECUTING', 'OUTCOME_UNKNOWN', 'CONFIRMED', 'FAILED', 'BLOCKED'], to_status)", [workspaceId, id]);
  const auditRows = (id: string) => oracle<{ action: string; actor_type: string; actor_user_id: string | null; outcome: string }>("select action, actor_type, actor_user_id, outcome from audit.audit_events where target_type = 'mutation_intent' and target_id = $1 order by occurred_at, array_position(array['mutation_intent.created', 'mutation_intent.executing', 'mutation_intent.outcome_unknown', 'mutation_intent.confirmed', 'mutation_intent.failed', 'mutation_intent.blocked', 'mutation_intent.reconciled'], action)", [id]);
  const replyRow = (workspaceId: string, id: string) => oracle<{ text: string; provider_reply_id: string | null; confirmed_at: Date | null }>("select text, provider_reply_id, confirmed_at from mutations.outbound_replies where workspace_id = $1 and intent_id = $2", [workspaceId, id]);

  /**
   * Step 7B-12A: mutation.provider_action is fail-closed (explicit_allow). This suite's simulator account publishes on
   * "facebook", so it grants EXACTLY facebook:public_reply, through the audited tool, for its own duration — and the
   * Step 7B-12A block below proves the deny paths by withdrawing that grant.
   */
  const SWITCH_OPERATOR = { operator: "ops.mutations-suite", reason: "test" } as const;
  const AUTHORIZATION = { key: "mutation.provider_action", qualifier: "facebook:public_reply", scope: "global" } as const;
  const WILDCARD = { key: "mutation.provider_action", qualifier: "*", scope: "global" } as const;
  const withOperator = async <T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await privileged.connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  };
  const authorize = (enabled: boolean) => withOperator((client) => setSwitch(client, AUTHORIZATION, { enabled }, SWITCH_OPERATOR));
  const withdraw = () => withOperator((client) => clearSwitch(client, AUTHORIZATION, SWITCH_OPERATOR));

  beforeAll(async () => {
    const target = getTarget();
    privileged = privilegedPool(target);
    web = runtimeDatabase(target, "web");
    worker = runtimeDatabase(target, "worker");
    system = runtimeDatabase(target, "system");
    logger = createLogger({ sink: () => undefined });
    await authorize(true);
  });

  afterAll(async () => {
    await withOperator(async (client) => {
      await clearSwitch(client, WILDCARD, SWITCH_OPERATOR);
      await clearSwitch(client, AUTHORIZATION, SWITCH_OPERATOR);
    });
    await cleanupWorld(privileged, organizations);
    await Promise.all([web.end(), worker.end(), system.end()]);
    await privileged.end();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("the request through the real pipeline", () => {
    it("a Responder's request writes the PENDING intent, its text, one web history row, the member's audit event and the IDs-only outbox row — atomically", async () => {
      const t = await tenant();
      const result = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment, idempotencyKey: "form-0000-0001" });
      expect(result.status === "ok" ? "ok" : result.status === "error" ? result.error.code : result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.value.kind).toBe("requested");
      if (result.value.kind !== "requested") return;
      const id = result.value.intentId;
      expect(await intentRow(t.workspaceId, id)).toEqual([{ status: "PENDING", attempt: 0, run_reference: null, outcome_code: null, initiator_user_id: t.users.RESPONDER }]);
      expect(await historyRows(t.workspaceId, id)).toEqual([{ from_status: null, to_status: "PENDING", actor: "web", outcome_code: null, attempt: 0 }]);
      expect(await replyRow(t.workspaceId, id)).toEqual([{ text: TEXT, provider_reply_id: null, confirmed_at: null }]);
      expect(await auditRows(id)).toEqual([{ action: "mutation_intent.created", actor_type: "user", actor_user_id: t.users.RESPONDER, outcome: "succeeded" }]);
      const outbox = await oracle<{ topic: string; subject_ids: Record<string, string>; initiator_type: string; initiator_user_id: string; status: string }>("select topic, subject_ids, initiator_type, initiator_user_id, status from system.outbox where workspace_id = $1", [t.workspaceId]);
      expect(outbox).toEqual([{ topic: TASK, subject_ids: { mutation_intent_id: id, connected_account_id: t.account }, initiator_type: "user", initiator_user_id: t.users.RESPONDER, status: "PENDING" }]);
      // Idempotent: the same key with the same payload answers the existing intent; another payload is a refused reuse.
      const again = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment, idempotencyKey: "form-0000-0001" });
      expect(again.status === "ok" ? again.value : again).toEqual({ kind: "existing", intentId: id, status: "PENDING" });
      const reused = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment, idempotencyKey: "form-0000-0001", text: "Other text" });
      expect(reused.status === "ok" ? reused.value : reused).toEqual({ kind: "refused", reason: "IDEMPOTENCY_KEY_REUSED" });
      expect((await oracle<{ n: string }>("select count(*)::text as n from mutations.mutation_intents where workspace_id = $1", [t.workspaceId]))[0]?.n).toBe("1");
      expect((await oracle<{ n: string }>("select count(*)::text as n from system.outbox where workspace_id = $1", [t.workspaceId]))[0]?.n).toBe("1");
    });

    it("refusals: the brand's own message, a hidden comment, Analyst/Guest, a stranger, a Monitor-only workspace — nothing written", async () => {
      const t = await tenant();
      const own = await request(t, t.users.OWNER, { targetInteractionId: t.own });
      expect(own.status === "ok" ? own.value : own).toEqual({ kind: "refused", reason: "TARGET_OWN_ACCOUNT" });
      const hidden = await request(t, t.users.OWNER, { targetInteractionId: t.hidden });
      expect(hidden.status === "ok" ? hidden.value : hidden).toEqual({ kind: "refused", reason: "TARGET_NOT_PRESENT" });
      for (const role of ["ANALYST_VIEWER", "CLIENT_GUEST"] as const) {
        const denied = await request(t, t.users[role], { targetInteractionId: t.comment });
        expect(denied.status === "error" ? denied.error.code : denied, role).toBe("PERMISSION_DENIED");
      }
      const other = await tenant();
      const stranger = await request(t, other.users.OWNER, { targetInteractionId: t.comment });
      expect(stranger.status === "error" ? stranger.error.code : stranger).toBe("NOT_FOUND");
      // Another workspace's comment, requested in this workspace: refused like an unknown one.
      const foreign = await request(t, t.users.OWNER, { targetInteractionId: other.comment });
      expect(foreign.status === "ok" ? foreign.value : foreign).toEqual({ kind: "refused", reason: "TARGET_NOT_FOUND" });
      const monitor = await tenant("MONITOR_ONLY");
      const blocked = await request(monitor, monitor.users.OWNER, { targetInteractionId: monitor.comment });
      expect(blocked.status === "error" ? blocked.error.code : blocked).toBe("MODE_BLOCKED");
      for (const ws of [t.workspaceId, other.workspaceId, monitor.workspaceId]) {
        expect((await oracle<{ n: string }>("select count(*)::text as n from mutations.mutation_intents where workspace_id = $1", [ws]))[0]?.n).toBe("0");
      }
      expect((await oracle<{ n: string }>("select count(*)::text as n from audit.audit_events where target_type = 'mutation_intent' and workspace_id in ($1, $2, $3)", [t.workspaceId, other.workspaceId, monitor.workspaceId]))[0]?.n).toBe("0");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("isolation and constraints (0027)", () => {
    it("RLS: members of the workspace read; a guest, another workspace's member and an unbound session read nothing", async () => {
      const t = await tenant();
      const other = await tenant();
      const created = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment });
      const id = created.status === "ok" && created.value.kind === "requested" ? created.value.intentId : "";
      expect(id).not.toBe("");
      const countAs = (user: string, bound: string | undefined, table: string) =>
        withUserScope(web, { sub: user, role: "authenticated" }, bound, async (tx) => Number((await tx.execute<{ n: string }>(`select count(*)::text as n from ${table}` as never)).rows[0]?.n ?? "-1"));
      for (const table of ["mutations.mutation_intents", "mutations.mutation_intent_history", "mutations.outbound_replies"]) {
        expect(await countAs(t.users.ANALYST_VIEWER, t.workspaceId, table), table).toBe(1);
        expect(await countAs(t.users.RESPONDER, t.workspaceId, table), table).toBe(1);
        expect(await countAs(t.users.CLIENT_GUEST, t.workspaceId, table), table).toBe(0);
        expect(await countAs(other.users.OWNER, other.workspaceId, table), table).toBe(0);
        expect(await countAs(t.users.OWNER, undefined, table), table).toBe(0);
      }
    });

    it("a member cannot insert a non-PENDING intent, an intent attributed to someone else, a worker history row, or update an intent (no grant)", async () => {
      const t = await tenant();
      const asResponder = <T>(work: (tx: Parameters<Parameters<typeof withUserScope>[3]>[0]) => Promise<T>) => withUserScope(web, { sub: t.users.RESPONDER, role: "authenticated" }, t.workspaceId, work);
      const insertIntent = (status: string, initiator: string) =>
        asResponder((tx) =>
          tx.execute(
            `insert into mutations.mutation_intents (id, organization_id, workspace_id, kind, request_type, target_interaction_id, connected_account_id, initiator_user_id, idempotency_key, status, attempt, run_reference, outcome_code, capability_catalog_id, capability_catalog_revision, correlation_id, created_at, updated_at)
             values ('${randomUUID()}', '${t.organizationId}', '${t.workspaceId}', 'reply_public', 'human', '${t.comment}', '${t.account}', '${initiator}', 'key-${randomUUID()}', '${status}', ${status === "PENDING" ? "0" : "1"}, ${status === "PENDING" ? "null" : "'run_x'"}, null, 'simulator', 2, 'corr-7b1-${randomUUID()}', now(), now())` as never,
          ),
        );
      expect((await sqlState(insertIntent("EXECUTING", t.users.RESPONDER))).code).toBe("42501");
      expect((await sqlState(insertIntent("PENDING", t.users.OWNER))).code).toBe("42501");
      await insertIntent("PENDING", t.users.RESPONDER);
      const id = (await oracle<{ id: string }>("select id from mutations.mutation_intents where workspace_id = $1", [t.workspaceId]))[0]?.id ?? "";
      expect((await sqlState(asResponder((tx) => tx.execute(`update mutations.mutation_intents set status = 'CONFIRMED' where id = '${id}'` as never)))).code).toBe("42501");
      expect((await sqlState(asResponder((tx) => tx.execute(`insert into mutations.mutation_intent_history (id, organization_id, workspace_id, intent_id, from_status, to_status, attempt, actor, outcome_code, run_reference, correlation_id, occurred_at) values ('${randomUUID()}', '${t.organizationId}', '${t.workspaceId}', '${id}', 'PENDING', 'EXECUTING', 1, 'executor', null, 'run_x', 'corr-7b1-forged-0001', now())` as never)))).code).toBe("42501");
      expect((await sqlState(asResponder((tx) => tx.execute(`delete from mutations.mutation_intents where id = '${id}'` as never)))).code).toBe("42501");
    });

    it("a cross-workspace target or account fails exactly like a non-existent one (23503); the idempotency key is unique per workspace (23505)", async () => {
      const t = await tenant();
      const other = await tenant();
      const insert = (target: string, account: string, key: string) =>
        privileged.query(
          `insert into mutations.mutation_intents (id, organization_id, workspace_id, kind, request_type, target_interaction_id, connected_account_id, initiator_user_id, idempotency_key, status, attempt, capability_catalog_id, capability_catalog_revision, correlation_id, created_at, updated_at)
           values ($1, $2, $3, 'reply_public', 'human', $4, $5, $6, $7, 'PENDING', 0, 'simulator', 2, 'corr-7b1-privileged-0001', now(), now())`,
          [randomUUID(), t.organizationId, t.workspaceId, target, account, t.users.OWNER, key],
        );
      expect((await sqlState(insert(other.comment, t.account, "key-foreign-target"))).code).toBe("23503");
      expect((await sqlState(insert(randomUUID(), t.account, "key-missing-target"))).code).toBe("23503");
      expect((await sqlState(insert(t.comment, other.account, "key-foreign-account"))).code).toBe("23503");
      await insert(t.comment, t.account, "key-unique-0001");
      expect(await sqlState(insert(t.comment, t.account, "key-unique-0001"))).toMatchObject({ code: "23505", constraint: "mutation_intents_idempotent" });
      // The same key in ANOTHER workspace is a different intent.
      await privileged.query(
        `insert into mutations.mutation_intents (id, organization_id, workspace_id, kind, request_type, target_interaction_id, connected_account_id, initiator_user_id, idempotency_key, status, attempt, capability_catalog_id, capability_catalog_revision, correlation_id, created_at, updated_at)
         values ($1, $2, $3, 'reply_public', 'human', $4, $5, $6, 'key-unique-0001', 'PENDING', 0, 'simulator', 2, 'corr-7b1-privileged-0002', now(), now())`,
        [randomUUID(), other.organizationId, other.workspaceId, other.comment, other.account, other.users.OWNER],
      );
      // The CHECKs refuse an incoherent shape (PENDING with a run; a FAILED without a code).
      expect((await sqlState(privileged.query(`update mutations.mutation_intents set run_reference = 'run_x' where workspace_id = $1`, [t.workspaceId]))).code).toBe("23514");
      expect((await sqlState(privileged.query(`update mutations.mutation_intents set status = 'FAILED', attempt = 1, run_reference = 'run_x' where workspace_id = $1`, [t.workspaceId]))).code).toBe("23514");
    });

    it("the initiator-role definer answers for the BOUND workspace only; the worker reads only its bound workspace", async () => {
      const t = await tenant();
      const other = await tenant();
      const roleIn = (workspace: string, user: string) => withWorkspaceJobScope(worker, workspace, async (tx) => (await tx.execute<{ role: string | null }>(`select mutations.initiator_workspace_role('${user}') as role` as never)).rows[0]?.role ?? null);
      expect(await roleIn(t.workspaceId, t.users.RESPONDER)).toBe("RESPONDER");
      expect(await roleIn(t.workspaceId, t.users.CLIENT_GUEST)).toBe("CLIENT_GUEST");
      expect(await roleIn(t.workspaceId, other.users.OWNER)).toBeNull();
      expect(await roleIn(other.workspaceId, t.users.RESPONDER)).toBeNull();
      await request(t, t.users.RESPONDER, { targetInteractionId: t.comment });
      const countAsWorker = (workspace: string) => withWorkspaceJobScope(worker, workspace, async (tx) => Number((await tx.execute<{ n: string }>("select count(*)::text as n from mutations.mutation_intents")).rows[0]?.n ?? "-1"));
      expect(await countAsWorker(t.workspaceId)).toBe(1);
      expect(await countAsWorker(other.workspaceId)).toBe(0);
      // The web login holds no EXECUTE on the definer.
      expect((await sqlState(withUserScope(web, { sub: t.users.OWNER, role: "authenticated" }, t.workspaceId, (tx) => tx.execute(`select mutations.initiator_workspace_role('${t.users.OWNER}')` as never)))).code).toBe("42501");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("execution through the real relay and the real integration handler", () => {
    /** Rows other tests left PENDING would be delivered by this test's relay pass: take them out of delivery first. */
    const onlyThisWorkspace = (workspaceId: string) => quietPendingOutbox((text, values) => privileged.query(text, values), "topic = $1 and workspace_id <> $2", [TASK, workspaceId]);
    const unique = (): string => `${TEXT} ${randomUUID()}`;

    it("CONFIRMED: EXECUTING committed before the call, the reply created on the platform, two system audit events, three history rows, the reply confirmed", async () => {
      const h = harness();
      const t = await tenant();
      const text = unique();
      const created = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment, text });
      const id = created.status === "ok" && created.value.kind === "requested" ? created.value.intentId : "";
      await onlyThisWorkspace(t.workspaceId);
      const before = h.world.interactions().length;
      await h.step();
      expect(h.payloads).toHaveLength(1);
      expect(await intentRow(t.workspaceId, id)).toEqual([expect.objectContaining({ status: "CONFIRMED", attempt: 1, outcome_code: null })]);
      const row = must((await intentRow(t.workspaceId, id))[0], "intent");
      expect(row.run_reference).not.toBeNull();
      const reply = must((await replyRow(t.workspaceId, id))[0], "reply");
      expect(reply.provider_reply_id).not.toBeNull();
      expect(reply.confirmed_at).not.toBeNull();
      expect(h.world.interactions()).toHaveLength(before + 1);
      expect(h.world.interaction(reply.provider_reply_id ?? "")).toMatchObject({ parent: "fb_c_010", text });
      expect((await historyRows(t.workspaceId, id)).map((r) => [r.from_status, r.to_status, r.actor, r.attempt])).toEqual([[null, "PENDING", "web", 0], ["PENDING", "EXECUTING", "executor", 1], ["EXECUTING", "CONFIRMED", "executor", 1]]);
      expect((await auditRows(id)).map((r) => [r.action, r.actor_type, r.actor_user_id, r.outcome])).toEqual([["mutation_intent.created", "user", t.users.RESPONDER, "succeeded"], ["mutation_intent.executing", "system", null, "succeeded"], ["mutation_intent.confirmed", "system", null, "succeeded"]]);
      // The outbox row reached a terminal, successful run.
      expect((await oracle<{ status: string; run_outcome: string | null }>("select status, run_outcome from system.outbox where workspace_id = $1", [t.workspaceId]))[0]).toMatchObject({ status: "DISPATCHED" });
      // A second delivery of the same row is a noop (nothing new on the platform).
      await h.step();
      expect(h.world.interactions()).toHaveLength(before + 1);
    });

    it("a lost response → OUTCOME_UNKNOWN; reconciliation through the READ port finds the reply → CONFIRMED (reconciled), exactly one reply on the platform", async () => {
      const h = harness();
      h.world.injectFaults([{ operation: "replyPublicly", on: 1, fault: { kind: "outcome_unknown" } }]);
      const t = await tenant();
      const text = unique();
      const created = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment, text });
      const id = created.status === "ok" && created.value.kind === "requested" ? created.value.intentId : "";
      await onlyThisWorkspace(t.workspaceId);
      await h.step();
      expect(await intentRow(t.workspaceId, id)).toEqual([expect.objectContaining({ status: "OUTCOME_UNKNOWN", attempt: 1, outcome_code: "RESPONSE_LOST" })]);
      expect(h.world.interactions().filter((state) => state.text === text)).toHaveLength(1);
      // Reconcile with the SAME composition: the read port lists the content; the mutation port is never called again.
      h.world.advanceClock(60);
      const payload = must(h.payloads[0], "payload");
      const result = await runTenantStepJob({ registry: PRODUCTION_TASKS, worker, logger }, TASK, payload, { runId: "run_reconcile_7b1", attempt: 1 }, (context) => runReconcileIntent(context, h.base, { intentId: id, provider: "simulator" }, { clock: h.clock }));
      expect(result.kind).toBe("confirmed");
      expect(h.world.interactions().filter((state) => state.text === text)).toHaveLength(1);
      const reply = must((await replyRow(t.workspaceId, id))[0], "reply");
      expect(reply.provider_reply_id).not.toBeNull();
      expect(await intentRow(t.workspaceId, id)).toEqual([expect.objectContaining({ status: "CONFIRMED", run_reference: "run_reconcile_7b1", outcome_code: null })]);
      expect((await historyRows(t.workspaceId, id)).map((r) => [r.to_status, r.actor, r.outcome_code])).toEqual([["PENDING", "web", null], ["EXECUTING", "executor", null], ["OUTCOME_UNKNOWN", "executor", "RESPONSE_LOST"], ["CONFIRMED", "reconciliation", null]]);
      expect((await auditRows(id)).map((r) => r.action)).toEqual(["mutation_intent.created", "mutation_intent.executing", "mutation_intent.outcome_unknown", "mutation_intent.reconciled"]);
    });

    it("Monitor-only at execution time (switched after the request) → BLOCKED MODE_NOT_STANDARD, nothing sent, no credential opened", async () => {
      const h = harness();
      const t = await tenant();
      const created = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment, text: unique() });
      const id = created.status === "ok" && created.value.kind === "requested" ? created.value.intentId : "";
      await onlyThisWorkspace(t.workspaceId);
      await privileged.query("update tenancy.workspaces set mode = 'MONITOR_ONLY' where id = $1", [t.workspaceId]);
      const before = h.world.interactions().length;
      await h.step();
      expect(await intentRow(t.workspaceId, id)).toEqual([expect.objectContaining({ status: "BLOCKED", attempt: 1, outcome_code: "MODE_NOT_STANDARD" })]);
      expect(h.world.interactions()).toHaveLength(before);
      expect((await historyRows(t.workspaceId, id)).map((r) => [r.to_status, r.actor])).toEqual([["PENDING", "web"], ["BLOCKED", "executor"]]);
      expect((await auditRows(id)).map((r) => [r.action, r.actor_type, r.outcome])).toEqual([["mutation_intent.created", "user", "succeeded"], ["mutation_intent.blocked", "system", "failed"]]);
      expect((await replyRow(t.workspaceId, id))[0]?.provider_reply_id).toBeNull();
    });

    it("a demoted initiator → BLOCKED PERMISSION_DENIED; an initiator removed from the workspace → BLOCKED INITIATOR_NOT_MEMBER", async () => {
      const h = harness();
      const t = await tenant();
      const text = unique();
      const first = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment, text });
      const firstId = first.status === "ok" && first.value.kind === "requested" ? first.value.intentId : "";
      await onlyThisWorkspace(t.workspaceId);
      await privileged.query("update tenancy.workspace_memberships set role = 'ANALYST_VIEWER' where workspace_id = $1 and user_id = $2", [t.workspaceId, t.users.RESPONDER]);
      await h.step();
      expect(await intentRow(t.workspaceId, firstId)).toEqual([expect.objectContaining({ status: "BLOCKED", outcome_code: "PERMISSION_DENIED" })]);
      // A second Responder (the workspace keeps its Owner) asks, then leaves before the executor runs.
      const leaver = randomUUID();
      await privileged.query("insert into tenancy.organization_memberships values ($1, $2, 'MEMBER', now())", [t.organizationId, leaver]);
      await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, 'RESPONDER', '{}', now())", [t.organizationId, t.workspaceId, leaver]);
      const second = await request(t, leaver, { targetInteractionId: t.comment, text });
      const secondId = second.status === "ok" && second.value.kind === "requested" ? second.value.intentId : "";
      await privileged.query("delete from tenancy.workspace_memberships where workspace_id = $1 and user_id = $2", [t.workspaceId, leaver]);
      await h.step();
      expect(await intentRow(t.workspaceId, secondId)).toEqual([expect.objectContaining({ status: "BLOCKED", outcome_code: "INITIATOR_NOT_MEMBER" })]);
      expect(h.world.interactions().some((state) => state.text === text)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("T-04: Monitor-only is a DATABASE backstop (0027 intent_mode_guard), not only the pipeline and the executor", () => {
    const insertIntent = (t: Tenant, run: (text: string, values: unknown[]) => Promise<unknown>, key: string) =>
      run(
        `insert into mutations.mutation_intents (id, organization_id, workspace_id, kind, request_type, target_interaction_id, connected_account_id, initiator_user_id, idempotency_key, status, attempt, capability_catalog_id, capability_catalog_revision, correlation_id, created_at, updated_at)
         values ($1, $2, $3, 'reply_public', 'human', $4, $5, $6, $7, 'PENDING', 0, 'simulator', 2, 'corr-7b1-t04-0001', now(), now())`,
        [randomUUID(), t.organizationId, t.workspaceId, t.comment, t.account, t.users.OWNER, key],
      );

    it("no new intent for a Monitor-only workspace — refused by the policy for a member and by the trigger for the privileged role", async () => {
      const t = await tenant("MONITOR_ONLY");
      const asOwner = (text: string, values: unknown[]) => withUserScope(web, { sub: t.users.OWNER, role: "authenticated" }, t.workspaceId, (tx) => tx.execute(text.replace(/\$(\d)/g, (_m, n: string) => `'${String(values[Number(n) - 1])}'`) as never));
      expect((await sqlState(insertIntent(t, asOwner, "key-t04-member"))).code).toBe("42501");
      expect((await sqlState(insertIntent(t, (text, values) => privileged.query(text, values), "key-t04-privileged"))).code).toBe("42501");
      expect((await oracle<{ n: string }>("select count(*)::text as n from mutations.mutation_intents where workspace_id = $1", [t.workspaceId]))[0]?.n).toBe("0");
    });

    it("an intent queued while STANDARD can never move INTO EXECUTING once the workspace is Monitor-only; BLOCKED (and every other transition) still can", async () => {
      const t = await tenant();
      const created = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment });
      const id = created.status === "ok" && created.value.kind === "requested" ? created.value.intentId : "";
      await privileged.query("update tenancy.workspaces set mode = 'MONITOR_ONLY' where id = $1", [t.workspaceId]);
      const asWorker = (text: string) => withWorkspaceJobScope(worker, t.workspaceId, (tx) => tx.execute(text as never));
      expect((await sqlState(asWorker(`update mutations.mutation_intents set status = 'EXECUTING', attempt = 1, run_reference = 'run_t04' where id = '${id}'`))).code).toBe("42501");
      expect((await sqlState(privileged.query(`update mutations.mutation_intents set status = 'EXECUTING', attempt = 1, run_reference = 'run_t04' where id = $1`, [id]))).code).toBe("42501");
      expect(await intentRow(t.workspaceId, id)).toEqual([expect.objectContaining({ status: "PENDING" })]);
      await asWorker(`update mutations.mutation_intents set status = 'BLOCKED', attempt = 1, run_reference = 'run_t04', outcome_code = 'MODE_NOT_STANDARD' where id = '${id}'`);
      expect(await intentRow(t.workspaceId, id)).toEqual([expect.objectContaining({ status: "BLOCKED", outcome_code: "MODE_NOT_STANDARD" })]);
    });

    it("a mode change racing the executor: the switch commits first and the executor, waiting on the row lock, records BLOCKED — nothing is sent", async () => {
      const h = harness();
      const t = await tenant();
      const created = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment, text: `${TEXT} race` });
      const id = created.status === "ok" && created.value.kind === "requested" ? created.value.intentId : "";
      await quietPendingOutbox((text, values) => privileged.query(text, values), "topic = $1 and workspace_id <> $2", [TASK, t.workspaceId]);
      const client = await privileged.connect();
      try {
        await client.query("begin");
        await client.query("update tenancy.workspaces set mode = 'MONITOR_ONLY' where id = $1", [t.workspaceId]);
        // The executor starts while the mode change is uncommitted: its FOR SHARE read must wait for the row lock.
        const running = h.step();
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(await intentRow(t.workspaceId, id)).toEqual([expect.objectContaining({ status: "PENDING" })]);
        await client.query("commit");
        await running;
      } finally {
        client.release();
      }
      expect(await intentRow(t.workspaceId, id)).toEqual([expect.objectContaining({ status: "BLOCKED", outcome_code: "MODE_NOT_STANDARD" })]);
      expect(h.world.interactions().some((state) => state.text === `${TEXT} race`)).toBe(false);
    });

    it("the mode definer answers for the bound workspace only and the web login holds no EXECUTE on it", async () => {
      const t = await tenant();
      expect(await withWorkspaceJobScope(worker, t.workspaceId, async (tx) => (await tx.execute<{ mode: string | null }>("select mutations.workspace_mode_for_execution() as mode")).rows[0]?.mode)).toBe("STANDARD");
      expect((await sqlState(withUserScope(web, { sub: t.users.OWNER, role: "authenticated" }, t.workspaceId, (tx) => tx.execute("select mutations.workspace_mode_for_execution()")))).code).toBe("42501");
      // The owner's lock policy never lets the owner CHANGE a workspace row (WITH CHECK false): proven by the definer
      // being a plain SELECT ... FOR SHARE and the policy's shape (introspection pins it).
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("authority coherence, identity uniqueness, key reuse and forged history (0027)", () => {
    it("an intent whose account does not own its target, or a reply naming another parent/account than its intent, fails like a non-existent reference (23503)", async () => {
      const t = await tenant();
      const b = await secondAccount(t);
      const insert = (target: string, account: string, key: string) =>
        privileged.query(
          `insert into mutations.mutation_intents (id, organization_id, workspace_id, kind, request_type, target_interaction_id, connected_account_id, initiator_user_id, idempotency_key, status, attempt, capability_catalog_id, capability_catalog_revision, correlation_id, created_at, updated_at)
           values ($1, $2, $3, 'reply_public', 'human', $4, $5, $6, $7, 'PENDING', 0, 'simulator', 2, 'corr-7b1-coherence-0001', now(), now())`,
          [randomUUID(), t.organizationId, t.workspaceId, target, account, t.users.OWNER, key],
        );
      // Account B with A's comment, and A with B's comment: both exist in the workspace, neither owns the other's target.
      expect(await sqlState(insert(t.comment, b.account, "key-coherence-1"))).toMatchObject({ code: "23503", constraint: "mutation_intents_target_owned" });
      expect(await sqlState(insert(b.comment, t.account, "key-coherence-2"))).toMatchObject({ code: "23503", constraint: "mutation_intents_target_owned" });
      // A coherent intent for B, then a reply that names A's comment or A's account: refused.
      await insert(b.comment, b.account, "key-coherence-3");
      const intentId = (await oracle<{ id: string }>("select id from mutations.mutation_intents where workspace_id = $1 and idempotency_key = 'key-coherence-3'", [t.workspaceId]))[0]?.id ?? "";
      const reply = (parent: string, account: string) =>
        privileged.query(
          `insert into mutations.outbound_replies (id, organization_id, workspace_id, intent_id, parent_interaction_id, connected_account_id, platform, text, created_at)
           values ($1, $2, $3, $4, $5, $6, 'facebook', 'x', now())`,
          [randomUUID(), t.organizationId, t.workspaceId, intentId, parent, account],
        );
      expect(await sqlState(reply(t.comment, b.account))).toMatchObject({ code: "23503", constraint: "outbound_replies_intent_coherent" });
      expect(await sqlState(reply(b.comment, t.account))).toMatchObject({ code: "23503", constraint: "outbound_replies_intent_coherent" });
      await reply(b.comment, b.account);
      // Through the real pipeline, B's comment is a valid target and ends up bound to B.
      const created = await request(t, t.users.RESPONDER, { targetInteractionId: b.comment });
      expect(created.status === "ok" ? created.value.kind : created).toBe("requested");
      const id = created.status === "ok" && created.value.kind === "requested" ? created.value.intentId : "";
      expect((await oracle<{ connected_account_id: string }>("select connected_account_id from mutations.mutation_intents where id = $1", [id]))[0]?.connected_account_id).toBe(b.account);
    });

    it("one provider reply identity links to at most one intent per workspace and platform (23505)", async () => {
      const t = await tenant();
      const first = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment, idempotencyKey: "key-identity-1" });
      const second = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment, idempotencyKey: "key-identity-2" });
      const ids = [first, second].map((r) => (r.status === "ok" && r.value.kind === "requested" ? r.value.intentId : ""));
      await privileged.query("update mutations.outbound_replies set provider_reply_id = 'fb_r_same', confirmed_at = now() where intent_id = $1", [ids[0]]);
      expect(await sqlState(privileged.query("update mutations.outbound_replies set provider_reply_id = 'fb_r_same', confirmed_at = now() where intent_id = $1", [ids[1]]))).toMatchObject({ code: "23505", constraint: "outbound_replies_provider_identity" });
    });

    it("the same key with a different text is refused (IDEMPOTENCY_KEY_REUSED); two concurrent requests with the same key yield exactly one intent", async () => {
      const t = await tenant();
      const first = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment, idempotencyKey: "key-reuse-0001", text: "first text" });
      expect(first.status === "ok" ? first.value.kind : first).toBe("requested");
      const reused = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment, idempotencyKey: "key-reuse-0001", text: "second text" });
      expect(reused.status === "ok" ? reused.value : reused).toEqual({ kind: "refused", reason: "IDEMPOTENCY_KEY_REUSED" });
      const byOther = await request(t, t.users.OWNER, { targetInteractionId: t.comment, idempotencyKey: "key-reuse-0001", text: "first text" });
      expect(byOther.status === "ok" ? byOther.value : byOther).toEqual({ kind: "refused", reason: "IDEMPOTENCY_KEY_REUSED" });
      const results = await Promise.all([1, 2, 3].map(() => request(t, t.users.RESPONDER, { targetInteractionId: t.comment, idempotencyKey: "key-concurrent-0001", text: "same text" })));
      const kinds = results.map((r) => (r.status === "ok" ? r.value.kind : r.status === "error" ? r.error.code : r.status)).sort();
      // One wins; the others see it (existing) or lose the unique race (CONFLICT); never two intents, never two rows.
      expect(kinds.filter((k) => k === "requested")).toHaveLength(1);
      expect(kinds.every((k) => k === "requested" || k === "existing" || k === "CONFLICT")).toBe(true);
      expect((await oracle<{ n: string }>("select count(*)::text as n from mutations.mutation_intents where workspace_id = $1 and idempotency_key = 'key-concurrent-0001'", [t.workspaceId]))[0]?.n).toBe("1");
      expect((await oracle<{ n: string }>("select count(*)::text as n from system.outbox where workspace_id = $1", [t.workspaceId]))[0]?.n).toBe("2");
    });

    it("a member cannot forge history or a reply for another member's intent, nor for their own once it left PENDING", async () => {
      const t = await tenant();
      const owners = await request(t, t.users.OWNER, { targetInteractionId: t.comment });
      const ownerIntent = owners.status === "ok" && owners.value.kind === "requested" ? owners.value.intentId : "";
      const asResponder = (text: string) => withUserScope(web, { sub: t.users.RESPONDER, role: "authenticated" }, t.workspaceId, (tx) => tx.execute(text as never));
      const historyRow = (intent: string) => `insert into mutations.mutation_intent_history (id, organization_id, workspace_id, intent_id, from_status, to_status, attempt, actor, outcome_code, run_reference, correlation_id, occurred_at) values ('${randomUUID()}', '${t.organizationId}', '${t.workspaceId}', '${intent}', null, 'PENDING', 0, 'web', null, null, 'corr-7b1-forged-0002', now())`;
      expect((await sqlState(asResponder(historyRow(ownerIntent)))).code).toBe("42501");
      const mine = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment });
      const mineId = mine.status === "ok" && mine.value.kind === "requested" ? mine.value.intentId : "";
      await privileged.query("update mutations.mutation_intents set status = 'BLOCKED', attempt = 1, run_reference = 'run_x', outcome_code = 'MODE_NOT_STANDARD' where id = $1", [mineId]);
      expect((await sqlState(asResponder(historyRow(mineId)))).code).toBe("42501");
      expect((await sqlState(asResponder(`insert into mutations.outbound_replies (id, organization_id, workspace_id, intent_id, parent_interaction_id, connected_account_id, platform, text, created_at) values ('${randomUUID()}', '${t.organizationId}', '${t.workspaceId}', '${ownerIntent}', '${t.comment}', '${t.account}', 'facebook', 'forged', now())`))).code).toBe("42501");
    });

    it("capability is evaluated for the target's own content: a comment on a story is refused (the simulator catalog: reply_public UNSUPPORTED for stories)", async () => {
      const t = await tenant();
      const story = await secondAccount(t, "story");
      const refused = await request(t, t.users.RESPONDER, { targetInteractionId: story.comment });
      expect(refused.status === "ok" ? refused.value : refused).toEqual({ kind: "refused", reason: "CAPABILITY_UNAVAILABLE" });
      const post = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment });
      expect(post.status === "ok" ? post.value.kind : post).toBe("requested");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("reconciliation never declares a failure", () => {
    it("after a lost response, a reply that cannot be seen any more leaves the intent OUTCOME_UNKNOWN: no FAILED, no history, no resend", async () => {
      const h = harness();
      h.world.injectFaults([{ operation: "replyPublicly", on: 1, fault: { kind: "outcome_unknown" } }]);
      const t = await tenant();
      const text = `${TEXT} ${randomUUID()}`;
      const created = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment, text });
      const id = created.status === "ok" && created.value.kind === "requested" ? created.value.intentId : "";
      await quietPendingOutbox((q, values) => privileged.query(q, values), "topic = $1 and workspace_id <> $2", [TASK, t.workspaceId]);
      await h.step();
      expect(await intentRow(t.workspaceId, id)).toEqual([expect.objectContaining({ status: "OUTCOME_UNKNOWN", outcome_code: "RESPONSE_LOST" })]);
      // The platform no longer lists the reply (removed at source): the lookup finds nothing.
      const applied = h.world.interactions().find((state) => state.text === text)?.id ?? "";
      h.world.removeAtSource(applied, { signaled: true });
      h.world.advanceClock(60);
      const payload = must(h.payloads[0], "payload");
      const result = await runTenantStepJob({ registry: PRODUCTION_TASKS, worker, logger }, TASK, payload, { runId: "run_reconcile_none", attempt: 1 }, (context) => runReconcileIntent(context, h.base, { intentId: id, provider: "simulator" }, { clock: h.clock }));
      expect(result).toEqual({ kind: "still_unknown", reason: "not_found" });
      expect(await intentRow(t.workspaceId, id)).toEqual([expect.objectContaining({ status: "OUTCOME_UNKNOWN", outcome_code: "RESPONSE_LOST" })]);
      expect((await historyRows(t.workspaceId, id)).map((r) => r.to_status)).toEqual(["PENDING", "EXECUTING", "OUTCOME_UNKNOWN"]);
      expect((await auditRows(id)).map((r) => r.action)).toEqual(["mutation_intent.created", "mutation_intent.executing", "mutation_intent.outcome_unknown"]);
      expect(h.world.interactions().filter((state) => state.text === text)).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("Step 7B-4: the integrated walk — request → outbox → relay → executor → simulator → Inbox read, on PostgreSQL", () => {
    const onlyThisWorkspace = (workspaceId: string) => quietPendingOutbox((text, values) => privileged.query(text, values), "topic = $1 and workspace_id <> $2", [TASK, workspaceId]);

    it("one request becomes one PENDING intent (+ reply, history, audit, outbox) in one transaction; the relay delivers it; EXECUTING is persisted before the ONE simulator call; CONFIRMED carries the provider id; the Inbox reads 'sent' from the database — and a later canonical read-back of the same reply is not shown twice", async () => {
      const h = harness();
      const t = await tenant();
      const conversation = await conversationFor(t);
      const text = `${TEXT} walk ${randomUUID()}`;
      // 1–3. the command, through the real pipeline (identity, membership, reply.public, Standard, target, account, capability, key).
      const created = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment, text, idempotencyKey: `form-walk-${randomUUID().slice(0, 8)}` });
      expect(created.status === "ok" ? created.value.kind : created).toBe("requested");
      const id = created.status === "ok" && created.value.kind === "requested" ? created.value.intentId : "";
      expect(await intentRow(t.workspaceId, id)).toEqual([expect.objectContaining({ status: "PENDING", attempt: 0, run_reference: null, outcome_code: null, initiator_user_id: t.users.RESPONDER })]);
      expect((await oracle<{ n: string }>("select count(*)::text as n from system.outbox where workspace_id = $1 and topic = $2 and status = 'PENDING'", [t.workspaceId, TASK]))[0]?.n).toBe("1");
      // The Inbox already shows the requested reply as "sending": nothing is optimistic, this is the persisted PENDING row.
      const before = await inboxView(t, t.users.RESPONDER, conversation);
      expect(before.status === "ok" ? before.value.outbound.map((o) => [o.parentInteractionId === t.comment, o.state, o.text === text]) : before).toEqual([[true, "sending", true]]);
      expect(before.status === "ok" ? before.value.reply.kind : before).toBe("available");
      await onlyThisWorkspace(t.workspaceId);
      // 4–7. the real relay → the fake runtime → the REAL integration handler → the simulator's mutation port, once.
      expect(h.providerCalls).toEqual([]);
      await h.step();
      expect(h.providerCalls).toEqual(["replyPublicly:fb_c_010"]);
      const row = must((await intentRow(t.workspaceId, id))[0], "intent");
      expect(row).toMatchObject({ status: "CONFIRMED", attempt: 1, outcome_code: null });
      expect(row.run_reference).not.toBeNull();
      const reply = must((await replyRow(t.workspaceId, id))[0], "reply");
      expect(reply.provider_reply_id).not.toBeNull();
      expect(reply.confirmed_at).not.toBeNull();
      expect(h.world.interaction(reply.provider_reply_id ?? "")).toMatchObject({ parent: "fb_c_010", text });
      // 5. EXECUTING was persisted BEFORE the call: the history has the EXECUTING row with the run that then confirmed.
      expect((await historyRows(t.workspaceId, id)).map((r) => [r.from_status, r.to_status, r.actor, r.attempt])).toEqual([[null, "PENDING", "web", 0], ["PENDING", "EXECUTING", "executor", 1], ["EXECUTING", "CONFIRMED", "executor", 1]]);
      expect((await auditRows(id)).map((r) => [r.action, r.actor_type])).toEqual([["mutation_intent.created", "user"], ["mutation_intent.executing", "system"], ["mutation_intent.confirmed", "system"]]);
      // 8. the Inbox reads the persisted CONFIRMED state as "sent", under the right comment, with the provider identity.
      const after = await inboxView(t, t.users.RESPONDER, conversation);
      expect(after.status === "ok" ? after.value.outbound.map((o) => [o.parentInteractionId === t.comment, o.state, o.confirmedAt !== null]) : after).toEqual([[true, "sent", true]]);
      // A second relay pass re-delivers nothing: the row is DISPATCHED, the simulator was called once.
      await h.step();
      expect(h.providerCalls).toHaveLength(1);
      // Later, the platform's own read-back of that reply arrives as a canonical member with the SAME provider id (as
      // ingestion writes it): the thread shows the canonical member and no longer repeats the outbound row.
      await privileged.query(`insert into interactions.authors (id, organization_id, workspace_id, platform, provider_author_id, role, label, created_at, updated_at) values ($1, $2, $3, 'facebook', 'fb_page_aurora', 'account_identity', null, now(), now()) on conflict do nothing`, [randomUUID(), t.organizationId, t.workspaceId]);
      const brand = (await oracle<{ id: string }>("select id from interactions.authors where workspace_id = $1 and role = 'account_identity' limit 1", [t.workspaceId]))[0]?.id ?? "";
      const canonical = randomUUID();
      await privileged.query(
        `insert into interactions.interactions (id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id, provider_content_id, observed, parent_interaction_id, kind, author_id, author_role, conversation_id,
           current_visibility, current_availability, provider_created_at, state_observed_at, first_observed_at, latest_observed_at, created_at, updated_at)
         values ($1, $2, $3, 'facebook', $4, $5, 'fb_page_aurora', $6, 'fb_post_boosted_02', true, $7, 'reply', $8, 'account_identity', $9, 'visible', 'available', now(), now(), now(), now(), now(), now())`,
        [canonical, t.organizationId, t.workspaceId, reply.provider_reply_id, t.account, t.content, t.comment, brand, conversation],
      );
      const readBack = await inboxView(t, t.users.RESPONDER, conversation);
      expect(readBack.status).toBe("ok");
      if (readBack.status !== "ok") return;
      expect(readBack.value.outbound).toEqual([]);
      expect(readBack.value.thread.filter((member) => member.author === "own_account" && member.parentInteractionId === t.comment).map((member) => member.interactionId)).toEqual([canonical]);
      // Members who can't reply see the same persisted states; a guest sees nothing (pipeline PERMISSION_DENIED).
      const analyst = await inboxView(t, t.users.ANALYST_VIEWER, conversation);
      expect(analyst.status === "ok" ? [analyst.value.reply.kind, analyst.value.outbound.length] : analyst).toEqual(["hidden", 0]);
      const guest = await inboxView(t, t.users.CLIENT_GUEST, conversation);
      expect(guest.status === "error" ? guest.error.code : guest).toBe("PERMISSION_DENIED");
    });

    it("a definite provider refusal (the target is gone at the platform) is FAILED after ONE call; a second delivery sends nothing", async () => {
      const h = harness();
      h.world.injectFaults([{ operation: "replyPublicly", on: 1, fault: { kind: "target_not_found" } }]);
      const t = await tenant();
      const created = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment, text: `${TEXT} gone ${randomUUID()}` });
      const id = created.status === "ok" && created.value.kind === "requested" ? created.value.intentId : "";
      await onlyThisWorkspace(t.workspaceId);
      await h.step();
      expect(await intentRow(t.workspaceId, id)).toEqual([expect.objectContaining({ status: "FAILED", attempt: 1, outcome_code: "TARGET_NOT_FOUND" })]);
      expect(h.providerCalls).toHaveLength(1);
      expect((await auditRows(id)).map((r) => [r.action, r.outcome])).toEqual([["mutation_intent.created", "succeeded"], ["mutation_intent.executing", "succeeded"], ["mutation_intent.failed", "failed"]]);
      await h.step();
      expect(h.providerCalls).toHaveLength(1);
      const conversation = await conversationFor(t);
      const view = await inboxView(t, t.users.RESPONDER, conversation);
      expect(view.status === "ok" ? view.value.outbound.map((o) => o.state) : view).toEqual(["failed"]);
    });

    it("a redelivered run after EXECUTING never sends again: the intent becomes OUTCOME_UNKNOWN (RUN_INTERRUPTED) with ZERO provider calls, and the Inbox shows 'checking'", async () => {
      const h = harness();
      const t = await tenant();
      const created = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment, text: `${TEXT} crash ${randomUUID()}` });
      const id = created.status === "ok" && created.value.kind === "requested" ? created.value.intentId : "";
      await onlyThisWorkspace(t.workspaceId);
      // The first run died right after committing EXECUTING (the only state a crash between the two transactions can
      // leave); its outbox row is then delivered again — exactly what the run-outcome sweeper does for a lost run.
      await withWorkspaceJobScope(worker, t.workspaceId, (tx) => tx.execute(`update mutations.mutation_intents set status = 'EXECUTING', attempt = 1, run_reference = 'run_crashed' where id = '${id}'` as never));
      await h.step();
      expect(h.providerCalls).toEqual([]);
      expect(await intentRow(t.workspaceId, id)).toEqual([expect.objectContaining({ status: "OUTCOME_UNKNOWN", attempt: 1, outcome_code: "RUN_INTERRUPTED" })]);
      expect((await historyRows(t.workspaceId, id)).map((r) => [r.to_status, r.outcome_code])).toEqual([["PENDING", null], ["OUTCOME_UNKNOWN", "RUN_INTERRUPTED"]]);
      const conversation = await conversationFor(t);
      const view = await inboxView(t, t.users.RESPONDER, conversation);
      expect(view.status === "ok" ? view.value.outbound.map((o) => o.state) : view).toEqual(["checking"]);
      // No automatic resend ever: the same real payload delivered once more is a noop (still 0 calls), and
      // reconciliation is not invoked here (Step 7B-4 leaves it unwired; its cross-intent blocker stands).
      const payload = must(h.payloads.at(-1), "payload");
      await runTenantStepJob({ registry: PRODUCTION_TASKS, worker, logger }, TASK, payload, { runId: "run_redelivered_2", attempt: 1 }, (context) => runExecuteIntent(context, h.base, { clock: h.clock }));
      expect(h.providerCalls).toEqual([]);
      expect(await intentRow(t.workspaceId, id)).toEqual([expect.objectContaining({ status: "OUTCOME_UNKNOWN", outcome_code: "RUN_INTERRUPTED" })]);
    });

    it("the Inbox's reply affordance follows the real guards: Monitor-only → unavailable (mode), a role without reply.public → hidden", async () => {
      const t = await tenant("MONITOR_ONLY");
      const conversation = await conversationFor(t);
      const owner = await inboxView(t, t.users.OWNER, conversation);
      expect(owner.status === "ok" ? owner.value.reply : owner).toEqual({ kind: "unavailable", reason: "monitor_only", platform: "facebook" });
      const analyst = await inboxView(t, t.users.ANALYST_VIEWER, conversation);
      expect(analyst.status === "ok" ? analyst.value.reply : analyst).toEqual({ kind: "hidden" });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("Step 7B-5: cross-intent reconciliation safety on PostgreSQL (two intents, same account, comment and text)", () => {
    const onlyThisWorkspace = (workspaceId: string) => quietPendingOutbox((text, values) => privileged.query(text, values), "topic = $1 and workspace_id <> $2", [TASK, workspaceId]);
    const reconcile = (h: Harness, intentId: string, runId: string) =>
      runTenantStepJob({ registry: PRODUCTION_TASKS, worker, logger }, TASK, must(h.payloads.at(-1), "payload"), { runId, attempt: 1 }, (context) => runReconcileIntent(context, h.base, { intentId, provider: "simulator" }, { clock: h.clock }));

    it("A unknown without publishing, B published and lost its answer: reconciling A and B — sequentially and concurrently — keeps both OUTCOME_UNKNOWN, links no identity, sends nothing", async () => {
      const h = harness();
      const t = await tenant();
      const text = `${TEXT} ab ${randomUUID()}`;
      // A: requested first; its run dies right after EXECUTING, so its redelivery records RUN_INTERRUPTED with no call.
      const a = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment, text, idempotencyKey: `form-a-${randomUUID().slice(0, 8)}` });
      const aId = a.status === "ok" && a.value.kind === "requested" ? a.value.intentId : "";
      await onlyThisWorkspace(t.workspaceId);
      await withWorkspaceJobScope(worker, t.workspaceId, (tx) => tx.execute(`update mutations.mutation_intents set status = 'EXECUTING', attempt = 1, run_reference = 'run_a_crashed' where id = '${aId}'` as never));
      await h.step();
      expect(h.providerCalls).toEqual([]);
      expect(await intentRow(t.workspaceId, aId)).toEqual([expect.objectContaining({ status: "OUTCOME_UNKNOWN", outcome_code: "RUN_INTERRUPTED" })]);
      // B: same account, target and text, another form; it really publishes and loses the answer.
      const b = await request(t, t.users.OWNER, { targetInteractionId: t.comment, text, idempotencyKey: `form-b-${randomUUID().slice(0, 8)}` });
      const bId = b.status === "ok" && b.value.kind === "requested" ? b.value.intentId : "";
      h.world.injectFaults([{ operation: "replyPublicly", on: 1, fault: { kind: "outcome_unknown" } }]);
      await h.step();
      expect(h.providerCalls).toEqual(["replyPublicly:fb_c_010"]);
      expect(await intentRow(t.workspaceId, bId)).toEqual([expect.objectContaining({ status: "OUTCOME_UNKNOWN", outcome_code: "RESPONSE_LOST" })]);
      expect(h.world.interactions().filter((state) => state.text === text)).toHaveLength(1);
      h.world.advanceClock(60);
      // Sequential: each sees the other as a plausible producer of the one reply.
      expect(await reconcile(h, aId, "run_rec_a")).toEqual({ kind: "still_unknown", reason: "competing_intents" });
      expect(await reconcile(h, bId, "run_rec_b")).toEqual({ kind: "still_unknown", reason: "competing_intents" });
      // Concurrent: the same, on two worker transactions at once.
      expect(await Promise.all([reconcile(h, aId, "run_rec_a2"), reconcile(h, bId, "run_rec_b2")])).toEqual([{ kind: "still_unknown", reason: "competing_intents" }, { kind: "still_unknown", reason: "competing_intents" }]);
      for (const id of [aId, bId]) {
        expect(await intentRow(t.workspaceId, id)).toEqual([expect.objectContaining({ status: "OUTCOME_UNKNOWN" })]);
        expect((await replyRow(t.workspaceId, id))[0]?.provider_reply_id).toBeNull();
      }
      expect(h.providerCalls).toHaveLength(1);
      expect((await oracle<{ n: string }>("select count(*)::text as n from mutations.outbound_replies where workspace_id = $1 and provider_reply_id is not null", [t.workspaceId]))[0]?.n).toBe("0");
      expect((await oracle<{ n: string }>("select count(*)::text as n from audit.audit_events where target_type = 'mutation_intent' and target_id in ($1, $2) and action in ('mutation_intent.confirmed', 'mutation_intent.reconciled')", [aId, bId]))[0]?.n).toBe("0");
    });

    it("an unambiguous reply (no competitor) still confirms through reconciliation; a competitor already holding the identity blocks another claim", async () => {
      const h = harness();
      const t = await tenant();
      const text = `${TEXT} single ${randomUUID()}`;
      const only = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment, text });
      const onlyId = only.status === "ok" && only.value.kind === "requested" ? only.value.intentId : "";
      await onlyThisWorkspace(t.workspaceId);
      h.world.injectFaults([{ operation: "replyPublicly", on: 1, fault: { kind: "outcome_unknown" } }]);
      await h.step();
      h.world.advanceClock(60);
      const confirmed = await reconcile(h, onlyId, "run_rec_single");
      expect(confirmed.kind).toBe("confirmed");
      const linkedId = (await replyRow(t.workspaceId, onlyId))[0]?.provider_reply_id ?? "";
      expect(linkedId).not.toBe("");
      // A later intent with the same text, left unknown without publishing, finds that reply: it belongs to someone else.
      const late = await request(t, t.users.OWNER, { targetInteractionId: t.comment, text });
      const lateId = late.status === "ok" && late.value.kind === "requested" ? late.value.intentId : "";
      await withWorkspaceJobScope(worker, t.workspaceId, (tx) => tx.execute(`update mutations.mutation_intents set status = 'EXECUTING', attempt = 1, run_reference = 'run_late_crashed' where id = '${lateId}'` as never));
      await h.step();
      expect(h.providerCalls).toHaveLength(1);
      expect(await reconcile(h, lateId, "run_rec_late")).toEqual({ kind: "still_unknown", reason: "identity_linked_elsewhere" });
      expect((await replyRow(t.workspaceId, lateId))[0]?.provider_reply_id).toBeNull();
      // The identity index is the last word: even a privileged second link of the same provider reply is refused.
      expect(await sqlState(privileged.query("update mutations.outbound_replies set provider_reply_id = $1, confirmed_at = now() where intent_id = $2", [linkedId, lateId]))).toMatchObject({ code: "23505", constraint: "outbound_replies_provider_identity" });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("Step 7B-12A: fail-closed mutation authorization on PostgreSQL (explicit_allow, read in the transaction)", () => {
    const onlyThisWorkspace = (workspaceId: string) => quietPendingOutbox((text, values) => privileged.query(text, values), "topic = $1 and workspace_id <> $2", [TASK, workspaceId]);
    const unique = (): string => `${TEXT} ${randomUUID()}`;

    it("nothing granted → the request is refused before anything is written, and the Inbox reads 'not enabled' (platform reason), never an available control", async () => {
      const t = await tenant();
      const conversationId = await conversationFor(t);
      await withdraw();
      try {
        const refused = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment, text: unique() });
        expect(refused.status === "ok" ? refused.value : refused).toMatchObject({ kind: "refused", reason: "PROVIDER_ACTIONS_DISABLED" });
        expect(await oracle("select 1 from mutations.mutation_intents where workspace_id = $1", [t.workspaceId])).toHaveLength(0);
        const view = await inboxView(t, t.users.RESPONDER, conversationId);
        expect(view.status === "ok" ? view.value.reply : view).toMatchObject({ kind: "unavailable", reason: "platform_unavailable" });
      } finally {
        await authorize(true);
      }
    });

    it("the '*' emergency block beats the exact grant: refused at request time, and the Inbox reads 'paused'", async () => {
      const t = await tenant();
      const conversationId = await conversationFor(t);
      await withOperator((client) => setSwitch(client, WILDCARD, { enabled: false }, SWITCH_OPERATOR));
      try {
        const refused = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment, text: unique() });
        expect(refused.status === "ok" ? refused.value : refused).toMatchObject({ kind: "refused", reason: "PROVIDER_ACTIONS_DISABLED" });
        const view = await inboxView(t, t.users.RESPONDER, conversationId);
        expect(view.status === "ok" ? view.value.reply : view).toMatchObject({ kind: "unavailable", reason: "paused" });
      } finally {
        await withOperator((client) => clearSwitch(client, WILDCARD, SWITCH_OPERATOR));
      }
    });

    it("revoked between the request and the execution → the executor re-reads it in the EXECUTING transaction: BLOCKED PROVIDER_ACTIONS_DISABLED, nothing sent", async () => {
      const h = harness();
      const t = await tenant();
      const created = await request(t, t.users.RESPONDER, { targetInteractionId: t.comment, text: unique() });
      const id = created.status === "ok" && created.value.kind === "requested" ? created.value.intentId : "";
      expect(id).not.toBe("");
      await onlyThisWorkspace(t.workspaceId);
      await authorize(false);
      try {
        const before = h.world.interactions().length;
        await h.step();
        expect(await intentRow(t.workspaceId, id)).toEqual([expect.objectContaining({ status: "BLOCKED", attempt: 1, outcome_code: "PROVIDER_ACTIONS_DISABLED" })]);
        expect(h.world.interactions()).toHaveLength(before);
        expect((await replyRow(t.workspaceId, id))[0]?.provider_reply_id).toBeNull();
      } finally {
        await authorize(true);
      }
    });
  });
}
