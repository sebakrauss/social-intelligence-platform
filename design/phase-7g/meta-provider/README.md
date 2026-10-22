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
| REMOVE_SURFACE | IMPLEMENTED_OFFLINE in Step 7G-F4C (see below) |
| F4C_REMOVE_SURFACE_REQUIRED_BEFORE_LIVE | YES: satisfied by Step 7G-F4C (a FAILED or DISCONNECTED Meta connection is recovered by Remove, then a fresh connect) |
| ROLE_LEVEL_IDLE_TRANSACTION_HARDENING | DEFERRED_BEFORE_CUSTOMER_EXPOSURE (separate operational gate; not a blocker for the controlled DEV live acceptance) |

## Live-acceptance prerequisite: Remove Meta, terminal (Step 7G-F4C)

The F4C0 contract, with the TL decisions D1–D7.

| Item | State |
|---|---|
| REMOVE_META_SURFACE | IMPLEMENTED_OFFLINE: an inline Remove form per Meta connection that isn't REMOVED on Settings › Connections; `removeMetaConnectionAction` (`"use server"`) reads only `workspaceId`, `connectionId` and the visible acknowledgement |
| REMOVE_ROUTE | WORKSPACE_SETTINGS_CONNECTIONS_INLINE_ACTION (no confirmation route) |
| Command | the existing `connections.connection.remove` (`connectionRemoveCommand`), `connections.manage`; the surface fixes `expectedProvider: "meta"`, so another provider's id is `connection_not_found`; generic callers unchanged |
| Acknowledgement | UX intent only: the exact form value, else `remove_not_confirmed` and no command; security is the POST Server Action, Next's Origin check, the verified session, `connections.manage` and RLS |
| REMOVE_META_SERIALIZATION | SAME_K_WORKSPACE_META: `get` (provider) → K → FOR UPDATE re-read → REMOVED? `changed:false` → REMOVED + pointer cleared + credential row deleted (crypto-shred) + accounts INACTIVE (REMOVED) + open fresh attempts closed + REMOVED_BY_USER event + `connection.removed` audit, one transaction |
| REMOVE_META_LOCK_TIMEOUT | 5_SECONDS_TRANSACTION_LOCAL (the F4-B primitive); past it → `unavailable`, nothing changed |
| REMOVE_INVALIDATES_OPEN_FRESH_META_ATTEMPTS | YES: every open fresh Meta attempt of the workspace, any creator: PENDING → CANCELLED, EXCHANGING → EXCHANGE_FAILED / CONNECTION_UNAVAILABLE; reconnect, other-provider and terminal attempts untouched |
| CROSS_CREATOR_ATTEMPT_INVALIDATION | WRITE_ONLY_SECURITY_DEFINER: `connections.invalidate_open_fresh_meta_attempts(timestamptz)` (0012), returns void, sealed workspace only, live Owner/Admin web callers only, EXECUTE for `authenticated` only |
| ATTEMPT_READ_RLS | CREATOR_ONLY_UNCHANGED (the two new policies are for `app_owner`, i.e. the definer, bound workspace) |
| Fresh completion | re-reads its attempt AFTER K: one closed by a removal is refused (`connection_unavailable`), nothing persisted |
| REMOVED_TERMINAL_CONNECTION | YES: no writer moves a REMOVED Connection (discovery and reconnect refuse it; removal is idempotent) |
| REMOVED_TERMINAL_ACCOUNT_ACTIVATION | GUARDED: link and Move activation read the Connection FOR SHARE, so ACTIVE-account-under-REMOVED-Connection can't commit |
| META_REMOTE_REVOCATION | NOT_IMPLEMENTED (no Meta call; deferred) |
| REMOVE_MEANS | WRENKIND_FORGETS_LOCAL_CONNECTION: Wrenkind deletes its stored credential and deactivates the accounts; discovery history stays; the authorization inside Meta is NOT revoked (the UI says so) |
| DISCOVERY_IN_FLIGHT_AFTER_REMOVE | SAFE_BUT_MAY_WASTE_PROVIDER_WORK: a run that already loaded the envelope may still Decrypt and call Meta; its write is refused; later runs skip before Decrypt |
| LIVE_CLEANUP_ORDER | WAIT_FOR_DISCOVERY_TERMINAL_THEN_REMOVE (so Decrypt / provider-call evidence counts stay exact) |
| CAPABILITY_PROFILE_FINAL_RECHECK | DEFERRED_HARDENING (a late profile for an already inactive account is derived metadata, not resurrection) |
| RECONNECT_SURFACE | NOT_IMPLEMENTED (a reconnect after removal stays refused) |

## First controlled live acceptance (Steps 7G-H3/H4)

