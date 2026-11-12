/**
 * Step 7B-1 — static guards around the Platform Mutation Executor (TA §6.3 rule 3; §26; CLAUDE.md §9):
 *   - the provider MUTATION port is obtained in exactly one production file, the integration plane's composition
 *     (jobs/mutations.ts); two adapters implement it — the simulator, and Meta's Instagram-only public reply (7B-11) —
 *     and Step 7B-13A composes the Meta port for exactly provider "meta" + platform "instagram", with its own default
 *     write transport (no injection, no second transport); Facebook and TikTok have no mutation port;
 *   - the web never reaches the executor: app/, ui/ and server/ (minus the job-side composition file) import no
 *     executor internals, and the job-side composition is imported by jobs/mutations.ts only;
 *   - the executor requests ONE kind (public reply): no hide / unhide / delete / block / private reply call exists;
 *   - the task is registered on the integration plane, lane 1, single attempt, serial per account; its topic is a
 *     member topic (the web appends it) and its Trigger file lives in the integration directory;
 *   - the productive Meta catalog still publishes no `reply_public`: real Meta replies stay unavailable (7B-1 scope);
 *   - the command declares reply.public + Standard mode and validates exactly three fields (plus, since 7B-14G1, one
 *     optional validated UUID — a validation authorization reference); 0027 lets a member insert
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
  it("only jobs/mutations.ts obtains a provider mutation implementation; the Meta port is composed there for Instagram only", () => {
    const users = sourceFiles(PRODUCTION).filter((file) => importsOf(file).some((specifier) => /providers\/(?!contract\/)[^/]+\/mutation-port/.test(specifier)));
    expect(users).toEqual(["jobs/mutations.ts"]);
    // 7B-11: two implementations (the simulator, and Meta's Instagram-only public reply).
    const implementations = sourceFiles(["integrations/providers"]).filter((file) => !file.startsWith("integrations/providers/contract/") && /mutation/.test(file));
    expect(implementations).toEqual(["integrations/providers/meta/mutation-port.ts", "integrations/providers/simulator/mutation-port.ts"]);
    // Step 7B-13A: jobs/mutations.ts is the Meta port's ONLY production importer; it builds the port ONCE, with no
    // options (the port's own Graph write transport — never an injected or second transport), never under the
    // staging stub, and serves it for exactly provider "meta" + platform "instagram". It imports nothing else of Meta.
    expect(sourceFiles(PRODUCTION).filter((file) => importsOf(file).some((specifier) => /providers\/meta\/mutation-port/.test(specifier)))).toEqual(["jobs/mutations.ts"]);
    expect(importsOf("jobs/mutations.ts").filter((specifier) => /providers\/meta\//.test(specifier))).toEqual(["@/integrations/providers/meta/mutation-port"]);
    const composition = strip(codeOf("jobs/mutations.ts"));
    expect(composition.match(/createMetaMutationPort\(/g)).toHaveLength(1);
    expect(composition).toMatch(/providerComposition\(environment\)\.kind === "staging_stub" \? undefined : createMetaMutationPort\(\);/);
    expect(composition).toMatch(/if \(provider === "meta" && platform === "instagram"\) return ports\.instagram;/);
    expect(composition.match(/ports\.instagram/g)).toHaveLength(1);
    expect(composition).not.toMatch(/facebook|tiktok|graph-transport|MetaGraph|transport:/i);
    // F2 (7B-11 review): reads and the write are separate objects. The read port is typed on, and builds, the READ
    // transport only; the integration composition never names a write (the AST guard in provider-guards covers aliases).
    const readPort = strip(codeOf("integrations/providers/meta/read-port.ts"));
    expect(readPort).toMatch(/readonly transport\?: MetaGraphTransport;/);
    expect(readPort).toMatch(/const transport = options\.transport \?\? createMetaGraphTransport\(\);/);
    expect(readPort).not.toMatch(/MetaGraphWriteTransport|createMetaGraphWriteTransport|createInstagramCommentReply/);
    expect(strip(codeOf("jobs/connections.ts"))).not.toMatch(/MetaGraphWriteTransport|createMetaGraphWriteTransport|createInstagramCommentReply|providers\/meta\/mutation-port/);
    // The Meta write edge lives in exactly two files: the port (the call) and the Graph transport (the request).
    expect(sourceFiles(["integrations/providers/meta", "integrations/providers/tiktok"]).filter((file) => /replyPublicly|replyPrivately|\/comments["']|"replies"/.test(strip(codeOf(file))))).toEqual(["integrations/providers/meta/graph-transport.ts", "integrations/providers/meta/mutation-port.ts"]);
  });

  it("the web never imports executor internals; the job-side composition is imported by jobs/mutations.ts only", () => {
    for (const file of sourceFiles(["app", "ui", "server"]).filter((f) => f !== EXECUTION_COMPOSITION)) {
      for (const specifier of importsOf(file)) expect(specifier, file).not.toMatch(/^@\/mutations\/(executor|ports|domain)|mutation-execution/);
    }
    for (const file of sourceFiles(["app", "ui"])) {
      for (const specifier of importsOf(file)) expect(specifier, file).not.toMatch(/^@\/mutations\b/);
    }
    const importers = sourceFiles(PRODUCTION).filter((file) => importsOf(file).some((specifier) => /persistence\/mutation-execution/.test(specifier)));
    // Step 7B-14I2: + the operator reconciliation module (it reads the credential authority and the executor's stores to
    // run the existing reconciler) — and it never reaches a mutation port, the executor composition or a write transport.
    expect(importers).toEqual(["jobs/integration-mutation-reconcile.ts", "jobs/mutations.ts"]);
    const reconcile = importsOf("jobs/integration-mutation-reconcile.ts");
    expect(reconcile.filter((specifier) => /mutation-port|graph-transport|read-port|@\/jobs\/mutations|\.\/mutations|registry/.test(specifier))).toEqual([]);
    expect(strip(codeOf("jobs/integration-mutation-reconcile.ts"))).not.toMatch(/executeIntent\(|replyPublicly|createMetaMutationPort|composeMutationProviders|createInstagramCommentReply/);
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
    // 8 since 7B-1 (the executor); 9 since 7B-14C1 (the read-only Instagram reply preflight diagnostic — no mutation task);
    // 10 since 7B-14I2 (the operator reconciliation task — reads only, never a send, absent from the registry).
    expect(RELEASE_PLANES.find((plane) => plane.plane === "integration")?.expectedTasks).toBe(10);
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
  it("the command declares reply.public and Standard mode, validates exactly three fields plus one OPTIONAL validated UUID (7B-14G1) and one OPTIONAL `true` flag (7B-14I2), appends only the executor dispatch", () => {
    const command = codeOf("server/commands/mutations.ts");
    expect(command).toMatch(/permission: "reply\.public",/);
    expect(command).toMatch(/requiresStandardMode: true,/);
    // Step 7B-14G1: the fourth field is optional and a validated UUID — a reference, never a permission.
    expect(command).toMatch(/validate: object\(\{ targetInteractionId: uuid, text: text\(\{ min: 1, max: REPLY_TEXT_MAX_CHARS \}\), idempotencyKey: text\(\{ min: 8, max: 128, pattern: IDEMPOTENCY_KEY \}\), validationAuthorizationId: optional\(uuid\), validation: optional\(flag\) \}\),/);
    // Step 7B-14I2: the flag accepts exactly `true` and only asks the request service to resolve on the server.
    expect(command).toMatch(/const flag = parsed\(\(value\) => \(value === true \? true : undefined\)\);/);
    expect(command).toMatch(/\.\.\.\(input\.validation === true \? \{ resolveValidationAuthorization: true \} : \{\}\),/);
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

describe("7B-14F1: the one-time validation authorization foundation (0028) is persistent and inert", () => {
  const sql = codeOf("db/migrations/0028_mutation_validation_authorizations.sql").toLowerCase().replace(/--[^\n]*/g, " ").replace(/\s+/g, " ");

  it("0028: read-only grants, forced RLS, single use by unique keys, scope by composite keys, triggers only (no EXECUTE)", () => {
    // Runtimes READ only; nothing else is granted on the table, and no function is granted to anyone.
    expect([...sql.matchAll(/grant [^;]*;/g)].map((m) => m[0])).toEqual(["grant select on mutations.validation_authorizations to authenticated, app_worker;"]);
    expect(sql).toMatch(/alter table mutations\.validation_authorizations force row level security/);
    // At most 2 hours, never open-ended; exactly meta + instagram + reply_public.
    expect(sql).toMatch(/expires_at timestamptz not null,/);
    expect(sql).toMatch(/constraint validation_authorizations_lifetime check \(expires_at > issued_at and expires_at <= issued_at \+ interval '2 hours'\)/);
    expect(sql).toMatch(/provider text not null check \(provider in \('meta'\)\), platform text not null check \(platform in \('instagram'\)\), kind text not null check \(kind in \('reply_public'\)\)/);
    // One intent per authorization (both sides) and one authorization per intent (one immutable column).
    expect(sql).toMatch(/create unique index mutation_intents_one_per_validation_authorization on mutations\.mutation_intents \(workspace_id, validation_authorization_id\) where validation_authorization_id is not null/);
    expect(sql).toMatch(/constraint validation_authorizations_one_intent unique \(workspace_id, intent_id\)/);
    expect(sql).toMatch(/alter table mutations\.mutation_intents add column validation_authorization_id uuid;/);
    // Scope coherence: the intent's workspace, account, target, initiator and kind are the authorization's own.
    expect(sql).toMatch(/foreign key \(workspace_id, validation_authorization_id, connected_account_id, target_interaction_id, initiator_user_id, kind\) references mutations\.validation_authorizations \(workspace_id, id, connected_account_id, target_interaction_id, initiator_user_id, kind\)/);
    // Binding on insert, consumption on the transition into EXECUTING, the authorization's own guard on every write.
    expect(sql).toMatch(/create trigger bind_validation_authorization after insert on mutations\.mutation_intents for each row when \(new\.validation_authorization_id is not null\) execute function mutations\.bind_validation_authorization\(\)/);
    expect(sql).toMatch(/create trigger consume_validation_authorization before update on mutations\.mutation_intents for each row execute function mutations\.consume_validation_authorization\(\)/);
    expect(sql).toMatch(/create trigger validation_authorization_guard before insert or update or delete on mutations\.validation_authorizations for each row execute function mutations\.validation_authorization_guard\(\)/);
    // Step 7B-14F2: one consumed authorization per target, for ever (guard + declarative backstop); issuance only under
    // READ COMMITTED; an authorized intent enters EXECUTING only from PENDING and reaches a provider outcome only consumed.
    expect(sql).toMatch(/create unique index validation_authorizations_one_consumed_per_target on mutations\.validation_authorizations \(workspace_id, target_interaction_id, kind\) where consumed_at is not null/);
    expect(sql).toMatch(/if pg_catalog\.current_setting\('transaction_isolation'\) <> 'read committed' then raise exception/);
    expect(sql).toMatch(/and v\.kind = new\.kind and v\.consumed_at is not null\) then raise exception 'a validation authorization was already consumed for this target'/);
    expect(sql).toMatch(/if old\.status <> 'pending' then raise exception 'an authorized intent enters executing only from pending'/);
    expect(sql).toMatch(/if new\.status in \('confirmed', 'failed', 'outcome_unknown'\) and v_auth\.consumed_at is null then raise exception/);
    // Nothing here touches switches, capability, outbox or tasks.
    expect(sql).not.toMatch(/operational_switches|capability\.|system\.outbox|provider_action|grant [^;]*(insert|update|delete)/);
  });

});

