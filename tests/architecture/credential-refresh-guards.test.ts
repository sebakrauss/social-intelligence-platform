/**
 * Static guards for the capability refresh after a re-authorization (Step 7G-H5.5-P12-C0-R1). The continuation is a
 * typed, identifier-only subject of the discovery authority that ONLY a successful re-authorization creates; only a
 * validated discovery whose credential is still active turns it into evaluation requests; the worker refuses a
 * credential-bound request once that credential was replaced, before any credential is loaded. Nothing here may grow
 * into a human-requested re-evaluation, an inferred continuation, a migration or a second discovery producer.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { codeOf, sourceFiles } from "../support/source-scan";

const root = path.resolve(import.meta.dirname, "../..");
const PRODUCTION_ROOTS = ["app", "server", "modules", "domain", "platform", "integrations", "jobs", "mutations", "ai", "ui", "tools"];
const DISCOVERY = "modules/connections/application/discovery.ts";
const REQUEST = "modules/connections/application/capability-request.ts";
const REFRESH = "modules/connections/application/capability-refresh.ts";
const COMMANDS = "server/commands/connections.ts";
const JOBS = "jobs/connections.ts";
const users = (pattern: RegExp): string[] => sourceFiles(PRODUCTION_ROOTS).filter((file) => pattern.test(codeOf(file))).sort();

describe("the continuation is created only by a successful re-authorization", () => {
  it("the subject name lives in exactly the builder/reader module and the task's declared subjects", () => {
    expect(users(/capability_refresh_credential_id/)).toEqual([DISCOVERY, "jobs/registry.ts"].sort());
    expect(PRODUCTION_TASKS.tenant("connections.discover_assets")?.subjects).toEqual(["connection_id", "capability_refresh_credential_id"]);
  });

  it("ONE builder of discovery authorities; its only caller sets the continuation exactly for `reauthorized`, never for `created`", () => {
    expect(users(/\bdiscoveryRequest\(/)).toEqual([COMMANDS, DISCOVERY].sort());
    const commands = codeOf(COMMANDS);
    expect(commands.match(/\bdiscoveryRequest\(/g)).toHaveLength(1);
    expect(commands).toMatch(/capabilityRefresh: output\.kind === "reauthorized" \? \{ kind: "credential", credentialId: output\.credentialId \} : null,/);
    // No hand-built discovery message anywhere else (topic + key are the builder's).
    expect(users(/topic: (DISCOVER_ASSETS_TOPIC|DISCOVER_ASSETS_TASK|"connections\.discover_assets")/)).toEqual([DISCOVERY]);
    expect(commands).not.toMatch(/dispatchKey: `\$\{DISCOVER_ASSETS_TOPIC\}/);
  });

  it("no database function produces a discovery authority (the web completion is the only producer)", () => {
    const migrations = readdirSync(path.join(root, "db/migrations")).filter((f) => f.endsWith(".sql"));
    for (const file of migrations) expect(readFileSync(path.join(root, "db/migrations", file), "utf8"), file).not.toMatch(/connections\.discover_assets|capability_refresh_credential_id/);
    expect(migrations.sort().at(-1)).toBe("0023_resumable_signal_progress.sql");
  });

  it("the continuation is read only from the run's subjects, by the discovery handler — never inferred from status, version or history", () => {
    expect(users(/\bcapabilityRefreshOf\(/)).toEqual([DISCOVERY, JOBS].sort());
    expect(codeOf(JOBS)).toMatch(/capabilityRefresh: capabilityRefreshOf\(context\.payload\.subjectIds\),/);
    const discovery = codeOf(DISCOVERY);
    const refresh = discovery.slice(discovery.indexOf("async function refreshCapabilities("));
    expect(refresh).toMatch(/if \(refresh === null\) return null;/);
    expect(refresh).not.toMatch(/\.version\b|\.status\b|events|history|credentialVersion/);
  });
});

describe("a validated discovery requests evaluations only for its own, still-active credential", () => {
  it("the refresh runs inside the validated branch's transaction, after the R6 claim, and guards the active credential", () => {
    const discovery = codeOf(DISCOVERY);
    const claim = discovery.indexOf("claimEffect(`${DISCOVER_ASSETS_TASK}:${input.outboxId}`)");
    const call = discovery.indexOf("const capabilityRefresh = await refreshCapabilities(store, deps, input, connection, now);");
    const failedBranch = discovery.indexOf("if (!result.ok) {");
    expect(claim).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(failedBranch);
    expect(discovery.match(/refreshCapabilities\(/g)).toHaveLength(2); // definition + the one validated-branch call
    expect(discovery).toMatch(/if \(connection\.activeCredentialId !== refresh\.credentialId\) return \{ kind: "superseded" \};/);
    expect(discovery).toMatch(/store\.connectedAccounts\.listActiveForConnection\(connection\.id\)/);
    expect(discovery).toMatch(/store\.capabilityRequests\.requestOnce\(/);
    expect(discovery).toMatch(/reason: \{ kind: "credential", credentialId: refresh\.credentialId \},\n\s+correlationId: input\.correlationId,\n\s+initiator: \{ type: "system" \},/);
  });

  it("requests are appended once per dispatch key (the outbox's unique key), and newly appended rows wake the relay", () => {
    const persistence = codeOf("server/persistence/connections.ts");
    expect(persistence).toMatch(/const outcome = await appendOutboxOnce\(scope\.tx, message\);\n\s+if \(outcome === "appended"\) scope\.noteOutbox\(message\);/);
    expect(persistence).toMatch(/capabilityRequests: requestOnce\(scope\),/);
    // The read-only diagnostic lookup can never request anything.
    expect(persistence).toMatch(/capabilityRequests: \{ requestOnce: refuseWrite \},/);
  });
});

describe("the worker never evaluates another credential under a credential-bound authority", () => {
  it("the superseded check comes before the envelope is loaded (so before any KMS Decrypt or provider call)", () => {
    const refresh = codeOf(REFRESH);
    const guard = refresh.indexOf("if (input.expectedCredentialId !== undefined && connection.activeCredentialId !== input.expectedCredentialId) return \"superseded\" as const;");
    const load = refresh.indexOf("await connections.credentials.load(connection.activeCredentialId)");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(load);
    expect(refresh).not.toMatch(/expectedCredentialId[^\n]*\?\?|activeCredentialId = input\.expectedCredentialId/);
  });

  it("the bound credential travels as a declared identifier subject and is passed through unchanged", () => {
    expect(PRODUCTION_TASKS.tenant("capability.evaluate_account")?.subjects).toEqual(["connected_account_id", "credential_id"]);
    expect(codeOf(JOBS)).toMatch(/const expectedCredentialId = context\.payload\.subjectIds\[CAPABILITY_EVALUATION_CREDENTIAL_SUBJECT\];/);
    expect(codeOf(REQUEST)).toMatch(/input\.reason\.kind === "credential"\n\s+\? \{ connected_account_id: input\.connectedAccountId, \[CAPABILITY_EVALUATION_CREDENTIAL_SUBJECT\]: input\.reason\.credentialId \}/);
  });
});

describe("the human re-check is untouched", () => {
  it("the human command never builds a credential request, and its event/reason vocabulary is unchanged", () => {
    const human = codeOf("modules/connections/application/capability-reevaluation.ts");
    expect(human).not.toMatch(/kind: "credential"|credentialId|capability_refresh/);
    expect(human).toMatch(/const reason = \{ kind: "reevaluation", eventId \} as const;/);
    expect(codeOf("modules/connections/domain/model.ts")).toMatch(/export const ACCOUNT_EVENT_REASONS = \["USER_LINKED", "USER_UNLINKED", "MOVE", "CONNECTION_DISCONNECTED", "CONNECTION_REMOVED", "USER_REQUESTED_REEVALUATION"\] as const;/);
    // The system path writes no account event and no audit of its own (no fabricated human action).
    const discovery = codeOf(DISCOVERY);
    const refresh = discovery.slice(discovery.indexOf("async function refreshCapabilities("));
    expect(refresh).not.toMatch(/accountEvents|recordAuditEvent|REEVALUATION|userId/);
  });
});
