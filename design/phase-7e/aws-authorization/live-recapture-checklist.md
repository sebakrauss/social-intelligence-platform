# Live read-only recapture — HARD prerequisite before any 7E.6 AWS mutation

**LIVE_POLICY_DIFF_PENDING_READ_ONLY_CAPTURE.** The artifacts in this directory are a target design. The 2026-10-06
TA-Q-07b evidence is historical. Before mutating anything, capture the current state **read-only** (List/Get/Describe
calls only), resolve the placeholders from it, and compare it with the 2026-10-06 baseline.

**If any drift exists: STOP before mutation and reconcile.** No repair during capture.

Never print, store or commit secret values. Access-key metadata means IDs, status and dates only.

## Capture

- [ ] Current KMS key policy of the DEV provider-credential key (compare with the historical post-validation policy;
      `kms-key-policy-diff.md`)
- [ ] Key state, key rotation status, aliases (only the provider-credential alias expected)
- [ ] Current state of historical keys B and C (expected: deleted, or PendingDeletion and unusable; no alias)
- [ ] KMS grants on every key in scope (expected: none)
- [ ] Current worker role trust (historical: operator-only)
- [ ] Current web role trust (historical: operator-only; any Vercel OIDC trust change is a separate artifact, not part
      of this diff)
- [ ] Role inline policies for web and worker (expected: only the guard on each)
- [ ] Role managed (attached) policies (expected: none)
- [ ] Role permissions boundaries (expected: none)
- [ ] Role `MaxSessionDuration` (expected: 3600)
- [ ] Current IAM users (historical: none)
- [ ] Current access-key metadata, including the root account (historical: none)
- [ ] CloudTrail trails, event selectors, KMS exclusion setting and logging status (historical: no trail)

## Compare

- [ ] Every item matches the 2026-10-06 baseline, or each difference is explained and accepted by the TL
- [ ] Placeholders resolved from the capture: `<DEV_AWS_ACCOUNT_ID>`, `<DEV_AWS_PARTITION>`, `<DEV_KMS_REGION>`,
      `<DEV_KMS_KEY_ARN>`, `<DEV_WORKER_ROLE_NAME>`, `<DEV_WORKER_ROLE_ARN>`, `<DEV_WEB_ROLE_ARN>`,
      `<DEV_OPERATOR_ROLE_ARN>`, `<DEV_GUARD_POLICY_NAME>`
- [ ] Planned target names reviewed (whether they already exist live is part of this capture; historical: no IAM users): `<DEV_BOOTSTRAP_USER_NAME>`, `<DEV_BOOTSTRAP_USER_ARN>`,
      `<DEV_BOOTSTRAP_BOUNDARY_POLICY_ARN>`
- [ ] Rendered policies keep their reviewed structure (only placeholders substituted)
