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

## Authoritative Meta discoverAssets read contract (Step 7G-E1)

Retrieved 2026-10-18 from Meta-owned documentation only. Pages marked (localized) were served in Spanish and are
paraphrased here, not quoted. Braces stand for runtime values; none is recorded here. `ProviderReadPort` fits
DIRECT: `discoverAssets` returns the complete `SocialAssetDto[]`, paginating internally. The platforms `facebook`
and `instagram`, `assetClass` and `relatedAssets` already exist. No contract change.

| Ref | Source |
|---|---|
| R1 | User accounts edge — `https://developers.facebook.com/docs/graph-api/reference/user/accounts/` |
| R2 | Instagram API with Facebook Login, get started — `https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/get-started` |
| R3 | Graph API overview (localized) — `https://developers.facebook.com/docs/graph-api/overview` |
| R4 | Field Expansion — `https://developers.facebook.com/docs/graph-api/guides/field-expansion` |
| R5 | Paginated results (localized) — `https://developers.facebook.com/docs/graph-api/results` |
| R6 | Page reference — `https://developers.facebook.com/docs/graph-api/reference/page/` |
| R7 | Instagram Platform Page reference — `https://developers.facebook.com/docs/instagram-api/reference/page/` |
| R8 | IG User reference — `https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user` |
| R9 | IG User Media reference — `https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media` |
| R10 | Access tokens — `https://developers.facebook.com/docs/facebook-login/guides/access-tokens` |
| R11 | Permissions reference — `https://developers.facebook.com/docs/permissions` |

**Discovery: three stages, only documented requests (strategy ME_ACCOUNTS_PLUS_PAGE_LOOKUPS).**

1. `GET https://graph.facebook.com/v25.0/me/accounts?fields=id,name`, paginated. R1: the Pages "the User has a role
   on", in a `data` / `paging` / `summary` shape. R2 uses `GET /me/accounts`. R11: `pages_show_list` "allows your
   app to access the list of Pages a person manages". R3: the `fields` parameter overrides a node's or an edge's
   default fields and returns only those specified. R6: `id` is "The ID representing a Facebook Page" and `name` is
   "The name of the Page".
2. For each distinct Page: `GET https://graph.facebook.com/v25.0/{page-id}?fields=instagram_business_account`. R7
   gives the response `{"instagram_business_account": {"id": …}, "id": …}`, with a Facebook User access token and
   `instagram_basic` and `pages_show_list`. R6 describes the field as an IG User: "Instagram account linked to page
   during Instagram business conversion flow".
3. For each distinct linked IG account: `GET https://graph.facebook.com/v25.0/{ig-user-id}?fields=id,username`. R8:
   "Represents an Instagram Business Account or an Instagram Creator Account". `username` is "Your app user's
   Instagram profile username". The request needs `instagram_basic` and `pages_read_engagement`.

Field expansion is documented generically (R4: "Certain resources … are unable to utilize field expansion"). The
exact `/me/accounts` + `instagram_business_account{…}` form is not established, so it stays out of the first slice:
IG_FIELD_EXPANSION_FROM_ME_ACCOUNTS = DEFERRED_7G_H.

**Page access tokens.**

- Not required for discovery. By default `/me/accounts` returns each Page's access token (R10: "… and the Page
  access token"; R2's sample response). The explicit `fields=id,name` selection excludes it (R3).
- The parser whitelists only the fields it maps. An `access_token` that arrives anyway is ignored at once. It is
  never wrapped as a credential, never mapped, persisted or logged, never in errors or `rawReference`, and only a
  synthetic placeholder in fixtures.

**Access-token transport: QUERY_PARAMETER, a deliberate documented-provider exception (TL decision).**

R3, R8 and R9 show `access_token={access-token}` as a query parameter on `graph.facebook.com` for these endpoints.
`Authorization: Bearer` was not established for them, so it is not used. Bearer may be tried later as a hardening
experiment in 7G-H; adopting it would be a separate reviewed change.

