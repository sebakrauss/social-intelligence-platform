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
| CloudTrail | `<PROD_CLOUDTRAIL_BUCKET_NAME>` | Management-event trail of the production account; KMS data events for the production key. |
| KMS key | `<PROD_KMS_KEY_ARN>`, `<PROD_KMS_KEY_ALIAS>` | Symmetric, customer-managed, automatic yearly rotation ON (transparent to Decrypt). Key policy = `artifacts/kms-*.json` statements + administration restricted to `<PROD_OPERATOR_ROLE_ARN>` (MFA). |
| Web role | `<PROD_WEB_ROLE_NAME>`, `<PROD_WEB_ROLE_ARN>` | Trust: Vercel OIDC provider `<PROD_VERCEL_OIDC_PROVIDER_ARN>`, limited to the production project and `production` environment. Permissions: `artifacts/web-role-policy.json` (`<PROD_WEB_POLICY_NAME>`). |
| Worker role | `<PROD_WORKER_ROLE_NAME>`, `<PROD_WORKER_ROLE_ARN>` | Trust: `artifacts/worker-trust-policy.json`. Inline guard `artifacts/worker-deny-guard.json` (`<PROD_GUARD_POLICY_NAME>`). No permissions boundary (it would block the key-policy Allow). |
| Offline CA | `<PROD_WORKLOAD_CA_CN>`, `<PROD_WORKLOAD_CA_CERTIFICATE_PEM>` | New CA, never the DEV CA. Private key custodied outside personal machines (see §5). |
| Trust anchor | `<PROD_ROLES_ANYWHERE_TRUST_ANCHOR_NAME>`, `<PROD_ROLES_ANYWHERE_TRUST_ANCHOR_ARN>` | `artifacts/roles-anywhere-trust-anchor.json`: the CA's PUBLIC certificate bundle. |
| Profile | `<PROD_ROLES_ANYWHERE_PROFILE_NAME>` | `artifacts/roles-anywhere-profile.json`: exactly the worker role, 900 s, `acceptRoleSessionName` false, Decrypt-only session policy. |
| Worker leaf certificate | — | P-256, CN `social-intelligence-platform-integration-prod`, issuer CN `<PROD_WORKLOAD_CA_CN>`, 90-day validity, `CA:FALSE`, key usage Digital Signature. |

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
- [ ] Account/OU and CloudTrail trail active before any key exists.
- [ ] KMS key + alias; key policy = production statements; rotation on; administration limited to `<PROD_OPERATOR_ROLE_ARN>`.
- [ ] Web role (OIDC trust to the production Vercel project/environment) + `web-role-policy.json`.
- [ ] Worker role + `worker-trust-policy.json` + inline `worker-deny-guard.json`; no permissions boundary.
- [ ] Production CA created and custodied; trust anchor from its PUBLIC certificate; profile (900 s, Decrypt-only).
- [ ] Leaf certificate issued (CN `…-integration-prod`, P-256, 90 days); private key in the vault only.
- [ ] Read-only recapture: live policies, trust, profile and anchor equal the templates with placeholders resolved; no DEV resource referenced.
- [ ] Nothing installed in Trigger.dev or Vercel yet (Gate 4).
