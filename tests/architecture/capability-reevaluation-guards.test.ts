/**
 * Capability re-evaluation guards (Step 7G-H5.5-P2-B1). The explicit recovery core is provider-neutral, only ever
 * CREATES authority (one appended request keyed by a new event), never re-arms or touches an existing outbox row, and is
 * reachable only through its registered command: no worker, job, scheduler, reconciler or availability code produces or
 * consumes a re-evaluation by itself. The worker path, the task definition and capability availability stay as they are.
 */
import { describe, expect, it } from "vitest";
import { TABLE_CLASSIFICATION } from "@/db/schema/classification";
import { PRODUCTION_TASKS } from "@/jobs/registry";
import { codeOf, sourceFiles } from "../support/source-scan";

const SERVICE = "modules/connections/application/capability-reevaluation.ts";
const REQUEST = "modules/connections/application/capability-request.ts";
const COMMANDS = "server/commands/connected-accounts.ts";
const STORE = "modules/connections/persistence/store.ts";
const MODULE_INDEX = "modules/connections/index.ts";
const SETTINGS = "server/connections/settings.ts";
const PRODUCTION_ROOTS = ["app", "server", "modules", "domain", "platform", "integrations", "jobs", "mutations", "ai", "ui"];
const WORKER_PATH = ["jobs", "modules/connections/application/capability-refresh.ts", "modules/capability", "platform/outbox", "platform/jobs", "platform/db"];

