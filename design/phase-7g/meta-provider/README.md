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
| Long-lived token exchange | DEFERRED: the first slice stores the authorization-code token with its provider expiry when Meta reports one; otherwise with expiry unknown (see Expiry below) |
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
  No refresh token, user id or scope is documented in the response. `expires_in` is NOT always present: a LIVE
  re-authorization (Step 7G-H5.5-P12-C0-R5D, 2026-10-26) returned a valid token response without it.

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
- The exact `expires_in` of the short-lived user token, and when Meta omits it (observed LIVE on a re-authorization; the reason is not established).

## Implementation status (Step 7G-D)

| Item | State |
|---|---|
| Meta authorization adapter | IMPLEMENTED_OFFLINE: `integrations/providers/meta/{authorization,oauth-transport,errors,endpoints}.ts` |
| Graph version | `META_GRAPH_VERSION = "v25.0"`, declared once (`endpoints.ts`) |
| PKCE | NOT_SUPPORTED (`pkce: "not_supported"`) |
| Token exchange | one GET per call; no retry (TOKEN_EXCHANGE_RETRY = NONE); manual redirects refused; 10 s timeout; 64 KiB body bound |
| Ambiguous exchange (no response, timeout, redirect, unreadable or unexpected body) | OutcomeUnknown: the code is treated as spent |
| Credential | ProviderCredential v1: `randomUUID()` id, access token as SecretValue, `grantedScopes: []` |
| Expiry | `expires_in` OPTIONAL on an otherwise valid success (Step 7G-H5.5-P12-C0-R5F, from LIVE evidence R5D). Present: positive whole seconds, at most ten years → `expiresAt = issuedAt + expires_in`; present but malformed → OutcomeUnknown (`token_response_expires_in_invalid`), no credential stored. Absent: the token is accepted with `expiresAt = null` = expiry UNKNOWN — never "never expires", never "expired"; no lifetime is inferred or defaulted. Actual expiry or revocation is learned from provider credential errors (e.g. 190 / 463) |
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
  synthetic placeholder in fixtures. (Discovery only. Facebook `read_content` derives a Page token through its own
  dedicated request: see › Facebook Page read_content, Step 7G-H5.5-P5-B.)

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
| RECONNECT_SURFACE | IMPLEMENTED in Step 7G-H5.5-P12-C0-R2, LIVE-validated R5I (see the Remove Meta table below); the domain reconnect path is unchanged |
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
| RECONNECT_SURFACE | IMPLEMENTED, LIVE-VALIDATED (Step 7G-H5.5-P12-C0-R2 / R5I): one Reconnect form per Meta connection that isn't REMOVED on Settings › Connections; `reconnectMetaConnectionAction` reads only `workspaceId` and `connectionId` and starts the existing authorization with that connection as its reconnect target, so a successful completion is `reauthorized` on the SAME logical connection (new credential stored, pointer swapped, old envelope shredded, one transaction). A reconnect after removal stays refused |

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

**Authorization semantics — RESOLVED (Step 7G-H5.5-P4-C).**
`ACCOUNT_PERMISSION_MISSING` is an authorization condition, not proof of intrinsic provider/platform non-support. P4-B
had found the evaluator storing it as `UNSUPPORTED / ACCOUNT_PERMISSION_MISSING`, contradicting the approved meaning of
Unsupported (TA §16.2, Model §6.2); P4-C resolves it with a PROFILE-ONLY state. The account profile now has five states,
the catalog keeps four:

| Profile state | Meaning | Reasons (exactly) | Availability | Recovery |
|---|---|---|---|---|
| SUPPORTED | validated platform support, account authorized | CATALOG_SUPPORTED | AVAILABLE | — |
| AVAILABLE_WITH_LIMITATION | as SUPPORTED, with a known restriction | CATALOG_LIMITATION | AVAILABLE_WITH_LIMITATION | — |
| UNSUPPORTED | the provider/account can't support it (authoritative) | CATALOG_UNSUPPORTED, OBSERVED_NOT_ELIGIBLE | UNAVAILABLE / CAPABILITY_UNSUPPORTED | OPEN_ON_PLATFORM |
| NOT_AUTHORIZED | the provider/account supports it, but Wrenkind lacks the current provider authorization | ACCOUNT_PERMISSION_MISSING, OBSERVED_PERMISSION_MISSING | UNAVAILABLE / ACCOUNT_PERMISSION_MISSING | REAUTHORIZE, then manual Re-check |
| UNKNOWN_NOT_VALIDATED | support truth not established, or facts unreadable | CATALOG_NOT_VALIDATED, ACCOUNT_FACTS_UNAVAILABLE, ACCOUNT_FACTS_INCONSISTENT | UNAVAILABLE / CAPABILITY_NOT_VALIDATED | Re-check when facts were unavailable |

- **Profile-only.** `NOT_AUTHORIZED` is a `ProfileState`, never a `CatalogState`: a catalog entry can't declare it (type),
  and the entry contract refuses it if a cast smuggles it in (`NOT_A_CATALOG_STATE`).
- **Strict.** The overlay maps NOT_AUTHORIZED only to UNAVAILABLE / ACCOUNT_PERMISSION_MISSING / REAUTHORIZE (never
  AVAILABLE, TEMPORARILY_UNAVAILABLE or platform non-support) and UNSUPPORTED only to CAPABILITY_UNSUPPORTED /
  OPEN_ON_PLATFORM. An incoherent row is never trusted: the store refuses it as corruption, the overlay answers
  CAPABILITY_NOT_VALIDATED, and migration 0015's `profile_entries_state_reasons` CHECK refuses it in the database.
