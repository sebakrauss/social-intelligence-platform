/**
 * TA-Q-07b runner.
 *   node scripts/run.mjs validate          sign in → preflight → provision (approved resources) → P → probe → audit
 *   node scripts/run.mjs reconcile         sign in → READ-ONLY check of existing resources against the approved plan
 *   node scripts/run.mjs audit --run <id>  sign in → audit only, for a previous run whose audit was incomplete
 *   node scripts/run.mjs cleanup --offline sign-in-free plan: ordered mutations, target state, key A policy diff
 *   node scripts/run.mjs cleanup           sign in → READ-ONLY dry-run (current state, preconditions, plan)
 *   node scripts/run.mjs cleanup --apply --confirm=<token>   mutations — only after explicit PO authorization
 *   node scripts/run.mjs cleanup-verify    sign in → READ-ONLY verification of the post-cleanup state
 * Exit codes: 0 PASS · 1 FAIL/STOP · 2 NOT RUN (configuration missing) · 3 PARTIAL (audit incomplete)
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { IAMClient } from "@aws-sdk/client-iam";
import { EVIDENCE_DIR, KEY_SLOTS, REGION, ROLE_NAMES, loadConfig } from "../lib/config.mjs";
import { callerIdentity, operatorSignIn } from "../lib/auth.mjs";
import { GuardError, allowExactTokens, describeError, log, safeStack, setRedactions, writeEvidence } from "../lib/guard.mjs";
import { guardPolicy, keyPolicy, keyPolicyAPostValidation, policyDiff, statementIds, trustPolicy } from "../lib/policies.mjs";
import { Recorder, StopValidation } from "../lib/recorder.mjs";
import { provision, resolveOperatorRole, verifyProvisioned } from "./provision.mjs";
import { probe } from "./probe.mjs";
import { audit } from "./audit.mjs";
import { inventoryChecks } from "./reconcile.mjs";
import { CONFIRM_TOKEN, applyCleanup, inspectForCleanup, plannedMutations, targetState } from "./cleanup.mjs";
import { collectPostCleanupSnapshot, evaluatePostCleanup, findAppliedCleanup } from "./verify-cleanup.mjs";
import { DescribeKeyCommand, KMSClient } from "@aws-sdk/client-kms";

// Reviewed policy statement IDs are static constants; only the ones that reach the long-opaque threshold
// need the exact-token exemption (see lib/guard.mjs allowExactTokens).
allowExactTokens(statementIds().filter((sid) => sid.length >= 40));

const [command, ...rest] = process.argv.slice(2);

function runIdNow() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

async function signIn(config) {
  const operator = await operatorSignIn(config);
  const identity = await callerIdentity(operator);
  if (identity.Account !== config.accountId) throw new StopValidation("signed-in account is not the expected development account");
  const iam = new IAMClient({ region: REGION, credentials: operator });
  const op = await resolveOperatorRole(iam, identity.Arn);
  setRedactions({ account: config.accountId, operator: op.operatorUser });
  const expiresIn = Math.round((operator.expiration.getTime() - Date.now()) / 1000);
  log(`[auth] account verified; operator role ${op.operatorRoleName}; session expires in ${String(Math.round(expiresIn / 60))} minutes`);
  return { operator, ...op, expiresIn };
}

/** Prints a redacted diagnostic (type, guarded message, frames); never throws. */
function reportDiagnostic(detail) {
  try {
    log(`[diag] ${detail.type}: ${detail.message}`);
    for (const frame of detail.frames) log(`[diag]   at ${frame.fn} (${frame.file}:${String(frame.line)})`);
  } catch {
    console.log("[diag] diagnostic withheld by output guard");
  }
}

function auditVerdict(result) {
  const complete = result.coverage.missing.length === 0;
  const clean = result.contextFindings.length === 0 && result.unexpectedKeys.length === 0 && result.plaintextFieldsLogged === 0;
  return { complete, clean, pass: complete && clean };
}

