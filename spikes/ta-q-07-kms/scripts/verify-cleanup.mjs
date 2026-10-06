/**
 * READ-ONLY post-cleanup verification for TA-Q-07b (`npm run cleanup:verify`).
 *
 *   collectPostCleanupSnapshot  List/Get/Describe calls only → a plain JSON snapshot (no SDK objects)
 *   evaluatePostCleanup         pure: snapshot + expectations → checks (offline-testable)
 *
 * Expected state after the applied cleanup: key A Enabled with its alias, automatic rotation and the
 * post-validation policy; keys B and C without aliases and PendingDeletion (7-day window); exactly the
 * web-encrypt and integration-worker roles (worker guard on key A only); the rotation-test role gone; no IAM
 * users, access keys or grants. Any mismatch is a FAIL. Nothing is repaired; nothing is ever mutated.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  GetAccountSummaryCommand, GetRoleCommand, GetRolePolicyCommand, IAMClient, ListAccessKeysCommand,
  ListAttachedRolePoliciesCommand, ListRolePoliciesCommand, ListRolesCommand, ListUsersCommand,
} from "@aws-sdk/client-iam";
import {
  DescribeKeyCommand, GetKeyPolicyCommand, GetKeyRotationStatusCommand, KMSClient, ListAliasesCommand, ListGrantsCommand,
  ListKeysCommand, ListResourceTagsCommand,
} from "@aws-sdk/client-kms";
import { EVIDENCE_DIR, GUARD_POLICY_NAME, KEY_SLOTS, PREFIX, REGION, ROLE_NAMES, ROTATION_PERIOD_DAYS } from "../lib/config.mjs";
import { canonicalJson, guardPolicy, keyPolicyAPostValidation, trustPolicy, workerGuardPostValidation } from "../lib/policies.mjs";
import { DELETION_WINDOW_DAYS } from "./cleanup.mjs";

const DAY = 86_400_000;
const RETAINED_ROLES = Object.freeze({ web: ROLE_NAMES.web, worker: ROLE_NAMES.worker });

async function allPages(fetchPage, pick, next) {
  const items = [];
  for (let marker; ;) {
    const page = await fetchPage(marker);
    items.push(...(pick(page) ?? []));
    marker = next(page);
    if (!marker) return items;
  }
}

/** The applied cleanup recorded in evidence: when it started and which key IDs it acted on. */
export function findAppliedCleanup(evidenceDir = EVIDENCE_DIR) {
  if (!existsSync(evidenceDir)) return null;
  const applied = readdirSync(evidenceDir)
    .filter((d) => /^cleanup-\d{8}T\d{6}Z-[0-9a-f]{4}$/.test(d) && existsSync(path.join(evidenceDir, d, "applied.json")))
    .sort();
  const latest = applied.at(-1);
  if (!latest) return null;
  const m = /^cleanup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(latest);
  const record = JSON.parse(readFileSync(path.join(evidenceDir, latest, "applied.json"), "utf8"));
  return {
    run: latest,
    startedAt: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`,
    keyIds: Object.fromEntries(Object.entries(record.current?.keys ?? {}).map(([slot, k]) => [slot, k.keyId])),
    stepsDone: (record.done ?? []).length,
  };
}

/** Read-only collection (List/Get/Describe only). */
export async function collectPostCleanupSnapshot({ operator }) {
  const kms = new KMSClient({ region: REGION, credentials: operator });
  const iam = new IAMClient({ region: REGION, credentials: operator });

  const aliases = (await allPages((m) => kms.send(new ListAliasesCommand({ Marker: m })), (p) => p.Aliases, (p) => (p.Truncated ? p.NextMarker : undefined)))
    .filter((a) => a.AliasName.startsWith(`alias/${PREFIX}`))
    .map((a) => ({ name: a.AliasName, targetKeyId: a.TargetKeyId ?? null }));

  const taggedKeys = [];
  for (const k of await allPages((m) => kms.send(new ListKeysCommand({ Marker: m })), (p) => p.Keys, (p) => (p.Truncated ? p.NextMarker : undefined))) {
    const meta = (await kms.send(new DescribeKeyCommand({ KeyId: k.KeyId }))).KeyMetadata;
    if (meta.KeyManager !== "CUSTOMER") continue;
    const tags = (await kms.send(new ListResourceTagsCommand({ KeyId: k.KeyId }))).Tags ?? [];
    if (!tags.some((t) => t.TagKey === "Validation" && t.TagValue === "TA-Q-07b")) continue;
    const grants = (await allPages((m) => kms.send(new ListGrantsCommand({ KeyId: k.KeyId, Marker: m })), (p) => p.Grants, (p) => (p.Truncated ? p.NextMarker : undefined))).length;
    const entry = {
      slot: tags.find((t) => t.TagKey === "Slot")?.TagValue ?? null,
      keyId: meta.KeyId,
      arn: meta.Arn,
      state: meta.KeyState,
      deletionDate: meta.DeletionDate ? meta.DeletionDate.toISOString() : null,
      grants,
      policy: null,
      rotationEnabled: null,
      rotationPeriodDays: null,
    };
    if (meta.KeyState === "Enabled") {
      entry.policy = (await kms.send(new GetKeyPolicyCommand({ KeyId: meta.KeyId, PolicyName: "default" }))).Policy;
      const rotation = await kms.send(new GetKeyRotationStatusCommand({ KeyId: meta.KeyId }));
      entry.rotationEnabled = rotation.KeyRotationEnabled === true;
      entry.rotationPeriodDays = rotation.RotationPeriodInDays ?? null;
    }
    taggedKeys.push(entry);
  }

  const roleNames = (await allPages((m) => iam.send(new ListRolesCommand({ Marker: m })), (p) => p.Roles, (p) => (p.IsTruncated ? p.Marker : undefined)))
    .map((r) => r.RoleName)
    .filter((n) => n.startsWith(PREFIX))
    .sort();
  const roles = {};
  for (const [role, RoleName] of Object.entries(RETAINED_ROLES)) {
    if (!roleNames.includes(RoleName)) continue;
    const r = (await iam.send(new GetRoleCommand({ RoleName }))).Role;
    const inline = (await iam.send(new ListRolePoliciesCommand({ RoleName }))).PolicyNames ?? [];
    const attached = (await iam.send(new ListAttachedRolePoliciesCommand({ RoleName }))).AttachedPolicies ?? [];
    let guard = null;
    if (inline.includes(GUARD_POLICY_NAME)) {
      guard = decodeURIComponent((await iam.send(new GetRolePolicyCommand({ RoleName, PolicyName: GUARD_POLICY_NAME }))).PolicyDocument);
    }
    roles[role] = { trust: decodeURIComponent(r.AssumeRolePolicyDocument), maxSessionDuration: r.MaxSessionDuration, inline: [...inline].sort(), attached: attached.length, guard };
  }
  let rotationRoleExists = true;
  try {
    await iam.send(new GetRoleCommand({ RoleName: ROLE_NAMES.rotation }));
  } catch (error) {
    if (error?.name === "NoSuchEntityException") rotationRoleExists = false;
    else throw error;
  }

  const users = await allPages((m) => iam.send(new ListUsersCommand({ Marker: m })), (p) => p.Users, (p) => (p.IsTruncated ? p.Marker : undefined));
  let accessKeys = 0;
  for (const user of users) {
    accessKeys += (await allPages((m) => iam.send(new ListAccessKeysCommand({ UserName: user.UserName, Marker: m })), (p) => p.AccessKeyMetadata, (p) => (p.IsTruncated ? p.Marker : undefined))).length;
  }
  const summary = (await iam.send(new GetAccountSummaryCommand({}))).SummaryMap ?? {};

  return {
    now: new Date().toISOString(),
    aliases,
    taggedKeys,
    roleNames,
    roles,
    rotationRoleExists,
    prefixedUsers: users.map((u) => u.UserName).filter((n) => n.startsWith(PREFIX)),
    accessKeys,
    rootAccessKeysPresent: summary.AccountAccessKeysPresent ?? null,
  };
}

const same = (a, b) => canonicalJson(typeof a === "string" ? JSON.parse(a) : a) === canonicalJson(typeof b === "string" ? JSON.parse(b) : b);

/** Pure evaluation. `applied` (from evidence) pins the key identities and the deletion-date window. */
export function evaluatePostCleanup(snapshot, { account, operatorRoleArn, applied }) {
  const checks = [];
  const check = (id, title, pass) => checks.push({ id, title, pass: pass === true });
  const bySlot = (slot) => snapshot.taggedKeys.filter((k) => k.slot === slot);
  const keyA = bySlot("A")[0];
  const keyArnA = keyA?.arn ?? "";
  const aliasNames = snapshot.aliases.map((a) => a.name);
  const appliedAt = applied ? Date.parse(applied.startedAt) : null;
  const now = Date.parse(snapshot.now);

  // ── Key A ────────────────────────────────────────────────────────────────────────────────────────────
  check("A1", "key A exists exactly once (tagged Slot=A) and is the key the cleanup acted on", bySlot("A").length === 1 && (!applied?.keyIds?.A || applied.keyIds.A === keyA.keyId));
  check("A2", "key A is Enabled", keyA?.state === "Enabled");
  check("A3", `alias A exists and resolves to key A`, snapshot.aliases.some((a) => a.name === KEY_SLOTS.A.alias && a.targetKeyId === keyA?.keyId));
  check("A4", `key A automatic rotation enabled (${String(ROTATION_PERIOD_DAYS)} days)`, keyA?.rotationEnabled === true && keyA?.rotationPeriodDays === ROTATION_PERIOD_DAYS);
  const policyA = keyA?.policy ? JSON.parse(keyA.policy) : { Statement: [] };
  const sids = new Set((policyA.Statement ?? []).map((s) => s.Sid));
  check("A5", "key A policy is EXACTLY the reviewed post-validation policy", keyA?.policy !== null && keyA?.policy !== undefined && same(keyA.policy, keyPolicyAPostValidation(account)));
  check("A6", "key A policy has no RotationReEncrypt statement", !sids.has("RotationReEncrypt"));
  check("A7", "key A policy has no DenyReEncryptExceptRotation statement", !sids.has("DenyReEncryptExceptRotation"));
  const denyAll = (policyA.Statement ?? []).find((s) => s.Sid === "DenyReEncryptToEveryone");
  check("A8", "key A policy denies kms:ReEncrypt* to everyone, unconditionally", denyAll?.Effect === "Deny" && denyAll?.Principal === "*" && denyAll?.Action === "kms:ReEncrypt*" && denyAll?.Condition === undefined);
  check("A9", "key A policy grants ReEncrypt to no principal", !(policyA.Statement ?? []).some((s) => s.Effect === "Allow" && [s.Action].flat().some((a) => /ReEncrypt/.test(a))));
  check("A10", "no grants on key A", keyA?.grants === 0);

  // ── Keys B and C: aliases gone, PendingDeletion within the 7-day cleanup window ──────────────────────────
  for (const slot of ["B", "C"]) {
    const keys = bySlot(slot);
    const k = keys[0];
    check(`${slot}1`, `alias ${slot} no longer exists and no alias targets key ${slot}`, !aliasNames.includes(KEY_SLOTS[slot].alias) && !snapshot.aliases.some((a) => k && a.targetKeyId === k.keyId));
    check(`${slot}2`, `key ${slot} exists exactly once and is the key the cleanup acted on`, keys.length === 1 && (!applied?.keyIds?.[slot] || applied.keyIds[slot] === k.keyId));
    check(`${slot}3`, `key ${slot} is PendingDeletion`, k?.state === "PendingDeletion");
    const deletion = k?.deletionDate ? Date.parse(k.deletionDate) : Number.NaN;
    const lower = appliedAt === null ? now : appliedAt + DELETION_WINDOW_DAYS * DAY - 5 * 60_000;
    const upper = (appliedAt ?? now) + (DELETION_WINDOW_DAYS + 1) * DAY + 60 * 60_000; // AWS may add up to 24 hours
    check(`${slot}4`, `key ${slot} deletion date is in the future and consistent with the ${String(DELETION_WINDOW_DAYS)}-day window`, Number.isFinite(deletion) && deletion > now && deletion >= lower && deletion <= upper);
    check(`${slot}5`, `no grants on key ${slot}`, k?.grants === 0);
  }

  // ── IAM roles ────────────────────────────────────────────────────────────────────────────────────────
  check("R1", "exactly the two retained TA-Q-07b roles exist (web-encrypt, integration-worker)", canonicalJson(snapshot.roleNames) === canonicalJson(Object.values(RETAINED_ROLES).sort()));
  check("R2", `${ROLE_NAMES.rotation} does not exist`, snapshot.rotationRoleExists === false);
  const expectedGuards = { web: guardPolicy("web", { A: keyArnA }), worker: workerGuardPostValidation(keyArnA) };
  for (const role of ["web", "worker"]) {
    const r = snapshot.roles[role];
    check(`R3-${role}`, `${RETAINED_ROLES[role]}: trust is operator-only (as approved)`, r !== undefined && same(r.trust, trustPolicy(account, operatorRoleArn)));
    check(`R4-${role}`, `${RETAINED_ROLES[role]}: max session 1 hour, no managed policies, only the deny guard inline`, r !== undefined && r.maxSessionDuration === 3600 && r.attached === 0 && canonicalJson(r.inline) === canonicalJson([GUARD_POLICY_NAME]));
    check(`R5-${role}`, `${RETAINED_ROLES[role]}: deny guard is EXACTLY the expected retained-state guard`, r?.guard != null && same(r.guard, expectedGuards[role]));
  }
  const otherKeys = snapshot.taggedKeys.filter((k) => k.slot === "B" || k.slot === "C").flatMap((k) => [k.keyId, k.arn]);
  const workerGuard = snapshot.roles.worker?.guard ?? "";
  check("R6", "worker guard references key A only (no key B or C)", workerGuard !== "" && workerGuard.includes(keyArnA) && !otherKeys.some((id) => workerGuard.includes(id)));

  // ── IAM users / long-lived credentials ───────────────────────────────────────────────────────────────
  check("U1", "no TA-Q-07b IAM user exists (including the trigger-worker user)", snapshot.prefixedUsers.length === 0);
  check("U2", "no IAM access keys exist in the development account", snapshot.accessKeys === 0);
  check("U3", "root has no access keys (AccountAccessKeysPresent = 0)", snapshot.rootAccessKeysPresent === 0);

  // ── Inventory / extras ───────────────────────────────────────────────────────────────────────────────
  check("X1", "no unexpected TA-Q-07b aliases (only alias A)", canonicalJson(aliasNames.sort()) === canonicalJson([KEY_SLOTS.A.alias]));
  check("X2", "no unexpected TA-Q-07b keys (exactly A, B and C; B and C pending deletion is expected)", snapshot.taggedKeys.length === 3 && ["A", "B", "C"].every((s) => bySlot(s).length === 1));
  check("X3", "no KMS grants on any TA-Q-07b key", snapshot.taggedKeys.every((k) => k.grants === 0));
  return checks;
}