- **Recovery.** A current profile with any NOT_AUTHORIZED row is eligible for an Owner/Admin Re-check (basis
  `AUTHORIZATION_MISSING`; offer copy "Authorization is missing for one or more capabilities. Reauthorize the connection
  if needed, then re-check capabilities."). Re-check only re-reads the provider facts; it never grants authorization.
  The cooldown applies as usual.
- **Capability refresh after re-authorization.** `AUTO_REEVALUATE_AFTER_REAUTHORIZED = IMPLEMENTED_VIA_VALIDATED_DISCOVERY`
  (Step 7G-H5.5-P12-C0-R1; LIVE-validated R5I). The completion of a successful `reauthorized` exchange emits no evaluation
  itself: it marks that connection's discovery authority with the typed `capability_refresh_credential_id` of the NEW
  credential (the only producer; never user input). Only a VALIDATED discovery whose marker still equals the active
  credential requests one system `capability.evaluate_account` per ACTIVE account of that connection and workspace, keyed
  `capability.evaluate_account:{account}:credential.{credentialId}` (at most one per account per credential); a
  superseded credential requests nothing, and a credential-bound evaluation whose credential was replaced is a no-op
  before any credential load. This is backend/system authority: no `REEVALUATION_REQUESTED` event, no manual Re-check
  is fabricated, and the Owner/Admin Re-check keeps its own semantics (PROFILE_CURRENT, cooldown, `USER_REQUESTED_REEVALUATION`).
- **Execution layer.** No AppError mapping from availability exists today. When the action-execution phase adds one,
  NOT_AUTHORIZED (availability ACCOUNT_PERMISSION_MISSING) must never become `CAPABILITY_UNSUPPORTED`: it is an
  authorization problem with a re-authorization recovery, not a platform limit.
- **No catalog change.** This is a profile-vocabulary change only: no entry, capability key or scope changed, so
  `platform` and `simulator` both stay revision 2 and no LIVE profile becomes stale (the 20 LIVE rows are
  UNKNOWN_NOT_VALIDATED / CATALOG_NOT_VALIDATED, valid before and after). P4-C validates no capability.
- **Migration 0015** (`0015_capability_not_authorized.sql`): widens `profile_entries_state_check` with NOT_AUTHORIZED and
  adds the `profile_entries_state_reasons` coherence CHECK; additive, no backfill. Its VALIDATE step fails if any row
  still has the old UNSUPPORTED + permission shape (none existed). Deploy order: the migration, then the paired Trigger
  release, then the web.

**Entry contract.** `modules/capability/domain/catalog-contract.ts` (development/test-time only) and the evidence schema
`api-validation/README.md`:
- **Positive entries** (SUPPORTED, AVAILABLE_WITH_LIMITATION) need all of: an accepted positive `api-validation:` record
  of the exact scope; a non-empty, explicitly named `requiredPermissions` equal to the record's; and registered
  implementation evidence for the capability's EXACT operation set (Step 7G-H5.5-P5-B): (A) an
  `OFFLINE_IMPLEMENTED_OPERATIONS` registration of exactly that set, and (B) an `IMPLEMENTED_PLATFORM_OPERATIONS`
  (live-validated) registration of exactly that set resting on the same accepted record, whose `operations` are that set.
- **UNSUPPORTED entries** need an accepted authoritative-negative record and name no permission.
- **Never from absence.** A missing or unrequested permission, an unimplemented operation, unavailable facts, a failed
  read or a missing rule never yield UNSUPPORTED: those stay UNKNOWN.
- **No inferred mappings.** No capability-to-operation mapping is inferred from names: the sets are declared in
  `CAPABILITY_REQUIRED_OPERATIONS`, and only `read_content` = {`getContent`, `listContent`} is declared (P5-B); a
  capability without a declared set can't be positive. `describeAccount` is never evidence.
- **Nothing passes today.** No accepted record and no live-validated implementation evidence exist, so no entry is
  admissible and `platform.entries` is `[]` — even though the P4-B authorization-semantics blocker itself is lifted (P4-C)
  and Facebook `read_content` is now implemented offline (P5-B).

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
| FIRST_VALIDATED_PLATFORM_ENTRY | semantic blocker LIFTED (P4-C, `FIRST_VALIDATED_PLATFORM_ENTRY_BLOCKED_UNTIL_AUTHORIZATION_SEMANTICS_RESOLVED = NO`); still not admissible without an accepted record and implementation evidence |
| PROFILE_STATES | SUPPORTED, AVAILABLE_WITH_LIMITATION, UNSUPPORTED, NOT_AUTHORIZED, UNKNOWN_NOT_VALIDATED (NOT_AUTHORIZED profile-only) |
| AUTO_REEVALUATE_AFTER_REAUTHORIZED | IMPLEMENTED_VIA_VALIDATED_DISCOVERY (P12-C0-R1; LIVE R5I): system evaluation per ACTIVE account for the new credential, emitted only by that credential's validated discovery; manual Re-check unchanged |
| REEVALUATION | manual Re-check only; no automatic reconcile |

**H6 readiness contract.** H6 may ingest for a Connected Account only when, at the moment of ingestion:
the account is ACTIVE; its connection is ACTIVE with a valid credential pointer; and `capabilityAvailability` answers
AVAILABLE (or AVAILABLE_WITH_LIMITATION, honoring the limitation) for EXACTLY the capability of that operation —
`read_content` for top-level content, `read_interactions` for comments and replies, `read_history` for backfill depth.
H6 consumes the resolver; it never infers a capability from the Meta authorization, the granted permissions, the
discovery result or the data it sees. Today that means: the simulator for development; real Meta only after the
live capability-validation gate.

## Facebook Page read_content (Step 7G-H5.5-P5-B) — IMPLEMENTED_OFFLINE_NOT_LIVE_VALIDATED

P5-B implements the provider side of `read_content` for Facebook Pages **offline only**. Nothing here is a validated
fact about the live Graph API: no catalog entry, no accepted (or draft) `api-validation:` record, no catalog revision
bump, no LIVE profile change. The platform catalog stays `platform` r2 with zero entries, and Facebook `read_content`
still evaluates UNKNOWN_NOT_VALIDATED.

**Semantics (TL decision).** `READ_CONTENT_REQUIRED_OPERATIONS = [listContent, getContent]`: the existing provider
contract's two content reads. A catalog `SUPPORTED` verdict for `read_content` may never rest on only one of them — the
entry contract refuses it (`IMPLEMENTATION_INCOMPLETE`, `EVIDENCE_OPERATIONS_INCOMPLETE`, `IMPLEMENTATION_EVIDENCE_MISMATCH`).
The capability is not redefined.

| Registry | State after P5-B |
|---|---|
| OFFLINE_IMPLEMENTED_OPERATIONS | meta · facebook · `read_content` · {`getContent`, `listContent`} (adapter code + offline tests; guard-checked against the adapter) |
| LIVE_VALIDATED_OPERATIONS (`IMPLEMENTED_PLATFORM_OPERATIONS`) | none |
| API_VALIDATION_RECORD_COUNT | 0 |
| PLATFORM_CATALOG | `platform` r2, entries `[]` |

**Requests (Graph `v25.0`, unchanged; all GET, the existing transport: `redirect: "manual"`, 10 s, 64 KiB, whitelist
parsing, one request per operation step, no retry).**

| Step | Request | Token |
|---|---|---|
| Page token derivation | `GET /v25.0/{page-id}?fields=access_token` | the sealed User Access Token |
| listContent | `GET /v25.0/{page-id}/published_posts?fields=id,from,message,created_time,updated_time,status_type&limit=10[&after={cursor}]` | the derived Page Access Token |
| getContent | `GET /v25.0/{post-id}?fields=id,from,message,created_time,updated_time,status_type` | the derived Page Access Token |

- **`/published_posts`, never `/feed`**: the product means content published by the managed Page, not visitor or
  user-generated Page content. Never requested: `attachments`, `full_picture`, `permalink_url`, `story`, insights,
  metrics.
- **Page token model**: each `listContent` / `getContent` call derives a Page Access Token from the sealed User Access
  Token and uses it for exactly one content read in the same call. The derived token is a `SecretValue` local to that
  call, inside the credential-use boundary: never persisted, cached, written to the database, logged, returned, placed
  in a DTO, error, raw reference or telemetry. An echoed `id`, when present, must be the managed Page; a missing, empty
  or malformed `access_token` is unreadable. Tests use synthetic markers only.
- **Expected permissions (to validate LIVE, not established)**: `pages_read_engagement`, `pages_show_list`.
  `pages_read_user_content` is NOT added. A LIVE authorization rejection is P5-C evidence for `NOT_AUTHORIZED`, never
  `UNSUPPORTED`.

**Mapping into ContentDto.** `ref` = facebook content `{post id}`; `account` = the managed Page; `caption` = `message`
(null when absent; untrusted); `publishedAt` = `created_time`; `timestamps` = `created_time` / `updated_time` (null when
absent); `availability` = `available`; `rawReference` = `facebook:post:{id}` (`meta`, `v25.0`).
- **Identity**: every post's `from.id` must equal the managed Page, else the whole page (or the single read) fails
  closed — never a partial page. `from.name` is never read.
- **`reportedSource` = `unknown`**: `/published_posts` says who published, not organic vs paid. The provider DTO never
  manufactures `organic`; a future catalog scope `source = organic` needs P5-C/product evidence first.
- **Content kind — a CLOSED `status_type` table**: `added_video` → `video`; `mobile_status_update`, `added_photos`,
  `shared_story` → `post`. Every other value (e.g. `created_event`, `created_note`, `wall_post`, `app_created_story`,
  `published_story`, `tagged_in_photo`, `approved_friend`, `created_group`, any new value) and a missing `status_type`
  fail closed (unreadable). No catch-all fallback. Reels, Stories and Carousel stay out of scope.

**Pagination and window.**
- One `listContent` call = ONE provider page. `paging.cursors.after` + `paging.next` → `{kind: "more", cursor}`;
  `paging.next` absent → `{kind: "end"}`. The `next` URL is presence-only and never fetched; the raw `after` is sent
  back against the fixed endpoint. The `cursor` handed to callers is the `meta1.` envelope of that raw cursor (Step
  7G-H5.5-P5-C7, below), never the raw Graph value. A malformed or oversized cursor, a next page without a valid
  cursor, or a returned cursor equal to the one sent fails closed. Cursors are never stored by the provider. The caller
  controls iteration; there is no "fetch entire history".
- The window `[from, to)` is applied CLIENT-SIDE to `created_time`. No server-side bounding is claimed (no
  `since`/`until`), and pagination never stops early on an assumed ordering, so a page may be empty and still `more`.
  `read_history` stays a separate capability.

**Errors (P4-C semantics preserved).** Graph codes 10 / 200–299 and subcode 492 → `PermissionMissing(read_content)`
(an authorization observation, never UNSUPPORTED); 190 / 102 / OAuthException → `CredentialInvalid`; 4 / 17 / 32 / 341 /
613 / 8000x → `RateLimited`; 1 / 2, 5xx and network → `Transient`; a malformed schema or an identity mismatch →
`PermanentRejected` (unreadable), with no unsupported observation. **getContent only:** code 100 / subcode 33 on the
post read is `TargetNotFound` — Meta's text covers "does not exist, cannot be loaded due to missing permissions, or does
not support this operation", so it is ambiguous and is never evidence for UNSUPPORTED, `TargetNotEligible` or
`OBSERVED_NOT_ELIGIBLE`. On `listContent` (and on the token derivation) it stays a permanent rejection. No Graph code is
mapped to `TargetNotEligible`.

**Validation vehicle: `integration.read_content_validation` (INTEGRATION only, operator-only).** `jobs/integration-read-
content-validation.ts` + the thin task `jobs/trigger/integration/read-content-validation.ts`. Not a product task: absent
from the task registry and outbox routes, no schedule, no hook, no product UI; one task attempt, one KMS attempt, its
own queue of one, 120 s. Payload: exactly `{acknowledge: "INTEGRATION_READ_CONTENT_VALIDATION_V1", workspace_id,
connected_account_id}` (internal UUIDs, no provider id, no token). Guards before anything provider- or AWS-capable: a
pinned Trigger.dev PRODUCTION run; the integration plane's environment contract; `APP_DEPLOYMENT_ENV = staging`;
Node 22; no `CAPABILITY_PROVIDER_MODE`; the KMS keyring. Then a READ-ONLY lookup (one worker transaction in the
payload's workspace; the store's write dependencies refuse): an ACTIVE, content-bearing Facebook Page of an unremoved
Meta connection with its active credential. Then ONE credential opening (Roles Anywhere → KMS Decrypt) in which:
1. `listContent` over `[now − 30 days, now)`, first page only;
2. only if it returned at least one in-window item: `getContent(first listed ref)` — never an arbitrary target.

It writes nothing (no capability profile, catalog, outbox, ingestion, audit or effect claim) and has no capability
authority. Output (closed values only): result class, `positiveEvidenceEligible`, authorization class, Graph version,
window days, stages, the implemented Meta request count, list success / item count / in-window count / content-kind
histogram / pagination `more|end` / correlation booleans / error class, getContent attempted / succeeded / correlation
booleans / error class, and `get.selectedContentKind` (Step 7G-H5.5-P5-C0): the canonical `ContentKind` of the exact
listed item whose ref getContent read back (null when not attempted), with `get.contentKindMatchesListed` = re-read kind
=== that selected kind — so a positive run proves which kind getContent was validated on. Never: Page or post ids, refs, tokens, captions, names, cursors, URLs, raw responses, AWS
material (architecture- and unit-tested).

| Run | Meta GETs (implemented) |
|---|---|
| with ≥ 1 in-window item | 4: derive + `published_posts`, derive + `{post-id}` |
| zero in-window items | 2: derive + `published_posts`; no getContent |

The Page token is derived once per operation rather than shared across the two calls: sharing it would mean changing
the public `ProviderReadPort` contract, which P5-B does not do. A zero-item run can never become accepted positive
capability evidence. INTEGRATION now discovers 4 tasks (2 product + 2 diagnostics); MAIN stays at 6.

**Expected LIVE validation sequence (P5-C, not executed; a later gate authorizes it).** Paired release carrying P5-B →
one operator run of `integration.read_content_validation` for the managed Facebook Page → logical run and task
attempts counted separately (one attempt by design) → CloudTrail (one CreateSession, one Decrypt) → a `draft` record
only if both operations succeeded with correlation → TL review → `accepted` → a later gate registers the live
implementation evidence and decides the catalog revision and the first entry.
**First catalog scope: PROPOSED, not accepted** — `facebook` · `content_bearing` · `read_content` · `contentKind = post` ·
`source = organic`.

**Unresolved (to be established LIVE; none is a validated fact):**
- the exact permission behavior of `/published_posts` LIVE (whether `pages_read_engagement` + `pages_show_list` suffice);
- Page role / task behavior (which Page tasks the user needs for the token derivation and the reads);
- pagination ordering of `/published_posts`;
- the future `organic` classification of Page-published content;
- the Page Access Token derivation's LIVE behavior (presence of `access_token`, echoed `id`);
- whether real Page-post `status_type` values (or their absence) and real bodies fit the closed table and the 64 KiB
  bound with a page of 10.

## Pagination cursor envelope (Step 7G-H5.5-P5-C7) — IMPLEMENTED, NOT YET LIVE-VALIDATED

**Why.** LIVE diagnostic run #4 (after a fresh Page post) got a successful `/published_posts` page WITH continuation.
Its raw `paging.cursors.after` passed the transport's raw-cursor rule but not the provider-neutral `PageCursor`
(`^[A-Za-z0-9_.:=-]{1,512}$`), because the read port passed the raw Graph cursor straight through as a `PageCursor`.
listContent failed closed (`permanent_rejected / invalid_cursor`, whole page rejected) and getContent never ran. The
raw cursor was never logged, so whether its alphabet, its length or both failed is unknown, and it is not recovered.
Runs #2/#3 returned no posts, so Graph sent no `next` and the cursor was never checked.

**Design (P5-C7-A, Fable review).**
- `PageCursor` stays a Wrenkind-owned, opaque continuation token, valid only for the operation and scope that produced
  it. Its alphabet is unchanged; its capacity is `PAGE_CURSOR_MAX_LENGTH = 2048` (was 512).
- The raw Graph cursor contract is unchanged: printable ASCII without whitespace, 1–`META_GRAPH_CURSOR_MAX_LENGTH`
  (1024) characters, validated in the transport.
- The Meta adapter owns a versioned envelope, private to `integrations/providers/meta/read-port.ts`:
  `meta1.<raw cursor as unpadded base64url>`. It is deterministic (the same raw cursor always gives the same
  `PageCursor`, so the repeated-cursor check still holds) and carries no id, time or randomness. The simulator's
  `sim1.` envelope already followed this pattern.
- Decoding is fail-closed, before any request: exact `meta1.` prefix; non-empty payload of the strict base64url
  alphabet (`^[A-Za-z0-9_-]+$`, no `=`, `+`, `/` or whitespace); canonical (re-encoding the decoded bytes must reproduce
  the payload, because Node's decoder is permissive); the decoded value must again be a valid raw Graph cursor. Any
  failure is `permanent_rejected / invalid_cursor`, and a foreign (`sim1.`, other version) cursor is refused the same way.
- Graph receives only the decoded raw cursor as `after` (query-encoded); the envelope never reaches Meta.
- Capacity: `6 + ceil(4 × 1024 / 3) = 1372 ≤ 2048` (architecture-guarded from the exported constants).
- Unchanged: `paging.next` is never followed; cursors are never persisted or logged and never appear in errors, the
  diagnostic output or evidence; no DB, env, KMS, task topology, catalog or UI change; every content, getContent,
  Page-token, window and error mapping rule above is unchanged.

**Next.** Rollout (commit → CI → paired Trigger release → web alignment), then exactly one controlled LIVE run #5,
reusing the fresh Page test post if it is still available. Facebook read_content is NOT LIVE-validated until then.

## Facebook read_content LIVE evidence accepted (Step 7G-H5.5-P5-C9-B)

**LIVE result (P5-C8, 2026-10-23 UTC).** At source revision `fb91ead`, fully aligned on the INTEGRATION and MAIN
Trigger planes and the web, one operator run of `integration.read_content_validation` (one attempt) succeeded
end-to-end. The run derived a Page token and read one page of `published_posts`: one in-window item, kind `post`,
reported source `unknown`, with continuation returned as a `meta1.` PageCursor (the P5-C7 fix, confirmed LIVE). It
then derived a Page token again and read the same item back with `getContent`: same ref, same managed Page, same kind.
Four Graph GETs are inferred from the executed stages. There was no authorization, credential, rate-limit or transient
failure, and no profile, outbox or catalog change. The earlier diagnostic runs are history only, never evidence:
- #1 was refused at the input guard (invocation tooling);
- #2 and #3 found no content;
- #4 hit the cursor-envelope defect fixed in P5-C7.

**Accepted record.** `api-validation:meta.facebook.read_content.20261023-01`
(`api-validation/records/meta/facebook/read_content/20261023-01.json`), registered in `IMPLEMENTED_PLATFORM_OPERATIONS`
with operations `getContent` + `listContent`. Scope: `facebook` · `content_bearing` · `read_content` · `post` ·
`unknown`. This scope supersedes the P5-B proposal of `source = organic`.

**Source semantics.**
- `unknown` is a real capability-source value: the platform reported no more specific classification, and the
  adapter never manufactures one.
- Reading `/published_posts` says who published the content, not whether it was organic or paid. The validated
  `post` was reported `unknown`, so organic, paid and mixed remain unvalidated.
- `any` is not used: it means every value of the source dimension and would claim support never observed.

**Permission semantics.**
- `requiredPermissions` = the known provider/contract conditions for this path: `pages_read_engagement` and
  `pages_show_list`, per R11 below.
- The observed granted permissions are account facts (the profile's granted set), not requirements. The validated
  connection also held `business_management`, `instagram_basic` and `public_profile`; none of them is listed.
- `pages_read_user_content` was NOT granted and the read succeeded, so it is not required for this Page-owned-post path.
- The run proves that this two-permission path works. It does NOT claim a globally minimal permission set for every
  Facebook API scenario, and no independent AWS audit is claimed (the record contract does not require one and forbids
  AWS identifiers).

**Authoritative references** (Meta-owned, retrieved 2026-10-23; R6, R10 and R11 as listed in E1):

| Ref | Source and what it supports |
|---|---|
| R11 | Permissions reference. `pages_read_engagement` lets an app read content (posts, photos, videos, events) posted by the Page, with `pages_show_list` as its dependency. `pages_show_list` gives access to the list of Pages a person manages. `pages_read_user_content` covers user-generated content on the Page (posts, comments and ratings by users or other Pages), which is not the Page-owned content read here. |
| R6 | Page reference. `access_token` is a Page field ("The Page's access token"), returned only when the requesting User has a role on the Page other than Live Contributor. This is the per-Page lookup Wrenkind uses: `GET /{page-id}?fields=access_token` with the User token. |
| R10 | Access tokens guide. Page access tokens are obtained with a User access token for Pages the person has a role on; the guide shows the `/{user-id}/accounts` form. |
| R13 | Page Published Posts edge — `https://developers.facebook.com/docs/graph-api/reference/page/published_posts/` (localized). Its Reading section names no permission scope; it only notes that a public-Page-content feature permission may be required. The permission assertion therefore rests on R11 and on the LIVE result, not on R13. |
| R14 | Meta's Facebook API Postman workspace, request "Get Specific Page Access Token" — `https://www.postman.com/meta/facebook/request/tass6hw/get-specific-page-access-token`. Located through the search index (a per-Page `fields=…access_token` lookup with a User token). The page did not render for retrieval, so it is supplementary and not relied upon; R6 is the authority. |

**Accepting this record does NOT change the catalog.** The platform catalog stays `platform` r2 with zero entries, and
the LIVE profiles keep their current state. A later gate may publish an r3 entry of exactly this scope (post / unknown,
the two permissions, this evidence). The revision bump will make every profile `PROFILE_STALE` until a manual Re-check.

## Platform catalog r3: first published supported capability (Step 7G-H5.5-P5-C9-C)

**What changed (code only, local).** `PLATFORM_CATALOG` moves from `platform` r2 (no entries) to **r3**
(`platform-catalog-r3`) with exactly ONE entry, scoped exactly as the accepted record:

| Field | Value |
|---|---|
| platform · assetClass | `facebook` · `content_bearing` (provider `meta`, implied by the platform) |
| capability · contentKind · source | `read_content` · `post` · `unknown` |
| state · limitation · validation | `SUPPORTED` · none · `validated` |
| requiredPermissions | `pages_read_engagement`, `pages_show_list` |
| evidence | `api-validation:meta.facebook.read_content.20261023-01` |

The entry contract admits it with no violation: the record is accepted and positive with the identical scope and
identical permissions, and the one live registration (`IMPLEMENTED_PLATFORM_OPERATIONS`) rests on that same record with
exactly `READ_CONTENT_REQUIRED_OPERATIONS`. The record and the registry are unchanged.

**No broadening.**
- No `organic`, `paid`, `mixed` or `any` source entry exists. `unknown` stays the provider-reported source, never
  translated to organic.
- No other content kind, no `any` kind, no Instagram, TikTok or `ad_account` entry, no other capability.
- A generic `read_content` caller (`any` / `any`) still resolves to its own UNKNOWN row. The catalog lookup lets a
  wildcard scope match only wildcard entries, and the profile resolver is not widened. Making generic callers ask
  for the exact scope is future H6 caller work.

**Profiles (expected semantics, nothing executed).** The evaluator, the availability resolver, the Re-check action and
the database are unchanged; no migration (the stored scope columns already admit `post` / `unknown`).
- Once r3 is deployed, every stored platform profile evaluated at r2 is stale by revision (`PROFILE_STALE`) until an
  explicit Re-check. No row is rewritten by this change.
- After a Re-check, a Facebook Page holding both permissions gets a `read_content` · `post` · `unknown` row that is
  `SUPPORTED` / `CATALOG_SUPPORTED` (availability `AVAILABLE`), next to its `any` / `any` rows, which stay
  UNKNOWN_NOT_VALIDATED.
- A Page missing either permission gets `NOT_AUTHORIZED` / `ACCOUNT_PERMISSION_MISSING`, never UNSUPPORTED.
- Instagram profiles keep ten UNKNOWN rows.

**Not claimed.** The runtime does not use r3 yet: no deploy, no Trigger release, no profile refreshed, no Re-check
run. The source, permission and reference semantics of the C9-B section above apply unchanged.

## Instagram read_content (Step 7G-H5.5-P11-B) — IMPLEMENTED_OFFLINE_NOT_LIVE_VALIDATED

**Scope.** Instagram professional accounts (Business or Creator, connected to a Facebook Page), asset class
`content_bearing`, capability `read_content`. The provider contract is unchanged: the same `listContent` and
`getContent` operations, selected by the account's platform with no fallback (a TikTok or any other account still
takes the Facebook Page path, which refuses it before any request). Graph stays at `v25.0`.

**Reads.** The sealed Facebook User Access Token is used directly; no Page Access Token is derived, so each call is ONE
Graph GET:

| Operation | Request | Fields |
|---|---|---|
| `listContent` | `GET /v25.0/{ig-user-id}/media?fields=…&limit=10[&after=…]` | `META_INSTAGRAM_MEDIA_FIELDS` |
| `getContent` | `GET /v25.0/{ig-media-id}?fields=…` | the same constant |

`META_INSTAGRAM_MEDIA_FIELDS` = `id,media_type,media_product_type,timestamp,caption,owner`. Never media URLs,
thumbnails, permalinks, album children, counts, metrics or boost data. The stories, live media, tags and mentioned
media edges are never read.

**Normalization.**
- `owner.id` must be the managed account; an absent or different owner fails the WHOLE page (or the single read)
  closed. A media object is never accepted on its id alone. The get answer must echo the requested id.
- Kind: a CLOSED table on (`media_type`, `media_product_type`):

  | media_type · media_product_type | ContentKind |
  |---|---|
  | IMAGE · FEED | `post` |
  | VIDEO · FEED | `video` |
  | VIDEO · REELS | `reel` |
  | CAROUSEL_ALBUM · FEED | `carousel` |

  STORY and AD media, IMAGE or CAROUSEL_ALBUM as REELS, any new value and a missing value fail closed (no fallback to
  `post`, `other` or an unknown kind). List and get share one mapper, so the same object always has the same kind.
- `reportedSource` is always `unknown`. FEED and REELS name where media appears, not whether it is organic or paid;
  nothing on this path proves either, and `any` is never used.
- `caption` → caption (untrusted text); `timestamp` → `publishedAt` and `createdAt`; `updatedAt` is not reported.

**Window and pagination.** One provider page per call, filtered client-side to [from, to) on `timestamp` (no
`since`/`until`, no ordering assumed, no early stop). Continuation reuses the Page path's rules unchanged: `more`
carries `paging.cursors.after` in the `meta1.` envelope, `end` means `paging.next` was absent, the `next` URL is never
fetched, and a repeated or malformed cursor fails closed. `PAGE_CURSOR_MAX_LENGTH` and the raw Graph cursor bound are
unchanged.

**Errors.** The shared Graph read mapping, unchanged (permission → PermissionMissing(read_content), never
non-support), plus the same getContent-only case: code 100 / subcode 33 on the media read is TargetNotFound. No
Instagram-specific code is added.

**Permissions.** `requiredPermissions` for Instagram `read_content` = the known requirements of the implemented read
path: `instagram_basic` and `pages_read_engagement` (R15: the `/media` edge needs `instagram_basic` with
`pages_read_engagement` or `pages_show_list`; R16: the media node needs `instagram_basic` and
`pages_read_engagement`). `pages_show_list` can matter for connection, discovery and App Review dependency flows, but
it is NOT a requirement of this capability's operation set as implemented, and the live account holding it does not
make it one. No globally minimal permission set is claimed.

**Diagnostic.** `integration.read_content_validation` (no new task; INTEGRATION 4 tasks, MAIN 6) now accepts an ACTIVE
content-bearing Facebook Page or Instagram professional account of a live Meta connection, and its output names the
`platform`. The output fields are platform-neutral (`allItemsFromManagedAccount`, `accountMatchesManagedAccount`); the
refusal for any other account is `read_content_validation_target_not_meta_content_account`. Meta GETs per run:

| Platform | No item | With an item |
|---|---|---|
| facebook | 2 | 4 |
| instagram | 1 | 2 |

**Contract state.** `OFFLINE_IMPLEMENTED_OPERATIONS` registers meta / instagram / read_content (requirement A). It is
NOT live evidence: `IMPLEMENTED_PLATFORM_OPERATIONS` stays Facebook-only, the accepted record count stays 1, and the
platform catalog stays r3 with its one Facebook entry. Instagram has no catalog support, and its profile keeps ten
UNKNOWN rows.

**First live target.** One controlled run of the diagnostic on an Instagram account whose selected item is
IMAGE · FEED could support, after TL acceptance, exactly: `instagram` · `content_bearing` · `read_content` · `post` ·
`unknown`, accountKind `instagram_professional_account`, operations `getContent` + `listContent`, requiredPermissions
`instagram_basic` + `pages_read_engagement`. One observed post never validates `video`, `reel` or `carousel`: each
kind needs its own positive live evidence, its own record and its own catalog entry. No generalized `any` support.

**References** (Meta-owned, retrieved 2026-10-23):

| Ref | Source and what it supports |
|---|---|
| R15 | IG User Media edge — `https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media`. User token; `instagram_basic` with `pages_read_engagement` or `pages_show_list`; up to 10K of the most recently created media; story media not returned (separate edge). |
| R16 | IG Media node — `https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media`. Facebook User token with `instagram_basic` and `pages_read_engagement`; `media_type` is CAROUSEL_ALBUM, IMAGE or VIDEO; `media_product_type` is AD, FEED, STORY or REELS; `timestamp` is ISO 8601 in UTC; `owner` is returned only for media the app user created; data only for media of professional accounts. |
| R17 | IG Media children edge — `https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/children`. Album children: not read in this slice. |
| R2, R8, R11, R5 | As listed above: getting started (User token on `/media`, sample `paging.cursors`), IG User fields and edges, permissions reference, cursor pagination (cursors are not to be stored). |

Meta's samples now show a newer Graph version; moving off `v25.0` is a separate, deliberate change.

## Instagram read_content LIVE evidence accepted (Step 7G-H5.5-P11-D)

**LIVE result (P11-C2, 2026-10-23 UTC).** At source revision `cd2c863`, fully aligned on the INTEGRATION and MAIN
Trigger planes and the web, one operator run of `integration.read_content_validation` (one attempt) against the
connected Instagram professional account succeeded end-to-end: `listContent` read one page of `{ig-user-id}/media`
with the Facebook User Access Token directly (no Page token derived) and returned one in-window item — provider
IMAGE on the FEED surface, normalized to `post`, reported source `unknown`, owner correlated — with continuation as a
`meta1.` PageCursor; `getContent` re-read that same media object (same ref, same managed account, same kind). Two
Graph GETs are inferred from the executed stages (Graph `v25.0`). No authorization, credential, rate-limit or
transient failure; no profile, outbox or catalog change. The previous run (P11-C1) is history only: it listed
successfully but found no in-window item, so it was never evidence.

**Accepted record.** `api-validation:meta.instagram.read_content.20261023-01`
(`api-validation/records/meta/instagram/read_content/20261023-01.json`), registered in
`IMPLEMENTED_PLATFORM_OPERATIONS` with operations `getContent` + `listContent`, next to the unchanged Facebook entry.
This supersedes the P11-B statement that the live registry is Facebook-only. Scope: `instagram` · `content_bearing` ·
`read_content` · `post` · `unknown`, accountKind `instagram_professional_account`.

**What it does NOT claim.**
- No other kind: `video`, `reel` and `carousel` stay unvalidated (each needs its own positive run, record and entry).
- No other source: the provider path proves neither organic nor paid, and the operator's knowledge of how the post
  was made is not provider evidence; `any` is never used.
- No stories, live media, tagged or mentioned media, and no generic `any` / `any` read_content.
- `requiredPermissions` = `instagram_basic` and `pages_read_engagement`, the known requirements of the implemented
  read path. `pages_show_list` and the other granted permissions are account facts, not requirements, and no globally
  minimal permission set is claimed.

**Accepting this record does NOT change the catalog.** The platform catalog stays `platform` r3 with its one Facebook
entry, and the Instagram profile keeps ten UNKNOWN rows. Publishing Instagram `post` / `unknown` support is a later
catalog gate (r4), followed by a paired release, web alignment and a Re-check.

## Platform catalog r4: first published Instagram capability (Step 7G-H5.5-P11-E)

**What changed (code only, local).** `PLATFORM_CATALOG` moves from `platform` r3 to **r4** (`platform-catalog-r4`)
with exactly TWO entries: the Facebook entry, unchanged, and one new Instagram entry scoped exactly as its accepted
record:

| Field | Instagram entry |
|---|---|
| platform · assetClass | `instagram` · `content_bearing` (provider `meta`, implied by the platform) |
| capability · contentKind · source | `read_content` · `post` · `unknown` |
| state · limitation · validation | `SUPPORTED` · none · `validated` |
| requiredPermissions | `instagram_basic`, `pages_read_engagement` |
| evidence | `api-validation:meta.instagram.read_content.20261023-01` |

Both entries are admissible with zero contract violations: each rests on its own accepted positive record of the same
scope and permissions, and on its own live registration of `getContent` + `listContent`. No record backs the other
platform's entry, and no entry is visible to the other platform's lookup.

**No broadening.** Instagram `video`, `reel` and `carousel`, every other source (organic, paid, mixed, any), stories,
live, tagged or mentioned media and generic `any` / `any` read_content stay UNKNOWN_NOT_VALIDATED. Organic or paid
support is not claimed, and `pages_show_list` is not an Instagram read_content requirement: an account holding
`instagram_basic` and `pages_read_engagement` without it gets the exact row SUPPORTED / CATALOG_SUPPORTED (availability
AVAILABLE); missing either of the two gives NOT_AUTHORIZED / ACCOUNT_PERMISSION_MISSING.

**Profiles (expected semantics, nothing executed).** No evaluator, resolver, Re-check, database or migration change.
A fresh r4 profile has 11 rows on either platform (10 `any` / `any` rows plus the exact `read_content` · `post` ·
`unknown` row). Once r4 is deployed, the stored r3 profiles (Facebook and Instagram) are stale by revision
(`PROFILE_STALE`) until an explicit human Re-check; nothing rewrites them automatically.

**Not claimed.** The runtime does not use r4 yet: no deploy, no Trigger release, no profile refreshed, no Re-check run.

## read_interactions (Step 7G-H5.5-P12-B1) — IMPLEMENTED_OFFLINE_NOT_REGISTERED

The Meta read port implements `listInteractions` and `getInteraction` offline, through the existing provider contract
(`ProviderReadPort`, `InteractionDto`, `AuthorDto`, `InteractionScope`; interaction kinds `comment` and `reply` only — no
reactions, mentions, DMs or private replies). Nothing here is evidence, a catalog entry or a registration: the offline
registry, `CAPABILITY_REQUIRED_OPERATIONS.read_interactions`, the record's `interactionKinds` field and the diagnostic
`integration.read_interactions_validation` belong to P12-B2, atomically. Every Meta `read_interactions` scope stays
UNKNOWN_NOT_VALIDATED.

**Scope.** One known content item per call: `listInteractions` with `scope.kind === "content"`. The `account` scope (an
account-wide comment feed) is `TargetNotEligible(unsupported_for_target)` on every platform, before any request.

| | Facebook Page post | Instagram professional-account media |
|---|---|---|
| Kinds implemented | `comment` and `reply` | `comment` only (top-level) |
| listInteractions | Page token derivation, then ONE page of `GET /v25.0/{post-id}/comments` with `filter=stream` | ONE page of `GET /v25.0/{ig-media-id}/comments` |
| getInteraction | Page token derivation, then `GET /v25.0/{comment-id}` | `GET /v25.0/{ig-comment-id}` |
| Fields | edge `META_FACEBOOK_COMMENT_FIELDS` = `id,from,message,created_time,parent,is_hidden`; node `META_FACEBOOK_COMMENT_NODE_FIELDS` adds `object` | `META_INSTAGRAM_COMMENT_FIELDS` = `id,from,text,timestamp,parent_id,hidden,media` (edge and node) |
| Token | derived Page Access Token per operation, never kept (the read_content helper) | the sealed User Access Token directly; no derivation |
| Meta GETs per call | 2 | 1 |
| Page size | `META_FACEBOOK_COMMENTS_PAGE_LIMIT` = 10 | `META_INSTAGRAM_COMMENTS_PAGE_LIMIT` = 10 |

**Normalization.** `ref` = the comment id; `content` = the scope's content on list; `interactionKind` = `reply` exactly
when Facebook reports `parent.id` (`parent` = that comment), else `comment` with `parent` null. Instagram never yields a
reply: a `parent_id` fails closed (it is not normalized as a reply in this slice). `author.ref` = `from.id`, REQUIRED:
a missing `from` or `from.id` fails the WHOLE page — never a dropped row, never an invented author. `author.role` =
`account_identity` exactly when `from.id` is the managed asset's id, else `user`. Facebook `displayName` = `from.name`
(or null), `handle` null; Instagram `displayName` null, `handle` = `from.username` (or null). `text` = `message` / `text`
as reported (required; `""` only when the provider says so). `visibility` from the reported boolean only (`is_hidden` /
`hidden`; absent → `unknown`). `availability` `available`; `textRevision`, `editedAt`, `updatedAt` null. No source and no
paid attribution exist on an interaction (`read_paid_context` is separate).

**Correlation, fail closed.** List: the caller's content scope is the parent authority (it comes from validated managed
content); Instagram additionally fails closed on a reported `media.id` other than the scope's. Get (superseded by
Step 7G-H5.5-P12-C9, below): Facebook's content authority is the listing edge, never a bare id —
`object.id` is optional corroboration; malformed, without id, equal to the parent comment or to the comment itself
still fails closed; Instagram's is `media.id` (absent fails closed). A get answer whose echoed id differs is unreadable; code 100 /
subcode 33 on the node read is TargetNotFound. A Facebook comment naming itself as its parent fails closed. Any
malformed item fails the whole page before the window is applied. Each node refusal NAMES its case (Step
7G-H5.5-P12-C6) with a closed `PermanentRejectedError.diagnostic` — `interaction_content_missing`, `_malformed`,
`_id_missing`, `_equals_interaction`, `_equals_parent`, or `interaction_node_unreadable` — with the same code, kind and
handling as before and never an id: LIVE run P12-C5 failed both Facebook node re-reads indistinguishably, so the next
run must tell which `object` behavior Meta has.

