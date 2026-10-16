# Step 7E.10-B — hosted web AWS identity: Vercel OIDC trust (DEV / non-prod)

Reviewed design, **applied and live-proven** (Step 7E.10, 2026-10-16), for the hosted web's AWS identity (source:
`server/connections/vercel-aws-identity.ts`, `server/connections/web-identity.ts`; TA §39, ADR-64). It is the
separate web-trust artifact that `../aws-authorization/live-recapture-checklist.md` refers to.

- **Applied by the operator in Step 7E.10-C** (OIDC provider, DUAL TRUST statement, Vercel Production configuration).
  These files remain templates: they are not evidence of current state, which is recorded only in local evidence.
- **No artifact in this directory is a secret.** The only placeholders are `<DEV_AWS_PARTITION>` and
  `<DEV_AWS_ACCOUNT_ID>` (vocabulary of `../aws-authorization/README.md`). The Vercel issuer, team, project and
  environment are non-secret and fixed here.
- No script, npm task or infrastructure-as-code here applies anything. Any future change starts from a fresh
  read-only capture of the web role's current trust document.

## Identity chain (target)

```
Vercel Production request → Vercel OIDC token (Team issuer)
  → audience exchange (sts.amazonaws.com) → STS AssumeRoleWithWebIdentity (sa-east-1, 3600 s, wrenkind-vercel-web)
  → social-intelligence-platform-dev-web-encrypt → kms:GenerateDataKey only → provider-credential key only
  → exact six-field encryption context
```

| Element | Value | Source |
|---|---|---|
| Issuer mode | Team | Vercel project settings (operator-observed) |
| OIDC issuer / provider URL | `https://oidc.vercel.com/social-intelligence` | Vercel project settings (operator-observed) |
| Client ID / audience | `sts.amazonaws.com` | `AWS_STS_OIDC_AUDIENCE` (platform/aws/identity.ts); the adapter asks Vercel's token exchange for it |
| Subject | `owner:social-intelligence:project:social-intelligence-platform:environment:production` | Vercel project settings (operator-observed) |
| STS action | `sts:AssumeRoleWithWebIdentity` | the official provider (`fromWebToken`) |
| Role session name | `wrenkind-vercel-web` | `WEB_AWS_ROLE_SESSION_NAME` (server/connections/web-identity.ts) |
| Session duration | 3600 s | `VERCEL_WEB_SESSION_SECONDS` |
| STS region | `sa-east-1` | the region of `CREDENTIAL_KMS_KEY_ARN` |
| Target role | `social-intelligence-platform-dev-web-encrypt` | live (operator-observed) |

The token Vercel shows in project settings has audience `https://vercel.com/social-intelligence`. That is the default
audience, not the one AWS sees: the adapter exchanges the token for audience `sts.amazonaws.com` before calling STS.
The live proof (2026-10-16) confirmed that STS accepts the exchanged token under the Team-issuer provider and trust.

## Artifacts

| File | Applied with | Purpose |
|---|---|---|
| `artifacts/vercel-oidc-provider.json` | IAM CreateOpenIDConnectProvider | Provider URL and the single client ID. Thumbprint: **VALIDATE** at apply time (current AWS behavior treats it as optional for issuers with a trusted CA) |
| `artifacts/web-trust-vercel-production-statement.json` | IAM UpdateAssumeRolePolicy on the web role | The ONE statement added to the web role's trust |

## Trust migration: DUAL TRUST

The web role's trust document after the change is exactly:

1. every statement of the **current** trust document, **verbatim** from the fresh read-only capture (today: the
   operator-only statement that admits the SIP-Dev-Administrator SSO role), and
2. `artifacts/web-trust-vercel-production-statement.json`.

The diff against the capture must show exactly one added statement and nothing else. The operator-only statement is
the break-glass sealing path: it is **not** removed in this step or in the first mutation step. Removing it is a
separate TL decision after the live Vercel proof.

## Conditions

