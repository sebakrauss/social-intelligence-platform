/**
 * RELEASE-TOOLING-01 — the 0034 rollout runbook stays consistent with the tooling it tells an operator to run: the
 * reconciliation CLI's development target, flags and confirmation phrase; the migration runner's lock-wait flag,
 * default and range; the release order (worker, then reconcile EVERY workspace, then — only then — the web); the
 * Inbox-wide impact; and the standing block on deployment until a worker recovery path is verified. A tooling change
 * that the runbook does not follow (or the reverse) fails here. RUNBOOK-ALIGN-01 adds the guards of the corrected
 * release window (second describe block).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MIGRATION_LOCK_TIMEOUT_MS, MIGRATION_LOCK_TIMEOUT_RANGE_MS } from "@/tools/db/migrations";
import { DEV_RECONCILE_CONFIRMATION, RECONCILE_TARGETS } from "@/tools/ops/workflow-reconcile-command";
import { parseSwitchCommand } from "@/tools/ops/switch-command";
import { REASON_CODES } from "@/tools/ops/switches";
import { PLATFORMS, SWITCHES } from "@/platform/flags/registry";
import { COMMENTS_WORKSPACES_ENV, parseCommentsAllowlist } from "@/server/inbox/comments-access";
import { webJobRuntime } from "@/server/jobs/outbox-notifier";
import { parseRecoveryArguments } from "@/tools/trigger/recover-release";
import { IN_PROGRESS_DEPLOYMENT_STATUSES, KNOWN_WORKER_WEB_INCOMPATIBILITIES, RECOVERY_EVIDENCE_DIRECTORY, RECOVERY_ORDER, TERMINAL_DEPLOYMENT_STATUSES, recoveryConfirmation } from "@/tools/trigger/recovery-plan";
import { REPOSITORY_ROOT } from "../support/source-scan";

const RUNBOOK = "design/workflow/runbooks/0034-comments-workflow-rollout.md";
const runbook = (): string => readFileSync(path.join(REPOSITORY_ROOT, RUNBOOK), "utf8");
const stepRow = (text: string, step: number): string => text.split("\n").find((line) => line.startsWith(`| **${String(step)}. `)) ?? "";
const windowRow = (text: string, step: number): string => text.split("\n").find((line) => line.startsWith(`| **W${String(step)}. `)) ?? "";
const source = (file: string): string => readFileSync(path.join(REPOSITORY_ROOT, file), "utf8");
/** The text of one `### Heading` section, up to the next `##`/`###` heading (or the given bold paragraph, up to the next one). */
const section = (text: string, heading: string): string => {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length);
  const end = heading.startsWith("**") ? rest.search(/\n(?:\*\*[A-Z][^*\n]*\*\*|#{2,3} )/) : rest.search(/\n#{2,3} /);
  return heading + (end < 0 ? rest : rest.slice(0, end));
};

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

  it("RECOVERY-TOOLING-01/-02/-03: worker recovery is the guarded forward recovery tool; X-3 is approved for DEV recovery readiness only and authorizes no deployment (03C PASS is synthetic only)", () => {
    const text = runbook();
    expect(text).toMatch(/The block stayed until\s+(?:> )?\*\*X-3 is approved by the Product Owner\*\*/);
    expect(text).toMatch(/X-3 is \*\*APPROVED for DEV recovery readiness only\*\* \(§Product Owner\s+(?:> )?decisions\)\. That approval lifts the recovery-path block for DEV\. It authorizes \*\*no\*\* release step/);
    expect(text).toMatch(/\| Worker \| \*\*Forward recovery:\*\* `npm run trigger:recover`/);
    expect(text).toMatch(/Rehearsed end to end on three isolated synthetic projects only \(`RECOVERY-REHEARSAL-03C`: PASS\)/);
    expect(text).toContain("X-3 **APPROVED for DEV recovery readiness only** (§Recovery status). Deployment still needs each step's own authorization.");
    // The three concepts stay separate; operational recovery never ran.
    expect(text).toContain("1. **Verified synthetic recovery**");
    expect(text).toContain("2. **Operational recovery readiness** — X-3 is **APPROVED for DEV recovery readiness only** (RUNBOOK-CLOSE-01, 2026-11-23)");
    expect(text).toContain("**It has not been granted**: each mutating step (W3–W13) needs its own authorization.");
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

/**
 * RUNBOOK-ALIGN-01 — the five corrections of DEV-RELEASE-PREP-01 §2 stay in the runbook, and stay tied to the code they
 * describe: the managed T-26 runs only its two entrypoints, from the right source on each side of 0034; the release window
 * is a sequence of separately authorized steps with explicit STOP conditions; the G2/G3 uncertainty and the backup risk
 * acknowledgment stay explicit; a recovery PLAN ONLY is never read as an apply authorization; the Comments allowlist stays
 * absent until step 9.
 */
describe("0034 rollout runbook — RUNBOOK-ALIGN-01 corrections", () => {
  const T26_COMMAND = "npx vitest run --config vitest.db-managed.config.ts tests/db/managed/t26.test.ts tests/db/managed/introspection.test.ts";

  it("managed T-26: only the two targeted entrypoints, never the full managed suite; 97dcaee before 0034, 24dcacc after", () => {
    const text = runbook();
    const t26 = section(text, "### Managed T-26 (W3 and W7)");
    expect(t26).toContain(T26_COMMAND);
    for (const file of ["tests/db/managed/t26.test.ts", "tests/db/managed/introspection.test.ts"]) expect(existsSync(path.join(REPOSITORY_ROOT, file)), file).toBe(true);
    // Why the full suite is never run: the package script runs the whole managed config, and that config includes every file.
    expect(t26).toContain("**Never execute the full `test:db:managed` suite as part of this release window.**");
    const scripts = (JSON.parse(source("package.json")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["test:db:managed"]).toBe("node tools/db/run-managed-tests.ts");
    expect(source("vitest.db-managed.config.ts")).toContain('include: ["tests/db/managed/**/*.test.ts"]');
    for (const line of text.split("\n").filter((entry) => entry.includes("test:db:managed"))) expect(line, line).toMatch(/never/i);
    // Why the pre-migration run needs 97dcaee: the managed setup refuses while any repository migration is pending.
    expect(source("tests/db/managed/global-setup.ts")).toContain("managed suite refused: migrations pending");
    expect(t26).toContain("**Before migration 0034 (W3): clean source `97dcaee`.**");
    expect(t26).toContain("**After migration 0034 (W7): clean source `24dcacc`, or a verified code-identical successor.**");
    expect(windowRow(text, 3)).toContain("source **`97dcaee`**");
    expect(windowRow(text, 7)).toContain("source **`24dcacc`**");
    expect(stepRow(text, 1)).toMatch(/The pre-migration managed T-26 and introspection are \*\*W3\*\*, a managed write under its own authorization/);
    expect(stepRow(text, 3)).toMatch(/\*\*post-migration managed T-26 and introspection\*\* are green \(W7: source `24dcacc`/);
    expect(stepRow(text, 1)).not.toMatch(/Managed T-26 is green/);
    // A managed write with its own authorization; the fixture is checked first; cleanup residue stops the window.
    expect(t26).toContain("**T-26 writes synthetic fixtures to the managed DEV database and requires separate authorization:**");
    expect(t26).toContain("**verify whether `t26_fixture` already exists**");
    expect(source("tests/db/support/t26-fixture.sql")).toContain("create schema t26_fixture");
    expect(t26).toContain("**Incomplete fixture cleanup is a STOP condition.**");
    expect(source("tests/db/support/world.ts")).toMatch(/export async function cleanupWorld/);
    expect(t26).toMatch(/Roles are never created, dropped or recreated on the managed project \(R8\)/);
  });

  it("the release window W1–W13 keeps its order, an own authorization for every mutating step, and every STOP condition", () => {
    const text = runbook();
    const titles = Array.from({ length: 13 }, (_, index) => windowRow(text, index + 1).split("**")[1] ?? "");
    expect(titles).toEqual([
      "W1. Billing and provider health",
      "W2. Backup freshness and DEV identity",
      "W3. Pre-migration managed T-26",
      "W4. Ingestion pause",
      "W5. No unintended writers",
      "W6. Migration 0034",
      "W7. Post-migration managed T-26",
      "W8. Coordinated three-plane worker release",
      "W9. New workers and old runs",
      "W10. Reconciliation",
      "W11. Web release",
      "W12. Functional validation",
      "W13. Controlled ingestion resumption and monitoring",
    ]);
    expect(text).toContain("**It is not a script and not one authorization.** Each mutating W step needs its **own authorization**, and none authorizes the next.");
    for (const step of [3, 4, 6, 7, 8, 10, 11, 13]) expect(windowRow(text, step), `W${String(step)}`).toContain("**own authorization**");
    // The pause and resume use the real switch, for every platform the switch knows.
    expect(windowRow(text, 4)).toContain("--key ingestion.provider_pause --qualifier <platform> --scope global --value '{\"paused\":true}'");
    expect(windowRow(text, 13)).toContain("ops:switch -- clear --target development --key ingestion.provider_pause --qualifier <platform>");
    for (const platform of PLATFORMS) expect(windowRow(text, 4), platform).toContain(`\`${platform}\``);
    // The STOP conditions the PO named.
    expect(windowRow(text, 1)).toContain("**provider health problem**");
    expect(windowRow(text, 2)).toContain("**stale backup**");
    expect(windowRow(text, 3)).toContain("**incomplete fixture cleanup**");
    expect(windowRow(text, 7)).toContain("**incomplete fixture cleanup**");
    expect(windowRow(text, 8)).toContain("**a failed worker release**");
    expect(windowRow(text, 9)).toContain("**undrained incompatible jobs**");
    expect(windowRow(text, 10)).toContain("**unsuccessful reconciliation**");
    // The web goes after reconciliation; the worker step is followed by a NEW recovery plan.
    expect(windowRow(text, 11)).toMatch(/^\| \*\*W11\. Web release\*\* \| 7 \| W10 clean everywhere/);
    expect(windowRow(text, 9)).toContain("a **new recovery PLAN ONLY** with the current provider versions and queues");
    // The release commit is whatever origin/main is when the window opens (the release tool refuses anything else).
    expect(windowRow(text, 8)).toContain("clean release worktree at the release commit (below)");
    expect(text).toContain("- `trigger:release` releases only `HEAD == origin/main`. The code baseline verified for this release is `24dcacc`.");
    expect(source("tools/trigger/deploy-release-pair.ts")).toContain("HEAD is not origin/main");
  });

  it("G2 and G3 uncertainty stays explicit and DEV-only; no baseline worker before 0034; the relay pin is absent by configuration only", () => {
    const text = runbook();
    const legacy = section(text, "**Legacy v2 release evidence.**");
    expect(legacy).toContain("the current operational known-good worker source is `ff5269c`, and the current operational version is `20261113.1`");
    expect(legacy).toContain("holds **no contentHash**");
    expect(legacy).toContain("`RECOVERED_FINGERPRINT_UNVERIFIED`");
    expect(legacy).toContain("**No new worker baseline may be deployed before migration 0034 merely to obtain a fingerprint.**");
    expect(legacy).toContain("**This limitation requires explicit DEV-only risk acceptance**");
    expect(legacy).toContain("It never extends to production.");
    expect(text).not.toMatch(/new fingerprinted \(v3\) baseline release/i);
    // Why no baseline: the current worker writes the Workflow projection in every ingestion transaction (needs 0034).
    expect(source("server/persistence/ingestion.ts")).toContain("createPostgresWorkflowProjectionStore");

    const pin = section(text, "### Web relay pin and Trigger credentials (G3)");
    expect(pin).toContain("**`TRIGGER_EXTERNAL_DEPLOYMENT_ID` is absent by configuration**");
    expect(pin).toContain("**`TRIGGER_SECRET_KEY` is also absent.**");
    expect(pin).toContain("**The effective runtime configuration of the in-service deployment has not been directly inspected.**");
    expect(pin).toContain("**This does not prove that every future web feature works without Trigger credentials.**");
    expect(text).not.toContain("which is not yet known");
    // The code fact behind "the pin is never read without the key".
    expect(webJobRuntime({})).toBeUndefined();
    expect(webJobRuntime({ TRIGGER_EXTERNAL_DEPLOYMENT_ID: "pinned-but-inert" })).toBeUndefined();
  });

  it("the backup recovery point needs the PO's acknowledgment; a backup's existence is never a tested restore", () => {
    const text = runbook();
    const backups = section(text, "### Backups and the recovery point (W2)");
    for (const required of [
      "A Supabase **Pro** entitlement",
      "A visible **Completed PHYSICAL backup**",
      "**verified immediately before the migration**",
      "A **PO-approved maximum backup age**",
      "**restoration has never been tested**",
      "**changes after the recovery point can be lost**",
      "**The existence of a backup is never evidence of a successful restoration.**",
    ]) expect(backups, required).toContain(required);
    expect(stepRow(text, 2)).toContain("**Completed PHYSICAL backup**");
    expect(stepRow(text, 2)).toContain("**PO-approved maximum backup age**");
    expect(stepRow(text, 2)).toContain("**restoration has never been tested**");
    expect(stepRow(text, 2)).not.toContain("logical dump of `conversations`, `interactions`, `audit`");
    expect(stepRow(text, 2)).toMatch(/\| PO \| no recovery point within the approved age, no PO acknowledgment of the untested restore/);
  });

  it("a recovery PLAN ONLY is never an apply authorization; 'nothing to recover' is legitimate before step 4; a new plan after it", () => {
    const text = runbook();
    const plan = section(text, "**What a recovery PLAN ONLY shows**");
    expect(plan).toContain("**PLAN ONLY deploys nothing and writes no record. PLAN ONLY is not an authorization to recover.**");
    expect(plan).toContain("**An exit code of 0 does not mean the plan is ready for APPLY.**");
    expect(plan).toContain('an initial plan **legitimately reports "nothing to recover"**');
    expect(plan).toContain("a **new** PLAN ONLY is required, with the current provider versions and queues");
    expect(plan).toContain("An earlier plan is never reused for an apply.");
    // The wording the operator compares against is the tool's own.
    const operator = source("tools/trigger/recover-release.ts");
    for (const phrase of [
      "every plane already runs the known-good release's own deployment; there is nothing to recover",
      "the approved release recorded no content fingerprint",
      "web rollback required first",
      "Every apply prerequisite is met",
    ]) {
      expect(plan, phrase).toContain(phrase);
      expect(operator, phrase).toContain(phrase);
    }
    // A proven pairing rests on deployment history, never on the flag alone.
    expect(text).toContain("**The flag only records an attestation; it proves nothing.** Pass it only when **historical deployment evidence** shows that exact pairing in service");
    expect(text).not.toContain("is such a proven pairing (DEV-PREFLIGHT-02)");
    expect(stepRow(text, 2)).toContain('**legitimately reports "nothing to recover"**');
    expect(stepRow(text, 2)).toContain("it is never an authorization to recover");
    expect(stepRow(text, 2)).not.toContain("no structural refusal");
  });

  it("the Comments allowlist stays absent through the whole window and changes only in step 9", () => {
    const text = runbook();
    expect(COMMENTS_WORKSPACES_ENV).toBe("COMMENTS_REDESIGN_WORKSPACES");
    expect(parseCommentsAllowlist(undefined).size).toBe(0);
    expect(text).toContain("The Comments allowlist (step 9) is **outside** the window: `COMMENTS_REDESIGN_WORKSPACES` stays absent through W13.");
    expect(windowRow(text, 11)).toContain("`COMMENTS_REDESIGN_WORKSPACES` still absent");
    expect(windowRow(text, 12)).toContain("the allowlist stays absent");
    for (let step = 1; step <= 13; step += 1) {
      const row = windowRow(text, step);
      if (row.includes(COMMENTS_WORKSPACES_ENV)) expect(row, `W${String(step)}`).toMatch(/absent/);
    }
    expect(stepRow(text, 9)).toMatch(/\*\*Explicit, separate authorization\*\* before `COMMENTS_REDESIGN_WORKSPACES` changes/);
  });
});

/**
 * RUNBOOK-CLOSE-01 — the Product Owner's DEV-only decisions (G2, G3, C-1 with a 24-hour backup age, X-3) are recorded
 * apart from execution authorization, never extend to production and weaken no STOP condition; step 1 is a read-only
 * preflight that never runs or authorizes T-26; the release commit is the verified origin/main, and a successor is
 * documentation and architecture tests only.
 */
describe("0034 rollout runbook — RUNBOOK-CLOSE-01 decisions", () => {
  it("the DEV-only decisions are recorded apart from execution authorization and keep every check and STOP", () => {
    const text = runbook();
    const decisions = section(text, "## Product Owner decisions (RUNBOOK-CLOSE-01, 2026-11-23) — DEV only");
    expect(decisions).toContain("They never apply to production.");
    expect(decisions).toMatch(/\| \*\*G2\*\* \(legacy worker fingerprint\) \| \*\*ACCEPTED — DEV ONLY\*\* \|[^\n]*`RECOVERED_FINGERPRINT_UNVERIFIED`/);
    expect(decisions).toMatch(/\| \*\*G3\*\* \(web relay pin\) \| \*\*ACCEPTED — DEV ONLY\*\* \|[^\n]*has not been directly observed/);
    expect(decisions).toMatch(/\| \*\*C-1\*\* \(recovery point\) \| \*\*ACCEPTED WITH CONDITIONS — DEV ONLY\*\* \|[^\n]*\*\*no older than 24 hours\*\*/);
    expect(decisions).toContain("**restoration has never been tested**");
    expect(decisions).toContain("**changes after the backup could be lost**");
    expect(decisions).toContain("**If no eligible backup is available: STOP.** This acceptance never authorizes proceeding without a recovery point");
    expect(decisions).toMatch(/\| \*\*X-3\*\* \(worker recovery readiness\) \| \*\*APPROVED for DEV recovery readiness only\*\* \|/);
    // Every acceptance line is DEV-only; nothing is accepted for production.
    for (const line of text.split("\n").filter((entry) => /ACCEPTED/.test(entry))) expect(line, line).toMatch(/DEV ONLY|DEV only/);
    // Approvals are not execution authorization: each release operation stays separately authorized.
    expect(decisions).toContain("**These decisions are not execution authorization.**");
    for (const operation of ["managed T-26", "the ingestion pause", "migration 0034", "the worker deployment", "reconciliation", "the web deployment"]) {
      expect(decisions, operation).toContain(`- ${operation}`);
    }
    for (const kept of [
      "its freshness is verified **immediately before the migration** (W2)",
      "its configuration is verified again, read-only, by name",
      "the historical pairing is confirmed from deployment evidence",
      "the active workers and the provider deployment status are re-checked",
      "billing is confirmed paid, and the service is confirmed healthy (W1)",
      "every mutating release step is independently authorized",
    ]) expect(decisions, kept).toContain(kept);
    expect(decisions).toContain("**The approvals do not weaken any STOP condition.**");
    // The STOP conditions stay, and the backup STOP carries the accepted 24-hour age.
    expect(windowRow(text, 2)).toContain("backup timestamp **at most 24 hours** old (C-1)");
    expect(windowRow(text, 2)).toContain("**stale backup** (older than 24 hours, not Completed, not PHYSICAL, or none: no eligible backup)");
    expect(section(text, "### Backups and the recovery point (W2)")).toContain("**24 hours** (C-1, RUNBOOK-CLOSE-01). An older backup is a **stale backup**: STOP. **If no eligible backup is available, STOP**");
    for (const step of [3, 4, 6, 7, 8, 10, 11, 13]) expect(windowRow(text, step), `W${String(step)}`).toContain("**own authorization**");
  });

  it("step 1 is a read-only preflight that never runs or authorizes the managed T-26 (W3)", () => {
    const text = runbook();
    const step1 = stepRow(text, 1);
    expect(step1).toContain("A **read-only preflight**: it re-verifies the baseline and the existing evidence, and writes nothing.");
    expect(step1).toContain("Step 1 does **not** run or authorize managed T-26: **a completed preflight is not permission to write synthetic fixtures.**");
    expect(step1).not.toMatch(/T-26 and introspection\*\* are green/);
    expect(windowRow(text, 3)).toMatch(/^\| \*\*W3\. Pre-migration managed T-26\*\* \| between 2 and 3 \| W2\. Not part of step 1's read-only preflight\. \|/);
    expect(windowRow(text, 3)).toContain("**own authorization** (managed write)");
  });

  it("the release commit is the verified origin/main; a successor is documentation and architecture tests only, and never changes the operators", () => {
    const text = runbook();
    const release = section(text, "**Release commit (W7, W8, W11).**");
    expect(release).toContain("**The release commit must equal the current verified `origin/main` at the window.**");
    expect(release).toContain("its diff from `24dcacc` touches nothing outside the approved documentation (`design/`, `docs/`) and architecture-test files (`tests/architecture/`)");
    expect(release).toContain("database migrations, product code, worker code, release operators, dependencies or environment configuration is **not** a documentation-only successor");
    expect(release).toContain("The release operators are never changed to accommodate a successor.");
    expect(release).toContain("The worker (W8) and the web (W11) always release from the same verified commit.");
    // The post-migration T-26 successor rule still excludes its database and test contracts.
    expect(section(text, "### Managed T-26 (W3 and W7)")).toContain("touches nothing under `db/`, `platform/`, `tools/db/`, `tests/db/` or `vitest.db-managed.config.ts`");
  });
});

/**
 * D-6 (WINDOW-PREP-01) — every operational switch command the runbook prints runs as written: the runbook's W4, W13 and
 * R1 once used `--reason` values (`release-0034`, `worker-recovery`) that `ops:switch` and the database refuse. Each
 * `npm run ops:switch -- …` command is parsed by the tool's own parser for every platform, with and without `--apply`
 * where that applies; every `--reason` in the runbook is one of the tool's reason codes; no bare `ops:switch`
 * reference stands in for a command.
 */
describe("0034 rollout runbook — ops:switch commands match the real parser (D-6)", () => {
  const OPERATOR = "operator-check";
  const commands = (text: string): string[] => [...text.matchAll(/`npm run ops:switch -- ([^`]+)`/g)].map((match) => match[1] ?? "");
  const tokens = (command: string): string[] => [...command.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
  const instantiate = (command: string, platform: string): string[] => tokens(command.replaceAll("<platform>", platform).replaceAll("<id>", OPERATOR));

  it("every --reason in the runbook is a reason code the tool and the database accept", () => {
    const text = runbook();
    const reasons = [...text.matchAll(/--reason ([A-Za-z0-9_-]+)/g)].map((match) => match[1] ?? "");
    expect(reasons.length).toBeGreaterThanOrEqual(4);
    for (const reason of reasons) expect(REASON_CODES as readonly string[], reason).toContain(reason);
    // The database enforces the same set (0005 switch history), so the tool's list is the authority.
    expect(source("db/migrations/0005_job_foundation.sql")).toContain(`reason_code     text not null check (reason_code in (${REASON_CODES.map((code) => `'${code}'`).join(", ")}))`);
    const scripts = (JSON.parse(source("package.json")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["ops:switch"]).toBe("node tools/ops/switch.ts");
  });

  it("every ops:switch command the runbook prints parses for every platform, with and without --apply", () => {
    const text = runbook();
    // No bare reference: every `…ops:switch…` code span is a complete npm command.
    for (const span of text.match(/`[^`]*ops:switch[^`]*`/g) ?? []) expect(span, span).toMatch(/^`npm run ops:switch -- (set|clear|show) --target development /);
    const found = commands(text);
    expect(found.length).toBeGreaterThanOrEqual(5);
    for (const command of found) {
      for (const platform of PLATFORMS) {
        const argv = instantiate(command, platform);
        const parsed = parseSwitchCommand(argv);
        expect(parsed.ok ? "ok" : parsed.problem, `${platform}: ${command}`).toBe("ok");
        if (argv[0] !== "show" && !argv.includes("--apply")) {
          const applied = parseSwitchCommand([...argv, "--apply"]);
          expect(applied.ok ? "ok" : applied.problem, `${platform} --apply: ${command}`).toBe("ok");
        }
      }
    }
  });

  it("the pause, resume, abort and containment commands carry the reviewed reasons", () => {
    const text = runbook();
    expect(windowRow(text, 4)).toContain("--value '{\"paused\":true}' --operator <id> --reason release`");
    expect(windowRow(text, 4)).toContain("ops:switch -- show --target development --key ingestion.provider_pause --qualifier <platform>`");
    expect(windowRow(text, 4)).toContain("--scope global --operator <id> --reason rollback` per platform (reverts this step's pause)");
    expect(windowRow(text, 13)).toContain("ops:switch -- clear --target development --key ingestion.provider_pause --qualifier <platform> --scope global --operator <id> --reason release`");
    const r1 = text.split("\n").find((line) => line.startsWith("| R1 |")) ?? "";
    expect(r1).toContain("--operator <id> --reason incident --apply`");
    expect(r1).toContain("The reason is `incident`: R1 contains a faulty release while it is recovered");
    expect(text).not.toMatch(/release-0034|worker-recovery/);
  });
});