async function validate(config) {
  const runId = runIdNow();
  const dir = path.join(EVIDENCE_DIR, runId);
  const rec = new Recorder(runId);
  const manifest = { runId, startedAt: new Date().toISOString(), region: REGION, roles: ROLE_NAMES, aliases: Object.fromEntries(Object.entries(KEY_SLOTS).map(([s, v]) => [s, v.alias])) };
  let status = "FAIL";
  let stopReason = null;
  let stopDetail = null;
  let keyArns = null;
  let session = null;
  let probeResult = null;
  log(`[run] TA-Q-07b validation run ${runId} (${REGION}); synthetic data only`);
  try {
    session = await signIn(config);
    const account = config.accountId;
    const provisioned = await provision({ operator: session.operator, account, operatorRoleArn: session.operatorRoleArn });
    keyArns = provisioned.keyArns;
    manifest.keyIds = Object.fromEntries(Object.entries(provisioned.keys).map(([slot, meta]) => [slot, meta.KeyId]));
    writeEvidence(dir, "provision.json", { runId, actions: provisioned.actions });
    writeEvidence(dir, "policies.json", {
      note: "Rendered policies as applied; account ID redacted.",
      keyPolicies: Object.fromEntries(Object.keys(KEY_SLOTS).map((slot) => [slot, keyPolicy(slot, account)])),
      trustPolicy: trustPolicy(account, session.operatorRoleArn),
      guards: Object.fromEntries(Object.keys(ROLE_NAMES).map((role) => [role, guardPolicy(role, keyArns)])),
    });
    await verifyProvisioned({ operator: session.operator, account, operatorRoleArn: session.operatorRoleArn, keyArns, rec, sessionExpiresInSeconds: session.expiresIn });
    for (const c of await inventoryChecks({ operator: session.operator, keyArns })) rec.assert(c.id, c.title, c.pass);
    probeResult = await probe({ operator: session.operator, account, keyArns, rec, runId });
    status = "PROBE_PASS";
  } catch (error) {
    const expected = error instanceof StopValidation || error instanceof GuardError;
    stopReason = expected ? error.message : `unexpected error: ${describeError(error)}`;
    log(`[run] STOPPED — ${stopReason}`);
    if (!expected) {
      stopDetail = safeStack(error);
      reportDiagnostic(stopDetail);
    }
  }
  manifest.calls = rec.calls;
  manifest.finishedProbeAt = new Date().toISOString();
  writeEvidence(dir, "results.json", { runId, summary: rec.summary(), stopReason, stopDetail, cases: rec.cases, r6: probeResult?.r6 ?? null });
  writeEvidence(dir, "manifest.json", manifest);
  if (status !== "PROBE_PASS") return 1;

  const remaining = session.operator.expiration.getTime() - Date.now();
  let result;
  try {
    result = await audit({ operator: session.operator, manifest, keyArns, deadline: Date.now() + remaining - 120_000 });
  } catch (error) {
    log(`[audit] not completed: ${describeError(error)} — rerun: node scripts/run.mjs audit --run ${runId}`);
    return 3;
  }
  const verdict = auditVerdict(result);
  writeEvidence(dir, "audit.json", { runId, verdict, ...result });
  log(`[run] audit: coverage ${verdict.complete ? "complete" : "INCOMPLETE"}; context ${verdict.clean ? "clean" : "FINDINGS"}`);
  if (!verdict.complete) {
    log(`[run] PARTIAL — rerun the audit later: node scripts/run.mjs audit --run ${runId}`);
    return 3;
  }
  log(`[run] ${verdict.pass ? "PASS" : "FAIL"} — ${JSON.stringify(rec.summary())}`);
  return verdict.pass ? 0 : 1;
}

