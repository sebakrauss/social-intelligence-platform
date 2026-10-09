# DEV provider-credential KMS key — intended target diff

> **LIVE_POLICY_DIFF_PENDING_READ_ONLY_CAPTURE.** This diff is computed against the **historical** TA-Q-07b
> post-validation policy (evidence date **2026-10-06**, read-only cleanup verification 35/35). That evidence is **not**
> authorization to mutate the live key. Before any change, complete `live-recapture-checklist.md`. If live state
> differs from the 2026-10-06 baseline, STOP and reconcile first.

This document describes the intended target only. It is not a statement about current AWS state.

## Key policy statements

| Historical statement (2026-10-06) | Target | Artifact |
|---|---|---|
| `WorkerDecryptAndSeal` (worker role: `kms:Decrypt` + `kms:GenerateDataKey`, six-key context) | **Remove**. Replace with `WorkerDecryptOnly` (worker role: `kms:Decrypt` only, same six-key context) | `artifacts/kms-worker-decrypt-statement.json` |
| `DenyDataKeysExceptWebAndWorker` (Deny `kms:GenerateDataKey*`, `kms:Encrypt` unless web **or worker**) | **Remove**. Replace with `DenyDataKeysExceptWeb` (same Deny; only the web role is excepted) | `artifacts/kms-deny-data-keys-except-web.json` |
| `KeyAdministrationNoCrypto` | Unchanged | — |
| `WebEncryptOnly` | Unchanged | — |
| `DenyDecryptExceptWorker` | Unchanged | — |
| `DenyReEncryptToEveryone` | Unchanged | — |
| `DenyGrantsToEveryone` | Unchanged | — |
| `DenyAdministrationToRuntimePrincipals` | Unchanged. It matches `user/social-intelligence-platform-dev-*`, so `<DEV_BOOTSTRAP_USER_NAME>` must use that prefix | — |

## Worker role (same change set)

| Historical | Target | Artifact |
|---|---|---|
| Trust: account principal restricted to the TA-Q-07b operator role | Exact `<DEV_BOOTSTRAP_USER_ARN>`, `sts:RoleSessionName` = `integration-worker`, `aws:TokenIssueTime` absent | `artifacts/worker-trust-policy.json` |
| Inline guard: Deny all but Decrypt **and GenerateDataKey**; GenerateDataKey outside key A; Decrypt outside key A | Deny all but Decrypt; Decrypt outside `<DEV_KMS_KEY_ARN>` | `artifacts/worker-deny-guard.json` |
| `MaxSessionDuration` 3600 | Unchanged (3600) | — |
| No permissions boundary, no managed policies | Unchanged (no boundary) | — |

## Capability contract after the change

| Principal | Operation | Target |
|---|---|---|
| Web | `kms:GenerateDataKey` | Still allowed (`WebEncryptOnly`, unchanged; still excepted by `DenyDataKeysExceptWeb`) |
| Web | `kms:Decrypt` | Not added (`DenyDecryptExceptWorker` unchanged) |
| Web | `kms:ReEncrypt*` | Not added (`DenyReEncryptToEveryone` unchanged) |
| Worker | `kms:Decrypt` | The only approved crypto operation (exact six-key context) |
| Worker | `kms:GenerateDataKey*` | Removed: no Allow; explicit Deny in the key policy and in the guard |
| Worker | `kms:Encrypt` | Denied (key policy and guard) |
| Worker | `kms:ReEncrypt*` | Denied (key policy and guard) |
| Worker | `kms:CreateGrant` | Denied (`DenyGrantsToEveryone` and guard) |
| Bootstrap user | Any KMS operation | Denied (boundary, plus key-policy Denies) |
| Anyone | `kms:ReEncrypt*` | Granted to no principal. A future rotation principal is a separate operator design (TA §65, open) |

The worker's GenerateDataKey must not come back through any other path:

- another key-policy statement;
- an IAM identity policy (the key policy delegates only administration to the account, never crypto);
- a grant (`CreateGrant` is denied to everyone; the historical evidence showed 0 grants);
- a wildcard action.

KMS has no alias-level policy.

## Historical keys

The TA-Q-07b validation keys B and C were scheduled for deletion (7-day window) on 2026-10-06. Key B's historical
policy named the worker role. The recapture must confirm both keys are deleted (or still PendingDeletion and unusable)
before 7E.6.
