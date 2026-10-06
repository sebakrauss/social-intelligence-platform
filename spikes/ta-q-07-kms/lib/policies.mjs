/**
 * The reviewed TA-Q-07b policies, rendered for one account. Crypto permissions live only in key policies
 * (explicit role ARNs, mandatory context); the account root gets administration only; role inline policies
 * are deny-only guards. Nothing grants kms:*.
 */
import { CONTEXT_CONSTANTS, CONTEXT_KEYS, KEY_SLOTS, ROLE_NAMES, UUID_LIKE } from "./config.mjs";

const VERSION = "2012-10-17";

export const ADMIN_ACTIONS = Object.freeze([
  "kms:DescribeKey", "kms:GetKeyPolicy", "kms:GetKeyRotationStatus", "kms:ListKeyRotations",
  "kms:ListResourceTags", "kms:ListGrants", "kms:ListKeyPolicies", "kms:PutKeyPolicy",
  "kms:EnableKey", "kms:DisableKey", "kms:EnableKeyRotation", "kms:DisableKeyRotation",
  "kms:RotateKeyOnDemand", "kms:UpdateKeyDescription", "kms:CreateAlias", "kms:UpdateAlias",
  "kms:DeleteAlias", "kms:TagResource", "kms:UntagResource", "kms:RevokeGrant",
  "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion",
]);

const RUNTIME_ADMIN_DENY = Object.freeze([
  "kms:PutKeyPolicy", "kms:DisableKey", "kms:EnableKey", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion",
  "kms:DisableKeyRotation", "kms:RotateKeyOnDemand", "kms:CreateAlias", "kms:UpdateAlias", "kms:DeleteAlias",
  "kms:RevokeGrant", "kms:TagResource", "kms:UntagResource", "kms:UpdateKeyDescription",
]);

export function contextCondition() {
  return {
    StringEquals: {
      "kms:EncryptionContext:app": CONTEXT_CONSTANTS.app,
      "kms:EncryptionContext:purpose": CONTEXT_CONSTANTS.purpose,
      "kms:EncryptionContext:env": CONTEXT_CONSTANTS.env,
      "kms:EncryptionContext:v": CONTEXT_CONSTANTS.v,
    },
    StringLike: {
      "kms:EncryptionContext:workspace_id": UUID_LIKE,
      "kms:EncryptionContext:credential_id": UUID_LIKE,
    },
    "ForAllValues:StringEquals": { "kms:EncryptionContextKeys": [...CONTEXT_KEYS] },
  };
}

export function roleArn(account, role) {
  return `arn:aws:iam::${account}:role/${ROLE_NAMES[role]}`;
}

function adminStatement(account) {
  return {
    Sid: "KeyAdministrationNoCrypto",
    Effect: "Allow",
    Principal: { AWS: `arn:aws:iam::${account}:root` },
    Action: [...ADMIN_ACTIONS],
    Resource: "*",
  };
}

function allow(sid, account, role, action) {
  return {
    Sid: sid,
    Effect: "Allow",
    Principal: { AWS: roleArn(account, role) },
    Action: action,
    Resource: "*",
    Condition: contextCondition(),
  };
}

function denyExcept(sid, action, exceptArns) {
  return {
    Sid: sid,
    Effect: "Deny",
    Principal: "*",
    Action: action,
    Resource: "*",
    Condition: { StringNotEquals: { "aws:PrincipalArn": exceptArns.length === 1 ? exceptArns[0] : exceptArns } },
  };
}

function denyAll(sid, action) {
  return { Sid: sid, Effect: "Deny", Principal: "*", Action: action, Resource: "*" };
}

function commonDenies(account) {
  return [
    denyAll("DenyGrantsToEveryone", "kms:CreateGrant"),
    {
      Sid: "DenyAdministrationToRuntimePrincipals",
      Effect: "Deny",
      Principal: "*",
      Action: [...RUNTIME_ADMIN_DENY],
      Resource: "*",
      Condition: {
        ArnLike: {
          "aws:PrincipalArn": [
            `arn:aws:iam::${account}:role/social-intelligence-platform-dev-*`,
            `arn:aws:iam::${account}:user/social-intelligence-platform-dev-*`,
          ],
        },
      },
    },
  ];
}

