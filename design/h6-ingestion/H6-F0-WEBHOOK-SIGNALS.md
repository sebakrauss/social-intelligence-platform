# H6-F0 — Webhook signal ingestion (design only)

Status: **frozen** (Step H6-F0 design; TL decisions D-F1 … D-F5 frozen in H6-F0C, §24). No route, migration, task,
subscription, provider call or deployment is part of F0/F0C. Source authority at design time: `9097f75` (Trigger
20261028.1 on both planes; web `da86455`; dev-v2 ledger 21).

Authoritative inputs: TA §14.1–§14.3, §38.8, §40, §61; CLAUDE.md §5, §10, §13; H6 TL decisions 1–6 (README);
`modules/interactions/domain/vocabulary.ts` (`webhook_relist`); `modules/ingestion/domain/policy.ts`
(`PROVIDER_EVENT_INBOX_POLICY`); H6-E (`ingestion.confirm_interaction`, Meta not-found unconfirmed); 0021.

**Principle (unchanged):** `webhook = signal` · `provider re-read = authority` · `reconciliation = completeness`.

---

## 1. What already exists (do not duplicate)

| Primitive | Where | Use in H6-F |
|---|---|---|
| Webhook hint contract: `WebhookRequest` (raw body + lower-cased headers), `WebhookEventHint` (IDs only, `change` is a hint), `WebhookParseResult`, `WebhookRejectedError` (`missing_signature` · `invalid_signature` · `stale_timestamp` · `malformed_payload`) | `integrations/providers/contract/webhooks.ts` | Reused; extended (§6) |
| `parseWebhook` on `ProviderReadPort` | contract `read-port.ts`; Meta + staging-stub refuse (`invalid_signature`) | Moves to a web-composed webhook port (§6); read ports keep refusing |
| Simulator signer/parser (HMAC-SHA256 over `<ts>.<body>`, tolerance, fail-closed) | `integrations/providers/simulator/webhooks.ts` | Simulator acceptance (its own scheme; Meta's is separate) |
| `subscribe` / `unsubscribe` operations, `manage_webhooks` capability name | contract read port / errors | H6-G only |
| Inbox policy: raw verified body only in `provider_event_inbox`, ≤ 7 days, never copied | `PROVIDER_EVENT_INBOX_POLICY` (TL decision 3) | Enforced by the 0022 inbox |
| Source-fact mechanism `webhook_relist` = `listInteractions · listed` ("the content is re-listed, never trusted"); CHECK already in 0017 | vocabulary / 0017 | The new-interaction path (§9) — no new mechanism |
| Removal basis `explicit_provider_signal` ("a verified webhook removal") | vocabulary / `state.ts` | **Not produced by H6-F** (§11) |
| Per-content watermarks and coverage (`account × capability × content_item`) | 0017, 0018 | Content-targeted relist fits them unchanged |
| `ingestion.confirm_interaction` (stored re-read, one read per attempt) | H6-E | Change/removal path (§10) |
| `ingestion.provider_pause` switch | `platform/flags/registry.ts` | Honored by processing |
| Meta App Secret `PROVIDER_META_CLIENT_SECRET` — **web-only**; both jobs planes refuse it | `server/connections/meta-app-config.ts`, `jobs/plane-environment.ts` | Meta signs webhooks with the App Secret → verification can only live in WEB |
| Post-commit relay nudge (best effort; sweeper fallback) | `platform/outbox/nudge.ts` | Pattern reused for the router nudge |
| M-01: a content-bearing asset is ACTIVE in at most one workspace **per organization** | `connected_accounts_m01_active_content_asset` | Mapping (§7) |

Missing today: any webhook route (`app/api` has only health and OAuth callback), raw-body size handling, edge or
application rate limiting, an inbox table, a routing primitive from provider asset to account, a retention job of any
kind, and Meta's own signature/handshake code. The proxy (`proxy.ts`) matches every route and refreshes session
cookies; a webhook route must keep the forbidden-environment check but skip the cookie refresh.

Constraints discovered: the outbox relay dispatches **tenant tasks only** (`registry.tenant(row.topic)` →
`unknown_task`); the web login can `SET ROLE` only to `authenticated`; system scope covers system tables only
(CLAUDE.md §5); TA §40 requires the receiver to read **no tenant data**.

---

## 2. Authority model (frozen)

A webhook may only say "something about this provider asset/content/interaction may have changed". It never creates
interaction text, author data, visibility, availability/removal, conversation state, coverage, watermarks or
capability. Every canonical change from webhook-triggered work comes from an existing provider re-read:

| Signal leads to | Provider read | Fact provenance |
|---|---|---|
| Content relist (new interactions) | `listInteractions` (INTEGRATION slice) | `webhook_relist · listInteractions · listed` |
| Account reconciliation (new content) | existing planner + slices | `reconciliation · …` (unchanged) |
| Stored confirmation (change/removal of a canonical interaction) | `getInteraction` stored (H6-E) | `stored_reread · getInteraction · stored` |

H6-F adds no source-fact mechanism, no removal basis, no coverage state and no capability.

---

## 3. Topology

```
Meta ──HTTPS──▶ WEB  POST /api/webhooks/meta
                 1 route known? · 2 size/type caps · 3 X-Hub-Signature-256 over RAW bytes (App Secret, constant time)
                 4 parse (whitelisted IDs only) · 5 one tx: system.record_provider_webhook(...)  (definer, no claims)
                 6 200 ── post-commit best-effort nudge ─▶ MAIN ingestion.route_provider_events
                                                              (also cron every minute: the durable fallback)
MAIN  ingestion.route_provider_events   (system scope; drains PENDING hints in bounded batches)
        definer system.route_provider_hint(hint) → ACTIVE account(s) for (platform, provider asset)
        → per (hint, account): IDs-only outbox row  ingestion.process_signals {connected_account_id, provider_event_hint_id}
MAIN  ingestion.process_signals          (workspace scope; per account serial; DB only, no provider)
        re-derives the hint for the BOUND account · gates · upserts a signal mark · requests at most one run/confirmation
INTEGRATION  ingestion.reconcile_slice (existing; relist plan → webhook_relist)  ·  ingestion.confirm_interaction (H6-E)
MAIN  ingestion.purge_provider_events    (system scope; cron; deletes inbox + hints older than 7 days)
```

The WEB holds no provider credential and makes no provider call; MAIN holds none either; only the existing
INTEGRATION tasks read the provider.

**D-F1 = A (frozen).** `system.provider_event_inbox` is deliberately the **durable queue** of this system-scoped
workflow: the receiver commits the receipt and dedupe, answers 200, then nudges the MAIN router best-effort; the MAIN
cron/sweeper guarantees eventual drain. The tenant outbox relay is **not** extended to route provider receipts (it
dispatches tenant tasks only), and the HTTP receiver never waits for routing or provider re-reads.

---

## 4. HTTP receipt (WEB)

Route `app/api/webhooks/[provider]/route.ts` (TA §40 path) → thin → `server/webhooks/route.ts`. Node runtime,
`dynamic = "force-dynamic"`, every response `Cache-Control: no-store`, empty body except the handshake.

**GET — subscription handshake.** Accept only `hub.mode=subscribe`, `hub.verify_token` equal (constant time) to
`PROVIDER_META_WEBHOOK_VERIFY_TOKEN`, and `hub.challenge` matching `^[A-Za-z0-9_-]{1,128}$`. Answer `200 text/plain`
with the challenge; anything else `403`. No database access, nothing logged but the outcome.

**POST — delivery**, in this order (each step fails closed before the next, cheapest first):

| # | Check | Failure |
|---|---|---|
| 1 | Provider known (`meta`) and receiver configured (App Secret + verify token present) | `404`, body never read |
| 2 | `content-type: application/json`; `content-length` ≤ `MAX_WEBHOOK_BODY_BYTES` (1 MiB); stream read with the same hard cap (chunked bodies included) | `415` / `413` |
| 3 | `x-hub-signature-256` = `sha256=` + 64 hex; HMAC-SHA256(App Secret, **exact received bytes**) compared with `timingSafeEqual` on equal-length buffers. The SHA-1 `x-hub-signature` is never accepted | `401`; nothing stored; metric `webhook.rejected{reason}` |
| 4 | JSON parse (only now); envelope `{ object ∈ {page, instagram}, entry[] }`; ≤ 1000 changes | `400` (`malformed_payload`) |
| 5 | Whitelisted extraction into hints (§6); unknown fields/items counted, never guessed | — (counted) |
| 6 | One transaction: `system.record_provider_webhook(...)` | `503` (Meta retries) |
| 7 | `200` | — |

**What must succeed before 2xx:** signature + envelope + the committed receipt (or a recognized duplicate). The
response never waits for routing, a provider read, ingestion, conversations, AI or notifications. A database failure is
`503` (a 200 would lose the signal; Meta's retry is the recovery). The router nudge is after commit and best effort.

**Logging:** reason codes, body-length bucket, hint counts, receipt id digest. Never the body, a header value, the App
Secret, the verify token, comment text or author names/ids.

**Secrets:** the App Secret is opened only through `readMetaAppConfig` (`SecretValue`) and `expose()`d only inside the
HMAC call of `integrations/providers/meta/webhooks.ts`. New web-only secret `PROVIDER_META_WEBHOOK_VERIFY_TOKEN`
(class secret; added to `META_APP_CONFIG_VARIABLES`'s receiver configuration and to the jobs planes' refusal list).
Separate Meta app per environment (TA §40, §51).

**Trust:** the route needs no user session; its trust is the provider signature. No workspace, organization, account,
user or role is ever read from the query or body — they are derived server-side, later, in MAIN (§7).

**Proxy:** `/api/webhooks/` keeps `rejectForbiddenWebEnvironment` and skips `refreshSessionCookies`.

**Database scope:** a new narrow helper `withProviderSignalScope(web, work)` — web login → `SET LOCAL ROLE authenticated`
(fixed literal, R3), **no claims, no workspace binding** — whose only use is the record definer. The definer refuses
(`42501`) when `auth.uid()` or `app.current_workspace()` is set, so no member transaction can record a receipt.

---

## 5. Raw payload, retention and cleanup (frozen; TL decision 3 + TA §40)

- **D-F4 = A (frozen).** The verified raw body (`bytea`, ≤ 1 MiB, byte-exact) is stored **only** in
  `system.provider_event_inbox`, only after the signature validated, and **only when every change's `field` is in the
  receiver allowlist** (`feed` for `page`, `comments` for `instagram`). A delivery carrying any disallowed field (for
  example Messenger `messages`, which S9 forbids) persists **no raw body**: only the approved bounded metadata, plus the
  approved hints extracted in memory when they independently satisfy the whitelist. The disallowed content is never
  persisted — unsupported fields are never a shadow message archive. No index touches the body; no member SELECT; no
  copy into tenant tables, job payloads or logs.
- Never copied into hints, marks, outbox rows, job payloads, logs, analytics, error reports or diagnostics
  (`forbiddenCopies`).
- **Retention: 7 days for everything webhook-derived**: inbox rows (body included), hint rows and signal marks. Nothing
  else survives: after 7 days what remains is the canonical facts produced by re-reads (their normal lifecycle), the
  runs/slices/coverage/watermarks of webhook-triggered runs (attributed by `plan` + system initiator), and aggregate
  metrics. 7 days exceeds Meta's retry window (VALIDATE: documented as ~36 h), so dedupe stays effective.
- Cleanup: MAIN system cron `ingestion.purge_provider_events` (every 15 min, bounded batches, definer
  `system.purge_provider_events(limit)`, cutoff = DB time − 7 days, §16.1); marks expire through `ingestion.process_signals` (tenant side).
  TA-Q-11 stays VALIDATE for production; the 7-day value is the policy constant, configurable per environment.

---

## 6. Provider adapter (Meta, pure)

`integrations/providers/meta/webhooks.ts`: `verifyMetaHandshake(query, verifyToken)` and
`parseMetaWebhook(appSecret, request) → WebhookParseResult`, exposed through a new contract
`ProviderWebhookPort { verifyHandshake, parseWebhook }` composed **in the web** (the read port is integration-only;
its `parseWebhook` keeps refusing). Contract additions to `WebhookEventHint`: `parent: ProviderObjectRef<"interaction"> | null`,
`field` and `item` (closed enums). Extraction is a whitelist: provider object ids, verb, field/item, times. Text
(`message`, `text`), author (`from.id`, `from.name`, `username`) and any other value are never read.

| Meta field (VALIDATE all shapes) | Extracted | Hint |
|---|---|---|
| `page` · `feed` · `item=comment` · `verb ∈ add, edited, remove, hide, unhide` | `entry.id` (Page), `comment_id`, `post_id`, `parent_id`, `entry.time` | target interaction; `parent` when `parent_id ≠ post_id` (reply) |
| `page` · `feed` · `item ∈ post, status, photo, video` · `verb=add` | `entry.id`, `post_id`, `entry.time` | target content, `created` |
| `page` · `feed` · `item=post…` · `verb ∈ edited, remove` | as above | target content, recorded only |
| `instagram` · `comments` | `entry.id` (IG professional account), `value.id`, `media.id`, `parent_id`, `entry.time` | target interaction `created` (reply when `parent_id`) |
| anything else (`reaction`, `share`, `live_comments`, `mentions`, `messages`, …) | nothing | ignored, counted |

Meta sends **no delivery id** and **no timestamp header** (VALIDATE): `deliveryId = null`, replay protection is dedupe
plus an entry-age bound (entries with `time` outside `[now − 7 d, now + 5 min]` → `STALE`, counted).

---

## 7. Account mapping (MAIN; frozen)

`(platform from object, provider asset id = entry.id)` → `connections.connected_accounts` with `status = 'ACTIVE'`,
`asset_class = 'content_bearing'`, same platform and `provider_asset_id`. Facebook: the Page id. Instagram: the
professional account id (`instagram_business_account`, as discovery stores it; VALIDATE that webhooks carry the same).

- Done by the system router through definer `system.route_provider_hint(hint_id)` (EXECUTE `app_system` only): it
  reads accounts by asset identity, writes only IDs-only outbox rows, and returns counts — never tenant data.
- Zero matches → `RETRYABLE` with backoff (1, 5, 15 min; activation races) → `UNMAPPED` (terminal) after 3 attempts.
- **D-F2 = A with no partial fan-out above the cap (frozen).** Several matches can only be different organizations
  (M-01). For **1..5** legitimate ACTIVE matches the router fans out to **all** of them; each tenant independently
  re-derives workspace, connected account, connection, capability and (later) credential authority — no cross-tenant
  canonical sharing. For **> 5** matches the hint is classified **`MULTI_ORG_LIMIT`** (terminal): no tenant processing
  is created, the receipt/hint stays operationally visible within retention, a metric and alert are emitted, and the
  mapping fails closed until the configuration is investigated. Query ordering never decides which tenants receive a
  provider event — the choice is all or none. Pinned by simulator cases 27 and 36.
- At processing, `ingestion.provider_event_hint(hint_id)` (EXECUTE `app_worker`) returns the hint **only** if its
  asset is the bound workspace's ACTIVE account — a move, unlink or removal between routing and processing yields
  `SKIPPED_ACCOUNT_INACTIVE`, never a cross-workspace action.

---

## 8. Deduplication and ordering

| Level | Key | Effect of a duplicate |
|---|---|---|
| Delivery | `body_sha256` unique | `record` returns `duplicate`; 200; nothing new |
| Hint | `hint_key` = SHA-256(`v1` · provider · object · asset · field · item · verb · target · parent · `entry.time`) unique | row not inserted; re-batched retries collapse |
| Processing | dispatch key `ingestion.process_signals:{hint}:{account}` (outbox unique) | relay duplicate absorbed |
| Provider work | one PENDING mark per (account, kind, target) + one open run per account (0018) + confirmation coalescing key | bursts collapse |

Never random UUIDs, `received_at` or raw-body equality. Distinct edits of one comment are distinct hints, coalesced by
marks.

Ordering is never trusted: a reply hint before its parent → content relist reads both (H6-A1 placeholder rule if
needed); remove before create → confirmation of a non-canonical target is skipped and the relist finds whatever
exists; an edit after a newer re-read → the stored re-read applies the provider's current state, and the H6-A1 stale
rules keep history. Hint times only order diagnostics.

---

## 9. New-interaction signal path (D-F3 = A, frozen)

Account reconciliation **cannot** serve this alone: its listing slice reads one page from the floor date and at most
`contentItemsPerRun` (10) contents, so a comment on an older post would never be read. The frozen vocabulary already
names the answer — `webhook_relist`: re-list the content.

**Relist plan** (frozen): `ingestion.reconciliation_runs.plan ∈ {account, relist}`. A relist run has no listing
slice; its planner creates `content_interactions` slices for the account's PENDING relist marks (≤ 10, oldest first),
with the existing windows (per-content watermark − overlap → run start), coverage and conversation semantics. Facts
carry `webhook_relist`. Only **canonical** content of the mapped account is relisted (ownership was established by an
earlier listing); a hint naming unknown content raises an **account** mark instead (the newest content is what listing
finds) and counts `signal.content_not_canonical` — an honest, measured gap. No content row is ever fabricated from
webhook data.

**Signal budget (D-F5 = B, frozen).** Every run requested from webhook signals — relist or account — is requested with
`max_operations = 10` (`SIGNAL_MAX_OPERATIONS`, within the 0019 CHECK 1..40); manual/operator Sync keeps its ordinary
40. Ten operations are an initial bounded authority, not a completeness claim. When a signal-driven traversal exhausts
its budget: slices end `ABANDONED_BUDGET` exactly as today, coverage stays honest (`UNKNOWN / TRAVERSAL_INCOMPLETE`
for what was not traversed), the pending marks are **not** satisfied (only a slice that reached the provider's end of
pages satisfies them, §13), and the close hook requests the follow-up run that completes the traversal later. Budget
exhaustion is never zero interactions. Revisit `10` only from LIVE operational evidence (TA-Q-32).

Arrival: a relisted fact created after its content's epoch arrives as `realtime`; first traversals and pre-epoch items
stay `backfill` (H6-C1 rule), so forward-only automation is never fed history.

---

## 10. Change and removal signal paths (H6-E integration)

- `edited`, `hide`, `unhide` of a **canonical** interaction → `ingestion.confirm_interaction` (stored re-read applies
  text versions and visibility through the one canonical path). Of a non-canonical interaction → relist mark.
- `remove` of a canonical interaction → **urgent confirmation, never a tombstone.** On Meta the stored re-read's
  not-found (100/33) stays `unconfirmed` → `PROVIDER_CONTRACT_AMBIGUOUS` → no change. The signal raises urgency only;
  two ambiguous indications are not authority. Non-canonical target → recorded, nothing requested.
- Coalescing: confirmation requests from signals use dispatch key
  `ingestion.confirm_interaction:{interaction}:{5-minute bucket}` (an optional coalescing key on the H6-E producer;
  existing callers keep their per-request key; nothing else in H6-E changes).
- Instagram: no edit/remove webhooks are assumed (VALIDATE). An IG reply hint is never confirmed or relisted.

---

## 11. Removal authority (frozen)

H6-F never produces `explicit_provider_signal` and never writes `removed_at_source`. The domain vocabulary admits "a
verified webhook removal" as a basis; using it would require a separate validation gate proving Meta's `remove` verb
semantics and an explicit TL decision. A guard pins that no webhook code names the basis.

---

## 12. Event classification matrix

R = recognized · I = enough identifiers to route · C = targeted confirmation · L = content relist · A = account
reconciliation · S = stored only · X = ignored after metrics.

| Class (Meta) | R | I | C | L | A | S | X |
|---|---|---|---|---|---|---|---|
| FB comment created | ✓ | ✓ | – | ✓ (canonical content) | ✓ (unknown content) | ✓ | – |
| FB reply created | ✓ | ✓ | – | ✓ | ✓ (unknown content) | ✓ | – |
| FB comment/reply edited | ✓ | ✓ | ✓ canonical | ✓ non-canonical | – | ✓ | – |
| FB comment/reply hidden / unhidden | ✓ | ✓ | ✓ canonical | ✓ non-canonical | – | ✓ | – |
| FB comment/reply removed | ✓ | ✓ | ✓ canonical (urgent; never tombstone) | – | – | ✓ | non-canonical |
| FB content created | ✓ | ✓ | – | – | ✓ | ✓ | – |
| FB content edited / removed | ✓ | ✓ | – | – | – | ✓ | ✓ (no content-state model in H6) |
| IG comment created | ✓ | ✓ | – | ✓ canonical content | ✓ unknown content | ✓ | – |
| IG reply (any) | ✓ | ✓ | – | – | – | ✓ | ✓ `SKIPPED_CAPABILITY` (`REPLIES_NOT_READ`) |
| Account / subscription change (deauthorize, permissions) | – | – | – | – | – | – | H6-G |
| Unknown / unsupported field or item | – | – | – | – | – | metadata only | ✓ |

---

## 13. Coalescing (frozen; budget and cap per D-F5 = B)

Tenant table `ingestion.signal_marks`: one **PENDING** mark per (account, kind ∈ {relist, account}, content item or
null), with `first_signal_at`, `last_signal_at`, `signal_count`.

1. A signal upserts its mark (count + last time). 30 signals for one post = one mark.
2. No open run → request one run (system initiator, plan from the marks). An open run → nothing (the mark waits).
3. A content slice that reaches the provider's end of pages, in a run started at `S`, **satisfies** (deletes) the marks
   of that content whose `last_signal_at + 120 s ≤ S` (skew margin). Later signals keep the mark PENDING.
4. **Close hook** (same transaction as the run's close): PENDING marks left → request exactly one follow-up run.
5. Caps (frozen): ≤ 1 open run per account (0018); ≤ **6** signal-requested runs per hour per connected account
   (`SIGNAL_RUNS_PER_ACCOUNT_PER_HOUR`), each with `max_operations = 10` (§9). At the cap, additional signals keep
   coalescing into their pending/deferred marks — never discarded — and the router's due-mark sweep (definer returning
   IDs only) re-dispatches `ingestion.process_signals` once capacity is available; the future scheduler may also resume
   this work. There is no provider-call-per-webhook model.
6. Marks expire after 7 days (`signal.mark_expired`); coverage is untouched, so the gap stays truthful.

No signal is silently lost: it is a durable mark until a traversal that started after it reads its content, or it
expires visibly. Provider amplification is bounded by runs, never by webhook count.

---

## 14. Failure and retry model

| Stage | States | Retry | Terminal |
|---|---|---|---|
| HTTP | `ACCEPTED` · `DUPLICATE` · rejected (never stored) | DB failure → `503` (Meta retries) | bad signature `401`, malformed `400`, too large `413` |
| Inbox row | `RECEIVED` → `ROUTED` / `UNSUPPORTED` | — | — |
| Hint | `PENDING` → `ROUTED` · `RETRYABLE` (no mapping yet) · `UNMAPPED` · `MULTI_ORG_LIMIT` (> 5 ACTIVE matches, D-F2) · `UNSUPPORTED` · `STALE` | router task: transient policy; mapping: 3 attempts | `UNMAPPED` after attempts; `MULTI_ORG_LIMIT` immediately (alert) |
| Processing (per tenant) | `PLANNED_RELIST` · `PLANNED_ACCOUNT` · `PLANNED_CONFIRMATION` · `ABSORBED` · `DEFERRED` · `SKIPPED_{ACCOUNT_INACTIVE, PAUSED, CAPABILITY, CONTENT_NOT_CANONICAL, NON_CANONICAL_REMOVAL}` | task transient policy (DB, relay) | every `SKIPPED_*` |
| Mark | `PENDING` → satisfied (deleted) / expired | close hook, due-mark sweep | expiry (7 d) |

The prompt's vocabulary maps as RECEIVED, ROUTED, DUPLICATE, UNSUPPORTED, UNMAPPED, ENQUEUED (= PLANNED_*),
COMPLETED (mark satisfied), RETRYABLE_FAILURE, TERMINAL_FAILURE. HTTP success is independent of processing success.
Invalid signatures are never retried by Wrenkind. Processing outcomes live in logs/metrics and mark state; a
workspace job never updates the system hint table.

---

## 15. Proposed task topology (after H6-F: MAIN 8 → 11, INTEGRATION 7 unchanged)

| Task | Plane | Scope | Payload | Why |
|---|---|---|---|---|
| `ingestion.route_provider_events` | MAIN | system | none (drains) | mapping + fan-out; cron every minute + post-commit nudge |
| `ingestion.process_signals` | MAIN | workspace | `connected_account_id`, `provider_event_hint_id` | tenant-side classification, marks, run/confirmation requests |
| `ingestion.purge_provider_events` | MAIN | system | none | 7-day retention |
| `ingestion.reconcile_account` / `reconcile_slice` / `confirm_interaction` | existing | — | unchanged | relist plan + close hook; coalescing key |

`ingestion.process_signals` is an internal topic: a **new** RESTRICTIVE member policy in 0022 (0021 is pinned
forward-only; its guard becomes "the union of restrictive member policies covers every internal topic").

---

## 16. Proposed migration 0022 (for a future gate; not authored)

- `system.provider_event_inbox` (system class): `id`, `provider` ('meta'), `object` ('page' · 'instagram'),
  `body_sha256` (hex, **unique**), `body` bytea null (≤ 1 MiB; null when a field is outside the allowlist), `body_bytes`,
  `hint_count`, `ignored_count`, `stale_count`, `state` ('RECEIVED' · 'ROUTED' · 'UNSUPPORTED'), `received_at`
  (`statement_timestamp()`, never the caller's), `routed_at`, `expires_at` (= received + 7 d). Index `(expires_at)`,
  partial `(received_at) where state = 'RECEIVED'`.
- `system.provider_event_hints` (system class): `id`, `inbox_id` → inbox (cascade), `ordinal`, `platform`,
  `provider_asset_id`, `field`, `item`, `change`, `target_kind`, `provider_target_id`, `provider_content_id`,
  `provider_parent_id`, `occurred_at`, `hint_key` (hex, **unique**), `state`, `route_attempts`, `next_route_at`,
  `mapped_count`, `received_at`, `expires_at`. Provider ids `^[0-9A-Za-z_.:-]{1,128}$`. No author id, no text. Partial
  index `(next_route_at) where state in ('PENDING','RETRYABLE')`.
- `ingestion.signal_marks` (tenant, forced RLS, composite workspace FKs to account and content item): `id`,
  `organization_id`, `workspace_id`, `connected_account_id`, `kind` ('relist' · 'account'), `content_item_id` null,
  `first_signal_at`, `last_signal_at`, `signal_count`, `requested_run_id` null, `expires_at`; unique nulls not
  distinct `(workspace_id, connected_account_id, kind, content_item_id)`.
- `ingestion.reconciliation_runs.plan text not null default 'account' check (plan in ('account','relist'))` (expand).
- Definers (empty `search_path`, owner `app_owner`): `system.record_provider_webhook` (EXECUTE `authenticated`; refuses
  claims/workspace), `ingestion.route_provider_hint` and `ingestion.due_signal_accounts` (EXECUTE `app_system`),
  `ingestion.provider_event_hint` (EXECUTE `app_worker`), `system.purge_provider_events` (EXECUTE `app_system`).
- Policies: inbox/hints — owner policies for the definers, `app_system` SELECT/UPDATE of routing columns; **no**
  `authenticated`, `app_worker` or `anon` grant. Marks — worker bound-workspace policies; no member access (a future
  health UI reads a derived, authorized query). Outbox — owner policy for the router definer's `ingestion.process_signals`
  rows; new RESTRICTIVE member policy for that topic.
- Classification, introspection and grant tests; T-26 unchanged.

### 16.1 As authored in H6-F2 (authoritative; supersedes the proposal above where they differ)

`db/migrations/0022_provider_webhook_signals.sql`, SHA-256
`556b4b2a052cf842b9add89690a03a11789654c54c8b5cae8793612e4aef6b1f` — **source only, not applied** (dev-v2 stays at
ledger 21 until H6-F2b).

- **Tables.** `system.provider_event_inbox` (unique `body_sha256`; `body` bytea ≤ 1 MiB, only when
  `raw_body_retainable`, and verified against its hash; counts; `state` RECEIVED · ROUTED · NO_HINTS; `received_at` is
  DB time). `system.provider_event_hints` (unique `hint_key`; the H6-F1 hint identifiers — `platform`,
  `provider_asset_id`, `target_kind`, `provider_target_id`, `provider_content_id`, `provider_parent_id`, `change`,
  `occurred_at`; the F0 `field`/`item` columns are not persisted because the F1 hint does not carry them — they are
  inside the hint key; `state` PENDING · RETRYABLE · ROUTED · UNMAPPED · MULTI_ORG_LIMIT; `route_attempts` ≤ 4,
  `routed_count` 1..5). `ingestion.signal_marks` (tenant; `kind` relist · account; relist ⇔ content; ownership by the
  composite FK to `content.content_items (workspace_id, id, connected_account_id)`; one row per (account, kind,
  content-or-null) — a row exists only while pending; `deferred_until` + `dispatch_generation` for the D-F5 cap).
  `ingestion.reconciliation_runs.plan` ('account' default, 'relist'; closed CHECK; no UPDATE grant).
- **Definers (five, unchanged in number).** The system-run ones live in the `system` schema — the only schema
  `app_system` holds USAGE on — so F0's `ingestion.route_provider_hint` / `ingestion.due_signal_accounts` became
  `system.route_provider_hint` / `system.dispatch_due_signal_marks` (the latter WRITES the account-only outbox rows
  itself: app_system has no outbox INSERT, so "returning IDs only" could not dispatch). `system.record_provider_webhook`
  (web login, no claims, no workspace), `ingestion.provider_event_hint` (bound worker), `system.purge_provider_events`
  (system; cutoff = DB time − 7 days; batch ≤ 5000).
- **Request boundary (TL decision H6-F2).** `ingestion.request_reconciliation` is replaced with the SAME signature: the
  worker's budget JSON may carry `plan` (account | relist); the web branch is unchanged (no budget → account, 40). Still
  the one creation path of a run; a guard pins that the body equals 0019's except for the plan handling.
- **Routing rows.** `ingestion.process_signals` subjects: `{connected_account_id, provider_event_hint_id}` for a routed
  hint (dispatch key `ingestion.process_signals:{hint}:{account}`), `{connected_account_id}` for a due mark
  (`ingestion.process_signals:mark:{mark}:{generation}`). Admitted only by the owner policy `owner_signal_dispatch`
  (a system login, no workspace, an ACTIVE matching account); blocked for members and workers by the RESTRICTIVE
  `no_direct_signal_routing` (0021 untouched; the union of restrictive policies is the inventory). No `ON CONFLICT` on
  the outbox: under RLS it would require a SELECT policy app_owner deliberately lacks; uniqueness comes from the locked
  hint / mark instead.
- **Cross-workspace owner reads** (`owner_signal_route_read` on accounts, `owner_due_read`/`owner_due_update` on marks)
  require a session login that is a member of `app_system` and no bound workspace: no web or worker transaction can
  satisfy them.

---

## 17. Capability, coverage, scheduler, audit

- **Capability:** processing runs the same gate as reconciliation (account, connection, pause, profile, capability at
  the content scope) plus the interaction-kind check. A webhook never upgrades capability; an IG reply signal is
  `SKIPPED_CAPABILITY` and never implies reply coverage.
- **Coverage:** a receipt, hint, mark or routing step never writes coverage, never advances `synced_through`, never
  validates history depth and never turns UNKNOWN into COMPLETE. Only the relist/account slices do, exactly as today.
- **Scheduler (future gate):** webhooks = low-latency signal; scheduler = eventual-consistency safety net (it will also
  drain stale marks); manual Sync = operator recovery. None replaces another; H6-F builds no scheduler.
- **Audit:** none per webhook (no audit flooding). Receipts are operational metadata. Audit belongs to subscription
  lifecycle and operator actions (H6-G).

---

## 18. Observability (identifiers and enums only)

Counters: `webhook.accepted`, `webhook.duplicate_delivery`, `webhook.rejected{missing_signature|invalid_signature|malformed_payload|too_large|unsupported_type}`,
`webhook.hints{class}`, `webhook.hints.duplicate`, `webhook.entries.ignored`, `webhook.entries.stale`,
`hint.routed`, `hint.unmapped`, `hint.route_retry`, `hint.multi_org_fanout{count}`, `hint.multi_org_limit` (alerting), `signal.{planned_relist|planned_account|planned_confirmation|absorbed|deferred|skipped_*}`,
`signal.content_not_canonical`, `signal.runs_capped`, `signal.mark_expired`, `purge.rows`. Gauges: pending marks,
oldest pending mark age, oldest inbox body age (alarm > 7 d), RECEIVED backlog. Lags: received → routed → planned →
run started → mark satisfied.

## 19. Abuse controls

Signature before JSON parsing; 1 MiB and 1000-change caps; delivery and hint dedupe; unmapped hints terminal after 3
attempts and purged at 7 days; router batches bounded (500 hints/run); processing is DB-only; provider work only through
marks and runs (≤ 1 open run per account, 6 signal runs per hour, 10-operation signal budget; manual Sync alone keeps
40). Edge rate limit on `/api/webhooks/*` (TA
§38.8; Vercel firewall rule, VALIDATE). The endpoint can never become a provider-call amplifier: no request path calls
a provider.

---

## 20. Simulator acceptance plan (future gate)

1 valid FB comment signal → relist → canonical · 2 duplicate delivery · 3 reply before comment · 4 edit burst → one
confirmation per bucket · 5 removal signal → confirmation, Meta-shaped not-found → no change · 6 invalid signature ·
7 malformed payload · 8 unknown account → retries → UNMAPPED · 9 disconnected account · 10 provider pause · 11 stale
profile · 12 IG reply signal → SKIPPED_CAPABILITY, no coverage · 13 burst of N for one content → one mark, ≤ 2 runs ·
14 signal during an open run → follow-up via close hook · 15 signal after the run started → mark survives satisfaction ·
16 processing crash + retry · 17 relay duplicate · 18 account moved between routing and processing · 19 workspace
isolation (other workspace's hint never visible) · 20 retention purge · 21 no webhook text becomes canonical without a
re-read · 22 no coverage change from receipt alone · 23 no provider call from WEB or MAIN · 24 IDs-only payloads ·
25 zero `unknown_task` · 26 comment on content older than the account run's listing → relist reads it · 27 multi-org
asset (D-F2) · 28 non-allowlisted field → body not stored · 29 router nudge lost → cron routes · 30 member transaction
cannot record a receipt; member SQL cannot append `ingestion.process_signals` · 31 handshake wrong token · 32 body
over cap (declared and chunked) · 33 stale entry time · 34 hourly cap (6) → deferred → due-mark sweep · 35 mark expiry ·
36 same asset ACTIVE in 6 organizations → `MULTI_ORG_LIMIT`, zero tenant processing, alert (D-F2) · 37 signal run
exhausts its 10 operations → `ABANDONED_BUDGET`, coverage `UNKNOWN / TRAVERSAL_INCOMPLETE`, mark still pending, follow-up
run completes it (D-F5) · 38 disallowed field (`messages`) with an allowed `feed` change → no raw body, allowed hint
persisted (D-F4) · 39 manual Sync during signal traffic keeps `max_operations = 40` (D-F5).

## 21. LIVE acceptance plan (future; needs H6-G)

1. Meta app dashboard: callback URL + verify token for the Dev app → handshake LIVE.
2. Dashboard "Test" deliveries (synthetic page ids): signature, receipt, `UNMAPPED` path; zero provider calls.
3. After subscription (H6-G): one real comment on a controlled post → receipt → mapping → relist → canonical comment.
4. Duplicate delivery only if Meta retries naturally; never by replaying a body (re-signing would be forging).
No destructive social action is required.

## 22. Subscription lifecycle → H6-G

Subscribing Pages (`subscribed_apps`, fields `feed`), Instagram subscription, the extra permission this likely needs
(`pages_manage_metadata`, VALIDATE), refresh/reconcile of subscriptions, unsubscribe on unlink/remove, app-level
webhook configuration per environment, and the `manage_webhooks` capability entry. INTEGRATION tasks (credentials);
not platform mutations of social content, so not the Platform Mutation Executor.

## 23. Implementation sequence (frozen in H6-F0C)

1. **H6-F1** — webhook contract additions; pure Meta signature verification; handshake verification primitive; bounded
   raw-body parser; Meta envelope → IDs-only hints; fixtures and tests only. No database, runtime or web route.
2. **H6-F2** — migration 0022: inbox, hints, marks; RLS, definers, policies (incl. the restrictive member policy for
   `ingestion.process_signals`); `reconciliation_runs.plan`; DB suites.
3. **H6-F2b** — apply 0022 to dev-v2.
4. **H6-F3** — HTTP receiver, provider signal scope, proxy exception, router and purge tasks.
5. **H6-F4** — tenant processing, marks, targeted relist, close hook, coalescing, budget and cap enforcement.
6. **H6-F5** — release/deploy sequencing (paired Trigger release MAIN 11 / INTEGRATION 7, then web).
7. **H6-G** — Meta webhook configuration, subscription lifecycle, LIVE acceptance.

None of these starts before its own gate.

## 24. TL decisions (frozen in H6-F0C)

| # | Decision | Frozen as |
|---|---|---|
| **D-F1 = A** | Router dispatch | Durable inbox + MAIN nudge + cron (§3): `system.provider_event_inbox` is the durable queue of this system-scoped workflow; the tenant outbox relay is not extended; the receiver never waits for routing or re-reads. |
| **D-F2 = A with no partial fan-out above cap** | Same asset ACTIVE in several organizations | 1..5 matches → fan out to all, each tenant re-deriving its own authority; > 5 → `MULTI_ORG_LIMIT`: no tenant processing, receipt/hint visible within retention, metric + alert, fail closed; query ordering never selects tenants (§7, cases 27/36). |
| **D-F3 = A** | New-interaction path | Targeted `webhook_relist` plan over canonical content (§9); bounded account-reconciliation fallback for non-canonical content; webhook text never trusted; no content row fabricated. |
| **D-F4 = A** | Raw body | Verified byte-exact body ≤ 1 MiB, ≤ 7 days, inbox only, no index, no member SELECT, no copies; no raw body when any field is outside the allowlist — metadata plus independently whitelisted hints only (§5, case 38). |
| **D-F5 = B** | Signal budget | Signal-initiated runs: `max_operations = 10`, ≤ 6 runs/hour/connected account; manual/operator Sync unchanged at 40; exhaustion keeps coverage honest and marks pending, follow-up completes later; at the cap marks coalesce and defer, never discarded (§9, §13, cases 34/37/39). Revisit 10 only from LIVE evidence. |

Everything else in this document stays as designed in F0.

## 25. H6-F3 as implemented (authoritative; source only, not released)

**Route.** `app/api/webhooks/meta/route.ts` (`/api/webhooks/meta`, Node runtime, `force-dynamic`), Meta-only, thin:
it delegates to `server/webhooks/meta-receiver.ts`, composed by `server/webhooks/runtime.ts`. No generic provider route.

**GET (handshake).** `searchParams.getAll` feeds the H6-F1 primitive, so a repeated parameter stays ambiguous:

| Case | Status |
|---|---|
| subscribe + correct token | 200 `text/plain`, body = the challenge only |
| wrong mode, missing or wrong token | 403, empty |
| missing, duplicated or malformed parameter or challenge | 400, empty |
| receiver not configured or configuration invalid | 503, empty |

**POST (delivery).** Strict order, each step failing closed:
1. Not configured → 503.
2. Content type other than `application/json` → 415.
3. Declared length invalid or above 1 MiB → 413, body never read.
4. Bounded stream read, cancelled above 1 MiB → 413.
5. H6-F1 `parseWebhook` over the exact bytes, with only `x-hub-signature-256` passed: signature failures → 401,
   `body_too_large` → 413, any other envelope rejection → 400.
6. One provider-signal transaction calling `system.record_provider_webhook`; any failure → 503, so Meta retries.
7. 200 with an empty body. Only for `recorded` with new hints > 0, `after()` sends a best-effort nudge whose failure
   is logged and swallowed. A duplicate or a zero-new-hint receipt never nudges.

Every response carries `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, and no reason detail.
The receiver never calls `request.json()`, never decodes or re-serializes the body, and reads no cookie or session.

**Provider-signal scope.** `withProviderSignalScope` in `platform/db/scopes.ts`: the web login only (`assertKind`),
then `set local role authenticated` (a fixed literal), with no claims and no workspace binding. Its only user is
`server/webhooks/runtime.ts`. Under it only the receipt definer works: no tenant row is visible, the inbox and hints
are unreadable, and routing, purge, mark dispatch and `request_reconciliation` are refused (DB suite).

**Receipt adapter.** `recordProviderWebhook` in `modules/ingestion/persistence/provider-events-store.ts` maps the
H6-F1 hints to the 0022 shape (`hint_key` = `eventId`). It passes the bytes only when the adapter's
`rawBodyRetainable` is true (D-F4, never re-decided), and validates the definer output against the closed vocabulary.

**Configuration boundary.** `server/webhooks/meta-config.ts` reads the App Secret through the existing web Meta app
configuration plus the new web-only `PROVIDER_META_WEBHOOK_VERIFY_TOKEN` (printable ASCII, 16–256 characters). If
either is missing the receiver is unavailable (503), with no bypass. An invalid token raises an error naming the
variable only. Both jobs planes refuse the variable (`jobs/plane-environment.ts`); `.env.example` names it with no value.

**Proxy.** `SESSIONLESS_PATHS = ["/api/webhooks/meta"]`, exact match only, checked after the forbidden-environment
refusal. Every other path, including the OAuth callback and look-alike paths, keeps the session refresh.

**MAIN tasks** (`jobs/trigger/main/provider-events.ts`, literal ids, `SYSTEM_DELIVERY_QUEUE`, both in `SYSTEM_TASKS`):

| Task | Cron | Retry | Bound |
|---|---|---|---|
| `ingestion.route_provider_events` | `* * * * *` | transient | ≤ 500 due hints per run, one system transaction per hint |
| `ingestion.purge_provider_events` | `*/15 * * * *` | single attempt | batches of 1 000, ≤ 5 per run (≤ 5 000) |

Both run through `runSystemJob` with a payload built in the task (`schedulePayload`); the vendor payload, whether from
the schedule or the nudge, is ignored. Overlapping router runs serialize on the definer's row lock, so a hint is routed
once (DB suite: two concurrent runs over 20 hints give 20 rows). Outcomes are tallied over the closed vocabulary:
routed, retry, unmapped, multi_org_limit, not_due, not_pending, not_found. A `multi_org_limit` count raises an
error-level `webhook.route.multi_org_limit_alert`. Logs carry event names and counts only.

**Nudge.** The web enqueues the router task with a system payload and dispatch key
`ingestion.route_provider_events:<receipt id>` through the existing web job runtime.

**Topology after F3 (source).** MAIN 10, INTEGRATION 7. `ingestion.process_signals` is NOT registered (H6-F4).

**Release-order hazard.** Routing writes `ingestion.process_signals` outbox rows. Their consumer arrives in H6-F4, so
F3 must never be released without F4: a routed row would otherwise fail as `unknown_task`. H6-F5 releases them
together (MAIN 11).

**VALIDATE before release (not resolved here):**
- The web `TRIGGER_SECRET_KEY` scope must allow triggering `ingestion.route_provider_events`. It is documented as
  restricted to `outbox.relay`. If it isn't widened, the nudge fails silently and the cron still drains.
- Triggering a `schedules.task` by id from the SDK (the nudge) must be confirmed on the deployed Trigger version.
- Edge or WAF rate limiting on the public route stays VALIDATE (§19).
- The H6-F1 VALIDATE items are untouched.

## 26. H6-F4 as implemented (authoritative; source only, not released)

**Task.** `ingestion.process_signals` is a MAIN tenant task (workspace scope, lane 2, serial per connected account,
transient retry). It runs in ONE workspace-scoped transaction and does database planning only. It never opens a
credential, calls a provider, reads a raw body or appends its own topic. Its producers stay the two 0022 system
definers. `no_direct_signal_routing` is unchanged, and members and workers are still refused (DB suite).

Accepted payload subjects, exactly one shape:

| Shape | Subjects |
|---|---|
| Routed hint | `connected_account_id`, `provider_event_hint_id` |
| Due mark | `connected_account_id` |

Anything else is a non-retryable `invalid_payload`. The workspace is the outbox row's, never a subject.

**Source topology.** MAIN 11, INTEGRATION 7. The release tool expects MAIN 11.

**Outcome vocabulary (closed).**
- Planned: `PLANNED_RELIST`, `PLANNED_ACCOUNT`, `PLANNED_CONFIRMATION`.
- Waiting: `ABSORBED`, `DEFERRED`.
- Skipped: `SKIPPED_ACCOUNT_INACTIVE`, `SKIPPED_HINT_UNAVAILABLE` (the hint is not routed, purged, or the account's
  asset changed), `SKIPPED_PAUSED`, `SKIPPED_CAPABILITY`, `SKIPPED_CONTENT_NOT_CANONICAL`,
  `SKIPPED_NON_CANONICAL_REMOVAL`, `SKIPPED_UNSUPPORTED`.
- Housekeeping: `EXPIRED`, `NO_PENDING_MARKS`.

`PLANNED_*` also covers a run scheduled for the skew boundary (see the review rule below). Logs carry
`signal.<outcome>`, `signal.mark_expired`, `signal.content_not_canonical` and `signal.due_marks_dispatched`, as counts
only.

**Routed-hint path.**
1. `ingestion.provider_event_hint` returns the hint's identifiers only if it is ROUTED and its (platform, asset) is the
   bound workspace's ACTIVE account.
2. Expired marks are deleted.
3. Canonical lookups use the workspace, platform and provider id. Ownership must be THIS account's; a content or
   interaction of another account fails closed.
4. The gate is re-checked for the exact scope: the canonical content's kind and source, else post/unknown; for a
   content target, `read_content` plus `read_interactions`. This uses `ignorePause`, because a pause must retain the
   signal, not drop it.
5. The §12 matrix is applied over canonical state (`classifySignal`):
   - an Instagram reply (`REPLIES_NOT_READ`) gives `SKIPPED_CAPABILITY`;
   - a created interaction on canonical content gives a relist mark; on unknown content, an account mark plus
     `signal.content_not_canonical`;
   - an edit, hide, unhide or update of a canonical interaction gives a confirmation; of a non-canonical interaction on
     canonical content, a relist mark; otherwise `SKIPPED_CONTENT_NOT_CANONICAL`;
   - a removal of a canonical interaction gives an urgent confirmation, never a tombstone; of a non-canonical one,
     `SKIPPED_NON_CANONICAL_REMOVAL`;
   - a created content gives an account mark; any other content change gives `SKIPPED_UNSUPPORTED`.
6. Pause: the mark is upserted and revisited in 15 minutes (`SKIPPED_PAUSED`). A paused confirmation becomes a relist
   mark of its canonical content, because marks are the only durable deferral.

**Confirmation key (deviation from §10).** A signal confirmation uses the H6-E producer with dispatch key
`ingestion.confirm_interaction:{interaction}:h{routed hint id}`. That is one confirmation per verified change hint,
canonical ids only, and idempotent under redelivery. The §10 bucket key was not adopted:
- A worker cannot see whether the bucket's confirmation already ran, because it has no outbox read.
- A change arriving after that read would therefore be coalesced into a finished read and lost.
- A relist cannot backstop it: relist windows are by creation time and never re-read an older comment.

Bound: one direct read per distinct verified change hint. Provider retries already collapse on `hint_key`.

**Mark persistence** (`modules/ingestion/persistence/signal-store.ts`, worker grants only):
- The upsert is `on conflict on constraint signal_marks_one_pending`. It adds 1 to the count, takes the greatest last
  signal, and keeps the first signal and the expiry (first signal + 7 days).
- The other operations are: summary; relist candidates (last signal ≤ boundary, oldest first, bounded); defer-all;
  link-run; satisfy-relist; satisfy-account; delete-expired; drop; signal-run count.
- The signal time is the processing time (always ≥ receipt ≥ event), which errs toward later satisfaction.
- `created_at` and `updated_at` are database time, like the 0022 dispatcher's own update. With application time, an
  app clock ahead of the database would trip `updated_at >= created_at` and fail the whole dispatch batch.
- Revisit, signal and expiry times are application time. The 0022 dispatcher compares the revisit with database time,
  so clock skew only shifts a revisit.

**Shared review** (`reviewSignalMarks`), used by the routed-hint path, the due-mark path and the close hook:
1. Delete expired marks (`signal.mark_expired`; coverage, watermarks and canonical rows untouched). If none are left,
   the outcome is `EXPIRED` or `NO_PENDING_MARKS`.
2. An open run gives `ABSORBED` with a 15-minute revisit. The close hook is the primary revisit.
3. The account gate at post/unknown (`read_interactions`, plus `read_content` when an account mark is pending):
   - paused: 15-minute revisit, `SKIPPED_PAUSED`;
   - account inactive, missing or connection removed: drop the marks, `SKIPPED_ACCOUNT_INACTIVE`;
   - any other refusal: hourly revisit, `SKIPPED_CAPABILITY`.
4. Hourly cap: six signal runs in the rolling hour defer every mark until the oldest leaves the window, plus 1 s
   (`DEFERRED`).
5. Priority: a pending account mark gives an `account` run; otherwise a `relist` run.
6. Skew: if the lead mark's last signal + 120 s is later than now, every mark is deferred to that instant + 1 s. This is
   scheduled, not requested, so no run is spent that could not satisfy anything.
7. Otherwise, exactly one run is requested through `ingestion.request_reconciliation` (worker branch):
   - plan account or relist, `max_operations` 10;
   - content items 10 for relist and 9 for account (one listing page plus one page for each of 9 contents fits 10
     operations, so an account mark can be satisfied);
   - correlation `sig.{lead mark id}`.

   `already_running` gives `ABSORBED`. `not_found` drops the marks (`SKIPPED_ACCOUNT_INACTIVE`).
8. `requested_run_id` is set on the lead account mark, or on the relist candidates. It is traceability only.

Invariant: every pending mark is either covered by an open run or carries a revisit time.

**Signal-run attribution and the cap.** A signal run is `initiator_type = 'system'` with `correlation_id LIKE 'sig.%'`,
counted by `requested_at` in the rolling hour per connected account. Manual and operator Sync never match:
- web Sync is `user`-initiated;
- the job runtime's own requests use other correlations.

Exactness comes from the one-open-run index: two concurrent reviews cannot both create a run. A guard pins that
`sig.` is produced only by `signalRunCorrelation` in the review.

**Relist planner** (`planReconciliation`, `run.plan = relist`):
- It creates no listing slice.
- It selects the pending relist marks the run can satisfy (last signal ≤ start − 120 s), oldest first, at most
  `min(contentItems, 10)`.
- Each mark is re-validated: the content exists, belongs to the run's account (beside the composite FK), and its exact
  scope is readable now. A content-level failure drops the mark; an account-level failure stops planning.
- Each kept mark gets one `content_interactions` slice. Its window runs from the watermark's synced-through minus the
  overlap (else the floor) to the run start, exactly like an account run. Pages, continuations, cursors, budget,
  coverage and conversation semantics are unchanged.
- No slice means the run closes COMPLETED at once (`completed_empty`).
- The account plan is unchanged.

**Provenance and arrival.** Facts from a relist run carry mechanism `webhook_relist` (`listInteractions` · `listed`).
Arrival is `relistArrival`: `backfill` on the content's first traversal or when created before the epoch, otherwise
`realtime`, decided by provider creation time and never by webhook time. Account runs keep `reconciliation`. Coverage
and watermarks are written only by traversal, through the existing code.

**Satisfaction and the close hook.** Every run closes through `closeRun` (a guard pins exactly one `finishRun` call).
The close hook runs in the same transaction, right after a successful finish:
- **Relist marks.** Delete the marks of every content with a COMPLETED `content_interactions` slice in this run (the
  provider's end of pages was reached) whose last signal ≤ `started_at` − 120 s.
- **Account mark.** Delete it only when an account-plan run finished COMPLETED (listing and every content slice) under
  the same boundary. A relist run never satisfies discovery. A run that never started satisfies nothing.
- **Then the shared review.** At most one follow-up run, or a revisit time.

Budget exhaustion (`ABANDONED_BUDGET`, run PARTIAL) satisfies nothing. Coverage stays `UNKNOWN / TRAVERSAL_INCOMPLETE`,
and follow-ups continue under the cap.

**Due marks.** The MAIN router task now also calls `system.dispatch_due_signal_marks(100)` on every run (cron every
minute). Each due mark gets an account-only `ingestion.process_signals` row (generation + 1). The tenant task re-reads
the account's marks; it does not need a hint. Duplicate dispatches converge: the first requests, the rest are ABSORBED.

**Crash safety.** Each process_signals run is one transaction (mark upsert, review, request, link), so a crash leaves
nothing. The close hook shares the run's closing transaction. Uniqueness is database authority: the
pending-mark constraint, the one-open-run index and the outbox dispatch keys.

**Known bounded behaviors (not resolved here).**
- A content whose overlap window needs more than 10 operations cannot complete within a signal run, because the window
  restarts from synced-through − 24 h each run. Its mark is retried up to six times an hour until a manual Sync (40
  operations) completes it or the mark expires. This is D-F5 = B as frozen; revisit only from LIVE evidence.
- When an account turns inactive, the 0022 dispatcher clears its due marks without dispatching them. Those marks stay
  inert: no work, no coverage, no canonical change. They are deleted only by a later review of that account (for
  example after reactivation); their 7-day expiry is enforced on review, not by a sweep. No persistence primitive
  sweeps another workspace's marks (worker-only DELETE).

**Release.** F3 and F4 ship together (H6-F5): the router's rows now have their consumer (MAIN 11 / INTEGRATION 7).

## 27. H6-F4b — migration 0023 (persistence only; authored, NOT applied; no runtime uses it yet)

`db/migrations/0023_resumable_signal_progress.sql` supplies the persistence that H6-F4a proved missing. TL decisions:
D-F4B-1 … D-F4B-6. Runtime behavior is unchanged until H6-F4d.

**A. Parked reconciliation cursor (one mechanism for every plan: account / manual Sync and relist).**
- Adds `reconciliation_slices.cursor_parked_at` (timestamptz).
- `reconciliation_slices_cursor_open` gets a pinned rewrite: a cursor is allowed in PENDING, RUNNING and ABANDONED_BUDGET
  only. COMPLETED, CONTINUED and every FAILED_* state still hold none.
- `reconciliation_slices_parked`: parked ⇔ ABANDONED_BUDGET with a cursor, `content_interactions` units only.
- Partial unique index `reconciliation_slices_one_parked (workspace_id, connected_account_id, content_item_id)
  WHERE state = 'ABANDONED_BUDGET' AND cursor IS NOT NULL`. It is the single continuation authority and also the
  bounded lookup.
- Trigger `reconciliation_slice_park_cursor` stamps `cursor_parked_at` from database time at the abandonment, so the
  application never supplies it. A parked cursor can only be retired (set to NULL), never replaced or parked afresh.
- A continuation adopts the parked slice's own window (`window_start`, `window_end`), never a later run's start.
- The cursor never leaves its slice row; a guard pins that marks, the outbox and payloads never name one.
- `cursor_issued_at` (application time of the last page read) is kept as is. The DB-authoritative parking time is
  the new column.

`PARKED_CURSOR_LOCAL_TTL = 90 minutes` from `cursor_parked_at` is Wrenkind's local maximum willingness to reuse a
cursor. It is not `META_CURSOR_TTL`: Meta's cursor lifetime stays VALIDATE (H6-G). The planner enforces it; there is
no wall-clock CHECK. On `invalid_cursor` the cursor is retired and the existing single safe restart applies, with no
coverage or watermark claim.

**B. Confirmation marks.** `signal_marks.kind` widens to relist, account and confirm. A confirm mark names a canonical
`interaction_id` together with its `content_item_id`:
- FK `signal_marks_confirm_interaction (workspace_id, interaction_id, content_item_id)` → `interactions.interactions`
  unique `(workspace_id, id, content_item_id)`;
- plus the existing content FK `(workspace_id, content_item_id, connected_account_id)`.

Together they prove workspace, account, content and interaction, and they refuse a cross-account or cross-workspace
target. Pinned rewrites:
- `signal_marks_target`, the closed shape: account has no target, relist has content only, confirm has content and
  interaction;
- `signal_marks_one_pending`, unique NULLS NOT DISTINCT over `(workspace_id, connected_account_id, kind,
  content_item_id, interaction_id)`. Account and relist marks keep exactly their 0022 uniqueness.

The migration lint gained a narrow pinned-UNIQUE-rewrite mechanism for that last one, with adversarial tests.

**Confirmation columns:**
- `read_started_at`: the database time at which the latest direct reread began.
- `confirmed_through_at`: the `read_started_at` of the latest successfully completed authoritative reread. A failed or
  ambiguous read never advances it; the caller decides success, and the database encodes no provider semantics.
  Meta 100/33 stays ambiguous.
- Both are monotonic, confirm marks only, with `confirmed_through_at <= read_started_at`.
- Trigger `signal_mark_confirmation_guard` makes a new mark start unclaimed and unconfirmed, and keeps the claim
  counter and both times from ever regressing.
- `dispatch_generation` is reused as the claim counter. It stays worker-immutable; only the claim definer and the
  0022 dispatcher move it.

**Definers (bound worker; owner policies `owner_confirm_read` and `owner_confirm_update`, confirm marks only):**

| Definer | Behavior |
|---|---|
| `ingestion.claim_signal_confirmation(account, interaction)` | Under the row lock: `not_found`; `expired`; `cooling_down` (with `due_at`); `caught_up` when `last_signal_at <= confirmed_through_at`, which needs no provider call and the caller deletes the mark; or `claimed`, which moves to generation + 1 and sets `deferred_until = DB now + 5 min`. Concurrent claims have one winner. |
| `ingestion.begin_signal_confirmation_read(account, interaction)` | Stamps `read_started_at` from DB time, in the confirmation's prepare transaction, before the provider read. |
| `ingestion.complete_signal_confirmation_read(account, interaction, read_started_at)` | Called only after an authoritative success. It sets `confirmed_through_at` to that read start; a value later than the recorded read start is `invalid`. |

**Confirmation cooldown (`CONFIRMATION_COOLDOWN = 5 minutes`, fixed in the claim):**
1. The first signal upserts the mark and gets an immediate claim and read.
2. Later signals only advance `last_signal_at`, which F4d writes from DB time.
3. At the next due review after the cooldown, the 0022 dispatcher emits the account-only `ingestion.process_signals`
   and the tenant task claims again:
   - caught up: delete the mark, no provider call;
   - otherwise: exactly one trailing read.

A burst therefore converges on about one immediate read plus one trailing read. Sustained changes cost at most one
read per 5 minutes per interaction. A mark is deleted only when a successful read began after its latest signal. Until
then the claim repeats every 5 minutes, so a failed read retries at most every 5 minutes, until the mark expires.

**C. System-wide expiry.** `system.expire_signal_marks(limit)`:
- system login, no workspace, DB clock, batch 1..5000 with `for update skip locked`;
- deletes every mark whose `expires_at` has passed, of any kind and whatever the account's status;
- returns counts per kind only, and touches no canonical row, coverage, watermark or provider.

Its owner DELETE policy `owner_expiry_delete` admits exactly that: a system login, no workspace, an expired row. It is
the only cross-workspace DELETE of marks; app_system holds no table grant. The new index
`signal_marks_by_expiry (expires_at, workspace_id, id)` serves the range scan. The MAIN purge task will call it
(H6-F4d). The 0022 due-mark dispatcher is unchanged and already dispatches every kind, as an account-only tenant row
with no direct confirmation.

**Clock authority (frozen):**
- **DB time** for persisted operational scheduling: `cursor_parked_at`, `read_started_at`, `confirmed_through_at`, the
  claim cooldown and the expiry cutoff. From F4d also the anchoring of `expires_at`, `deferred_until` and a confirm
  mark's `last_signal_at`.
- **Provider time** is metadata only.
- **The reconciliation run clock** (`requested_at`, `started_at`) keeps governing the hourly signal-run cap and the
  relist/account satisfaction boundary.

**Unchanged:** every restrictive outbox policy, the worker's outbox access (append only, no read), the request
boundary (account and relist plans; web Sync is account/40; signal runs 10), the existing rows (all constraints
validated), and canonical state, coverage and watermarks (0023 writes none).

**H6-F4d must still:**
- park cursors at budget abandonment in `commitSlice`/`stopRun`, adopt them in both planners (within the TTL, same
  window), retire them on `invalid_cursor` or at completion, and satisfy marks by the slice's `window_end`;
- create confirm marks from change and removal signals (DB-time `last_signal_at`) and use claim, begin and complete in
  process_signals and confirm_interaction, with dispatch key `ingestion.confirm_interaction:{interaction}:g{generation}`;
- exclude confirm marks from the account/relist review and `deferAll`;
- anchor `expires_at` and `deferred_until` to DB time;
- call `system.expire_signal_marks` from the MAIN purge task.

## 28. H6-F4d as implemented (authoritative; source only, not released)

H6-F4d wires migration 0023 into the runtime. It adds no migration (0023 is the latest), makes no provider call and
changes no topology: MAIN 11, INTEGRATION 7. The release waits for H6-F5.

### 28.1 Cross-run continuation (manual Sync, signal account runs and relist runs alike)

- **Parking.** An interactions slice abandoned for budget (`ABANDONED_BUDGET`: out of pages, continuations or run
  operations before the provider's end) keeps the provider's next cursor. `finishSlice(…, park)` retires any older
  parked cursor of the same account/content first (one parked per content, the 0023 unique index). The 0023 trigger
  stamps `cursor_parked_at` with DB time; TypeScript never writes it. `stopRun` also re-parks a continuation that was
  created but never read (its cursor is still the next unread page). Listing slices never park.
- **Adoption.** `application/traversal.ts` (`insertContentTraversal`) is the only creator of a sequence-0
  interactions slice. Both planners use it: the account plan (`planContentSlices`) and the relist plan
  (`planRelistSlices`). It reads the content's watermark and its parked continuation (row-locked), and **always
  retires** the parked cursor in that transaction, so a cursor is consumed at most once. The cursor is adopted only
  when it is:
  - locally eligible: `cursor_parked_at ≥ DB now − 90 min`, computed in SQL;
  - not superseded: no later complete traversal, i.e. the watermark's `synced_through` is before the parked
    `window_end`.

  The adopted slice carries the cursor **and the original window** (`window_start`, `window_end`). It is created first
  in the run's serial chain, so the run's first operations go to it.
- **Retirement.** On adoption; when expired (stale) or superseded, after which a fresh window starts (watermark −
  overlap → run start); at completion; and when a newer park replaces it.
- **Local TTL.** `RECONCILIATION_RUNTIME.parkedCursorLocalTtlMs = 90 min`. This is our own operational bound, **not a
  provider guarantee**: Meta's cursor lifetime stays VALIDATE. A sequence-0 slice with a cursor uses the same 90-minute
  bound on its `cursor_issued_at` at claim time; in-run continuations keep `SLICE_CURSOR_MAX_AGE_MS`.
- **Invalid cursor.** A provider that refuses an adopted cursor goes through readSlice's existing single safe restart:
  the original window from page 1, with no cursor. It is never retried blindly, and nothing is claimed complete.
- **Satisfaction.** `completedContentTraversals(runId)` returns each completed traversal with its own `window_end`.
  A relist mark is satisfied only when `last_signal_at ≤ that window_end − 120 s`. A continuation therefore never
  satisfies a signal that arrived after the original traversal began; the newer signal stays pending and gets its own
  follow-up run. A COMPLETED account run satisfies the account mark as of `min(run start, every traversal's
  window_end) − 120 s`.
- **Cap.** The hourly signal-run cap (6), the 10-operation signal budget and the run clock are unchanged.
  Continuation reduces re-reads; it never adds runs.
- **Payloads.** Cursors live only in `reconciliation_slices`. Outbox subjects stay IDs-only (pinned by guard).

### 28.2 Confirm marks (replace per-hint confirmation)

- **Creation.** A change or removal signal of a canonical interaction upserts its one confirm mark (`upsertConfirm`):
  - all times are DB time;
  - `last_signal_at = greatest(…)` and `signal_count + 1`;
  - conflict target `signal_marks_one_pending`.

  A non-canonical target is skipped as before (`SKIPPED_NON_CANONICAL_REMOVAL` / `SKIPPED_CONTENT_NOT_CANONICAL`). A
  paused provider retains the mark with a 15-minute revisit.
- **Claim + request (same transaction).** `claimAndRequest` asks `ingestion.claim_signal_confirmation`, which decides
  under the mark's row lock:
  - `claimed`: generation + 1, cooldown DB now + 5 min. The ONE H6-E confirmation of that claim is appended to the
    outbox in the same transaction. Its dispatch key is `ingestion.confirm_interaction:{mark id}:g{generation}`.
    *Deviation from §27's sketch (`{interaction}`):* the key is per **mark lifetime**, because a mark deleted after a
    caught-up read and re-created later restarts at generation 1, and an interaction-based key would collide with the
    old one and silently request nothing.
  - `cooling_down`: nothing; the signal has coalesced into the mark.
  - `caught_up` / `expired`: the mark is deleted, with no provider call. An expired mark under a fresh signal is
    re-created and claimed once.
  - `not_found`: nothing.

  If the H6-E request finds the target gone or a placeholder, the mark is dropped. TypeScript never re-decides the
  definer's answer and never reads the outbox.
- **Read.** `confirmStoredInteraction`:
  1. `begin_signal_confirmation_read`, in its own transaction: DB-stamps `read_started_at` and returns it as
     **`started_at::text`**;
  2. the unchanged H6-E read: exactly one provider read per attempt, outside any transaction;
  3. a final transaction:
     - `FOUND` / `AUTHORITATIVE_NOT_FOUND` → `complete_signal_confirmation_read(acct, interaction,
       ${startedAt}::timestamptz)`, passing back the exact text, so microseconds survive (a JS Date would truncate
       them);
     - any other settled outcome (TEMPORARY_FAILURE on the final attempt, PROVIDER_CONTRACT_AMBIGUOUS — Meta's 100/33 —,
       authorization or capability failures) → `backoffConfirmation`: `deferred_until = greatest(current, DB now +
       min(6 h, 5 min × 2^(generation − 1)))`.

  `confirmed_through_at` moves only through the definer and never regresses (0023 guard trigger). A retrying attempt
  settles nothing.
- **Trailing read.** A signal during or after a read leaves `last_signal_at > confirmed_through_at`. The next claim
  after the cooldown, from the due path, reads once more. A burst converges on one immediate read plus one trailing
  read; sustained signals cost ≤ 1 claim per 5 minutes per interaction; a mark is deleted only after a successful read
  that began after its newest signal.
- **Removal semantics** stay H6-E's. An authoritative not-found removes (`direct_fetch_confirmed`); an ambiguous one
  changes nothing and backs off. A webhook alone never removes.
- **Isolation.** Confirm marks are excluded from the account/relist summary, `deferAll`, the relist planner and the
  run close hook (`kind in ('account','relist')`, pinned by guard).
- **Due path.** For an ACTIVE account, `reviewDueConfirmations` claims at most `confirmReviewLimit` (10) due confirm
  marks per invocation; any remaining get a 60-second revisit. The account/relist review then runs as before. The
  outcome is `PLANNED_CONFIRMATION` when reconciliation is idle and a confirmation was requested.

### 28.3 Global expiry

The MAIN purge task (`ingestion.purge_provider_events`, system scope) first runs `expireSignalMarksSweep`:
`system.expire_signal_marks(1000)` up to 5 batches, counts only. It then purges the inbox. Logs:
- `signal.mark_expired.account`, `signal.mark_expired.relist`, `signal.mark_expired.confirm`;
- a remainder warning.

No other code names the definer (guard). The per-account `deleteExpired` in the review is unchanged and compares with
DB time.

### 28.4 Clock authority as implemented

- **DB time** (`statement_timestamp()`): every mark's `expires_at` (now + 7 d), every `deferred_until` (now + delay,
  including the cap/skew delay computed on the run clock), confirm-mark signal times, `cursor_parked_at`,
  `read_started_at`, `confirmed_through_at`, the claim cooldown, the parked-TTL check and expiry.
- **Run clock**: account/relist `last_signal_at`, run requested/started, satisfaction boundaries and the hourly cap.
- **Provider time**: metadata only.

### 28.5 Crash safety

- A claim and its outbox row commit together.
- A crash after `begin` but before `complete` leaves the mark pending. The next claim after the cooldown reads again,
  and the dispatch key of the new generation is new.
- A crash between park and adoption leaves the cursor parked until its TTL; it is then retired and the content gets a
  fresh window.
- Adoption and retirement share one transaction, so a cursor can't be adopted twice.

### 28.6 Still VALIDATE / open

- Meta's cursor lifetime (the 90-minute TTL is local).
- Meta not-found authority (100/33 stays ambiguous).
- The LIVE acceptance (H6-G) and the release (H6-F5).
