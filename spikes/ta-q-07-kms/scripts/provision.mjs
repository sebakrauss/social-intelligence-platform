/**
 * Idempotent provisioning of exactly the approved TA-Q-07b development resources, then verification.
 * Existing resources are verified, never modified: any difference from the reviewed policy is a STOP.
 * Order: roles (trust only) → keys with policies (retry while IAM propagates new principals) → aliases →
 * rotation on A → deny-only guards (they reference the key ARNs).
 */
import {
  CreateRoleCommand, GetRoleCommand, GetRolePolicyCommand, IAMClient, ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand, ListRoleTagsCommand, ListUsersCommand, PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
  CreateAliasCommand, CreateKeyCommand, DescribeKeyCommand, EnableKeyRotationCommand, GetKeyPolicyCommand,
  GetKeyRotationStatusCommand, KMSClient, ListAliasesCommand, ListKeysCommand, ListResourceTagsCommand,
} from "@aws-sdk/client-kms";
import { BASE_TAGS, FORBIDDEN_USER, GUARD_POLICY_NAME, KEY_SLOTS, PREFIX, REGION, ROLE_NAMES, ROTATION_PERIOD_DAYS } from "../lib/config.mjs";
import { describeError, log } from "../lib/guard.mjs";
import { guardPolicy, keyPolicy, samePolicy, trustPolicy } from "../lib/policies.mjs";
import { StopValidation } from "../lib/recorder.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const iamTags = (extra = {}) => Object.entries({ ...BASE_TAGS, ...extra }).map(([Key, Value]) => ({ Key, Value }));
const kmsTags = (extra = {}) => Object.entries({ ...BASE_TAGS, ...extra }).map(([TagKey, TagValue]) => ({ TagKey, TagValue }));

function stop(reason) {
  log(`[provision] STOP — ${reason}`);
  return new StopValidation(`provision: ${reason}`);
}

/** The Identity Center role behind the operator session, with its full path. */
export async function resolveOperatorRole(iam, callerArn) {
  const match = /^arn:aws:sts::\d{12}:assumed-role\/(AWSReservedSSO_[A-Za-z0-9+=,.@_-]+)\/([^/]+)$/.exec(callerArn);
  if (!match) throw stop("caller is not an IAM Identity Center operator session");
  const [, roleName, user] = match;
  if (!roleName.startsWith(`AWSReservedSSO_SIP-Dev-Administrator_`)) throw stop("operator permission set is not SIP-Dev-Administrator");
  const role = (await iam.send(new GetRoleCommand({ RoleName: roleName }))).Role;
  if (!role.Path.startsWith("/aws-reserved/sso.amazonaws.com/")) throw stop("operator role is not an Identity Center reserved role");
  return { operatorRoleArn: role.Arn, operatorRoleName: roleName, operatorUser: user };
}

async function findKeyIdByAlias(kms, alias) {
  try {
    return (await kms.send(new DescribeKeyCommand({ KeyId: alias }))).KeyMetadata;
  } catch (error) {
    if (error?.name === "NotFoundException") return null;
    throw error;
  }
}

/** A key created by an earlier interrupted run (tagged with its slot) but left without its alias. */
async function findOrphanKey(kms, slot) {
  const aliased = new Set();
  for (let marker; ;) {
    const page = await kms.send(new ListAliasesCommand({ Marker: marker }));
    for (const a of page.Aliases ?? []) if (a.TargetKeyId) aliased.add(a.TargetKeyId);
    if (!page.Truncated) break;
    marker = page.NextMarker;
  }
  for (let marker; ;) {
    const page = await kms.send(new ListKeysCommand({ Marker: marker }));
    for (const k of page.Keys ?? []) {
      if (aliased.has(k.KeyId)) continue;
      let tags;
      try {
        tags = (await kms.send(new ListResourceTagsCommand({ KeyId: k.KeyId }))).Tags ?? [];
      } catch {
        continue;
      }
      const has = (key, value) => tags.some((t) => t.TagKey === key && t.TagValue === value);
      if (has("Validation", "TA-Q-07b") && has("Slot", slot)) {
        const meta = (await kms.send(new DescribeKeyCommand({ KeyId: k.KeyId }))).KeyMetadata;
        if (meta.KeyState === "Enabled") return meta;
      }
    }
    if (!page.Truncated) break;
    marker = page.NextMarker;
  }
  return null;
}