async function auditOnly(config, runId) {
  const dir = path.join(EVIDENCE_DIR, runId ?? "");
  const file = path.join(dir, "manifest.json");
  if (!runId || !existsSync(file)) {
    log("[audit] usage: node scripts/run.mjs audit --run <runId> (manifest not found)");
    return 2;
  }
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const session = await signIn(config);
  const keyArns = Object.fromEntries(Object.entries(manifest.keyIds).map(([slot, id]) => [slot, `arn:aws:kms:${REGION}:${config.accountId}:key/${id}`]));
  const result = await audit({ operator: session.operator, manifest, keyArns, firstWaitMinutes: 0, maxWaitMinutes: 10, deadline: session.operator.expiration.getTime() - 120_000 });
  const verdict = auditVerdict(result);
  let n = 2;
  while (existsSync(path.join(dir, `audit-${String(n)}.json`))) n += 1;
  writeEvidence(dir, `audit-${String(n)}.json`, { runId, verdict, ...result });
  log(`[run] audit: coverage ${verdict.complete ? "complete" : "INCOMPLETE"}; context ${verdict.clean ? "clean" : "FINDINGS"}`);
  return verdict.pass ? 0 : verdict.complete ? 1 : 3;
}

/** Read-only: verifies the existing resources against the approved plan; creates, changes and deletes nothing. */
async function reconcileOnly(config) {
  const stamp = runIdNow();
  const dir = path.join(EVIDENCE_DIR, `reconcile-${stamp}`);
  const session = await signIn(config);
  const kms = new KMSClient({ region: REGION, credentials: session.operator });
  const keyArns = {};
  for (const [slot, s] of Object.entries(KEY_SLOTS)) {
    try {
      keyArns[slot] = (await kms.send(new DescribeKeyCommand({ KeyId: s.alias }))).KeyMetadata.Arn;
    } catch (error) {
      log(`[reconcile] alias for key ${slot} not found (${describeError(error)})`);
      return 1;
    }
  }
  const rec = new Recorder(`reconcile-${stamp}`, { collect: true });
  await verifyProvisioned({ operator: session.operator, account: config.accountId, operatorRoleArn: session.operatorRoleArn, keyArns, rec, sessionExpiresInSeconds: session.expiresIn });
  for (const c of await inventoryChecks({ operator: session.operator, keyArns })) rec.assert(c.id, c.title, c.pass);
  const summary = rec.summary();
  writeEvidence(dir, "reconcile.json", {
    note: "Read-only reconciliation; no AWS resource was created, changed or deleted.",
    keyIds: Object.fromEntries(Object.entries(keyArns).map(([slot, arn]) => [slot, arn.split("/").pop()])),
    summary,
    checks: rec.cases,
  });
  log(`[reconcile] ${summary.fail === 0 ? "MATCHES the approved plan" : "DEVIATIONS FOUND"} — ${JSON.stringify(summary)}`);
  return summary.fail === 0 ? 0 : 1;
}

function printPlan(account, diff) {
  log("[cleanup] ordered mutations:");
  for (const m of plannedMutations()) log(`[cleanup]   ${String(m.step)}. ${m.service}:${m.action} ${m.target} — ${m.detail}`);
  const target = targetState();
  log(`[cleanup] retained: ${target.retained.join(" · ")}`);
  log(`[cleanup] scheduled for deletion: ${target.scheduledForDeletion.join(" · ")}`);
  log(`[cleanup] deleted: ${target.deleted.join(" · ")}`);
  log(`[cleanup] key A policy diff: removed [${diff.removed.join(", ")}] · added [${diff.added.join(", ")}] · changed [${diff.changed.join(", ")}] · unchanged ${String(diff.unchanged.length)}`);
  const post = keyPolicyAPostValidation(account);
  for (const sid of diff.added) log(`[cleanup]   + ${JSON.stringify(post.Statement.find((s) => s.Sid === sid))}`);
  log(`[cleanup] expected cost after cleanup: ${target.expectedMonthlyCostAfterCleanup}`);
}

