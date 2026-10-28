# H6 — Continuous interaction ingestion (design + frozen contracts)

H6 is the approved Step 6 of TA §73 ("ingestion + canonical conversation model"): comments and replies enter
Wrenkind continuously and truthfully, ending at a trustworthy normalized interaction state and an IDs-only event.
The authoritative architecture is TA §12–§14, §17–§20, §38.11, §40, §47 and Model §10–§13, §45; this document records
what H6 adds on top and what the TL decided. No AI, protocol, workflow (beyond the initial Open state), automation or
webhook delivery is built in H6-A1.

**Principle:** `webhook = signal` · `provider re-read = authority` · `reconciliation = completeness`.
Reconciliation (pull) is the first ingestion primitive; Meta webhook delivery comes after it.

## TL decisions (frozen in H6-A1)

| # | Decision | Frozen as |
|---|---|---|
| 1 | Persistent `stored` interaction provenance | `modules/interactions/domain/stored-authority.ts`: an authority issued only from a persisted canonical interaction row (`issueStoredInteractionAuthority`, persistence-only, not in the public API), frozen and remembered in a process-local WeakSet so literals, copies and deserialized values are never authorities; `verifyStoredReread` fails closed on any workspace, account, platform, asset, interaction, content, parent or kind mismatch. The provider contract's `InteractionTarget` gains the `stored` kind in H6-E, not now. |
| 2 | Author data | Only the opaque provider author ref, the role (`account_identity` · `user` · `unknown`), the provider-visible label (Facebook display name / Instagram username), platform and workspace scope (`AuthorFact`). No cross-platform or cross-workspace identity, enrichment, contact data, demographics or profile scraping. Personal data (class P). |
| 3 | Raw webhook inbox retention | **7 days**, inbox only (`PROVIDER_EVENT_INBOX_POLICY`); never copied into canonical rows, text versions, outbox rows, job payloads, logs, analytics, error reports or diagnostic outputs. Polling responses are never stored. Cleanup scheduling is a later gate; TA-Q-11 stays VALIDATE for production. |
| 4 | Coverage is part of H6 | `modules/coverage/domain/coverage.ts`: per account × capability × interaction kind × interval, TA §17.1 states; slice outcomes COMPLETE · LIMITED · TEMPORARILY_FAILED · AUTHORIZATION_MISSING · NOT_VALIDATED · PLATFORM_UNSUPPORTED (never profile-state literals). Instagram under `REPLIES_NOT_READ`: comments COMPLETE, replies UNAVAILABLE — never zero. |
| 5 | Conversation initial workflow state | `OPEN`, set atomically with the anchoring canonical interaction (`planConversation`, whose initialization type admits only OPEN). Done, reopen, assignment, SLA and automation stay with the workflow layer. |
| 6 | Initial historical import | Only the `read_interactions` windows actually read; no 30-day history is claimed until `read_history` is validated (`INITIAL_IMPORT_POLICY`); coverage before the first read interval is `HISTORY_DEPTH_NOT_VALIDATED`. |

## Frozen contracts (pure domain, H6-A1)

- **`InteractionSourceFact`** (`modules/interactions/domain/source-fact.ts`): scope (workspace, connected account,
  platform, provider asset) · identity (provider interaction id, content id, parent id or null, kind) · author ·
  untrusted text exactly as provided + SHA-256 hash · state (visibility, availability, removal basis) · time (provider
  created, provider edited when stated, observed) · provenance (mechanism, provider operation, provenance kind, from a
  closed table) · evaluation (catalog and profile revision). The parser refuses unknown keys, so no raw payload,
  cursor, token or header can enter.
- **Identity:** unique `(workspace, platform, provider interaction id)`; account, asset, content and parent are
  validated attributes. A conflicting sighting is a classified authority conflict and is never applied.
- **Text versions:** same hash → unchanged; new hash → appended (immutable); stale (provider edit time first, else
  observed time) → never replaces newer state.
- **State:** absence from a listing is a removal candidate only; `removed_at_source` needs a verified provider signal or
  a validated direct-fetch not-found on a healthy connection. Meta's node not-found (100/33) is ambiguous and is not one.
  Stale observations are history only.
