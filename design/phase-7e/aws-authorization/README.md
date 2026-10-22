# Step 7E.5 / 7G-H5.6B — AWS authorization artifacts (DEV / non-prod)

Reviewed **target design** for the INTEGRATION worker's AWS identity and the development provider-credential KMS key
(TA §39, ADR-64). The worker identity is **AWS IAM Roles Anywhere** (Step 7G-H5.6A decision; source:
`jobs/integration-aws-identity.ts`). The Step 7E.4C bootstrap IAM user is **retired**: no code reads its key, every
runtime refuses its variable names, and its artifacts are kept under `artifacts/retired/` only as the deletion inventory
of resources that still exist live (`runbooks/bootstrap-retirement.md`).

- **Nothing here has been applied to AWS by this design.** These files are templates, not evidence of current AWS state.
- **No artifact in this directory is a secret.** They contain placeholders only: no account IDs, ARNs, access-key IDs,
  certificates, keys, Trigger.dev identifiers or credentials.
- **Placeholders must be resolved from fresh read-only AWS state before any apply** (`live-recapture-checklist.md`).
  The 2026-10-06 TA-Q-07b evidence (`spikes/ta-q-07-kms/`) is historical and does not authorize mutating today's
  live resources: **LIVE_POLICY_DIFF_PENDING_READ_ONLY_CAPTURE**.
- Roles Anywhere is **not secretless**: the workload's X.509 private key is long-lived identity material, held only as
  a Secret variable of the INTEGRATION Trigger.dev project. What it buys over a static access key: the key can only be
  exchanged for 900-second sessions of the one worker role, every session is attributed to the exact certificate, the
  certificate expires on its own, and the trust anchor, the profile or the trust can be disabled at once.
- **PRODUCTION authorization model: UNRESOLVED** (TA-Q-05). Native Trigger.dev workload OIDC does not exist yet (roadmap:
  planned); migrating to it later replaces only the identity adapter and the worker trust.
- No script, npm task or infrastructure-as-code here applies anything. A later, separately authorized operator gate
  renders and applies these after the recapture.

## State separation

| Concept | Source | Status |
|---|---|---|
| Target design | This directory | Reviewed, not applied |
| Historical evidence | TA-Q-07b, captured 2026-10-06; 7E.6/7E.7 live state; H3/H4 acceptance | Historical only; never authorizes a live mutation |
| Current AWS state | Read-only recapture (`live-recapture-checklist.md`) | **UNVERIFIED UNTIL READ-ONLY RECAPTURE** |
| Future mutation | Later authorized gates (trust anchor, profile, trust rewrite; then bootstrap retirement) | Only after a successful recapture and reconciliation |

## Authority model

| Principal | Allow authority | Explicit-Deny authority |
|---|---|---|
| **Integration workload** (X.509 certificate, CN `social-intelligence-platform-integration-dev`) | Roles Anywhere `CreateSession` through the trust anchor `artifacts/roles-anywhere-trust-anchor.json` and the profile `artifacts/roles-anywhere-profile.json` (exactly the worker role, 900 s, no custom session name, Decrypt-only session policy), **and** the worker trust `artifacts/worker-trust-policy.json` (service principal, exact trust anchor, exact subject CN and issuer CN) | Everything the worker role denies; the session policy can only narrow |
| **Integration worker role** | KMS key policy statement `artifacts/kms-worker-decrypt-statement.json` (Decrypt only, exact context) | Inline guard `artifacts/worker-deny-guard.json`. **No permissions boundary** (see below) |
| **Web role** | Unchanged: `WebEncryptOnly` (GenerateDataKey only); its Vercel OIDC trust is not part of this design | Unchanged, except the key-policy data-key Deny is `artifacts/kms-deny-data-keys-except-web.json` (the worker is not exempt) |
| **Retired bootstrap user** | None after the trust rewrite: the new trust names no IAM principal, so its still-attached policies grant nothing usable | Retired artifacts; removed in the retirement gate |

The trust's three conditions are **required by our design** (AWS also recommends them): without `aws:SourceArn` any
trust anchor of the account could be used, and without the subject and issuer CN conditions any certificate of the CA
could assume the role.

