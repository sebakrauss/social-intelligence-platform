/**
 * Step H7-A2 — migration 0024 (classification persistence) on the real database, through the runtime logins. No runtime
 * code writes these tables yet; the statements here are the shapes H7-B/C will use. Proves: the immutable analysis
 * target, append-only assessments/signals/watch terms, the domain vocabulary (round-tripped from the pure domain's
 * exported keys), the machine identity / request idempotency boundaries, human corrections by workflow.internal
 * members as themselves, tenant isolation (read, insert, cross-workspace references) and that no canonical row moves.
 */
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ABSTENTIONS,
  AUTHENTICITY_VALUES,
  CONFIDENCE_LEVELS,
  DIMENSIONS,
  INTENT_VALUES,
  RESPONSE_NEED_VALUES,
  RISK_VALUES,
  SAFETY_VALUES,
  SENTIMENT_VALUES,
  SIGNAL_KINDS,
} from "@/modules/classification";
import { withUserScope, withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";
import { sqlState } from "./helpers";

interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly users: Readonly<Record<"owner" | "responder" | "analyst" | "guest", string>>;
  readonly interaction: string;
  readonly otherInteraction: string;
  readonly version: string;
  readonly edited: string;
  readonly otherVersion: string;
}

type Role = keyof Tenant["users"];

const AI = {
  provider: "simulator", model: "fixture-model", model_version: null, task_id: "classification.understand", task_version: "1", prompt_version: "1",
  prompt_hash: "sha256:fixture", schema_version: "understanding-output.v1", confidence_policy_version: "confidence.v1",
} as const;

interface AssessmentRow {
  readonly id?: string;
  readonly interaction?: string;
  readonly version?: string;
  readonly workspaceId?: string;
  readonly dimension: string;
  /** Any string, so tests can also send origins the database must refuse. */
  readonly origin?: string;
  readonly keys?: readonly string[] | null;
  readonly levels?: readonly string[] | null;
  readonly scores?: readonly (number | null)[] | null;
  readonly reasons?: readonly string[];
  readonly abstention?: string | null;
  readonly certainty?: string | null;
  readonly ai?: Partial<Record<keyof typeof AI, string | null>> | null;
  readonly rule?: { readonly kind: string; readonly version: string } | null;
  readonly hint?: { readonly kind: string; readonly version: string } | null;
  readonly actor?: string | null;
  readonly corrects?: string | null;
}

const textArray = (values: readonly (string | null)[] | null | undefined) => (values === null || values === undefined ? null : `{${values.map((v) => (v === null ? "NULL" : `"${v.replace(/(["\\])/g, "\\$1")}"`)).join(",")}}`);
const numericArray = (values: readonly (number | null)[] | null | undefined) => (values === null || values === undefined ? null : `{${values.map((v) => (v === null ? "NULL" : String(v))).join(",")}}`);
const intArray = (values: readonly number[] | null | undefined) => (values === null || values === undefined ? null : `{${values.join(",")}}`);

