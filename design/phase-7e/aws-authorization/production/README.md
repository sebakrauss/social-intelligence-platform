# Production credential cryptography — target design (Step H7-credential-context-code-readiness)

Status: **DESIGNED, NOT APPLIED.** Nothing in this directory exists in AWS. The code knows the `prod` label
(`platform/crypto/credentials/context.ts`, `aws-kms-config.ts`); no production key, role, trust anchor, profile or
certificate has been created, and no Trigger.dev or Vercel variable names a production resource. Code readiness is not
infrastructure readiness: every resource below is created only in its own authorized gate, by the operator.

## 1. The `prod` cryptographic environment contract

| Aspect | Contract |
|---|---|
| Label | `CREDENTIAL_CONTEXT_ENV=prod`. A closed value of `CREDENTIAL_CONTEXT_ENVS` (`local`, `test`, `dev`, `prod`) and of `KMS_CONTEXT_ENVS` (`dev`, `prod`). |
| Not the tier | `APP_DEPLOYMENT_ENV=production` is the deployment tier (provider composition); `prod` is the key environment. The KMS diagnostic pairs them (`KMS_DIAGNOSTIC_TARGETS`: `staging ↔ dev`, `production ↔ prod`) and refuses any other pairing. |
| Binding | The label is the `env` field of the six-field context `{app, purpose, env, v, workspace_id, credential_id}`: sent to KMS as the encryption context AND bound as AAD to the wrapped data key and to the AES-256-GCM payload. A `dev` envelope never opens under `prod`, nor the reverse — by cryptography (AAD), by key (different KEK) and by policy (`kms:EncryptionContext:env`). |
| Envelope | Format v1, context version 1, logical key reference `kms-provider-credentials-v1` — unchanged. The physical production key ARN appears only in `CREDENTIAL_KMS_KEY_ARN` / `CREDENTIAL_KMS_ALLOWED_KEY_ARNS`. |
| Who seals, who opens | WEB (`CREDENTIAL_KMS_WEB_ROLE_ARN`, Vercel OIDC) → `kms:GenerateDataKey` only. INTEGRATION worker (Roles Anywhere) → `kms:Decrypt` only. MAIN and INTELLIGENCE hold no crypto variable (`jobs/plane-environment.ts`). |
| Identity ↔ label | The worker certificate's subject CN must be `social-intelligence-platform-integration-prod` (`INTEGRATION_WORKLOAD_SUBJECT_CN_PREFIX` + label). The dev certificate is refused under `prod`, the prod certificate under `dev`. |
| No fallback | KMS → local keyring never; `LOCAL_KEYRING_KEY` next to KMS refuses; a deployed runtime without KMS refuses. |

## 2. Development, staging and production

| | development (local) | staging tier (deployed, label `dev`) | production (deployed, label `prod`) |
|---|---|---|---|
| `NODE_ENV` | development / test | production | production |
| `APP_DEPLOYMENT_ENV` | unset | `staging` (staging stub providers) | `production` (real Meta adapter; no stub) |
| Keyring | local keyring (`LOCAL_KEYRING_KEY`), label `local` / `test` | AWS KMS, DEV key, label `dev` | AWS KMS, **PRODUCTION key**, label `prod` |
| Worker identity | none (local opener) | Roles Anywhere DEV trust anchor / profile / role, CN `…-integration-dev` | Roles Anywhere **PROD** trust anchor / profile / role, CN `…-integration-prod` |
| Web identity | none (local sealer) | Vercel OIDC → DEV web role | Vercel OIDC (production project/environment) → **PROD** web role |
| Database | local cluster | social-intelligence-dev-v2 | social-intelligence-prod |

## 3. AWS resources to create (Gate 2, operator)

Placeholders are the only identifiers used here (vocabulary in `../README.md`).

