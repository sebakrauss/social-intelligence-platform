/**
 * Connect Meta surface guards (Step 7G-F4): the permanent Settings › Connections page and its server action stay thin
 * and server-only; the provider is fixed; Meta's endpoint expectation comes from server composition; the fresh-connection
 * lock exists only in the connections persistence boundary, transaction-scoped and bounded; Remove Meta (Step 7G-F4C)
 * reuses the existing remove command with the provider fixed, closes old fresh attempts only through one write-only
 * definer, and never calls Meta; there is still no reconnect surface. Managed accounts (Step 7G-H5) save the whole
 * checked set through one command with the provider fixed, from persisted discovery only: no provider, KMS or job.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPOSITORY_ROOT, codeOf, sourceFiles } from "../support/source-scan";

const PAGE = "app/workspaces/[workspaceId]/settings/connections/page.tsx";
const ACTIONS = "server/connections/actions.ts";
const SETTINGS = "server/connections/settings.ts";
const SETTINGS_RUNTIME = "server/connections/settings-runtime.ts";
const PENDING_BUTTON = "ui/connections/pending-submit-button.tsx";
const SURFACE = [PAGE, ACTIONS, SETTINGS, SETTINGS_RUNTIME, "server/routes.ts", PENDING_BUTTON];
const STORE = "modules/connections/persistence/store.ts";
const importsOf = (file: string): string[] => [...codeOf(file).matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");
const PRODUCTION_ROOTS = ["app", "server", "modules", "domain", "platform", "integrations", "jobs", "mutations", "ai", "ui"];

describe("Connect Meta surface (Step 7G-F4)", () => {
  it("the page imports only server-side surface modules: no adapter, persistence, database, provider or job code", () => {
    for (const specifier of importsOf(PAGE)) {
      expect(specifier, specifier).toMatch(/^(next\/navigation|@\/server\/connections\/(actions|settings|settings-runtime)|@\/server\/i18n|@\/ui\/connections\/pending-submit-button)$/);
    }
    for (const file of SURFACE) {
      for (const specifier of importsOf(file)) {
        expect(specifier, `${file} → ${specifier}`).not.toMatch(/platform\/db|modules\/[^/]+\/persistence|integrations\/|platform\/crypto|platform\/aws|platform\/jobs|^@\/jobs\/|@trigger\.dev|@aws-sdk|^pg$|drizzle|meta-app-config/);
      }
    }
  });

  it("reads no environment, holds no provider secret and issues no SQL", () => {
    for (const file of SURFACE) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(/process\.env|PROVIDER_META_|client_secret|clientSecret|config_id|configId|SUPABASE_SERVICE_ROLE_KEY|DATABASE_\w*URL/);
      expect(code, file).not.toMatch(/\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b|sql`|\.insert\(|\.update\(|\.delete\(|pg_advisory|lock_timeout/i);
    }
  });

  it("the actions are a server-action module; connect reads only workspaceId, remove only workspaceId + connectionId + acknowledgement; provider fixed to meta", () => {
    expect(readFileSync(path.join(REPOSITORY_ROOT, ACTIONS), "utf8").startsWith('"use server";')).toBe(true);
    const actions = codeOf(ACTIONS);
    const connect = actions.slice(actions.indexOf("export async function startMetaConnectionAction"), actions.indexOf("export async function removeMetaConnectionAction"));
    const removeAndAfter = actions.slice(actions.indexOf("export async function removeMetaConnectionAction"));
    const fields = (code: string): (string | undefined)[] => [...code.matchAll(/form\.get\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]);
    expect(fields(connect)).toEqual(["workspaceId"]);
    const accounts = actions.slice(actions.indexOf("export async function saveManagedAccountsAction"));
    const remove = removeAndAfter.slice(0, removeAndAfter.indexOf("export async function saveManagedAccountsAction"));
    expect(fields(remove)).toEqual(["workspaceId", "connectionId", "acknowledgement"]);
    // Managed accounts: the routed ids plus the checked discovered-asset ids, nothing else.
    expect(fields(accounts)).toEqual(["workspaceId", "connectionId"]);
    expect([...accounts.matchAll(/form\.getAll\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1])).toEqual(["discoveredAssetId"]);
    expect(fields(actions)).toHaveLength(6);
    expect([...actions.matchAll(/form\.getAll\(/g)]).toHaveLength(1);
    expect(actions).not.toMatch(/form\.(entries|keys|values|has)\(|Object\.fromEntries/);
    expect(codeOf(SETTINGS)).toMatch(/input: \{ connectionId: input\.connectionId, expectedProvider: "meta", discoveredAssetIds \}/);
    expect(codeOf(SETTINGS)).toMatch(/startConnectionAuthorization\(deps, \{ workspaceId, provider: "meta" \}\)/);
    expect(codeOf(SETTINGS)).toMatch(/input: \{ connectionId: input\.connectionId, expectedProvider: "meta" \}/);
    for (const file of SURFACE) expect(codeOf(file), file).not.toMatch(/reconnectConnectionId|provider: "simulator"/);
  });

  it("the page renders and reads only; exactly three forms: Connect Meta, the per-connection Remove and Managed accounts", () => {
    const page = codeOf(PAGE);
    expect(page).not.toMatch(/"use client"|connectMeta|removeMeta\(|startConnectionAuthorization|connectionAuthorizationRuntime|recoverStale|\.start\b|onClick|confirm\(/);
    expect(page).toMatch(/export const dynamic = "force-dynamic"/);
    expect([...page.matchAll(/<form action=\{(\w+)\}>/g)].map((match) => match[1])).toEqual(["removeMetaConnectionAction", "startMetaConnectionAction", "saveManagedAccountsAction"]);
    expect([...page.matchAll(/<form\b/g)]).toHaveLength(3);
    // Managed accounts only for an ACTIVE Meta connection; checked = already managed, never preselected otherwise.
    expect(page).toMatch(/connection\.provider === "meta" && connection\.status === "ACTIVE"/);
    expect(page).toMatch(/name="discoveredAssetId" type="checkbox" value=\{asset\.discoveredAssetId\} defaultChecked=\{asset\.managed\}/);
    expect(page).not.toMatch(/dangerouslySetInnerHTML/);
    // Remove only for a Meta connection that isn't REMOVED, with the visible acknowledgement.
    expect(page).toMatch(/connection\.provider === "meta" && connection\.status !== "REMOVED"/);
    expect(page).toMatch(/name="acknowledgement" type="checkbox" value=\{REMOVE_ACKNOWLEDGEMENT\} required/);
  });

  it("no reconnect surface; removal only through the existing remove command; no remote Meta revocation", () => {
    for (const file of SURFACE) {
      const code = codeOf(file);
      expect(code, file).not.toMatch(/reconnect/i);
      expect(code, file).not.toMatch(/removeConnection\(|commands\.remove\b|\/permissions|deauthori[sz]e|revoke|graph\.facebook|unsubscribe/i);
    }
    const commandUsers = sourceFiles(PRODUCTION_ROOTS).filter((file) => /connectionRemoveCommand/.test(codeOf(file)));
    expect(commandUsers.sort()).toEqual(["server/commands/connections.ts", SETTINGS]);
  });

  it("the onboarding ready state links each workspace through the validated Settings path helper only", () => {
    const onboarding = codeOf("app/onboarding/page.tsx");
    expect(onboarding).toMatch(/workspaceConnectionsPath\(workspace\.id\)/);
    expect(onboarding).not.toMatch(/\/settings\/connections/);
    expect(codeOf("server/routes.ts")).toMatch(/`\/workspaces\/\$\{id\}\/settings\/connections`/);
  });
});

describe("Managed accounts (Step 7G-H5): local configuration only", () => {
  const LINKING = "modules/connections/application/linking.ts";
  const COMMAND = "server/commands/connected-accounts.ts";
  const selection = (code: string, start: string, end: string): string => code.slice(code.indexOf(start), code.indexOf(end, code.indexOf(start)));

  it("the selection command is used only by its module and the Settings surface; its only outbox work is the shared evaluation request (Step 7G-H5.5)", () => {
    const users = sourceFiles(PRODUCTION_ROOTS).filter((file) => /connectedAccountSelectionCommand/.test(codeOf(file)));
    expect(users.sort()).toEqual([COMMAND, SETTINGS]);
    const command = selection(codeOf(COMMAND), "export const connectedAccountSelectionCommand", "export function createConnectedAccountCommands");
    expect(command).toMatch(/permission: "connections\.manage"/);
    expect(command).toMatch(/expectedProvider: oneOf\(\["meta"\] as const\)/);
    // One request per activation transition, through the helper link shares; never a raw append, topic or provider.
    expect(command).toMatch(/for \(const activation of output\.activated\) await requestEvaluation\(tx\.outbox, context, env, activation\);/);
    expect(command.replace("tx.outbox, context", "")).not.toMatch(/outbox|CAPABILITY_EVALUATION_TOPIC|providers?\b\.|sealing|secrets|credential|deactivated\.map\([^)]*requestEvaluation/i);
  });

  it("one primitive builds every capability-evaluation request: activation (link, selection, Move), reconciliation and explicit re-evaluation", () => {
    const builders = sourceFiles(PRODUCTION_ROOTS).filter((file) => /CAPABILITY_EVALUATION_TOPIC/.test(codeOf(file)));
    expect(builders.sort()).toEqual(["modules/connections/application/capability-request.ts", "modules/connections/domain/model.ts", "modules/connections/index.ts"]);
    const callers = sourceFiles(PRODUCTION_ROOTS).filter((file) => /capabilityEvaluationRequest\(/.test(codeOf(file)));
    expect(callers.sort()).toEqual([
      "modules/connections/application/capability-reconcile.ts",
      // Step 7G-H5.5-P2-B1: the explicit recovery request (reason reevaluation, keyed by its REEVALUATION_REQUESTED event).
      "modules/connections/application/capability-reevaluation.ts",
      "modules/connections/application/capability-request.ts",
      "modules/connections/application/moves.ts",
      COMMAND,
    ]);
    const commands = codeOf(COMMAND);
    expect([...commands.matchAll(/capabilityEvaluationRequest\(/g)]).toHaveLength(1);
    expect([...commands.matchAll(/await requestEvaluation\(/g)]).toHaveLength(2);
    expect(commands).not.toMatch(/dispatchKey:/);
  });

  it("the convergence locks the Connection FOR UPDATE, reuses link/unlink, and touches no provider, credential, KMS or job", () => {
    const linking = codeOf(LINKING);
    const save = linking.slice(linking.indexOf("export async function saveManagedSelection"));
    expect(save).toMatch(/store\.connections\.lockForUpdate\(input\.connectionId\)/);
    expect(save).toMatch(/linkAccount\(store,/);
    expect(save).toMatch(/unlinkAccount\(store,/);
    expect(save).not.toMatch(/outbox|credential|withCredential|provider\w*Port|discoverAssets|kms|decrypt/i);
    for (const specifier of importsOf(LINKING)) expect(specifier, specifier).toMatch(/^(@\/domain\/errors|@\/domain\/ids|\.\.\/domain\/model|\.\/authorization|\.\/ports)$/);
  });

  it("the pending-state button is the only client component, and it only reads the form status", () => {
    const clients = sourceFiles(PRODUCTION_ROOTS).filter((file) => readFileSync(path.join(REPOSITORY_ROOT, file), "utf8").startsWith('"use client";'));
    expect(clients).toEqual([PENDING_BUTTON]);
    expect(importsOf(PENDING_BUTTON)).toEqual(["react-dom"]);
    expect(codeOf(PENDING_BUTTON)).toMatch(/disabled=\{pending\}/);
  });
});

describe("Meta endpoint expectation and fresh-connection lock boundaries", () => {
  it("META_DIALOG_URL is referenced in product code only by the Meta adapter and the web composition root", () => {
    const users = sourceFiles(PRODUCTION_ROOTS).filter((file) => /META_DIALOG_URL/.test(codeOf(file)));
    expect(users.sort()).toEqual(["integrations/providers/meta/authorization.ts", "integrations/providers/meta/endpoints.ts", "server/connections/runtime.ts"]);
  });

  it("advisory locks and lock_timeout appear only in the connections store (beyond the reviewed 0002 owner triggers); never session-level or try-locks", () => {
    const advisory = sourceFiles(PRODUCTION_ROOTS).filter((file) => /pg_advisory|lock_timeout/.test(codeOf(file)));
    expect(advisory).toEqual([STORE]);
    for (const file of sourceFiles(PRODUCTION_ROOTS)) {
      expect(codeOf(file), file).not.toMatch(/pg_advisory_lock\b|pg_advisory_lock_shared|pg_try_advisory|pg_advisory_unlock|set\s+lock_timeout|set_config\(\s*'lock_timeout'[^)]*false/i);
    }
    const store = codeOf(STORE);
    expect(store).toMatch(/pg_catalog\.pg_advisory_xact_lock\(pg_catalog\.hashtextextended\(\$\{FRESH_CONNECTION_LOCK_NAMESPACE\}::text \|\| \$\{workspace\}::uuid::text \|\| ':' \|\| \$\{provider\}::text, 0\)\)/);
    expect(store).toMatch(/FRESH_CONNECTION_LOCK_NAMESPACE = "connections\.fresh_connection:"/);
    expect(store).toMatch(/FRESH_CONNECTION_LOCK_TIMEOUT_MS = 5_000;\nconst FRESH_CONNECTION_LOCK_TIMEOUT = `\$\{String\(FRESH_CONNECTION_LOCK_TIMEOUT_MS\)\}ms`;/);
    // Transaction-local only (set_config(…, true)), and the previous value is what gets restored.
    expect([...store.matchAll(/set_config\('lock_timeout', [^)]*\)/g)].map((match) => match[0])).toEqual([
      "set_config('lock_timeout', ${FRESH_CONNECTION_LOCK_TIMEOUT}::text, true)",
      "set_config('lock_timeout', ${previous}::text, true)",
    ]);
  });

  it("the fresh-connection policy is Meta-only and applied at exactly the fresh start and the fresh completion", () => {
    expect(codeOf("modules/connections/domain/model.ts")).toMatch(/SINGLE_CONNECTION_PROVIDERS = \["meta"\] as const/);
    const application = codeOf("modules/connections/application/authorization.ts");
    expect([...application.matchAll(/\.serializeFresh\(/g)]).toHaveLength(2);
    // Call sites: only the application layer (the store defines it; the port declares it).
    const callers = sourceFiles(PRODUCTION_ROOTS).filter((file) => /\.serializeFresh\(/.test(codeOf(file)));
    // Fresh start, fresh completion (authorization.ts) and the Meta removal (management.ts, Step 7G-F4C).
    expect(callers).toEqual(["modules/connections/application/authorization.ts", "modules/connections/application/management.ts"]);
    expect([...codeOf("modules/connections/application/management.ts").matchAll(/\.serializeFresh\(/g)]).toHaveLength(1);
  });

  it("cross-creator invalidation is ONE write-only definer, called only by the connections store during a Meta removal", () => {
    const users = sourceFiles(PRODUCTION_ROOTS).filter((file) => /invalidate_open_fresh_meta_attempts|\.invalidateOpenFresh\(/.test(codeOf(file)));
    expect(users.sort()).toEqual(["modules/connections/application/management.ts", STORE]);
    const migration = readFileSync(path.join(REPOSITORY_ROOT, "db/migrations/0012_remove_invalidates_fresh_meta_attempts.sql"), "utf8");
    expect([...migration.matchAll(/create function ([a-z_.]+)\(/g)].map((match) => match[1])).toEqual(["connections.invalidate_open_fresh_meta_attempts"]);
    expect(migration).toMatch(/invalidate_open_fresh_meta_attempts\(p_closed_at timestamptz\) returns void/);
    expect(migration).not.toMatch(/returns (table|setof|integer|bigint|boolean|record)|execute format|execute '|\bexecute\s+v_/i);
    expect(migration).not.toMatch(/to authenticated[^;]*select|for select to authenticated|alter policy|drop policy|create policy [a-z_]+ on [a-z_.]+ for (select|update) to authenticated/i);
    expect(migration).toMatch(/revoke all on function connections\.invalidate_open_fresh_meta_attempts\(timestamptz\) from public;/);
    expect([...migration.matchAll(/grant execute on function ([^;]+);/g)].map((match) => match[1])).toEqual(["connections.invalidate_open_fresh_meta_attempts(timestamptz) to authenticated"]);
  });

  it("account activation reads its Connection FOR SHARE (link and Move activation), so REMOVED stays terminal", () => {
    expect(codeOf("modules/connections/application/linking.ts")).toMatch(/store\.connections\.getForShare\(asset\.connectionId\)/);
    expect(codeOf("modules/connections/application/moves.ts")).toMatch(/store\.connections\.getForShare\(move\.connectionId\)/);
    expect(codeOf(STORE)).toMatch(/getForShare: \(id\) => getConnection\(tx, id, "share"\)/);
  });
});
