/**
 * TA-Q-07b closeout cleanup. DRY-RUN BY DEFAULT: inspects the live state read-only, checks every
 * precondition and prints the exact ordered mutations without performing any. Mutations run only with
 * `--apply --confirm=retire-taq07b-temporary-resources`, after explicit Product Owner authorization.
 *
 * Target retained state: key A (+ alias), web-encrypt role, integration-worker role.
 * Retired: aliases B and C, keys B and C (ScheduleKeyDeletion, 7-day minimum window), kms-rotation-test role.
 * Ordering: key A gets its post-validation policy (no rotation principal) BEFORE the rotation role is deleted;
 * aliases are removed before their keys are scheduled for deletion; B and C are scheduled before the role goes.
 */
import { CloudTrailClient, LookupEventsCommand } from "@aws-sdk/client-cloudtrail";
import { DeleteRoleCommand, DeleteRolePolicyCommand, GetRoleCommand, GetRolePolicyCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import {
  DeleteAliasCommand, DescribeKeyCommand, GetKeyPolicyCommand, KMSClient, ListAliasesCommand, ListGrantsCommand,
  ListResourceTagsCommand, PutKeyPolicyCommand, ScheduleKeyDeletionCommand,
} from "@aws-sdk/client-kms";
import { GUARD_POLICY_NAME, KEY_SLOTS, PREFIX, REGION, ROLE_NAMES, SESSION_PREFIX } from "../lib/config.mjs";
import { describeError, log } from "../lib/guard.mjs";
import { guardPolicy, keyPolicy, keyPolicyAPostValidation, policyDiff, samePolicy, trustPolicy, workerGuardPostValidation } from "../lib/policies.mjs";
import { StopValidation } from "../lib/recorder.mjs";

export const DELETION_WINDOW_DAYS = 7;
export const CONFIRM_TOKEN = "retire-taq07b-temporary-resources";

/** The ordered mutation list (pure; also used offline). */
export function plannedMutations() {
  return [
    { step: 1, service: "kms", action: "PutKeyPolicy", target: `key A (${KEY_SLOTS.A.alias})`, detail: "apply the reviewed post-validation policy (no rotation principal; ReEncrypt* denied to everyone)" },
    { step: 2, service: "iam", action: "PutRolePolicy", target: `${ROLE_NAMES.worker}/${GUARD_POLICY_NAME}`, detail: "tighten the deny-only guard: Decrypt only under key A (drops the key B reference)" },
    { step: 3, service: "kms", action: "DeleteAlias", target: KEY_SLOTS.B.alias, detail: "remove alias B" },
    { step: 4, service: "kms", action: "ScheduleKeyDeletion", target: "key B", detail: `PendingWindowInDays=${String(DELETION_WINDOW_DAYS)} (cancellable until it expires)` },
    { step: 5, service: "kms", action: "DeleteAlias", target: KEY_SLOTS.C.alias, detail: "remove alias C" },
    { step: 6, service: "kms", action: "ScheduleKeyDeletion", target: "key C", detail: `PendingWindowInDays=${String(DELETION_WINDOW_DAYS)} (cancellable until it expires)` },
    { step: 7, service: "iam", action: "DeleteRolePolicy", target: `${ROLE_NAMES.rotation}/${GUARD_POLICY_NAME}`, detail: "remove the rotation-test guard (required before deleting the role)" },
    { step: 8, service: "iam", action: "DeleteRole", target: ROLE_NAMES.rotation, detail: "retire the rotation-test role (no remaining policy references it)" },
  ];
}

export function targetState() {
  return {
    retained: [`KMS key A + ${KEY_SLOTS.A.alias} (automatic rotation 365 days)`, `IAM role ${ROLE_NAMES.web}`, `IAM role ${ROLE_NAMES.worker}`],
    scheduledForDeletion: [`KMS key B (${String(DELETION_WINDOW_DAYS)}-day window)`, `KMS key C (${String(DELETION_WINDOW_DAYS)}-day window)`],
    deleted: [KEY_SLOTS.B.alias, KEY_SLOTS.C.alias, `IAM role ${ROLE_NAMES.rotation} (and its inline guard)`],
    expectedMonthlyCostAfterCleanup:
      "about USD 1/month for key A (+USD 1/month after each of its first two automatic rotations, capped at about USD 3/month); B and C are billed only until deletion (worst case under USD 0.50 for the window); IAM roles are free",
  };
}

async function allPages(fetchPage, pick, next) {
  const items = [];
  for (let marker; ;) {
    const page = await fetchPage(marker);
    items.push(...(pick(page) ?? []));
    marker = next(page);
    if (!marker) return items;
  }
}

/** Read-only inspection: current state + preconditions. Nothing is changed. */
export async function inspectForCleanup({ operator, account, operatorRoleArn, operatorRoleName, rec }) {
  const kms = new KMSClient({ region: REGION, credentials: operator });
  const iam = new IAMClient({ region: REGION, credentials: operator });
  const ct = new CloudTrailClient({ region: REGION, credentials: operator });

  const aliases = await allPages((m) => kms.send(new ListAliasesCommand({ Marker: m })), (p) => p.Aliases, (p) => (p.Truncated ? p.NextMarker : undefined));
  const ours = aliases.filter((a) => a.AliasName.startsWith(`alias/${PREFIX}`));
  const keys = {};
  for (const [slot, s] of Object.entries(KEY_SLOTS)) {
    const alias = ours.find((a) => a.AliasName === s.alias);
    if (!alias) throw new StopValidation(`alias ${s.alias} missing — state differs from the validated state; refusing to plan`);
    const meta = (await kms.send(new DescribeKeyCommand({ KeyId: alias.TargetKeyId }))).KeyMetadata;
    const tags = (await kms.send(new ListResourceTagsCommand({ KeyId: meta.KeyId }))).Tags ?? [];
    const policy = (await kms.send(new GetKeyPolicyCommand({ KeyId: meta.KeyId, PolicyName: "default" }))).Policy;
    const grants = await allPages((m) => kms.send(new ListGrantsCommand({ KeyId: meta.KeyId, Marker: m })), (p) => p.Grants, (p) => (p.Truncated ? p.NextMarker : undefined));
    keys[slot] = { meta, tags, policy, grants: grants.length };
  }
  const keyArns = Object.fromEntries(Object.entries(keys).map(([slot, k]) => [slot, k.meta.Arn]));
  const tagged = (slot) => keys[slot].tags.some((t) => t.TagKey === "Validation" && t.TagValue === "TA-Q-07b") && keys[slot].tags.some((t) => t.TagKey === "Slot" && t.TagValue === slot);

  rec.assert("C1", "exactly the three approved aliases exist", ours.length === 3);
  for (const slot of ["A", "B", "C"]) {
    rec.assert(`C2${slot}`, `key ${slot}: Enabled, tagged Validation=TA-Q-07b / Slot=${slot}, no grants`, keys[slot].meta.KeyState === "Enabled" && tagged(slot) && keys[slot].grants === 0);
  }
  rec.assert("C3A", "key A policy is the validated TA-Q-07b policy (the post-validation policy is not applied yet)", samePolicy(keys.A.policy, keyPolicy("A", account)));
  rec.assert("C3B", "key B policy is the validated TA-Q-07b policy", samePolicy(keys.B.policy, keyPolicy("B", account)));
  rec.assert("C3C", "key C policy is the validated TA-Q-07b policy", samePolicy(keys.C.policy, keyPolicy("C", account)));

  for (const [role, RoleName] of Object.entries(ROLE_NAMES)) {
    const r = (await iam.send(new GetRoleCommand({ RoleName }))).Role;
    const g = await iam.send(new GetRolePolicyCommand({ RoleName, PolicyName: GUARD_POLICY_NAME }));
    rec.assert(
      `C4-${role}`,
      `${RoleName}: trust and guard are the validated ones`,
      samePolicy(decodeURIComponent(r.AssumeRolePolicyDocument), trustPolicy(account, operatorRoleArn)) && samePolicy(decodeURIComponent(g.PolicyDocument), guardPolicy(role, keyArns)),
    );
  }

  // Keys B and C were used only by TA-Q-07b: every successful CloudTrail KMS event naming them came from a
  // TA-Q-07b test session or the operator. (Denied calls carry no request parameters in CloudTrail.)
  const since = new Date(Math.min(keys.B.meta.CreationDate.getTime(), keys.C.meta.CreationDate.getTime()) - 60_000);
  const events = [];
  for (let token; ;) {
    const page = await ct.send(new LookupEventsCommand({ LookupAttributes: [{ AttributeKey: "EventSource", AttributeValue: "kms.amazonaws.com" }], StartTime: since, EndTime: new Date(), MaxResults: 50, NextToken: token }));
    events.push(...(page.Events ?? []));
    token = page.NextToken;
    if (!token) break;
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  const ids = new Set(["B", "C"].flatMap((slot) => [keys[slot].meta.KeyId, keys[slot].meta.Arn]));
  let usage = 0;
  let foreign = 0;
  for (const event of events) {
    const detail = JSON.parse(event.CloudTrailEvent ?? "{}");
    const values = Object.values(detail.requestParameters ?? {}).filter((v) => typeof v === "string");
    if (!values.some((v) => ids.has(v))) continue;
    usage += 1;
    const arn = detail.userIdentity?.arn ?? "";
    const session = arn.split("/").pop() ?? "";
    const allowedActor = session.startsWith(`${SESSION_PREFIX}-`) || arn.includes(`/${operatorRoleName}/`);
    if (!allowedActor) foreign += 1;
  }
  rec.assert("C5", "keys B and C were used only by TA-Q-07b test sessions and the operator (CloudTrail)", foreign === 0);

  return {
    keyArns,
    current: {
      aliases: ours.map((a) => a.AliasName).sort(),
      keys: Object.fromEntries(Object.entries(keys).map(([slot, k]) => [slot, { keyId: k.meta.KeyId, state: k.meta.KeyState, grants: k.grants }])),
      roles: Object.values(ROLE_NAMES),
      cloudTrailEventsNamingKeysBC: usage,
    },
    keyAPolicyDiff: policyDiff(keyPolicy("A", account), keyPolicyAPostValidation(account)),
    workerGuardDiff: policyDiff(guardPolicy("worker", keyArns), workerGuardPostValidation(keyArns.A)),
  };
}

/** Executes the plan in order. Every step is verified; any error stops the sequence. Never called by dry-run. */
export async function applyCleanup({ operator, account, keyArns }) {
  const kms = new KMSClient({ region: REGION, credentials: operator });
  const iam = new IAMClient({ region: REGION, credentials: operator });
  const done = [];
  const step = async (n, label, fn) => {
    try {
      await fn();
      done.push({ step: n, action: label, result: "done" });
      log(`[cleanup] step ${String(n)} done — ${label}`);
    } catch (error) {
      log(`[cleanup] step ${String(n)} FAILED — ${label}: ${describeError(error)}; stopping`);
      throw new StopValidation(`cleanup step ${String(n)} failed`);
    }
  };
  const postA = keyPolicyAPostValidation(account);
  await step(1, "PutKeyPolicy key A (post-validation)", async () => {
    await kms.send(new PutKeyPolicyCommand({ KeyId: keyArns.A, PolicyName: "default", Policy: JSON.stringify(postA) }));
    const now = (await kms.send(new GetKeyPolicyCommand({ KeyId: keyArns.A, PolicyName: "default" }))).Policy;
    if (!samePolicy(now, postA)) throw Object.assign(new Error("verify"), { name: "KeyPolicyVerificationFailed" });
  });
  await step(2, "PutRolePolicy worker guard (key A only)", async () => {
    await iam.send(new PutRolePolicyCommand({ RoleName: ROLE_NAMES.worker, PolicyName: GUARD_POLICY_NAME, PolicyDocument: JSON.stringify(workerGuardPostValidation(keyArns.A)) }));
  });
  await step(3, `DeleteAlias ${KEY_SLOTS.B.alias}`, () => kms.send(new DeleteAliasCommand({ AliasName: KEY_SLOTS.B.alias })));
  await step(4, "ScheduleKeyDeletion key B", () => kms.send(new ScheduleKeyDeletionCommand({ KeyId: keyArns.B, PendingWindowInDays: DELETION_WINDOW_DAYS })));
  await step(5, `DeleteAlias ${KEY_SLOTS.C.alias}`, () => kms.send(new DeleteAliasCommand({ AliasName: KEY_SLOTS.C.alias })));
  await step(6, "ScheduleKeyDeletion key C", () => kms.send(new ScheduleKeyDeletionCommand({ KeyId: keyArns.C, PendingWindowInDays: DELETION_WINDOW_DAYS })));
  await step(7, `DeleteRolePolicy ${ROLE_NAMES.rotation}`, () => iam.send(new DeleteRolePolicyCommand({ RoleName: ROLE_NAMES.rotation, PolicyName: GUARD_POLICY_NAME })));
  await step(8, `DeleteRole ${ROLE_NAMES.rotation}`, () => iam.send(new DeleteRoleCommand({ RoleName: ROLE_NAMES.rotation })));
  return done;
}
