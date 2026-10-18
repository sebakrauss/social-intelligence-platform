# Step 7G — first real provider: Meta (DEV / non-prod)

Reviewed design record for the first real provider (decisions D1–D14 of Step 7G; TA §15, §39). It records
classifications and ownership only. **No artifact here is a secret or a provider identifier**: the Meta App ID, the
login configuration ID, the App Secret and any token live only where the operator enters them, never in this
repository, chat or evidence.

## Decisions in force

| Item | Value |
|---|---|
| First provider | META (`AUTHORIZABLE_PROVIDERS` = simulator, meta; TikTok known but not authorizable) |
| First capability | `ProviderReadPort.discoverAssets` |
| Login | Facebook Login for Business (`config_id`, not `scope`) |
| Token type | User Access Token |
| PKCE | NOT_SUPPORTED in the first slice (confidential client; single-use state with TTL). No OIDC flow |
| Long-lived token exchange | DEFERRED: the first slice stores the authorization-code token with its provider expiry |
| Refresh | REAUTHORIZATION in the first slice (no refresh token, no worker sealer) |
| Require App Secret | OFF: no `appsecret_proof` on reads |
| Client Token | NOT USED: outside the architecture, no variable exists for it |
| Credential codec | ProviderCredential v1, unchanged |
| Persistence | no schema change (the provider CHECK already admits `meta`) |
| Callback | `${APP_BASE_URL origin}/api/oauth/meta/callback`, persisted per attempt; no redirect-URI variable |

## Configuration contract (hosted web only)

Owner: `server/connections/meta-app-config.ts`, read only where the Meta authorization adapter is composed
(`server/connections/runtime.ts`, Step 7G-D), never at boot.

| Variable | Class | Hosted web | Integration plane | MAIN plane |
|---|---|---|---|---|
| `PROVIDER_META_CLIENT_ID` | NON_SECRET | yes | refused | refused |
| `PROVIDER_META_CONFIG_ID` | NON_SECRET | yes | refused | refused |
| `PROVIDER_META_CLIENT_SECRET` | SECRET | yes (code exchange only) | refused | refused |

- All three or none. None set: Meta is unavailable and the flow fails closed (never a simulator stand-in). Some set:
  refused as incomplete. Values are validated as opaque printable tokens only; errors name variables, never values.
- The App Secret is a `SecretValue` from parsing onwards. In Vercel it is a Production-scoped, Sensitive variable
  entered by the operator in the dashboard; it never passes through chat, a terminal, `.env*` files or evidence.
- Both jobs planes refuse the three names in deployed runs (`jobs/plane-environment.ts`), and dependency-cruiser keeps
  the configuration module out of every module but the web's connection runtime.

## State after Step 7G-C

Meta is authorizable in the domain, but no Meta authorization adapter, read adapter or HTTP transport exists: Meta
authorization fails closed everywhere, and the repository has no Meta remote-call capability.

## Authoritative FLfB authorization contract (Step 7G-D1)

Retrieved 2026-10-17 from Meta-owned documentation only (the Meta pages carry no visible revision date; the
Graph changelog dates its versions). Placeholders in braces stand for runtime values; none is recorded here.

| Ref | Source |
|---|---|
| S1 | Facebook Login for Business — `https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business` (same content at `/docs/facebook-login/facebook-login-for-business`) |
| S2 | Manually Build a Login Flow — `https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow` (S1 links its `#logindialog` and `#exchangecode` sections) |
| S3 | Graph API versioning — `https://developers.facebook.com/docs/graph-api/guides/versioning` |
| S4 | Graph API changelog — `https://developers.facebook.com/docs/graph-api/changelog` |

**G1 — authorization-code grant with a User Access Token configuration: SUPPORTED, with `response_type=code` and
`override_default_response_type=true`.**

- S1, access-token comparison, user access tokens: "Implicit grant by default, and can support authorization code
  grant".
- S1 defines the override: "When true, any response types passed in the `response_type` will take precedence over
  the default types". The system-user section, the only one with an example, sets `response_type` to `code` and says
  "`override_default_response_type` must be set to `true`".
- Conclusion: a configuration's default governs unless the override is true, and a user-token configuration defaults
  to implicit. So a server-side code flow sends both parameters. This is derived from the documented semantics; S1
  shows no user-token example. First live confirmation: 7G-H.

**G2 — the dialog is the Facebook Login manual-flow dialog plus `config_id`.**

- S1: "When invoking the login dialog and setting the redirect URL, include your configuration ID as an optional
  parameter (although scope can still be included, we recommend that you do not use it)". The link targets
  S2 `#logindialog`.