- **Comment / reply:** a reply shares its parent's content scope; a reply before its parent creates a minimal,
  never-observed placeholder (identity + content scope only). Kinds are admitted only if coverage covers them, so an
  Instagram reply is refused under r5.
- **Reconciliation slice** (`modules/ingestion/domain/reconciliation-slice.ts`): bounded pages (hard cap 10), no early
  stop on ordering, opaque short-lived cursor as resumable-slice state only, time watermark with overlap, deterministic
  dispatch key. Cadence is not decided (TA-Q-22, TA-Q-32).
- **`interactions.observed`** (`modules/ingestion/domain/events.ts`): an append-only `IngestionEventRecord` (change ·
  arrival realtime / reconciliation / backfill · observed time · correlation · system initiator) plus an IDs-only
  outbox row (UUID subject ids only, as the outbox CHECK requires). `backfill` stays distinguishable for forward-only
  automation.

## Prompt-injection boundary

Social interaction text is untrusted data (`UntrustedSocialText`). Ingestion stores it exactly as provided and never
interprets it: it doesn't select a tool, a task or a route, links stay inert, no URL found in text is fetched, and text
never travels in an outbox row or job payload. Future AI use goes through the AI gateway with delimited data sections
(Step 8, outside H6).

## Scope of H6-A1 and what follows

No migration in H6-A1, no persistence, no jobs, no provider call. Next: H6-B (canonical source model migration 0017,
coverage persistence, simulator ingestion service), then H6-C (pull sync job on the simulator), H6-D (LIVE pull
acceptance), H6-E (`stored` target + lifecycle), H6-F (webhook receiver offline), H6-G (Meta webhook validation).

## H6-C1 — deferred conversations (supersedes the H6-B provisional conversation)

TL decisions frozen for the reconciliation runtime (H6-C0 design): D-C1 the first reconciliation is triggered only by an
explicit Owner/Admin action (no cadence, no automatic fan-out yet); D-C2 a brand-rooted thread has no Conversation;
D-C3 default budgets; D-C4 a 24-hour overlap; D-C5 migration 0018 (H6-C2) adds `TRAVERSAL_INCOMPLETE` to the coverage
reason CHECK and `connected_account.reconciliation_requested` to the audit action CHECK. H6-C1 itself adds no
migration: 0017 already allows `conversation_id` to be null and to move only from null to a value.

**Invariant.** An interaction has a `conversation_id` only if its ancestry has resolved to an observed top-level
**audience** comment. A placeholder never anchors a Conversation; no Conversation is provisional; none is re-anchored.

| Sighting | Conversation |
|---|---|
| Top-level comment, author user or unknown | Created OPEN (or found), anchored on it permanently |
| Top-level comment by the managed account (brand) | None; its thread's replies stay without one |
| Reply whose parent has a conversation | Joins it |
| Reply whose parent has none (placeholder, unresolved, or brand-rooted) | None — a reply never creates one |

**Late root.** When a placeholder is observed as a top-level audience comment, its Conversation is created then and
the root plus every canonical descendant without a conversation take it in one statement (`attachSubtree`, bounded at
depth 64, workspace-scoped). A placeholder observed as a reply takes its parent's conversation (if any) the same way.
Before any write, the completion is checked: a parent inside the placeholder's own subtree is `ANCESTRY_CYCLE`; a
subtree deeper than 64 (or looping) is `ANCESTRY_DEPTH_EXCEEDED`; a member already in another conversation (or in any,
under a brand root) is `DESCENDANT_CONVERSATION_CONFLICT`. Each fails closed — the fact is rolled back, rows are kept,
nothing is repaired. `THREAD_ANCHOR_CONFLICT` no longer exists: arrival order alone is never a conflict.

**Events.** The `interactions.observed` vocabulary is unchanged (created · text_changed · state_changed ·
removed_at_source). Attaching existing descendants to a late root's conversation emits no event of its own: the root's
`created` event names the conversation. A `conversation_attached` event, if needed, belongs to H7.

**Runtime contract changes (pure; no job yet).**

