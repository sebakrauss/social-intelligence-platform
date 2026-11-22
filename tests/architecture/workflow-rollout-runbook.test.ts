/**
 * RELEASE-TOOLING-01 — the 0034 rollout runbook stays consistent with the tooling it tells an operator to run: the
 * reconciliation CLI's development target, flags and confirmation phrase; the migration runner's lock-wait flag,
 * default and range; the release order (worker, then reconcile EVERY workspace, then — only then — the web); the
 * Inbox-wide impact; and the standing block on deployment until a worker recovery path is verified. A tooling change
 * that the runbook does not follow (or the reverse) fails here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MIGRATION_LOCK_TIMEOUT_MS, MIGRATION_LOCK_TIMEOUT_RANGE_MS } from "@/tools/db/migrations";
import { DEV_RECONCILE_CONFIRMATION, RECONCILE_TARGETS } from "@/tools/ops/workflow-reconcile-command";
import { SWITCHES } from "@/platform/flags/registry";
import { parseRecoveryArguments } from "@/tools/trigger/recover-release";
import { IN_PROGRESS_DEPLOYMENT_STATUSES, KNOWN_WORKER_WEB_INCOMPATIBILITIES, RECOVERY_EVIDENCE_DIRECTORY, RECOVERY_ORDER, TERMINAL_DEPLOYMENT_STATUSES, recoveryConfirmation } from "@/tools/trigger/recovery-plan";
import { REPOSITORY_ROOT } from "../support/source-scan";

const RUNBOOK = "design/workflow/runbooks/0034-comments-workflow-rollout.md";
const runbook = (): string => readFileSync(path.join(REPOSITORY_ROOT, RUNBOOK), "utf8");
const stepRow = (text: string, step: number): string => text.split("\n").find((line) => line.startsWith(`| **${String(step)}. `)) ?? "";

describe("0034 rollout runbook ↔ release tooling", () => {
  it("deployment is blocked until a worker recovery path is verified; promote is not assumed; history is never rewritten", () => {
    const text = runbook();
    expect(text).toMatch(/\*\*DEPLOYMENT IS BLOCKED\*\* until a supported, executable worker recovery path has been verified and approved/);
    expect(text).toMatch(/TRIGGER-ROLLBACK-REHEARSAL-01/);
    expect(text).toMatch(/\*\*Do not assume it works\.\*\*/);
    expect(text).toMatch(/\*\*Never\*\* use force push or any history rewrite as a rollback/);
    expect(stepRow(text, 2)).toMatch(/worker recovery path is rehearsed and approved/);
  });

  it("the nine steps run in the approved order: preflight, backups, 0034, worker, reconcile, verify, web, acceptance, allowlist", () => {
    const text = runbook();
    const titles = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((step) => stepRow(text, step).split("**")[1] ?? "");
    expect(titles).toEqual([
      "1. Preflight and database metadata",
      "2. Backups and verified recovery",
      "3. Migration 0034",
      "4. Coordinated worker release",
      "5. Reconcile every workspace",
      "6. Reconciliation verification and exceptions",
      "7. Web deployment from the clean release worktree",
      "8. Authenticated DEV acceptance",
      "9. Comments allowlist",
    ]);
    // The web goes live only after reconciliation is clean everywhere; the worker step releases no web.
    expect(stepRow(text, 7)).toMatch(/\*\*Only after step 6 is clean for every workspace\.\*\*/);
    expect(stepRow(text, 4)).toMatch(/\*\*The web is NOT released in this step\.\*\*/);
    expect(stepRow(text, 9)).toMatch(/\*\*Explicit, separate authorization\*\* before `COMMENTS_REDESIGN_WORKSPACES` changes/);
    expect(text).toMatch(/never the web before reconciliation/);
  });

  it("the Inbox-wide impact is explicit: the allowlist does not protect the rollout", () => {
    const text = runbook();
    expect(text).toMatch(/\*\*classic Inbox list of every workspace\*\*/);
    expect(text).toMatch(/It does \*\*not\*\* protect the rollout as a whole/);
  });

  it("the reconciliation commands are the CLI's own: the development target, its flags and the exact confirmation phrase", () => {
    const text = runbook();
    expect(RECONCILE_TARGETS).toEqual(["loopback", "development"]);
    expect(stepRow(text, 5)).toContain("npm run ops:workflow-reconcile -- --target development --database-url-env DATABASE_WORKER_URL --workspace <id>");
    expect(stepRow(text, 5)).toContain(`--apply --confirm-dev-reconcile ${DEV_RECONCILE_CONFIRMATION}`);
    expect(stepRow(text, 5)).toMatch(/--after <next> --run <runCorrelationId>/);
    expect(text).toMatch(/The CLI reads no `\.env` file\. The operator exports only `DATABASE_WORKER_URL` and `DATABASE_SSL_ROOT_CERT`/);
    // The package script the runbook names exists.
    const scripts = (JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["ops:workflow-reconcile"]).toBe("node tools/ops/workflow-reconcile.ts");
    expect(scripts["db:migrate"]).toBe("node tools/db/migrate.ts");
    expect(scripts["trigger:release"]).toBe("node tools/trigger/deploy-release-pair.ts");
  });

  it("the migration step uses the runner's lock-wait flag, default and range — and says the timeout bounds only the wait", () => {
    const text = runbook();
    expect(stepRow(text, 3)).toContain("npm run db:migrate -- --target development --apply --lock-timeout-ms <n>");
    expect(stepRow(text, 3)).toContain(`(default ${String(DEFAULT_MIGRATION_LOCK_TIMEOUT_MS)})`);
    expect(text).toContain(`Default ${String(DEFAULT_MIGRATION_LOCK_TIMEOUT_MS)} ms; \`--lock-timeout-ms\` accepts ${String(MIGRATION_LOCK_TIMEOUT_RANGE_MS.min)}–${String(MIGRATION_LOCK_TIMEOUT_RANGE_MS.max)}`);
    expect(text).toMatch(/\*\*`lock_timeout` limits only the WAIT for a lock\.\*\*/);
  });

  it("releases come from a clean, disposable worktree at the approved commit; secrets and evidence are never copied", () => {
    const text = runbook();
    expect(text).toMatch(/git worktree add --detach \.\.\/wrenkind-release-<sha8> <sha>/);
    expect(text).toMatch(/node tools\/trigger\/fetch-aws-signing-helper\.ts/);
    expect(text).toMatch(/Never copy `\.env\*`, credentials, `\.next\/`, `tools\/perf\/` or any generated artifact/);
    expect(text).toMatch(/git worktree remove \.\.\/wrenkind-release-<sha8>/);
    expect(stepRow(text, 4)).toMatch(/from the clean release worktree/);
    // The upload boundary the web step relies on.
    expect(readFileSync(path.join(REPOSITORY_ROOT, ".vercelignore"), "utf8")).toMatch(/^\/tools\/perf\/$/m);
  });

  it("RECOVERY-TOOLING-01/-02/-03: worker recovery is the guarded forward recovery tool; deployment stays blocked until X-3 is approved (03C PASS is synthetic only)", () => {
    const text = runbook();
    expect(text).toMatch(/The block stays until\s+(?:> )?\*\*X-3 is approved by the Product Owner\*\*/);
    expect(text).toMatch(/\| Worker \| \*\*Forward recovery:\*\* `npm run trigger:recover`/);
    expect(text).toMatch(/Rehearsed end to end on three isolated synthetic projects only \(`RECOVERY-REHEARSAL-03C`: PASS\)/);
    expect(text).toMatch(/deployment stays blocked until X-3 is approved/);
    // The three concepts stay separate; operational recovery never ran.
    expect(text).toContain("1. **Verified synthetic recovery**");
    expect(text).toContain("2. **Operational recovery readiness** — X-3 is **CONDITIONAL**, not approved.");
    expect(text).toContain("3. **Authorization to deploy DEV** — a separate Product Owner gate (steps 3 onward). Neither of the above grants it.");
    expect(text.match(/\*\*Operational DEV recovery has not been executed\.\*\*/g)).toHaveLength(2);
    // RECOVERY-TOOLING-03 (03C G1): never continue while a remote deployment is not terminal.
    expect(text).toContain("**Remote deployments in progress**");
    expect(text).toMatch(/Interrupting the local CLI does \*\*not\*\* cancel its deployment/);
    expect(text).toMatch(/Recovery must not continue while the provider reports a deployment that is not terminal/);
    for (const status of [...IN_PROGRESS_DEPLOYMENT_STATUSES, ...TERMINAL_DEPLOYMENT_STATUSES]) expect(text, status).toContain(`\`${status}\``);
    expect(text).toMatch(/The tool never cancels, forces or retries a provider build, and there is no override/);
    expect(text).toMatch(/Queued and delayed runs were observed executing on the version active \*\*when they started\*\*/);
    expect(text).toMatch(/Runs explicitly pinned to an earlier deployment keep using it even after the recovery/);
    expect(text).toMatch(/The old operational release `ff5269c` still lacks a recorded worker content fingerprint/);
    expect(text).toMatch(/\| Schema \| \*\*Never rolled back\.\*\*/);
    const scripts = (JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["trigger:recover"]).toBe("node tools/trigger/recover-release.ts");
    // The order, the worktree model, the evidence location and the confirmation are the tool's own.
    expect(RECOVERY_ORDER).toEqual(["integration", "intelligence", "main"]);
    expect(text).toContain("**Order: INTEGRATION → INTELLIGENCE → MAIN**");
    // RECOVERY-TOOLING-02: the source SHA and the recovery id are distinct; the id is never the SHA; never --force.
    expect(text).toContain("**Source SHA versus recovery id**");
    expect(text).toContain("`recovery-<sha12>-<UTC yyyymmddThhmmssZ>`");
    expect(text).toMatch(/It is \*\*never\*\* the known-good SHA/);
    expect(text).toMatch(/A zero exit that created nothing is \*\*never\*\* a recovery/);
    expect(text).toMatch(/and never the CLI's deploy force flag \(`--force`\)/);
    expect(text).toMatch(/A continuation never mints a new id: it uses the \*\*same recovery id\*\*/);
    expect(text).toMatch(/\*\*never\*\* the release being recovered from/);
    expect(text).toContain("**Legacy v2 release evidence.**");
    expect(text).toMatch(/git worktree add --detach \.\.\/wrenkind-recovery-<sha8> <known-good sha>/);
    expect(text).toMatch(/git worktree remove \.\.\/wrenkind-recovery-<sha8>/);
    expect(text).toContain(`${RECOVERY_EVIDENCE_DIRECTORY}/<timestamp>-<sha12>.json`);
    expect(text).toContain(`--confirm-recovery ${recoveryConfirmation("<sha12>")}`);
    // Every recovery flag the plan and apply checkpoints name is one the tool accepts.
    const rows = text.split("\n").filter((line) => /^\| R[34] \|/.test(line)).join(" ");
    const flags = [...new Set([...rows.matchAll(/--[a-z][a-z-]+/g)].map((match) => match[0]))];
    expect(flags.length).toBeGreaterThan(10);
    for (const flag of flags) expect(parseRecoveryArguments([flag, "x"]), flag).not.toEqual({ error: `unknown argument: ${flag}` });
    // Containment uses the real switch; the web goes first when the pairing is known to break; partial is never success.
    expect(SWITCHES["ingestion.provider_pause"].key).toBe("ingestion.provider_pause");
    expect(text).toContain("--key ingestion.provider_pause --qualifier <platform> --scope global --value '{\"paused\":true}'");
    expect(KNOWN_WORKER_WEB_INCOMPATIBILITIES.map((rule) => rule.id)).toEqual(["workflow-0034"]);
    expect(text).toMatch(/\(`workflow-0034`\) whatever is attested: \*\*roll the web back first\*\*/);
    expect(text).toMatch(/A partial recovery is \*\*never\*\* reported as successful/);
    expect(text).toMatch(/There is no automatic retry, reorder or restore/);
  });

  it("the dependency audit passes with no exception (DEPS-01) and is never bypassed", () => {
    expect(runbook()).toMatch(/\| CI dependency audit \| `PASS` with \*\*no exception\*\*.*\*\*Never bypassed\.\*\*/);
    expect(readFileSync(path.join(REPOSITORY_ROOT, "tools/audit-policy/exceptions.ts"), "utf8")).not.toMatch(/expiresOn: "\d{4}-\d{2}-\d{2}"/);
  });
});