export function keyPolicy(slot, account) {
  const web = roleArn(account, "web");
  const worker = roleArn(account, "worker");
  const rotation = roleArn(account, "rotation");
  const statements = [adminStatement(account)];
  if (slot === "A") {
    statements.push(
      allow("WebEncryptOnly", account, "web", "kms:GenerateDataKey"),
      allow("WorkerDecryptAndSeal", account, "worker", ["kms:Decrypt", "kms:GenerateDataKey"]),
      allow("RotationReEncrypt", account, "rotation", ["kms:ReEncryptFrom", "kms:ReEncryptTo"]),
      denyExcept("DenyDecryptExceptWorker", "kms:Decrypt", [worker]),
      denyExcept("DenyDataKeysExceptWebAndWorker", ["kms:GenerateDataKey*", "kms:Encrypt"], [web, worker]),
      denyExcept("DenyReEncryptExceptRotation", "kms:ReEncrypt*", [rotation]),
    );
  } else if (slot === "B") {
    statements.push(
      allow("WorkerDecryptOnly", account, "worker", "kms:Decrypt"),
      allow("RotationReEncryptTo", account, "rotation", "kms:ReEncryptTo"),
      denyExcept("DenyDecryptExceptWorker", "kms:Decrypt", [worker]),
      denyAll("DenyDataKeysToEveryone", ["kms:GenerateDataKey*", "kms:Encrypt"]),
      denyExcept("DenyReEncryptExceptRotation", "kms:ReEncrypt*", [rotation]),
    );
  } else if (slot === "C") {
    statements.push(
      allow("RotationReEncryptToTestOnly", account, "rotation", "kms:ReEncryptTo"),
      denyAll("DenyDecryptToEveryone", "kms:Decrypt"),
      denyAll("DenyDataKeysToEveryone", ["kms:GenerateDataKey*", "kms:Encrypt"]),
      denyAll("DenyReEncryptFromToEveryone", "kms:ReEncryptFrom"),
      denyExcept("DenyReEncryptToExceptRotation", "kms:ReEncryptTo", [rotation]),
    );
  } else {
    throw new TypeError(`unknown key slot ${slot}`);
  }
  statements.push(...commonDenies(account));
  return { Version: VERSION, Id: KEY_SLOTS[slot].policyId, Statement: statements };
}