**Re-read provenance (Step 7G-H5.5-P12-C9; design P12-C8).** LIVE run P12-C7 showed that Facebook comment and reply
nodes carry no `object` at all, so a node can never establish its own content. `getInteraction(access, target)` now
takes an `InteractionTarget` (integrations/providers/contract/interaction-target.ts), a closed union whose only kind is
`{ kind: "listed", listed }`: the EXACT `InteractionDto` instance this same port instance returned from
`listInteractions`. Each port keeps an ephemeral, identity-keyed registry (a `WeakMap` per instance; never persisted,
never shared, no credential, no migration) recording, at listing time, the account, the content the edge returned it
under, its identity, parent and kind. A bare id, a copy, a deserialized or reconstructed DTO, another instance's DTO,
another account's or another provider's is `invalid_request` before any request; there is no bare-id fallback.

| Facebook node read of a listed interaction | Result |
|---|---|
| no `object` | accepted on the listed post |
| `object.id` = the listed post | accepted (corroborated) |
| `object.id` = another post | refused, `interaction_content_conflicts` |
| `object` malformed / without id / = the comment / = its parent | refused as before (named) |
| node id ≠ the listed id, or otherwise unreadable | refused, `interaction_node_unreadable` |
| parent ≠ the listed parent (incl. a kind change) | refused, `interaction_parent_mismatch` |

