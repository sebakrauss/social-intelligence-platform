/**
 * Step 7B-14G1 — the one-time validation authorization (0028) integrated into the ONE request and executor path, on
 * the real database. Synthetic tenants only; the Instagram account is evaluated with the PRODUCTIVE Meta catalog
 * (reply_public UNKNOWN_NOT_VALIDATED / CATALOG_NOT_VALIDATED, r5) and NO provider-action grant exists (today's DEV
 * state); the provider is the REAL Meta mutation port on the REAL write transport with a FAKE fetch (never the network);
 * the credential opener is synthetic (no KMS). Authorizations are issued and revoked the way the operator tooling would
 * (privileged transaction + transaction-local operator declaration) — never by the runtimes.
 *
 *   request     the real action pipeline (web login, sealed workspace, RLS): an ordinary request is unchanged; a request
 *               naming an admitting authorization creates the PENDING intent bound to it in the same transaction; every
 *               other authorization (absent, another workspace / account / comment / initiator, expired, revoked,
 *               consumed, bound) is refused with ONE closed reason and writes nothing; two concurrent binds → one
 *   executor    the real worker composition: admitted → EXECUTING (consumed by 0028's trigger in that commit) → ONE POST →
 *               CONFIRMED; revocation / expiry racing the EXECUTING commit → BLOCKED, never consumed, zero POSTs (F);
 *               a second consumption for the target refused by the unique index mid-flight → BLOCKED (X2, deterministic);
 *               a worker same-status rewrite is detected before the call (X1); a pause or the emergency block — before
 *               or after EXECUTING — stops it; OUTCOME_UNKNOWN and redelivery never send again; nothing re-arms
 *   inert       no switch row, grant, catalog or profile change is ever made by any of it: 18/18 still DENY
 */
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { providerCredential } from "@/integrations/providers/contract/credential";
import { createMetaGraphWriteTransport, type MetaGraphFetch } from "@/integrations/providers/meta/graph-transport";
import { createMetaMutationPort } from "@/integrations/providers/meta/mutation-port";
import { PLATFORM_CATALOG, evaluateAndStore, type FactsInput } from "@/modules/capability";
import { createPostgresCapabilityStore } from "@/modules/capability/persistence";
import type { ProviderCredentialAccess } from "@/modules/connections";
import { parseUserId } from "@/domain/ids";
import { MUTATION_ACTIONS, resolveSwitch } from "@/platform/flags";
import { postgresError, withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { runTenantStepJob } from "@/platform/jobs";
import { createLogger, type Logger } from "@/platform/observability";
import { createPostgresIntentStore } from "@/mutations/persistence";
import { executeIntent, type ExecutionResult, type ExecutorStores } from "@/mutations/executor/execute";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { createActionPipeline } from "@/server/pipeline";
import { requestPublicReplyCommand } from "@/server/commands/mutations";
import { credentialUse, selectMutationPorts } from "@/jobs/mutations";
import { executorStores } from "@/server/persistence/mutation-execution";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { clearSwitch, setSwitch } from "../../../tools/ops/switches";
import { FakeIdentity, verifiedUser } from "../../support/in-memory";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";
import { quietPendingOutbox } from "./helpers";
import { providerObjectRef } from "@/integrations/providers/contract";
import { createInstagramReplyLookup, type InstagramReplyLookupTransport } from "@/integrations/providers/meta/instagram-reply-lookup";
import { instagramReplyLookupPort } from "@/jobs/integration-mutation-reconcile";
import { reconcileIntent } from "@/mutations/executor/reconcile";
import { recordValidationPreflight } from "@/mutations/persistence/validation-preflights";
import { operatorLogin } from "../support/validation-operator";

const TASK = "mutations.execute_intent";
const ROLES = ["OWNER", "RESPONDER", "RESPONDER_2", "ANALYST_VIEWER"] as const;
type Role = (typeof ROLES)[number];
const OPERATOR = { operator: "ops.validation-integration", reason: "test" } as const;
const SWITCH_OPERATOR = { operator: "ops.validation-integration", reason: "test" } as const;
const PREFLIGHT = "run_7b14g1synthetic000000001";
const IG_PERMISSIONS = ["business_management", "instagram_basic", "instagram_manage_comments", "pages_read_engagement", "pages_read_user_content", "pages_show_list", "public_profile"];
const WILDCARD = { key: "mutation.provider_action", qualifier: "*", scope: "global" } as const;
const INSTAGRAM = { key: "mutation.provider_action", qualifier: "instagram:public_reply", scope: "global" } as const;
const TEXT = "Gracias por escribirnos (7B-14G1 DB).";

interface IgAccount {
  readonly account: string;
  readonly asset: string;
  readonly comment: string;
  readonly commentProviderId: string;
  readonly otherComment: string;
  readonly nested: string;
}
interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly users: Readonly<Record<Role, string>>;
  readonly connection: string;
  readonly ig: IgAccount;
}

