/**
 * Step H6-C3d — static guards around audit provenance (migration 0020):
 *   - a member's direct audit append (0003 `append_own`, narrowed by 0020) admits exactly the action pipeline's own
 *     actions — the literal actions of server/commands — and nothing a reviewed definer or the job runtime emits;
 *   - the generic semantics can't come back: 0020 is the only migration that alters `append_own`, and no later one may
 *     create another member/PUBLIC audit INSERT policy or touch the narrowed one;
 *   - `connected_account.reconciliation_requested` stays command-bound (written only by 0019's definer), the Move saga
 *     actions only by 0010's, `connection.validated` only by the job runtime as `system`;
 *   - no browser/UI module writes audit; the pipeline is the only TypeScript producer of `user` audit events;
 *   - 0020 changes exactly one policy, adds one helper with one grant, and touches no audit row.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS } from "@/modules/audit";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../support/source-scan";
import {
  COMMAND_BOUND_ELSEWHERE,
  PIPELINE_ORGANIZATION_ACTIONS,
  PIPELINE_USER_ACTIONS,
  PIPELINE_WORKSPACE_ACTIONS,
} from "../db/suites/audit-provenance";

const MIGRATIONS = path.join(REPOSITORY_ROOT, "db/migrations");
const migrationNames = (): string[] => readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const raw = (name: string): string => readFileSync(path.join(MIGRATIONS, name), "utf8");
const code = (name: string): string => raw(name).replace(/--[^\n]*/g, " ");
const M0020 = "0020_audit_command_provenance.sql";
const PRODUCTION = ["app", "ui", "server", "domain", "modules", "platform", "integrations", "ai", "mutations", "jobs", "tools"];
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();
/** The closed vocabulary's declaration (AUDIT_ACTIONS) names every action; it is not a producer. */
const VOCABULARY = "modules/audit/domain/audit-event.ts";
const producers = (): string[] => sourceFiles(PRODUCTION).filter((file) => file !== VOCABULARY);

/** The actions admitted by 0020's WITH CHECK, per branch (a) workspace, (b) organization, (c) user. */
function admitted(): { workspace: string[]; organization: string[]; user: string[] } {
  const sql = code(M0020);
  const policy = sql.slice(sql.indexOf("alter policy append_own on audit.audit_events"));
  const branches = policy.split(/\n\s*or \(\n/);
  const actions = (part: string | undefined): string[] => {
    const list = /and action in \(([^)]*)\)/.exec(part ?? "")?.[1] ?? "";
    return sorted([...list.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1] ?? ""));
  };
  return { workspace: actions(branches[0]), organization: actions(branches[1]), user: actions(branches[2]) };
}