async function ensureRole(iam, role, account, operatorRoleArn, actions) {
  const RoleName = ROLE_NAMES[role];
  const expectedTrust = trustPolicy(account, operatorRoleArn);
  try {
    const existing = (await iam.send(new GetRoleCommand({ RoleName }))).Role;
    if (!samePolicy(decodeURIComponent(existing.AssumeRolePolicyDocument), expectedTrust)) throw stop(`${RoleName} exists with a different trust policy`);
    actions.push({ resource: `iam:role/${RoleName}`, action: "verified-existing" });
    return existing.Arn;
  } catch (error) {
    if (error instanceof StopValidation) throw error;
    if (error?.name !== "NoSuchEntityException") throw error;
  }
  const created = await iam.send(
    new CreateRoleCommand({
      RoleName,
      AssumeRolePolicyDocument: JSON.stringify(expectedTrust),
      Description: `TA-Q-07b development validation (${role}); synthetic data only`,
      MaxSessionDuration: 3600,
      Tags: iamTags({ Role: role }),
    }),
  );
  actions.push({ resource: `iam:role/${RoleName}`, action: "created" });
  log(`[provision] created IAM role ${RoleName}`);
  return created.Role.Arn;
}

async function ensureKey(kms, slot, account, actions) {
  const { alias } = KEY_SLOTS[slot];
  const expected = keyPolicy(slot, account);
  let meta = await findKeyIdByAlias(kms, alias);
  if (meta) {
    actions.push({ resource: alias, action: "verified-existing" });
  } else {
    meta = await findOrphanKey(kms, slot);
    if (meta) {
      actions.push({ resource: `kms:key slot ${slot}`, action: "adopted-orphan-from-interrupted-run" });
    } else {
      const deadline = Date.now() + 180_000;
      for (;;) {
        try {
          meta = (
            await kms.send(
              new CreateKeyCommand({
                Policy: JSON.stringify(expected),
                Description: `TA-Q-07b development validation, slot ${slot}; synthetic data only`,
                KeyUsage: "ENCRYPT_DECRYPT",
                KeySpec: "SYMMETRIC_DEFAULT",
                Origin: "AWS_KMS",
                MultiRegion: false,
                BypassPolicyLockoutSafetyCheck: false,
                Tags: kmsTags({ Slot: slot }),
              }),
            )
          ).KeyMetadata;
          break;
        } catch (error) {
          // Newly created roles may not be visible to KMS yet ("invalid principals").
          if (error?.name === "MalformedPolicyDocumentException" && Date.now() < deadline) {
            log(`[provision] key ${slot}: waiting for IAM principals to propagate`);
            await sleep(10_000);
            continue;
          }
          throw stop(`CreateKey ${slot} failed: ${describeError(error)}`);
        }
      }
      actions.push({ resource: `kms:key slot ${slot}`, action: "created", keyId: meta.KeyId });
      log(`[provision] created KMS key slot ${slot} (${meta.KeyId})`);
    }
    await kms.send(new CreateAliasCommand({ AliasName: alias, TargetKeyId: meta.KeyId }));
    actions.push({ resource: alias, action: "created" });
    log(`[provision] created alias ${alias}`);
  }
  const policy = (await kms.send(new GetKeyPolicyCommand({ KeyId: meta.KeyId, PolicyName: "default" }))).Policy;
  if (!samePolicy(policy, expected)) throw stop(`key ${slot} policy differs from the reviewed policy`);
  return meta;
}

async function ensureGuard(iam, role, keyArns, actions) {
  const RoleName = ROLE_NAMES[role];
  const expected = guardPolicy(role, keyArns);
  try {
    const existing = await iam.send(new GetRolePolicyCommand({ RoleName, PolicyName: GUARD_POLICY_NAME }));
    if (!samePolicy(decodeURIComponent(existing.PolicyDocument), expected)) throw stop(`${RoleName} guard differs from the reviewed guard`);
    actions.push({ resource: `iam:role/${RoleName}/${GUARD_POLICY_NAME}`, action: "verified-existing" });
    return;
  } catch (error) {
    if (error instanceof StopValidation) throw error;
    if (error?.name !== "NoSuchEntityException") throw error;
  }
  await iam.send(new PutRolePolicyCommand({ RoleName, PolicyName: GUARD_POLICY_NAME, PolicyDocument: JSON.stringify(expected) }));
  actions.push({ resource: `iam:role/${RoleName}/${GUARD_POLICY_NAME}`, action: "created" });
  log(`[provision] attached deny-only guard to ${RoleName}`);
}

export async function provision({ operator, account, operatorRoleArn }) {
  const iam = new IAMClient({ region: REGION, credentials: operator });
  const kms = new KMSClient({ region: REGION, credentials: operator });
  const actions = [];

  for (const role of Object.keys(ROLE_NAMES)) await ensureRole(iam, role, account, operatorRoleArn, actions);
  const keys = {};
  for (const slot of Object.keys(KEY_SLOTS)) keys[slot] = await ensureKey(kms, slot, account, actions);
  const keyArns = Object.fromEntries(Object.entries(keys).map(([slot, meta]) => [slot, meta.Arn]));

  const rotation = await kms.send(new GetKeyRotationStatusCommand({ KeyId: keyArns.A }));
  if (!rotation.KeyRotationEnabled) {
    await kms.send(new EnableKeyRotationCommand({ KeyId: keyArns.A, RotationPeriodInDays: ROTATION_PERIOD_DAYS }));
    actions.push({ resource: KEY_SLOTS.A.alias, action: `enabled-automatic-rotation-${String(ROTATION_PERIOD_DAYS)}d` });
    log(`[provision] enabled automatic rotation on key A (${String(ROTATION_PERIOD_DAYS)} days)`);
  }
  for (const role of Object.keys(ROLE_NAMES)) await ensureGuard(iam, role, keyArns, actions);
  return { keys, keyArns, actions };
}