DEV, 2026-10-19: one operator, one synthetic workspace, the real Meta app, the hosted web and both Trigger planes on the same reviewed build. Evidence came from read-only database inspection (counts, states and hash-correlation labels only), the Trigger run records and AWS CloudTrail (operator-confirmed). No identifier, token or key appears in this record.

| Item | Result |
|---|---|
| OAuth callback | SUCCEEDED: one fresh Meta attempt COMPLETED |
| Connection | exactly ONE, ACTIVE, with its active-credential pointer set |
| Credential | exactly ONE sealed credential, the one the pointer names |
| KMS GenerateDataKey | exactly ONE, succeeded (the web sealing the token) |
| KMS Decrypt | exactly ONE, succeeded, by the integration worker |
| `connections.discover_assets` | ONE attempt: one outbox row on the integration plane, one dispatch, one domain effect claimed, its assets written |
| Discovered assets | exactly ONE Facebook Page and ONE Instagram professional account; no duplicates |
| Encryption-context correlation | MATCHED: the workspace, connection and credential the KMS calls named are the persisted ones |
| Page access token | NOT persisted (no token-like value in any table, payload or display name) |
| Connected accounts | 0: discovery activates nothing |
| Temporary acceptance credentials | REMOVED afterwards (operator-confirmed) |

## Managed accounts (Step 7G-H5)

Which discovered accounts a workspace manages is an explicit Wrenkind decision, saved as a whole; discovery and authorization alone manage nothing.

| Item | State |
|---|---|
| MANAGED_ACCOUNTS_SURFACE | IMPLEMENTED_OFFLINE: a "Managed accounts" section per ACTIVE Meta connection on Settings › Connections, "N of M selected" apart from the provider connection's status; `saveManagedAccountsAction` (`"use server"`) reads only `workspaceId`, `connectionId` and the checked `discoveredAssetId` values |
| Command | `connections.account.save_selection` (`connectedAccountSelectionCommand`), `connections.manage`, provider fixed to `meta`, at most 1000 ids; configuration, not a platform mutation (Monitor-only allowed) |
| Supported assets | content-bearing Facebook Pages and Instagram professional accounts already persisted by discovery; ad accounts and other platforms are refused |
| SELECTION_SEMANTICS | DESIRED_SET_ONE_TRANSACTION: Connection re-read FOR UPDATE → must be ACTIVE → every id must be a manageable asset of that connection → unlink what isn't wanted, link what is; any refusal saves nothing |
| CONNECTED_ACCOUNT_IDENTITY | UNCHANGED_0007: one row per (connection, platform, provider asset); reactivation reuses the INACTIVE row; M-01 enforced by the database's unique index |
| DESELECTION | ACTIVE → INACTIVE (UNLINKED); never a delete; history kept |
| CONCURRENCY | saves of one connection serialize on its row lock; the LAST COMMITTED save decides the set; no duplicates |
| REMOVE_COMPATIBILITY | Remove takes the same row lock after K: a stale save after Remove is `connection_not_ready`; a save in flight is deactivated by the Remove that follows it |
| Audit | one `connected_account.linked` / `connected_account.unlinked` per changed account (user, workspace); none for a no-op |
| PROVIDER_KMS_JOB_SIDE_EFFECTS | NONE: no Meta, KMS, STS or Trigger call. Step 7G-H5.5 adds exactly one `capability.evaluate_account` outbox row per activation transition (see below) |
| DB_MIGRATION | NO |

## Managed-account capability lifecycle (Step 7G-H5.5)

DISCOVERED ASSET → explicit activation → Connected Account ACTIVE → evaluation requested → profile current → downstream
operations proceed only as `capabilityAvailability` allows. The profile is derived, recomputable state; it never decides
activation. An account may be ACTIVE while its evaluation is pending, and that fails closed.