const importsOf = (file: string): string[] => [...codeOf(file).matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");
/** The command's own definition inside the registry file. */
const commandCode = (): string => {
  const code = codeOf(COMMANDS);
  const start = code.indexOf("const requestCapabilityReevaluationCommand");
  const end = code.indexOf("return { link, unlink", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return code.slice(start, end);
};
/** A store method's body (from its name to the next method of the same object). */
const storeMethod = (name: string): string => {
  const code = codeOf(STORE);
  const start = code.indexOf(`async ${name}(`);
  expect(start).toBeGreaterThan(0);
  return code.slice(start, code.indexOf("\n      },", start));
};
const referencing = (pattern: RegExp, roots: readonly string[] = PRODUCTION_ROOTS): string[] => sourceFiles(roots).filter((file) => pattern.test(codeOf(file)));

describe("provider-neutral (no Meta logic)", () => {
  it("the service and the command import no provider, integration, job, credential or AWS code", () => {
    for (const specifier of importsOf(SERVICE)) {
      expect(specifier, `${SERVICE} → ${specifier}`).toMatch(/^(@\/domain\/errors|@\/modules\/capability|@\/platform\/outbox|\.\.\/domain\/model|\.\/authorization|\.\/capability-request|\.\/ports)$/);
    }
    for (const specifier of importsOf(COMMANDS)) {
      expect(specifier, `${COMMANDS} → ${specifier}`).not.toMatch(/integrations\/|meta|tiktok|^@\/jobs\/|platform\/jobs|platform\/crypto|platform\/aws|@aws-sdk|@trigger\.dev/);
    }
  });

  it("names no provider, platform or provider operation", () => {
    for (const code of [codeOf(SERVICE), commandCode()]) {
      expect(code).not.toMatch(/["'`](meta|tiktok|facebook|instagram|simulator)["'`]/i);
      expect(code).not.toMatch(/describeAccount|withCredential|ProviderReadPort|credential/i);
    }
  });
});

describe("authority is only ever created, never re-armed", () => {
  it("the service's only outbox interaction is ONE append of the shared evaluation request", () => {
    const code = codeOf(SERVICE);
    expect([...code.matchAll(/\.append\(/g)]).toHaveLength(2); // the account event + the evaluation request
    expect([...code.matchAll(/stores\.outbox\.append\(\s*capabilityEvaluationRequest\(/g)]).toHaveLength(1);
    expect(code).not.toMatch(/system\.outbox|dispatch_key|run_outcome|recovery_count|claimed_until|routed\(|requeue|markDispatched|recordOutcome|\.update\(|sql`/);
  });

  it("the new store primitives only lock the account and read event times: no outbox, no write beyond the append", () => {
    const store = codeOf(STORE);
    const readAccount = store.slice(store.indexOf("async function getConnectedAccount("), store.indexOf("function toMove("));
    expect(readAccount).toMatch(/query\.for\("update"\)/);
    expect(store).toContain("lock: (id) => getConnectedAccount(tx, id, true),\n    },\n    accountEvents: {");
    for (const body of [storeMethod("latestOccurredAt"), readAccount]) {
      expect(body).not.toMatch(/outbox|\.update\(|\.delete\(|\.insert\(|sql`/);
    }
  });

  it("the web role still holds INSERT only on system.outbox: it can't read, update or re-arm any authority", () => {
    expect(TABLE_CLASSIFICATION["system.outbox"]?.privileges.authenticated).toEqual(["INSERT"]);
  });

  it("the recovery key exists only as `reeval.{UUID event id}`; every other reason keeps its key", () => {
    const request = codeOf(REQUEST);
    expect(request).toMatch(/case "reevaluation":\s*if \(!isUuid\(reason\.eventId\)\) throw new TypeError/);
    expect(request).toMatch(/return `reeval\.\$\{reason\.eventId\}`;/);
    expect(request).toMatch(/case "activation":\s*return reason\.activationId;/);
    expect(request).toMatch(/case "unrecorded":\s*return "initial";/);
    expect(request).toMatch(/case "catalog":\s*return `\$\{reason\.catalogId\}\.r\$\{String\(reason\.catalogRevision\)\}`;/);
  });
});

describe("no automatic recovery, no scheduler or reconcile wiring", () => {
  it("only the service constructs a re-evaluation reason or writes REEVALUATION_REQUESTED", () => {
    expect(referencing(/kind:\s*"reevaluation"/)).toEqual([REQUEST, SERVICE].sort());
    expect(referencing(/"REEVALUATION_REQUESTED"/)).toEqual(["modules/connections/domain/model.ts", SERVICE].sort());
    expect(referencing(/"USER_REQUESTED_REEVALUATION"/)).toEqual(["modules/connections/domain/model.ts", SERVICE].sort());
  });

  it("the service is reached only through the registered command; the command only from its registry", () => {
    // Step 7G-H5.5-P2-B2: the Settings surface names the COMMAND (taken from the registry), never the service.
    expect(referencing(/\brequestCapabilityReevaluation\b/)).toEqual([MODULE_INDEX, COMMANDS, SERVICE, SETTINGS].sort());
    expect(codeOf(SETTINGS)).toMatch(/const \{ requestCapabilityReevaluation \} = createConnectedAccountCommands\(\);/);
    expect(codeOf(SETTINGS)).toMatch(/import type \{[^}]*\} from "@\/modules\/connections";/);
    expect(codeOf(SETTINGS)).not.toMatch(/import \{[^}]*\} from "@\/modules\/connections";/);
    expect(referencing(/request_capability_reevaluation|requestCapabilityReevaluationCommand|\.requestCapabilityReevaluation\b/)).toEqual([COMMANDS]);
  });

  it("the worker, jobs, outbox delivery, R7 and capability (availability) code never reference a re-evaluation", () => {
    expect(referencing(/reevaluation|REEVALUATION|reeval\./i, WORKER_PATH)).toEqual([]);
    // Reconciliation (unchanged, still unwired) never creates a recovery authority either.
    expect(codeOf("modules/connections/application/capability-reconcile.ts")).not.toMatch(/"reevaluation"|REEVALUATION_REQUESTED/);
    expect(referencing(/\brequestCapabilityReevaluations\b/)).toEqual([MODULE_INDEX, "modules/connections/application/capability-reconcile.ts"].sort());
  });

  it("capability.evaluate_account is unchanged: same plane, lane, retry policy, concurrency and subjects", () => {
    const task = PRODUCTION_TASKS.get("capability.evaluate_account");
    expect(task).toMatchObject({ scope: "workspace", executionPlane: "integration", lane: 3, concurrency: { by: "subject", subject: "connected_account_id" }, subjects: ["connected_account_id"] });
    expect(task?.retry).toEqual(PRODUCTION_TASKS.get("connections.move.reject_destination")?.retry);
  });
});
