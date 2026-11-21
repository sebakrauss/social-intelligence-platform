/**
 * WORKFLOW-WF-2B — static guards for the shared Workflow core and its first consumer, Comments:
 *
 *   - the queue read keeps the measured WF-2A shape: every statement of the read store opens its WHERE with the bound
 *     workspace as an explicit predicate, the workspace is a REQUIRED argument, and nothing else in the product reads the
 *     workflow tables;
 *   - ownership: only modules/workflow/persistence names the workflow tables; the workflow module never names another
 *     module's tables; ingestion (L1) never imports the workflow layer (L3) — server/persistence composes them;
 *   - no automatic Done: the job runtime's store never sets DONE; the auto-reopen input carries no `arrival`;
 *   - the web writes only through the reviewed definer; the one Server Action runs only the two workflow commands;
 *   - Comments only: no Messages subject, no assignment, note, escalation or label in the workflow code;
 *   - the migration's definer is web-only and pinned (R4a), and there is no DELETE path.
 */
import { describe, expect, it } from "vitest";
import { codeOf, sourceFiles } from "../support/source-scan";

const READ_STORE = "modules/workflow/persistence/read-store.ts";
const PROJECTION_STORE = "modules/workflow/persistence/projection-store.ts";
const STATE_CHANGER = "modules/workflow/persistence/state-changer.ts";
const MIGRATION = "db/migrations/0034_workflow_core.sql";
const PRODUCT = ["app", "ui", "server", "domain", "modules", "platform", "integrations", "ai", "mutations", "jobs"];
const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ").replace(/^\s*\*.*$/gm, " ");