| Resource | Placeholder(s) | Notes |
|---|---|---|
| AWS account (recommended: separate) | `<PROD_AWS_ACCOUNT_ID>`, `<PROD_AWS_PARTITION>` | A shared account requires strict separation: distinct key, roles, trust anchor, profile, CA, plus an SCP denying `kms:*` on the production key to all but the two production roles. |
| Region | `<PROD_KMS_REGION>` = `sa-east-1` | Same region as the production database (TA-Q-05 coherence; KMS is regional). |
| CloudTrail | `<PROD_CLOUDTRAIL_TRAIL_NAME>`, `<PROD_CLOUDTRAIL_BUCKET_NAME>` | Three API operations, three contracts (§3a): `artifacts/cloudtrail-create-trail.json` (`CreateTrail`: multi-region, global service events, log-file validation, not an organization trail), `artifacts/cloudtrail-put-event-selectors.json` (`PutEventSelectors`: `ReadWriteType: All`, management events included, **no** `ExcludeManagementEventSources`) and `artifacts/cloudtrail-start-logging.json` (`StartLogging`). KMS `Decrypt` and `GenerateDataKey` are management **Read** events and `PutKeyPolicy`/`DisableKey`/`ScheduleKeyDeletion` management **Write** events: a write-only selector or a `kms.amazonaws.com` exclusion loses visibility. KMS has no "data events"; nothing else to enable. |
| KMS key | `<PROD_KMS_KEY_ARN>`, `<PROD_KMS_KEY_ALIAS>` | Symmetric, customer-managed, automatic yearly rotation ON (transparent to Decrypt). Key policy = the COMPLETE document `artifacts/kms-key-policy.json` (9 statements, §4a); the `kms-*-statement.json` / `kms-deny-*.json` files are its reviewed fragments and must stay identical to it. Created with `--policy file://kms-key-policy.json` and **never** `--bypass-policy-lockout-safety-check`. |
| OIDC provider | `<PROD_VERCEL_OIDC_PROVIDER_ARN>` | `artifacts/vercel-oidc-provider.json`: Vercel **Team** issuer `https://oidc.vercel.com/social-intelligence`, client ID (audience) exactly `sts.amazonaws.com` — the custom audience the adapter requests (`AWS_STS_OIDC_AUDIENCE`); it must be registered on the provider or every exchange fails. |
| Web role | `<PROD_WEB_ROLE_NAME>`, `<PROD_WEB_ROLE_ARN>` | Trust: `artifacts/web-trust-policy.json` — `sts:AssumeRoleWithWebIdentity` only, `StringEquals` on `aud` = `sts.amazonaws.com`, `sub` = `owner:social-intelligence:project:social-intelligence-platform:environment:production` and `sts:RoleSessionName` = `wrenkind-vercel-web`; no Preview, Development or other project (no wildcard anywhere). Permissions: `artifacts/web-role-policy.json` (`<PROD_WEB_POLICY_NAME>`). |
| Worker role | `<PROD_WORKER_ROLE_NAME>`, `<PROD_WORKER_ROLE_ARN>` | Trust: `artifacts/worker-trust-policy.json`. Inline guard `artifacts/worker-deny-guard.json` (`<PROD_GUARD_POLICY_NAME>`). No permissions boundary (it would block the key-policy Allow). |
| Offline CA | `<PROD_WORKLOAD_CA_CN>`, `<PROD_WORKLOAD_CA_CERTIFICATE_PEM>` | New CA, never the DEV CA. Private key custodied outside personal machines (see §5). |
| Trust anchor | `<PROD_ROLES_ANYWHERE_TRUST_ANCHOR_NAME>`, `<PROD_ROLES_ANYWHERE_TRUST_ANCHOR_ARN>` | `artifacts/roles-anywhere-trust-anchor.json`: the CA's PUBLIC certificate bundle. |
| Profile | `<PROD_ROLES_ANYWHERE_PROFILE_NAME>` | `artifacts/roles-anywhere-profile.json`: exactly the worker role, 900 s, `acceptRoleSessionName` false, Decrypt-only session policy. |
| Worker leaf certificate | — | P-256, CN `social-intelligence-platform-integration-prod`, issuer CN `<PROD_WORKLOAD_CA_CN>`, 90-day validity, `CA:FALSE`, key usage Digital Signature. |

