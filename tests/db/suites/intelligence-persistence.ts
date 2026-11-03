/**
 * Step H7-D1c — migration 0025 (intelligence persistence) on the real database, through the runtime logins. No runtime
 * writes these objects yet; the statements are the shapes H7-D1d will use. Proves: the intelligence plane is DB-valid
 * only for classification.understand_ai (and that topic binds only there); members can't append the topic; the AI
 * generation / failure state of a request; the append-only ledger and results (no raw text, prompt, response,
 * reasoning or action column; closed vocabularies; bounds; idempotency); SHADOW assessments invisible to members;
 * worker-only, least-privilege writes; composite workspace references; the atomic, race-safe budget reservation.
 */
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresInteractionTextReader } from "@/modules/interactions/persistence";
import { withUserScope, withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";
import { sqlState } from "./helpers";
import { INTELLIGENCE_PIPELINE, LANGUAGE_POLICY, attemptColumns, insertAiChain, insertAiRequest, insertIntent, insertRow, intentColumns, resultColumns, type AiTarget } from "./intelligence-fixtures";

interface Tenant extends AiTarget {
  readonly users: Readonly<Record<"owner" | "analyst" | "guest", string>>;
  readonly otherVersion: string;
  /** Further versions of the same interaction (one request per version × pipeline, so each test uses its own). */
  readonly spare: readonly string[];
}

const NEW_TABLES = ["ai_attempts", "ai_budget_reservations", "ai_results"] as const;
/** Whole name segments only (`interaction_id` is a reference, not an action; `source_text_version_id` a reference, not text). */
const FORBIDDEN_COLUMN = /\.((\w+_)?(prompt_text|rendered_prompt|raw\w*|response\w*|request_body|reasoning|thinking|chain_of_thought|comment\w*|author\w*|handle|api_key|access_token|secret\w*|action\w*|hide\w*|delete\w*|reply\w*|block\w*|moderat\w*|alert\w*|automat\w*)|source_text)$/;
const TASK = "classification.understanding";
const DAY = "2026-10-31";

export function defineIntelligencePersistenceSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let racers: RuntimeDatabase<"worker">;
  const organizations: string[] = [];
  let A: Tenant;
  let B: Tenant;

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const asWorker = <T>(t: Pick<Tenant, "workspaceId">, work: (tx: DatabaseTransaction) => Promise<T>) => withWorkspaceJobScope(worker, t.workspaceId, work);
  const asMember = <T>(t: Tenant, role: keyof Tenant["users"], work: (tx: DatabaseTransaction) => Promise<T>) =>
    withUserScope(web, { sub: t.users[role], role: "authenticated" }, t.workspaceId, work);
  /** Runs one parameterized statement as the bound worker. */
  const workerRow = (t: Pick<Tenant, "workspaceId">, statement: { readonly text: string; readonly values: unknown[] }) =>
    asWorker(t, (tx) => tx.execute(sql.raw(statement.text.replace(/\$(\d+)/g, (_, n: string) => literal(statement.values[Number(n) - 1])))));
  const count = async (t: Pick<Tenant, "workspaceId">, table: string, as: "worker" | Tenant, role: keyof Tenant["users"] = "owner"): Promise<number> => {
    const query = sql.raw(`select count(*)::int as n from ${table}`);
    const result = as === "worker" ? await asWorker(t, (tx) => tx.execute<{ n: number }>(query)) : await asMember(as, role, (tx) => tx.execute<{ n: number }>(query));
    return result.rows[0]?.n ?? -1;
  };

  const tenant = async (): Promise<Tenant> => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const users = { owner: randomUUID(), analyst: randomUUID(), guest: randomUUID() };
    organizations.push(organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'H7D1C', now())", [organizationId]);
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'MONITOR_ONLY', now())", [workspaceId, organizationId]);
    for (const [key, role] of [["owner", "OWNER"], ["analyst", "ANALYST_VIEWER"], ["guest", "CLIENT_GUEST"]] as const) {
      await privileged.query("insert into tenancy.organization_memberships values ($1, $2, $3, now())", [organizationId, users[key], key === "owner" ? "OWNER" : "MEMBER"]);
      await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, $4, '{}', now())", [organizationId, workspaceId, users[key], role]);
    }
    const connection = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`, [connection, organizationId, workspaceId, users.owner]);
    const asset = `h7d1c_${randomUUID().slice(0, 8)}`;
    const discovered = randomUUID();
    await privileged.query(
      `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'facebook', $5, 'content_bearing', 'Synthetic', now(), now(), now())`, [discovered, organizationId, workspaceId, connection, asset]);
    const account = randomUUID();
    await privileged.query(
      `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
       select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`, [account, discovered]);
    const content = randomUUID();
    await privileged.query(
      `insert into content.content_items (id, organization_id, workspace_id, platform, connected_account_id, provider_asset_id, provider_content_id, content_kind, reported_source,
                                          source_state, first_observed_at, latest_observed_at, created_at, updated_at)
       values ($1, $2, $3, 'facebook', $4, $5, $6, 'post', 'unknown', 'available', now(), now(), now(), now())`, [content, organizationId, workspaceId, account, asset, `${asset}_p`]);
    const interaction = randomUUID();
    await privileged.query(
      `insert into interactions.interactions (id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id,
                                              provider_content_id, observed, created_at, updated_at)
       values ($1, $2, $3, 'facebook', $4, $5, $6, $7, $8, false, now(), now())`, [interaction, organizationId, workspaceId, `${asset}_c`, account, asset, content, `${asset}_p`]);
    const versionOf = async (text: string): Promise<string> => {
      const id = randomUUID();
      await privileged.query(
        `insert into interactions.source_text_versions (id, organization_id, workspace_id, interaction_id, text_hash, source_text, provider_edited_at, observed_at, created_at)
         values ($1, $2, $3, $4, $5, $6, null, now(), now())`, [id, organizationId, workspaceId, interaction, createHash("sha256").update(text, "utf8").digest("hex"), text]);
      return id;
    };
    return {
      organizationId, workspaceId, users, interaction,
      version: await versionOf("Muy caro el precio"), otherVersion: await versionOf("Muy caro el precio, de verdad"),
      spare: [await versionOf("¿Precio?"), await versionOf("¿Precio? Gracias"), await versionOf("Excelente servicio")],
    };
  };

  /** An AI assessment row (shadow) of `t` naming `resultId`. */
  const aiAssessment = (t: Tenant, resultId: string | null, overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
    id: randomUUID(), organization_id: t.organizationId, workspace_id: t.workspaceId, interaction_id: t.interaction, source_text_version_id: t.version,
    dimension: "intent", origin: "ai", outcome: "values", value_keys: ["price_objection"], confidence_levels: ["high"], confidence_scores: [null], reason_codes: [],
    taxonomy_version: "taxonomy.v1", provider: "anthropic", model: "claude-sonnet-5-5", model_version: "claude-sonnet-5-5", task_id: TASK, task_version: "understanding-task.v2",
    prompt_version: "understanding-prompt.v2", prompt_hash: "c177c6f36c77337645d2cc9f45628f80bd2fbeddd8f5ac2a418ac97ae2c9b7bf", schema_version: "understanding-output.v1",
    confidence_policy_version: "confidence.v1", assessed_at: "2026-10-31T12:00:02Z", created_at: "2026-10-31T12:00:02Z",
    acceptance_mode: "shadow", pipeline_version: INTELLIGENCE_PIPELINE, language_policy_version: LANGUAGE_POLICY, ai_result_id: resultId, ...overrides,
  });

  beforeAll(async () => {
    const target = getTarget();
    privileged = privilegedPool(target, 3);
    web = runtimeDatabase(target, "web", 2);
    worker = runtimeDatabase(target, "worker", 2);
    racers = runtimeDatabase(target, "worker", 10);
    A = await tenant();
    B = await tenant();
  });
  afterAll(async () => {
    await Promise.all([web.end(), worker.end(), racers.end()]);
    await cleanupWorld(privileged, organizations);
    await privileged.end();
  });

  describe("schema", () => {
    it("1 · 3 · 24. 0025 is the 25th applied migration (0026, H7-D1e2b, follows); the three new tables are owned by app_owner with RLS enabled AND forced", async () => {
      const applied = await oracle<{ name: string }>("select name from app_migrations.applied order by name");
      expect(applied).toHaveLength(26);
      expect(applied[24]?.name).toBe("0025_intelligence_persistence.sql");
      expect(applied.at(-1)?.name).toBe("0026_ai_call_intents.sql");
      const tables = await oracle<{ t: string; owner: string; rls: boolean; forced: boolean }>(
        `select c.relname as t, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity as rls, c.relforcerowsecurity as forced
           from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'classification' and c.relname = any($1::text[]) order by 1`, [[...NEW_TABLES]]);
      expect(tables).toEqual(NEW_TABLES.map((t) => ({ t, owner: "app_owner", rls: true, forced: true })));
    });

    it("9–12. no new or changed table has a raw-text, prompt, response, reasoning, secret or action column", async () => {
      const columns = await oracle<{ t: string; c: string }>(
        `select table_name as t, column_name as c from information_schema.columns where table_schema = 'classification' and table_name = any($1::text[])`, [[...NEW_TABLES, "ai_call_intents", "assessments", "understanding_requests"]]);
      expect(columns.length).toBeGreaterThan(60);
      // H7-D1g-prep: the 0026 egress ledger is under the same privacy guard as the 0025 tables.
      expect(columns.filter((r) => r.t === "ai_call_intents").length).toBe(18);
      for (const { t, c } of columns) expect(`${t}.${c}`, `${t}.${c}`).not.toMatch(FORBIDDEN_COLUMN);
      const added = columns.filter((r) => r.t === "assessments" && ["acceptance_mode", "pipeline_version", "language_policy_version", "ai_result_id"].includes(r.c));
      expect(added).toHaveLength(4);
      expect(columns.filter((r) => r.t === "understanding_requests" && ["ai_generation", "ai_failure_class"].includes(r.c))).toHaveLength(2);
    });

    it("25. the managed constraint and index inventory of the new objects is exact", async () => {
      const constraints = await oracle<{ t: string; name: string }>(
        `select c.relname as t, k.conname as name from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'classification' and c.relname = any($1::text[]) and k.contype in ('u', 'f', 'p') order by 1, 2`, [[...NEW_TABLES]]);
      expect(constraints.map((r) => `${r.t} ${r.name}`)).toEqual([
        // H7-D1e2b (0026): + ai_attempts_intent (every attempt names its prior call intent).
        "ai_attempts ai_attempts_intent", "ai_attempts ai_attempts_once", "ai_attempts ai_attempts_organization_id_workspace_id_fkey", "ai_attempts ai_attempts_pkey", "ai_attempts ai_attempts_request",
        "ai_attempts ai_attempts_result_target",
        "ai_budget_reservations ai_budget_reservations_organization_id_workspace_id_fkey", "ai_budget_reservations ai_budget_reservations_pkey",
        "ai_results ai_results_assessment_target", "ai_results ai_results_attempt", "ai_results ai_results_once", "ai_results ai_results_organization_id_workspace_id_fkey",
        "ai_results ai_results_pkey", "ai_results ai_results_request",
      ].sort());
      const indexes = await oracle<{ name: string }>(
        `select indexname as name from pg_indexes where schemaname = 'classification' and indexname in ('understanding_requests_ai_inflight', 'assessments_ai_result', 'understanding_requests_ai_target')`);
      expect(indexes.map((r) => r.name).sort()).toEqual(["assessments_ai_result", "understanding_requests_ai_inflight", "understanding_requests_ai_target"]);
      const triggers = await oracle<{ name: string }>(
        `select t.tgname as name from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'classification' and not t.tgisinternal order by 1`);
      expect(triggers.map((r) => r.name)).toEqual(["ai_budget_reservation_guard", "understanding_request_guard"]);
    });
  });

  describe("system.outbox: the intelligence plane", () => {
    /** A privileged transaction that always rolls back (no understand_ai row ever reaches a relay pass). */
    const rolledBack = async (work: (client: pg.PoolClient) => Promise<void>): Promise<void> => {
      const client = await privileged.connect();
      try {
        await client.query("begin");
        await work(client);
      } finally {
        await client.query("rollback");
        client.release();
      }
    };
    const pendingRow = async (client: pg.PoolClient, topic: string): Promise<string> => {
      const id = randomUUID();
      await client.query(`insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type, dispatch_key, created_at)
        values ($1, $2, $3, $4, '{}', 'corr-h7-d1c-plane', 'system', $5, '2999-01-01T00:00:00Z')`, [id, topic, A.organizationId, A.workspaceId, `${topic}:${id}`]);
      return id;
    };
    /** A claim-shaped binding inside a savepoint: "bound", or the refusal as `code:constraint`. */
    const claim = async (client: pg.PoolClient, id: string, plane: string): Promise<string> => {
      await client.query("savepoint s");
      try {
        await client.query("update system.outbox set claimed_until = now() + interval '1 minute', execution_plane = $2 where id = $1", [id, plane]);
        return "bound";
      } catch (error: unknown) {
        await client.query("rollback to savepoint s");
        const { code, constraint } = error as { code?: string; constraint?: string };
        return `${code ?? "?"}:${constraint ?? ""}`;
      }
    };

    it("4 · 5 · 7. main / integration stay valid; intelligence binds ONLY classification.understand_ai, and that topic binds only there", async () => {
      const def = await oracle<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'system.outbox'::regclass and conname = 'outbox_execution_plane_known'");
      expect([...(def[0]?.def ?? "").matchAll(/'([a-z]+)'::text/g)].map((m) => m[1])).toEqual(["main", "integration", "intelligence"]);
      await rolledBack(async (client) => {
        expect(await claim(client, await pendingRow(client, "interactions.observed"), "main")).toBe("bound");
        expect(await claim(client, await pendingRow(client, "ingestion.confirm_interaction"), "integration")).toBe("bound");
        expect(await claim(client, await pendingRow(client, "classification.understand_ai"), "intelligence")).toBe("bound");
        expect(await claim(client, await pendingRow(client, "classification.understand_ai"), "main")).toBe("23514:outbox_intelligence_routing");
        expect(await claim(client, await pendingRow(client, "classification.understand_ai"), "integration")).toBe("23514:outbox_intelligence_routing");
        expect(await claim(client, await pendingRow(client, "interactions.observed"), "intelligence")).toBe("23514:outbox_intelligence_routing");
        expect(await claim(client, await pendingRow(client, "interactions.observed"), "tiktok")).toBe("23514:outbox_execution_plane_known");
      });
    });

    it("6. members can't append classification.understand_ai (own restrictive policy); the bound worker can", async () => {
      const row = (initiator: string) => sql`insert into system.outbox (id, topic, organization_id, workspace_id, subject_ids, correlation_id, initiator_type, initiator_user_id, dispatch_key, created_at)
        values (${randomUUID()}, 'classification.understand_ai', ${A.organizationId}, ${A.workspaceId}, '{}'::jsonb, 'corr-h7-d1c-topic', ${initiator}, ${initiator === "user" ? A.users.owner : null},
                ${`classification.understand_ai:${randomUUID()}:a1`}, '2999-01-01T00:00:00Z')`;
      expect((await sqlState(asMember(A, "owner", (tx) => tx.execute(row("user"))))).code).toBe("42501");
      const before = await oracle<{ n: number }>("select count(*)::int as n from system.outbox where topic = 'classification.understand_ai'");
      await expect(asWorker(A, async (tx) => {
        await tx.execute(row("system"));
        throw new Error("rollback-ok");
      })).rejects.toThrow("rollback-ok");
      expect(await oracle<{ n: number }>("select count(*)::int as n from system.outbox where topic = 'classification.understand_ai'")).toEqual(before);
    });
  });

  describe("understanding requests: the AI generation", () => {
    const insertRequest = (t: Tenant, pipeline: string, version = t.version) => asWorker(t, (tx) => tx.execute<{ id: string }>(sql`
      insert into classification.understanding_requests (id, organization_id, workspace_id, interaction_id, source_text_version_id, pipeline_version, arrival, state, created_at, updated_at)
      values (${randomUUID()}::uuid, ${t.organizationId}::uuid, ${t.workspaceId}::uuid, ${t.interaction}::uuid, ${version}::uuid, ${pipeline}, 'realtime', 'PENDING', now(), now()) returning id`))
      .then((r) => r.rows[0]?.id ?? "");
    const move = (t: Tenant, id: string, set: ReturnType<typeof sql>) => asWorker(t, (tx) => tx.execute(sql`update classification.understanding_requests set ${set}, updated_at = now() where id = ${id}::uuid`));

    it("18. the intelligence pipeline enters AI states with a generation 1..1000 that never decreases; AI_FAILED carries one of the five classes", async () => {
      const id = await insertRequest(A, INTELLIGENCE_PIPELINE, A.spare[0]);
      expect((await sqlState(move(A, id, sql`state = 'AI_PENDING'`))).constraint).toBe("understanding_requests_ai_state");
      await move(A, id, sql`state = 'AI_PENDING', ai_generation = 1`);
      expect((await sqlState(move(A, id, sql`ai_generation = 1001`))).constraint).toBe("understanding_requests_ai_generation_range");
      await move(A, id, sql`state = 'AI_RUNNING', ai_generation = 2`);
      expect((await sqlState(move(A, id, sql`ai_generation = 1`))).code).toBe("23514");
      expect((await sqlState(move(A, id, sql`ai_generation = null`))).code).toBe("23514");
      expect((await sqlState(move(A, id, sql`state = 'AI_FAILED', completed_at = now()`))).constraint).toBe("understanding_requests_ai_failure");
      expect((await sqlState(move(A, id, sql`state = 'AI_FAILED', completed_at = now(), ai_failure_class = 'AI_TIMEOUT'`))).constraint).toBe("understanding_requests_ai_failure_class");
      await move(A, id, sql`state = 'AI_FAILED', completed_at = now(), ai_failure_class = 'AI_BUDGET'`);
      expect((await sqlState(move(A, id, sql`ai_failure_class = 'AI_REFUSED'`))).code).toBe("23514");
    });

    it("26. a deterministic.v1 request is never continued: it can't enter an AI state or carry a generation", async () => {
      const id = await insertRequest(A, "classification.deterministic.v1", A.spare[1]);
      await move(A, id, sql`state = 'DETERMINISTIC_DONE'`);
      for (const set of [sql`state = 'AI_PENDING', ai_generation = 1`, sql`ai_generation = 1`, sql`state = 'COMPLETED', completed_at = now()`]) {
        expect((await sqlState(move(A, id, set))).constraint).toBe("understanding_requests_ai_state");
      }
      expect(await oracle("select state, ai_generation from classification.understanding_requests where id = $1", [id])).toEqual([{ state: "DETERMINISTIC_DONE", ai_generation: null }]);
      // A fresh request can't start with a generation either (requests start PENDING).
      expect((await sqlState(asWorker(A, (tx) => tx.execute(sql`insert into classification.understanding_requests (id, organization_id, workspace_id, interaction_id, source_text_version_id,
        pipeline_version, arrival, state, ai_generation, created_at, updated_at) values (${randomUUID()}::uuid, ${A.organizationId}::uuid, ${A.workspaceId}::uuid, ${A.interaction}::uuid,
        ${A.version}::uuid, 'classification.intelligence.v2', 'realtime', 'PENDING', 1, now(), now())`)))).code).toBe("23514");
    });
  });

  describe("the attempt ledger and the results", () => {
    it("15 · 17. the bound worker appends attempts and a result; a redelivered attempt or a second result is refused; nothing is updatable or deletable", async () => {
      const requestId = await insertAiRequest(privileged, { ...A, version: A.otherVersion });
      const target = { ...A, version: A.otherVersion };
      const attempt = attemptColumns(target, requestId);
      await insertIntent(privileged, target, requestId, 1, 1);
      await insertIntent(privileged, target, requestId, 1, 2);
      await workerRow(A, insertRow("classification.ai_attempts", attempt));
      expect((await sqlState(workerRow(A, insertRow("classification.ai_attempts", { ...attempt, id: randomUUID() })))).constraint).toBe("ai_attempts_once");
      await workerRow(A, insertRow("classification.ai_attempts", attemptColumns(target, requestId, { attempt_number: 2, attempt_kind: "reask" })));
      const result = resultColumns(target, requestId, attempt["id"] as string);
      await workerRow(A, insertRow("classification.ai_results", result));
      expect((await sqlState(workerRow(A, insertRow("classification.ai_results", { ...result, id: randomUUID() })))).constraint).toBe("ai_results_once");
      for (const statement of [
        sql`update classification.ai_attempts set outcome = 'refused' where id = ${attempt["id"] as string}::uuid`,
        sql`delete from classification.ai_attempts where id = ${attempt["id"] as string}::uuid`,
        sql`update classification.ai_results set summary = 'x' where id = ${result["id"] as string}::uuid`,
        sql`delete from classification.ai_results where id = ${result["id"] as string}::uuid`,
        sql`delete from classification.ai_budget_reservations`,
        sql`update classification.understanding_requests set pipeline_version = 'x' where id = ${requestId}::uuid`,
      ]) expect((await sqlState(asWorker(A, (tx) => tx.execute(statement)))).code).toBe("42501");
    });

    it("18 · 19. attempt bounds and the closed outcome ⇔ failure-class mapping; issue codes are the closed A1 vocabulary", async () => {
      const requestId = await insertAiRequest(privileged, { ...B });
      const bad = async (overrides: Readonly<Record<string, unknown>>) => sqlState(workerRow(B, insertRow("classification.ai_attempts", attemptColumns(B, requestId, overrides))));
      expect((await bad({ attempt_number: 3 })).code).toBe("23514");
      expect((await bad({ attempt_number: 0 })).code).toBe("23514");
      expect((await bad({ attempt_number: 2, attempt_kind: "initial" })).constraint).toBe("ai_attempts_kind");
      expect((await bad({ dispatch_generation: 0 })).code).toBe("23514");
      expect((await bad({ dispatch_generation: 1001 })).code).toBe("23514");
      expect((await bad({ outcome: "invalid_output", failure_class: "AI_BUDGET", issue_codes: ["UNKNOWN_VALUE"] })).constraint).toBe("ai_attempts_failure");
      expect((await bad({ outcome: "accepted", failure_class: "AI_INVALID_OUTPUT" })).constraint).toBe("ai_attempts_failure");
      expect((await bad({ outcome: "timeout", failure_class: "AI_UNAVAILABLE" })).code).toBe("23514");
      expect((await bad({ outcome: "invalid_output", failure_class: "AI_INVALID_OUTPUT", issue_codes: ["Ignore your rules"] })).code).toBe("23514");
      expect((await bad({ outcome: "accepted", issue_codes: ["UNKNOWN_VALUE"] })).constraint).toBe("ai_attempts_issues");
      expect((await bad({ model_requested: "claude sonnet with spaces" })).code).toBe("23514");
      expect((await bad({ cost_estimate_usd: 0.01 })).constraint).toBe("ai_attempts_cost");
      expect((await bad({ completed_at: "2026-10-31T11:00:00Z" })).constraint).toBe("ai_attempts_times");
      for (const [outcome, failure] of [["invalid_output", "AI_INVALID_OUTPUT"], ["refused", "AI_REFUSED"], ["unavailable", "AI_UNAVAILABLE"], ["input_too_large", "AI_INPUT_TOO_LARGE"]] as const) {
        await insertIntent(privileged, B, requestId, 10 + ["invalid_output", "refused", "unavailable", "input_too_large"].indexOf(outcome), 1);
        await workerRow(B, insertRow("classification.ai_attempts", attemptColumns(B, requestId, { dispatch_generation: 10 + ["invalid_output", "refused", "unavailable", "input_too_large"].indexOf(outcome),
          outcome, failure_class: failure, issue_codes: outcome === "invalid_output" ? ["MALFORMED_JSON", "QUOTE_NOT_IN_TEXT"] : [] })));
      }
    });

    it("20 · 21. a result holds ≤ 3 verified evidence spans and a plain summary of ≤ 240 characters; it names an ACCEPTED attempt of its request", async () => {
      const target = { ...B, version: B.otherVersion };
      const requestId = await insertAiRequest(privileged, target);
      const accepted = attemptColumns(target, requestId);
      await insertIntent(privileged, target, requestId, 1, 1);
      await insertIntent(privileged, target, requestId, 2, 1);
      await workerRow(B, insertRow("classification.ai_attempts", accepted));
      const failedAttempt = attemptColumns(target, requestId, { dispatch_generation: 2, outcome: "unavailable", failure_class: "AI_UNAVAILABLE" });
      await workerRow(B, insertRow("classification.ai_attempts", failedAttempt));
      const bad = (overrides: Readonly<Record<string, unknown>>) => sqlState(workerRow(B, insertRow("classification.ai_results", resultColumns(target, requestId, accepted["id"] as string, overrides))));
      expect((await bad({ evidence_starts: [0, 1, 2, 3], evidence_ends: [1, 2, 3, 4] })).constraint).toBe("ai_results_evidence");
      expect((await bad({ evidence_starts: [5], evidence_ends: [5] })).constraint).toBe("ai_results_evidence");
      expect((await bad({ evidence_starts: [0, 1], evidence_ends: [1] })).constraint).toBe("ai_results_evidence");
      expect((await bad({ evidence_starts: [0], evidence_ends: null })).constraint).toBe("ai_results_evidence");
      expect((await bad({ summary: "x".repeat(241) })).code).toBe("23514");
      expect((await bad({ summary: "" })).code).toBe("23514");
      expect((await bad({ summary: "ok\u0007bell" })).code).toBe("23514");
      expect((await bad({ acceptance_mode: "accepting" })).code).toBe("42501");
      expect((await bad({ route_fingerprint: "76e0ca1f" })).code).toBe("23514");
      expect((await bad({ attempt_id: failedAttempt["id"], dispatch_generation: 2 })).code).toBe("23503");
      expect((await bad({ dispatch_generation: 2 })).code).toBe("23503");
      await workerRow(B, insertRow("classification.ai_results", resultColumns(target, requestId, accepted["id"] as string, { summary: `${"y".repeat(239)}\n`, evidence_starts: [0, 4, 9], evidence_ends: [3, 8, 12] })));
    });
  });

  describe("shadow assessments", () => {
    it("13 · 14. every AI assessment is SHADOW and names its result; members can't see it, the worker can; non-AI rows stay accepting and visible", async () => {
      const chain = await insertAiChain(privileged, A);
      const id = randomUUID();
      await workerRow(A, insertRow("classification.assessments", aiAssessment(A, chain.resultId, { id })));
      const def = await oracle<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'classification.assessments'::regclass and conname = 'assessments_acceptance_mode_check'");
      expect([...(def[0]?.def ?? "").matchAll(/'([a-z]+)'::text/g)].map((m) => m[1])).toEqual(["shadow", "accepting"]);
      expect((await sqlState(workerRow(A, insertRow("classification.assessments", aiAssessment(A, chain.resultId, { dimension: "sentiment", value_keys: ["negative"], acceptance_mode: "accepting" }))))).constraint).toBe("assessments_ai_shadow_only");
      expect((await sqlState(workerRow(A, insertRow("classification.assessments", aiAssessment(A, chain.resultId, { dimension: "sentiment", value_keys: ["negative"], acceptance_mode: "provisional" }))))).code).toBe("23514");
      expect((await sqlState(workerRow(A, insertRow("classification.assessments", aiAssessment(A, null, { dimension: "sentiment", value_keys: ["negative"] }))))).constraint).toBe("assessments_ai_shadow_only");
      // The result must be of the SAME text version, pipeline and language policy.
      expect((await sqlState(workerRow(A, insertRow("classification.assessments", aiAssessment(A, chain.resultId, { dimension: "sentiment", value_keys: ["negative"], language_policy_version: "language-policy.v9" }))))).code).toBe("23503");
      expect((await sqlState(workerRow(A, insertRow("classification.assessments", aiAssessment(A, chain.resultId, { dimension: "sentiment", value_keys: ["negative"], source_text_version_id: A.otherVersion }))))).code).toBe("23503");
      // A human correction is accepting and visible; a human row can't claim shadow.
      const human = randomUUID();
      await asMember(A, "owner", (tx) => tx.execute(sql`insert into classification.assessments (id, organization_id, workspace_id, interaction_id, source_text_version_id, dimension, origin, outcome,
        value_keys, confidence_levels, confidence_scores, reason_codes, taxonomy_version, actor_user_id, corrects_assessment_id, assessed_at, created_at)
        values (${human}::uuid, ${A.organizationId}::uuid, ${A.workspaceId}::uuid, ${A.interaction}::uuid, ${A.version}::uuid, 'intent', 'human', 'values', '{complaint}', '{high}', '{NULL}', '{}',
                'taxonomy.v1', ${A.users.owner}::uuid, ${id}::uuid, now(), now())`));
      expect(await oracle("select acceptance_mode from classification.assessments where id = $1", [human])).toEqual([{ acceptance_mode: "accepting" }]);
      const visibleTo = (role: keyof Tenant["users"]) => asMember(A, role, (tx) => tx.execute<{ id: string }>(sql`select id from classification.assessments`)).then((r) => r.rows.map((row) => row.id));
      expect(await visibleTo("owner")).toEqual([human]);
      expect(await visibleTo("analyst")).toEqual([human]);
      expect(await visibleTo("guest")).toEqual([]);
      expect((await asWorker(A, (tx) => tx.execute<{ id: string }>(sql`select id from classification.assessments`))).rows.map((r) => r.id).sort()).toEqual([id, human].sort());
    });
  });

  describe("least privilege and tenant isolation", () => {
    it("16. members (any role) and guests can't read the ledger, the results or the budget counters at all", async () => {
      for (const table of ["classification.ai_attempts", "classification.ai_results", "classification.ai_budget_reservations"]) {
        for (const role of ["owner", "analyst", "guest"] as const) expect((await sqlState(count(A, table, A, role))).code, `${role} ${table}`).toBe("42501");
      }
      expect(await count(A, "classification.ai_attempts", "worker")).toBeGreaterThan(0);
    });

    it("8. cross-workspace references are impossible: B's request, attempt or result can't be named from A (fails like a missing row)", async () => {
      const b = await insertAiChain(privileged, { ...B, version: B.spare[0] ?? "" });
      // A's own rows naming B's request / attempt / result.
      expect((await sqlState(workerRow(A, insertRow("classification.ai_attempts", attemptColumns(A, b.requestId, { dispatch_generation: 7 }))))).code).toBe("23503");
      expect((await sqlState(workerRow(A, insertRow("classification.ai_results", resultColumns(A, b.requestId, b.attemptId))))).code).toBe("23503");
      expect((await sqlState(workerRow(A, insertRow("classification.assessments", aiAssessment(A, b.resultId, { dimension: "risk", value_keys: ["low"] }))))).code).toBe("23503");
      // A's worker can't write into B, nor read B.
      expect((await sqlState(workerRow(A, insertRow("classification.ai_attempts", attemptColumns(B, b.requestId, { dispatch_generation: 8 }))))).code).toBe("42501");
      expect(await asWorker(A, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from classification.ai_results where workspace_id = ${B.workspaceId}::uuid`)).then((r) => r.rows[0]?.n)).toBe(0);
    });
  });

  describe("the budget reservation authority", () => {
    const reserve = (db: RuntimeDatabase<"worker">, t: Pick<Tenant, "workspaceId">, calls: number, chars: number, maxCalls: number, maxChars: number, task = TASK, day = DAY) =>
      withWorkspaceJobScope(db, t.workspaceId, (tx) => tx.execute<{ ok: boolean }>(sql`select classification.reserve_ai_budget(${task}, ${day}::date, ${calls}, ${chars}::bigint, ${maxCalls}, ${maxChars}::bigint) as ok`))
        .then((r) => r.rows[0]?.ok);

    it("22. reservations add up to the caller's caps and no further; invalid arguments deny; counters never decrease", async () => {
      expect(await reserve(worker, A, 1, 1_000, 3, 10_000)).toBe(true);
      expect(await reserve(worker, A, 1, 1_000, 3, 10_000)).toBe(true);
      expect(await reserve(worker, A, 1, 9_000, 3, 10_000)).toBe(false); // chars cap
      expect(await reserve(worker, A, 1, 1_000, 3, 10_000)).toBe(true);
      expect(await reserve(worker, A, 1, 1_000, 3, 10_000)).toBe(false); // calls cap
      expect(await oracle("select reserved_calls, reserved_input_chars::int as chars from classification.ai_budget_reservations where workspace_id = $1 and task_id = $2", [A.workspaceId, TASK]))
        .toEqual([{ reserved_calls: 3, chars: 3_000 }]);
      for (const [calls, chars, maxCalls, maxChars] of [[0, 1, 3, 10], [1, -1, 3, 10], [5, 1, 3, 10], [1, 1, -1, 10]] as const) {
        expect(await reserve(worker, A, calls, chars, maxCalls, maxChars, "classification.other"), [calls, chars, maxCalls, maxChars].join(",")).toBe(false);
      }
      expect(await reserve(worker, A, 1, 1, 3, 10, "Bad Task")).toBe(false);
      expect((await sqlState(asWorker(A, (tx) => tx.execute(sql`update classification.ai_budget_reservations set reserved_calls = 0 where workspace_id = ${A.workspaceId}::uuid`))))).toMatchObject({ code: "23514" });
      expect((await sqlState(asWorker(A, (tx) => tx.execute(sql`update classification.ai_budget_reservations set task_id = 'x' where workspace_id = ${A.workspaceId}::uuid`))))).toMatchObject({ code: "42501" });
      // Another workspace has its own counter; a member can't reserve.
      expect(await reserve(worker, B, 1, 1_000, 3, 10_000)).toBe(true);
      expect((await sqlState(asMember(A, "owner", (tx) => tx.execute(sql`select classification.reserve_ai_budget(${TASK}, ${DAY}::date, 1, 1::bigint, 3, 10::bigint)`))))).toMatchObject({ code: "42501" });
    });

    it("23. 20 concurrent reservations against a cap of 5 grant exactly 5 — never more", async () => {
      const results = await Promise.all(Array.from({ length: 20 }, () => reserve(racers, B, 1, 10, 5, 1_000_000, TASK, "2026-11-01")));
      expect(results.filter((ok) => ok === true)).toHaveLength(5);
      expect(results.filter((ok) => ok === false)).toHaveLength(15);
      expect(await oracle("select reserved_calls from classification.ai_budget_reservations where workspace_id = $1 and budget_day = '2026-11-01'", [B.workspaceId])).toEqual([{ reserved_calls: 5 }]);
    });
  });

  describe("H7-D1g-prep: tenant boundaries of the intelligence ledger (direct inserts, ancestors, tenant deletion)", () => {
    /** A request + its intent + an ACCEPTED attempt of `t`, but no result yet (so a result insert is otherwise valid). */
    const attemptOnly = async (t: AiTarget) => {
      const requestId = await insertAiRequest(privileged, t);
      await insertIntent(privileged, t, requestId);
      const attempt = insertRow("classification.ai_attempts", attemptColumns(t, requestId));
      return { requestId, attemptId: (await privileged.query<{ id: string }>(attempt.text, attempt.values)).rows[0]?.id ?? "" };
    };
    /** A direct budget-counter insert (the table has no `id`, so not insertRow's `returning id`). */
    const budgetRow = (t: Pick<Tenant, "organizationId" | "workspaceId">) => ({
      text: `insert into classification.ai_budget_reservations (organization_id, workspace_id, task_id, budget_day, reserved_calls, reserved_input_chars, created_at, updated_at)
             values ($1, $2, $3, '2026-11-03'::date, 2, 8000, '2026-11-03T12:00:00Z', '2026-11-03T12:00:00Z')`,
      values: [t.organizationId, t.workspaceId, TASK],
    });

    it("1. A's bound worker can't INSERT an ai_results row into B's workspace (RLS 42501); the same row is valid in B's own scope", async () => {
      const b = await tenant();
      const chain = await attemptOnly(b);
      const row = insertRow("classification.ai_results", resultColumns(b, chain.requestId, chain.attemptId));
      expect((await sqlState(workerRow(A, row))).code).toBe("42501");
      expect(await oracle("select count(*)::int as n from classification.ai_results where workspace_id = $1", [b.workspaceId])).toEqual([{ n: 0 }]);
      await workerRow(b, row);
      expect(await oracle("select count(*)::int as n from classification.ai_results where workspace_id = $1", [b.workspaceId])).toEqual([{ n: 1 }]);
    });

    it("2. A's bound worker can't INSERT a budget counter into B's workspace (RLS 42501), and A's reservation never touches B's counter", async () => {
      const b = await tenant();
      expect((await sqlState(workerRow(A, budgetRow(b)))).code).toBe("42501");
      expect(await oracle("select count(*)::int as n from classification.ai_budget_reservations where workspace_id = $1", [b.workspaceId])).toEqual([{ n: 0 }]);
      await workerRow(b, budgetRow(b));
      const before = await oracle("select reserved_calls from classification.ai_budget_reservations where workspace_id = $1", [b.workspaceId]);
      expect(await asWorker(A, (tx) => tx.execute<{ ok: boolean }>(sql`select classification.reserve_ai_budget(${TASK}, '2026-11-03'::date, 1, 10::bigint, 100, 100000::bigint) as ok`)).then((r) => r.rows[0]?.ok)).toBe(true);
      expect(await oracle("select reserved_calls from classification.ai_budget_reservations where workspace_id = $1", [b.workspaceId])).toEqual(before);
    });

    it("3. no cross-tenant ancestor: B's interaction can't be named as A's parent (23503), and A's scope reads none of B's interactions or texts", async () => {
      const b = await tenant();
      const content = (await oracle<{ content_item_id: string; connected_account_id: string; provider_asset_id: string; provider_content_id: string }>(
        "select content_item_id, connected_account_id, provider_asset_id, provider_content_id from interactions.interactions where id = $1", [A.interaction]))[0];
      if (content === undefined) throw new Error("fixture");
      // A fully observed reply (every shape CHECK satisfied), so only the composite (workspace, parent) FK can refuse it.
      const reply = await sqlState(privileged.query(
        `insert into interactions.interactions (id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id,
                                                provider_content_id, parent_interaction_id, observed, kind, author_id, author_role, current_visibility, current_availability,
                                                provider_created_at, state_observed_at, first_observed_at, latest_observed_at, created_at, updated_at)
         values ($1, $2, $3, 'facebook', $4, $5, $6, $7, $8, $9, true, 'reply', null, 'user', 'visible', 'available', now(), now(), now(), now(), now(), now())`,
        [randomUUID(), A.organizationId, A.workspaceId, `h7d1g_${randomUUID().slice(0, 8)}`, content.connected_account_id, content.provider_asset_id, content.content_item_id, content.provider_content_id, b.interaction]));
      expect(reply.code).toBe("23503");
      // The ancestor read (interactions/persistence/store.ts `item`) filters by id only and relies on forced RLS: from A, B's id reads nothing.
      const ancestor = (t: Pick<Tenant, "workspaceId">, id: string) => asWorker(t, (tx) => tx.execute<{ n: number }>(sql`
        select count(*)::int as n from interactions.interactions i
          left join interactions.source_text_versions v on v.workspace_id = i.workspace_id and v.interaction_id = i.id
         where i.id = ${id}::uuid`)).then((r) => r.rows[0]?.n);
      expect(await ancestor(A, b.interaction)).toBe(0);
      expect(await ancestor(b, b.interaction)).toBeGreaterThan(0);
      expect(await asWorker(A, (tx) => createPostgresInteractionTextReader(tx).understandingContext(b.interaction, b.version))).toBeUndefined();
      expect(await asWorker(b, (tx) => createPostgresInteractionTextReader(tx).understandingContext(b.interaction, b.version))).toMatchObject({ workspaceId: b.workspaceId });
    });

    it("4. deleting a tenant cascades through EVERY intelligence table (request, intent, attempt, result, assessments, budget): no orphan, no other tenant touched", async () => {
      const c = await tenant();
      const chain = await insertAiChain(privileged, c);
      const assessment = insertRow("classification.assessments", aiAssessment(c, chain.resultId));
      await privileged.query(assessment.text, assessment.values);
      await workerRow(c, budgetRow(c));
      const TABLES = ["classification.understanding_requests", "classification.ai_call_intents", "classification.ai_attempts", "classification.ai_results", "classification.assessments",
        "classification.ai_budget_reservations", "interactions.source_text_versions", "interactions.interactions"] as const;
      const counts = async (workspaceId: string) => Object.fromEntries(await Promise.all(TABLES.map(async (table) =>
        [table, (await oracle<{ n: number }>(`select count(*)::int as n from ${table} where workspace_id = $1`, [workspaceId]))[0]?.n ?? -1] as const)));
      const others = { a: await counts(A.workspaceId), b: await counts(B.workspaceId) };
      const mine = await counts(c.workspaceId);
      for (const table of TABLES) expect(mine[table], table).toBeGreaterThan(0);
      await privileged.query("delete from tenancy.organizations where id = $1", [c.organizationId]);
      for (const table of TABLES) expect((await counts(c.workspaceId))[table], table).toBe(0);
      expect({ a: await counts(A.workspaceId), b: await counts(B.workspaceId) }).toEqual(others);
    });
  });

  describe("H7-D1e2b (0026): durable provider-call intents", () => {
    const INTENT_FORBIDDEN = /^((\w+_)?(prompt\w*|raw\w*|response\w*|request_body|reasoning|thinking|chain_of_thought|comment\w*|author\w*|handle|api_key|access_token|secret\w*|source_text|text|summary|output\w*|evidence\w*|action\w*|hide\w*|delete\w*|reply\w*|block\w*|moderat\w*|alert\w*|automat\w*|status|state|outcome|completed_at|usage\w*|\w*tokens))$/;

    it("1 · 3 · 18 · 19 · 20. the table exists, owned by app_owner, RLS enabled AND forced; no raw content, action or lifecycle column", async () => {
      expect(await oracle(`select pg_get_userbyid(c.relowner) as owner, c.relrowsecurity as rls, c.relforcerowsecurity as forced from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'classification' and c.relname = 'ai_call_intents'`)).toEqual([{ owner: "app_owner", rls: true, forced: true }]);
      const columns = (await oracle<{ c: string }>("select column_name as c from information_schema.columns where table_schema = 'classification' and table_name = 'ai_call_intents' order by ordinal_position")).map((r) => r.c);
      expect(columns).toEqual(["id", "organization_id", "workspace_id", "understanding_request_id", "interaction_id", "source_text_version_id", "pipeline_version", "dispatch_generation",
        "attempt_number", "attempt_kind", "task_id", "provider", "model_requested", "route_fingerprint", "input_chars", "correlation_id", "trigger_run_id", "created_at"]);
      for (const c of columns) expect(c, c).not.toMatch(INTENT_FORBIDDEN);
      const constraints = await oracle<{ name: string }>(`select k.conname as name from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'classification' and c.relname = 'ai_call_intents' and k.contype in ('u', 'f', 'p') order by 1`);
      expect(constraints.map((r) => r.name)).toEqual(["ai_call_intents_once", "ai_call_intents_pkey", "ai_call_intents_request", "ai_call_intents_workspace"]);
    });

    it("11 · 12 · 6 · 7. the bound worker inserts and reads an intent; a duplicate egress identity and an attempt number outside 1–2 are refused", async () => {
      const target = { ...A, version: A.spare[2] ?? "" };
      const requestId = await insertAiRequest(privileged, target);
      const first = intentColumns(target, requestId);
      await workerRow(A, insertRow("classification.ai_call_intents", first));
      expect(await count(A, "classification.ai_call_intents", "worker")).toBeGreaterThan(0);
      expect((await sqlState(workerRow(A, insertRow("classification.ai_call_intents", { ...first, id: randomUUID() })))).constraint).toBe("ai_call_intents_once");
      for (const attempt_number of [0, 3]) expect((await sqlState(workerRow(A, insertRow("classification.ai_call_intents", intentColumns(target, requestId, { attempt_number }))))).code).toBe("23514");
      expect((await sqlState(workerRow(A, insertRow("classification.ai_call_intents", intentColumns(target, requestId, { attempt_number: 2, attempt_kind: "initial" }))))).constraint).toBe("ai_call_intents_kind");
      expect((await sqlState(workerRow(A, insertRow("classification.ai_call_intents", intentColumns(target, requestId, { dispatch_generation: 0 }))))).code).toBe("23514");
      expect((await sqlState(workerRow(A, insertRow("classification.ai_call_intents", intentColumns(target, requestId, { pipeline_version: "classification.deterministic.v1" }))))).code).toBe("23514");
      await workerRow(A, insertRow("classification.ai_call_intents", intentColumns(target, requestId, { attempt_number: 2, attempt_kind: "reask" })));
    });

    it("8 · 9 · 13. nobody updates or deletes an intent (append-only)", async () => {
      for (const statement of [sql`update classification.ai_call_intents set input_chars = 1`, sql`delete from classification.ai_call_intents`]) {
        expect((await sqlState(asWorker(A, (tx) => tx.execute(statement)))).code).toBe("42501");
        expect((await sqlState(asMember(A, "owner", (tx) => tx.execute(statement)))).code).toBe("42501");
      }
    });

    it("10. members (any role) and guests can't read, insert or see intents", async () => {
      for (const role of ["owner", "analyst", "guest"] as const) {
        expect((await sqlState(asMember(A, role, (tx) => tx.execute(sql`select count(*) from classification.ai_call_intents`)))).code).toBe("42501");
      }
      const bTarget = { ...B, version: B.spare[2] ?? "" };
      const requestId = await insertAiRequest(privileged, bTarget);
      const row = insertRow("classification.ai_call_intents", intentColumns(bTarget, requestId));
      const statement = sql.raw(row.text.replace(/\$(\d+)/g, (_, n: string) => literal(row.values[Number(n) - 1])));
      expect((await sqlState(asMember(B, "owner", (tx) => tx.execute(statement)))).code).toBe("42501");
    });

    it("5 · 3. cross-workspace intents are impossible: B's request can't be named from A, and A can't write B's workspace", async () => {
      const b = await insertAiChain(privileged, { ...B, version: B.spare[1] ?? "" });
      const bTarget = { ...B, version: B.spare[1] ?? "" };
      // Naming B's request inside A's workspace fails like a missing row (composite FK); writing B's workspace is RLS.
      expect((await sqlState(workerRow(A, insertRow("classification.ai_call_intents", intentColumns({ ...bTarget, organizationId: A.organizationId, workspaceId: A.workspaceId }, b.requestId, { dispatch_generation: 9 }))))).code).toBe("23503");
      expect((await sqlState(workerRow(A, insertRow("classification.ai_call_intents", intentColumns(bTarget, b.requestId, { dispatch_generation: 9 }))))).code).toBe("42501");
      expect(await oracle("select count(*)::int as n from classification.ai_call_intents where workspace_id = $1 and dispatch_generation = 9", [A.workspaceId])).toEqual([{ n: 0 }]);
    });

    it("14 · 15 · 16 · 17. an attempt needs ITS intent: another generation, attempt number or request is refused", async () => {
      /** The intelligence request of one of B's text versions (reused when an earlier test created it). */
      const requestOf = async (version: string): Promise<string> =>
        (await oracle<{ id: string }>("select id from classification.understanding_requests where source_text_version_id = $1 and pipeline_version = $2", [version, INTELLIGENCE_PIPELINE]))[0]?.id
        ?? insertAiRequest(privileged, { ...B, version });
      const target = { ...B, version: B.spare[2] ?? "" };
      const requestId = await requestOf(target.version);
      await insertIntent(privileged, target, requestId, 3, 1);
      const attempt = (overrides: Readonly<Record<string, unknown>>) => workerRow(B, insertRow("classification.ai_attempts", attemptColumns(target, requestId, overrides)));
      expect((await sqlState(attempt({ dispatch_generation: 4 }))).constraint).toBe("ai_attempts_intent");
      expect((await sqlState(attempt({ dispatch_generation: 3, attempt_number: 2, attempt_kind: "reask", outcome: "unavailable", failure_class: "AI_UNAVAILABLE" }))).constraint).toBe("ai_attempts_intent");
      // The intent of THIS request does not cover another request of the same workspace (composite FK on the request too).
      const otherRequest = await requestOf(B.spare[1] ?? "");
      expect(otherRequest).not.toBe(requestId);
      expect((await sqlState(workerRow(B, insertRow("classification.ai_attempts", attemptColumns(target, otherRequest, { dispatch_generation: 3 }))))).code).toBe("23503");
      await attempt({ dispatch_generation: 3 });
      expect(await oracle("select count(*)::int as n from classification.ai_attempts where understanding_request_id = $1 and dispatch_generation = 3", [requestId])).toEqual([{ n: 1 }]);
    });
  });
}

/** A literal for the synthetic values these tests send (uuids, versions, numbers, arrays, timestamps — never user text). */
function literal(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "'{}'";
    return `array[${value.map((v) => literal(v)).join(", ")}]::${value.every((v) => typeof v === "number") ? "integer" : value.every((v) => v === null) ? "numeric" : "text"}[]`;
  }
  if (typeof value !== "string") throw new TypeError("literal_unsupported");
  return `'${value.replace(/'/g, "''")}'`;
}