export function defineValidationIntegrationSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let logger: Logger;
  const organizations: string[] = [];
  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const asOperator = async <T>(declaration: { readonly operator: string; readonly reason: string }, work: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await privileged.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.operator_id', $1, true), set_config('app.change_reason', $2, true)", [declaration.operator, declaration.reason]);
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  };
  const withClient = async <T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await privileged.connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  };

  /** An ACTIVE Instagram account on `connection`, evaluated with the PRODUCTIVE Meta catalog; two top-level comments and a nested reply. */
  const instagramAccount = async (organizationId: string, workspaceId: string, connection: string): Promise<IgAccount> => {
    const asset = `1784140${randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "1")}`;
    const discovered = randomUUID();
    await privileged.query(
      `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'instagram', $5, 'content_bearing', 'Synthetic IG', now(), now(), now())`,
      [discovered, organizationId, workspaceId, connection, asset],
    );
    const account = randomUUID();
    await privileged.query(
      `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
       select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`,
      [account, discovered],
    );
    const facts: FactsInput = { kind: "available", assetClass: "content_bearing", grantedPermissions: IG_PERMISSIONS, linkedAdAccountIds: [], accountIdentityKnown: true, obtainedAt: new Date() };
    await withWorkspaceJobScope(worker, workspaceId, (tx) =>
      evaluateAndStore(createPostgresCapabilityStore(tx), { organizationId, workspaceId, connectedAccountId: account, catalog: PLATFORM_CATALOG, platform: "instagram", assetClass: "content_bearing", facts, observations: [], evaluatedAt: new Date() }),
    );
    const content = randomUUID();
    const media = `1780000${randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "2")}`;
    await privileged.query(
      `insert into content.content_items (id, organization_id, workspace_id, platform, connected_account_id, provider_asset_id, provider_content_id, content_kind, reported_source, source_state, first_observed_at, latest_observed_at, created_at, updated_at)
       values ($1, $2, $3, 'instagram', $4, $5, $6, 'post', 'organic', 'available', now(), now(), now(), now())`,
      [content, organizationId, workspaceId, account, asset, media],
    );
    const author = randomUUID();
    await privileged.query(`insert into interactions.authors (id, organization_id, workspace_id, platform, provider_author_id, role, label, created_at, updated_at) values ($1, $2, $3, 'instagram', $4, 'user', null, now(), now())`, [author, organizationId, workspaceId, `ig_u_${randomUUID().slice(0, 8)}`]);
    const interaction = async (parent: string | null): Promise<{ readonly id: string; readonly providerId: string }> => {
      const id = randomUUID();
      const providerId = `1790000${randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "3")}`;
      await privileged.query(
        `insert into interactions.interactions (id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id, provider_content_id, observed, kind, parent_interaction_id, author_id, author_role,
           current_visibility, current_availability, provider_created_at, state_observed_at, first_observed_at, latest_observed_at, created_at, updated_at)
         values ($1, $2, $3, 'instagram', $4, $5, $6, $7, $8, true, $9, $10, $11, 'user', 'visible', 'available', now() - interval '1 hour', now(), now(), now(), now(), now())`,
        [id, organizationId, workspaceId, providerId, account, asset, content, media, parent === null ? "comment" : "reply", parent, author],
      );
      return { id, providerId };
    };
    const comment = await interaction(null);
    const otherComment = await interaction(null);
    const nested = await interaction(comment.id);
    return { account, asset, comment: comment.id, commentProviderId: comment.providerId, otherComment: otherComment.id, nested: nested.id };
  };

  const tenant = async (): Promise<Tenant> => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    organizations.push(organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Validation integration', now())", [organizationId]);
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'STANDARD', now())", [workspaceId, organizationId]);
    const users = {} as Record<Role, string>;
    for (const role of ROLES) {
      const user = randomUUID();
      users[role] = user;
      await privileged.query("insert into tenancy.organization_memberships values ($1, $2, $3, now())", [organizationId, user, role === "OWNER" ? "OWNER" : "MEMBER"]);
      await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, $4, '{}', now())", [organizationId, workspaceId, user, role === "RESPONDER_2" ? "RESPONDER" : role]);
    }
    const connection = randomUUID();
    const credential = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`,
      [connection, organizationId, workspaceId, users.OWNER],
    );
    await privileged.query(
      `insert into credentials.provider_credentials (id, organization_id, workspace_id, connection_id, credential_version, envelope, created_at) values ($1, $2, $3, $4, 1, $5, now())`,
      [credential, organizationId, workspaceId, connection, Buffer.concat([Buffer.from("5349504501", "hex"), randomBytes(64)])],
    );
    await privileged.query("update connections.connections set active_credential_id = $1 where id = $2", [credential, connection]);
    return { organizationId, workspaceId, users, connection, ig: await instagramAccount(organizationId, workspaceId, connection) };
  };

  /** Issues as the operator tooling would (privileged, declared); returns the id. */
  const issue = (t: Tenant, options: { readonly account?: string; readonly target?: string; readonly initiator?: string; readonly lifetime?: string } = {}): Promise<string> => {
    const id = randomUUID();
    return asOperator(OPERATOR, async (client) => {
      await client.query(
        `insert into mutations.validation_authorizations (id, organization_id, workspace_id, connected_account_id, target_interaction_id, initiator_user_id, provider, platform, kind,
           preflight_run_reference, preflight_completed_at, expires_at)
         values ($1, $2, $3, $4, $5, $6, 'meta', 'instagram', 'reply_public', $7, now() - interval '5 minutes', now() + $8::interval)`,
        [id, t.organizationId, t.workspaceId, options.account ?? t.ig.account, options.target ?? t.ig.comment, options.initiator ?? t.users.RESPONDER, PREFLIGHT, options.lifetime ?? "60 minutes"],
      );
      return id;
    });
  };
  const revoke = (t: Tenant, id: string) =>
    asOperator({ operator: OPERATOR.operator, reason: "test" }, (client) => client.query("update mutations.validation_authorizations set revoked_at = now() where workspace_id = $1 and id = $2", [t.workspaceId, id]));
  const authorizationRow = async (t: Tenant, id: string) =>
    (await oracle<{ intent_id: string | null; bound: boolean; consumed: boolean; revoked: boolean }>(
      "select intent_id, bound_at is not null as bound, consumed_at is not null as consumed, revoked_at is not null as revoked from mutations.validation_authorizations where workspace_id = $1 and id = $2", [t.workspaceId, id]))[0];
  /** Waits (bounded) until the database's clock has passed the authorization's expiry. */
  const untilExpired = async (t: Tenant, id: string): Promise<void> => {
    for (let i = 0; i < 100; i += 1) {
      const rows = await oracle<{ expired: boolean }>("select clock_timestamp() >= expires_at as expired from mutations.validation_authorizations where workspace_id = $1 and id = $2", [t.workspaceId, id]);
      if (rows[0]?.expired === true) return;
      await sleep(100);
    }
    throw new Error("the authorization never expired");
  };

  const request = async (t: Tenant, user: string, input: { readonly target?: string; readonly authorization?: string; readonly key?: string; readonly text?: string; readonly validation?: true }) => {
    const identity = new FakeIdentity(verifiedUser(parseUserId(user) ?? (() => { throw new Error("user"); })()));
    const pipeline = createActionPipeline({ identity, unitOfWork: createPostgresUnitOfWork(web), clock: () => new Date(), newId: randomUUID, logger });
    const result = await pipeline.run(requestPublicReplyCommand, {
      workspaceId: t.workspaceId,
      input: {
        targetInteractionId: input.target ?? t.ig.comment, text: input.text ?? TEXT, idempotencyKey: input.key ?? `form-${randomUUID()}`,
        ...(input.authorization === undefined ? {} : { validationAuthorizationId: input.authorization }),
        // Step 7B-14I2: the Inbox's mode flag — the server resolves the member's own live authorization.
        ...(input.validation === true ? { validation: true } : {}),
      },
    });
    await quietPendingOutbox((text, values) => privileged.query(text, values), "topic = $1 and workspace_id = $2", [TASK, t.workspaceId]);
    return result.status === "ok" ? result.value : result;
  };
  const requested = async (t: Tenant, authorization: string): Promise<string> => {
    const outcome = await request(t, t.users.RESPONDER, { authorization });
    if (!("kind" in outcome) || outcome.kind !== "requested") throw new Error(`expected a request, got ${JSON.stringify(outcome)}`);
    return outcome.intentId;
  };
  const intentRow = async (t: Tenant, id: string) =>
    (await oracle<{ status: string; attempt: number; run_reference: string | null; outcome_code: string | null; validation_authorization_id: string | null }>(
      "select status, attempt, run_reference, outcome_code, validation_authorization_id from mutations.mutation_intents where workspace_id = $1 and id = $2", [t.workspaceId, id]))[0];
  const historyOf = async (t: Tenant, id: string) =>
    (await oracle<{ to_status: string }>("select to_status from mutations.mutation_intent_history where workspace_id = $1 and intent_id = $2 order by occurred_at, array_position(array['PENDING','EXECUTING','OUTCOME_UNKNOWN','CONFIRMED','FAILED','BLOCKED'], to_status)", [t.workspaceId, id])).map((r) => r.to_status);
  const intentsOf = async (t: Tenant) => (await oracle<{ n: number }>("select count(*)::int as n from mutations.mutation_intents where workspace_id = $1", [t.workspaceId]))[0]?.n;

  interface Run {
    readonly posts: string[];
    readonly opened: string[];
    readonly run: (t: Tenant, intentId: string, options?: {
      readonly runId?: string;
      /**
       * Called before each deps.inScope. Authorized intent (Step 7B-14H1): 1 = admit, 2 = gate before the credential is
       * opened (or the F/X2 recovery), 3 = gate after it was opened, 4 = finish. The credential use's own authority read
       * runs in the job context directly (not counted).
       */
      readonly beforeScope?: (n: number) => Promise<void>;
      readonly wrap?: (stores: ExecutorStores, n: number) => ExecutorStores;
      readonly beforeCredential?: () => Promise<void>;
      /** Step 7B-14H1: runs inside the (synthetic) key service AFTER it handed the credential over, BEFORE the executor's callback. */
      readonly afterOpen?: () => Promise<void>;
      /** Step 7B-14H1: the key service fails (as a KMS Decrypt outage would) before handing anything over. */
      readonly keyServiceFails?: boolean;
    }) => Promise<ExecutionResult>;
  }
  /** The real worker composition with the REAL Meta port on a FAKE fetch, and a synthetic credential opener. */
  const execution = (answer: "created" | "lost" = "created", hooks: { readonly onPost?: () => Promise<void> } = {}): Run => {
    const posts: string[] = [];
    const opened: string[] = [];
    const fetch: MetaGraphFetch = async (url) => {
      posts.push(new URL(url).pathname);
      await hooks.onPost?.();
      if (answer === "lost") return Promise.reject(new Error("socket hang up"));
      return Promise.resolve(new Response(JSON.stringify({ id: `1799999${String(posts.length).padStart(8, "0")}` }), { status: 200, headers: { "content-type": "application/json" } }));
    };
    const providers = selectMutationPorts({ simulator: undefined, instagram: createMetaMutationPort({ transport: createMetaGraphWriteTransport({ fetch, timeoutMs: 100 }) }) });
    const run: Run["run"] = (t, intentId, options = {}) => {
      const access: ProviderCredentialAccess = {
        withCredential: async (input, use) => {
          if (options.keyServiceFails === true) throw Object.assign(new Error("KMS Decrypt: service unavailable (synthetic)"), { name: "KMSInternalException" });
          opened.push(input.credentialId);
          const credential = providerCredential("cred-synthetic", "synthetic-user-token");
          await options.afterOpen?.();
          return use(credential);
        },
      };
      const runId = options.runId ?? `run_7b14g1_${randomUUID().slice(0, 8)}`;
      const clock = { newId: randomUUID, now: () => new Date() };
      const payload = { v: 1, scope: "workspace", task: TASK, workspaceId: t.workspaceId, outboxId: randomUUID(), subjectIds: { connected_account_id: t.ig.account, mutation_intent_id: intentId }, correlationId: "corr-7b14g1-db-0001", initiator: { type: "user", userId: t.users.RESPONDER } };
      let scopes = 0;
      return runTenantStepJob({ registry: PRODUCTION_TASKS, worker, logger }, TASK, payload, { runId, attempt: 1 }, async (context) => {
        const credentials = credentialUse(context, access);
        return executeIntent(
          {
            inScope: async (work) => {
              scopes += 1;
              await options.beforeScope?.(scopes);
              return context.inScope((scope) => {
                const stores = executorStores(scope, clock.newId);
                return work(options.wrap === undefined ? stores : options.wrap(stores, scopes));
              });
            },
            credentials: { withAccess: async (input, use) => {
              await options.beforeCredential?.();
              return credentials.withAccess(input, use);
            } },
            providers,
            clock,
          },
          { workspaceId: t.workspaceId, intentId, runReference: runId },
        );
      });
    };
    return { posts, opened, run };
  };

  /** Wraps the executor's authorization read: `after` runs ONCE (first read of the run), before EXECUTING. */
  const afterAuthorizationRead = (after: () => Promise<void>) => {
    let done = false;
    return (stores: ExecutorStores): ExecutorStores => {
    const validation = stores.validation;
    if (validation === undefined) return stores;
    return {
      ...stores,
      validation: {
        ...validation,
        authorization: async (workspaceId, id) => {
          const reading = await validation.authorization(workspaceId, id);
          if (!done) {
            done = true;
            await after();
          }
          return reading;
        },
      },
    };
    };
  };

  /** The provider-action rows as they stand, and the 18 decisions resolved from them (Step 7B-12A). */
  const providerActionState = async () => {
    const rows = await oracle<{ switch_key: string; qualifier: string; scope: string; organization_id: string | null; workspace_id: string | null; value: unknown }>(
      "select switch_key, qualifier, scope, organization_id, workspace_id, value from system.operational_switches where switch_key = 'mutation.provider_action'");
    const input = rows.map((r) => ({ switchKey: r.switch_key, qualifier: r.qualifier, scope: r.scope, organizationId: r.organization_id, workspaceId: r.workspace_id, value: r.value }));
    let allowed = 0;
    for (const platform of ["facebook", "instagram", "tiktok"]) for (const action of MUTATION_ACTIONS) {
      const resolved = resolveSwitch(input as never, "mutation.provider_action", { qualifier: `${platform}:${action}` });
      if (resolved.value.enabled && !resolved.failSafe) allowed += 1;
    }
    return { rows: rows.length, decisions: 3 * MUTATION_ACTIONS.length, allowed };
  };

  beforeAll(async () => {
    const target = getTarget();
    privileged = privilegedPool(target, 8);
    web = runtimeDatabase(target, "web", 8);
    worker = runtimeDatabase(target, "worker", 8);
    logger = createLogger({ sink: () => undefined });
    // Today's DEV state: no provider-action row at all → 18/18 DENY (explicit_allow, Step 7B-12A).
    expect(await providerActionState()).toEqual({ rows: 0, decisions: 18, allowed: 0 });
  });

  afterAll(async () => {
    await withClient(async (client) => {
      await clearSwitch(client, WILDCARD, SWITCH_OPERATOR);
      await clearSwitch(client, INSTAGRAM, SWITCH_OPERATOR);
    });
    await cleanupWorld(privileged, organizations);
    await Promise.all([web.end(), worker.end()]);
    await privileged.end();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("1 · the controlled synthetic flow, with no grant and the catalog still UNKNOWN", () => {
    it("(13, 24) request → bound in the same transaction → EXECUTING consumes → ONE POST → CONFIRMED; nothing else changed (18/18 DENY, r5, UNKNOWN)", async () => {
      const t = await tenant();
      const id = await issue(t);
      const intentId = await requested(t, id);
      expect(await intentRow(t, intentId)).toMatchObject({ status: "PENDING", validation_authorization_id: id });
      expect(await authorizationRow(t, id)).toEqual({ intent_id: intentId, bound: true, consumed: false, revoked: false });

      const x = execution();
      const result = await x.run(t, intentId);
      expect(result).toMatchObject({ kind: "confirmed" });
      expect(x.posts).toEqual([`/v25.0/${t.ig.commentProviderId}/replies`]);
      expect(x.opened).toHaveLength(1);
      expect(await historyOf(t, intentId)).toEqual(["PENDING", "EXECUTING", "CONFIRMED"]);
      expect(await authorizationRow(t, id)).toEqual({ intent_id: intentId, bound: true, consumed: true, revoked: false });
      // Inert everywhere else: no switch row, no grant, the profile untouched (UNKNOWN_NOT_VALIDATED, current revision).
      expect(await providerActionState()).toEqual({ rows: 0, decisions: 18, allowed: 0 });
      expect(await oracle("select state, reason_codes as reasons from capability.profile_entries where workspace_id = $1 and connected_account_id = $2 and capability = 'reply_public'", [t.workspaceId, t.ig.account]))
        .toEqual([{ state: "UNKNOWN_NOT_VALIDATED", reasons: ["CATALOG_NOT_VALIDATED"] }]);
      expect(await oracle("select catalog_id, catalog_revision from capability.account_profiles where workspace_id = $1 and connected_account_id = $2", [t.workspaceId, t.ig.account]))
        .toEqual([{ catalog_id: PLATFORM_CATALOG.id, catalog_revision: PLATFORM_CATALOG.revision }]);

      // (9) Consumed: a second request naming it is refused; (no re-issue) the target can never be validated again.
      expect(await request(t, t.users.RESPONDER, { authorization: id })).toEqual({ kind: "refused", reason: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
      expect((await issue(t).then(() => "issued", (error: unknown) => postgresError(error)?.code))).toBe("23505");
      // A redelivered run sends nothing.
      expect(await x.run(t, intentId)).toEqual({ kind: "noop", status: "CONFIRMED" });
      expect(x.posts).toHaveLength(1);
    });

    it("(1, 24) an ordinary request (no authorization) is unchanged: PROVIDER_ACTIONS_DISABLED, nothing written, even while an authorization exists", async () => {
      const t = await tenant();
      await issue(t);
      expect(await request(t, t.users.RESPONDER, {})).toEqual({ kind: "refused", reason: "PROVIDER_ACTIONS_DISABLED" });
      expect(await intentsOf(t)).toBe(0);
    });

    it("(3) the worker's validation reads answer for the BOUND workspace only: another workspace's id reads nothing and counts as already validated (fail closed)", async () => {
      const t = await tenant();
      const other = await tenant();
      const foreign = await issue(other);
      const reads = await withWorkspaceJobScope(worker, t.workspaceId, async (tx: DatabaseTransaction) => {
        const validation = executorStores({ tx }, randomUUID).validation;
        if (validation === undefined) throw new Error("the worker composition must provide the validation reads");
        return {
          foreignRead: await validation.authorization(other.workspaceId, foreign),
          foreignConsumed: await validation.consumedElsewhere(other.workspaceId, other.ig.comment, foreign),
          ownConsumed: await validation.consumedElsewhere(t.workspaceId, t.ig.comment, randomUUID()),
          credentialReady: await validation.credentialReady(t.workspaceId, t.ig.account),
        };
      });
      expect(reads).toEqual({ foreignRead: undefined, foreignConsumed: true, ownConsumed: false, credentialReady: true });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("2 · the request refuses every authorization that is not exactly this one, writing nothing", () => {
    it("(2–8, 10, 11) absent, another workspace / account / comment / initiator, expired, revoked, already bound, a nested target", async () => {
      const t = await tenant();
      const other = await tenant();
      const secondAccount = await instagramAccount(t.organizationId, t.workspaceId, t.connection);
      const refused = { kind: "refused", reason: "VALIDATION_AUTHORIZATION_UNAVAILABLE" };

      expect(await request(t, t.users.RESPONDER, { authorization: randomUUID() })).toEqual(refused); // (2)
      expect(await request(t, t.users.RESPONDER, { authorization: await issue(other) })).toEqual(refused); // (3) RLS: invisible here
      const forOtherAccount = await issue(t, { account: secondAccount.account, target: secondAccount.comment });
      expect(await request(t, t.users.RESPONDER, { authorization: forOtherAccount })).toEqual(refused); // (4) another account's comment
      expect(await request(t, t.users.RESPONDER, { authorization: await issue(t, { target: t.ig.otherComment }) })).toEqual(refused); // (5)
      const forColleague = await issue(t, { target: t.ig.comment, initiator: t.users.RESPONDER_2 });
      expect(await request(t, t.users.RESPONDER, { authorization: forColleague })).toEqual(refused); // (6) RLS: only the initiator reads it
      await revoke(t, forColleague);
      const revoked = await issue(t);
      await revoke(t, revoked);
      expect(await request(t, t.users.RESPONDER, { authorization: revoked })).toEqual(refused); // (8)
      const shortLived = await issue(t, { lifetime: "1 second" });
      await untilExpired(t, shortLived);
      expect(await request(t, t.users.RESPONDER, { authorization: shortLived })).toEqual(refused); // (7) database clock
      expect(await intentsOf(t)).toBe(0);

      const live = await issue(t);
      await requested(t, live);
      expect(await request(t, t.users.RESPONDER, { authorization: live })).toEqual(refused); // (10) already bound
      expect(await intentsOf(t)).toBe(1);

      const nested = await issue(t, { target: t.ig.nested, initiator: t.users.RESPONDER_2 });
      expect(await request(t, t.users.RESPONDER_2, { target: t.ig.nested, authorization: nested })).toEqual({ kind: "refused", reason: "TARGET_NOT_REPLYABLE" }); // (11)
      // A role without reply.public never reaches the service (the pipeline refuses first).
      expect(await request(t, t.users.ANALYST_VIEWER, { authorization: live })).toMatchObject({ status: "error", error: { code: "PERMISSION_DENIED" } });
      expect(await intentsOf(t)).toBe(1);
    });

    it("(14) two concurrent requests binding one authorization: exactly one intent, bound; the other writes nothing", async () => {
      const t = await tenant();
      const id = await issue(t);
      const outcomes = await Promise.allSettled([request(t, t.users.RESPONDER, { authorization: id }), request(t, t.users.RESPONDER, { authorization: id })]);
      const created = outcomes.filter((o) => o.status === "fulfilled" && "kind" in o.value && o.value.kind === "requested");
      expect(created).toHaveLength(1);
      expect(await intentsOf(t)).toBe(1);
      expect(await oracle("select count(*)::int as n from mutations.mutation_intents where workspace_id = $1 and validation_authorization_id = $2", [t.workspaceId, id])).toEqual([{ n: 1 }]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("3 · the executor: F (revocation / expiry during admit), kill switches, PRE-LIVE-1/2", () => {
    it("(8, 16) revoked before admit → BLOCKED from PENDING; revoked BETWEEN the check and the EXECUTING commit → the trigger refuses, a new transaction records BLOCKED; never consumed, zero POSTs", async () => {
      const t = await tenant();
      const early = await issue(t);
      const earlyIntent = await requested(t, early);
      await revoke(t, early);
      const x = execution();
      expect(await x.run(t, earlyIntent)).toEqual({ kind: "blocked", code: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });

      const t2 = await tenant();
      const racing = await issue(t2);
      const racingIntent = await requested(t2, racing);
      expect(await x.run(t2, racingIntent, { wrap: afterAuthorizationRead(() => revoke(t2, racing).then(() => undefined)) })).toEqual({ kind: "blocked", code: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
      expect(await intentRow(t2, racingIntent)).toMatchObject({ status: "BLOCKED", attempt: 1, outcome_code: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
      expect(await historyOf(t2, racingIntent)).toEqual(["PENDING", "BLOCKED"]);
      expect(await authorizationRow(t2, racing)).toMatchObject({ consumed: false, revoked: true });
      expect([x.posts, x.opened]).toEqual([[], []]);
      // A later delivery does nothing.
      expect(await x.run(t2, racingIntent)).toEqual({ kind: "noop", status: "BLOCKED" });
    });

    it("(17) expired BETWEEN the check and the EXECUTING commit (database clock) → BLOCKED in a new transaction, never consumed, zero POSTs", async () => {
      const t = await tenant();
      const id = await issue(t, { lifetime: "2 seconds" });
      const intentId = await requested(t, id);
      const x = execution();
      expect(await x.run(t, intentId, { wrap: afterAuthorizationRead(() => untilExpired(t, id)) })).toEqual({ kind: "blocked", code: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
      expect(await authorizationRow(t, id)).toMatchObject({ consumed: false, revoked: false });
      expect(await historyOf(t, intentId)).toEqual(["PENDING", "BLOCKED"]);
      expect([x.posts, x.opened]).toEqual([[], []]);
    });

    it("an infrastructure failure at admit is never recorded as a revocation: the error propagates, the intent stays PENDING, the authorization live", async () => {
      const t = await tenant();
      const id = await issue(t);
      const intentId = await requested(t, id);
      const x = execution();
      const failing = (stores: ExecutorStores): ExecutorStores => ({ ...stores, intents: { ...stores.intents, transition: () => Promise.reject(new Error("connection terminated unexpectedly")) } });
      await expect(x.run(t, intentId, { wrap: failing })).rejects.toThrow();
      expect(await intentRow(t, intentId)).toMatchObject({ status: "PENDING", attempt: 0, outcome_code: null });
      expect(await authorizationRow(t, id)).toEqual({ intent_id: intentId, bound: true, consumed: false, revoked: false });
      expect(x.posts).toEqual([]);
    });

    it("(22) the emergency block or an exact pause vetoes at request and at execution (not consumed); after EXECUTING it stops the call (PRE-LIVE-1)", async () => {
      for (const target of [WILDCARD, INSTAGRAM]) {
        const t = await tenant();
        const id = await issue(t);
        const intentId = await requested(t, id);
        const x = execution();
        await withClient((client) => setSwitch(client, target, { enabled: false }, SWITCH_OPERATOR));
        try {
          const second = await issue(t, { target: t.ig.otherComment });
          expect(await request(t, t.users.RESPONDER, { target: t.ig.otherComment, authorization: second })).toEqual({ kind: "refused", reason: "PROVIDER_ACTIONS_DISABLED" });
          expect(await x.run(t, intentId)).toEqual({ kind: "blocked", code: "PROVIDER_ACTIONS_DISABLED" });
          expect(await authorizationRow(t, id)).toMatchObject({ consumed: false });
        } finally {
          await withClient((client) => clearSwitch(client, target, SWITCH_OPERATOR));
        }
        expect(x.posts).toEqual([]);
      }
      // After EXECUTING committed, before the credential is opened: the final gate reads the pause.
      const t = await tenant();
      const id = await issue(t);
      const intentId = await requested(t, id);
      const x = execution();
      try {
        const result = await x.run(t, intentId, { beforeScope: async (n) => { if (n === 2) await withClient((client) => setSwitch(client, WILDCARD, { enabled: false }, SWITCH_OPERATOR)); } });
        expect(result).toEqual({ kind: "blocked", code: "PROVIDER_ACTIONS_DISABLED" });
      } finally {
        await withClient((client) => clearSwitch(client, WILDCARD, SWITCH_OPERATOR));
      }
      expect(await historyOf(t, intentId)).toEqual(["PENDING", "EXECUTING", "BLOCKED"]);
      expect(await authorizationRow(t, id)).toMatchObject({ consumed: true });
      expect([x.posts, x.opened]).toEqual([[], []]);
      expect(await providerActionState()).toEqual({ rows: 0, decisions: 18, allowed: 0 });
    });

    it("(23, PRE-LIVE-2) the connection degrades after EXECUTING → BLOCKED CREDENTIAL_UNREADABLE: the envelope never opened, zero POSTs; consumed, never re-armed", async () => {
      const t = await tenant();
      const id = await issue(t);
      const intentId = await requested(t, id);
      const x = execution();
      const result = await x.run(t, intentId, { beforeCredential: async () => { await privileged.query("update connections.connections set status = 'DEGRADED' where id = $1", [t.connection]); } });
      expect(result).toEqual({ kind: "blocked", code: "CREDENTIAL_UNREADABLE" });
      expect([x.posts, x.opened]).toEqual([[], []]);
      expect(await authorizationRow(t, id)).toMatchObject({ consumed: true });
      await privileged.query("update connections.connections set status = 'ACTIVE' where id = $1", [t.connection]);
      expect(await x.run(t, intentId)).toEqual({ kind: "noop", status: "BLOCKED" });
      expect(x.posts).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("4 · one consumption, one POST: OUTCOME_UNKNOWN, redelivery, concurrency, X1, X2", () => {
    it("(18) a lost response → OUTCOME_UNKNOWN after ONE POST; never retried, never re-armed, never re-issuable for that comment", async () => {
      const t = await tenant();
      const id = await issue(t);
      const intentId = await requested(t, id);
      const x = execution("lost");
      expect(await x.run(t, intentId)).toEqual({ kind: "outcome_unknown", code: "RESPONSE_LOST" });
      expect(await x.run(t, intentId)).toEqual({ kind: "noop", status: "OUTCOME_UNKNOWN" });
      expect(x.posts).toHaveLength(1);
      expect(await authorizationRow(t, id)).toMatchObject({ consumed: true });
      // Nothing returns it to PENDING or EXECUTING (0028 consume trigger, the worker's own grant).
      for (const status of ["PENDING", "EXECUTING"]) {
        const refused = await withWorkspaceJobScope(worker, t.workspaceId, (tx: DatabaseTransaction) =>
          createPostgresIntentStore(tx).transition(t.workspaceId, intentId, { from: "OUTCOME_UNKNOWN", status: status as "PENDING", attempt: 2, runReference: "run_forged", outcomeCode: null, at: new Date() })).then(() => "OK", (error: unknown) => postgresError(error)?.code ?? "refused");
        expect(refused, status).not.toBe("OK");
      }
      expect((await issue(t).then(() => "issued", (error: unknown) => postgresError(error)?.code))).toBe("23505");
    });

    it("(19) the run dies after the POST (EXECUTING left without an outcome): a redelivery records OUTCOME_UNKNOWN and sends NOTHING", async () => {
      const t = await tenant();
      const id = await issue(t);
      const intentId = await requested(t, id);
      const x = execution();
      // Step 7B-14H1: the finish transaction of an authorized intent is scope 4 (a second gate runs after opening).
      await expect(x.run(t, intentId, { beforeScope: (n) => (n === 4 ? Promise.reject(new Error("worker crashed")) : Promise.resolve()) })).rejects.toThrow("worker crashed");
      expect(x.posts).toHaveLength(1);
      expect(await intentRow(t, intentId)).toMatchObject({ status: "EXECUTING" });
      expect(await x.run(t, intentId, { runId: "run_redelivered_0001" })).toEqual({ kind: "outcome_unknown", code: "RUN_INTERRUPTED" });
      expect(x.posts).toHaveLength(1);
    });

    it("(15) two runs at once on one authorized intent: one EXECUTING, consumed once, at most ONE POST", async () => {
      const t = await tenant();
      const id = await issue(t);
      const intentId = await requested(t, id);
      const x = execution();
      const results = await Promise.allSettled([x.run(t, intentId, { runId: "run_concurrent_a" }), x.run(t, intentId, { runId: "run_concurrent_b" })]);
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      expect(x.posts.length).toBeLessThanOrEqual(1);
      expect((await historyOf(t, intentId)).filter((s) => s === "EXECUTING")).toHaveLength(1);
      expect(await oracle("select count(*)::int as n from mutations.validation_authorizations where workspace_id = $1 and consumed_at is not null", [t.workspaceId])).toEqual([{ n: 1 }]);
      expect(["CONFIRMED", "OUTCOME_UNKNOWN"]).toContain((await intentRow(t, intentId))?.status);
    });

    it("(20, X1) a worker same-status rewrite of run reference / attempt (admitted by 0028 today) is detected before the call: nothing sent; the store refuses such a rewrite itself", async () => {
      const t = await tenant();
      const id = await issue(t);
      const intentId = await requested(t, id);
      const x = execution();
      const rewrite = () => withWorkspaceJobScope(worker, t.workspaceId, (tx: DatabaseTransaction) =>
        tx.execute(sql`update mutations.mutation_intents set run_reference = 'run_forged_x1', attempt = 2 where workspace_id = ${t.workspaceId} and id = ${intentId} and status = 'EXECUTING'`));
      const result = await x.run(t, intentId, { beforeScope: async (n) => { if (n === 2) await rewrite(); } });
      expect(result).toEqual({ kind: "noop", status: "EXECUTING" });
      expect(await intentRow(t, intentId)).toMatchObject({ status: "EXECUTING", attempt: 2, run_reference: "run_forged_x1" });
      expect([x.posts, x.opened]).toEqual([[], []]);
      // The PostgreSQL store refuses a same-status transition outright, and from a status the row is not in.
      for (const next of [{ from: "EXECUTING", status: "EXECUTING" }, { from: "PENDING", status: "EXECUTING" }] as const) {
        await expect(withWorkspaceJobScope(worker, t.workspaceId, (tx: DatabaseTransaction) =>
          createPostgresIntentStore(tx).transition(t.workspaceId, intentId, { ...next, attempt: 3, runReference: "run_forged_store", outcomeCode: null, at: new Date() }))).rejects.toThrow(/incoherent transition/);
      }
      // Whatever the row says, a new run never sends: EXECUTING → OUTCOME_UNKNOWN (RUN_INTERRUPTED), zero POSTs.
      expect(await x.run(t, intentId)).toEqual({ kind: "outcome_unknown", code: "RUN_INTERRUPTED" });
      expect(x.posts).toEqual([]);
    });

    it("(21, X2) deterministic: a consumption committed AFTER a second authorization was issued at the expiry boundary → the second intent's EXECUTING is refused by the unique index mid-flight → BLOCKED, never left PENDING, zero POSTs", async () => {
      const t = await tenant();
      const first = await issue(t, { lifetime: "3 seconds" });
      const firstIntent = await requested(t, first);
      // T1: the first intent consumes its authorization, uncommitted (as an executor whose commit is still in flight).
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let consumedInT1: () => void = () => undefined;
      const consumedSignal = new Promise<void>((resolve) => { consumedInT1 = resolve; });
      const t1 = withWorkspaceJobScope(worker, t.workspaceId, async (tx: DatabaseTransaction) => {
        await tx.execute(sql`update mutations.mutation_intents set status = 'EXECUTING', attempt = 1, run_reference = 'run_x2_first', updated_at = now() where workspace_id = ${t.workspaceId} and id = ${firstIntent} and status = 'PENDING'`);
        consumedInT1();
        await held;
      });
      await consumedSignal;
      // The first authorization expires; its consumption is still invisible: the issuance guard admits a second one.
      await untilExpired(t, first);
      const second = await issue(t);
      const secondIntent = await requested(t, second);
      // The executor on the second intent passes its checks, then waits on the unique index behind T1.
      const x = execution();
      const running = x.run(t, secondIntent);
      // pg_locks is readable by every role (pg_stat_activity hides other roles' sessions): an ungranted transactionid
      // lock is the unique-index wait on T1's uncommitted consumption.
      for (let i = 0; ; i += 1) {
        const waiting = await oracle<{ n: number }>("select count(*)::int as n from pg_locks where locktype = 'transactionid' and not granted");
        if ((waiting[0]?.n ?? 0) > 0) break;
        if (i === 200) throw new Error("the second consumption never waited on the first");
        await sleep(20);
      }
      release();
      await t1;
      expect(await running).toEqual({ kind: "blocked", code: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
      expect(await intentRow(t, secondIntent)).toMatchObject({ status: "BLOCKED", outcome_code: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
      expect(await authorizationRow(t, second)).toMatchObject({ consumed: false });
      expect(await oracle("select count(*)::int as n from mutations.validation_authorizations where workspace_id = $1 and target_interaction_id = $2 and consumed_at is not null", [t.workspaceId, t.ig.comment])).toEqual([{ n: 1 }]);
      expect([x.posts, x.opened]).toEqual([[], []]);
      expect(await x.run(t, secondIntent)).toEqual({ kind: "noop", status: "BLOCKED" });
    });
  });
  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("5 · Step 7B-14H1: the final gate AFTER the key service opened the credential, BEFORE the POST", () => {
    const replaceCredential = async (t: Tenant): Promise<string> => {
      const credential = randomUUID();
      const version = (await oracle<{ v: number }>("select coalesce(max(credential_version), 0)::int + 1 as v from credentials.provider_credentials where workspace_id = $1 and connection_id = $2", [t.workspaceId, t.connection]))[0]?.v ?? 2;
      await privileged.query(
        `insert into credentials.provider_credentials (id, organization_id, workspace_id, connection_id, credential_version, envelope, created_at)
         values ($1, $2, $3, $4, $5, $6, now())`,
        [credential, t.organizationId, t.workspaceId, t.connection, version, Buffer.concat([Buffer.from("5349504501", "hex"), randomBytes(64)])],
      );
      await privileged.query("update connections.connections set active_credential_id = $1 where id = $2", [credential, t.connection]);
      return credential;
    };
    const consumed = async (t: Tenant, id: string) => (await authorizationRow(t, id))?.consumed;

    interface Change { readonly name: string; readonly code: string; readonly change: (t: Tenant) => Promise<void>; readonly undo?: () => Promise<void> }
    const changes: readonly Change[] = [
      { name: "(1) the workspace turns Monitor-only", code: "MODE_NOT_STANDARD", change: async (t) => { await privileged.query("update tenancy.workspaces set mode = 'MONITOR_ONLY' where id = $1", [t.workspaceId]); } },
      { name: "(2) an exact provider-action pause", code: "PROVIDER_ACTIONS_DISABLED", change: async () => { await withClient((client) => setSwitch(client, INSTAGRAM, { enabled: false }, SWITCH_OPERATOR)); }, undo: async () => { await withClient((client) => clearSwitch(client, INSTAGRAM, SWITCH_OPERATOR)); } },
      { name: "(3) the global wildcard emergency block", code: "PROVIDER_ACTIONS_DISABLED", change: async () => { await withClient((client) => setSwitch(client, WILDCARD, { enabled: false }, SWITCH_OPERATOR)); }, undo: async () => { await withClient((client) => clearSwitch(client, WILDCARD, SWITCH_OPERATOR)); } },
      { name: "(4) the initiator loses the replying role", code: "PERMISSION_DENIED", change: async (t) => { await privileged.query("update tenancy.workspace_memberships set role = 'ANALYST_VIEWER' where workspace_id = $1 and user_id = $2", [t.workspaceId, t.users.RESPONDER]); } },
      { name: "(5) the account is deactivated", code: "ACCOUNT_INACTIVE", change: async (t) => { await privileged.query("update connections.connected_accounts set status = 'INACTIVE', deactivated_at = now(), deactivation_reason = 'DISCONNECTED' where id = $1", [t.ig.account]); } },
      { name: "(5) the connection degrades", code: "CONNECTION_UNAVAILABLE", change: async (t) => { await privileged.query("update connections.connections set status = 'DEGRADED' where id = $1", [t.connection]); } },
      { name: "(6) the credential is replaced (rotation)", code: "CREDENTIAL_UNREADABLE", change: async (t) => { await replaceCredential(t); } },
      { name: "(6) the credential is invalidated (its connection FAILED: re-authorization required)", code: "CONNECTION_UNAVAILABLE", change: async (t) => { await privileged.query("update connections.connections set status = 'FAILED' where id = $1", [t.connection]); } },
    ];
    it.each(changes)("$name between the key service and the POST → BLOCKED $code: the credential opened ONCE, ZERO POSTs; consumed, never re-armed", async ({ code, change, undo }) => {
      const t = await tenant();
      const id = await issue(t);
      const intentId = await requested(t, id);
      const x = execution();
      try {
        expect(await x.run(t, intentId, { afterOpen: () => change(t) })).toEqual({ kind: "blocked", code });
      } finally {
        await undo?.();
      }
      expect(x.posts).toEqual([]);
      expect(x.opened).toHaveLength(1);
      expect(await intentRow(t, intentId)).toMatchObject({ status: "BLOCKED", attempt: 1, outcome_code: code });
      expect(await historyOf(t, intentId)).toEqual(["PENDING", "EXECUTING", "BLOCKED"]);
      expect(await consumed(t, id)).toBe(true);
      expect(await x.run(t, intentId)).toEqual({ kind: "noop", status: "BLOCKED" });
      expect(x.posts).toEqual([]);
      expect(await providerActionState()).toEqual({ rows: 0, decisions: 18, allowed: 0 });
    });

    it("(7, X1) attempt / run reference rewritten after the credential was opened → nothing sent, nothing recorded", async () => {
      const t = await tenant();
      const id = await issue(t);
      const intentId = await requested(t, id);
      const x = execution();
      const rewrite = async (): Promise<void> => {
        await withWorkspaceJobScope(worker, t.workspaceId, (tx: DatabaseTransaction) =>
          tx.execute(sql`update mutations.mutation_intents set run_reference = 'run_forged_h1', attempt = 2 where workspace_id = ${t.workspaceId} and id = ${intentId} and status = 'EXECUTING'`));
      };
      expect(await x.run(t, intentId, { afterOpen: rewrite })).toEqual({ kind: "noop", status: "EXECUTING" });
      expect([x.posts, x.opened.length]).toEqual([[], 1]);
      expect(await historyOf(t, intentId)).toEqual(["PENDING", "EXECUTING"]);
      expect(await x.run(t, intentId)).toEqual({ kind: "outcome_unknown", code: "RUN_INTERRUPTED" });
      expect(x.posts).toEqual([]);
    });

    it("(8) a database failure DURING the final check fails closed: no POST, no refusal, no outcome recorded; a redelivery records OUTCOME_UNKNOWN and sends nothing", async () => {
      const t = await tenant();
      const id = await issue(t);
      const intentId = await requested(t, id);
      const x = execution();
      const failing = (stores: ExecutorStores, n: number): ExecutorStores =>
        n !== 3 ? stores : { ...stores, guards: { ...stores.guards, workspaceMode: () => Promise.reject(new Error("connection terminated unexpectedly")) } };
      await expect(x.run(t, intentId, { wrap: failing })).rejects.toThrow("connection terminated unexpectedly");
      expect([x.posts, x.opened.length]).toEqual([[], 1]);
      expect(await intentRow(t, intentId)).toMatchObject({ status: "EXECUTING", attempt: 1, outcome_code: null });
      expect(await historyOf(t, intentId)).toEqual(["PENDING", "EXECUTING"]);
      expect(await consumed(t, id)).toBe(true);
      // The same failure when the transaction itself cannot even start.
      const t2 = await tenant();
      const id2 = await issue(t2);
      const intent2 = await requested(t2, id2);
      const y = execution();
      await expect(y.run(t2, intent2, { beforeScope: (n) => (n === 3 ? Promise.reject(new Error("pool exhausted")) : Promise.resolve()) })).rejects.toThrow("pool exhausted");
      expect([y.posts, y.opened.length]).toEqual([[], 1]);
      expect(await historyOf(t2, intent2)).toEqual(["PENDING", "EXECUTING"]);
      // Never a second attempt: redelivered, the row becomes OUTCOME_UNKNOWN (reconciliation looks, never resends).
      expect(await x.run(t, intentId, { runId: "run_redelivered_h1" })).toEqual({ kind: "outcome_unknown", code: "RUN_INTERRUPTED" });
      expect(x.posts).toEqual([]);
    });

    it("(9) the key service fails before handing the credential over → BLOCKED CREDENTIAL_UNREADABLE, zero POSTs; consumed, never re-armed", async () => {
      const t = await tenant();
      const id = await issue(t);
      const intentId = await requested(t, id);
      const x = execution();
      expect(await x.run(t, intentId, { keyServiceFails: true })).toEqual({ kind: "blocked", code: "CREDENTIAL_UNREADABLE" });
      expect([x.posts, x.opened]).toEqual([[], []]);
      expect(await historyOf(t, intentId)).toEqual(["PENDING", "EXECUTING", "BLOCKED"]);
      expect(await consumed(t, id)).toBe(true);
      expect(await x.run(t, intentId)).toEqual({ kind: "noop", status: "BLOCKED" });
      expect(x.posts).toEqual([]);
    });

    it("(10) the credential opened and every control intact → the second gate reads the opened credential BEFORE the ONE synthetic POST → CONFIRMED", async () => {
      const t = await tenant();
      const id = await issue(t);
      const intentId = await requested(t, id);
      const x = execution();
      const postsAtGate: number[] = [];
      const spy = (stores: ExecutorStores, n: number): ExecutorStores => {
        const validation = stores.validation;
        if (n !== 3 || validation === undefined) return stores;
        return { ...stores, validation: { ...validation, activeCredential: (w, a) => { postsAtGate.push(x.posts.length); return validation.activeCredential(w, a); } } };
      };
      const result = await x.run(t, intentId, { wrap: spy });
      expect(result).toMatchObject({ kind: "confirmed" });
      expect(postsAtGate).toEqual([0]);
      expect(x.posts).toEqual([`/v25.0/${t.ig.commentProviderId}/replies`]);
      expect(x.opened).toHaveLength(1);
      expect(await historyOf(t, intentId)).toEqual(["PENDING", "EXECUTING", "CONFIRMED"]);
    });

    it("(11, 12) the SAME run redelivered after its POST (no outcome recorded) sends nothing; an OUTCOME_UNKNOWN is never retried", async () => {
      const t = await tenant();
      const id = await issue(t);
      const intentId = await requested(t, id);
      const x = execution();
      const runId = "run_h1_same_0001";
      await expect(x.run(t, intentId, { runId, beforeScope: (n) => (n === 4 ? Promise.reject(new Error("worker crashed after the POST")) : Promise.resolve()) })).rejects.toThrow("worker crashed after the POST");
      expect(x.posts).toHaveLength(1);
      expect(await x.run(t, intentId, { runId })).toEqual({ kind: "outcome_unknown", code: "RUN_INTERRUPTED" });
      for (const again of [runId, "run_h1_other_0001"]) expect(await x.run(t, intentId, { runId: again })).toEqual({ kind: "noop", status: "OUTCOME_UNKNOWN" });
      expect(x.posts).toHaveLength(1);
      expect(await consumed(t, id)).toBe(true);
    });

    it("concurrency: a Monitor-only change racing the second gate is either seen or waits for it (SHARE lock): here it commits while the gate waits → BLOCKED, zero POSTs", async () => {
      const t = await tenant();
      const id = await issue(t);
      const intentId = await requested(t, id);
      const x = execution();
      const client = await privileged.connect();
      let committer: Promise<boolean> = Promise.resolve(false);
      try {
        const hold = async (): Promise<void> => {
          await client.query("begin");
          await client.query("update tenancy.workspaces set mode = 'MONITOR_ONLY' where id = $1", [t.workspaceId]);
          // Commit only once the gate's SHARE lock is seen waiting behind this uncommitted update.
          committer = (async () => {
            let waited = false;
            for (let i = 0; i < 200 && !waited; i += 1) {
              const waiting = await oracle<{ n: number }>("select count(*)::int as n from pg_locks where locktype = 'transactionid' and not granted");
              waited = (waiting[0]?.n ?? 0) > 0;
              if (!waited) await sleep(20);
            }
            await client.query("commit");
            return waited;
          })();
        };
        expect(await x.run(t, intentId, { afterOpen: hold })).toEqual({ kind: "blocked", code: "MODE_NOT_STANDARD" });
        // The gate really waited behind the uncommitted change (it was not merely run after it).
        expect(await committer).toBe(true);
      } finally {
        await client.query("rollback").catch(() => undefined);
        client.release();
      }
      expect([x.posts, x.opened.length]).toEqual([[], 1]);
      expect(await historyOf(t, intentId)).toEqual(["PENDING", "EXECUTING", "BLOCKED"]);
    });

    it("residual window (documented, not closable without a transaction across the HTTP call): a pause committed AFTER the second gate, while the request is leaving, does not recall it", async () => {
      const t = await tenant();
      const id = await issue(t);
      const intentId = await requested(t, id);
      const x = execution("created", { onPost: async () => { await withClient((client) => setSwitch(client, WILDCARD, { enabled: false }, SWITCH_OPERATOR)); } });
      try {
        expect(await x.run(t, intentId)).toMatchObject({ kind: "confirmed" });
      } finally {
        await withClient((client) => clearSwitch(client, WILDCARD, SWITCH_OPERATOR));
      }
      expect(x.posts).toHaveLength(1);
      expect(await historyOf(t, intentId)).toEqual(["PENDING", "EXECUTING", "CONFIRMED"]);
    });
  });

  /**
   * Step 7B-14I2 — the operator path end to end on the real database: evidence recorded by the bound worker, issuance by a
   * validation operator login (never declared), the Inbox request resolved ON THE SERVER (no identifier from the caller),
   * the executor's ONE POST on a fake Meta, and reconciliation through the Instagram own-reply lookup (GETs on a fake
   * transport). Never a second POST.
   */
  describe("7B-14I2 · operator path: evidence → operator issuance → server-resolved request → one POST → reconciliation", () => {
    const OPERATOR_LOGIN = "validation_operator_integration";
    const issueAsOperator = async (t: Tenant, initiator = t.users.RESPONDER): Promise<string> => {
      const credential = (await oracle<{ id: string }>("select active_credential_id as id from connections.connections where id = $1", [t.connection]))[0]?.id ?? "";
      const preflightId = randomUUID();
      await withWorkspaceJobScope(worker, t.workspaceId, (tx: DatabaseTransaction) => recordValidationPreflight(tx, {
        id: preflightId, connectedAccountId: t.ig.account, targetInteractionId: t.ig.comment, credentialId: credential, runReference: `run_7b14i2_${randomUUID().slice(0, 8)}`,
        status: "VERIFIED", checksVerified: 10, requiredPermissionsGranted: true, repliesComplete: true, repliesByManagedAccount: 0, repliesUnattributed: 0, stoppedEarly: false,
      }));
      const client = await (await operatorLogin(privileged, getTarget(), OPERATOR_LOGIN))();
      try {
        await client.query("begin transaction isolation level read committed");
        await client.query("set local role app_validation_operator");
        const row = (await client.query<{ authorization_id: string }>("select authorization_id from mutations.issue_validation_authorization($1, $2, $3, 'live_validation', 60, true)", [t.workspaceId, preflightId, initiator])).rows[0];
        await client.query("commit");
        return row?.authorization_id ?? "";
      } finally {
        await client.end();
      }
    };
    const synthetic = (replies: readonly { readonly id: string; readonly fromId: string; readonly fromUsername?: string; readonly text: string; readonly parentId: string }[] | "fail"): InstagramReplyLookupTransport => ({
      getInstagramAccount: () => Promise.resolve({ kind: "ok", value: { username: "synthetic_managed" } }),
      listInstagramCommentRepliesForReconciliation: () => Promise.resolve(replies === "fail"
        ? { kind: "transient", reason: "network" }
        : { kind: "ok", value: { replies: replies.map((reply) => ({ ...reply, fromUsername: reply.fromUsername ?? null, timestamp: new Date().toISOString() })) as never, after: null } }),
    });
    const reconcileWith = (t: Tenant, intentId: string, transport: InstagramReplyLookupTransport) =>
      reconcileIntent(
        {
          inScope: (work) => withWorkspaceJobScope(worker, t.workspaceId, (tx: DatabaseTransaction) => work(executorStores({ tx }, randomUUID))),
          credentials: { withAccess: (_input, use) => use({ credential: providerCredential("cred-synthetic", "synthetic-user-token"), account: providerObjectRef("instagram", "asset", t.ig.asset) }, { credentialId: "synthetic" }) },
          lookup: instagramReplyLookupPort(createInstagramReplyLookup({ transport })),
          clock: { newId: randomUUID, now: () => new Date() },
        },
        { workspaceId: t.workspaceId, intentId, runReference: `run_reconcile_${randomUUID().slice(0, 8)}` },
      );

    it("the request names no identifier: the server binds the member's own live authorization; ONE POST → CONFIRMED; nothing else is admitted", async () => {
      const t = await tenant();
      const id = await issueAsOperator(t);
      const key = `form-${randomUUID()}`;
      const outcome = await request(t, t.users.RESPONDER, { validation: true, key });
      expect(outcome).toMatchObject({ kind: "requested" });
      const intentId = (outcome as { readonly intentId: string }).intentId;
      expect(await authorizationRow(t, id)).toMatchObject({ intent_id: intentId, bound: true, consumed: false });
      expect((await intentRow(t, intentId))?.validation_authorization_id).toBe(id);
      // The same form again: the same answer (idempotent), never a second intent.
      expect(await request(t, t.users.RESPONDER, { validation: true, key })).toMatchObject({ kind: "existing", intentId });
      // Bound: a new validation request for the same comment, by the same member, is refused.
      expect(await request(t, t.users.RESPONDER, { validation: true })).toEqual({ kind: "refused", reason: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
      const x = execution();
      expect(await x.run(t, intentId)).toMatchObject({ kind: "confirmed" });
      expect(x.posts).toHaveLength(1);
      expect(await historyOf(t, intentId)).toEqual(["PENDING", "EXECUTING", "CONFIRMED"]);
      expect(await authorizationRow(t, id)).toMatchObject({ consumed: true });
      // Consumed: nothing can request again on that comment, and a re-run sends nothing.
      expect(await request(t, t.users.RESPONDER, { validation: true })).toEqual({ kind: "refused", reason: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
      expect(await x.run(t, intentId)).toEqual({ kind: "noop", status: "CONFIRMED" });
      expect(x.posts).toHaveLength(1);
    });

    it("only the named initiator, only the exact comment; no flag means the ordinary path (still refused); flag + identifier is refused", async () => {
      const t = await tenant();
      const id = await issueAsOperator(t);
      expect(await request(t, t.users.RESPONDER_2, { validation: true })).toEqual({ kind: "refused", reason: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
      expect(await request(t, t.users.RESPONDER, { validation: true, target: t.ig.otherComment })).toEqual({ kind: "refused", reason: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
      expect(await request(t, t.users.RESPONDER, {})).toEqual({ kind: "refused", reason: "PROVIDER_ACTIONS_DISABLED" });
      expect(await request(t, t.users.RESPONDER, { validation: true, authorization: id })).toEqual({ kind: "refused", reason: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
      const other = await tenant();
      expect(await request(other, other.users.RESPONDER, { validation: true })).toEqual({ kind: "refused", reason: "VALIDATION_AUTHORIZATION_UNAVAILABLE" });
      expect(await authorizationRow(t, id)).toMatchObject({ bound: false });
      expect(await intentsOf(t)).toBe(0);
    });

    it("a pause (exact or wildcard) and Monitor-only still win over an operator-issued authorization", async () => {
      const t = await tenant();
      const id = await issueAsOperator(t);
      for (const key of [WILDCARD, INSTAGRAM]) {
        await withClient((client) => setSwitch(client, key, { enabled: false }, SWITCH_OPERATOR));
        try {
          expect(await request(t, t.users.RESPONDER, { validation: true }), key.qualifier).toEqual({ kind: "refused", reason: "PROVIDER_ACTIONS_DISABLED" });
        } finally {
          await withClient((client) => clearSwitch(client, key, SWITCH_OPERATOR));
        }
      }
      await privileged.query("update tenancy.workspaces set mode = 'MONITOR_ONLY' where id = $1", [t.workspaceId]);
      expect(await request(t, t.users.RESPONDER, { validation: true })).toMatchObject({ status: "error" });
      expect(await authorizationRow(t, id)).toMatchObject({ bound: false });
      expect(await intentsOf(t)).toBe(0);
    });

    it("a lost response → OUTCOME_UNKNOWN; reconciliation: an incomplete or ambiguous listing keeps it unknown, ONE unique match confirms, a repeat is a no-op; ONE POST in total", async () => {
      const t = await tenant();
      await issueAsOperator(t);
      const intentId = ((await request(t, t.users.RESPONDER, { validation: true })) as { readonly intentId: string }).intentId;
      const x = execution("lost");
      expect(await x.run(t, intentId)).toEqual({ kind: "outcome_unknown", code: "RESPONSE_LOST" });
      expect(x.posts).toHaveLength(1);
      const ours = { id: "17990000000000001", fromId: t.ig.asset, text: TEXT, parentId: t.ig.commentProviderId };
      expect(await reconcileWith(t, intentId, synthetic("fail"))).toEqual({ kind: "still_unknown", reason: "incomplete" });
      expect(await reconcileWith(t, intentId, synthetic([ours, { ...ours, id: "17990000000000002" }]))).toEqual({ kind: "still_unknown", reason: "ambiguous" });
      // Our text under another id: unattributable without usernames (ambiguous); provably someone else's → nothing found.
      expect(await reconcileWith(t, intentId, synthetic([{ ...ours, fromId: "17841400000000999" }]))).toEqual({ kind: "still_unknown", reason: "ambiguous" });
      expect(await reconcileWith(t, intentId, synthetic([{ ...ours, fromId: "17841400000000999", fromUsername: "someone_else" }]))).toEqual({ kind: "still_unknown", reason: "not_found" });
      expect((await intentRow(t, intentId))?.status).toBe("OUTCOME_UNKNOWN");
      expect(await reconcileWith(t, intentId, synthetic([ours]))).toEqual({ kind: "confirmed", providerReplyId: ours.id });
      expect(await reconcileWith(t, intentId, synthetic([ours]))).toEqual({ kind: "noop", status: "CONFIRMED" });
      expect(await historyOf(t, intentId)).toEqual(["PENDING", "EXECUTING", "OUTCOME_UNKNOWN", "CONFIRMED"]);
      expect(await x.run(t, intentId)).toEqual({ kind: "noop", status: "CONFIRMED" });
      expect(x.posts).toHaveLength(1);
    });

    it("EXECUTING left by a crashed run: reconciliation records OUTCOME_UNKNOWN (RUN_INTERRUPTED) first and sends nothing; a redelivered run sends nothing", async () => {
      const t = await tenant();
      const id = await issueAsOperator(t);
      const intentId = ((await request(t, t.users.RESPONDER, { validation: true })) as { readonly intentId: string }).intentId;
      await withWorkspaceJobScope(worker, t.workspaceId, (tx: DatabaseTransaction) => tx.execute(sql`update mutations.mutation_intents set status = 'EXECUTING', attempt = 1, run_reference = 'run_crashed_7b14i2', updated_at = now() where workspace_id = ${t.workspaceId} and id = ${intentId} and status = 'PENDING'`));
      expect(await authorizationRow(t, id)).toMatchObject({ consumed: true });
      expect(await reconcileWith(t, intentId, synthetic([]))).toEqual({ kind: "still_unknown", reason: "not_found" });
      expect(await intentRow(t, intentId)).toMatchObject({ status: "OUTCOME_UNKNOWN", outcome_code: "RUN_INTERRUPTED" });
      const x = execution();
      expect(await x.run(t, intentId)).toEqual({ kind: "noop", status: "OUTCOME_UNKNOWN" });
      expect(x.posts).toEqual([]);
    });
  });
}