/** Read-only checks recorded as the P cases. */
export async function verifyProvisioned({ operator, account, operatorRoleArn, keyArns, rec, sessionExpiresInSeconds }) {
  const iam = new IAMClient({ region: REGION, credentials: operator });
  const kms = new KMSClient({ region: REGION, credentials: operator });

  rec.assert("P0a", "operator session is short-lived (≤ 1 hour remaining)", sessionExpiresInSeconds > 0 && sessionExpiresInSeconds <= 3600 + 60);
  rec.assert("P0b", `region is ${REGION}`, REGION === "sa-east-1");
  const users = [];
  for (let marker; ;) {
    const page = await iam.send(new ListUsersCommand({ Marker: marker }));
    users.push(...(page.Users ?? []));
    if (!page.IsTruncated) break;
    marker = page.Marker;
  }
  rec.assert("P0c", `no IAM user named ${FORBIDDEN_USER} (no long-lived worker credential)`, !users.some((u) => u.UserName === FORBIDDEN_USER));
  rec.assert("P0d", "no IAM users with the development prefix exist", !users.some((u) => u.UserName.startsWith(PREFIX)));

  for (const [slot, arn] of Object.entries(keyArns)) {
    const meta = (await kms.send(new DescribeKeyCommand({ KeyId: arn }))).KeyMetadata;
    rec.assert(
      `P1${slot}`,
      `key ${slot}: Enabled, SYMMETRIC_DEFAULT, ENCRYPT_DECRYPT, AWS_KMS, single-Region, alias resolves`,
      meta.KeyState === "Enabled" && meta.KeySpec === "SYMMETRIC_DEFAULT" && meta.KeyUsage === "ENCRYPT_DECRYPT" &&
        meta.Origin === "AWS_KMS" && meta.MultiRegion === false &&
        (await findKeyIdByAlias(kms, KEY_SLOTS[slot].alias))?.Arn === arn,
    );
    const rotation = await kms.send(new GetKeyRotationStatusCommand({ KeyId: arn }));
    const expectedRotation = KEY_SLOTS[slot].rotation;
    rec.assert(
      `P2${slot}`,
      `key ${slot}: automatic rotation ${expectedRotation ? `enabled (${String(ROTATION_PERIOD_DAYS)} days)` : "disabled (as approved)"}`,
      expectedRotation ? rotation.KeyRotationEnabled === true && rotation.RotationPeriodInDays === ROTATION_PERIOD_DAYS : rotation.KeyRotationEnabled === false,
    );
    const policy = (await kms.send(new GetKeyPolicyCommand({ KeyId: arn, PolicyName: "default" }))).Policy;
    rec.assert(`P3${slot}`, `key ${slot}: key policy equals the reviewed policy`, samePolicy(policy, keyPolicy(slot, account)));
    const tags = (await kms.send(new ListResourceTagsCommand({ KeyId: arn }))).Tags ?? [];
    rec.assert(
      `P4${slot}`,
      `key ${slot}: approved tags present`,
      Object.entries({ ...BASE_TAGS, Slot: slot }).every(([k, v]) => tags.some((t) => t.TagKey === k && t.TagValue === v)),
    );
  }

  for (const [role, RoleName] of Object.entries(ROLE_NAMES)) {
    const existing = (await iam.send(new GetRoleCommand({ RoleName }))).Role;
    const inline = (await iam.send(new ListRolePoliciesCommand({ RoleName }))).PolicyNames ?? [];
    const attached = (await iam.send(new ListAttachedRolePoliciesCommand({ RoleName }))).AttachedPolicies ?? [];
    const guard = await iam.send(new GetRolePolicyCommand({ RoleName, PolicyName: GUARD_POLICY_NAME }));
    const tags = (await iam.send(new ListRoleTagsCommand({ RoleName }))).Tags ?? [];
    rec.assert(
      `P5-${role}`,
      `${RoleName}: trust = operator only, max session 1h, only the deny guard, no managed policies, tagged`,
      samePolicy(decodeURIComponent(existing.AssumeRolePolicyDocument), trustPolicy(account, operatorRoleArn)) &&
        existing.MaxSessionDuration === 3600 &&
        inline.length === 1 && inline[0] === GUARD_POLICY_NAME && attached.length === 0 &&
        samePolicy(decodeURIComponent(guard.PolicyDocument), guardPolicy(role, keyArns)) &&
        Object.entries(BASE_TAGS).every(([k, v]) => tags.some((t) => t.Key === k && t.Value === v)),
    );
  }
}
