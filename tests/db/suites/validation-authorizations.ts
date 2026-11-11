/**
 * Step 7B-14F1 — one-time LIVE validation authorizations on the real database (migration 0028). Synthetic tenants only;
 * no provider, no network, no executor run: the tests drive the persistent invariants directly through the runtime
 * roles (web `authenticated`, sealed workspace; the bound worker) and the privileged operator tooling credential.
 *
 *   scope        an authorization names exactly one workspace + Instagram account + target + initiator + reply_public;
 *                any substitution (workspace, account, target, platform, operation, initiator) fails like a
 *                non-existent authorization (23503) or is refused at issuance (CHECK / guard)
 *   lifecycle    ISSUED → BOUND (an intent inserted naming it) → CONSUMED (that intent committed EXECUTING), write-once;
 *                revocation (operator, declared, before consumption) and expiry stop binding and consumption
 *   single use   one intent per authorization, one authorization per intent, under concurrency; never re-armed after a
 *                failure, a timeout or an uncertain outcome; no runtime role writes it; nobody alters the binding
 *   inert        ordinary intents (NULL) are untouched and never consume an authorization; no switch, grant or
 *                capability row is created by any of it
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validationAuthorizationState } from "@/mutations/domain/validation-authorization";
import { readValidationAuthorization } from "@/mutations/persistence/validation-authorizations";
import { postgresError, withUserScope, withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";
import { sqlState } from "./helpers";

const ROLES = ["OWNER", "RESPONDER", "RESPONDER_2", "ANALYST_VIEWER", "CLIENT_GUEST"] as const;
type Role = (typeof ROLES)[number];
const OPERATOR = { operator: "ops.validation-suite", reason: "test" } as const;
const PREFLIGHT = "run_7b14f1synthetic0000000001";

interface Account {
  readonly account: string;
  readonly asset: string;
  readonly content: string;
  readonly comment: string;
  readonly otherComment: string;
}
interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly users: Readonly<Record<Role, string>>;
  readonly meta: string;
  readonly ig: Account;
}
interface Issue {
  readonly account?: string;
  readonly target?: string;
  readonly initiator?: string;
  readonly workspaceId?: string;
  readonly organizationId?: string;
  readonly platform?: string;
  readonly provider?: string;
  readonly kind?: string;
  readonly lifetime?: string;
  readonly preflightAgo?: string;
  readonly operator?: { readonly operator: string; readonly reason: string } | null;
}

export function defineValidationAuthorizationsSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  const organizations: string[] = [];
  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;

  /** One privileged transaction with the operator declaration (as the switch tooling); `null` declares nothing. */
  const asOperator = async <T>(declaration: { readonly operator: string; readonly reason: string } | null, work: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await privileged.connect();
    try {
      await client.query("begin");
      if (declaration !== null) {
        await client.query("select set_config('app.operator_id', $1, true), set_config('app.change_reason', $2, true)", [declaration.operator, declaration.reason]);
      }
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

  const connection = async (organizationId: string, workspaceId: string, owner: string, provider: "meta" | "simulator"): Promise<string> => {
    const id = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, $4, 'ACTIVE', null, $5, now(), 1, now(), now())`,
      [id, organizationId, workspaceId, provider, owner],
    );
    return id;
  };

  /** An ACTIVE account on `connectionId`, one content item and two canonical top-level audience comments. */
  const account = async (organizationId: string, workspaceId: string, connectionId: string, platform: "instagram" | "facebook"): Promise<Account> => {
    const asset = `${platform === "instagram" ? "ig" : "fb"}_7b14f1_${randomUUID().slice(0, 8)}`;
    const discovered = randomUUID();
    await privileged.query(
      `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, 'content_bearing', 'Synthetic', now(), now(), now())`,
      [discovered, organizationId, workspaceId, connectionId, platform, asset],
    );
    const id = randomUUID();
    await privileged.query(
      `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
       select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`,
      [id, discovered],
    );
    const content = randomUUID();
    const providerContent = `${asset}_post`;
    await privileged.query(
      `insert into content.content_items (id, organization_id, workspace_id, platform, connected_account_id, provider_asset_id, provider_content_id, content_kind, reported_source, source_state, first_observed_at, latest_observed_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'post', 'organic', 'available', now(), now(), now(), now())`,
      [content, organizationId, workspaceId, platform, id, asset, providerContent],
    );
    const author = randomUUID();
    await privileged.query(
      `insert into interactions.authors (id, organization_id, workspace_id, platform, provider_author_id, role, label, created_at, updated_at) values ($1, $2, $3, $4, $5, 'user', null, now(), now())`,
      [author, organizationId, workspaceId, platform, `${asset}_audience`],
    );
    const comment = async (): Promise<string> => {
      const interaction = randomUUID();
      await privileged.query(
        `insert into interactions.interactions (id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id, provider_content_id, observed, kind, author_id, author_role,
           current_visibility, current_availability, provider_created_at, state_observed_at, first_observed_at, latest_observed_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, 'comment', $10, 'user', 'visible', 'available', now() - interval '1 hour', now(), now(), now(), now(), now())`,
        [interaction, organizationId, workspaceId, platform, `${asset}_c_${randomUUID().slice(0, 8)}`, id, asset, content, providerContent, author],
      );
      return interaction;
    };
    return { account: id, asset, content, comment: await comment(), otherComment: await comment() };
  };

  const tenant = async (): Promise<Tenant> => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    organizations.push(organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Validation', now())", [organizationId]);
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'STANDARD', now())", [workspaceId, organizationId]);
    const users = {} as Record<Role, string>;
    for (const role of ROLES) {
      const user = randomUUID();
      users[role] = user;
      await privileged.query("insert into tenancy.organization_memberships values ($1, $2, $3, now())", [organizationId, user, role === "OWNER" ? "OWNER" : "MEMBER"]);
      await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, $4, '{}', now())", [organizationId, workspaceId, user, role === "RESPONDER_2" ? "RESPONDER" : role]);
    }
    const meta = await connection(organizationId, workspaceId, users.OWNER, "meta");
    return { organizationId, workspaceId, users, meta, ig: await account(organizationId, workspaceId, meta, "instagram") };
  };

  /** Issues through the operator declaration; returns the authorization id. */
  const issue = (t: Tenant, options: Issue = {}): Promise<string> => {
    const id = randomUUID();
    return asOperator(options.operator === undefined ? OPERATOR : options.operator, async (client) => {
      await client.query(
        `insert into mutations.validation_authorizations (id, organization_id, workspace_id, connected_account_id, target_interaction_id, initiator_user_id, provider, platform, kind,
           preflight_run_reference, preflight_completed_at, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() - $11::interval, now() + $12::interval)`,
        [id, options.organizationId ?? t.organizationId, options.workspaceId ?? t.workspaceId, options.account ?? t.ig.account, options.target ?? t.ig.comment,
          options.initiator ?? t.users.RESPONDER, options.provider ?? "meta", options.platform ?? "instagram", options.kind ?? "reply_public", PREFLIGHT,
          options.preflightAgo ?? "5 minutes", options.lifetime ?? "60 minutes"],
      );
      return id;
    });
  };
  const revoke = (t: Tenant, id: string, declaration: { readonly operator: string; readonly reason: string } | null = { operator: "ops.validation-suite", reason: "superseded" }) =>
    asOperator(declaration, (client) => client.query("update mutations.validation_authorizations set revoked_at = now() where workspace_id = $1 and id = $2", [t.workspaceId, id]));

  const asUser = <T>(user: string, workspaceId: string | undefined, work: (tx: DatabaseTransaction) => Promise<T>) => withUserScope(web, { sub: user, role: "authenticated" }, workspaceId, work);
  const asWorker = <T>(workspaceId: string, work: (tx: DatabaseTransaction) => Promise<T>) => withWorkspaceJobScope(worker, workspaceId, work);

  /** A member's PENDING intent (exactly the 0027 insert, plus the binding column), optionally naming an authorization. */
  const intentSql = (t: Tenant, initiator: string, options: { readonly authorization?: string | null; readonly account?: string; readonly target?: string; readonly workspaceId?: string; readonly organizationId?: string; readonly id?: string }) => {
    const id = options.id ?? randomUUID();
    return {
      id,
      statement: sql`insert into mutations.mutation_intents (id, organization_id, workspace_id, kind, request_type, target_interaction_id, connected_account_id, initiator_user_id, idempotency_key, status, attempt,
          capability_catalog_id, capability_catalog_revision, correlation_id, created_at, updated_at, validation_authorization_id)
        values (${id}, ${options.organizationId ?? t.organizationId}, ${options.workspaceId ?? t.workspaceId}, 'reply_public', 'human', ${options.target ?? t.ig.comment}, ${options.account ?? t.ig.account},
          ${initiator}, ${`key-${randomUUID()}`}, 'PENDING', 0, 'platform', 5, ${`corr-7b14f1-${randomUUID()}`}, now(), now(), ${options.authorization ?? null})`,
    };
  };
  const request = async (t: Tenant, initiator: string, options: Parameters<typeof intentSql>[2] = {}): Promise<string> => {
    const { id, statement } = intentSql(t, initiator, options);
    await asUser(initiator, options.workspaceId ?? t.workspaceId, (tx) => tx.execute(statement));
    return id;
  };
  /** The executor's R6 transition, as the bound worker writes it (column grants only). Returns the rows it moved. */
  const transition = (t: Tenant, intentId: string, from: string, to: string, extra = sql``) =>
    asWorker(t.workspaceId, async (tx) => (await tx.execute(sql`update mutations.mutation_intents set status = ${to}, attempt = 1, run_reference = 'run_7b14f1', updated_at = now() ${extra}
      where workspace_id = ${t.workspaceId} and id = ${intentId} and status = ${from}`)).rowCount ?? 0);
  const toExecuting = (t: Tenant, intentId: string) => transition(t, intentId, "PENDING", "EXECUTING");

  const authorizationRow = async (t: Tenant, id: string) =>
    (await oracle<{ intent_id: string | null; bound: boolean; consumed: boolean; revoked: boolean; issued_by: string; issue_reason: string; revoked_by: string | null; revocation_reason: string | null }>(
      `select intent_id, bound_at is not null as bound, consumed_at is not null as consumed, revoked_at is not null as revoked, issued_by, issue_reason, revoked_by, revocation_reason
         from mutations.validation_authorizations where workspace_id = $1 and id = $2`, [t.workspaceId, id]))[0];
  const stateOf = async (t: Tenant, id: string) => {
    const read = await asWorker(t.workspaceId, (tx) => readValidationAuthorization(tx, t.workspaceId, id));
    return read === undefined ? "INVISIBLE" : validationAuthorizationState(read, new Date());
  };
  const errorOf = async (promise: Promise<unknown>): Promise<{ code: string; constraint: string | undefined; message: string }> => {
    try {
      await promise;
    } catch (error) {
      const pgError = postgresError(error);
      if (pgError === undefined) throw error;
      const cause = (error as { cause?: { message?: string } }).cause;
      return { ...pgError, message: cause?.message ?? (error as Error).message };
    }
    expect.unreachable("expected the statement to be refused");
  };

  /** Awaits a refusal with exactly this SQLSTATE and a message naming the reason. */
  const refused = async (promise: Promise<unknown>, code: string, reason: RegExp): Promise<void> => {
    const error = await errorOf(promise);
    expect(error.code).toBe(code);
    expect(error.message).toMatch(reason);
  };

  beforeAll(() => {
    const target = getTarget();
    privileged = privilegedPool(target, 8);
    web = runtimeDatabase(target, "web", 8);
    worker = runtimeDatabase(target, "worker", 4);
  });

  afterAll(async () => {
    await cleanupWorld(privileged, organizations);
    await Promise.all([web.end(), worker.end()]);
    await privileged.end();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("1 · the exact scope: issue → bind → consume", () => {
    it("records the declared operator; the designated initiator's intent binds it; EXECUTING consumes it, once", async () => {
      const t = await tenant();
      const id = await issue(t);
      expect(await authorizationRow(t, id)).toEqual({ intent_id: null, bound: false, consumed: false, revoked: false, issued_by: OPERATOR.operator, issue_reason: "test", revoked_by: null, revocation_reason: null });
      expect(await stateOf(t, id)).toBe("ISSUED");
      // The designated initiator reads their own authorization (a later request needs its id).
      expect((await asUser(t.users.RESPONDER, t.workspaceId, (tx) => readValidationAuthorization(tx, t.workspaceId, id)))?.targetInteractionId).toBe(t.ig.comment);

      const intent = await request(t, t.users.RESPONDER, { authorization: id });
      expect(await authorizationRow(t, id)).toMatchObject({ intent_id: intent, bound: true, consumed: false });
      expect(await stateOf(t, id)).toBe("BOUND");
      expect(await oracle("select validation_authorization_id from mutations.mutation_intents where workspace_id = $1 and id = $2", [t.workspaceId, intent])).toEqual([{ validation_authorization_id: id }]);

      expect(await toExecuting(t, intent)).toBe(1);
      expect(await authorizationRow(t, id)).toMatchObject({ intent_id: intent, bound: true, consumed: true, revoked: false });
      expect(await stateOf(t, id)).toBe("CONSUMED");
      const shape = await oracle<{ ok: boolean }>(
        `select (bound_at >= issued_at and consumed_at >= bound_at and consumed_at < expires_at and expires_at = issued_at + interval '60 minutes') as ok
           from mutations.validation_authorizations where workspace_id = $1 and id = $2`, [t.workspaceId, id]);
      expect(shape).toEqual([{ ok: true }]);
    });

    it("issuance refuses a lifetime over 2 hours, a non-positive lifetime, a future preflight and a missing declaration", async () => {
      const t = await tenant();
      expect((await sqlState(issue(t, { lifetime: "121 minutes" }))).constraint).toBe("validation_authorizations_lifetime");
      // A non-positive lifetime is already expired: the guard refuses it before the CHECK would.
      expect((await sqlState(issue(t, { lifetime: "0 minutes" }))).code).toBe("42501");
      expect((await sqlState(issue(t, { lifetime: "-5 minutes" }))).code).toBe("42501");
      expect((await sqlState(issue(t, { preflightAgo: "-1 minute" }))).constraint).toBe("validation_authorizations_preflight_first");
      expect((await sqlState(issue(t, { operator: null }))).code).toBe("42501");
      expect((await sqlState(issue(t, { operator: { operator: "ops.validation-suite", reason: "release" } }))).code).toBe("23514");
      // Exactly 2 hours is the ceiling, admitted.
      await issue(t, { lifetime: "120 minutes" });
      // No expiry at all is impossible (NOT NULL).
      expect((await sqlState(asOperator(OPERATOR, (client) => client.query(
        `insert into mutations.validation_authorizations (id, organization_id, workspace_id, connected_account_id, target_interaction_id, initiator_user_id, provider, platform, kind, preflight_run_reference, preflight_completed_at)
         values ($1, $2, $3, $4, $5, $6, 'meta', 'instagram', 'reply_public', $7, now())`, [randomUUID(), t.organizationId, t.workspaceId, t.ig.account, t.ig.otherComment, t.users.RESPONDER, PREFLIGHT])))).code).toBe("23502");
    });

    it("issuance is born unbound, unconsumed and unrevoked, at the transaction's time, attributed to the declaration", async () => {
      const t = await tenant();
      const forged = (column: string, value: string) => asOperator(OPERATOR, (client) => client.query(
        `insert into mutations.validation_authorizations (id, organization_id, workspace_id, connected_account_id, target_interaction_id, initiator_user_id, provider, platform, kind, preflight_run_reference, preflight_completed_at, expires_at, ${column})
         values ($1, $2, $3, $4, $5, $6, 'meta', 'instagram', 'reply_public', $7, now(), now() + interval '1 hour', ${value})`, [randomUUID(), t.organizationId, t.workspaceId, t.ig.account, t.ig.comment, t.users.RESPONDER, PREFLIGHT]));
      for (const [column, value] of [["consumed_at", "now()"], ["revoked_at", "now()"], ["intent_id", `'${randomUUID()}'`], ["issued_at", "now() - interval '1 minute'"], ["issued_by", "'ops.somebody-else'"], ["issue_reason", "'live_validation'"]] as const) {
        expect((await sqlState(forged(column, value))).code, column).toBe("42501");
      }
    });

    it("at most one OPEN authorization per target; after revocation a new one may be issued", async () => {
      const t = await tenant();
      const first = await issue(t);
      expect(await errorOf(issue(t))).toMatchObject({ code: "23505" });
      // Another target of the same account is independent.
      await issue(t, { target: t.ig.otherComment });
      await revoke(t, first);
      const second = await issue(t);
      expect(second).not.toBe(first);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("2–6 · substitution fails like a non-existent authorization; foreign scopes are refused at issuance", () => {
    it("2 · another workspace: the authorization cannot be named from it, nor issued over its account or target", async () => {
      const t = await tenant();
      const other = await tenant();
      const id = await issue(t);
      // The other workspace's own replying member, on their own comment, naming this authorization: 23503 (R5).
      const foreign = await sqlState(request(other, other.users.RESPONDER, { authorization: id }));
      expect(foreign).toEqual({ code: "23503", constraint: "mutation_intents_validation_scope" });
      // Issued in this workspace over the other workspace's account (the guard: not an account of this workspace) or
      // target (the composite key), or under the other organization (the workspace key).
      expect((await sqlState(issue(t, { account: other.ig.account, target: other.ig.comment }))).code).toBe("42501");
      expect(await sqlState(issue(t, { target: other.ig.comment }))).toEqual({ code: "23503", constraint: "validation_authorizations_target" });
      expect(await sqlState(issue(t, { organizationId: other.organizationId, target: t.ig.otherComment }))).toEqual({ code: "23503", constraint: "validation_authorizations_workspace" });
      expect(await authorizationRow(t, id)).toMatchObject({ intent_id: null });
    });

    it("3 · another connected account of the same workspace", async () => {
      const t = await tenant();
      const second = await account(t.organizationId, t.workspaceId, t.meta, "instagram");
      const id = await issue(t);
      expect(await sqlState(request(t, t.users.RESPONDER, { authorization: id, account: second.account, target: second.comment }))).toEqual({ code: "23503", constraint: "mutation_intents_validation_scope" });
      // The authorization's target paired with the other account is not that account's interaction.
      expect((await sqlState(request(t, t.users.RESPONDER, { authorization: id, account: second.account }))).code).toBe("23503");
      expect(await authorizationRow(t, id)).toMatchObject({ intent_id: null });
    });

    it("4 · another target interaction of the same account", async () => {
      const t = await tenant();
      const id = await issue(t);
      expect(await sqlState(request(t, t.users.RESPONDER, { authorization: id, target: t.ig.otherComment }))).toEqual({ code: "23503", constraint: "mutation_intents_validation_scope" });
      expect(await authorizationRow(t, id)).toMatchObject({ intent_id: null });
    });

    it("5 · another platform or provider: only Instagram on a Meta connection", async () => {
      const t = await tenant();
      const facebook = await account(t.organizationId, t.workspaceId, t.meta, "facebook");
      const simulator = await account(t.organizationId, t.workspaceId, await connection(t.organizationId, t.workspaceId, t.users.OWNER, "simulator"), "instagram");
      // Declared facebook over the Facebook account: the closed CHECK (instagram only).
      expect((await sqlState(issue(t, { platform: "facebook", account: facebook.account, target: facebook.comment }))).code).toBe("23514");
      // Declared instagram over a Facebook account, or tiktok over the Instagram one: the guard (the account's own
      // platform); the (workspace, account, platform) key backs it.
      expect((await sqlState(issue(t, { account: facebook.account, target: facebook.comment }))).code).toBe("42501");
      expect((await sqlState(issue(t, { platform: "tiktok" }))).code).toBe("42501");
      // An Instagram account whose connection is not Meta (the simulator), or a declared non-Meta provider: refused.
      expect((await sqlState(issue(t, { account: simulator.account, target: simulator.comment }))).code).toBe("42501");
      expect((await sqlState(issue(t, { provider: "tiktok" }))).code).toBe("42501");
      // Declared simulator over the simulator account: the closed CHECK (meta only).
      expect((await sqlState(issue(t, { account: simulator.account, target: simulator.comment, provider: "simulator" }))).code).toBe("23514");
      // A Facebook intent naming the Instagram authorization: 23503.
      const id = await issue(t);
      expect((await sqlState(request(t, t.users.RESPONDER, { authorization: id, account: facebook.account, target: facebook.comment }))).code).toBe("23503");
    });

    it("6 · another operation: reply_public only", async () => {
      const t = await tenant();
      for (const kind of ["hide", "unhide", "delete", "block", "reply_private", "*"]) {
        expect((await sqlState(issue(t, { kind }))).code, kind).toBe("23514");
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("7–8 · expiry and revocation stop binding and consumption", () => {
    it("7 · expired before binding: no intent binds it", async () => {
      const t = await tenant();
      const id = await issue(t, { lifetime: "1500 milliseconds" });
      await new Promise((resolve) => setTimeout(resolve, 1_700));
      await refused(request(t, t.users.RESPONDER, { authorization: id }), "42501", /expired/);
      expect(await stateOf(t, id)).toBe("EXPIRED");
      expect(await authorizationRow(t, id)).toMatchObject({ intent_id: null, consumed: false });
    });

    it("7 · expired after binding: the intent never enters EXECUTING", async () => {
      const t = await tenant();
      const id = await issue(t, { lifetime: "1500 milliseconds" });
      const intent = await request(t, t.users.RESPONDER, { authorization: id });
      await new Promise((resolve) => setTimeout(resolve, 1_700));
      await refused(toExecuting(t, intent), "42501", /expired/);
      expect(await oracle("select status from mutations.mutation_intents where workspace_id = $1 and id = $2", [t.workspaceId, intent])).toEqual([{ status: "PENDING" }]);
      expect(await authorizationRow(t, id)).toMatchObject({ intent_id: intent, consumed: false });
      // The executor's own refusal (BLOCKED) remains possible and leaves it unconsumed and unbindable.
      expect(await transition(t, intent, "PENDING", "BLOCKED", sql`, outcome_code = 'CAPABILITY_UNAVAILABLE'`)).toBe(1);
      expect(await stateOf(t, id)).toBe("EXPIRED");
    });

    it("8 · revoked before binding: no intent binds it; revocation is declared, attributed and write-once", async () => {
      const t = await tenant();
      const id = await issue(t);
      expect((await sqlState(revoke(t, id, null))).code).toBe("42501");
      await revoke(t, id);
      expect(await authorizationRow(t, id)).toMatchObject({ revoked: true, revoked_by: "ops.validation-suite", revocation_reason: "superseded" });
      await refused(request(t, t.users.RESPONDER, { authorization: id }), "42501", /revoked/);
      // A second revocation (new time) is refused: write-once.
      expect((await sqlState(asOperator(OPERATOR, (client) => client.query("update mutations.validation_authorizations set revoked_at = now() + interval '1 second' where workspace_id = $1 and id = $2", [t.workspaceId, id])))).code).toBe("42501");
      expect(await stateOf(t, id)).toBe("REVOKED");
    });

    it("8 · revoked after binding, before execution: the intent never enters EXECUTING", async () => {
      const t = await tenant();
      const id = await issue(t);
      const intent = await request(t, t.users.RESPONDER, { authorization: id });
      await revoke(t, id);
      await refused(toExecuting(t, intent), "42501", /revoked/);
      expect(await authorizationRow(t, id)).toMatchObject({ intent_id: intent, consumed: false, revoked: true });
    });

    it("8 · after consumption revocation is refused (it cannot recall a call that may have left — PRE-LIVE-1 stays open)", async () => {
      const t = await tenant();
      const id = await issue(t);
      const intent = await request(t, t.users.RESPONDER, { authorization: id });
      expect(await toExecuting(t, intent)).toBe(1);
      await refused(revoke(t, id), "42501", /consumed/);
      expect(await authorizationRow(t, id)).toMatchObject({ consumed: true, revoked: false });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("9–11, 16 · single use: never two valid consumptions", () => {
    it("9 · consumed: no other intent binds it", async () => {
      const t = await tenant();
      const id = await issue(t);
      expect(await toExecuting(t, await request(t, t.users.RESPONDER, { authorization: id }))).toBe(1);
      expect(await sqlState(request(t, t.users.RESPONDER, { authorization: id }))).toEqual({ code: "23505", constraint: "mutation_intents_one_per_validation_authorization" });
    });

    it("10 · a second intent on a BOUND (still PENDING) authorization is refused", async () => {
      const t = await tenant();
      const id = await issue(t);
      const first = await request(t, t.users.RESPONDER, { authorization: id });
      expect(await sqlState(request(t, t.users.RESPONDER, { authorization: id }))).toEqual({ code: "23505", constraint: "mutation_intents_one_per_validation_authorization" });
      expect(await authorizationRow(t, id)).toMatchObject({ intent_id: first });
      expect(await oracle("select count(*)::int as n from mutations.mutation_intents where workspace_id = $1 and validation_authorization_id = $2", [t.workspaceId, id])).toEqual([{ n: 1 }]);
    });

    it("11 · concurrent claims: of 8 parallel requests exactly one binds; of 2 parallel EXECUTING claims exactly one moves", async () => {
      const t = await tenant();
      const id = await issue(t);
      const attempts = Array.from({ length: 8 }, () => {
        const { id: intent, statement } = intentSql(t, t.users.RESPONDER, { authorization: id });
        // Each holds its transaction open after the insert, so the claims overlap.
        return asUser(t.users.RESPONDER, t.workspaceId, async (tx) => {
          await tx.execute(statement);
          await tx.execute(sql`select pg_sleep(0.3)`);
          return intent;
        });
      });
      const settled = await Promise.allSettled(attempts);
      const won = settled.filter((result) => result.status === "fulfilled");
      const lost = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost.map((result) => postgresError(result.reason)?.code)).toEqual(Array.from({ length: 7 }, () => "23505"));
      const winner = (won[0] as PromiseFulfilledResult<string>).value;
      expect(await authorizationRow(t, id)).toMatchObject({ intent_id: winner, consumed: false });
      expect(await oracle("select count(*)::int as n from mutations.mutation_intents where workspace_id = $1 and validation_authorization_id = $2", [t.workspaceId, id])).toEqual([{ n: 1 }]);

      const claims = await Promise.all([toExecuting(t, winner), toExecuting(t, winner)]);
      expect([...claims].sort()).toEqual([0, 1]);
      expect(await authorizationRow(t, id)).toMatchObject({ consumed: true });
    });

    it("16 · after an uncertain outcome (timeout / lost response) nothing re-arms it: no second EXECUTING, no new intent", async () => {
      const t = await tenant();
      const id = await issue(t);
      const intent = await request(t, t.users.RESPONDER, { authorization: id });
      expect(await toExecuting(t, intent)).toBe(1);
      expect(await transition(t, intent, "EXECUTING", "OUTCOME_UNKNOWN", sql`, outcome_code = 'RESPONSE_LOST'`)).toBe(1);
      await refused(transition(t, intent, "OUTCOME_UNKNOWN", "EXECUTING", sql`, outcome_code = null`), "42501", /already consumed/);
      expect(await sqlState(request(t, t.users.RESPONDER, { authorization: id }))).toEqual({ code: "23505", constraint: "mutation_intents_one_per_validation_authorization" });
      // Even the operator cannot clear the consumption or the binding.
      for (const change of ["consumed_at = null", "intent_id = null, bound_at = null"]) {
        expect((await sqlState(asOperator(OPERATOR, (client) => client.query(`update mutations.validation_authorizations set ${change} where workspace_id = $1 and id = $2`, [t.workspaceId, id])))).code, change).toBe("42501");
      }
      expect(await stateOf(t, id)).toBe("CONSUMED");
    });

    it("16 · after a failure (BLOCKED before any call, or FAILED) it stays spent: a new intent cannot bind it", async () => {
      const t = await tenant();
      const blocked = await issue(t);
      const first = await request(t, t.users.RESPONDER, { authorization: blocked });
      expect(await transition(t, first, "PENDING", "BLOCKED", sql`, outcome_code = 'PROVIDER_ACTIONS_DISABLED'`)).toBe(1);
      expect(await sqlState(request(t, t.users.RESPONDER, { authorization: blocked }))).toEqual({ code: "23505", constraint: "mutation_intents_one_per_validation_authorization" });
      await revoke(t, blocked);
      const failed = await issue(t);
      const second = await request(t, t.users.RESPONDER, { authorization: failed });
      expect(await toExecuting(t, second)).toBe(1);
      expect(await transition(t, second, "EXECUTING", "FAILED", sql`, outcome_code = 'PROVIDER_REJECTED'`)).toBe(1);
      expect(await sqlState(request(t, t.users.RESPONDER, { authorization: failed }))).toEqual({ code: "23505", constraint: "mutation_intents_one_per_validation_authorization" });
      expect(await stateOf(t, failed)).toBe("CONSUMED");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("12–14 · actors, isolation and scope tampering", () => {
    it("12 · only the designated initiator binds it; no runtime role issues, alters, revokes or deletes one", async () => {
      const t = await tenant();
      const id = await issue(t);
      // Another replying member of the same workspace: the initiator is part of the scope key.
      expect(await sqlState(request(t, t.users.RESPONDER_2, { authorization: id }))).toEqual({ code: "23503", constraint: "mutation_intents_validation_scope" });
      expect(await sqlState(request(t, t.users.OWNER, { authorization: id }))).toEqual({ code: "23503", constraint: "mutation_intents_validation_scope" });
      // Non-replying roles cannot request at all (0027 policy).
      for (const role of ["ANALYST_VIEWER", "CLIENT_GUEST"] as const) {
        expect((await sqlState(request(t, t.users[role], { authorization: id }))).code, role).toBe("42501");
      }
      // Issuance for a non-replying member is refused.
      for (const role of ["ANALYST_VIEWER", "CLIENT_GUEST"] as const) {
        expect((await sqlState(issue(t, { initiator: t.users[role], target: t.ig.otherComment }))).code, role).toBe("42501");
      }
      // No runtime role writes the table (no grant): insert, update, delete.
      const writes = [
        sql`insert into mutations.validation_authorizations (id, organization_id, workspace_id, connected_account_id, target_interaction_id, initiator_user_id, provider, platform, kind, preflight_run_reference, preflight_completed_at, expires_at)
            values (${randomUUID()}, ${t.organizationId}, ${t.workspaceId}, ${t.ig.account}, ${t.ig.otherComment}, ${t.users.RESPONDER}, 'meta', 'instagram', 'reply_public', ${PREFLIGHT}, now(), now() + interval '1 hour')`,
        sql`update mutations.validation_authorizations set revoked_at = now() where id = ${id}`,
        sql`update mutations.validation_authorizations set expires_at = now() + interval '2 hours' where id = ${id}`,
        sql`delete from mutations.validation_authorizations where id = ${id}`,
      ];
      for (const statement of writes) {
        expect((await sqlState(asUser(t.users.RESPONDER, t.workspaceId, (tx) => tx.execute(statement)))).code).toBe("42501");
        expect((await sqlState(asUser(t.users.OWNER, t.workspaceId, (tx) => tx.execute(statement)))).code).toBe("42501");
        expect((await sqlState(asWorker(t.workspaceId, (tx) => tx.execute(statement)))).code).toBe("42501");
      }
      // The worker never inserts intents (0027); nobody calls the trigger functions directly.
      expect((await sqlState(asWorker(t.workspaceId, (tx) => tx.execute(intentSql(t, t.users.RESPONDER, { authorization: id }).statement)))).code).toBe("42501");
      for (const fn of ["validation_authorization_guard", "bind_validation_authorization", "consume_validation_authorization"]) {
        expect((await sqlState(asUser(t.users.OWNER, t.workspaceId, (tx) => tx.execute(sql.raw(`select mutations.${fn}()`))))).code, fn).toBe("42501");
        expect((await sqlState(asWorker(t.workspaceId, (tx) => tx.execute(sql.raw(`select mutations.${fn}()`))))).code, fn).toBe("42501");
      }
      expect(await authorizationRow(t, id)).toMatchObject({ intent_id: null, revoked: false });
    });

    it("13 · tenant isolation: the designated initiator and the bound worker read it; nobody else does", async () => {
      const t = await tenant();
      const other = await tenant();
      const id = await issue(t);
      const countAs = (user: string, workspace: string | undefined) =>
        asUser(user, workspace, async (tx) => Number((await tx.execute<{ n: string }>(sql`select count(*)::text as n from mutations.validation_authorizations`)).rows[0]?.n ?? "-1"));
      expect(await countAs(t.users.RESPONDER, t.workspaceId)).toBe(1);
      for (const role of ["OWNER", "RESPONDER_2", "ANALYST_VIEWER", "CLIENT_GUEST"] as const) expect(await countAs(t.users[role], t.workspaceId), role).toBe(0);
      expect(await countAs(t.users.RESPONDER, undefined)).toBe(0);
      expect(await countAs(other.users.OWNER, other.workspaceId)).toBe(0);
      const workerCount = (workspace: string) => asWorker(workspace, async (tx) => Number((await tx.execute<{ n: string }>(sql`select count(*)::text as n from mutations.validation_authorizations`)).rows[0]?.n ?? "-1"));
      expect(await workerCount(t.workspaceId)).toBe(1);
      expect(await workerCount(other.workspaceId)).toBe(0);
      expect(await asWorker(other.workspaceId, (tx) => readValidationAuthorization(tx, t.workspaceId, id))).toBeUndefined();
    });

    it("14 · scope tampering: the scope, lifetime and evidence never change; binding and consumption only through the intent", async () => {
      const t = await tenant();
      const id = await issue(t);
      const operatorUpdate = (change: string) => asOperator(OPERATOR, (client) => client.query(`update mutations.validation_authorizations set ${change} where workspace_id = $1 and id = $2`, [t.workspaceId, id]));
      for (const change of [
        `target_interaction_id = '${t.ig.otherComment}'`, `initiator_user_id = '${t.users.RESPONDER_2}'`, "expires_at = expires_at + interval '30 minutes'",
        "expires_at = expires_at - interval '30 minutes'", "preflight_run_reference = 'run_forged'", "issued_by = 'ops.somebody-else'", `workspace_id = workspace_id, connected_account_id = '${randomUUID()}'`,
        `intent_id = '${randomUUID()}', bound_at = now()`, "consumed_at = now()",
      ]) {
        expect((await sqlState(operatorUpdate(change))).code, change).toBe("42501");
      }
      expect((await sqlState(asOperator(OPERATOR, (client) => client.query("delete from mutations.validation_authorizations where workspace_id = $1 and id = $2", [t.workspaceId, id])))).code).toBe("42501");
      // The intent's binding: no runtime grant, and the trigger refuses everyone else.
      const intent = await request(t, t.users.RESPONDER, { authorization: id });
      const ordinary = await request(t, t.users.RESPONDER);
      expect((await sqlState(asWorker(t.workspaceId, (tx) => tx.execute(sql`update mutations.mutation_intents set validation_authorization_id = null where id = ${intent}`)))).code).toBe("42501");
      expect((await sqlState(asUser(t.users.RESPONDER, t.workspaceId, (tx) => tx.execute(sql`update mutations.mutation_intents set validation_authorization_id = ${id} where id = ${ordinary}`)))).code).toBe("42501");
      for (const [target, value] of [[intent, "null"], [ordinary, `'${id}'`]] as const) {
        expect((await sqlState(privileged.query(`update mutations.mutation_intents set validation_authorization_id = ${value} where workspace_id = $1 and id = $2`, [t.workspaceId, target]))).code).toBe("42501");
      }
      expect(await authorizationRow(t, id)).toMatchObject({ intent_id: intent, consumed: false });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("15, 17–18 · ordinary intents and the absence of any general grant", () => {
    it("15 · an ordinary intent (no authorization) on the same target executes as before and never touches an open authorization", async () => {
      const t = await tenant();
      const id = await issue(t);
      const ordinary = await request(t, t.users.RESPONDER);
      expect(await oracle("select validation_authorization_id from mutations.mutation_intents where workspace_id = $1 and id = $2", [t.workspaceId, ordinary])).toEqual([{ validation_authorization_id: null }]);
      expect(await toExecuting(t, ordinary)).toBe(1);
      expect(await transition(t, ordinary, "EXECUTING", "CONFIRMED")).toBe(1);
      expect(await authorizationRow(t, id)).toMatchObject({ intent_id: null, consumed: false, revoked: false });
      expect(await stateOf(t, id)).toBe("ISSUED");
    });

    it("17 · the 0027 request shape (no binding column named) is unchanged: it inserts, and the column defaults to NULL", async () => {
      const t = await tenant();
      const id = randomUUID();
      await asUser(t.users.RESPONDER, t.workspaceId, (tx) => tx.execute(sql`insert into mutations.mutation_intents (id, organization_id, workspace_id, kind, request_type, target_interaction_id, connected_account_id, initiator_user_id, idempotency_key, status, attempt,
          capability_catalog_id, capability_catalog_revision, correlation_id, created_at, updated_at)
        values (${id}, ${t.organizationId}, ${t.workspaceId}, 'reply_public', 'human', ${t.ig.comment}, ${t.ig.account}, ${t.users.RESPONDER}, ${`key-${randomUUID()}`}, 'PENDING', 0, 'platform', 5, ${`corr-7b14f1-${randomUUID()}`}, now(), now())`));
      expect(await oracle("select status, validation_authorization_id from mutations.mutation_intents where workspace_id = $1 and id = $2", [t.workspaceId, id])).toEqual([{ status: "PENDING", validation_authorization_id: null }]);
    });

    it("18 · no general grant: SELECT only, to the two runtime roles; no function is executable; no switch, grant or capability row appears", async () => {
      const t = await tenant();
      const snapshot = () => oracle<{ k: string; n: number }>(`select 'switches' as k, count(*)::int as n from system.operational_switches
        union all select 'switch_changes', count(*)::int from system.operational_switch_changes
        union all select 'profile_entries', count(*)::int from capability.profile_entries where workspace_id = $1`, [t.workspaceId]);
      const before = await snapshot();
      const id = await issue(t);
      expect(await toExecuting(t, await request(t, t.users.RESPONDER, { authorization: id }))).toBe(1);
      expect(await snapshot()).toEqual(before);
      const grants = await oracle<{ grantee: string; privilege: string }>(
        `select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end as grantee, a.privilege_type as privilege
           from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) a
          where n.nspname = 'mutations' and c.relname = 'validation_authorizations' and a.grantee <> c.relowner order by 1, 2`);
      expect(grants).toEqual([{ grantee: "app_worker", privilege: "SELECT" }, { grantee: "authenticated", privilege: "SELECT" }]);
      const columnGrants = await oracle(`select 1 from pg_attribute att join pg_class c on c.oid = att.attrelid join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'mutations' and c.relname = 'validation_authorizations' and att.attacl is not null`);
      expect(columnGrants).toEqual([]);
      // The intent's binding column: nobody holds a column UPDATE on it (the worker's column grants are 0027's five).
      const bindingGrants = await oracle(`select 1 from pg_attribute att join pg_class c on c.oid = att.attrelid join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'mutations' and c.relname = 'mutation_intents' and att.attname = 'validation_authorization_id' and att.attacl is not null`);
      expect(bindingGrants).toEqual([]);
      const executable = await oracle(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace, aclexplode(p.proacl) a
         where n.nspname = 'mutations' and p.proname in ('validation_authorization_guard', 'bind_validation_authorization', 'consume_validation_authorization') and a.grantee <> p.proowner`);
      expect(executable).toEqual([]);
      for (const role of ["anon", "service_role", "web_login", "worker_login", "system_login"]) {
        const reach = await oracle<{ r: boolean }>(`select coalesce((select has_table_privilege(r.oid, 'mutations.validation_authorizations', 'SELECT,INSERT,UPDATE,DELETE') from pg_roles r where r.rolname = $1), false) as r`, [role]);
        expect(reach, role).toEqual([{ r: false }]);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  // Step 7B-14F2 — hardening A (transitions), B (one consumed authorization per target) and C (READ COMMITTED only).
  describe("7B-14F2 · A · an authorized intent follows exactly the intent model's transitions and consumes on EXECUTING only", () => {
    const viaPrivileged = (t: Tenant, intent: string, to: string, outcome: string | null) =>
      privileged.query("update mutations.mutation_intents set status = $3, attempt = 1, run_reference = 'run_7b14f2', outcome_code = $4, updated_at = now() where workspace_id = $1 and id = $2", [t.workspaceId, intent, to, outcome]);

    it("PENDING → EXECUTING consumes exactly once; no second entry into EXECUTING from any status", async () => {
      const t = await tenant();
      const id = await issue(t);
      const intent = await request(t, t.users.RESPONDER, { authorization: id });
      expect(await toExecuting(t, intent)).toBe(1);
      const consumedAt = await oracle<{ c: Date }>("select consumed_at as c from mutations.validation_authorizations where workspace_id = $1 and id = $2", [t.workspaceId, id]);
      expect(await transition(t, intent, "EXECUTING", "OUTCOME_UNKNOWN", sql`, outcome_code = 'RESPONSE_LOST'`)).toBe(1);
      await refused(transition(t, intent, "OUTCOME_UNKNOWN", "EXECUTING", sql`, outcome_code = null`), "42501", /already consumed/);
      await refused(viaPrivileged(t, intent, "EXECUTING", null), "42501", /already consumed/);
      expect(await oracle<{ c: Date }>("select consumed_at as c from mutations.validation_authorizations where workspace_id = $1 and id = $2", [t.workspaceId, id])).toEqual(consumedAt);
    });

    it("PENDING → CONFIRMED / FAILED / OUTCOME_UNKNOWN (skipping EXECUTING) is refused — for the worker and for the privileged tooling", async () => {
      for (const [to, outcome] of [["CONFIRMED", null], ["FAILED", "PROVIDER_REJECTED"], ["OUTCOME_UNKNOWN", "RESPONSE_LOST"]] as const) {
        const t = await tenant();
        const id = await issue(t);
        const intent = await request(t, t.users.RESPONDER, { authorization: id });
        await refused(transition(t, intent, "PENDING", to, sql`, outcome_code = ${outcome}`), "42501", /only after consuming/);
        await refused(viaPrivileged(t, intent, to, outcome), "42501", /only after consuming/);
        expect(await oracle("select status from mutations.mutation_intents where workspace_id = $1 and id = $2", [t.workspaceId, intent])).toEqual([{ status: "PENDING" }]);
        expect(await authorizationRow(t, id)).toMatchObject({ intent_id: intent, consumed: false });
        // The executor's refusal stays possible, and a revocation is still meaningful (nothing was attempted).
        expect(await transition(t, intent, "PENDING", "BLOCKED", sql`, outcome_code = 'CAPABILITY_UNAVAILABLE'`)).toBe(1);
        await revoke(t, id);
      }
    });

    it("BLOCKED → EXECUTING is refused (worker and privileged); PENDING → BLOCKED keeps the authorization unconsumed and spent", async () => {
      const t = await tenant();
      const id = await issue(t);
      const intent = await request(t, t.users.RESPONDER, { authorization: id });
      expect(await transition(t, intent, "PENDING", "BLOCKED", sql`, outcome_code = 'PROVIDER_ACTIONS_DISABLED'`)).toBe(1);
      await refused(transition(t, intent, "BLOCKED", "EXECUTING", sql`, outcome_code = null`), "42501", /only from PENDING/);
      await refused(viaPrivileged(t, intent, "EXECUTING", null), "42501", /only from PENDING/);
      expect(await authorizationRow(t, id)).toMatchObject({ intent_id: intent, consumed: false });
      expect(await sqlState(request(t, t.users.RESPONDER, { authorization: id }))).toEqual({ code: "23505", constraint: "mutation_intents_one_per_validation_authorization" });
    });

    it("EXECUTING → CONFIRMED / FAILED / BLOCKED / OUTCOME_UNKNOWN and OUTCOME_UNKNOWN → CONFIRMED / FAILED are admitted; consumption stays; nothing leaves a terminal status", async () => {
      const outcomes = [["CONFIRMED", null], ["FAILED", "PROVIDER_REJECTED"], ["BLOCKED", "PROVIDER_MUTATION_UNSUPPORTED"], ["OUTCOME_UNKNOWN", "RESPONSE_LOST"]] as const;
      for (const [to, outcome] of outcomes) {
        const t = await tenant();
        const id = await issue(t);
        const intent = await request(t, t.users.RESPONDER, { authorization: id });
        expect(await toExecuting(t, intent)).toBe(1);
        expect(await transition(t, intent, "EXECUTING", to, sql`, outcome_code = ${outcome}`), to).toBe(1);
        if (to === "OUTCOME_UNKNOWN") {
          expect(await transition(t, intent, "OUTCOME_UNKNOWN", "CONFIRMED", sql`, outcome_code = null`)).toBe(1);
        }
        const final = to === "OUTCOME_UNKNOWN" ? "CONFIRMED" : to;
        for (const [next, code] of [["PENDING", null], ["OUTCOME_UNKNOWN", "RESPONSE_LOST"], ["FAILED", "PROVIDER_REJECTED"], ["CONFIRMED", null], ["BLOCKED", "PROVIDER_ACTIONS_DISABLED"]] as const) {
          if (next === final) continue;
          await refused(viaPrivileged(t, intent, next, code), "42501", /not a transition of an authorized intent/);
        }
        expect(await authorizationRow(t, id)).toMatchObject({ consumed: true, revoked: false });
      }
      const t = await tenant();
      const id = await issue(t);
      const intent = await request(t, t.users.RESPONDER, { authorization: id });
      expect(await toExecuting(t, intent)).toBe(1);
      expect(await transition(t, intent, "EXECUTING", "OUTCOME_UNKNOWN", sql`, outcome_code = 'RESPONSE_LOST'`)).toBe(1);
      expect(await transition(t, intent, "OUTCOME_UNKNOWN", "FAILED", sql`, outcome_code = 'PROVIDER_REJECTED'`)).toBe(1);
      await refused(viaPrivileged(t, intent, "PENDING", null), "42501", /not a transition of an authorized intent/);
      expect(await authorizationRow(t, id)).toMatchObject({ consumed: true });
    });

    it("an ordinary intent (no authorization) keeps every transition the database admitted before 0028", async () => {
      const t = await tenant();
      const skip = await request(t, t.users.RESPONDER);
      expect(await transition(t, skip, "PENDING", "CONFIRMED")).toBe(1);
      const revived = await request(t, t.users.RESPONDER);
      expect(await transition(t, revived, "PENDING", "BLOCKED", sql`, outcome_code = 'CAPABILITY_UNAVAILABLE'`)).toBe(1);
      expect(await transition(t, revived, "BLOCKED", "EXECUTING", sql`, outcome_code = null`)).toBe(1);
      const unknown = await request(t, t.users.RESPONDER);
      expect(await transition(t, unknown, "PENDING", "OUTCOME_UNKNOWN", sql`, outcome_code = 'RESPONSE_LOST'`)).toBe(1);
    });
  });

  describe("7B-14F2 · B · one consumed authorization per target, for ever", () => {
    const consumed = async (t: Tenant, after: "EXECUTING" | "OUTCOME_UNKNOWN" | "CONFIRMED" | "CONFIRMED_WITH_ID" | "FAILED"): Promise<string> => {
      const id = await issue(t);
      const intent = await request(t, t.users.RESPONDER, { authorization: id });
      if (after === "CONFIRMED_WITH_ID") {
        await oracle(`insert into mutations.outbound_replies (id, organization_id, workspace_id, intent_id, parent_interaction_id, connected_account_id, platform, text, created_at)
          values ($1, $2, $3, $4, $5, $6, 'instagram', 'Respuesta sintética 7B-14F2', now())`, [randomUUID(), t.organizationId, t.workspaceId, intent, t.ig.comment, t.ig.account]);
      }
      expect(await toExecuting(t, intent)).toBe(1);
      if (after === "OUTCOME_UNKNOWN") expect(await transition(t, intent, "EXECUTING", "OUTCOME_UNKNOWN", sql`, outcome_code = 'RESPONSE_LOST'`)).toBe(1);
      if (after === "FAILED") expect(await transition(t, intent, "EXECUTING", "FAILED", sql`, outcome_code = 'PROVIDER_REJECTED'`)).toBe(1);
      if (after === "CONFIRMED") expect(await transition(t, intent, "EXECUTING", "CONFIRMED")).toBe(1);
      if (after === "CONFIRMED_WITH_ID") {
        await oracle("update mutations.outbound_replies set provider_reply_id = 'ig_reply_7b14f2', confirmed_at = now() where workspace_id = $1 and intent_id = $2", [t.workspaceId, intent]);
        expect(await transition(t, intent, "EXECUTING", "CONFIRMED")).toBe(1);
      }
      return id;
    };

    it("after a consumption — EXECUTING, OUTCOME_UNKNOWN, CONFIRMED without and with a provider reply id, FAILED — no new authorization for that target", async () => {
      for (const after of ["EXECUTING", "OUTCOME_UNKNOWN", "CONFIRMED", "CONFIRMED_WITH_ID", "FAILED"] as const) {
        const t = await tenant();
        await consumed(t, after);
        await refused(issue(t), "23505", /already consumed for this target/);
        // Another initiator, another reason, a longer or shorter lifetime: no bypass.
        await refused(issue(t, { initiator: t.users.RESPONDER_2 }), "23505", /already consumed for this target/);
        await refused(issue(t, { operator: { operator: "ops.another-operator", reason: "live_validation" } }), "23505", /already consumed for this target/);
        await refused(issue(t, { lifetime: "5 minutes" }), "23505", /already consumed for this target/);
        expect(await oracle("select count(*)::int as n from mutations.validation_authorizations where workspace_id = $1 and target_interaction_id = $2", [t.workspaceId, t.ig.comment]), after).toEqual([{ n: 1 }]);
        // Another comment of the same account stays possible (a later validation uses another comment).
        await issue(t, { target: t.ig.otherComment });
      }
    });

    it("re-issuance stays possible after an UNCONSUMED authorization expired or was revoked (bound or not)", async () => {
      const t = await tenant();
      const revokedUnbound = await issue(t);
      await revoke(t, revokedUnbound);
      const revokedBound = await issue(t);
      const intent = await request(t, t.users.RESPONDER, { authorization: revokedBound });
      expect(await transition(t, intent, "PENDING", "BLOCKED", sql`, outcome_code = 'CAPABILITY_UNAVAILABLE'`)).toBe(1);
      await revoke(t, revokedBound);
      const expiring = await issue(t, { lifetime: "1500 milliseconds" });
      await refused(issue(t), "23505", /another open/);
      await new Promise((resolve) => setTimeout(resolve, 1_700));
      expect(await stateOf(t, expiring)).toBe("EXPIRED");
      const fresh = await issue(t);
      expect(await stateOf(t, fresh)).toBe("ISSUED");
    });

    it("concurrent issuances after a consumption are all refused; the declarative backstop exists", async () => {
      const t = await tenant();
      await consumed(t, "OUTCOME_UNKNOWN");
      const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => issue(t)));
      expect(attempts.map((a) => (a.status === "rejected" ? postgresError(a.reason)?.code : "OK"))).toEqual(["23505", "23505", "23505", "23505"]);
      expect(await oracle("select indexdef from pg_indexes where schemaname = 'mutations' and indexname = 'validation_authorizations_one_consumed_per_target'")).toEqual([
        { indexdef: "CREATE UNIQUE INDEX validation_authorizations_one_consumed_per_target ON mutations.validation_authorizations USING btree (workspace_id, target_interaction_id, kind) WHERE (consumed_at IS NOT NULL)" },
      ]);
    });
  });

  describe("7B-14F2 · C · issuance only under READ COMMITTED; never two OPEN authorizations for a target", () => {
    const insertIn = (client: pg.PoolClient, t: Tenant) => client.query(
      `insert into mutations.validation_authorizations (id, organization_id, workspace_id, connected_account_id, target_interaction_id, initiator_user_id, provider, platform, kind, preflight_run_reference, preflight_completed_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, 'meta', 'instagram', 'reply_public', $7, now(), now() + interval '60 minutes')`,
      [randomUUID(), t.organizationId, t.workspaceId, t.ig.account, t.ig.comment, t.users.RESPONDER, PREFLIGHT]);
    const begin = async (client: pg.PoolClient, isolation: string) => {
      await client.query(`begin isolation level ${isolation}`);
      await client.query("select set_config('app.operator_id', $1, true), set_config('app.change_reason', $2, true)", [OPERATOR.operator, OPERATOR.reason]);
    };
    /** Waits until `pid` is blocked on a lock (deterministic interleaving; bounded). */
    const blockedOnLock = async (pid: number): Promise<void> => {
      for (let i = 0; i < 200; i += 1) {
        const rows = await oracle<{ w: string | null }>("select wait_event_type as w from pg_stat_activity where pid = $1", [pid]);
        if (rows[0]?.w === "Lock") return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("the second issuer never waited on the lock");
    };

    it("REPEATABLE READ and SERIALIZABLE issuance are refused inside PostgreSQL, leaving no row", async () => {
      const t = await tenant();
      for (const isolation of ["repeatable read", "serializable"]) {
        const client = await privileged.connect();
        try {
          await begin(client, isolation);
          await refused(insertIn(client, t), "25000", /only under READ COMMITTED/);
        } finally {
          // Never hand a client back to the pool inside a transaction (whatever the outcome above).
          await client.query("rollback").catch(() => undefined);
          client.release();
        }
      }
      expect(await oracle("select count(*)::int as n from mutations.validation_authorizations where workspace_id = $1", [t.workspaceId])).toEqual([{ n: 0 }]);
      await issue(t);
    });

    it("READ COMMITTED, deterministic: a second issuer waits on the first; commit → refused, rollback → admitted", async () => {
      for (const ending of ["commit", "rollback"] as const) {
        const t = await tenant();
        const first = await privileged.connect();
        const second = await privileged.connect();
        try {
          await begin(first, "read committed");
          await begin(second, "read committed");
          const pid = (await second.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]?.pid ?? -1;
          await insertIn(first, t);
          const pending = insertIn(second, t).then(() => "OK", (error: unknown) => postgresError(error)?.code ?? "?");
          await blockedOnLock(pid);
          await first.query(ending);
          // The waiter re-checks AFTER the lock, on a fresh snapshot: it sees the committed row, or none after a rollback.
          expect(await pending, ending).toBe(ending === "commit" ? "23505" : "OK");
          await second.query(ending === "commit" ? "rollback" : "commit");
          expect(await oracle("select count(*)::int as n from mutations.validation_authorizations where workspace_id = $1 and target_interaction_id = $2", [t.workspaceId, t.ig.comment]), ending).toEqual([{ n: 1 }]);
        } finally {
          await first.query("rollback").catch(() => undefined);
          await second.query("rollback").catch(() => undefined);
          first.release();
          second.release();
        }
      }
    });

    it("READ COMMITTED, concurrent: of 6 overlapping issuers exactly one OPEN authorization results", async () => {
      const t = await tenant();
      const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => asOperator(OPERATOR, async (client) => {
        await insertIn(client, t);
        await client.query("select pg_sleep(0.1)");
      })));
      expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter((a): a is PromiseRejectedResult => a.status === "rejected").map((a) => postgresError(a.reason)?.code)).toEqual(Array.from({ length: 5 }, () => "23505"));
      expect(await oracle("select count(*)::int as n from mutations.validation_authorizations where workspace_id = $1 and revoked_at is null and consumed_at is null", [t.workspaceId])).toEqual([{ n: 1 }]);
    });
  });
}