- S2: `https://www.facebook.com/v25.0/dialog/oauth?client_id={app-id}&redirect_uri={redirect-uri}&state={state-param}`.
  `state` is "used for preventing Cross-site Request Forgery". The `code` response type: "Response data is included
  as URL parameters and contains code parameter".
- Origin `https://www.facebook.com`, path `/{version}/dialog/oauth`. S3: the dialog is versioned like Graph calls,
  and a call without a version uses the one set in the app dashboard (the fetched page was localized; paraphrased).
- First-slice parameter set: `client_id`, `config_id`, `redirect_uri`, `state`, `response_type=code`,
  `override_default_response_type=true`.
- Never sent: `scope`, PKCE parameters, `client_secret`, the Client Token.

**G3 — token exchange is the manual-flow exchange; `redirect_uri` REQUIRED, exact match.**

- S1, after the code redirect: "See Exchanging Code for an Access Token for more information about this step",
  linking to S2 `#exchangecode`. S1's own example (system-user section, invoked through the JS SDK) omits
  `redirect_uri`; it does not govern the redirect-based manual flow.
- S2: `GET https://graph.facebook.com/v25.0/oauth/access_token?client_id={app-id}&redirect_uri={redirect-uri}&client_secret={app-secret}&code={code-parameter}`.
  `redirect_uri`: "This argument is required and must be the same as the original request_uri that you used when
  starting the OAuth login process".
- Response (S2): `{"access_token": …, "token_type": …, "expires_in": …}`. S1 calls a user access token "short-lived".
  No refresh token, user id or scope is documented in the response.

**Callback.**

- Success (`response_type=code`): query parameters `code` and `state`.
- Cancellation (S2): `?error_reason=user_denied&error=access_denied&error_description=…`. S2's example carries no
  `state`; whether `state` accompanies an error is unstated. Policy: a denial without a bindable state is MALFORMED
  (fail closed). `error_description` is never interpreted.

**Version.**

- REQUIRED_VERSION: none documented. Any available version works. An unversioned call depends on the app dashboard
  setting, and S3 recommends always specifying the version.
- EXAMPLE_VERSION: `v25.0` in every S1/S2 example.
- S4: v25.0 was introduced on 2026-02-18 and is available until 2028-07-29. v26.0 (2026-07-29) is the latest.
- First-slice policy: pin `v25.0` explicitly, one constant for the dialog, the token exchange and the 7G-E Graph
  reads. A version upgrade is a deliberate, reviewed change.

**Remaining uncertainties (live-only, 7G-H).**

- That a user-token configuration returns a `code` with the override.
- Whether Meta echoes `state` on a denial.
- The exact `expires_in` of the short-lived user token.

## Implementation status (Step 7G-D)

| Item | State |
|---|---|
| Meta authorization adapter | IMPLEMENTED_OFFLINE: `integrations/providers/meta/{authorization,oauth-transport,errors,endpoints}.ts` |
| Graph version | `META_GRAPH_VERSION = "v25.0"`, declared once (`endpoints.ts`) |
| PKCE | NOT_SUPPORTED (`pkce: "not_supported"`) |
| Token exchange | one GET per call; no retry (TOKEN_EXCHANGE_RETRY = NONE); manual redirects refused; 10 s timeout; 64 KiB body bound |
| Ambiguous exchange (no response, timeout, redirect, unreadable or unexpected body) | OutcomeUnknown: the code is treated as spent |
| Credential | ProviderCredential v1: `randomUUID()` id, access token as SecretValue, `grantedScopes: []` |
| Expiry | `expires_in` REQUIRED on success (positive whole seconds, at most ten years): missing or invalid → OutcomeUnknown, no credential, no default lifetime; a successful Meta exchange never yields `expiresAt = null` |
| Long-lived token exchange · refresh | NOT_IMPLEMENTED |
| Client Token | NOT_USED |
| Composition | `server/connections/runtime.ts` only: no Meta variables → no Meta port; partial → MetaAppConfigError (names only); all three → adapter |
| Read adapter (`discoverAssets`) | PENDING_7G_E |
| Shared authorization contract suite | SHARED_REAL_PROVIDER_CONTRACT_SUITE = PENDING_7G_H (deferral approved; NOT a pass): several assertions (cancel vs deny, unknown/expired/reused code, redirect mismatch) depend on Meta behavior the documentation does not state; they run against controlled real-provider evidence or recorded, sanitized exchanges |