- Slice dispatch key: `ingestion.reconcile_slice:{slice id}` — the persistent slice row's id alone (≤ 128 characters);
  a continuation is a new row with a new id. The H6-A1 window-derived key is superseded (two runs over one window could
  collide, and it could exceed the outbox's 128-character key).
- Coverage: a traversal stopped by its page/continuation budget covers nothing — UNKNOWN / `TRAVERSAL_INCOMPLETE`,
  slice outcome TEMPORARILY_FAILED; never COMPLETE, never zero. Persisted from 0018 on.
- Arrival: `backfill` for facts of a content's first traversal and for items the provider created before that
  content's reconciliation epoch; `reconciliation` otherwise. No historical depth is claimed.
- Defaults (`RECONCILIATION_DEFAULTS`, separate from the hard ceilings of 10 pages per slice and a 7-day overlap):
  1 listing page per slice, 5 interaction pages per slice, 2 continuations per content and run (≤ 15 pages), 10
  content items per run, 1 open run per account, 24-hour overlap. Budgets, not claims about provider history.

## H6-C2 — reconciliation runtime persistence (migration 0018)

0018 adds the reconciliation tables only (no webhook inbox — that is H6-F) and two closed-vocabulary widenings:

| Table | Purpose | Who reads / writes |
|---|---|---|
| `ingestion.reconciliation_runs` | One request per connected account, with its budget snapshot; at most one REQUESTED/RUNNING run per account | Non-guest members read (status); job runtime writes |
| `ingestion.reconciliation_slices` | One bounded unit of provider work; the only home of a short-lived provider cursor (≤ 2048, only while PENDING/RUNNING); at most one RUNNING slice per account | Job runtime only |
| `ingestion.reconciliation_watermarks` | Per account × `read_interactions` scope × content: fixed epoch, `synced_through` that never regresses | Job runtime only |
| `ingestion.authority_conflicts` | Append-only refusals: ids and the 12 canonical conflict classes (no `THREAD_ANCHOR_CONFLICT`) | Job runtime only |

Widenings: `coverage_records.reason` gains `TRAVERSAL_INCOMPLETE`; `audit_events.action` gains
`connected_account.reconciliation_requested`. Triggers refuse only authority-breaking transitions (a finished run or
slice never changes again, a slice is claimed only by incrementing its attempt, counters never decrease, the epoch is
fixed). Every other transition is the application's (H6-C3). Applying 0018 to dev-v2 is its own gate (H6-C2b).

## H6-C3 — reconciliation runtime (simulator only)

Three tenant tasks, registered in the production registry (no schedule, TL D-C1):

| Task | Plane | Does |
|---|---|---|
| `ingestion.reconcile_account` | MAIN | Re-checks account, connection, `ingestion.provider_pause`, rate-limit back-off and capability (read_content and read_interactions at post·unknown); never a credential. Unavailable → SKIPPED_UNAVAILABLE (a gap is written only over already-synced intervals). Otherwise RUNNING + the content_listing slice. |
| `ingestion.reconcile_slice` | INTEGRATION | Claim (attempt + 1, lease; a cursor older than 15 min is dropped) → per page: re-check every authority + reserve one run operation, then one provider read outside any transaction → commit: share-locked re-check (a removal discards the answer), ingest parents-first with one savepoint per fact (an authority conflict is recorded alone), coverage, watermark, the slice's final or CONTINUED state, and the next slice's outbox row. |
| `interactions.observed` | MAIN | Terminal H6 consumer: the IDs-only event names one canonical event of the workspace → `accepted_terminal`. No text, provider, credential, AI or workflow. |

The request service (`requestReconciliation`) runs in the job scope: 0018 lets only the job runtime write runs, so the
H6-C4 web action needs its own write path for the request (a reviewed definer or an Owner/Admin INSERT policy). The run
operation cap (40; 8 for a LIVE acceptance) is enforced against the persisted `operations_used`, but 0018's budget
snapshot has no column for the cap itself.

## H6-C3b — the reconciliation request boundary (migration 0019)

Closes the two gaps above before any web action, and freezes the third (TL decisions 1–3).

**One creation path (TL 1).** `ingestion.request_reconciliation(account, correlation, requested_at, budget)` is a
reviewed SECURITY DEFINER (`app_owner`, empty `search_path`, schema-qualified, no dynamic SQL; EXECUTE for
`authenticated` and `app_worker` only, none for PUBLIC). In the caller's transaction, atomically, it:

- binds the workspace from the sealed context, never from a parameter;
- for a web caller, requires OWNER or ADMIN from the verified claims and live membership; the caller passes neither
  the budget nor the time, and gets the approved defaults at statement time;
- for the job runtime (the internal/operator path), may narrow the budget within the CHECKs and names the time;
- finds the ACTIVE account of that workspace, else returns `not_found` (no existence oracle);
- with an open run, returns `already_running` (a concurrent duplicate loses on the one-open index and returns the same);
- otherwise writes one REQUESTED run (initiator = the user, or the system for the job runtime), one
  `connected_account.reconciliation_requested` audit event and one IDs-only `ingestion.reconcile_account` outbox row,
  and returns `requested`.

A refused caller gets 42501 and nothing is written. Members still have no INSERT on runs. A RESTRICTIVE policy refuses
their direct appends of the three reconciliation topics. `requestReconciliation` is the typed adapter: it maps the
function's outcome and wakes the relay.

**The persisted operation budget (TL 2).** `reconciliation_runs.max_operations` is NOT NULL and immutable (no UPDATE
grant), with `1 ≤ max_operations ≤ 40` and `operations_used ≤ max_operations`. An ordinary run gets 40; a bounded LIVE
acceptance gets 8, through the internal path only. Each read attempt reserves against the run's own column, never a
code constant.

**No removal detection (TL 3).** Absence from a listing is not removal authority. 0019 adds no tombstone, sweep or
`getInteraction` re-read. Directly confirmed removal is H6-E.

Applying 0019 to dev-v2 is its own gate (H6-C3c).

## H6-C3d — audit provenance before H6-C4 (migration 0020)

**The issue.** 0003's `append_own` let any member append a self-attributed audit event with any action the CHECK
admits, in any workspace or organization (it checked only `actor_type = 'user'` and `actor_user_id = auth.uid()`). A
member could fabricate `connected_account.reconciliation_requested` without going through 0019's boundary.

**Who produces audit events (inventory at 214f168):**

| Producer | Role | Actions |
|---|---|---|
| Action pipeline, step 7 (`server/pipeline`) | `authenticated`, actor = the verified user | the 20 literal actions of `server/commands` |
| `ingestion.request_reconciliation` (0019) | `app_owner` definer | `connected_account.reconciliation_requested` |
| `connections.record_move_audit` (0010) | `app_owner` definer | `moved_out`, `moved_in`, `move_failed`, `move_rejected` |
| Discovery worker | `app_worker`, actor `system` | `connection.validated`, `connection.status_changed` |

No flow is a pure "direct user event": every pipeline action accompanies a real mutation in the same transaction. The
database can't tell the pipeline's INSERT from another one by the same role (`app.bind_workspace` takes no secret).

**TL decision: narrow allowlist.** 0020 replaces `append_own`'s WITH CHECK in place (`ALTER POLICY`; DROP is
forbidden by the migration lint). A member's direct append must be one of the pipeline's actions, bound to the tenant
context the way the pipeline writes it:

