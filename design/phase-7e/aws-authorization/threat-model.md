# Threat model notes (DEV / non-prod)

Companion to `README.md`. This describes the semantics the artifacts rely on and their known limits. The worker's
identity is AWS IAM Roles Anywhere (Step 7G-H5.6B); the Step 7E.4C bootstrap IAM user is retired
(`runbooks/bootstrap-retirement.md`).

## 1. What the workload holds, and what it can do with it

- The INTEGRATION Trigger.dev project holds one X.509 end-entity certificate and its private key (Secret variable).
  Roles Anywhere is **not secretless**: the private key is long-lived identity material.
- Its only use is `CreateSession` (Roles Anywhere) through the exact trust anchor and profile, for the one worker role.
  The worker role can do nothing but `kms:Decrypt` on the DEV key with the exact six-key context.
- A stolen key therefore yields at most what a running worker has: 900-second worker sessions, until the certificate
  expires or the profile, the trust anchor or the trust is disabled. It never yields arbitrary account access.
- The CA's private key never reaches Trigger.dev. A stolen leaf can't issue new identities; a stolen CA key could, and
  is answered by disabling the trust anchor (`runbooks/workload-identity-compromise.md`).

| Threat | Guardrail |
|---|---|
| Leaf private key or certificate copied from Trigger.dev | Worker sessions only (≤ 900 s each); short leaf validity; disable profile / anchor / trust; rotate (compromise runbook) |
| CA certificate exposed | Harmless: it only verifies |
| CA private key compromised | Disable the trust anchor at once; new CA, new anchor, new leaf |
| Another certificate issued under the same CA | Trust requires the exact subject CN; the CA is offline and issues nothing else |
| A profile that permits another role | The profile contract allows exactly the worker role (artifact test) |
| A trust without `aws:SourceArn` or the subject/issuer CN conditions | All three are required in the artifact (artifact test); without them any anchor or any certificate of the CA would do |
| An expired certificate | `CreateSession` is refused; the adapter refuses it before any request (`IDENTITY_ACCESS_DENIED`) |
| A trust anchor or profile disabled | The intended kill switch: new sessions fail closed |
| A tampered credential helper | The executable's SHA-256 is pinned in source and checked at build and before the first use |
| The private key logged or leaked by the application | It is never an argument, never logged; it exists on disk only for one helper run (0600, then overwritten and removed) |
| A DEV certificate used for another environment | The subject CN carries the env; the adapter requires `…-<context env>`; KMS context `env` is `dev` |
| Material in a build artifact | Builds contain only the helper executables; certificate and key are runtime variables |
| Many concurrent tasks on one identity | Acceptable in DEV: one session per resolution, attributed to the same certificate serial |

## 2. Retired: derived IAM-user credentials (historical)

The bootstrap design's worst-case analysis (**AWS_DOCUMENTATION_CONFLICT — ASSUME_WORST_CASE**: credentials derived
from the user's long-term key with `GetSessionToken`) no longer applies to the worker path: the rewritten trust names no
IAM principal. It still applies to the bootstrap user itself while it exists; it has no access key, and its retired
boundary (`artifacts/retired/bootstrap-permissions-boundary.json`) stays attached until the retirement gate deletes it.

## 3. Role session lifetime

| | Seconds | Enforced by |
|---|---|---|
| Role `MaxSessionDuration` | 3600 | IAM (the minimum IAM allows for a role's maximum) |
| Profile `durationSeconds` | 900 | **Roles Anywhere**: `min(profile, request)` is what `CreateSession` asks AssumeRole for |
| Application request (`--session-duration`) | 900 | Our source (`INTEGRATION_WORKER_SESSION_SECONDS`) |
| Application acceptance | ≤ 900 + 60 s skew | Our source refuses longer credentials as misconfigured |
| Application refresh window | 120 before expiry | Our source only (`INTEGRATION_WORKER_REFRESH_WINDOW_SECONDS`) |

- Unlike the retired bootstrap path, **900 seconds is now an infrastructure-enforced maximum** for sessions obtained
  through the profile: whoever holds the certificate and key cannot ask Roles Anywhere for more.
- Session duration does not contain a key compromise: a stolen key can mint new sessions until the certificate expires
  or the profile, anchor or trust is disabled.

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