| Item | State |
|---|---|
| EVALUATION_REQUEST | ONE provider-neutral primitive, `capabilityEvaluationRequest` (`modules/connections/application/capability-request.ts`), used by link, save_selection, the Move activation and reconciliation |
| ACTIVATION_ENQUEUE | one `capability.evaluate_account` outbox row per activation transition (new or reactivated account), in the activation's own transaction; subject `connected_account_id` only; web initiator = the user |
| DISPATCH_KEY | `capability.evaluate_account:{account}:{LINKED or MOVED_IN event id}`; `…:initial` for an ACTIVE account without a recorded activation; `…:{catalog}.r{revision}` for a stale profile |
| UNCHANGED_SAVE / RETAINED / DESELECTED | no request |
| RECONCILIATION | `requestCapabilityReevaluations` (worker scope, one workspace, ≤ 200 accounts per call, resumable by `next`): ACTIVE account under an ACTIVE connection with no profile, or a profile on another catalog or an older revision → one request; the missing-profile key is the latest activation's, so an activation's pending request is found (`already_requested`), never duplicated. Duplicate dispatch keys are absorbed by `appendOutboxOnce` (savepoint). NOT scheduled: no task or deploy yet |
| NOT_RECONCILED | INACTIVE accounts; accounts under a non-ACTIVE connection; a profile on a NEWER revision than the running code |
| AVAILABILITY_ORDER | account not ACTIVE → `ACCOUNT_INACTIVE`; no profile → `PROFILE_NOT_EVALUATED`; profile not on the provider's catalog at exactly its revision → `PROFILE_STALE`; then the stored row with connection health (`REMOVED` → `CONNECTION_REMOVED`). One capability per answer |
| DEACTIVATION / REMOVE | the profile is kept as history and is never authority: availability refuses it (`ACCOUNT_INACTIVE`) |
| FAILURE_SEMANTICS | unchanged (Step 5E): a definite provider refusal or an unreadable credential → "facts unavailable" → UNKNOWN, never SUPPORTED; transient, rate-limited or ambiguous → retried by the task, profile untouched; nothing deactivates the account or touches the credential |
| CATALOG_REVISION | both catalogs → revision 2 (the vocabulary gained `read_content`): every revision-1 profile is stale |
| READ_CONTENT | DEDICATED_CAPABILITY: top-level content is its own provider operation (`listContent` / `getContent`) and permission (`read_content` already exists in the provider contract's normalized names), distinct from `read_interactions` |
| DB_MIGRATION | `0013_capability_read_content.sql`: the verified widening of `capability.profile_entries_capability_check`; nothing else |

**Meta describeAccount contract (H55).**

| Ref | Source |
|---|---|
| R6, R8 | as in E1 (Page reference; IG User reference) |
| R12 | User permissions edge — `https://developers.facebook.com/docs/graph-api/reference/user/permissions/` (retrieved 2026-10-19: `GET /{user-id}/permissions`; `data` is a list of Permission nodes `{permission: string, status: enum{granted, declined, expired}}`; the edge is paginated; the token type for reading is not stated) |

1. The asset, its echoed id checked: Facebook Page `GET /v25.0/{page-id}?fields=id,name` (R6: `id`, `name`); Instagram
   professional account `GET /v25.0/{ig-user-id}?fields=id,username` (E1's documented read, R8).
2. `GET /v25.0/me/permissions?fields=permission,status` (R12). Only `granted` names count. One page only: a response that
   reports a next page, an unknown status, a non-identifier name or more than 256 entries is unreadable (fail closed,
   never a truncated grant set).

Facts: `content_bearing`; the account identity is the asset itself; no linked ad accounts (no ads permission is
requested, so none is claimed); `describedAt` is the local clock. Another platform is refused before any request; any
failure fails the whole description. Same transport containment as E1. No scope is added.

Live uncertainties (to be proven in a live capability gate): whether the Page node read needs more than
`pages_show_list`; whether `me/permissions` under Facebook Login for Business lists the configuration's permissions;
whether it is ever paginated for one app grant. Observed in P3 (2026-10-22, one grant): the Page and Instagram account
reads succeeded with the configuration's grants, and `me/permissions` listed them in one unpaginated page.

| Item | State |
|---|---|
| META_DESCRIBE_ACCOUNT | VALIDATED_LIVE (Step 7G-H5.5-P3: Facebook Page and Instagram professional account; account description only, no capability) |
| CAPABILITY_CATALOG_META | BLOCKED_ON_API_VALIDATION_EVIDENCE: the platform catalog holds NO entry. Every Meta capability, `read_content` and `read_interactions` included, evaluates UNKNOWN_NOT_VALIDATED until a live API-validation gate records `api-validation:` evidence for an exact (platform, asset class, capability, scope, required permissions) entry |
| LIVE_EVALUATION_BLOCKER | RESOLVED for account description (Roles Anywhere workload identity, Step 7G-H5.6; first live evaluations, P3). Capability validation remains blocked: see Capability catalog contract (Step 7G-H5.5-P4-B) |

**First live capability evaluations (Steps 7G-H5.5-P3-B / P3-C, 2026-10-22).** One Facebook Page and one Instagram
professional account were each activated once through Save managed accounts. Each produced exactly one evaluation,
delivered by the outbox to the integration plane:
- AWS: one Roles Anywhere session for the worker role and one KMS Decrypt under the exact six-field context.
- Meta: two read-only Graph GETs, the asset itself (id echoed and matched) and `me/permissions`.
- Facts: available, account identity known, five granted permissions, no linked ad accounts.
- Profile: platform catalog r2, revision 1, ten rows per account, all `UNKNOWN_NOT_VALIDATED` / `CATALOG_NOT_VALIDATED`.

The connection and credential were unchanged. P3 validated **account description only**: identity and granted-permission
retrieval through the real credential path (`describeAccount`, i.e. `read_account`). It did **NOT** validate any of the
ten product capabilities, and no mutation capability was tested. The catalog stayed empty.

## Capability catalog contract (Step 7G-H5.5-P4-B)

**The question.** The capability system answers: "Can Wrenkind perform X now for this connected account?" Four
dimensions stay distinct:

| # | Dimension | Where it lives |
|---|---|---|
| 1 | the provider/account supports the operation | a validated catalog entry (evidence record) |
| 2 | Wrenkind is authorized for it (granted permissions) | account facts (`describeAccount`) and observations |
| 3 | Wrenkind implements the operation | `IMPLEMENTED_PLATFORM_OPERATIONS` (explicit, evidence-backed; empty today) |
| 4 | the product exposes/enables it | role, workspace mode, availability resolver (TA §16.6) and future UI/action gates |

A capability-profile `SUPPORTED` requires dimensions 1–3 proven. Dimension 4 is a product/exposure concern: it is never
inferred from provider support, and future UI/action availability may impose an additional product gate.

**Authorization semantics — OPEN (`AUTHORIZATION_SEMANTICS_OPEN_BEFORE_FIRST_VALIDATED_ENTRY`).**
`ACCOUNT_PERMISSION_MISSING` is an authorization condition, not proof of intrinsic provider/platform non-support. The
evaluator's stored `UNSUPPORTED / ACCOUNT_PERMISSION_MISSING` (and `OBSERVED_PERMISSION_MISSING`) is historical/technical
behavior. It MUST be interpreted together with its reason code, and the availability overlay presents it as
`ACCOUNT_PERMISSION_MISSING` + `REAUTHORIZE`, never as "the platform doesn't offer it" (`CAPABILITY_UNSUPPORTED` /
`OPEN_ON_PLATFORM`). The approved documents define Unsupported as platform non-support (TA §16.2, Model §6.2). P4-B does
not reconcile this: no new state, reason code, migration or evaluator change.
`FIRST_VALIDATED_PLATFORM_ENTRY_BLOCKED_UNTIL_AUTHORIZATION_SEMANTICS_RESOLVED = YES`.

**Entry contract.** `modules/capability/domain/catalog-contract.ts` (development/test-time only) and the evidence schema
`api-validation/README.md`:
- **Positive entries** (SUPPORTED, AVAILABLE_WITH_LIMITATION) need all of: an accepted positive `api-validation:` record
  of the exact scope; a non-empty, explicitly named `requiredPermissions` equal to the record's; and registered
  implementation evidence.
- **UNSUPPORTED entries** need an accepted authoritative-negative record and name no permission.
- **Never from absence.** A missing or unrequested permission, an unimplemented operation, unavailable facts, a failed
  read or a missing rule never yield UNSUPPORTED: those stay UNKNOWN.
- **No inferred mappings.** No capability-to-operation mapping is inferred from names, and `describeAccount` is never
  evidence.
- **Nothing passes today.** No capability passes, so `platform.entries` is `[]`.

**Catalog version and re-evaluation.**
- **P4-B:** `platform` stays revision 2 (`platform-catalog-r2`) and the LIVE profiles stay current and untouched.
- **First validated entry:** requires a deliberate catalog version/revision decision. When the catalog revision in code
  changes, every existing profile becomes `PROFILE_STALE`.
- **Re-evaluation path:** the supported path is an Owner/Admin's manual Re-check. No automatic reconcile is enabled.
- **Deployment order for a future catalog change:**
  1. the canonical paired Trigger release (`npm run trigger:release`, INTEGRATION then MAIN);
  2. verify both workers;
  3. web deploy;
  4. manual Re-check of the target account(s).

| Item | State |
|---|---|
| PLATFORM_CATALOG | `platform` r2, entries `[]` (frozen, guard-tested) |
| CATALOG_ENTRY_CONTRACT | G1 non-empty named permissions; G2 registered implementation evidence (none registered → every positive entry refused); UNSUPPORTED only from authoritative negative evidence; G3 LIVE-shaped facts → 0 SUPPORTED, 0 UNSUPPORTED, 10 UNKNOWN per account |
| FIRST_VALIDATED_PLATFORM_ENTRY | BLOCKED until the authorization semantics are resolved |
| REEVALUATION | manual Re-check only; no automatic reconcile |

**H6 readiness contract.** H6 may ingest for a Connected Account only when, at the moment of ingestion:
the account is ACTIVE; its connection is ACTIVE with a valid credential pointer; and `capabilityAvailability` answers
AVAILABLE (or AVAILABLE_WITH_LIMITATION, honoring the limitation) for EXACTLY the capability of that operation —
`read_content` for top-level content, `read_interactions` for comments and replies, `read_history` for backfill depth.
H6 consumes the resolver; it never infers a capability from the Meta authorization, the granted permissions, the
discovery result or the data it sees. Today that means: the simulator for development; real Meta only after the
live capability-validation gate.