/** Only the Identity Center operator role (exact ARN, path included) may assume a test role. */
export function trustPolicy(account, operatorRoleArn) {
  return {
    Version: VERSION,
    Statement: [
      {
        Sid: "OperatorOnly",
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${account}:root` },
        Action: "sts:AssumeRole",
        Condition: { ArnLike: { "aws:PrincipalArn": operatorRoleArn } },
      },
    ],
  };
}

/** Deny-only inline guards (a second barrier; the key policies grant). */
export function guardPolicy(role, keyArns) {
  if (role === "web") {
    return {
      Version: VERSION,
      Statement: [
        { Sid: "DenyEverythingButGenerateDataKey", Effect: "Deny", NotAction: "kms:GenerateDataKey", Resource: "*" },
        { Sid: "DenyGenerateDataKeyOutsideKeyA", Effect: "Deny", Action: "kms:GenerateDataKey", NotResource: keyArns.A },
      ],
    };
  }
  if (role === "worker") {
    return {
      Version: VERSION,
      Statement: [
        { Sid: "DenyEverythingButDecryptAndGenerateDataKey", Effect: "Deny", NotAction: ["kms:Decrypt", "kms:GenerateDataKey"], Resource: "*" },
        { Sid: "DenyGenerateDataKeyOutsideKeyA", Effect: "Deny", Action: "kms:GenerateDataKey", NotResource: keyArns.A },
        { Sid: "DenyDecryptOutsideKeysAB", Effect: "Deny", Action: "kms:Decrypt", NotResource: [keyArns.A, keyArns.B] },
      ],
    };
  }
  if (role === "rotation") {
    return {
      Version: VERSION,
      Statement: [
        { Sid: "DenyEverythingButReEncrypt", Effect: "Deny", NotAction: ["kms:ReEncryptFrom", "kms:ReEncryptTo"], Resource: "*" },
        { Sid: "DenyReEncryptOutsideKeysABC", Effect: "Deny", Action: "kms:ReEncrypt*", NotResource: [keyArns.A, keyArns.B, keyArns.C] },
      ],
    };
  }
  throw new TypeError(`unknown role ${role}`);
}

/**
 * Key A after TA-Q-07b (closeout): identical to the validated policy except that the rotation-test principal
 * is gone — its RotationReEncrypt grant is removed and ReEncrypt* is denied to everyone until a future,
 * separately reviewed rotation role is introduced. No reference to a deleted principal remains.
 */
export function keyPolicyAPostValidation(account) {
  const web = roleArn(account, "web");
  const worker = roleArn(account, "worker");
  return {
    Version: VERSION,
    Id: KEY_SLOTS.A.policyId,
    Statement: [
      adminStatement(account),
      allow("WebEncryptOnly", account, "web", "kms:GenerateDataKey"),
      allow("WorkerDecryptAndSeal", account, "worker", ["kms:Decrypt", "kms:GenerateDataKey"]),
      denyExcept("DenyDecryptExceptWorker", "kms:Decrypt", [worker]),
      denyExcept("DenyDataKeysExceptWebAndWorker", ["kms:GenerateDataKey*", "kms:Encrypt"], [web, worker]),
      denyAll("DenyReEncryptToEveryone", "kms:ReEncrypt*"),
      ...commonDenies(account),
    ],
  };
}

/** Worker guard after closeout: decrypt only under key A (key B no longer exists). */
export function workerGuardPostValidation(keyArnA) {
  return {
    Version: VERSION,
    Statement: [
      { Sid: "DenyEverythingButDecryptAndGenerateDataKey", Effect: "Deny", NotAction: ["kms:Decrypt", "kms:GenerateDataKey"], Resource: "*" },
      { Sid: "DenyGenerateDataKeyOutsideKeyA", Effect: "Deny", Action: "kms:GenerateDataKey", NotResource: keyArnA },
      { Sid: "DenyDecryptOutsideKeyA", Effect: "Deny", Action: "kms:Decrypt", NotResource: keyArnA },
    ],
  };
}

/** Statement-level difference between two policies (by Sid). */
export function policyDiff(before, after) {
  const bySid = (p) => new Map(p.Statement.map((s) => [s.Sid, s]));
  const b = bySid(before);
  const a = bySid(after);
  return {
    removed: [...b.keys()].filter((sid) => !a.has(sid)),
    added: [...a.keys()].filter((sid) => !b.has(sid)),
    changed: [...a.keys()].filter((sid) => b.has(sid) && canonicalJson(a.get(sid)) !== canonicalJson(b.get(sid))),
    unchanged: [...a.keys()].filter((sid) => b.has(sid) && canonicalJson(a.get(sid)) === canonicalJson(b.get(sid))),
  };
}

/**
 * Statement IDs of every reviewed policy, collected from the code (placeholder inputs; Sids don't depend on
 * them). They are static policy constants, never data returned by AWS.
 */
export function statementIds() {
  const account = "000000000000";
  const arns = { A: "arn:a", B: "arn:b", C: "arn:c" };
  const policies = [
    ...Object.keys(KEY_SLOTS).map((slot) => keyPolicy(slot, account)),
    trustPolicy(account, "arn:operator"),
    ...Object.keys(ROLE_NAMES).map((role) => guardPolicy(role, arns)),
    keyPolicyAPostValidation(account),
    workerGuardPostValidation(arns.A),
  ];
  return [...new Set(policies.flatMap((p) => p.Statement.map((s) => s.Sid)))];
}

/** Deep comparison after key-order normalization (arrays keep their order). */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function samePolicy(a, b) {
  return canonicalJson(typeof a === "string" ? JSON.parse(a) : a) === canonicalJson(typeof b === "string" ? JSON.parse(b) : b);
}