## 3a. CloudTrail — preconditions, sequence and verification

| # | Precondition / step | Detail | Status |
|---|---|---|---|
| 1 | S3 bucket exists before `CreateTrail` | `<PROD_CLOUDTRAIL_BUCKET_NAME>` in the production account, region `sa-east-1`, dedicated to CloudTrail (never shared with application data). | **Blocking dependency**: no bucket contract exists in this directory (bucket and policy resources are ARNs, which this directory's convention forbids). The operator applies AWS's official template at creation time. |
| 2 | Bucket policy permits authorized delivery | AWS's official CloudTrail bucket policy, exactly: `Principal` = `cloudtrail.amazonaws.com`; `s3:GetBucketAcl` on the bucket; `s3:PutObject` on `<bucket>/AWSLogs/<PROD_AWS_ACCOUNT_ID>/*`; conditions `aws:SourceArn` = the trail's ARN (`<PROD_CLOUDTRAIL_TRAIL_NAME>` in `sa-east-1`, account `<PROD_AWS_ACCOUNT_ID>`) and `s3:x-amz-acl` = `bucket-owner-full-control`. Not a Requester Pays bucket. | **Blocking dependency** (same reason). |
| 3 | Public access blocked | S3 Block Public Access: all four settings on; no ACL grants; default encryption SSE-S3 (or SSE-KMS with a key that is NOT the provider-credential key). | Operator checklist. |
| 4 | Retention and integrity | Versioning on; Object Lock (compliance mode, 365 days) or a lifecycle rule that never expires before 365 days; `EnableLogFileValidation: true` so digest files prove integrity. | Operator checklist. |
| 5 | Home region | The trail is created from `sa-east-1` (its home region): `PutEventSelectors` must be called from the home region (`InvalidHomeRegionException` otherwise). Multi-region delivery covers `us-east-1` (STS/IAM global events, Trigger.dev callers). | Contract (`IsMultiRegionTrail`, `IncludeGlobalServiceEvents`). |
| 6 | Sequence | `CreateTrail` (`cloudtrail-create-trail.json`) → `PutEventSelectors` (`cloudtrail-put-event-selectors.json`, same `TrailName`) → `StartLogging` (`cloudtrail-start-logging.json`, same `Name`). A trail created through the API is **not logging** until `StartLogging` succeeds; the console performs the three steps in one flow. | Contracts. |
| 7 | Three distinct states | *Trail created* (`DescribeTrails` lists it) ≠ *logging active* (`GetTrailStatus.IsLogging = true`) ≠ *delivery confirmed* (`GetTrailStatus.LatestDeliveryTime` set and a `AWSLogs/<PROD_AWS_ACCOUNT_ID>/CloudTrail/sa-east-1/…` object present in the bucket). Only the third proves evidence is being kept. | Verification. |
| 8 | Verification operations (read-only) | `DescribeTrails` → fields equal `cloudtrail-create-trail.json`; `GetEventSelectors` → equals `cloudtrail-put-event-selectors.json` (one selector, `All`, management included, no exclusions); `GetTrailStatus` → `IsLogging` true, no `LatestDeliveryError`, `LatestDigestDeliveryTime` set; S3 `ListObjectsV2` on the `AWSLogs/` prefix → at least one log and one digest object within 15 minutes of a `ConsoleLogin`. | Gate 2 acceptance. |

KMS visibility (audit): with `ReadWriteType: All`, `IncludeManagementEvents: true` and an empty exclusion list the trail records `GenerateDataKey` and `Decrypt` (management Read), `PutKeyPolicy`, `DisableKey`, `EnableKey`, `ScheduleKeyDeletion`, `CancelKeyDeletion`, `CreateGrant` attempts (management Write), and the Roles Anywhere operations `CreateSession`, `CreateTrustAnchor`/`UpdateTrustAnchor`/`DisableTrustAnchor`, `CreateProfile`/`UpdateProfile`/`DisableProfile`, `ImportCrl` (management events of `rolesanywhere.amazonaws.com`). Denied KMS calls are logged without request parameters (TA-Q-07b finding).

## 4a. The complete key policy (`artifacts/kms-key-policy.json`) — administration, recovery and use

| Statement | Effect | Principal | Actions | Why |
|---|---|---|---|---|
| `EnableIamUserPermissions` | Allow | the account principal `<PROD_AWS_ACCOUNT_PRINCIPAL_ARN>` (the production account's root principal) | `kms:*` | The AWS "Enable IAM User Permissions" pattern: lets the account delegate through IAM policies and guarantees the key never becomes unmanageable (the root user cannot be deleted). It grants nothing to any IAM principal by itself. |
| `AllowKeyAdministrators` | Allow | `<PROD_OPERATOR_ROLE_ARN>` | the standard administrator set (`Create*`, `Describe*`, `Enable*`, `List*`, `Put*`, `Update*`, `Revoke*`, `Disable*`, `Get*`, `Delete*`, `TagResource`, `UntagResource`, `ScheduleKeyDeletion`, `CancelKeyDeletion`, `RotateKeyOnDemand`) | Day-to-day administration (policy edits, alias, rotation, disable/enable, tags) by an SSO role with MFA — never by a laptop credential. No cryptographic use. |
| `WebSealOnly` / `WorkerDecryptOnly` | Allow | web role / worker role | `kms:GenerateDataKey` / `kms:Decrypt` with the exact six-key `env=prod` context | Cryptographic use, one operation each. |
| `DenyDataKeysExceptWeb`, `DenyDecryptExceptWorker` | Deny | `*` except the one role | data keys / Decrypt | Administrators and root cannot use the key cryptographically (separation of administration and use). |
| `DenyReEncryptAndGrantsToEveryone` | Deny | `*` | `ReEncrypt*`, `CreateGrant`, `RetireGrant`, `RevokeGrant` | No grant and no re-encryption path exists until a rotation design is authorized (TA §65). **Not permanent:** `PutKeyPolicy` is not denied, so an administrator (or root) lifts it by an authorized policy change — the two-step is the control. |
| `DenyAdministrationToRuntimePrincipals` | Deny | `*` when `aws:PrincipalArn` is a runtime role | everything but `Decrypt`, `GenerateDataKey`, `DescribeKey` | Runtime roles can never administer the key, whatever IAM policy they are later given. |
| `DenyScheduleKeyDeletionToEveryone` | Deny | `*` | `kms:ScheduleKeyDeletion` | Deleting the key destroys every envelope it protects. Deletion needs a prior, deliberate policy change (`PutKeyPolicy` removing this statement) — a rollback is never "delete the key". `DisableKey` (reversible) stays available to administrators. |

Offline evaluation (tests/architecture, deny-wins model): root → `PutKeyPolicy` ALLOW, `Decrypt` DENY, `ScheduleKeyDeletion` DENY; administrator → `PutKeyPolicy`/`DescribeKey`/`DisableKey`/`EnableKeyRotation`/`CancelKeyDeletion` ALLOW, `Decrypt`/`GenerateDataKey`/`CreateGrant`/`ReEncryptFrom`/`ScheduleKeyDeletion` DENY; web → `GenerateDataKey` under `env=prod` ALLOW, under `env=dev`, with a missing or extra key, or `Decrypt` DENY; worker → `Decrypt` under `env=prod` ALLOW, `GenerateDataKey`/`PutKeyPolicy` DENY; any other principal → DENY. This is an offline model of documented AWS semantics, not an AWS evaluation (§8).

## 4. Least privilege (what the templates grant and deny)

| Principal | Allowed | Denied (explicit) |
|---|---|---|
| Production web role | `kms:GenerateDataKey` on `<PROD_KMS_KEY_ARN>` with the exact six-key `env=prod` context (`WebSealOnly` + `web-role-policy.json`) | Everything else (`DenyEverythingButGenerateDataKey`); `kms:Decrypt` (`DenyDecryptExceptWorker`) |
| Production worker role | `kms:Decrypt` on `<PROD_KMS_KEY_ARN>` with the exact six-key `env=prod` context (`WorkerDecryptOnly`; session policy; guard) | Everything else (`DenyEverythingButDecrypt`); Decrypt outside the key; data keys (`DenyDataKeysExceptWeb`) |
| Everyone | — | `kms:ReEncrypt*`, `kms:CreateGrant`, `kms:RetireGrant`, `kms:RevokeGrant` (`DenyReEncryptAndGrantsToEveryone`) |
| Runtime roles | — | Any administration of the key (`DenyAdministrationToRuntimePrincipals`) |

Condition semantics (checked against the AWS KMS condition-key documentation): `kms:EncryptionContext:<key>` uses
`StringEquals` / `StringLike` only (never a set operator); `kms:EncryptionContextKeys` uses `ForAllValues:StringEquals`
with the six names, and because `ForAllValues` alone is satisfied by a request with no context, every key is also
required by its own `StringEquals`/`StringLike`. Roles Anywhere trust: principal `rolesanywhere.amazonaws.com`, actions
`sts:AssumeRole`, `sts:TagSession`, `sts:SetSourceIdentity`, conditions `aws:SourceArn` (trust anchor),
`aws:PrincipalTag/x509Subject/CN`, `aws:PrincipalTag/x509Issuer/CN`. A reviewed template is not a deployed policy: Gate 2
ends with a read-only recapture that compares the live policies with these artifacts.

## 4b. Creation order without circular dependencies or temporary privilege

1. Account, SSO (`<PROD_OPERATOR_ROLE_ARN>` as a permission-set role), Budgets, SCPs. 2. CloudTrail bucket + policy (§3a, operator), then `cloudtrail-create-trail.json` → `cloudtrail-put-event-selectors.json` → `cloudtrail-start-logging.json`, verified logging and delivery — before any key exists. 3. OIDC provider (`vercel-oidc-provider.json`). 4. Web role with `web-trust-policy.json` and **no permissions yet**. 5. Production CA (offline, §5) → 6. trust anchor (`roles-anywhere-trust-anchor.json`). 7. Worker role with `worker-trust-policy.json` (needs the trust anchor ARN) and no permissions yet. 8. Profile (`roles-anywhere-profile.json`, needs the worker role ARN; its session policy names the key ARN, so the profile is created AFTER step 9 or updated then). 9. KMS key with the complete `kms-key-policy.json` (needs both role ARNs and the operator role ARN) + alias + rotation. 10. Attach `web-role-policy.json` to the web role and the inline `worker-deny-guard.json` to the worker role (both need the key ARN). 11. Leaf certificate (§5). 12. Read-only recapture against these artifacts. No step grants a privilege that a later step removes: roles exist without permissions until the key they are scoped to exists.

Deployability: `kms-key-policy.json`, `web-trust-policy.json`, `worker-trust-policy.json`, `web-role-policy.json`, `worker-deny-guard.json`, `revoke-older-sessions.json` are complete policy documents, syntactically and semantically validated offline. `vercel-oidc-provider.json`, `roles-anywhere-profile.json`, `roles-anywhere-trust-anchor.json`, `cloudtrail-create-trail.json`, `cloudtrail-put-event-selectors.json`, `cloudtrail-start-logging.json` are API field contracts (one per operation). The `kms-*-statement.json` / `kms-deny-*.json` files are fragments of the key policy and are not applied on their own. **None has been validated in AWS.**

## 5. Custody of the CA and private keys

- The production CA private key is generated and kept outside personal laptops: an HSM-backed or KMS asymmetric signing
  key, or at minimum the team vault with two custodians and an access log. The DEV CA (laptop, `~/.wrenkind-pki/dev`) is
  never reused for production.
- The worker leaf private key exists in exactly two places: the INTEGRATION production plane's secret store
  (`INTEGRATION_AWS_WORKLOAD_PRIVATE_KEY_PEM`) and the vault. Never in the repository, a chat, a ticket or a log.
- Inventory with owner and expiry: CA (10 years, rotate at 5), leaf (90 days, rotate at 60), KMS key (automatic),
  Vercel OIDC trust (review yearly).

## 6. Revocation and rotation

| Event | Action |
|---|---|
| Leaf rotation (normal) | Issue a new leaf from the production CA; install it in the plane (one env import: certificate + key); verify one diagnostic run; retire the old leaf (`runbooks/workload-certificate-rotation.md` applies with PROD placeholders). |
| Leaf compromise | Disable the profile, then the trust anchor; attach `artifacts/revoke-older-sessions.json` with `<REVOCATION_CUTOFF_UTC>`; issue a new leaf; re-enable; review CloudTrail `CreateSession`/`Decrypt` since the suspected time. |
| CA compromise or loss | Create a new CA and trust anchor; disable the old trust anchor; re-issue the leaf. Envelopes are unaffected (the CA authenticates the worker, not the data). |
| KEK rotation (automatic) | Transparent: KMS keeps old material; `Decrypt` needs no change. |
| KEK replacement (manual) | A new key in `CREDENTIAL_KMS_ALLOWED_KEY_ARNS` next to the old one, then `ReEncrypt` of every envelope's wrapped data key, then removal of the old key. **Not available yet** — see §7. |

## 7. Open risk — no ReEncrypt / KEK-replacement tooling

`kms:ReEncrypt*` is granted to nobody and no migration tool exists (TA §65 open). Until a separate design and authorization
provide a controlled principal and tool, a compromised production KEK can only be handled by disabling the key (all
provider credentials become unreadable and must be re-authorized by the customers). Acceptable for a one-workspace
supervised shadow pilot with zero or few credentials; a blocker before general availability.

## 8. Tests that need real AWS resources (Gate 3, separate authorization)

Everything else is covered offline (`tests/unit/platform/credential-context-prod.test.ts`,
`tests/unit/jobs/integration-kms-diagnostic.test.ts`, `tests/unit/jobs/integration-aws-identity.test.ts`,
`tests/architecture/aws-authorization-artifacts.test.ts`). Live, with a synthetic credential only:

1. Production web role: `GenerateDataKey` under the `prod` context succeeds; under `env=dev` it is denied.
2. Production worker: `Decrypt` of the synthetic prod envelope succeeds (KMS diagnostic, tier `production`); the same
   blob with `env=dev` is denied; a DEV-sealed envelope is denied / unreadable.
3. A role without the policy, a disabled profile, an expired or revoked certificate: `CreateSession` or `Decrypt` denied.
4. CloudTrail shows exactly the expected `CreateSession` and `Decrypt`/`GenerateDataKey` events and nothing else.
5. Zero provider (Meta) calls during every step.

## 9. Gate 2 checklist (AWS production infrastructure)

- [ ] Operator decisions recorded: separate account vs strict separation; CA custody; region `sa-east-1`; CloudTrail retention; budget.
- [ ] Account/OU; CloudTrail bucket with the official policy, public access blocked, retention ≥ 365 days; `CreateTrail` → `PutEventSelectors` → `StartLogging`; `GetTrailStatus.IsLogging` true and first delivery confirmed in S3 — before any key exists.
- [ ] KMS key created with the complete `kms-key-policy.json` (no lockout bypass); alias; rotation on; `get-key-policy` equals the document.
- [ ] OIDC provider created with client ID `sts.amazonaws.com`; web role trust equals `web-trust-policy.json`.
- [ ] Web role (OIDC trust to the production Vercel project/environment) + `web-role-policy.json`.
- [ ] Worker role + `worker-trust-policy.json` + inline `worker-deny-guard.json`; no permissions boundary.
- [ ] Production CA created and custodied; trust anchor from its PUBLIC certificate; profile (900 s, Decrypt-only).
- [ ] Leaf certificate issued (CN `…-integration-prod`, P-256, 90 days); private key in the vault only.
- [ ] Read-only recapture: live policies, trust, profile and anchor equal the templates with placeholders resolved; no DEV resource referenced.
- [ ] Nothing installed in Trigger.dev or Vercel yet (Gate 4).