A reply has DIRECT authority from the edge that listed it — never inherited from its parent comment's re-read; its
identity, parent and kind are verified against the provenance after the response. Instagram is unchanged (`media.id`
stays required on the node). The simulator applies the same registry and checks, with no bypass. Same requests and
budgets as before; the diagnostic passes the listed DTO instance and its `contentAuthority` adds `content_conflicts` and
`parent_mismatch` (ten relations).

**Window and pagination.** The window [from, to) is applied client-side to the creation time with no ordering assumed
and no early stop. Exactly one provider page per call; the same `meta1.` envelope, raw-cursor bounds and
fixed-endpoint continuation as read_content; `paging.next` is never fetched; a repeated cursor fails closed.

**Errors.** The shared Graph read mapping with capability `read_interactions` (a failed Page token derivation for an
interaction read also names `read_interactions`); never non-support.

**LIVE-verify items (not established by this slice).** Whether Graph returns `is_hidden` and `object` on these reads;
whether `object.id` of a reply names the post; pagination parameters on the Instagram comments edge; whether `from`
is always present for user comments under the granted permissions; whether Instagram reports the account's own
comments with `from.id` equal to the IG user id; the exact permissions each read needs (P12-A2: documentation is
internally inconsistent, so no permission set is claimed here and none is minimal); whether a page of long comments fits
the 64 KiB body bound (an oversized page fails closed).