export function defineClassificationPersistenceSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  const organizations: string[] = [];
  let A: Tenant;
  let B: Tenant;

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const asWorker = <T>(t: Pick<Tenant, "workspaceId">, work: (tx: DatabaseTransaction) => Promise<T>) => withWorkspaceJobScope(worker, t.workspaceId, work);
  const asMember = <T>(t: Tenant, role: Role, workspaceId: string, work: (tx: DatabaseTransaction) => Promise<T>) =>
    withUserScope(web, { sub: t.users[role], role: "authenticated" }, workspaceId, work);

  const tenant = async (): Promise<Tenant> => {
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const users = { owner: randomUUID(), responder: randomUUID(), analyst: randomUUID(), guest: randomUUID() };
    organizations.push(organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'H7A2', now())", [organizationId]);
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'MONITOR_ONLY', now())", [workspaceId, organizationId]);
    for (const [key, role] of [["owner", "OWNER"], ["responder", "RESPONDER"], ["analyst", "ANALYST_VIEWER"], ["guest", "CLIENT_GUEST"]] as const) {
      await privileged.query("insert into tenancy.organization_memberships values ($1, $2, $3, now())", [organizationId, users[key], key === "owner" ? "OWNER" : "MEMBER"]);
      await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, $4, '{}', now())", [organizationId, workspaceId, users[key], role]);
    }
    const connection = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`, [connection, organizationId, workspaceId, users.owner]);
    const asset = `h7a2_${randomUUID().slice(0, 8)}`;
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
    const interactionOf = async (n: string): Promise<string> => {
      const id = randomUUID();
      await privileged.query(
        `insert into interactions.interactions (id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id,
                                                provider_content_id, observed, created_at, updated_at)
         values ($1, $2, $3, 'facebook', $4, $5, $6, $7, $8, false, now(), now())`, [id, organizationId, workspaceId, `${asset}_${n}`, account, asset, content, `${asset}_p`]);
      return id;
    };
    const versionOf = async (interaction: string, text: string): Promise<string> => {
      const id = randomUUID();
      const hash = createHash("sha256").update(text, "utf8").digest("hex");
      await privileged.query(
        `insert into interactions.source_text_versions (id, organization_id, workspace_id, interaction_id, text_hash, source_text, provider_edited_at, observed_at, created_at)
         values ($1, $2, $3, $4, $5, $6, null, now(), now())`, [id, organizationId, workspaceId, interaction, hash, text]);
      return id;
    };
    const interaction = await interactionOf("c1");
    const otherInteraction = await interactionOf("c2");
    const version = await versionOf(interaction, "¿Cuál es el precio?");
    const edited = await versionOf(interaction, "¿Cuál es el precio? Muy caro.");
    const otherVersion = await versionOf(otherInteraction, "Your company scammed me.");
    return { organizationId, workspaceId, users, interaction, otherInteraction, version, edited, otherVersion };
  };

  const insertSql = (t: Tenant, row: AssessmentRow) => {
    const origin = row.origin ?? "ai";
    // The default AI identity for AI rows; explicit AI fields on any other origin are sent as given (to prove the shape check).
    const ai = row.ai === null ? null : origin === "ai" ? { ...AI, ...(row.ai ?? {}) } : (row.ai ?? null);
    const values = row.abstention !== undefined && row.abstention !== null ? null : (row.keys ?? []);
    return sql`
      insert into classification.assessments (id, organization_id, workspace_id, interaction_id, source_text_version_id, dimension, origin, outcome, value_keys, confidence_levels,
        confidence_scores, reason_codes, abstention, language_certainty, taxonomy_version, rule_kind, rule_version, provider, model, model_version, task_id, task_version,
        prompt_version, prompt_hash, schema_version, confidence_policy_version, hint_kind, adapter_version, actor_user_id, corrects_assessment_id, assessed_at, created_at)
      values (${row.id ?? randomUUID()}::uuid, ${t.organizationId}::uuid, ${row.workspaceId ?? t.workspaceId}::uuid, ${row.interaction ?? t.interaction}::uuid, ${row.version ?? t.version}::uuid,
        ${row.dimension}, ${origin}, ${values === null ? "abstained" : "values"},
        ${textArray(values === null ? null : row.keys)}::text[], ${textArray(values === null ? null : (row.levels ?? (row.keys ?? []).map(() => "high")))}::text[],
        ${numericArray(values === null ? null : (row.scores ?? (row.keys ?? []).map(() => null)))}::numeric[], ${textArray(row.reasons ?? [])}::text[],
        ${row.abstention ?? null}, ${"certainty" in row ? (row.certainty ?? null) : row.dimension === "language" && values !== null ? "certain" : null}, 'taxonomy.v1',
        ${row.rule?.kind ?? null}, ${row.rule?.version ?? null},
        ${ai?.provider ?? null}, ${ai?.model ?? null}, ${ai?.model_version ?? null}, ${ai?.task_id ?? null}, ${ai?.task_version ?? null}, ${ai?.prompt_version ?? null},
        ${ai?.prompt_hash ?? null}, ${ai?.schema_version ?? null}, ${ai?.confidence_policy_version ?? null},
        ${row.hint?.kind ?? null}, ${row.hint?.version ?? null}, ${row.actor ?? null}::uuid, ${row.corrects ?? null}::uuid, now(), now())
      returning id`;
  };
  const machine = (t: Tenant, row: AssessmentRow) => asWorker(t, (tx) => tx.execute<{ id: string }>(insertSql(t, row))).then((r) => r.rows[0]?.id ?? "");
  const human = (t: Tenant, role: Role, row: AssessmentRow, workspaceId = t.workspaceId) =>
    asMember(t, role, workspaceId, (tx) => tx.execute<{ id: string }>(insertSql(t, { origin: "human", actor: t.users[role], ...row }))).then((r) => r.rows[0]?.id ?? "");

  const signalSql = (t: Tenant, row: { readonly kind: string; readonly revision?: string | null; readonly term?: string | null; readonly matcher?: string | null; readonly starts?: readonly number[] | null; readonly ends?: readonly number[] | null; readonly truncated?: boolean; readonly version?: string; readonly interaction?: string; readonly signalsVersion?: string }) => sql`
    insert into classification.signals (id, organization_id, workspace_id, interaction_id, source_text_version_id, kind, signals_version, watch_term_revision_id, watch_term_id,
                                        matcher_version, span_starts, span_ends, truncated, created_at)
    values (${randomUUID()}::uuid, ${t.organizationId}::uuid, ${t.workspaceId}::uuid, ${row.interaction ?? t.interaction}::uuid, ${row.version ?? t.version}::uuid, ${row.kind},
            ${row.signalsVersion ?? "signals.v1"}, ${row.revision ?? null}::uuid, ${row.term ?? null}::uuid, ${row.matcher ?? null}, ${intArray(row.starts)}::integer[],
            ${intArray(row.ends)}::integer[], ${row.truncated ?? false}, now())
    returning id`;
  const signal = (t: Tenant, row: Parameters<typeof signalSql>[1]) => asWorker(t, (tx) => tx.execute<{ id: string }>(signalSql(t, row))).then((r) => r.rows[0]?.id ?? "");

  /** A watch-term revision with one term, written by the privileged test login (no runtime writer exists yet). */
  const revisionOf = async (t: Tenant, revision: number, phrases: readonly string[] = ["precio"], excludes: readonly string[] = []): Promise<{ revision: string; term: string }> => {
    const id = randomUUID();
    const term = randomUUID();
    await privileged.query("insert into classification.watch_term_revisions (id, organization_id, workspace_id, revision, created_by_user_id, created_at) values ($1, $2, $3, $4, $5, now())",
      [id, t.organizationId, t.workspaceId, revision, t.users.owner]);
    await privileged.query("insert into classification.watch_terms (organization_id, workspace_id, revision_id, term_id, phrases, excludes, accent_sensitive, created_at) values ($1, $2, $3, $4, $5, $6, false, now())",
      [t.organizationId, t.workspaceId, id, term, phrases, excludes]);
    return { revision: id, term };
  };

  const canonicalDigest = async (t: Tenant): Promise<string> => {
    const rows = await oracle<{ d: string }>(
      `select md5(coalesce((select string_agg(x::text, '|' order by x::text) from interactions.interactions x where workspace_id = $1), '') ||
                  coalesce((select string_agg(v::text, '|' order by v::text) from interactions.source_text_versions v where workspace_id = $1), '') ||
                  coalesce((select string_agg(c::text, '|' order by c::text) from content.content_items c where workspace_id = $1), '')) as d`, [t.workspaceId]);
    return rows[0]?.d ?? "";
  };

  beforeAll(async () => {
    const target = getTarget();
    privileged = privilegedPool(target, 3);
    web = runtimeDatabase(target, "web", 2);
    worker = runtimeDatabase(target, "worker", 2);
    A = await tenant();
    B = await tenant();
  });
  afterAll(async () => {
    await Promise.all([web.end(), worker.end()]);
    await cleanupWorld(privileged, organizations);
    await privileged.end();
  });

  describe("schema", () => {
    it("1. 0024 created the classification schema (owned by app_owner) with its five tables, RLS enabled and forced", async () => {
      const tables = await oracle<{ t: string; owner: string; rls: boolean; forced: boolean }>(
        `select c.relname as t, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity as rls, c.relforcerowsecurity as forced
           from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'classification' and c.relkind = 'r' order by 1`);
      expect(tables).toEqual(["assessments", "signals", "understanding_requests", "watch_term_revisions", "watch_terms"].map((t) => ({ t, owner: "app_owner", rls: true, forced: true })));
      expect(await oracle("select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'classification'")).toEqual([{ owner: "app_owner" }]);
    });

    it("2. signals have no semantic column (no dimension, value, category, priority or confidence)", async () => {
      const columns = (await oracle<{ c: string }>("select column_name as c from information_schema.columns where table_schema = 'classification' and table_name = 'signals'")).map((r) => r.c);
      expect(columns.filter((c) => /dimension|value|categor|priority|confidence|score|intent|safety/.test(c))).toEqual([]);
      expect(await sqlState(asWorker(A, (tx) => tx.execute(sql`insert into classification.signals (id, organization_id, workspace_id, interaction_id, source_text_version_id, kind, signals_version, dimension, created_at)
        values (${randomUUID()}::uuid, ${A.organizationId}::uuid, ${A.workspaceId}::uuid, ${A.interaction}::uuid, ${A.version}::uuid, 'watch_term_match', 'signals.v1', 'safety', now())`)))).toMatchObject({ code: "42703" });
    });
  });

  describe("assessments: vocabulary (round-tripped from the pure domain)", () => {
    const closed: Readonly<Record<string, readonly string[]>> = { safety: SAFETY_VALUES, authenticity: AUTHENTICITY_VALUES, intent: INTENT_VALUES, sentiment: SENTIMENT_VALUES, risk: RISK_VALUES, response_need: RESPONSE_NEED_VALUES };

    it("3. every closed value of taxonomy.v1 (incl. safety.hate_speech) is accepted; an unknown one is refused", async () => {
      for (const [dimension, values] of Object.entries(closed)) {
        for (const value of values) {
          await machine(A, { dimension, keys: [value], ai: { prompt_version: `vocab-${dimension}-${value}` } });
        }
        expect(await sqlState(machine(A, { dimension, keys: ["expensive_price"], ai: { prompt_version: `bad-${dimension}` } }))).toMatchObject({ code: "23514", constraint: "assessments_outcome_shape" });
      }
      expect(SAFETY_VALUES).toContain("hate_speech");
    });

    it("4. the dimension, origin, confidence and abstention vocabularies are exactly the domain's (topics refused until `topics` exists)", async () => {
      const definition = (name: string) => oracle<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'classification.assessments'::regclass and conname = $1", [name]);
      const listed = (def: string) => [...def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]);
      expect(listed((await definition("assessments_dimension_check"))[0]?.def ?? "")).toEqual([...DIMENSIONS]);
      expect(listed((await definition("assessments_origin_check"))[0]?.def ?? "")).toEqual(["rule", "ai", "platform_hint", "human"]);
      expect(listed((await definition("assessments_abstention_check"))[0]?.def ?? "")).toEqual([...ABSTENTIONS]);
      for (const level of CONFIDENCE_LEVELS) await machine(A, { dimension: "sentiment", keys: ["neutral"], levels: [level], ai: { prompt_version: `level-${level}` } });
      expect(await sqlState(machine(A, { dimension: "sentiment", keys: ["neutral"], levels: ["very_high"], ai: { prompt_version: "level-bad" } }))).toMatchObject({ code: "23514" });
      expect(await sqlState(machine(A, { dimension: "toxicity", keys: ["x"] }))).toMatchObject({ code: "23514", constraint: "assessments_dimension_check" });
      expect(await sqlState(machine(A, { dimension: "topics", keys: ["price"] }))).toMatchObject({ code: "23514" });
      expect(await sqlState(machine(A, { dimension: "topics", abstention: "none_fits", ai: { prompt_version: "topics-abstain" } }))).toMatchObject({ code: "23514", constraint: "assessments_topics_deferred" });
      expect(await sqlState(machine(A, { dimension: "intent", origin: "watch_term", keys: ["complaint"] }))).toMatchObject({ code: "23514" });
    });

    it("5. cardinality, duplicates, the exclusive `none`, scores and reason codes are enforced", async () => {
      expect(await sqlState(machine(A, { dimension: "sentiment", keys: ["negative", "positive"], ai: { prompt_version: "card" } }))).toMatchObject({ code: "23514" });
      expect(await sqlState(machine(A, { dimension: "intent", keys: ["praise", "praise"], ai: { prompt_version: "dup" } }))).toMatchObject({ code: "23514" });
      expect(await sqlState(machine(A, { dimension: "safety", keys: ["none", "obvious_spam"], ai: { prompt_version: "none" } }))).toMatchObject({ code: "23514" });
      expect(await sqlState(machine(A, { dimension: "intent", keys: [], ai: { prompt_version: "empty" } }))).toMatchObject({ code: "23514" });
      expect(await sqlState(machine(A, { dimension: "sentiment", keys: ["negative"], scores: [1.5], ai: { prompt_version: "score" } }))).toMatchObject({ code: "23514" });
      await machine(A, { dimension: "sentiment", keys: ["negative"], scores: [0.91], ai: { prompt_version: "score-ok" } });
      await machine(A, { dimension: "risk", keys: ["high"], reasons: ["reputation_risk"], ai: { prompt_version: "reason-ok" } });
      expect(await sqlState(machine(A, { dimension: "risk", keys: ["high"], reasons: ["vibes"], ai: { prompt_version: "reason-bad" } }))).toMatchObject({ code: "23514" });
      expect(await sqlState(machine(A, { dimension: "intent", keys: ["complaint"], reasons: ["reputation_risk"], ai: { prompt_version: "reason-intent" } }))).toMatchObject({ code: "23514" });
    });

    it("6. language: canonical BCP-47 tags with a certainty; the certainty is required there and forbidden elsewhere", async () => {
      for (const tags of [["es"], ["pt-BR"], ["en", "es"], ["es-419"], ["zh-Hant-TW"], ["fr"]]) await machine(A, { dimension: "language", keys: tags, ai: { prompt_version: `lang-${tags.join("+")}` } });
      await machine(A, { dimension: "language", keys: ["es"], certainty: "uncertain", ai: { prompt_version: "lang-uncertain" } });
      expect(await sqlState(machine(A, { dimension: "language", keys: ["ES"], ai: { prompt_version: "lang-case" } }))).toMatchObject({ code: "23514" });
      expect(await sqlState(machine(A, { dimension: "language", keys: ["spanish"], ai: { prompt_version: "lang-word" } }))).toMatchObject({ code: "23514" });
      expect(await sqlState(machine(A, { dimension: "language", keys: ["es"], certainty: null, ai: { prompt_version: "lang-no-certainty" } }))).toMatchObject({ code: "23514", constraint: "assessments_language_certainty" });
      expect(await sqlState(machine(A, { dimension: "intent", keys: ["praise"], certainty: "certain", ai: { prompt_version: "certainty-intent" } }))).toMatchObject({ code: "23514", constraint: "assessments_language_certainty" });
      await machine(A, { dimension: "language", abstention: "insufficient_evidence", ai: { prompt_version: "lang-unknown" } });
    });

    it("7. explicit abstention is stored as an abstention, never a value", async () => {
      const id = await machine(A, { dimension: "intent", abstention: "none_fits", ai: { prompt_version: "abstain" } });
      expect(await oracle("select outcome, value_keys, abstention from classification.assessments where id = $1", [id])).toEqual([{ outcome: "abstained", value_keys: null, abstention: "none_fits" }]);
      expect(await sqlState(asWorker(A, (tx) => tx.execute(sql`insert into classification.assessments (id, organization_id, workspace_id, interaction_id, source_text_version_id, dimension, origin,
        outcome, value_keys, confidence_levels, confidence_scores, abstention, taxonomy_version, provider, model, task_id, task_version, prompt_version, prompt_hash, schema_version,
        confidence_policy_version, assessed_at, created_at) values (${randomUUID()}::uuid, ${A.organizationId}::uuid, ${A.workspaceId}::uuid, ${A.interaction}::uuid, ${A.version}::uuid,
        'intent', 'ai', 'abstained', '{praise}', '{high}', '{NULL}', 'none_fits', 'taxonomy.v1', 'p', 'm', 't', '1', 'abstain-mixed', 'h', 's', 'c', now(), now())`)))).toMatchObject({ code: "23514" });
    });
  });

  describe("assessments: origins, append-only, identity", () => {
    it("8. each origin carries exactly its provenance; the only rule is the narrow malicious-link fact", async () => {
      await machine(A, { dimension: "safety", origin: "rule", keys: ["malicious_link"], rule: { kind: "link_reputation_malicious", version: "link-reputation.v1" } });
      expect(await sqlState(machine(A, { dimension: "safety", origin: "rule", keys: ["obvious_spam"], rule: { kind: "link_reputation_malicious", version: "v2" } }))).toMatchObject({ code: "23514", constraint: "assessments_rule_shape" });
      expect(await sqlState(machine(A, { dimension: "intent", origin: "rule", keys: ["fraud_accusation_against_brand"], rule: { kind: "link_reputation_malicious", version: "v3" } }))).toMatchObject({ code: "23514" });
      expect(await sqlState(machine(A, { dimension: "safety", origin: "rule", keys: ["scam_fraud_content"], rule: { kind: "watch_term_match", version: "v4" } }))).toMatchObject({ code: "23514" });
      expect(await sqlState(machine(A, { dimension: "intent", keys: ["praise"], ai: { provider: null, prompt_version: "no-provider" } }))).toMatchObject({ code: "23514", constraint: "assessments_ai_shape" });
      expect(await sqlState(machine(A, { dimension: "intent", origin: "platform_hint", keys: ["praise"], hint: { kind: "spam_flag", version: "meta.v1" }, ai: { provider: "x" } }))).toMatchObject({ code: "23514" });
      await machine(A, { dimension: "safety", origin: "platform_hint", keys: ["obvious_spam"], hint: { kind: "spam_flag", version: "meta.v1" } });
    });

    it("9. append-only: no runtime role may UPDATE or DELETE an assessment", async () => {
      const id = await machine(A, { dimension: "intent", keys: ["praise"], ai: { prompt_version: "immutable" } });
      expect(await sqlState(asWorker(A, (tx) => tx.execute(sql`update classification.assessments set value_keys = '{complaint}' where id = ${id}::uuid`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(asWorker(A, (tx) => tx.execute(sql`delete from classification.assessments where id = ${id}::uuid`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(asMember(A, "owner", A.workspaceId, (tx) => tx.execute(sql`update classification.assessments set value_keys = '{complaint}' where id = ${id}::uuid`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(asMember(A, "owner", A.workspaceId, (tx) => tx.execute(sql`delete from classification.assessments where id = ${id}::uuid`)))).toMatchObject({ code: "42501" });
    });

    it("10. a machine assessment is unique per (text version, dimension, method); new versions and other text versions add history", async () => {
      const row = { dimension: "sentiment", keys: ["neutral"], ai: { prompt_version: "identity" } } as const;
      await machine(A, row);
      expect(await sqlState(machine(A, row))).toMatchObject({ code: "23505", constraint: "assessments_machine_identity" });
      expect(await sqlState(machine(A, { ...row, keys: ["positive"] }))).toMatchObject({ code: "23505" });
      await machine(A, { ...row, ai: { prompt_version: "identity", model_version: "2026-10" } });
      await machine(A, { ...row, ai: { prompt_version: "identity", task_version: "2" } });
      await machine(A, { ...row, version: A.edited });
      const rule = { dimension: "safety", origin: "rule", keys: ["malicious_link"], rule: { kind: "link_reputation_malicious", version: "identity.v1" } } as const;
      await machine(A, rule);
      expect(await sqlState(machine(A, rule))).toMatchObject({ code: "23505" });
    });

    it("11. the target is the interaction's OWN immutable text version; another interaction's version is refused", async () => {
      expect(await sqlState(machine(A, { dimension: "intent", keys: ["praise"], version: A.otherVersion, ai: { prompt_version: "mismatch" } }))).toMatchObject({ code: "23503" });
      await machine(A, { dimension: "intent", keys: ["fraud_accusation_against_brand"], interaction: A.otherInteraction, version: A.otherVersion, ai: { prompt_version: "own" } });
    });
  });

  describe("human corrections", () => {
    it("12. a workflow.internal member corrects as themselves; history keeps the machine row untouched", async () => {
      const ai = await machine(A, { dimension: "intent", keys: ["praise"], ai: { prompt_version: "to-correct" } });
      const before = await oracle("select * from classification.assessments where id = $1", [ai]);
      const ownerCorrection = await human(A, "owner", { dimension: "intent", keys: ["complaint"], corrects: ai });
      const responderCorrection = await human(A, "responder", { dimension: "intent", keys: ["praise"], corrects: ownerCorrection });
      expect(await oracle("select * from classification.assessments where id = $1", [ai])).toEqual(before);
      expect(await oracle("select origin, actor_user_id, corrects_assessment_id from classification.assessments where id = any($1::uuid[]) order by created_at, actor_user_id",
        [[ownerCorrection, responderCorrection]])).toHaveLength(2);
      // Two human rows with the same content are both kept (appended, never collapsed).
      await human(A, "owner", { dimension: "intent", keys: ["complaint"] });
      await human(A, "owner", { dimension: "intent", keys: ["complaint"] });
    });

    it("13. analysts, guests, another member's identity, the worker and members of another workspace can't author corrections", async () => {
      expect(await sqlState(human(A, "analyst", { dimension: "intent", keys: ["complaint"] }))).toMatchObject({ code: "42501" });
      expect(await sqlState(human(A, "guest", { dimension: "intent", keys: ["complaint"] }))).toMatchObject({ code: "42501" });
      expect(await sqlState(asMember(A, "responder", A.workspaceId, (tx) => tx.execute(insertSql(A, { origin: "human", actor: A.users.owner, dimension: "intent", keys: ["complaint"] }))))).toMatchObject({ code: "42501" });
      expect(await sqlState(machine(A, { dimension: "intent", origin: "human", actor: A.users.owner, keys: ["complaint"], ai: null }))).toMatchObject({ code: "42501" });
      // A member of B binding A's workspace: no role there.
      expect(await sqlState(asMember(B, "owner", A.workspaceId, (tx) => tx.execute(insertSql(A, { origin: "human", actor: B.users.owner, dimension: "intent", keys: ["complaint"] }))))).toMatchObject({ code: "42501" });
      // Members can't write machine origins (WEB holds no AI-assessment write).
      expect(await sqlState(asMember(A, "owner", A.workspaceId, (tx) => tx.execute(insertSql(A, { dimension: "intent", keys: ["praise"], ai: { prompt_version: "web-ai" } }))))).toMatchObject({ code: "42501" });
    });

    it("14. human values are authoritative (high); a correction names an assessment of the same interaction and dimension", async () => {
      expect(await sqlState(human(A, "owner", { dimension: "intent", keys: ["complaint"], levels: ["medium"] }))).toMatchObject({ code: "23514" });
      const sentiment = await machine(A, { dimension: "sentiment", keys: ["positive"], ai: { prompt_version: "other-dim" } });
      expect(await sqlState(human(A, "owner", { dimension: "intent", keys: ["complaint"], corrects: sentiment }))).toMatchObject({ code: "23503" });
      const otherInteraction = await machine(A, { dimension: "intent", keys: ["praise"], interaction: A.otherInteraction, version: A.otherVersion, ai: { prompt_version: "other-int" } });
      expect(await sqlState(human(A, "owner", { dimension: "intent", keys: ["complaint"], corrects: otherInteraction }))).toMatchObject({ code: "23503" });
      expect(await sqlState(machine(A, { dimension: "intent", keys: ["praise"], corrects: sentiment, ai: { prompt_version: "machine-corrects" } }))).toMatchObject({ code: "23514" });
    });
  });

  describe("tenant isolation", () => {
    it("15. A can't read B; guests read nothing; analysts read", async () => {
      await machine(B, { dimension: "intent", keys: ["praise"], ai: { prompt_version: "b-row" } });
      const visible = (t: Tenant, role: Role, ws: string) => asMember(t, role, ws, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from classification.assessments`)).then((r) => r.rows[0]?.n ?? -1);
      expect(await visible(A, "owner", B.workspaceId)).toBe(0);
      expect(await visible(A, "guest", A.workspaceId)).toBe(0);
      expect(await visible(A, "analyst", A.workspaceId)).toBeGreaterThan(0);
      expect(await asWorker(A, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from classification.assessments where workspace_id = ${B.workspaceId}::uuid`)).then((r) => r.rows[0]?.n)).toBe(0);
    });

    it("16. A's worker can't insert for B, nor reference B's interaction or text version", async () => {
      expect(await sqlState(machine(A, { workspaceId: B.workspaceId, interaction: B.interaction, version: B.version, dimension: "intent", keys: ["praise"], ai: { prompt_version: "into-b" } }))).toMatchObject({ code: "42501" });
      expect(await sqlState(machine(A, { interaction: B.interaction, version: B.version, dimension: "intent", keys: ["praise"], ai: { prompt_version: "ref-b" } }))).toMatchObject({ code: "23503" });
      expect(await sqlState(signal(A, { kind: "text_empty", interaction: B.interaction, version: B.version }))).toMatchObject({ code: "23503" });
    });
  });

  describe("signals", () => {
    it("17. facts of the closed kinds, with source spans; flags carry nothing", async () => {
      const { revision, term } = await revisionOf(A, 1);
      await signal(A, { kind: "watch_term_match", revision, term, matcher: "watch-term-matcher.v1", starts: [12], ends: [18] });
      await signal(A, { kind: "link_present", starts: [0, 20], ends: [10, 32] });
      for (const kind of ["text_empty", "text_emoji_only", "author_own_brand"]) await signal(A, { kind });
      expect([...SIGNAL_KINDS].sort()).toEqual(["author_own_brand", "link_present", "text_emoji_only", "text_empty", "watch_term_match"]);
      expect(await sqlState(signal(A, { kind: "category_assignment", version: A.edited }))).toMatchObject({ code: "23514" });
      expect(await sqlState(signal(A, { kind: "watch_term_match", version: A.edited, starts: [0], ends: [1] }))).toMatchObject({ code: "23514", constraint: "signals_shape" });
      expect(await sqlState(signal(A, { kind: "text_empty", version: A.edited, starts: [0], ends: [1] }))).toMatchObject({ code: "23514" });
      expect(await sqlState(signal(A, { kind: "link_present", version: A.edited, starts: [5], ends: [5] }))).toMatchObject({ code: "23514" });
      expect(await sqlState(signal(A, { kind: "link_present", version: A.edited, starts: [0], ends: [40000] }))).toMatchObject({ code: "23514" });
      expect(await sqlState(signal(A, { kind: "link_present", version: A.edited, starts: Array.from({ length: 21 }, (_, i) => i * 2), ends: Array.from({ length: 21 }, (_, i) => i * 2 + 1) }))).toMatchObject({ code: "23514" });
      expect(await sqlState(signal(A, { kind: "watch_term_match", version: A.edited, revision, term, matcher: "watch-term-matcher.v0", starts: [0], ends: [1] }))).toMatchObject({ code: "23514" });
    });

    it("18. one signal per (text version, kind, versions, rule identity); a new revision adds history", async () => {
      const first = await revisionOf(A, 2);
      await signal(A, { kind: "text_emoji_only", version: A.edited });
      expect(await sqlState(signal(A, { kind: "text_emoji_only", version: A.edited }))).toMatchObject({ code: "23505", constraint: "signals_once" });
      await signal(A, { kind: "watch_term_match", version: A.edited, revision: first.revision, term: first.term, matcher: "watch-term-matcher.v1", starts: [0], ends: [6] });
      expect(await sqlState(signal(A, { kind: "watch_term_match", version: A.edited, revision: first.revision, term: first.term, matcher: "watch-term-matcher.v1", starts: [0], ends: [6] }))).toMatchObject({ code: "23505" });
      const second = await revisionOf(A, 3);
      await signal(A, { kind: "watch_term_match", version: A.edited, revision: second.revision, term: second.term, matcher: "watch-term-matcher.v1", starts: [0], ends: [6] });
    });

    it("19. a watch-term signal can't name another workspace's term; signals are append-only", async () => {
      const foreign = await revisionOf(B, 1);
      expect(await sqlState(signal(A, { kind: "watch_term_match", version: A.otherVersion, interaction: A.otherInteraction, revision: foreign.revision, term: foreign.term, matcher: "watch-term-matcher.v1", starts: [0], ends: [4] }))).toMatchObject({ code: "23503" });
      const id = await signal(A, { kind: "author_own_brand", version: A.otherVersion, interaction: A.otherInteraction });
      expect(await sqlState(asWorker(A, (tx) => tx.execute(sql`update classification.signals set truncated = true where id = ${id}::uuid`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(asWorker(A, (tx) => tx.execute(sql`delete from classification.signals where id = ${id}::uuid`)))).toMatchObject({ code: "42501" });
    });
  });

  describe("watch terms", () => {
    it("20. bounded phrases (no #/@, non-blank, ≤ 32 variants, distinct); revisions unique per workspace", async () => {
      await revisionOf(A, 10, ["precio", "precios", "precio caro"], ["no es caro"]);
      for (const [phrases, n] of [[["#precio"], 11], [["@precio"], 12], [["   "], 13], [["x".repeat(257)], 14], [Array.from({ length: 33 }, (_, i) => `w${String(i)}`), 15], [["a", "a"], 16], [[], 17]] as const) {
        await expect(revisionOf(A, n, phrases)).rejects.toMatchObject({ code: "23514" });
      }
      await expect(revisionOf(A, 10)).rejects.toMatchObject({ code: "23505" });
    });

    it("21. no runtime role may write watch terms yet; members of the workspace read them, guests don't", async () => {
      expect(await sqlState(asWorker(A, (tx) => tx.execute(sql`insert into classification.watch_term_revisions (id, organization_id, workspace_id, revision, created_by_user_id, created_at)
        values (${randomUUID()}::uuid, ${A.organizationId}::uuid, ${A.workspaceId}::uuid, 99, ${A.users.owner}::uuid, now())`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(asMember(A, "owner", A.workspaceId, (tx) => tx.execute(sql`insert into classification.watch_term_revisions (id, organization_id, workspace_id, revision, created_by_user_id, created_at)
        values (${randomUUID()}::uuid, ${A.organizationId}::uuid, ${A.workspaceId}::uuid, 98, ${A.users.owner}::uuid, now())`)))).toMatchObject({ code: "42501" });
      const read = (role: Role) => asMember(A, role, A.workspaceId, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from classification.watch_terms`)).then((r) => r.rows[0]?.n ?? -1);
      expect(await read("owner")).toBeGreaterThan(0);
      expect(await read("guest")).toBe(0);
      expect(await asMember(A, "owner", B.workspaceId, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from classification.watch_terms`)).then((r) => r.rows[0]?.n)).toBe(0);
    });
  });

  describe("understanding requests (idempotency anchor)", () => {
    const request = (t: Tenant, version: string, pipeline: string, state = "PENDING", interaction = t.interaction) => asWorker(t, (tx) => tx.execute<{ id: string }>(sql`
      insert into classification.understanding_requests (id, organization_id, workspace_id, interaction_id, source_text_version_id, pipeline_version, arrival, state, created_at, updated_at)
      values (${randomUUID()}::uuid, ${t.organizationId}::uuid, ${t.workspaceId}::uuid, ${interaction}::uuid, ${version}::uuid, ${pipeline}, 'realtime', ${state}, now(), now()) returning id`)).then((r) => r.rows[0]?.id ?? "");
    const move = (t: Tenant, id: string, state: string, completed: boolean) => asWorker(t, (tx) => tx.execute(sql`
      update classification.understanding_requests set state = ${state}, completed_at = ${completed ? sql`now()` : sql`null`}, updated_at = now() where id = ${id}::uuid`));

    it("22. one request per (text version, pipeline version): a duplicate is refused, a new pipeline or an edit is a new request", async () => {
      await request(A, A.version, "pipeline.v1");
      expect(await sqlState(request(A, A.version, "pipeline.v1"))).toMatchObject({ code: "23505", constraint: "understanding_requests_once" });
      await request(A, A.version, "pipeline.v2-shadow");
      await request(A, A.edited, "pipeline.v1");
      // Identical text on another interaction is a separate analysis (never deduplicated by text).
      await request(A, A.otherVersion, "pipeline.v1", "PENDING", A.otherInteraction);
    });

    it("23. requests start PENDING; a terminal request is final and nothing returns to PENDING", async () => {
      expect(await sqlState(request(A, A.version, "pipeline.v3", "COMPLETED"))).toMatchObject({ code: "42501" });
      const id = await request(A, A.version, "pipeline.v4");
      await move(A, id, "DETERMINISTIC_DONE", false);
      expect(await sqlState(move(A, id, "PENDING", false))).toMatchObject({ code: "23514" });
      expect(await sqlState(move(A, id, "COMPLETED", false))).toMatchObject({ code: "23514", constraint: "understanding_requests_completion" });
      await move(A, id, "DETERMINISTIC_ONLY", true);
      expect(await sqlState(move(A, id, "AI_PENDING", false))).toMatchObject({ code: "23514" });
      expect(await sqlState(asWorker(A, (tx) => tx.execute(sql`update classification.understanding_requests set pipeline_version = 'x' where id = ${id}::uuid`)))).toMatchObject({ code: "42501" });
    });

    it("24. requests are the worker's only: members can't read them; A's worker can't reference B's version", async () => {
      expect(await sqlState(asMember(A, "owner", A.workspaceId, (tx) => tx.execute(sql`select count(*) from classification.understanding_requests`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(request(A, B.version, "pipeline.v1", "PENDING", B.interaction))).toMatchObject({ code: "23503" });
    });
  });

  describe("no canonical mutation", () => {
    it("25. classification writes never change interactions, text versions or content", async () => {
      const before = await canonicalDigest(A);
      await machine(A, { dimension: "intent", keys: ["purchase_question"], ai: { prompt_version: "canonical" } });
      await human(A, "owner", { dimension: "intent", keys: ["price_objection"] });
      await signal(A, { kind: "link_present", version: A.otherVersion, interaction: A.otherInteraction, starts: [1], ends: [3], truncated: true });
      expect(await canonicalDigest(A)).toBe(before);
    });
  });
}