The worker role deliberately has **no permissions boundary**. The KMS key policy is its Allow authority, and a grant
to an IAM **role** ARN is limited by an implicit deny in that role's permissions boundary. A deny-only boundary would
therefore block the intended key-policy grant. The profile's session policy is a separate, narrowing layer.

## Artifacts

| File | Apply to | Purpose |
|---|---|---|
| `artifacts/worker-trust-policy.json` | Worker role trust policy | Roles Anywhere service principal; `sts:AssumeRole`, `sts:TagSession`, `sts:SetSourceIdentity`; exact trust anchor, subject CN and issuer CN |
| `artifacts/roles-anywhere-trust-anchor.json` | Roles Anywhere trust anchor (`CreateTrustAnchor` fields) | External CA certificate bundle (the CA's PUBLIC certificate); enabled |
| `artifacts/roles-anywhere-profile.json` | Roles Anywhere profile (`CreateProfile` fields) | Exactly the worker role; `durationSeconds` 900; `acceptRoleSessionName` false; Decrypt-only session policy (rendered as a JSON string at apply time) |
| `artifacts/worker-deny-guard.json` | Worker role, **inline** (`<DEV_GUARD_POLICY_NAME>`) | Deny everything but `kms:Decrypt`; Deny Decrypt outside the credential key |
| `artifacts/kms-worker-decrypt-statement.json` | DEV KMS key policy (one statement) | `WorkerDecryptOnly`: Decrypt with the exact six-key context |
| `artifacts/kms-deny-data-keys-except-web.json` | DEV KMS key policy (one statement) | `DenyDataKeysExceptWeb` |
| `artifacts/revoke-older-sessions.json` | Worker role, inline, incident only | `AWSRevokeOlderSessions` template; `<REVOCATION_CUTOFF_UTC>` set at revocation time |
| `artifacts/retired/bootstrap-identity-policy.json` | RETIRED — still attached live to the bootstrap user | Deletion inventory only; never re-applied |
| `artifacts/retired/bootstrap-permissions-boundary.json` | RETIRED — still attached live to the bootstrap user | Deletion inventory only; never re-applied |
| `artifacts/retired/emergency-deny-all.json` | RETIRED — incident template of the bootstrap user | Kept until the user is deleted |

Documents: `kms-key-policy-diff.md` (target key-policy diff), `threat-model.md` (workload identity, session lifetime,
encryption-context condition), `cloudtrail-alerting.md` (audit and alert design), `live-recapture-checklist.md` (hard
prerequisite), `runbooks/workload-certificate-rotation.md`, `runbooks/workload-identity-compromise.md`,
`runbooks/bootstrap-retirement.md`.

Static checks: `tests/architecture/aws-authorization-artifacts.test.ts` parses every artifact, cross-checks the context
values, the subject CN, the session duration and the profile against the source, and evaluates an offline model of the
conditions. The model documents our intent; it does not prove AWS behavior (live validation is a later gate).

## Workload certificate contract

| Item | Value |
|---|---|
| CA | External, offline; its private key never enters Trigger.dev, Git, chat or a terminal transcript |
| Leaf key | ECDSA P-256 with a **named curve** (explicit curve parameters are rejected by the credential helper) |
| Leaf subject | `CN=social-intelligence-platform-integration-dev`, `O=Wrenkind` |
| Leaf extensions | `CA:false`; key usage `digitalSignature`; SHA-256 signature |
| Leaf validity | about 90 days; rotate around day 60 (`runbooks/workload-certificate-rotation.md`) |
| Delivered to | the INTEGRATION Trigger.dev project only: certificate (confidential) and private key (Secret), PKCS#8 unencrypted |
| Revocation | short expiry plus disabling the profile, the trust anchor or the trust; a CRL is optional and not used in DEV |

## INTEGRATION deployment (credential helper)

The official helper (`jobs/aws-signing-helper.ts`: version 1.8.5, both Linux builds, pinned SHA-256) is packaged into
the INTEGRATION image only. Supported operator path, from the repository root:

```
node tools/trigger/fetch-aws-signing-helper.ts
npm run trigger:release -- --cli … --integration-project-ref … --main-project-ref …
```

The INTEGRATION image is never deployed alone: `npm run trigger:release` (root README › Jobs) deploys INTEGRATION and
then MAIN from one captured commit with the same external id, both with `--depot-build`. Before anything is deployed it
verifies the pinned helper builds (presence and SHA-256 against `jobs/aws-signing-helper.ts`) and stops with the fetch
instruction if one is missing or altered; the image-build layer below remains the enforcement boundary. Roles Anywhere,
the worker identity and the build extension are unchanged by the paired release.

| Layer | What it does | Guarantee |
|---|---|---|
| Fetch tool | Downloads each pinned URL (no redirect), verifies its SHA-256 before writing, into the git-ignored `vendor/` | Operator convenience |
| `onBuildStart` | Refuses the deploy before bundling if a build is missing or mismatched (the CLI does not catch it) | Early, visible failure only |
| `onBuildComplete` | Registers the integrity layer FIRST, then copies the verified builds into the build output as 0755; never throws (the CLI swallows that throw AND drops the extension's layers) | Staging only |
| **Image-build layer** | `RUN` steps after `COPY . .` in `/app`: each build present, a regular file (not a link), executable, exact pinned SHA-256 (`sha256sum -c`) | **The enforcement boundary**: any failure fails the image build, nothing is deployed |
| Runtime | Re-verifies the digest and the executable bit before the first use | Fails closed (`IDENTITY_MISCONFIGURED`) |

`--depot-build` matters because the image context is then the local build output, where the helper was staged. A
native build-server deploy uploads a project archive that honors `.gitignore`, so `vendor/` is absent: the preflight and
the integrity layer fail that build wherever the build extensions run. The native path is not the supported path for
this project.

## Placeholder vocabulary

The only placeholders allowed in artifacts and documents:

| Placeholder | Meaning |
|---|---|
| `<DEV_AWS_ACCOUNT_ID>` | Development AWS account ID |
| `<DEV_AWS_PARTITION>` | AWS partition of that account |
| `<DEV_KMS_REGION>` | Region of the provider-credential key (also the Roles Anywhere region) |
| `<DEV_KMS_KEY_ARN>` | Full ARN of the DEV provider-credential KMS key |
| `<DEV_WORKER_ROLE_NAME>` | Integration worker role name |
| `<DEV_WORKER_ROLE_ARN>` | Full ARN of the worker role |
| `<DEV_WEB_ROLE_ARN>` | Full ARN of the web (GenerateDataKey-only) role |
| `<DEV_OPERATOR_ROLE_ARN>` | ARN of the human operator role that applies changes and runs runbooks |
| `<DEV_GUARD_POLICY_NAME>` | Name of the worker's inline guard |
| `<DEV_ROLES_ANYWHERE_TRUST_ANCHOR_NAME>` | Name of the Roles Anywhere trust anchor |
| `<DEV_ROLES_ANYWHERE_TRUST_ANCHOR_ARN>` | Its full ARN (known only after creation) |
| `<DEV_ROLES_ANYWHERE_PROFILE_NAME>` | Name of the Roles Anywhere profile |
| `<DEV_WORKLOAD_CA_CN>` | Subject CN of the offline workload CA (the leaf's issuer CN) |
| `<DEV_WORKLOAD_CA_CERTIFICATE_PEM>` | The CA's PUBLIC certificate, PEM, entered at apply time |
| `<DEV_BOOTSTRAP_USER_NAME>` | RETIRED bootstrap IAM user name (deletion inventory). It starts with `social-intelligence-platform-dev-` |
| `<DEV_BOOTSTRAP_USER_ARN>` | Full ARN of that retired user |
| `<DEV_BOOTSTRAP_BOUNDARY_POLICY_ARN>` | ARN of its retired customer-managed boundary policy |
| `<REVOCATION_CUTOFF_UTC>` | ISO-8601 UTC cutoff, chosen when sessions are revoked |

Runbook-only operational labels, never values in a policy: `<WORKLOAD_CERTIFICATE_A_SERIAL>`,
`<WORKLOAD_CERTIFICATE_B_SERIAL>`.
Alert threshold to calibrate in live acceptance: `<DECRYPT_HOURLY_CEILING>`.