## read_interactions validation contract and diagnostic (Step 7G-H5.5-P12-B2) — OFFLINE, NOT LIVE-VALIDATED

**Contract.** `CAPABILITY_REQUIRED_OPERATIONS.read_interactions` = `getInteraction` + `listInteractions`; the Meta
Facebook and Instagram adapters (P12-B1) are registered OFFLINE only; the evidence record gains `interactionKinds`
(api-validation README › read_interactions evidence semantics). No LIVE registration, record, catalog entry, limitation
code or migration: the platform catalog stays r4 with its two read_content entries, and every Meta `read_interactions`
scope stays UNKNOWN_NOT_VALIDATED. A positive `read_interactions` entry is refused until the kinds → state rule exists
(defined by Step 7G-H5.5-P12-D2b; see Platform catalog r5 below).

**Diagnostic.** A separate operator-only INTEGRATION task, `integration.read_interactions_validation`
(jobs/integration-read-interactions-validation.ts; never an extension of `integration.read_content_validation`).
INTEGRATION now discovers 5 tasks (2 product + 3 diagnostics); MAIN stays at 6. Same security model as the read_content
diagnostic: input exactly `{ acknowledge: "INTEGRATION_READ_INTERACTIONS_VALIDATION_V1", workspace_id,
connected_account_id }` (no provider, content or comment id, no cursor); pinned PRODUCTION release, plane, `staging`
tier, Node 22, no staging stub, KMS keyring; one task attempt, one KMS attempt, its own queue of one, 120 s; writes
nothing.

