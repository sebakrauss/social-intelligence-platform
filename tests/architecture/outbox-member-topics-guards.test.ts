/**
 * Step H6-E1 — static guards around migration 0021 (member outbox topic provenance):
 *   - the member-topic inventory is DERIVED from the web producers: every web-reachable outbox append goes through one of
 *     two message builders, whose topics are exactly MEMBER_TOPICS;
 *   - the internal inventory is CLOSED over the registry: every tenant task that is not a member topic is named by 0021,
 *     so a new internal topic registered without a policy fails here;
 *   - 0021 is exactly one RESTRICTIVE INSERT policy for `authenticated`, no DML, no other object; no migration ever names
 *     a member topic (no definer produces or admits one by name);
 *   - `ingestion.confirm_interaction` is INTERNAL_ONLY: its one producer is the job runtime's request, member SQL is
 *     never its authority, and the schema manifest pins the policy.
 */
import { describe, expect, it } from "vitest";
import { RESTRICTIVE_POLICIES, TABLE_CLASSIFICATION } from "@/db/schema/classification";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { readMigrations } from "@/tools/db/migrations";
import { INTERNAL_TOPICS, INTERNAL_TOPICS_POLICY, MEMBER_TOPICS } from "../db/suites/outbox-member-topics";
import { codeOf, sourceFiles } from "../support/source-scan";

const MIGRATION = "0021_outbox_internal_topics.sql";
const CONFIRM = "ingestion.confirm_interaction";
const PRODUCTION = ["app", "ui", "server", "domain", "modules", "platform", "integrations", "jobs", "db", "tools"];
/** SQL without comments, lowercased, whitespace collapsed. */
const normalize = (text: string): string => text.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").toLowerCase().trim();
const statements = (sql: string): string[] => normalize(sql).split(";").map((s) => s.trim()).filter((s) => s !== "");
const topicsOf = (list: string): string[] => [...list.matchAll(/'([a-z_]+(?:\.[a-z_]+)+)'/g)].map((m) => m[1] ?? "").sort();
const RESTRICTIVE_MEMBER_POLICY = /create policy (\w+) on system\.outbox as restrictive for insert to ([a-z_, ]+) with check \(topic not in \(([^)]*)\)\)/g;
const migrations = readMigrations();
const sorted = <T extends string>(values: readonly T[]): T[] => [...values].sort();

