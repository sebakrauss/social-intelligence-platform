/**
 * Offline self-test (no AWS): envelope, output guard and the rendered policies' structural invariants.
 * Credential-shaped samples are assembled at runtime so this file never contains one.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { CONTEXT_CONSTANTS, CONTEXT_KEYS } from "../lib/config.mjs";
import { canonicalContext, open, seal, tamper, zero } from "../lib/envelope.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GuardError, allowExactTokens, assertSafe, registerSecret, safeStack, setRedactions, writeEvidence } from "../lib/guard.mjs";
import { Recorder, StopValidation } from "../lib/recorder.mjs";
import { credentialsFrom } from "../lib/auth.mjs";
import { KMSClient } from "@aws-sdk/client-kms";
import { STSClient } from "@aws-sdk/client-sts";
import { guardPolicy, keyPolicy, keyPolicyAPostValidation, policyDiff, samePolicy, statementIds, trustPolicy, workerGuardPostValidation } from "../lib/policies.mjs";
import { DELETION_WINDOW_DAYS, plannedMutations } from "./cleanup.mjs";
import { evaluatePostCleanup } from "./verify-cleanup.mjs";

const results = [];
const test = async (name, fn) => {
  await fn();
  results.push(name);
};

const ctx = { ...CONTEXT_CONSTANTS, workspace_id: randomUUID(), credential_id: randomUUID() };

await test("envelope round-trip and zeroing", () => {
  const dek = randomBytes(32);
  const secret = randomBytes(32);
  const env = seal(dek, secret, ctx);
  const back = open(dek, env, ctx);
  assert.ok(back.equals(secret));
  assert.equal(zero(back), true);
  assert.equal(zero(dek), true);
});

await test("tampering and wrong AAD fail authentication", () => {
  const dek = randomBytes(32);
  const env = seal(dek, randomBytes(32), ctx);
  for (const field of ["ciphertext", "tag", "iv"]) assert.throws(() => open(dek, tamper(env, field), ctx), { name: "AuthenticationFailed" });
  assert.throws(() => open(dek, env, { ...ctx, workspace_id: randomUUID() }), { name: "AuthenticationFailed" });
});

await test("canonical context is key-order independent", () => {
  const reversed = Object.fromEntries(Object.entries(ctx).reverse());
  assert.equal(canonicalContext(ctx), canonicalContext(reversed));
});

await test("guard refuses registered secrets, credential shapes, long opaque values and binary evidence", () => {
  const registered = randomBytes(24).toString("hex");
  registerSecret(registered);
  assert.throws(() => assertSafe(`x ${registered} y`, "t"), GuardError);
  const keyIdShape = ["AK", "IA", "Q".repeat(16)].join("");
  assert.throws(() => assertSafe(keyIdShape, "t"), GuardError);
  assert.throws(() => assertSafe(randomBytes(48).toString("base64"), "t"), GuardError);
  assert.throws(() => writeEvidence("/nonexistent", "x.json", { dek: Buffer.alloc(32) }), GuardError);
  assertSafe("arn:aws:iam::<ACCOUNT>:role/social-intelligence-platform-dev-integration-worker", "t");
});

await test("policies: every crypto Allow names one role and carries the full context condition; no wildcard admin", () => {
  const account = "000000000000";
  for (const slot of ["A", "B", "C"]) {
    const policy = keyPolicy(slot, account);
    for (const s of policy.Statement) {
      const actions = [s.Action ?? s.NotAction].flat();
      assert.ok(!actions.includes("kms:*"), `${slot} ${s.Sid} uses kms:*`);
      if (s.Effect === "Allow" && s.Sid !== "KeyAdministrationNoCrypto") {
        assert.match(s.Principal.AWS, /:role\/social-intelligence-platform-dev-/);
        assert.deepEqual(s.Condition["ForAllValues:StringEquals"]["kms:EncryptionContextKeys"], [...CONTEXT_KEYS]);
        assert.equal(Object.keys(s.Condition.StringLike).length, 2);
      }
      if (s.Sid === "KeyAdministrationNoCrypto") {
        assert.ok(!actions.some((a) => /Decrypt|Encrypt|GenerateDataKey|CreateGrant/.test(a)), "admin has crypto");
      }
    }
    const allows = policy.Statement.filter((s) => s.Effect === "Allow");
    const webAllows = allows.filter((s) => String(s.Principal.AWS).endsWith("-web-encrypt")).flatMap((s) => [s.Action].flat());
    assert.ok(webAllows.every((a) => a === "kms:GenerateDataKey"), `${slot}: web has more than GenerateDataKey`);
    const rotationAllows = allows.filter((s) => String(s.Principal.AWS).endsWith("-kms-rotation-test")).flatMap((s) => [s.Action].flat());
    assert.ok(rotationAllows.every((a) => a.startsWith("kms:ReEncrypt")), `${slot}: rotation has more than ReEncrypt`);
  }
  assert.ok(samePolicy(JSON.stringify(trustPolicy(account, "arn:x")), trustPolicy(account, "arn:x")));
  const arns = { A: "arn:a", B: "arn:b", C: "arn:c" };
  assert.deepEqual(guardPolicy("web", arns).Statement[0].NotAction, "kms:GenerateDataKey");
});

await test("regression (run 20261006T171741Z-1aa8): SDK clients resolve harness credentials offline", async () => {
  const credentials = credentialsFrom("offline-fake-id", "offline-fake-secret", "offline-fake-token", Date.now() + 3_600_000);
  for (const Client of [STSClient, KMSClient]) {
    const resolved = await new Client({ region: "sa-east-1", credentials }).config.credentials();
    assert.equal(resolved.accessKeyId, "offline-fake-id");
  }
});

await test("safe diagnostics: frames are relative, messages with secrets are withheld", () => {
  const registered = randomBytes(24).toString("hex");
  registerSecret(registered);
  const error = new TypeError(`boom ${registered}`);
  const detail = safeStack(error);
  assert.equal(detail.type, "TypeError");
  assert.equal(detail.message, "[message withheld by output guard]");
  assert.ok(detail.frames.length > 0);
  for (const frame of detail.frames) assert.ok(!frame.file.startsWith("/"), "absolute path in diagnostic");
  assert.equal(safeStack(new TypeError("plain message")).message, "plain message");
});

await test("regression (run 20261006T172454Z-f40c): the full policies evidence passes the guard with the exact Sid allowlist", () => {
  const fakeAccount = "000000000000";
  setRedactions({ account: fakeAccount, operator: "offline-operator" });
  allowExactTokens(statementIds().filter((sid) => sid.length >= 40));
  const keyArns = Object.fromEntries(["A", "B", "C"].map((slot) => [slot, `arn:aws:kms:sa-east-1:${fakeAccount}:key/${randomUUID()}`]));
  const operatorRoleArn = `arn:aws:iam::${fakeAccount}:role/aws-reserved/sso.amazonaws.com/sa-east-1/AWSReservedSSO_SIP-Dev-Administrator_${randomBytes(8).toString("hex")}`;
  const dir = mkdtempSync(path.join(tmpdir(), "taq07b-selftest-"));
  try {
    writeEvidence(dir, "policies.json", {
      keyPolicies: Object.fromEntries(["A", "B", "C"].map((slot) => [slot, keyPolicy(slot, fakeAccount)])),
      trustPolicy: trustPolicy(fakeAccount, operatorRoleArn),
      guards: Object.fromEntries(["web", "worker", "rotation"].map((role) => [role, guardPolicy(role, keyArns)])),
    });
    assert.ok(!readFileSync(path.join(dir, "policies.json"), "utf8").includes(fakeAccount), "account not redacted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("the exemption is exact and narrow: near-misses, opaque values and non-alphabetic tokens stay refused", () => {
  const sid = statementIds().find((s) => s.length >= 40);
  assert.ok(sid, "expected one long statement id");
  assertSafe(`"Sid": "${sid}"`, "t");
  assert.throws(() => assertSafe(`${sid}X`, "t"), GuardError);
  assert.throws(() => assertSafe(`X${sid}`, "t"), GuardError);
  assert.throws(() => assertSafe("Q".repeat(41), "t"), GuardError);
  assert.throws(() => assertSafe(randomBytes(48).toString("base64"), "t"), GuardError);
  assert.throws(() => allowExactTokens([`${sid}1`]), GuardError);
  assert.throws(() => allowExactTokens(["ShortToken"]), GuardError);
  assert.throws(() => allowExactTokens([randomBytes(32).toString("base64")]), GuardError);
});

await test("reconciliation recorder collects failures; the validation recorder stops on them", () => {
  const collecting = new Recorder("selftest", { collect: true });
  collecting.assert("X1", "collected failure", false);
  assert.equal(collecting.summary().fail, 1);
  assert.throws(() => new Recorder("selftest").assert("X2", "stopping failure", false), StopValidation);
});

await test("closeout: key A post-validation policy drops the rotation principal and denies ReEncrypt to everyone", () => {
  const account = "000000000000";
  const before = keyPolicy("A", account);
  const after = keyPolicyAPostValidation(account);
  assert.ok(!JSON.stringify(after).includes("kms-rotation-test"), "rotation principal still referenced");
  const diff = policyDiff(before, after);
  assert.deepEqual(diff.removed.sort(), ["DenyReEncryptExceptRotation", "RotationReEncrypt"]);
  assert.deepEqual(diff.added, ["DenyReEncryptToEveryone"]);
  assert.deepEqual(diff.changed, []);
  const deny = after.Statement.find((s) => s.Sid === "DenyReEncryptToEveryone");
  assert.deepEqual([deny.Effect, deny.Principal, deny.Action, deny.Condition], ["Deny", "*", "kms:ReEncrypt*", undefined]);
  assert.ok(after.Statement.some((s) => s.Sid === "KeyAdministrationNoCrypto" && s.Action.includes("kms:PutKeyPolicy")), "lockout: admin must keep PutKeyPolicy");
  const guard = workerGuardPostValidation("arn:a");
  assert.ok(!JSON.stringify(guard).includes("arn:b"), "worker guard still references key B");
});

await test("closeout: mutation order is safe (policy before role deletion, alias before key deletion, 7-day window)", () => {
  const steps = plannedMutations();
  const at = (action, target) => steps.findIndex((m) => m.action === action && m.target.includes(target));
  assert.ok(at("PutKeyPolicy", "key A") < at("DeleteRole", "kms-rotation-test"));
  assert.ok(at("DeleteAlias", "-next") < at("ScheduleKeyDeletion", "key B"));
  assert.ok(at("DeleteAlias", "-decoy") < at("ScheduleKeyDeletion", "key C"));
  assert.ok(at("ScheduleKeyDeletion", "key C") < at("DeleteRole", "kms-rotation-test"));
  assert.ok(at("DeleteRolePolicy", "kms-rotation-test") < at("DeleteRole", "kms-rotation-test"));
  assert.equal(DELETION_WINDOW_DAYS, 7);
  assert.ok(!steps.some((m) => /key A|provider-credentials$/.test(m.target) && /Delete|Schedule/.test(m.action)), "key A must never be deleted");
  assert.ok(!steps.some((m) => /web-encrypt|integration-worker$/.test(m.target) && m.action === "DeleteRole"), "retained roles must never be deleted");
});

// ── Post-cleanup verifier (offline snapshots) ──────────────────────────────────────────────────────────
function postCleanupFixture() {
  const account = "000000000000";
  const operatorRoleArn = `arn:aws:iam::${account}:role/aws-reserved/sso.amazonaws.com/sa-east-1/AWSReservedSSO_SIP-Dev-Administrator_offline`;
  const ids = { A: randomUUID(), B: randomUUID(), C: randomUUID() };
  const arn = (slot) => `arn:aws:kms:sa-east-1:${account}:key/${ids[slot]}`;
  const now = Date.now();
  const appliedAt = now - 3_600_000;
  const pending = (slot) => ({ slot, keyId: ids[slot], arn: arn(slot), state: "PendingDeletion", deletionDate: new Date(appliedAt + 7 * 86_400_000 + 1_800_000).toISOString(), grants: 0, policy: null, rotationEnabled: null, rotationPeriodDays: null });
  const role = (guard) => ({ trust: JSON.stringify(trustPolicy(account, operatorRoleArn)), maxSessionDuration: 3600, inline: ["social-intelligence-platform-dev-guard"], attached: 0, guard: JSON.stringify(guard) });
  const snapshot = {
    now: new Date(now).toISOString(),
    aliases: [{ name: "alias/social-intelligence-platform-dev-provider-credentials", targetKeyId: ids.A }],
    taggedKeys: [
      { slot: "A", keyId: ids.A, arn: arn("A"), state: "Enabled", deletionDate: null, grants: 0, policy: JSON.stringify(keyPolicyAPostValidation(account)), rotationEnabled: true, rotationPeriodDays: 365 },
      pending("B"),
      pending("C"),
    ],
    roleNames: ["social-intelligence-platform-dev-integration-worker", "social-intelligence-platform-dev-web-encrypt"],
    roles: { web: role(guardPolicy("web", { A: arn("A") })), worker: role(workerGuardPostValidation(arn("A"))) },
    rotationRoleExists: false,
    prefixedUsers: [],
    accessKeys: 0,
    rootAccessKeysPresent: 0,
  };
  const options = { account, operatorRoleArn, applied: { run: "cleanup-offline", startedAt: new Date(appliedAt).toISOString(), keyIds: ids, stepsDone: 8 } };
  return { snapshot, options, ids, arn, account };
}
const failing = (checks) => checks.filter((c) => !c.pass).map((c) => c.id).sort();

await test("cleanup:verify — the approved post-cleanup state passes every check", () => {
  const { snapshot, options } = postCleanupFixture();
  const checks = evaluatePostCleanup(snapshot, options);
  assert.ok(checks.length >= 30, "unexpectedly few checks");
  assert.deepEqual(failing(checks), []);
});

await test("cleanup:verify — failure: alias B still exists", () => {
  const { snapshot, options, ids } = postCleanupFixture();
  snapshot.aliases.push({ name: "alias/social-intelligence-platform-dev-provider-credentials-next", targetKeyId: ids.B });
  assert.deepEqual(failing(evaluatePostCleanup(snapshot, options)), ["B1", "X1"]);
});

await test("cleanup:verify — failure: key C not PendingDeletion", () => {
  const { snapshot, options } = postCleanupFixture();
  Object.assign(snapshot.taggedKeys[2], { state: "Enabled", deletionDate: null });
  assert.deepEqual(failing(evaluatePostCleanup(snapshot, options)), ["C3", "C4"]);
});

await test("cleanup:verify — failure: deletion date outside the 7-day window", () => {
  const { snapshot, options } = postCleanupFixture();
  snapshot.taggedKeys[1].deletionDate = new Date(Date.now() + 30 * 86_400_000).toISOString();
  assert.deepEqual(failing(evaluatePostCleanup(snapshot, options)), ["B4"]);
});

await test("cleanup:verify — failure: rotation-test role still present", () => {
  const { snapshot, options } = postCleanupFixture();
  snapshot.rotationRoleExists = true;
  snapshot.roleNames = [...snapshot.roleNames, "social-intelligence-platform-dev-kms-rotation-test"].sort();
  assert.deepEqual(failing(evaluatePostCleanup(snapshot, options)), ["R1", "R2"]);
});

await test("cleanup:verify — failure: worker guard still references key B", () => {
  const { snapshot, options, arn } = postCleanupFixture();
  snapshot.roles.worker.guard = JSON.stringify(guardPolicy("worker", { A: arn("A"), B: arn("B"), C: arn("C") }));
  assert.deepEqual(failing(evaluatePostCleanup(snapshot, options)), ["R5-worker", "R6"]);
});

await test("cleanup:verify — failure: key A still permits ReEncrypt (validation policy)", () => {
  const { snapshot, options, account } = postCleanupFixture();
  snapshot.taggedKeys[0].policy = JSON.stringify(keyPolicy("A", account));
  assert.deepEqual(failing(evaluatePostCleanup(snapshot, options)), ["A5", "A6", "A7", "A8", "A9"]);
});

await test("cleanup:verify — failure: long-lived credentials or extra keys/grants are caught", () => {
  const { snapshot, options } = postCleanupFixture();
  Object.assign(snapshot, { prefixedUsers: ["social-intelligence-platform-dev-trigger-worker"], accessKeys: 1, rootAccessKeysPresent: 1 });
  snapshot.taggedKeys[0].grants = 1;
  assert.deepEqual(failing(evaluatePostCleanup(snapshot, options)), ["A10", "U1", "U2", "U3", "X3"]);
});

await test("cleanup:verify is read-only by construction (List/Get/Describe imports only; no mutating path)", () => {
  const source = readFileSync(new URL("./verify-cleanup.mjs", import.meta.url), "utf8");
  const commands = [...source.matchAll(/\b([A-Z][A-Za-z]+Command)\b/g)].map((m) => m[1]);
  assert.ok(commands.length > 0);
  for (const name of new Set(commands)) assert.match(name, /^(List|Get|Describe)[A-Za-z]+Command$/, `non-read command ${name}`);
  assert.doesNotMatch(source, /from "\.\/(provision|probe|reconcile)\.mjs"|applyCleanup|inspectForCleanup/);
  const run = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
  const body = run.slice(run.indexOf("async function cleanupVerify"), run.indexOf("const config = loadConfig();"));
  assert.doesNotMatch(body, /applyCleanup|inspectForCleanup|provision\(|probe\(|\.send\(/);
});

console.log(`selftest: ${String(results.length)}/${String(results.length)} passed`);