Sequence, ONE credential opening, window [now − 30 days, now), first provider page of each list: listContent → a
BOUNDED candidate scan (Step 7G-H5.5-P12-C4): listInteractions on the first, then the next in-window item of that one
content page, in provider order, for at most `READ_INTERACTIONS_VALIDATION_CANDIDATE_LIMIT` = 3 items; the FIRST
candidate with at least one interaction is selected, a provider error ends the scan (fail closed), and with none the run
is `INCONCLUSIVE_EMPTY_INTERACTIONS` → getInteraction of the selected candidate's FIRST listed comment and (Facebook
only) its FIRST listed reply. The output adds `candidateLimit`, `candidatesInspected` and `selectedCandidatePosition`
(1-based, or null) — counts and positions only — and, per re-read, `contentAuthority` (Step 7G-H5.5-P12-C6):
`expected_content` / `other_content` for a usable node, else the refusal's relation (`content_missing`,
`content_malformed`, `content_id_missing`, `equals_interaction`, `equals_parent`, `node_unreadable`, and since
P12-C9 `content_conflicts`, `parent_mismatch`), never an id; no extra request. Why the scan: LIVE runs P12-C2/C3 always took position 1 of three in-window
posts, a newer post without interactions, and never reached the prepared one. Each re-read is correlated on identity
only (interaction, content, kind, author and parent refs — never text, name, handle or visibility).
Instagram never re-reads a reply: its slice cannot prove one.