describe("H6-E1: the member-topic inventory is derived from the web producers", () => {
  it("every production outbox append is one of five call sites; the web-reachable ones use exactly the two member builders", () => {
    const appenders = sourceFiles(PRODUCTION).filter((file) => /outbox\.append\(/.test(codeOf(file)));
    expect(appenders.sort()).toEqual([
      "modules/connections/application/capability-reevaluation.ts", // web command (requestCapabilityReevaluation)
      "modules/connections/application/moves.ts", // job runtime (the activation step of a Move)
      "server/commands/connected-accounts.ts", // web commands (link, save_selection)
      "server/commands/connections.ts", // web command (completed exchange)
      "server/pipeline/pipeline.ts", // the pipeline's pass-through wrapper (records what a command appends)
    ]);
    for (const file of ["server/commands/connected-accounts.ts", "server/commands/connections.ts", "modules/connections/application/capability-reevaluation.ts"]) {
      const code = codeOf(file);
      const calls = [...code.matchAll(/outbox\.append\(\s*(\w+)\(/g)].map((m) => m[1]);
      expect(calls.length, file).toBe([...code.matchAll(/outbox\.append\(/g)].length);
      for (const builder of calls) expect(["discoveryRequest", "capabilityEvaluationRequest"], file).toContain(builder);
    }
    expect(codeOf("server/pipeline/pipeline.ts")).toMatch(/return base\.outbox\.append\(message\);/);
    // The other appends (appendOutboxOnce) are the job runtime's: capability requests, ingestion events, slices, confirmations.
    const once = sourceFiles(PRODUCTION).filter((file) => /appendOutboxOnce\(/.test(codeOf(file)) && file !== "platform/db/outbox.ts");
    expect(once.sort()).toEqual(["modules/ingestion/persistence/reconciliation-store.ts", "modules/ingestion/persistence/store.ts", "server/persistence/connections.ts"]);
  });

  it("the two builders' topics are exactly MEMBER_TOPICS, and both are registered tenant tasks", () => {
    expect(codeOf("modules/connections/application/discovery.ts")).toMatch(/export const DISCOVER_ASSETS_TASK = "connections\.discover_assets";/);
    expect(codeOf("modules/connections/domain/model.ts")).toMatch(/export const CAPABILITY_EVALUATION_TOPIC = "capability\.evaluate_account";/);
    expect(codeOf("modules/connections/application/discovery.ts")).toMatch(/topic: DISCOVER_ASSETS_TASK,/);
    expect(codeOf("modules/connections/application/capability-request.ts")).toMatch(/topic: CAPABILITY_EVALUATION_TOPIC,/);
    expect(sorted(MEMBER_TOPICS)).toEqual(["capability.evaluate_account", "connections.discover_assets"]);
    for (const topic of MEMBER_TOPICS) expect(PRODUCTION_TASKS.tenant(topic)?.scope, topic).toBe("workspace");
  });
});

describe("H6-E1: the internal inventory is closed over the registry", () => {
  it("every tenant task that is not a member topic is an internal topic, and vice versa; the confirmation is one of them", () => {
    const tenantTasks = PRODUCTION_TASKS.tasks.filter((task) => task.scope === "workspace").map((task) => task.name);
    expect(sorted(tenantTasks.filter((name) => !(MEMBER_TOPICS as readonly string[]).includes(name)))).toEqual(sorted(INTERNAL_TOPICS));
    expect(INTERNAL_TOPICS).toContain(CONFIRM);
    expect(new Set([...MEMBER_TOPICS, ...INTERNAL_TOPICS]).size).toBe(MEMBER_TOPICS.length + INTERNAL_TOPICS.length);
  });

  it("system-scope tasks are never outbox topics: the relay resolves a row's topic as a TENANT task only", () => {
    const relay = codeOf("platform/outbox/delivery.ts");
    expect(relay).toMatch(/const definition = deps\.registry\.tenant\(row\.topic\);\s+if \(definition === undefined\) return fail\("unknown_task"\);/);
    for (const task of PRODUCTION_TASKS.tasks.filter((t) => t.scope === "system")) expect(PRODUCTION_TASKS.tenant(task.name), task.name).toBeUndefined();
  });
});

describe("H6-E1: migration 0021", () => {
  const migration = migrations.find((m) => m.name === MIGRATION);

  it("is the latest migration and is exactly one RESTRICTIVE INSERT policy for authenticated — no DML, no other object", () => {
    expect(migrations.at(-1)?.name).toBe(MIGRATION);
    if (migration === undefined) throw new Error("0021 missing");
    const body = statements(migration.sql);
    expect(body).toHaveLength(3);
    expect(body[0]).toBe("set role app_owner");
    expect(body[2]).toBe("reset role");
    const policy = /^create policy (\w+) on system\.outbox as restrictive for insert to authenticated with check \(topic not in \(([^)]*)\)\)$/.exec(body[1] ?? "");
    expect(policy?.[1]).toBe(INTERNAL_TOPICS_POLICY);
    expect(topicsOf(policy?.[2] ?? "")).toEqual(sorted(INTERNAL_TOPICS));
    // No DML and no other object: every statement is one of the three above (a policy governs future INSERTs only, so
    // historical rows are untouched by construction).
    for (const statement of body) expect(statement).not.toMatch(/^(update|delete|insert|alter|drop|grant|revoke|truncate|create (table|function|trigger|index|schema))\b/);
  });

  it("no migration names a member topic: no definer produces or admits one, and the member list lives in source only", () => {
    for (const m of migrations) for (const topic of MEMBER_TOPICS) expect(m.sql, `${m.name} names ${topic}`).not.toContain(topic);
  });

  it("every internal topic is removed from the member's direct append by at least one restrictive policy; 0021 alone is the whole inventory", () => {
    const policies = new Map<string, { migration: string; roles: string[]; topics: string[] }>();
    for (const m of migrations) {
      for (const match of normalize(m.sql).matchAll(RESTRICTIVE_MEMBER_POLICY)) {
        const roles = (match[2] ?? "").split(",").map((r) => r.trim()).sort();
        if (roles.includes("authenticated")) policies.set(match[1] ?? "", { migration: m.name, roles, topics: topicsOf(match[3] ?? "") });
      }
    }
    expect([...policies.keys()].sort()).toEqual(["no_direct_internal_topics", "no_direct_move_routing", "no_direct_reconciliation_routing"]);
    expect(policies.get("no_direct_move_routing")?.migration).toBe("0010_connected_account_moves.sql");
    expect(policies.get("no_direct_reconciliation_routing")?.migration).toBe("0019_reconciliation_request.sql");
    expect(policies.get(INTERNAL_TOPICS_POLICY)).toEqual({ migration: MIGRATION, roles: ["authenticated"], topics: sorted(INTERNAL_TOPICS) });
    const union = new Set([...policies.values()].flatMap((p) => p.topics));
    for (const topic of INTERNAL_TOPICS) expect(union.has(topic), topic).toBe(true);
    for (const topic of MEMBER_TOPICS) expect(union.has(topic), topic).toBe(false);
    // Only 0021 may ever carry this policy name (forward-only: no later ALTER/DROP of it).
    for (const m of migrations) if (m.name !== MIGRATION) expect(m.sql, m.name).not.toContain(INTERNAL_TOPICS_POLICY);
  });

  it("the schema manifest pins the policy on system.outbox and as RESTRICTIVE", () => {
    expect(TABLE_CLASSIFICATION["system.outbox"]?.policies).toContain(`${INTERNAL_TOPICS_POLICY} INSERT authenticated`);
    expect(RESTRICTIVE_POLICIES).toContain(`system.outbox ${INTERNAL_TOPICS_POLICY}`);
  });
});

describe("H6-E1: ingestion.confirm_interaction is INTERNAL_ONLY", () => {
  it("its topic string lives in the domain constant, the job, the plane definition, the registry and 0021 — nowhere web-reachable", () => {
    const literal = sourceFiles(PRODUCTION).filter((file) => codeOf(file).includes(CONFIRM));
    expect(literal.sort()).toEqual(["jobs/confirm-interaction.ts", "jobs/registry.ts", "jobs/trigger/integration/ingestion.ts", "modules/ingestion/domain/confirmation.ts"]);
    expect(migrations.filter((m) => m.sql.includes(CONFIRM)).map((m) => m.name)).toEqual([MIGRATION]);
    for (const file of sourceFiles(["app", "ui", "server"])) expect(codeOf(file), file).not.toMatch(/confirm_interaction|CONFIRM_INTERACTION_TOPIC|enqueueConfirmation|requestInteractionConfirmation/);
  });

  it("its one producer is the reconciliation store's enqueueConfirmation, called only by the job-scope request", () => {
    const producers = sourceFiles(PRODUCTION).filter((file) => /topic: CONFIRM_INTERACTION_TOPIC/.test(codeOf(file)));
    expect(producers).toEqual(["modules/ingestion/persistence/reconciliation-store.ts"]);
    expect(codeOf("modules/ingestion/persistence/reconciliation-store.ts")).toMatch(/topic: CONFIRM_INTERACTION_TOPIC,\s+organizationId: target\.organizationId,\s+workspaceId: target\.workspaceId,\s+subjectIds: \{ connected_account_id: target\.connectedAccountId, interaction_id: target\.interactionId \},/);
    const callers = sourceFiles(PRODUCTION).filter((file) => /\.enqueueConfirmation\(/.test(codeOf(file)));
    expect(callers).toEqual(["modules/ingestion/application/confirm-interaction.ts"]);
    // The task reads exactly those two subjects (H6-E), so the policy protects the only shape the runtime accepts.
    expect(PRODUCTION_TASKS.tenant(CONFIRM)?.subjects).toEqual(["connected_account_id", "interaction_id"]);
  });
});