The exception covers the documented Meta Graph read transport only. It is not a precedent for query-string secrets
elsewhere. Mandatory containment in `graph-transport.ts`:

- the sensitive URL is built only there, and the caller never supplies a full URL or receives the built one;
- the URL is never logged, thrown, returned or serialized; `response.url` and raw fetch errors never propagate; the
  query string never reaches telemetry; the provider body never enters an error;
- `redirect: "manual"`, and any redirect fails closed; a finite timeout; a bounded response; exactly one request per
  transport invocation; no ambient cookies;
- never the App Secret, the Client Token or `appsecret_proof` ("Require App Secret" is OFF, so Integration holds no
  App Secret);
- the access token stays a SecretValue until the request is built.

**Pagination (R5, localized).**

- A page carries `paging.cursors.{before,after}` and full `previous` / `next` URLs of the form
  `…?limit=…&after={cursor}`.
- Stop when `next` is absent. A short page is not an end. Cursors are not stored.
- Contract:
  - continue only while `paging.next` exists AND `paging.cursors.after` is valid (non-empty, bounded, printable, never
    treated as a URL);
  - the next request is the fixed endpoint plus that cursor (NEXT_REQUEST = FIXED_ENDPOINT_PLUS_VALIDATED_CURSOR);
  - the returned `next` URL is never fetched (FOLLOW_PROVIDER_NEXT_URL_DIRECTLY = NO).
- `next` without a valid `after`, or a repeated cursor: fail closed.
- No `limit` is sent in the first slice.
- DISCOVER_ASSETS_MAX_PAGES = 20, a fixed constant and never configuration. A twentieth page that still has `next`
  fails closed (`limit_exceeded`). There is no silent truncation: PARTIAL_DISCOVERY_RESULT = NOT_SUPPORTED.

**Permissions (documented minimum; nothing added preemptively).**

| Stage | Permissions |
|---|---|
| Page discovery | `pages_show_list` |
| Linked IG account | `instagram_basic`, `pages_show_list` |
| IG user details | `instagram_basic`, `pages_read_engagement` |

- Not added: `pages_read_user_content`, `ads_management`, `ads_read`.
- R7's conditional ("If the token is from a User whose Page role was granted via the Business Manager, one of the
  following permissions is also required: ads_management, ads_read") remains a 7G-H concern. The controlled test
  asset should not depend on such a role.

**Errors.**

- `errors.ts` is reused (capability `discover_assets`). 7G-E2 adds only the documented `error_subcode` 492 (no role
  on the Page): it maps to `PermissionMissing(discover_assets)`.
- No code is invented for a missing Page task, Business Manager specifics or other per-Page behavior. Unknown
  behavior fails closed.
- Any failure while discovering a Page or an IG account fails the whole `discoverAssets`: no partial success.

**SocialAssetDto mapping.**

| Source | `ref` | `assetClass` | `displayName` | `rawReference` |
|---|---|---|---|---|
| Page | `providerObjectRef("facebook", "asset", page.id)` | `content_bearing` | `page.name` if valid, else the existing downstream fallback (the provider id) | `rawReference("meta", META_GRAPH_VERSION, "facebook:page:{id}")` |
| IG account | `providerObjectRef("instagram", "asset", ig.id)` | `content_bearing` | `ig.username` if valid, else the existing fallback | `rawReference("meta", META_GRAPH_VERSION, "instagram:account:{id}")` |

- `relatedAssets`: a Page references its linked IG asset. An IG asset references every Page through which it was
  observed.
- Pages are deduplicated by Page id and IG accounts by IG id: one IG account seen from several Pages is one asset.
- Relationship and output order are deterministic: by platform, then provider id.
- An id that fails the existing provider-id rule, or a malformed object, fails the whole discovery closed. No new
  enum values.

**Live uncertainties (7G-H; none is proven).**

1. Whether `Authorization: Bearer` works for these exact endpoints.
2. `/me/accounts` nested field expansion for `instagram_business_account`.
3. The Business Manager conditional `ads_read` / `ads_management` behavior.
4. The `pages_read_user_content` ambiguity between the general Page reference (R6) and the Instagram Page
   reference (R7).