| Path (k = candidates inspected, 1 ≤ k ≤ 3) | Facebook Meta GETs | Instagram Meta GETs |
|---|---|---|
| no content | 2 | 1 |
| content, no interactions on any of the k candidates | 2 + 2k (max 8) | 1 + k (max 4) |
| comment(s) only on candidate k | 4 + 2k (max 10) | 2 + k (max 5) |
| comment and reply on candidate k | 6 + 2k (max **12**) | — |

Worst case: Facebook 2·(1 + N + 2) = **12**, Instagram 1 + N + 1 = **5**, with N = 3. No cursor is ever sent and no
next page is ever fetched.

**Evidence eligibility.** `evidenceInteractionKinds` = the canonical kinds both listed and re-read with full
correlation, non-null only when it contains `comment` and every structural check held. Facebook comment-only →
`INCONCLUSIVE_COMMENT_ONLY` with `["comment"]` (limited evidence; replies not proven); comment and reply →
`READ_INTERACTIONS_LIST_AND_GET_SUCCEEDED` with `["comment", "reply"]`; a reply without a comment →
`INCONCLUSIVE_REPLY_WITHOUT_COMMENT`, never evidence. Instagram comment → `READ_INTERACTIONS_LIST_AND_GET_SUCCEEDED`
with `["comment"]`, never a reply. Failures are closed classes: `PERMISSION_MISSING`, `TARGET_NOT_ELIGIBLE`,
`MALFORMED_RESPONSE` (an unreadable or fail-closed provider page), `PROVIDER_FAILURE`, `CORRELATION_FAILURE`.