describe("the queue read keeps the measured WF-2A shape", () => {
  it("every read-store statement opens its WHERE with `workspace_id = <bound workspace>`, and the workspace is a required argument", () => {
    const code = strip(codeOf(READ_STORE));
    const statements = [...code.matchAll(/from workflow\.(\w+)\s+where ([^\n]+)/g)].map((match) => [match[1], (match[2] ?? "").trim()]);
    expect(statements).toEqual([["work_items", "workspace_id = ${input.workspaceId}::uuid"], ["work_items", "workspace_id = ${input.workspaceId}::uuid"]]);
    // No other way to reach the table from here (no drizzle builder over the table, no unparameterized SQL).
    expect(code).not.toMatch(/\.from\(workItems\)|sql\.raw|workflowEvents/);
    const ports = strip(codeOf("modules/workflow/application/ports.ts"));
    expect(ports).toMatch(/queue\(input: \{ readonly workspaceId: WorkspaceId; readonly view: QueueView; readonly before: QueuePosition \| null; readonly limit: number \}\)/);
    expect(ports).toMatch(/findMany\(input: \{ readonly workspaceId: WorkspaceId; readonly ids: readonly string\[\] \}\)/);
  });

  it("the list passes the command's resolved (bound) workspace, never input; the conversation view does the same", () => {
    const query = strip(codeOf("server/queries/inbox.ts"));
    expect(query).toMatch(/execute: \(context, input, tx\) => readInboxPage\(tx, context\.workspaceId, input\.cursor\?\.cursor, input\.state\),/);
    expect(query).toMatch(/tx\.workflow\.reads\.findMany\(\{ workspaceId: context\.workspaceId, ids: \[conversation\.id\] \}\)/);
    expect([...query.matchAll(/tx\.workflow\.reads\.(\w+)\(/g)].map((match) => match[1])).toEqual(["queue", "findMany"]);
  });

  it("only the workflow persistence names the workflow tables in product code", () => {
    const naming = sourceFiles(PRODUCT).filter((file) => /workflow\.(work_items|workflow_events)|pgSchema\("workflow"\)/.test(strip(codeOf(file))));
    expect(naming).toContain(READ_STORE);
    for (const file of naming) expect(file.startsWith("modules/workflow/persistence/"), file).toBe(true);
  });
});

describe("ownership and layering", () => {
  it("the workflow module names no other module's tables and imports no other module's persistence", () => {
    for (const file of sourceFiles(["modules/workflow"])) {
      const code = strip(codeOf(file));
      expect(code, file).not.toMatch(/interactions\.interactions|conversations\.conversations|content\.content_items|pgSchema\("(interactions|conversations|content)"\)/);
      expect([...code.matchAll(/from "(@\/modules\/[^"]+)"/g)].map((match) => match[1]).filter((specifier) => !(specifier ?? "").startsWith("@/modules/workflow")), file).toEqual(
        // The audit module's PUBLIC API only (its log is injected by the composition, never its persistence imported here).
        file === PROJECTION_STORE ? ["@/modules/audit"] : [],
      );
    }
  });

  it("ingestion (L1) never imports the workflow layer (L3); server/persistence composes the projection into ingestion's own port", () => {
    for (const file of sourceFiles(["modules/ingestion", "modules/interactions", "modules/conversations"])) expect(codeOf(file), file).not.toMatch(/@\/modules\/workflow/);
    const composition = strip(codeOf("server/persistence/ingestion.ts"));
    expect(composition).toMatch(/workflow: workflowMembershipSink\(tx\),/);
    expect(composition).toMatch(/await projectMembersJoined\(store, activity, \{ newId: randomUUID, now: \(\) => new Date\(\) \}, input\);/);
  });
});

describe("no automatic Done, and nothing suppresses a reopen", () => {
  it("the job runtime's store never sets DONE and never writes a resolution; only the objective reopen changes a state", () => {
    const code = strip(codeOf(PROJECTION_STORE));
    // Every state literal it writes, in order: the new item (OPEN), the reopen (OPEN), and the audit summary of the reopen
    // (previous DONE → current OPEN). DONE appears ONLY as that audit's previous state; no resolution literal is written.
    expect([...code.matchAll(/(previous: \{ )?state: "(OPEN|DONE)"/g)].map((match) => `${match[1] === undefined ? "" : "previous:"}${match[2] ?? ""}`)).toEqual(["OPEN", "OPEN", "previous:DONE", "OPEN"]);
    expect(code).not.toMatch(/resolution: "[a-z_]+"/);
    expect(code).toMatch(/\.\.\.\(decision\.reopen \? \{ state: "OPEN", resolution: null, stateChangedAt: input\.now, stateChangedByKind: "system_auto_reopen", stateChangedByUser: null \} : \{\}\),/);
    // The database refuses it too (trigger guard): the worker may only reopen.
    expect(codeOf(MIGRATION)).toMatch(/if current_user = 'app_worker'\s+and not \(old\.state = 'DONE' and new\.state = 'OPEN' and new\.resolution is null\s+and new\.state_changed_by_kind = 'system_auto_reopen' and new\.state_changed_by_user is null\) then/);
  });

  it("the auto-reopen receives no `arrival` (WF-2A §7): neither the port, the call site nor the decision has one", () => {
    const ports = strip(codeOf("modules/ingestion/application/ports.ts"));
    const sink = ports.slice(ports.indexOf("export interface ConversationMembershipSink"), ports.indexOf("export interface IngestionStores"));
    expect(sink).toMatch(/membersJoined\(input: \{ readonly conversationId: string; readonly organizationId: string; readonly workspaceId: string; readonly joined: readonly ConversationMember\[\]; readonly correlationId: CorrelationId \}\)/);
    expect(sink).not.toMatch(/arrival/);
    const call = strip(codeOf("modules/ingestion/application/ingest-interaction.ts")).match(/await stores\.workflow\.membersJoined\(\{[^}]*\}[^;]*;/)?.[0] ?? "";
    expect(call).not.toBe("");
    expect(call).not.toMatch(/arrival/);
    expect(strip(codeOf("modules/workflow/domain/work-item.ts"))).not.toMatch(/arrival|backfill/);
  });
});

describe("the web's only write path", () => {
  it("Mark Done / Reopen go through workflow.change_state only; the Server Action runs exactly the two workflow commands", () => {
    expect(strip(codeOf(STATE_CHANGER))).toMatch(/from workflow\.change_state\(/);
    const action = codeOf("server/inbox/workflow-actions.ts");
    expect(action.startsWith('"use server";')).toBe(true);
    expect([...action.matchAll(/pipeline\.run\((\w+),/g)].map((match) => match[1])).toEqual(["markDoneCommand", "reopenCommand"]);
    expect(action).not.toMatch(/@\/mutations|@\/integrations|@\/platform\/db|@\/modules\/workflow\/persistence|requestPublicReply/);
    // The pilot allowlist is consulted (unchanged) before anything runs.
    expect(action).toMatch(/if \(!commentsOfferedFor\(workspaceId\)\) return \{ kind: "blocked", code: "NOT_FOUND" \};/);
  });

  it("the definer is web-only, pinned to pg_catalog, pg_temp, EXECUTE to authenticated only; no DELETE grant or policy exists", () => {
    const sql = codeOf(MIGRATION).replace(/--[^\n]*/g, " ");
    expect(sql).toMatch(/create function workflow\.change_state\([\s\S]*?\)\s*language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as \$\$/);
    expect(sql).toMatch(/or not pg_catalog\.pg_has_role\(session_user, 'authenticated', 'MEMBER'\)\s+or pg_catalog\.pg_has_role\(session_user, 'app_worker', 'MEMBER'\) then/);
    expect([...sql.matchAll(/grant execute on function workflow\.[^;]*;/g)].map((match) => match[0])).toEqual(["grant execute on function workflow.change_state(uuid, text, text, integer, text, text) to authenticated;"]);
    expect(sql).not.toMatch(/grant [^;]*\bdelete\b[^;]*on workflow|for delete|policy [a-z_]+ on workflow\.[a-z_]+ for all/i);
  });
});

describe("Comments first: nothing of Messages or of later workflow gates", () => {
  it("one subject kind, and no assignment, note, escalation flow or operational label in the workflow code or its UI", () => {
    expect(codeOf(MIGRATION)).toMatch(/subject_kind\s+text not null check \(subject_kind in \('comment_conversation'\)\)/);
    for (const file of [...sourceFiles(["modules/workflow"]), "server/commands/workflow.ts", "server/inbox/workflow-actions.ts", "server/inbox/workflow-state.ts", "ui/inbox/workflow-control.tsx"]) {
      expect(strip(codeOf(file)), file).not.toMatch(/message_thread|private_message|assignee|assign(ed)?_to|internal_note|escalat(e|ion)_(flow|to)|operational_label/i);
    }
  });
});

describe("WF-2C: reconciliation repairs, reports, and never transitions", () => {
  it("the service repairs only through the rebuild (no member joins: no reopen, no version change) and only reports a possibly missed reopen", () => {
    const code = strip(codeOf("modules/workflow/application/reconcile.ts"));
    expect(code).toMatch(/await rebuildWorkItem\(ports\.store, ports\.activity, ports\.clock, \{ conversationId: input\.conversationId, organizationId: input\.organizationId, workspaceId: input\.workspaceId, correlationId: input\.correlationId \}\)/);
    expect(code).not.toMatch(/projectMembersJoined|changeState|\.apply\(|ensureAndLock|joined:/);
    expect(code).not.toMatch(/state: "(OPEN|DONE)"|reopen: true/);
  });

  it("the entry point: each batch its own workspace job scope, each item its own savepoint, a READ ONLY transaction for a dry run, ids and counts only", () => {
    const code = strip(codeOf("server/persistence/workflow-reconciliation.ts"));
    expect(code).toMatch(/await withWorkspaceJobScope\(worker, input\.workspaceId, \(tx\) => reconcileBatch\(/);
    expect(code).toMatch(/if \(dryRun\) await makeTransactionReadOnly\(tx\);/);
    expect(strip(codeOf("platform/db/scopes.ts"))).toMatch(/export async function makeTransactionReadOnly\(tx: DatabaseTransaction\): Promise<void> \{\s+await tx\.execute\(sql`set transaction read only`\);\s+\}/);
    expect(code).toMatch(/await tx\.transaction\(async \(savepoint\) =>/);
    expect(code).not.toMatch(/withUserScope|withSystemScope|privileged|\.message|String\(error\)/);
  });

  it("the CLI reads no .env file, fences the target before anything connects, and is dry by default", () => {
    for (const file of ["tools/ops/workflow-reconcile.ts", "tools/ops/workflow-reconcile-command.ts", "tools/ops/workflow-reconcile.operator.ts"]) {
      expect(codeOf(file), file).not.toMatch(/loadEnvironment|dotenv|\.env\.|readFileSync|console\.log\([^)]*url/i);
    }
    const cli = strip(codeOf("tools/ops/workflow-reconcile.ts"));
    expect(cli.indexOf("reconcileTargetProblems(")).toBeLessThan(cli.indexOf("spawnSync("));
    expect(strip(codeOf("tools/ops/workflow-reconcile.operator.ts"))).toMatch(/dryRun: !parsed\.command\.apply,/);
    expect(strip(codeOf("tools/ops/workflow-reconcile-command.ts"))).toMatch(/const LOOPBACK: readonly string\[\] = \["127\.0\.0\.1", "localhost", "::1", "\[::1\]"\];/);
  });
});
