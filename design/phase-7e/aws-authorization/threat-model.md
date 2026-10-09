# Threat model notes (DEV / non-prod)

Companion to `README.md`. This describes the semantics the artifacts rely on and their known limits.

## 1. Exact-user trust is bound to the principal ID

When a role trust policy names a specific IAM user ARN, IAM stores that user's unique principal ID. If the user is
deleted and a user with the same name is recreated, the old trust **does not** apply to the new user. Trusting the
new principal requires an intentional rewrite of `artifacts/worker-trust-policy.json` with the new user ARN. This is a
safety property: never automate a silent re-trust of a same-name user.

## 2. Derived IAM-user credentials (GetSessionToken)

**AWS_DOCUMENTATION_CONFLICT — ASSUME_WORST_CASE.**

- The STS API reference and the IAM "Compare AWS STS credentials" table say GetSessionToken credentials may call
  `AssumeRole` and `GetCallerIdentity`. The IAM "Permissions for GetSessionToken" page says they cannot call STS.
  We follow the worst case: such credentials can attempt `AssumeRole`.
- GetSessionToken cannot be denied by policy (it is an authentication operation). Its credentials last up to 36 hours
  and carry the IAM user's permissions, which AWS evaluates on every request.
- GetCallerIdentity also cannot be denied. It reveals only the caller's identity. Our application never calls it, so
  any call is a high-signal alert (`cloudtrail-alerting.md`).

Containment, independent layers:

1. Boundary `DenyAllTemporaryUserCredentials`: denies every action when `aws:TokenIssueTime` is present. That key is
   only in the request context when temporary credentials sign the request, never when long-term access keys do.
2. Worker trust `Null aws:TokenIssueTime = "true"`: a temporary user session cannot satisfy the trust at all.
3. Incident: `artifacts/emergency-deny-all.json` attached permanently to the compromised user. AWS documents that a
   Deny on the user also covers sessions created with GetSessionToken.
4. Recovery rewrites the trust to a NEW user (`runbooks/bootstrap-compromise.md`). The compromised principal then has
   no trust grant at all.

A single AWS page saying "no STS calls" is not a reason to drop any layer.

## 3. Role session lifetime

| | Seconds | Enforced by |
|---|---|---|
| Role `MaxSessionDuration` | 3600 | IAM (the minimum IAM allows for a role's maximum) |
| Application request (`DurationSeconds`) | 900 | Our source only (`INTEGRATION_WORKER_SESSION_SECONDS`) |
| Application refresh window | 120 before expiry | Our source only (`INTEGRATION_WORKER_REFRESH_WINDOW_SECONDS`) |

- **900 seconds is not an infrastructure-enforced maximum.** Anyone holding the long-lived bootstrap key can call
  `AssumeRole` directly and request up to 3600 seconds.
- No `sts:DurationSeconds` condition key applies to `AssumeRole`, so IAM cannot force 900 through the trust.
- The infrastructure worst case for one role session is therefore **3600 seconds**.
- Session duration does not contain a bootstrap-key compromise: a stolen long-lived key can mint new sessions until the
  bootstrap path is denied (`runbooks/bootstrap-compromise.md`).

## 4. Encryption-context condition

`artifacts/kms-worker-decrypt-statement.json` pins these values:

- Four static values with `StringEquals`, taken from source constants in `platform/crypto/credentials/context.ts` and
  `aws-kms-config.ts`: `app` = `social-intelligence-platform`, `purpose` = `provider-credential`, `env` = `dev`,
  `v` = `1`.
- The exact key set with `ForAllValues:StringEquals` on `kms:EncryptionContextKeys`: the six names `app`, `purpose`,
  `env`, `v`, `workspace_id`, `credential_id`.
- `workspace_id` and `credential_id` use a **UUID-SHAPED IDENTIFIER CONDITION**:
  `StringLike` `????????-????-????-????-????????????`.
  - In `StringLike`, `?` matches **any one character**. The pattern only requires the 8-4-4-4-12 shape with literal
    hyphens.
  - It does not check hexadecimal digits, lowercase, the UUID version or the variant.
  - Canonical UUID checking is done by the application (`isUuid` in `domain/ids.ts`) before the KMS call. The IAM
    condition is defense in depth: it refuses empty and free-form values.
  - No hexadecimal pattern is faked in IAM.
- Dynamic identifiers are **not authorization boundaries**. Another UUID-shaped identifier may satisfy the policy.
  Whether the ciphertext decrypts is then decided by KMS's cryptographic context binding: the wrong context fails with
  `InvalidCiphertextException`.
- `ForAllValues` alone is vacuous for an empty key set. Every required key is therefore also required by its own
  `StringEquals` or `StringLike`, which evaluates false when the key is absent.
- Condition-key names are case-insensitive in AWS, but `ForAllValues:StringEquals` compares key names
  case-sensitively. A differently cased key such as `App` is therefore refused.
- The context appears in CloudTrail Decrypt events. Context values are identifiers and fixed constants only, never
  sensitive data.