/**
 * Step 7B-14G1 replaces the 7B-14F1 inertness pin ("nobody knows the authorization yet") with the integration's boundary:
 * the authorization reaches exactly the one request path and the one executor, read-only, through one pure decision —
 * and no other code (UI, Server Action, job, provider, AI) learns of it, and nothing outside the migrations can write it.
 */
describe("7B-14G1: the validation authorization is integrated into the ONE request and executor path, read-only", () => {
  const KNOWS = /validation_authorization|validationAuthorization|ValidationAuthorization|validation-authorization|catalogValidationPending|ValidationExecutionReads|ValidationAuthorityReads|validationReads|anotherValidationConsumedForTarget/;

  it("exactly these production files know it (no UI, Server Action, job, provider or AI code)", () => {
    const knows = sourceFiles(PRODUCTION).filter((file) => !file.startsWith("db/") && KNOWS.test(strip(codeOf(file))));
    expect(knows).toEqual([
      "domain/i18n/message-keys.ts",
      // Step 7B-14I2: the closed audit vocabulary names the operator's two 0029 events (no TypeScript producer).
      "modules/audit/domain/audit-event.ts",
      "modules/capability/application/evaluation.ts",
      "modules/capability/index.ts",
      "mutations/domain/intent.ts",
      "mutations/domain/validation-authorization.ts",
      "mutations/executor/execute.ts",
      "mutations/persistence/index.ts",
      "mutations/persistence/store.ts",
      "mutations/persistence/tables.ts",
      "mutations/persistence/validation-authorizations.ts",
      "mutations/ports.ts",
      "mutations/request/index.ts",
      "platform/i18n/catalogs/development-reference.ts",
      "server/commands/mutations.ts",
      "server/inbox/inbox.ts",
      "server/persistence/mutation-execution.ts",
      "server/persistence/mutations.ts",
      // Step 7B-14I2: the Inbox reply model (the initiator's own live authorization, through RLS — its id never leaves
      // the server) and the operator tool (three fixed definer calls; no table access).
      "server/queries/inbox.ts",
      "tools/ops/validation-authorization.ts",
      "tools/ops/validation-authorizations.ts",
    ]);
    // Step 7B-14I2: the Inbox Server Action reads ONE more field — a constant mode flag — and never an identifier; the
    // composer sends that flag only; no browser path names an authorization.
    const action = strip(codeOf("server/inbox/actions.ts"));
    expect(action).toMatch(/const validation = field\(form, "validation"\) === "1";/);
    expect(action).toMatch(/\.\.\.\(validation \? \{ validation: true \} : \{\}\)/);
    expect(action).not.toMatch(/validationAuthorizationId|authorizationId|field\(form, "validationAuthorization/);
    for (const file of sourceFiles(["app", "ui", "jobs", "integrations", "ai"])) expect(strip(codeOf(file)), file).not.toMatch(KNOWS);
    expect(strip(codeOf("server/queries/inbox.ts"))).not.toMatch(/validationAuthorizationId|readValidationAuthorization/);
  });

  it("nothing outside the migrations can write an authorization: no insert / update / delete / locking read, in any form", () => {
    const writes = /(insert\s+into|update|delete\s+from)\s+mutations\.validation_authorizations|\.(insert|update|delete)\(\s*validationAuthorizations\b/i;
    expect(sourceFiles(PRODUCTION).filter((file) => !file.startsWith("db/migrations/") && writes.test(strip(codeOf(file))))).toEqual([]);
    const adapter = strip(codeOf("mutations/persistence/validation-authorizations.ts"));
    expect(adapter).not.toMatch(/\.(insert|update|delete)\(|\.for\(|for update|for share|set_config|app\.operator_id/i);
    // The worker's UPDATE grant (0027) never covered the binding column, and 0028 adds no grant but SELECT.
    expect(codeOf("db/migrations/0027_mutation_intents.sql")).toMatch(/grant update \(status, attempt, run_reference, outcome_code, updated_at\) on mutations\.mutation_intents to app_worker;/);
  });

  it("one pure decision, used by exactly the request and the executor; the capability answer is a separate, narrow read", () => {
    const users = sourceFiles(PRODUCTION).filter((file) => /decideValidationAdmission\(/.test(strip(codeOf(file))) && file !== "mutations/domain/validation-authorization.ts");
    expect(users).toEqual(["mutations/executor/execute.ts", "mutations/request/index.ts"]);
    // The effective capability resolver is unchanged: catalogValidationPending is never consulted by capabilityAvailability.
    const evaluation = strip(codeOf("modules/capability/application/evaluation.ts"));
    const availability = evaluation.slice(evaluation.indexOf("export async function capabilityAvailability"), evaluation.indexOf("export async function catalogValidationPending"));
    expect(availability).not.toMatch(/catalogValidationPending|CATALOG_NOT_VALIDATED/);
    // The productive catalog still publishes no reply_public (r5): the exception never makes it AVAILABLE.
    expect(JSON.stringify(PLATFORM_CATALOG)).not.toMatch(/reply_public/);
  });

  it("the exception never substitutes a pause or the emergency block, and is decided before EXECUTING", () => {
    const domain = strip(codeOf("mutations/domain/validation-authorization.ts"));
    expect(domain).toMatch(/if \(input\.providerAction === "paused"\) return refuse\("provider_action"\);/);
    expect(domain).toMatch(/if \(!input\.capability\.usable && !input\.capability\.catalogValidationPending\) return refuse\("capability"\);/);
    const executor = strip(codeOf("mutations/executor/execute.ts"));
    // The ordinary refusals are untouched for an intent without an authorization.
    expect(executor).toMatch(/if \(authorizationId === null && providerAction !== "allowed"\) return block\("PROVIDER_ACTIONS_DISABLED"\);/);
    expect(executor).toMatch(/if \(authorizationId === null\) \{\s*if \(!usable\) return block\("CAPABILITY_UNAVAILABLE"\);/);
    // The verdict and PRE-LIVE-2 come before the EXECUTING settle; the final gate before the ONE provider call.
    expect(executor.indexOf("validationVerdict(stores.validation")).toBeLessThan(executor.indexOf('await settle(stores, intent, "EXECUTING"'));
    expect(executor.indexOf("credentialReady(")).toBeLessThan(executor.indexOf('await settle(stores, intent, "EXECUTING"'));
    expect(executor.indexOf("finalValidationGate(stores, intent")).toBeLessThan(executor.indexOf(".replyPublicly("));
  });
});
