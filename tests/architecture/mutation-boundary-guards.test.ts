/**
 * Step 7B-1 — static guards around the Platform Mutation Executor (TA §6.3 rule 3; §26; CLAUDE.md §9):
 *   - the provider MUTATION port is obtained in exactly one production file, the integration plane's composition
 *     (jobs/mutations.ts), and only the simulator implements it: no Meta or TikTok mutation adapter exists;
 *   - the web never reaches the executor: app/, ui/ and server/ (minus the job-side composition file) import no
 *     executor internals, and the job-side composition is imported by jobs/mutations.ts only;
 *   - the executor requests ONE kind (public reply): no hide / unhide / delete / block / private reply call exists;
 *   - the task is registered on the integration plane, lane 1, single attempt, serial per account; its topic is a
 *     member topic (the web appends it) and its Trigger file lives in the integration directory;
 *   - the productive Meta catalog still publishes no `reply_public`: real Meta replies stay unavailable (7B-1 scope);
 *   - the command declares reply.public + Standard mode and validates exactly three fields; 0027 lets a member insert
 *     PENDING only and grants no member UPDATE on intents.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOGS, PLATFORM_CATALOG, SIMULATOR_CATALOG } from "@/modules/capability";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { RELEASE_PLANES } from "@/tools/trigger/release-pair";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../support/source-scan";

const PRODUCTION = ["app", "ui", "server", "domain", "modules", "platform", "integrations", "ai", "mutations", "jobs", "db", "tools"];
const EXECUTION_COMPOSITION = "server/persistence/mutation-execution.ts";
const importsOf = (file: string): string[] => [...codeOf(file).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("7B-1: the mutation port has one composition root and one implementation", () => {
  it("only jobs/mutations.ts obtains a provider mutation implementation; only the simulator implements the port", () => {
    const users = sourceFiles(PRODUCTION).filter((file) => importsOf(file).some((specifier) => /providers\/(?!contract\/)[^/]+\/mutation-port/.test(specifier)));
    expect(users).toEqual(["jobs/mutations.ts"]);
    const implementations = sourceFiles(["integrations/providers"]).filter((file) => !file.startsWith("integrations/providers/contract/") && /mutation/.test(file));
    expect(implementations).toEqual(["integrations/providers/simulator/mutation-port.ts"]);
    expect(sourceFiles(["integrations/providers/meta", "integrations/providers/tiktok"]).filter((file) => /replyPublicly|replyPrivately|\/comments["']|\/replies["']/.test(strip(codeOf(file))))).toEqual([]);
  });

  it("the web never imports executor internals; the job-side composition is imported by jobs/mutations.ts only", () => {
    for (const file of sourceFiles(["app", "ui", "server"]).filter((f) => f !== EXECUTION_COMPOSITION)) {
      for (const specifier of importsOf(file)) expect(specifier, file).not.toMatch(/^@\/mutations\/(executor|ports|domain)|mutation-execution/);
    }
    for (const file of sourceFiles(["app", "ui"])) {
      for (const specifier of importsOf(file)) expect(specifier, file).not.toMatch(/^@\/mutations\b/);
    }
    const importers = sourceFiles(PRODUCTION).filter((file) => importsOf(file).some((specifier) => /persistence\/mutation-execution/.test(specifier)));
    expect(importers).toEqual(["jobs/mutations.ts"]);
    expect(importsOf("server/persistence/mutations.ts").filter((s) => s.startsWith("@/mutations/"))).toEqual(["@/mutations/persistence", "@/mutations/request"]);
  });

  it("the executor invokes exactly one port method, replyPublicly: no hide, unhide, delete, block or private reply", () => {
    const executor = sourceFiles(["mutations"]).map((file) => strip(codeOf(file))).join("\n");
    expect(executor.match(/\.replyPublicly\(/g)).toHaveLength(1);
    // A negative lookup never becomes a failure: reconciliation settles ONLY to CONFIRMED.
    const reconcile = strip(codeOf("mutations/executor/reconcile.ts"));
    expect([...reconcile.matchAll(/settle\(stores, [a-z]+, "([A-Z_]+)"/g)].map((m) => m[1])).toEqual(["OUTCOME_UNKNOWN", "CONFIRMED"]);
    expect(reconcile).not.toMatch(/"FAILED"/);
    expect(executor).not.toMatch(/\.(replyPrivately|hide|unhide|delete|block)\(/);
    expect(executor).not.toMatch(/AutomationMutationRequest|BulkMutationRequest|automation_decision/);
  });
});

describe("7B-1: the task, its topic and its release", () => {
  it("mutations.execute_intent is an integration-plane tenant task on lane 1, single attempt, serial per account, with exactly two subjects", () => {
    const task = PRODUCTION_TASKS.tenant("mutations.execute_intent");
    expect(task).toMatchObject({ scope: "workspace", executionPlane: "integration", lane: 1, retry: { maxAttempts: 1 }, concurrency: { by: "subject", subject: "connected_account_id" } });
    expect([...(task?.subjects ?? [])].sort()).toEqual(["connected_account_id", "mutation_intent_id"]);
    expect(PRODUCTION_TASKS.tasks.filter((t) => t.name.startsWith("mutations."))).toHaveLength(1);
    expect(readdirSync(path.join(REPOSITORY_ROOT, "jobs/trigger/integration"))).toContain("mutations.ts");
    expect(codeOf("jobs/trigger/integration/mutations.ts")).toMatch(/defineTenantStepTask\(PRODUCTION_TASKS, "mutations\.execute_intent"/);
    expect(RELEASE_PLANES.find((plane) => plane.plane === "integration")?.expectedTasks).toBe(8);
    // Members append the topic (the web request); 0021's internal inventory does not name it.
    expect(codeOf("db/migrations/0021_outbox_internal_topics.sql")).not.toMatch(/mutations\.execute_intent/);
  });

  it("the productive Meta catalog publishes no reply_public; only the simulator does", () => {
    expect(JSON.stringify(PLATFORM_CATALOG)).not.toMatch(/reply_public/);
    expect(JSON.stringify(SIMULATOR_CATALOG)).toMatch(/reply_public/);
    expect(Object.keys(CATALOGS).sort()).toEqual(["platform", "simulator"]);
  });
});

describe("7B-1: the request command and 0027", () => {
  it("the command declares reply.public and Standard mode, validates exactly three fields, appends only the executor dispatch", () => {
    const command = codeOf("server/commands/mutations.ts");
    expect(command).toMatch(/permission: "reply\.public",/);
    expect(command).toMatch(/requiresStandardMode: true,/);
    expect(command).toMatch(/validate: object\(\{ targetInteractionId: uuid, text: text\(\{ min: 1, max: REPLY_TEXT_MAX_CHARS \}\), idempotencyKey: text\(\{ min: 8, max: 128, pattern: IDEMPOTENCY_KEY \}\) \}\),/);
    expect([...command.matchAll(/outbox\.append\(/g)]).toHaveLength(1);
    expect(command).toMatch(/tx\.outbox\.append\(executeIntentDispatch\(/);
    expect(command).not.toMatch(/tx\.connections|tx\.audit|sql`|replyPublicly|mutation-port/);
  });

  it("0027: members insert PENDING only, as themselves, with a replying role; no member UPDATE grant; the worker's UPDATE is column-bound; every table forces RLS", () => {
    const sql = codeOf("db/migrations/0027_mutation_intents.sql").toLowerCase().replace(/--[^\n]*/g, " ").replace(/\s+/g, " ");
    expect(sql).toMatch(/create policy member_request on mutations\.mutation_intents for insert to authenticated with check \(workspace_id = \(select app\.current_workspace\(\)\) and status = 'pending' and request_type = 'human' and initiator_user_id = \(select auth\.uid\(\)\) and app\.my_workspace_role\(workspace_id\) in \('owner', 'admin', 'manager', 'responder'\) and exists \(select 1 from tenancy\.workspaces w where w\.id = mutation_intents\.workspace_id and w\.mode = 'standard'\)\)/);
    // The Monitor-only backstop (TA §26.6 point 4): a definer trigger on INSERT and on the transition INTO EXECUTING,
    // the mode locked FOR SHARE; the owner's lock policy can never change a workspace row.
    expect(sql).toMatch(/create trigger intent_mode_guard before insert or update of status on mutations\.mutation_intents for each row execute function mutations\.intent_mode_guard\(\)/);
    expect(sql).toMatch(/if new\.status = 'executing' and old\.status is distinct from 'executing' then select w\.mode into v_mode from tenancy\.workspaces w where w\.id = new\.workspace_id for share;/);
    expect(sql).toMatch(/create policy owner_share_lock on tenancy\.workspaces for update to app_owner using \(true\) with check \(false\)/);
    // Authority coherence and one link per provider reply identity.
    expect(sql).toMatch(/constraint mutation_intents_target_owned foreign key \(workspace_id, target_interaction_id, connected_account_id\) references interactions\.interactions \(workspace_id, id, connected_account_id\)/);
    expect(sql).toMatch(/constraint outbound_replies_intent_coherent foreign key \(workspace_id, intent_id, parent_interaction_id, connected_account_id\) references mutations\.mutation_intents \(workspace_id, id, target_interaction_id, connected_account_id\)/);
    expect(sql).toMatch(/create unique index outbound_replies_provider_identity on mutations\.outbound_replies \(workspace_id, platform, provider_reply_id\) where provider_reply_id is not null/);
    expect(sql).not.toMatch(/grant [^;]*update[^;]* on mutations\.[a-z_]+ to authenticated/);
    expect(sql).toMatch(/grant update \(status, attempt, run_reference, outcome_code, updated_at\) on mutations\.mutation_intents to app_worker/);
    expect(sql).toMatch(/grant update \(provider_reply_id, confirmed_at\) on mutations\.outbound_replies to app_worker/);
    for (const table of ["mutation_intents", "mutation_intent_history", "outbound_replies"]) {
      expect(sql, table).toMatch(new RegExp(`alter table mutations\\.${table} force row level security`));
    }
    // No DELETE anywhere, no role or session statement, no automation request type.
    expect(sql).not.toMatch(/grant [^;]*delete|'automation'|'bulk'/);
  });
});