async function cleanupCommand(config, args) {
  const offline = args.includes("--offline");
  const apply = args.includes("--apply");
  if (offline) {
    log("[cleanup] OFFLINE plan (no AWS call; placeholder account)");
    printPlan("000000000000", policyDiff(keyPolicy("A", "000000000000"), keyPolicyAPostValidation("000000000000")));
    return 0;
  }
  if (apply && !args.includes(`--confirm=${CONFIRM_TOKEN}`)) {
    log(`[cleanup] refusing --apply without --confirm=${CONFIRM_TOKEN}`);
    return 2;
  }
  const stamp = runIdNow();
  const dir = path.join(EVIDENCE_DIR, `cleanup-${stamp}`);
  const session = await signIn(config);
  const rec = new Recorder(`cleanup-${stamp}`, { collect: !apply });
  const state = await inspectForCleanup({ operator: session.operator, account: config.accountId, operatorRoleArn: session.operatorRoleArn, operatorRoleName: session.operatorRoleName, rec });
  const preconditionsOk = rec.summary().fail === 0;
  printPlan(config.accountId, state.keyAPolicyDiff);
  const record = { mode: apply ? "apply" : "dry-run", preconditions: rec.cases, current: state.current, keyAPolicyDiff: state.keyAPolicyDiff, workerGuardDiff: state.workerGuardDiff, mutations: plannedMutations(), target: targetState() };
  if (!apply) {
    writeEvidence(dir, "dry-run.json", { ...record, note: "DRY-RUN: no AWS resource was created, changed or deleted." });
    log(`[cleanup] DRY-RUN complete — preconditions ${preconditionsOk ? "all satisfied" : "NOT satisfied"}; nothing was changed`);
    return preconditionsOk ? 0 : 1;
  }
  const done = await applyCleanup({ operator: session.operator, account: config.accountId, keyArns: state.keyArns });
  writeEvidence(dir, "applied.json", { ...record, done });
  log("[cleanup] APPLIED — run `npm run reconcile` is NOT valid after cleanup (it expects B, C and the rotation role); verify with: npm run cleanup:verify (read-only)");
  return 0;
}

/** READ-ONLY: verifies the post-cleanup state; any mismatch is a FAIL; nothing is repaired or changed. */
async function cleanupVerify(config) {
  const stamp = runIdNow();
  const dir = path.join(EVIDENCE_DIR, `cleanup-verify-${stamp}`);
  const applied = findAppliedCleanup();
  if (!applied) log("[verify] no applied-cleanup evidence found; the deletion-date window is checked against the current time only");
  const session = await signIn(config);
  const snapshot = await collectPostCleanupSnapshot({ operator: session.operator });
  const checks = evaluatePostCleanup(snapshot, { account: config.accountId, operatorRoleArn: session.operatorRoleArn, applied });
  const rec = new Recorder(`cleanup-verify-${stamp}`, { collect: true });
  for (const c of checks) rec.assert(c.id, c.title, c.pass);
  const summary = rec.summary();
  writeEvidence(dir, "verify.json", {
    note: "READ-ONLY post-cleanup verification; no AWS resource was created, changed or deleted.",
    appliedCleanup: applied ? { run: applied.run, startedAt: applied.startedAt, stepsDone: applied.stepsDone } : null,
    keys: snapshot.taggedKeys.map((k) => ({ slot: k.slot, keyId: k.keyId, state: k.state, deletionDate: k.deletionDate, grants: k.grants })),
    aliases: snapshot.aliases.map((a) => a.name),
    roles: snapshot.roleNames,
    rotationRoleExists: snapshot.rotationRoleExists,
    summary,
    checks: rec.cases,
  });
  log(`[verify] ${summary.fail === 0 ? "PASS — post-cleanup state matches the approved target" : "FAIL — post-cleanup state deviates; nothing was changed"} — ${JSON.stringify(summary)}`);
  return summary.fail === 0 ? 0 : 1;
}

const config = loadConfig();
if (!config.ok) {
  log(`[run] NOT RUN — ${config.reason}`);
  process.exit(2);
}
let code;
try {
  if (command === "validate") code = await validate(config);
  else if (command === "audit") code = await auditOnly(config, rest[rest.indexOf("--run") + 1]);
  else if (command === "reconcile") code = await reconcileOnly(config);
  else if (command === "cleanup") code = await cleanupCommand(config, rest);
  else if (command === "cleanup-verify") code = await cleanupVerify(config);
  else {
    log("usage: node scripts/run.mjs validate | reconcile | audit --run <runId> | cleanup [--offline] | cleanup-verify");
    code = 2;
  }
} catch (error) {
  console.log("[run] STOPPED — unexpected error outside the validation steps");
  reportDiagnostic(safeStack(error));
  code = 1;
}
process.exit(code);