- (a) workspace-scoped commands: the sealed workspace, its organization, and a live member of that workspace;
- (b) organization-scoped commands: no workspace bound, a live member of that organization, and any named workspace one
  of that organization's;
- (c) user-scoped commands: no workspace bound, and the actor's own new membership.

The domain allows self-removal, so a removal record that targets the actor themselves is admitted once their
membership is gone. One helper backs the policy: `audit.bound_workspace_organization()`, a definer that returns the
bound workspace's organization only to a live member of that organization. It is not an oracle, unlike
`app.current_workspace_organization()`, which stays reserved for the job runtime.

Out of a member's reach: `reconciliation_requested`, the four Move saga actions and `connection.validated`. The ledger
stays append-only: no runtime role may read, update or delete. The vocabulary is unchanged and no historical row is
touched.

**Documented residuals:**

- A member can still append one of the pipeline's actions within their own workspace or organization. Emitting these
  from an authoritative database boundary (definers or row triggers) is a later gate.
- A self-targeted removal record can't prove the removed membership existed.

Applying 0020 to dev-v2 is its own gate (H6-C3e).

## H6-C4 — "Sync interactions" (the web producer; source only)

An Owner/Admin requests one reconciliation of one managed account from Workspace Settings › Connections, under the
managed accounts. One form per managed account posts only the workspace id and the account id.