5. The exact error for a Page-specific permission or task failure.
6. The provider's default page size.

## Implementation status (Step 7G-E)

| Item | State |
|---|---|
| Meta read adapter · `discoverAssets` | IMPLEMENTED_OFFLINE: `integrations/providers/meta/{read-port,graph-transport}.ts`; every other read operation refused (permanent) |
| Composition | the integration worker only (`composeJobProviders`, `jobs/connections.ts`); never the hosted web or MAIN; no Meta app configuration, no App Secret |
| Graph access-token transport | QUERY_PARAMETER_CONTAINED: the URL is built only in `graph-transport.ts`, never logged, thrown, returned or serialized |
| Requests | GET only; manual redirects refused; 10 s timeout; 64 KiB body bound; one request per operation; no internal retry |
| Pagination | `paging.cursors.after` on the fixed endpoint; `next` is never fetched; DISCOVER_ASSETS_MAX_PAGES = 20 (page 21 is never requested) |
| Results | PARTIAL_DISCOVERY_RESULT = NOT_SUPPORTED: any failure fails the whole discovery |
| Errors | the shared Graph mapping; reads add `error_subcode` 492 → PermissionMissing(discover_assets); network/timeout/5xx without a Graph error → Transient; unreadable or malformed → PermanentRejected(unknown) |
| Field expansion · Bearer hardening | DEFERRED_7G_H |
| Shared read contract suite | the applicable `discoverAssets` and shape assertions run on Meta; every other section is NOT_APPLICABLE (operations not implemented), not a pass |

## Live-acceptance prerequisite: tenancy onboarding (Step 7G-F3)

A product surface, not test scaffolding: it serves every new user, not only the Meta acceptance run.

| Item | State |
|---|---|
| TENANCY_ONBOARDING_SURFACE | IMPLEMENTED_OFFLINE: `/onboarding` (`app/onboarding/page.tsx`, `server/tenancy/{onboarding,actions,runtime}.ts`), linked from `/` for a signed-in user |
| TENANCY_CREATION | REAL_PRODUCT_COMMANDS through the action pipeline: ORGANIZATION_COMMAND `tenancy.organization.create`, WORKSPACE_COMMAND `tenancy.workspace.create` |
| State read | `tenancy.membership.list_own` (user scope, read only, no audit): the caller's own organization and workspace memberships; RLS limits the web role to the same rows |
| WORKSPACE_MODE | STANDARD_SERVER_FIXED |
| Identity | the server-validated session only; unverified users are refused by the pipeline |
| DIRECT_SQL_SEEDING | NOT_USED (no SQL, service-role or operator path) |
| PROVIDER_DEPENDENCY | NONE |
| REMOTE_DB_MUTATIONS_THIS_GATE | 0 |
| Multiples | domain behavior: two submissions create two objects; the page guides only the first organization and workspace |
| External auth configuration | unchanged: Supabase Site URL and redirect allowlist are verified in the live-run gates (F8/H1) |

## Live-acceptance prerequisite: Connect Meta surface (Step 7G-F4)

Permanent product code. The F4A contract, with the TL decisions D1–D4 and T1.