All conditions use `StringEquals`. No wildcard, no `StringLike`, no `ForAnyValue`:

- `oidc.vercel.com/social-intelligence:aud` = `sts.amazonaws.com`;
- `oidc.vercel.com/social-intelligence:sub` = the exact Production subject. A Preview deployment
  (`…:environment:preview`), Development (`…:environment:development`), another project or another team never
  matches. Preview is denied deliberately: one Preview subject covers every branch;
- `sts:RoleSessionName` = `wrenkind-vercel-web`.

## What does not change

- The web role's permission policies: its inline guard keeps it to `kms:GenerateDataKey` on the provider-credential key.
- The KMS key policy: `WebEncryptOnly` and `DenyDataKeysExceptWeb` match on the web role ARN, which a federated
  session of the same role carries as `aws:PrincipalArn`.
- The worker role, the bootstrap user and every other principal.

## Vercel Production configuration (applied, permanent)

Production scope only; none of these is a long-lived AWS credential:

| Variable | Value |
|---|---|
| `CREDENTIAL_CONTEXT_ENV` | `dev` |
| `CREDENTIAL_KMS_KEY_ARN` | the provider-credential key ARN |
| `CREDENTIAL_KMS_ALLOWED_KEY_ARNS` | the same single ARN |
| `CREDENTIAL_KMS_WEB_ROLE_ARN` | the web-encrypt role ARN |

- OIDC federation is enabled in the project with issuer mode Team. Vercel supplies the request token: no token
  variable is provisioned by hand.
- Never `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` or `AWS_PROFILE`: the hosted web refuses
  them (`server/http/web-environment.ts`).
- `APP_DEPLOYMENT_ENV` is not part of the web contract and stays forbidden in the hosted web.

## Step 7E.10 result: PASS_ALIGNED_LIVE_PROVEN_CLEANED (2026-10-16)

Proven chain, live, from a Vercel Production deployment:

```
Vercel Production → Team OIDC → AssumeRoleWithWebIdentity → social-intelligence-platform-dev-web-encrypt
  → KMS GenerateDataKey (provider-credential key, exact six-field context)
```

| Proof item | Result |
|---|---|
| Hosted invocation | exactly one, HTTP 200, sanitized result `VERCEL_WEB_KMS_IDENTITY_DIAGNOSTIC_PASSED` (Node 22, context env `dev`, issuer mode Team) |
| CloudTrail AssumeRoleWithWebIdentity | 1 event, role web-encrypt, session `wrenkind-vercel-web`, no error (operator-observed) |
| CloudTrail GenerateDataKey | 1 event, caller the assumed web-encrypt session `wrenkind-vercel-web`, provider-credential key, no error (operator-observed) |
| Exact encryption context | PASS: app, purpose `provider-credential`, env `dev`, v `1`, synthetic workspace and credential |
| Long-lived AWS keys in Vercel | none |

Temporary proof mechanism, retired after the proof:

| Temporary element | State |
|---|---|
| Operator-invoked diagnostic route, its handler and the diagnostic service | REMOVED AFTER PROOF (cleanup commit) |
| Ephemeral operator secret | REMOVED FROM VERCEL PRODUCTION |
| Temporary Production deployment that served the proof | DELETED AFTER PROOF |
| Deployment Protection | RESTORED_TO_STANDARD_PROTECTION |

No remotely invokable KMS diagnostic exists in the repository any more; the hosted web reaches KMS only through the
connection flow's sealer.

Permanent architecture retained: the IAM OIDC provider for the Team issuer, the DUAL TRUST statement (operator-only
break-glass statement kept), the four Vercel Production KMS configuration variables, the hosted composition (no
local-only adapter in a hosted runtime) with the real KMS sealer, the exact six-field context, and the web role and
KMS key guards (GenerateDataKey only, provider-credential key only).

Rollback (should the trust ever need to be withdrawn): restore the captured pre-change trust document exactly, then
delete the OIDC provider.