| Layer | Piece |
|---|---|
| Page | `InteractionsSync` (pending button) |
| Server action | `requestInteractionsSyncAction` (reads two fields) |
| Surface | `requestInteractionsSync` (closed statuses) |
| Command | `ingestion.account.request_reconciliation` (`connections.manage`, input = account id only, Monitor-only allowed) |
| Adapter | `requestMemberReconciliation` (no time, no budget) |
| Web unit of work | `reconciliation` port: `requestRun` only |
| Boundary | `ingestion.request_reconciliation` (0019) |

**Authority.** The pipeline's `connections.manage` check (Owner/Admin, not grantable) is only the early refusal. The
0019 boundary decides again and writes the REQUESTED run (budget 40), its audit event and its planner row atomically.

**Audit.** The command declares `auditedBy` (a `DatabaseBoundaryAudit`), so the pipeline appends no second event. If a
boundary-audited command ever returns a draft, the pipeline fails closed. The command appends no outbox row; it only
reports the boundary's row for the post-commit wake-up (`outbox.routed`).

**Outcomes.**

| Status | Meaning |
|---|---|
| `sync_started` | a run is requested; nothing has been imported yet |
| `sync_already_running` | a run is already open; a product state, not an error |
| `sync_not_found` | foreign, unknown, inactive or malformed account; nothing leaks |
| `not_allowed` | the caller isn't Owner/Admin |
| `unavailable` | any other failure, including an unknown answer |

Run status is not shown yet, and nothing polls.

**Release order (H6-C5).** This source adds a web producer of `ingestion.reconcile_account`. The deployed MAIN plane
(@332046e) has no such task, so a relay dispatch from it would fail with `unknown_task`. Ship it with the paired Trigger
release FIRST: both planes from the same source, with MAIN's task inventory including `ingestion.reconcile_account` and
the paired task counts verified. Only then deploy the web from that source — never the web producer first. Source
guards keep the topic registered on MAIN and the release-pair task counts equal to the registry; the deployment order
itself is the H6-C5 runbook.

## H6 closeout

H6 is closed. The authoritative final record (capability matrix, rules, topology, budgets, coverage and watermark
models, the security boundary, evidence by class, limitations and deferred scope) is [CLOSEOUT.md](CLOSEOUT.md).

## H6-E — stored-interaction confirmation (source and simulator only)

H6-E adds the one mechanism that may mark a canonical interaction `removed_at_source` from a re-read: a direct provider
read of that interaction, derived from stored provenance. Absence from a listing is still never removal authority.

**Provenance.** This follows the H6-A1 freeze (TL decision 1):
- The interactions persistence layer issues the stored authority (`loadStoredInteractionAuthority`) from the canonical
  observed row.
- The provider contract's `InteractionTarget` gains the `stored` kind, carrying the same five facts as a listed
  provenance (account, content, identity, parent, kind). Adapters check them for coherence: one platform, the access's
  own account, reply ⇔ parent.
- A FOUND node must pass `verifyStoredReread` against its authority, or nothing is applied.
- No caller, browser or payload supplies a provider id.

**Topology.** `ingestion.confirm_interaction` runs on INTEGRATION (INTEGRATION now has 7 tasks; MAIN stays at 8), with
subjects `interaction_id` and `connected_account_id`, IDs only.
- It makes exactly one `getInteraction(stored)` per attempt; retries follow the task's transient policy.
- The only producer is the internal job-scope `requestInteractionConfirmation`. There is no web surface, scheduler or
  fan-out.
- Reusing `reconcile_slice` was rejected: confirmation is object-level, with no run budget, coverage or cursor.

**Outcomes** (closed): `FOUND`, `AUTHORITATIVE_NOT_FOUND`, `TEMPORARY_FAILURE`, `AUTHORIZATION_FAILURE`,
`CAPABILITY_UNAVAILABLE`, `PROVIDER_CONTRACT_AMBIGUOUS`, `INTERACTION_NOT_FOUND`, `NOT_ELIGIBLE`.
- Only `AUTHORITATIVE_NOT_FOUND`, with an ACTIVE connection and a readable capability for the content scope and the
  interaction's kind, removes. It goes through `removalBasisFrom` → `direct_fetch_confirmed`.
