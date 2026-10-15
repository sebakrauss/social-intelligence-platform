# Step 7E.10-B — hosted web AWS identity: Vercel OIDC trust (DEV / non-prod)

Reviewed **target design** for the hosted web's AWS identity (source: `server/connections/vercel-aws-identity.ts`,
`server/connections/web-identity.ts`; TA §39, ADR-64). It is the separate web-trust artifact that
`../aws-authorization/live-recapture-checklist.md` refers to.

- **Nothing here has been applied to AWS or Vercel.** These files are templates, not evidence of current state.
- **No artifact in this directory is a secret.** The only placeholders are `<DEV_AWS_PARTITION>` and
  `<DEV_AWS_ACCOUNT_ID>` (vocabulary of `../aws-authorization/README.md`). The Vercel issuer, team, project and
  environment are non-secret and fixed here.
- No script, npm task or infrastructure-as-code here applies anything. A later operator gate applies it, after a
  fresh read-only capture of the web role's current trust document.

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
Which issuer the exchanged token carries is confirmed only by the live proof.

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

## Vercel Production configuration (target)

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

## Live proof (later gate)

Through the guarded hosted web KMS identity diagnostic (`server/connections/web-kms-diagnostic.ts`). Its invocation
was **BLOCKED_PENDING_SAFE_ROUTE_PROTECTION** until Step 7E.10-C0, and is now **TEMP_PROTECTED_ROUTE_READY** through the
temporary operator route below. The proof is accepted only with:

- exactly one AssumeRoleWithWebIdentity from the new provider, with the exact Production subject and session
  `wrenkind-vercel-web`, into the web role, without error;
- exactly one GenerateDataKey by that session, on the provider-credential key, with the synthetic six-field context
  (`env` dev, workspace `5eed0000-d1a9-4000-8000-00000000e001`, credential `5eed0000-d1a9-4000-8000-00000000e002`);
- no IAM user access key in either event.

Rollback: restore the captured trust document exactly, then delete the OIDC provider.

## Temporary invocation lifecycle (Step 7E.10-C0)

The diagnostic is invoked through ONE temporary route, `POST /api/internal/kms-web-diagnostic`
(`app/api/internal/kms-web-diagnostic/route.ts` → `server/connections/web-kms-diagnostic-route.ts`), protected by an
EPHEMERAL operator key plus the diagnostic acknowledgement.

**The temporary secret is not part of the product authentication model.** It is not an AWS credential, not a customer
credential and not a permanent operator credential; no platform-admin role exists or is created for it. The route
and the key exist only for the one live proof.

| Contract | Value |
|---|---|
| Method | `POST` only (no other method is exported; GET never invokes anything) |
| Runtime | `NODE_ENV` = `production` and `VERCEL_ENV` = `production` (the diagnostic re-checks both) |
| Key variable | `WEB_KMS_DIAGNOSTIC_OPERATOR_KEY`, Vercel **Production** scope only; at least 32 random bytes as 64+ hex or 43+ base64url characters; absent, empty or weak → the route is inert |
| Key header | `x-wrenkind-diagnostic-key`, exactly the configured value, compared in constant time. Never a query string, URL or body (any query string is refused) |
| Body | exactly `{"acknowledge":"VERCEL_WEB_KMS_IDENTITY_DIAGNOSTIC_V1"}`, at most 1 KiB, no other field |
| Refusals | every pre-diagnostic refusal is the same generic `404 {"result":"NOT_FOUND"}` |
| Result | `200` with the sanitized outcome, or `500` with `{"result":"VERCEL_WEB_KMS_IDENTITY_DIAGNOSTIC_FAILED","failure":<closed code>}` |
| OIDC token | never accepted from the caller: the diagnostic uses only the platform's request token |

**One-shot is operational, not technical.** A serverless runtime can't guarantee a single execution with in-memory
state, and no database table is added for it. "Exactly once" is enforced by the procedure: one manual request without
retry, CloudTrail correlation, then deleting the key and removing the route.

Lifecycle:

1. Generate the high-entropy operator key locally (at least 32 random bytes); it never passes through chat or a file in
   the repository.
2. Provision `WEB_KMS_DIAGNOSTIC_OPERATOR_KEY` to Vercel **Production** only, marked sensitive. It is never
   provisioned to any Trigger.dev project or worker environment (MAIN or Integration), nor to Vercel Preview or
   Development; the Trigger plane guards are deliberately left unchanged, so this rule is operational.
3. Configure AWS: the OIDC provider and the DUAL TRUST statement (this directory's artifacts).
4. Configure the permanent Vercel Production KMS metadata variables (table above).
5. Deploy the exact reviewed diagnostic commit to Production.
6. Make ONE `POST` with the `x-wrenkind-diagnostic-key` header and the exact acknowledgement body, without retry
   (for example `curl --retry 0`).
7. Verify the response (the sanitized outcome) and CloudTrail (the live-proof criteria above).
8. Delete `WEB_KMS_DIAGNOSTIC_OPERATOR_KEY` from Vercel immediately, whatever the result.
9. Remove the temporary route, its handler and their tests in a cleanup commit.
10. Keep the permanent OIDC identity and the KMS metadata variables only if the proof passed; otherwise roll back the
    trust (above) and remove them.