describe("H6-C3d: the members' audit append is the pipeline's, exactly", () => {
  it("22. the 0020 allowlist per scope is exact (pinned)", () => {
    const { workspace, organization, user } = admitted();
    expect(workspace).toEqual(sorted(PIPELINE_WORKSPACE_ACTIONS));
    expect(organization).toEqual(sorted(PIPELINE_ORGANIZATION_ACTIONS));
    expect(user).toEqual(sorted(PIPELINE_USER_ACTIONS));
  });

  it("the allowlist is exactly the set of actions the action pipeline's commands emit (no more, no less)", () => {
    const commands = sourceFiles(["server/commands"]).filter((f) => !f.includes(".test."));
    const emitted = sorted(commands.flatMap((file) => [...codeOf(file).matchAll(/action: "([a-z_]+\.[a-z_]+)"/g)].map((m) => m[1] ?? "")));
    const { workspace, organization, user } = admitted();
    expect(sorted([...workspace, ...organization, ...user])).toEqual(emitted);
    // Every admitted action belongs to the closed vocabulary.
    for (const action of emitted) expect(AUDIT_ACTIONS as readonly string[], action).toContain(action);
  });

  it("the vocabulary splits cleanly: every action is either the pipeline's or a definer's / the job runtime's", () => {
    const pipeline = new Set<string>([...PIPELINE_WORKSPACE_ACTIONS, ...PIPELINE_ORGANIZATION_ACTIONS, ...PIPELINE_USER_ACTIONS]);
    expect(sorted([...pipeline, ...COMMAND_BOUND_ELSEWHERE])).toEqual(sorted(AUDIT_ACTIONS));
    for (const action of COMMAND_BOUND_ELSEWHERE) expect(pipeline.has(action), action).toBe(false);
  });

  it("23. the generic semantics can't come back: only 0003 creates and only 0020 alters append_own; no other member/PUBLIC audit INSERT policy exists", () => {
    const names = migrationNames();
    const creators = names.filter((n) => /create policy append_own on audit\.audit_events/.test(code(n)));
    const alterers = names.filter((n) => /alter policy append_own on audit\.audit_events/.test(code(n)));
    expect(creators).toEqual(["0003_audit.sql"]);
    expect(alterers).toEqual([M0020]);
    for (const n of names) {
      for (const match of code(n).matchAll(/create policy ([a-z_]+) on audit\.audit_events[^;]*?\bto ([a-z_, ]+)/g)) {
        const roles = (match[2] ?? "").split(",").map((r) => r.trim());
        if (match[1] === "append_own") continue;
        expect(roles.some((r) => r === "authenticated" || r === "public" || r === "anon"), `${n}: ${match[1] ?? ""}`).toBe(false);
      }
      // No later migration may touch the narrowed policy or the audit table's policies/grants for members.
      if (n > M0020) {
        expect(code(n), n).not.toMatch(/policy append_own|on audit\.audit_events[^;]*\bto (authenticated|public|anon)\b|grant [^;]* on audit\.audit_events/);
      }
    }
  });

  it("the narrowed policy keeps the actor bound to the verified user and requires an organization", () => {
    const sql = code(M0020);
    expect(sql).toMatch(/with check \(\s*actor_type = 'user' and actor_user_id = \(select auth\.uid\(\)\) and organization_id is not null/);
    expect(sql).toMatch(/workspace_id = \(select app\.current_workspace\(\)\)\s+and organization_id = \(select audit\.bound_workspace_organization\(\)\)/);
  });
});

describe("H6-C3d: command-bound actions keep their authoritative producers", () => {
  it("reconciliation_requested is written only by the request boundary (0019, replaced same-signature by 0022); no TypeScript emits it", () => {
    const writers = migrationNames().filter((n) => /insert into audit\.audit_events[\s\S]*?'connected_account\.reconciliation_requested'/.test(code(n)));
    expect(writers).toEqual(["0019_reconciliation_request.sql", "0022_provider_webhook_signals.sql"]);
    // In 0022 that insert lives inside the replaced ingestion.request_reconciliation, and nowhere else.
    const replaced = code("0022_provider_webhook_signals.sql");
    const boundary = replaced.slice(replaced.indexOf("create or replace function ingestion.request_reconciliation("), replaced.indexOf("end $$;", replaced.indexOf("create or replace function ingestion.request_reconciliation(")));
    expect([...replaced.matchAll(/insert into audit\.audit_events/g)]).toHaveLength(1);
    expect(boundary).toMatch(/insert into audit\.audit_events/);
    // Step H6-C4: the only TypeScript mention is the web command's DECLARATION that its boundary writes it (auditedBy).
    const mentions = producers().filter((file) => /"connected_account\.reconciliation_requested"/.test(codeOf(file)));
    expect(mentions).toEqual(["server/commands/reconciliation.ts"]);
    const declaration = codeOf("server/commands/reconciliation.ts");
    expect([...declaration.matchAll(/"connected_account\.reconciliation_requested"/g)]).toHaveLength(1);
    expect(declaration).toMatch(/export const RECONCILIATION_REQUEST_AUDIT: DatabaseBoundaryAudit = Object\.freeze\(\{\s+kind: "database_boundary",\s+function: "ingestion\.request_reconciliation",\s+actions: Object\.freeze\(\["connected_account\.reconciliation_requested"\] as const\),\s+\}\);/);
  });

  it("the Move saga's audit is 0010's definer's only; connection.validated is the job runtime's, as `system`", () => {
    for (const file of producers()) {
      expect(codeOf(file), file).not.toMatch(/"connected_account\.(moved_out|moved_in|move_failed|move_rejected)"/);
    }
    const validated = producers().filter((file) => /"connection\.validated"/.test(codeOf(file)));
    expect(validated).toEqual(["modules/connections/application/discovery.ts"]);
    const discovery = codeOf("modules/connections/application/discovery.ts");
    expect(discovery.slice(discovery.indexOf("await recordAuditEvent(store.audit, {"))).toMatch(/^await recordAuditEvent\(store\.audit, \{\s+id: deps\.newId\(\),\s+occurredAt: now,\s+action,\s+actorType: "system",/);
  });

  it("no browser/UI module writes audit; the pipeline is the only TypeScript producer of `user` audit events", () => {
    for (const file of sourceFiles(["app", "ui"])) {
      expect(codeOf(file), file).not.toMatch(/audit_events|auditEvents|createPostgresAuditLog|recordAuditEvent|modules\/audit\/persistence/);
    }
    const userProducers = sourceFiles(PRODUCTION).filter((file) => /actorType: "user"/.test(codeOf(file)) && /recordAuditEvent\(/.test(codeOf(file)));
    expect(userProducers).toEqual(["server/pipeline/pipeline.ts"]);
    expect(codeOf("server/pipeline/pipeline.ts")).toMatch(/actorType: "user",\s+actorUserId: user\.userId,/);
  });
});

describe("H6-C3d: 0020's scope", () => {
  it("24. exactly: one helper definer (+ revoke PUBLIC, grant authenticated) and the one ALTER POLICY; no data touched", () => {
    const sql = code(M0020);
    const statements = sql.split(/;\s*(?=\n|$)/).map((s) => s.trim()).filter((s) => s.length > 0 && !/^\$\$$/.test(s));
    const heads = statements.map((s) => s.split(/\s+/).slice(0, 3).join(" ").toLowerCase());
    expect(heads).toEqual(["set role app_owner", "create function audit.bound_workspace_organization()", "revoke all on", "grant execute on", "reset role", "alter policy append_own"]);
    expect(sql).toMatch(/create function audit\.bound_workspace_organization\(\) returns uuid\s+language sql stable security definer set search_path = '' as \$\$/);
    expect(sql).toMatch(/revoke all on function audit\.bound_workspace_organization\(\) from public;/);
    expect([...sql.matchAll(/grant [^;]*;/g)].map((m) => m[0])).toEqual(["grant execute on function audit.bound_workspace_organization() to authenticated;"]);
    // 20. Forward-only: no row is inserted, updated, deleted or truncated; no table, column, constraint or vocabulary change.
    expect(sql.toLowerCase()).not.toMatch(/\b(insert into|update|delete from|truncate|alter table|create table|drop|audit_events_action_check)\b/);
  });

  it("no later migration changes audit policy or vocabulary: 0021 is outbox-only; 0022 only re-creates the request boundary's one insert; 0023 and 0024 name no audit object", () => {
    const later = migrationNames().filter((name) => name > M0020);
    expect(later).toEqual(["0021_outbox_internal_topics.sql", "0022_provider_webhook_signals.sql", "0023_resumable_signal_progress.sql", "0024_classification_persistence.sql"]);
    expect(code("0023_resumable_signal_progress.sql").toLowerCase()).not.toMatch(/audit_events|audit\.|on audit|policy append_own/);
    expect(code("0024_classification_persistence.sql").toLowerCase()).not.toMatch(/audit_events|audit\.|on audit|policy append_own/);
    expect(code("0021_outbox_internal_topics.sql").toLowerCase()).not.toMatch(/audit_events|audit\.|on audit|policy append_own/);
    const replaced = code("0022_provider_webhook_signals.sql").toLowerCase();
    // No audit policy, grant, constraint or vocabulary change; every audit mention is the boundary's single INSERT.
    expect(replaced).not.toMatch(/policy [a-z_]+ on audit|on audit\.audit_events|audit_events_action_check|policy append_own|alter table audit/);
    expect([...replaced.matchAll(/audit\.audit_events/g)]).toHaveLength(1);
  });
});