- A FOUND interaction is an ordinary observation through the one canonical path: unchanged adds nothing; a removed one
  that reappears becomes available again in the same row (`state_changed`).
- Rows, text history, parent links and conversations stay. Coverage and watermarks are never touched.

**Not-found authority.** `TargetNotFoundError.authority` is `authoritative` or `unconfirmed`, and the default is
unconfirmed.
- Meta's 100/33 ("does not exist, cannot be loaded due to missing permissions, or does not support this operation") is
  ambiguous by Meta's own definition, so on Meta every not-found stays unconfirmed. **H6-E cannot remove anything on
  Facebook or Instagram** until a LIVE validation gate establishes an authoritative not-found.
- Only the simulator's direct re-read of a vanished interaction is authoritative.
- A stored Instagram reply is refused before any request (`REPLIES_NOT_READ`).

**No migration.** 0017 already has `stored_reread`, `getInteraction`, `stored`, `direct_fetch_confirmed`,
`removed_at_source` and `state_changed`.

**Release recommendation.** The members' outbox `append_own` (0004) admits any topic not blocked by a RESTRICTIVE
policy, so a member could append `ingestion.confirm_interaction` directly. The impact is bounded: own workspace only,
everything re-derived server-side, and no removal possible on Meta. Still, a migration gate adding the topic to a
restrictive member policy should precede the H6-E release.

## H6-E1 — member outbox topic provenance (migration 0021; source only, not applied)

**Inventory (derived from the repository, pinned by `tests/architecture/outbox-member-topics-guards`).** The web
(`authenticated`, 0004 `append_own`) appends exactly two topics as the member, through two message builders:
`connections.discover_assets` (completed exchange) and `capability.evaluate_account` (link, save_selection,
re-evaluation). Every other tenant task of `PRODUCTION_TASKS` is internal — its producer is a reviewed definer
(`connections.route_move_step` for the three Move topics, 0010; `ingestion.request_reconciliation` for
`ingestion.reconcile_account`, 0019) or the job runtime (`ingestion.reconcile_slice`, `interactions.observed`,
`ingestion.confirm_interaction`). System-scope tasks (`outbox.*`) are never outbox topics: the relay resolves a row's
topic as a tenant task only (`unknown_task` otherwise).

**Finding.** Before 0021 a member could append `ingestion.confirm_interaction` directly: 0010 and 0019 removed their own
topics from `append_own`, but H6-E added a job-runtime-only topic without a policy.

**TL decision: complete internal inventory + closure guard (not an allowlist).** 0021 creates ONE restrictive INSERT
policy for `authenticated`, `no_direct_internal_topics`, naming all seven internal topics (overlapping 0010 and 0019 on
purpose, so one policy is the auditable inventory). An exact SQL allowlist was rejected because the permanent suites
(T-27, `persistence`, `moves`) exercise the generic member append with synthetic topics through the real web pipeline;
closing the class is the guard's job instead: every tenant task registered without being a member topic must appear in
0021, or CI fails. The worker (`append_bound_workspace`), `app_owner` (owner policies) and `app_system` are untouched;
no row is read or rewritten; no topic, payload or runtime behavior changes.

**Proven on the real database (`tests/db/suites/outbox-member-topics`).** Members still append both member topics (and
a synthetic one) into their bound workspace; they cannot append the confirmation topic in the trusted producer's exact
shape, nor any other internal topic, nor anything cross-workspace, cross-organization or as another user. The H6-E
producer (`enqueueConfirmation`, worker scope) still appends its IDs-only row — system initiator, exactly
`connected_account_id` + `interaction_id` — and the real relay dispatches it once to INTEGRATION with an IDs-only payload.

**Residual (unchanged, documented).** `append_own` binds `workspace_id` to the sealed workspace and `initiator_user_id`
to the verified claims, but does not check `organization_id` on a member's own-workspace row; the relay derives the
tenant from `workspace_id`, so the column is metadata there. Out of scope here.

**Release order.** Apply 0021 (H6-E2) before the paired Trigger release that carries `ingestion.confirm_interaction`
(INTEGRATION 7 / MAIN 8). On Meta the released confirmation still removes nothing until a LIVE validation gate
establishes an authoritative not-found.
