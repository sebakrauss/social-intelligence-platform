# Step 7E.5 — AWS authorization artifacts (DEV / non-prod)

Reviewed **target design** for the INTEGRATION worker's AWS identity (Step 7E.4C source: `jobs/integration-aws-identity.ts`)
and the development provider-credential KMS key (TA §39, ADR-64). Approved in 7E.5A / 7E.5A-R1, materialized in 7E.5B.

- **Nothing here has been applied to AWS.** These files are templates, not evidence of current AWS state.
- **No artifact in this directory is a secret.** They contain placeholders only: no account IDs, ARNs, access-key IDs,
  Trigger.dev identifiers or credentials.
- **Placeholders must be resolved from fresh read-only AWS state before any apply** (`live-recapture-checklist.md`).
  The 2026-10-06 TA-Q-07b evidence (`spikes/ta-q-07-kms/`) is historical and does not authorize mutating today's
  live resources: **LIVE_POLICY_DIFF_PENDING_READ_ONLY_CAPTURE**.
- `KMS_WORKER_AUTH` stays OPEN. **PRODUCTION authorization model: UNRESOLVED** (TA-Q-05, Trigger.dev workload identity /
  topology). The bootstrap IAM-user model is DEV/non-prod only and is never carried into production by default.
- No script, npm task or infrastructure-as-code here applies anything. A future 7E.6 operator procedure renders and
  applies these after the recapture.

## State separation

| Concept | Source | Status |
|---|---|---|
| Target design | This directory | Reviewed (7E.5A-R1), not applied |
| Historical evidence | TA-Q-07b, captured 2026-10-06 | Historical only; never authorizes a live mutation |
| Current AWS state | Read-only recapture (`live-recapture-checklist.md`) | **UNVERIFIED UNTIL READ-ONLY RECAPTURE** |
| Future mutation | 7E.6 | Only after a successful recapture and reconciliation |

## Authority model

| Principal | Allow authority | Explicit-Deny authority |
|---|---|---|
| **Bootstrap IAM user** (C1_STRICT) | Identity policy `artifacts/bootstrap-identity-policy.json` **and** permissions boundary Allow, **and** exact-user role trust `artifacts/worker-trust-policy.json` — all three converge on the same worker role | Boundary `artifacts/bootstrap-permissions-boundary.json` (three Deny statements) |
| **Integration worker role** | KMS key policy statement `artifacts/kms-worker-decrypt-statement.json` (Decrypt only, exact context) | Inline guard `artifacts/worker-deny-guard.json`. **No permissions boundary** (see below) |
| **Web role** | Unchanged by this design: `WebEncryptOnly` (GenerateDataKey only), as recorded in the 2026-10-06 historical evidence; live state unverified until recapture | Unchanged, except the key-policy data-key Deny is replaced by `artifacts/kms-deny-data-keys-except-web.json` (the worker is no longer exempt) |

C1_STRICT's identity policy is **required by our design**, not because AWS universally requires one when a
same-account trust names the user directly. The redundancy is deliberate, so the AssumeRole path never depends on how
AWS combines a permissions boundary with a resource-based grant.

The worker role deliberately has **no permissions boundary**. The KMS key policy is its Allow authority, and a grant
to an IAM **role** ARN is limited by an implicit deny in that role's permissions boundary. A deny-only boundary would
therefore block the intended key-policy grant.

## Artifacts

| File | Attach to | Purpose |
|---|---|---|
| `artifacts/bootstrap-identity-policy.json` | Bootstrap user, **inline** | Allow `sts:AssumeRole` on the exact worker role only |
| `artifacts/bootstrap-permissions-boundary.json` | Bootstrap user, **customer-managed** permissions boundary | Same Allow as the ceiling; Deny everything but AssumeRole, AssumeRole on any other role, and every request made with temporary user credentials |
| `artifacts/worker-trust-policy.json` | Worker role trust policy | Exact bootstrap user; session name `integration-worker`; long-term credentials only (`aws:TokenIssueTime` absent) |
| `artifacts/worker-deny-guard.json` | Worker role, **inline** (`<DEV_GUARD_POLICY_NAME>`) | Deny everything but `kms:Decrypt`; Deny Decrypt outside the credential key |
| `artifacts/kms-worker-decrypt-statement.json` | DEV KMS key policy (one statement) | `WorkerDecryptOnly`: Decrypt with the exact six-key context |
| `artifacts/kms-deny-data-keys-except-web.json` | DEV KMS key policy (one statement) | `DenyDataKeysExceptWeb`: replaces `DenyDataKeysExceptWebAndWorker` |
| `artifacts/emergency-deny-all.json` | **Compromised** bootstrap user, inline, incident only | Full Deny; never removed while that user exists |
| `artifacts/revoke-older-sessions.json` | Worker role, inline, incident only | `AWSRevokeOlderSessions` template; `<REVOCATION_CUTOFF_UTC>` set at revocation time |

Documents: `kms-key-policy-diff.md` (target key-policy diff), `threat-model.md` (derived credentials, session lifetime,
encryption-context condition), `cloudtrail-alerting.md` (audit and alert design), `live-recapture-checklist.md` (hard
prerequisite before 7E.6), `runbooks/bootstrap-key-rotation.md`, `runbooks/bootstrap-compromise.md`.

Static checks: `tests/architecture/aws-authorization-artifacts.test.ts` parses every artifact, cross-checks the context
values and the session name against the source, and evaluates an offline model of the conditions. The model documents
our intent; it does not prove AWS behavior. Live validation is 7F.

## Placeholder vocabulary

The only placeholders allowed in artifacts and documents:

| Placeholder | Meaning |
|---|---|
| `<DEV_AWS_ACCOUNT_ID>` | Development AWS account ID |
| `<DEV_AWS_PARTITION>` | AWS partition of that account |
| `<DEV_KMS_REGION>` | Region of the provider-credential key |
| `<DEV_KMS_KEY_ARN>` | Full ARN of the DEV provider-credential KMS key |
| `<DEV_BOOTSTRAP_USER_NAME>` | Bootstrap IAM user name. It must start with `social-intelligence-platform-dev-` so the key policy's `DenyAdministrationToRuntimePrincipals` covers it |
| `<DEV_BOOTSTRAP_USER_ARN>` | Full ARN of that user |
| `<DEV_BOOTSTRAP_BOUNDARY_POLICY_ARN>` | ARN of the customer-managed boundary policy |
| `<DEV_WORKER_ROLE_NAME>` | Integration worker role name |
| `<DEV_WORKER_ROLE_ARN>` | Full ARN of the worker role |
| `<DEV_WEB_ROLE_ARN>` | Full ARN of the web (GenerateDataKey-only) role |
| `<DEV_OPERATOR_ROLE_ARN>` | ARN of the human operator role that applies changes and runs runbooks |
| `<DEV_GUARD_POLICY_NAME>` | Name of the worker's inline guard |
| `<REVOCATION_CUTOFF_UTC>` | ISO-8601 UTC cutoff, chosen when sessions are revoked |

Runbook-only operational labels, never values in a policy: `<BOOTSTRAP_KEY_A_ID>`, `<BOOTSTRAP_KEY_B_ID>`.
Alert threshold to calibrate in 7F: `<DECRYPT_HOURLY_CEILING>`.