| Item | State |
|---|---|
| CONNECT_META_SURFACE | IMPLEMENTED_OFFLINE: `app/workspaces/[workspaceId]/settings/connections/page.tsx` (read only, `force-dynamic`), `server/connections/{settings,settings-runtime,actions}.ts`; linked from the onboarding ready state through `server/routes.ts` |
| CONNECT_META_ROUTE | `/workspaces/[workspaceId]/settings/connections` |
| Settings read | `connections.settings.view` (workspace scope, `connections.manage`: Owner/Admin per IA §18; read only, no stale recovery, no start, no audit); its "Connect Meta available" hint is UX only |
| Connect action | `startMetaConnectionAction` (`"use server"`): reads only `workspaceId` (parsed, then resolved live); provider fixed to `meta`; identity from the session; `connections.manage` through the pipeline; fixed internal redirects from the parsed id; invalid id → `/onboarding` |
| FRESH_META_CONNECTION_POLICY | AT_MOST_ONE_NON_REMOVED_PER_WORKSPACE_TEMPORARY_PRODUCT_POLICY (`SINGLE_CONNECTION_PROVIDERS = ["meta"]`); CONNECTING, ACTIVE, DEGRADED, FAILED and DISCONNECTED block a fresh connect; REMOVED doesn't; simulator and TikTok multiplicity unchanged |
| GLOBAL_WORKSPACE_PROVIDER_UNIQUENESS | NOT_ENFORCED (no schema rule; a future identity-keyed model stays open) |
| META_FRESH_CONNECTION_SERIALIZATION | POSTGRES_TRANSACTION_ADVISORY_LOCK: `pg_advisory_xact_lock(hashtextextended('connections.fresh_connection:' \|\| workspace \|\| ':' \|\| provider, 0))`, only in `modules/connections/persistence/store.ts`, taken before the re-checks at fresh start and at fresh completion; never held across a provider, network or KMS call |
| META_FRESH_LOCK_TIMEOUT | 5_SECONDS_TRANSACTION_LOCAL (code constant `FRESH_CONNECTION_LOCK_TIMEOUT_MS`, not configuration) |
| LOCK_TIMEOUT_SCOPE | ADVISORY_LOCK_ACQUISITION_ONLY: the previous `lock_timeout` is read and restored, transaction-locally, once K is held |
| LOCK_TIMEOUT_SQLSTATE | 55P03_INTERNAL_ONLY: surfaced only as CONFLICT; the aborted transaction issues no further statement |
| LOCK_TIMEOUT_START_OUTCOME | UNAVAILABLE (no attempt, no authorization request, no URL) |
| LOCK_TIMEOUT_COMPLETION_OUTCOME | CREDENTIAL_NOT_STORED_RESTART_REQUIRED (the existing failure path, in a new transaction) |
| LIVE_ATTEMPT_POLICY | PER_CREATOR: the caller's own fresh Meta attempt, PENDING before `expires_at` or EXCHANGING for less than `EXCHANGE_STALE_AFTER_MS`, after the caller's stale recovery; attempt RLS unchanged |
| CONCURRENT_SECOND_START | AUTHORIZATION_IN_PROGRESS (no second attempt, no URL, no state reuse, nothing cancelled) |
| FRESH_COMPLETION_DUPLICATE_GUARD | ENABLED_META_ONLY: a losing completion closes its attempt EXCHANGE_FAILED / CONNECTION_UNAVAILABLE; no Connection, credential, pointer, event, audit or `discover_assets` row |
| Known temporary-policy cost | in a two-admin race the loser's code was already exchanged and its token sealed (one GenerateDataKey) before the guard refuses; the envelope is never stored, the plaintext follows the existing zeroing, nothing secret is surfaced |
| AUTHORIZATION_REDIRECT_VALIDATION | HTTPS_EXACT_META_ORIGIN_AND_DIALOG_PATH: https, no userinfo, no fragment, origin + path exactly `META_DIALOG_URL` (composed in `server/connections/runtime.ts`); the query is never interpreted; otherwise `authorization_start_failed`, no redirect |
| DB_MIGRATION | NO |
| RECONNECT_SURFACE | NOT_IMPLEMENTED (the domain path is unchanged) |
| REMOVE_SURFACE | NOT_IMPLEMENTED |
| F4C_REMOVE_SURFACE_REQUIRED_BEFORE_LIVE | YES: a FAILED or DISCONNECTED Meta connection blocks a fresh connect with no recovery surface until F4-C |
| ROLE_LEVEL_IDLE_TRANSACTION_HARDENING | DEFERRED_BEFORE_CUSTOMER_EXPOSURE (separate operational gate; not a blocker for the controlled DEV live acceptance) |