**Output.** Closed values, counts and booleans only — platform, account kind, the selected content's kind and reported
source, item and kind counts, author-role and visibility histograms, per-pair correlations, stages and the expected
Meta GETs. Never a text, caption, name, handle, provider id, ref, cursor, raw reference, token or raw response.

## Platform catalog r5: read_interactions published (Step 7G-H5.5-P12-D2b)

**What changed (code only).** Two accepted LIVE records, two LIVE registrations, the kinds → state rule and
`PLATFORM_CATALOG` **r5** (`platform-catalog-r5`) = r4's two `read_content` entries, unchanged, plus exactly two
`read_interactions` entries. No migration (0016, applied in Step 7G-H5.5-P12-D2a, already admits `REPLIES_NOT_READ`), no
provider or evaluator change, no release, no Re-check.

| Field | Facebook entry | Instagram entry |
|---|---|---|
| platform · assetClass | `facebook` · `content_bearing` | `instagram` · `content_bearing` |
| capability · contentKind · source | `read_interactions` · `post` · `unknown` | `read_interactions` · `post` · `unknown` |
| interaction kinds proven LIVE | `comment`, `reply` (P12-C10) | `comment` (P12-C6) |
| state · limitation | `SUPPORTED` · none | `AVAILABLE_WITH_LIMITATION` · `REPLIES_NOT_READ` |
| requiredPermissions | `pages_read_engagement`, `pages_read_user_content`, `pages_show_list` | `instagram_basic`, `instagram_manage_comments`, `pages_read_engagement` |
| evidence | `api-validation:meta.facebook.read_interactions.20261027-01` | `api-validation:meta.instagram.read_interactions.20261026-01` |

**The kinds → state rule** (`readInteractionsPublication`, catalog-contract.ts; pure). Interaction kinds are evidence
detail on the record, never a catalog dimension: the scope stays platform · asset class · capability · content kind ·
source. Over a record's canonical kinds: every canonical kind (`comment`, `reply`) → `SUPPORTED`; every kind except
`reply` → `AVAILABLE_WITH_LIMITATION` with `REPLIES_NOT_READ` (comments are read, replies are not); anything else (empty,
reply-only, duplicates, non-canonical order, an unknown kind, `any`) has no rule and is refused — nothing is normalized
or inferred. An entry's state and limitation must equal that derivation (`INTERACTION_KINDS_STATE_MISMATCH`). Each
OFFLINE registration declares the kinds its adapter implements — Facebook `comment`, `reply`; Instagram `comment` only —
and a record may state only those (`INTERACTION_KINDS_NOT_IMPLEMENTED`); the LIVE registration states exactly its
record's kinds.

**Instagram replies are not unsupported.** UNSUPPORTED still needs an accepted authoritative-negative record of the
exact scope; none exists. Wrenkind's Instagram slice simply does not read replies, so reply coverage there is "not
available", never zero. The Instagram record rests on the P12-C6 run at its own source revision (accepted by TL
decision: the later listed-provenance change only added admission before any provider access and kept the `media.id`
correlation).

**No broadening.** `reel`, `video`, `carousel`, every other source (organic, paid, mixed, any) and generic `any` / `any`
read_interactions stay UNKNOWN_NOT_VALIDATED on both platforms; there is no explicit UNKNOWN entry.

**Profiles (expected semantics, nothing executed).** A fresh r5 profile has 12 rows on either platform (10 `any` /
`any` rows plus the two exact `post` · `unknown` rows). With every required permission: Facebook read_interactions
SUPPORTED / CATALOG_SUPPORTED (availability AVAILABLE); Instagram AVAILABLE_WITH_LIMITATION / CATALOG_LIMITATION /
REPLIES_NOT_READ (availability AVAILABLE_WITH_LIMITATION, the limitation also kept while the connection is temporarily
unavailable). Missing any required permission → NOT_AUTHORIZED / ACCOUNT_PERMISSION_MISSING, never UNSUPPORTED. Once r5
is deployed, the stored r4 profiles are stale by revision (`PROFILE_STALE`) until an explicit human Re-check.

**Not claimed.** The runtime does not use r5 yet: no deploy, no Trigger release, no profile refreshed, no Re-check run.

