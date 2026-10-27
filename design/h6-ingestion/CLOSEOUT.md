# H6 — Continuous interaction ingestion: final closeout

This is the authoritative record of what H6 delivered, what is proven and how, what is limited, and what is deferred.
The gate-by-gate history is in [README.md](README.md). Evidence classes are kept apart and never promoted:

| Class | Meaning |
|---|---|
| **PROVEN LIVE** | Observed against real Meta, in Wrenkind Dev, through the deployed runtime (H6-D1, H6-D2). |
| **PROVEN BY SIMULATOR** | Proven end to end on PostgreSQL, with the real handlers and relay/sweepers, against the provider simulator (H6-C3 acceptance). |
| **KNOWN LIMITATION** | True of the product today; reported truthfully, not a defect. |
| **DEFERRED** | Not built in H6. Not complete. |

## Final authority (closeout)

| Surface | Authority |
|---|---|
| Source | `da86455` (H6-C4); runtime code unchanged since |
| Trigger INTEGRATION | `20261027.4 @da86455`, 6 tasks (incl. `ingestion.reconcile_slice`) |
| Trigger MAIN | `20261027.4 @da86455`, 8 tasks (incl. `ingestion.reconcile_account`, `interactions.observed`) |
| Web | production `@da86455` |
| Database (dev-v2) | ledger 20 (0017 canonical model, 0018 reconciliation persistence, 0019 request boundary, 0020 audit provenance), all FULL_MATCH, 0 pending |

Release invariant (H6-C5): the paired Trigger release ships first and is verified; only then the web producer.
Never the web producer first.

## Capability matrix (catalog r5, profiles rev5)

| Platform · scope | read_content | read_interactions | comment | reply | LIVE |
|---|---|---|---|---|---|
| Facebook · `post/unknown` | SUPPORTED | SUPPORTED | read | read | YES (H6-D1) |
| Instagram · `post/unknown` | SUPPORTED | AVAILABLE_WITH_LIMITATION | read | **`REPLIES_NOT_READ`** | YES (H6-D2) |

Every other scope (`any/any` and anything not listed) is `UNKNOWN_NOT_VALIDATED` and is never read. H6 validated
**read** capabilities only. On Instagram, `REPLIES_NOT_READ` means Wrenkind cannot claim complete observation of
replies. It says nothing about a future `create_reply`: reading comments, reading replies and creating replies are
distinct provider capabilities, each to be validated on its own, in the future Inbox/reply work.

## Canonical authority rules

- The provider re-read is the source authority. A webhook, when added later, is a signal to re-read, never a fact.
- An interaction is unique by `(workspace_id, platform, provider_interaction_id)`.
- Source text versions are append-only. A stale observation never overwrites newer authority.
- **Absence from a listing is not removal authority.** Removal requires an explicit provider signal or a validated
  direct re-read (H6-E).
- Authors are platform-local and minimal. There is no cross-platform identity synthesis.
- Downstream events (`interactions.observed`) and every outbox subject are IDs-only: no text, cursor, provider id or
  credential reference.

## Conversation rules

- A top-level **audience** comment creates, and anchors, the conversation.
- A top-level `account_identity` (brand) root creates no conversation.
- A reply never creates a conversation; it inherits its authoritative parent's.
- A reply observed before its root keeps `conversation_id = null`. A later authoritative audience root attaches the
  subtree.
- No provisional conversation, no re-anchoring, no `THREAD_ANCHOR_CONFLICT` (removed in H6-C1).
- Structural conflicts are `ANCESTRY_CYCLE`, `ANCESTRY_DEPTH_EXCEEDED` and `DESCENDANT_CONVERSATION_CONFLICT`. The
  closed vocabulary also has the identity and scope classes: `KEY_MISMATCH`, `ACCOUNT_CHANGED`, `ASSET_CHANGED`,
  `CONTENT_CHANGED`, `PARENT_CHANGED`, `KIND_CHANGED`, `CONTENT_SCOPE_CONFLICT`, `PLACEHOLDER_SCOPE_CONFLICT`,
  `PARENT_SCOPE_CONFLICT`.

## Reconciliation topology

| Task | Plane | Role |
|---|---|---|
| `ingestion.reconcile_account` | MAIN | Planner. Gates account, connection, kill switch and capability; never opens a credential. |
| `ingestion.reconcile_slice` | INTEGRATION | Reads one provider page per budgeted operation, outside any transaction, then commits ingestion, coverage and watermark. |
| `interactions.observed` | MAIN | Terminal consumer (`accepted_terminal`). Reads no source text (structural guard). |

- Slices run serially within one connected account; parallelism exists only across accounts. The database indexes
  (one open run, one RUNNING slice) are the concurrency authority, not the vendor's keys.
- Credentials open only in INTEGRATION. MAIN cannot reach the credential opener (depcruise and guard).
- A provider cursor lives only in its slice row. It never appears in a job payload or outbox row.
- Canonical ingestion is idempotent, and an authority conflict is isolated to its own fact (savepoint).
- Content slices traverse in listing order, newest first (observed LIVE).

## Budget model

| Field | Ordinary (web) | LIVE acceptance (internal path) |
|---|---|---|
| `max_operations` (persisted, immutable, 1–40, `operations_used ≤ max_operations`) | **40** | **8** |
| content listing pages / slice | 1 | 1 |
| interaction pages / slice | 5 | 5 |
| continuation slices / content | 2 | 2 |
| interaction pages / content / run (derived) | 15 | 15 |
| content items / run | 10 | 10 in H6-D1, **7** in H6-D2 |
| overlap | 24 h (CHECK ≤ 7 d) | 24 h |

The browser can choose none of these. The ordinary web request always gets the defaults (40 operations). The 8-operation
LIVE budget exists only on the internal worker path. Production defaults were not changed by H6-D.

## Coverage model

- **No coverage record means not available, no measurement.** Zero is never inferred.
- Coverage is a state, a reason and a slice outcome. The mapping below is exactly `modules/coverage/domain/coverage.ts`;
  the first five rows were exercised LIVE, the others are proven by the simulator or by unit tests:

| Situation | State | Reason | Slice outcome |
|---|---|---|---|
| First traversal, before the epoch | UNAVAILABLE | HISTORY_DEPTH_NOT_VALIDATED | NOT_VALIDATED |
| Facebook, fully traversed proven interval (comment and reply) | COMPLETE | VALIDATED_SCOPE_READ | COMPLETE |
| Instagram, fully traversed proven interval: comment | COMPLETE | VALIDATED_SCOPE_READ | LIMITED (`limitation_code REPLIES_NOT_READ`) |
| Instagram, fully traversed proven interval: reply | UNAVAILABLE | CAPABILITY_LIMITATION | LIMITED (`limitation_code REPLIES_NOT_READ`) |
| Budget exhausted (content not traversed) | UNKNOWN | TRAVERSAL_INCOMPLETE | TEMPORARILY_FAILED |
| Transient provider failure / read not attempted | FAILED / UNKNOWN | PROVIDER_FAILURE | TEMPORARILY_FAILED |
| Profile stale | FAILED | PROFILE_STALE | TEMPORARILY_FAILED |
| Connection removed or temporarily unavailable | FAILED | CONNECTION_UNAVAILABLE | TEMPORARILY_FAILED |
| Missing authorization | UNAVAILABLE | ACCOUNT_PERMISSION_MISSING | AUTHORIZATION_MISSING |
| Scope not validated / profile not evaluated | UNAVAILABLE | CAPABILITY_NOT_VALIDATED | NOT_VALIDATED |
| Authoritative platform non-support | UNAVAILABLE | CAPABILITY_UNSUPPORTED | PLATFORM_UNSUPPORTED |
| Account inactive | UNAVAILABLE | ACCOUNT_INACTIVE | NOT_VALIDATED |

- Coverage never claims completeness before the epoch. COMPLETE covers only `[synced_through, run start)` of a
  traversal that reached the provider's end.
- A known limitation is never turned into UNKNOWN.

## Watermark model

- The first complete traversal establishes the epoch (its window end). The epoch is immutable.
- `synced_through` advances only over a proven complete traversal and never regresses.
- `latest_created_at` is monotonic and reflects readable observations only. Instagram replies, which are not read,
  never move it.
- Overlap re-reads (`[synced_through − 24 h, run start)`) never change the epoch.

## Request and security boundary

- **Sync interactions** (Workspace Settings › Connections, managed accounts) is Owner/Admin only. The pipeline's
  `connections.manage` check gives an early refusal; the authority is 0019's SECURITY DEFINER
  `ingestion.request_reconciliation(...)`.
- The browser supplies only the routed workspace and the account id. It cannot control workspace, organization,
  user, role, topic, subjects, `requested_at` or `max_operations`.
- The definer atomically creates the REQUESTED run, its `connected_account.reconciliation_requested` audit event and
  the IDs-only `ingestion.reconcile_account` planner row. The TypeScript command declares `auditedBy`
  (`DatabaseBoundaryAudit`), so the pipeline appends no second audit event and fails closed if one is drafted.
- **Audit (0020):** a member's direct audit append is limited to the action pipeline's 19 actions, each bound to its
  tenant context. Actions owned by definers and the worker (`reconciliation_requested`, the Move saga, and
  `connection.validated`) are outside members' reach.
  - **RESIDUAL_AUDIT_RISK_1 (accepted):** an authenticated SQL caller inside its own authorized tenant may fabricate
    one of the 19 allowlisted pipeline actions.
  - **RESIDUAL_AUDIT_RISK_2 (accepted):** a self-removal audit row cannot prove the membership existed immediately
    before deletion.

## Evidence

### PROVEN BY SIMULATOR (H6-C3; `tests/db/suites/reconciliation-runtime.ts` and the H6-C3b/C4 suites)

- **Reading and backfill:** only validated content is read; comments, a brand reply and a nested reply are ingested as
  backfill. The first traversal claims nothing before its epoch.
- **Overlap re-reads:** they read only the overlap window. New interactions are `reconciliation`; edits, hide and
  native unhide apply; duplicates add nothing; absence is no deletion.
- **Instagram-like replies:** they are never ingested and are covered as UNAVAILABLE, never zero.
- **Thread structure:** a reply observed before its root attaches late across continuations; a brand root stays
  without a conversation.
- **Budget:** exhaustion ends as TRAVERSAL_INCOMPLETE. The budget is reserved before every read, so an exhausted
  mid-slice budget makes no further call and ends PARTIAL.
- **Cursors:** an expired cursor restarts the window once, bounded, without duplicates.
- **Faults and kill switch:** rate limiting gives FAILED_RATE_LIMITED with Retry-After and back-off. A transient
  failure is retried (attempt 2). A crash after commit is a no-op on re-dispatch. A worker failure before commit
  re-claims without duplicates. A profile that goes stale stops the run truthfully. A connection removed mid-read
  discards the answer. The provider-pause kill switch skips the run before any read.
- **Concurrency and conflicts:** an open run answers `already_running`; concurrent duplicate requests create one run.
  An authority conflict is isolated to its fact.
- **Consumer:** every `interactions.observed` is accepted by the terminal consumer, with 0 `unknown_task`.
- **Request boundary:** the Owner/Admin matrix, cross-workspace refusal, the budget not being browser-controllable,
  persisted `max_operations`, and the audit allowlist.

### PROVEN LIVE — Facebook (H6-D1)

- 2 runs, both **PARTIAL** (budget 8 against 10 listed posts), each 8/8 operations: 1 `listContent` plus 7
  `listInteractions`. That is 16 provider reads.
- Canonical: 10 content items (`post/unknown`), 2 interactions, 1 conversation, 0 conflicts, 0 duplicates.
- **Controlled comment:** top-level, author `user`, exactly once, arrival `reconciliation`, conversation anchor.
- **Controlled reply:** parent = the controlled comment, author `account_identity`, same conversation, exactly once.
- Observed consumer terminal (COMPLETED); 0 `unknown_task`.
- Coverage: COMPLETE over the proven post-epoch interval for traversed posts; UNKNOWN/TRAVERSAL_INCOMPLETE for the 3
  untraversed posts; nothing claimed before the epoch.
- Watermark: epoch fixed; `synced_through` advanced; `latest_created_at` set by the readable fixtures.

### PROVEN LIVE — Instagram (H6-D2; `krse.cl`)

- 2 runs, both **COMPLETED** (budget 8 with `content_items = 7`; the account has 3 `post/unknown` posts), each 4/8
  operations. That is 8 provider reads.
- Canonical: 3 content items, 1 interaction (comment), 0 replies, 1 conversation, 0 conflicts.
- **Controlled comment:** exactly once, arrival `reconciliation`, conversation created, observed consumer COMPLETED.
- **Controlled reply:** NOT ingested. No reply endpoint was called, `getInteraction` was not used as a bypass, and no
  reply was synthesized. Reply coverage is UNAVAILABLE/CAPABILITY_LIMITATION/`REPLIES_NOT_READ`; comment coverage is
  COMPLETE over the proven interval.
- The Facebook D1 rows were byte-identical before and after (11 table digests). D2 made no Facebook read.

### LIVE totals

- 24 provider reads: 16 Facebook, 8 Instagram. All came from the reconciliation machinery.
- The social fixtures were created manually in the Meta UIs; that is not a provider API read.

### Not proven LIVE

- **Overlap idempotency: NOT PROVEN LIVE. PROVEN BY SIMULATOR; accepted by the TL.** No LIVE overlap window contained
  a previously imported interaction. A proposed third Facebook run (D1-C) was blocked by the permission classifier and
  deliberately not bypassed; the TL declined it.
- **Absence-as-not-removal: not exercised LIVE.** The P12 fixtures had been deleted before the first H6 traversal, so
  they were never canonical; their absence proves nothing about tombstones. The rule is proven by the simulator
  (case 13) and enforced by guard 27.

## Known limitations

- Instagram `REPLIES_NOT_READ` (catalog r5).
- RESIDUAL_AUDIT_RISK_1 and RESIDUAL_AUDIT_RISK_2 (above).
- Operational latency: each slice waits for the dispatch sweeper's window, about 2 minutes per slice and about 16
  minutes for a 10-post run. Correctness is unaffected.
- With 10 posts, an 8-operation run always ends PARTIAL; the default `content_items = 10` exceeds that budget.

## Deferred (not complete)

- Direct removal confirmation (stored-provenance direct re-read; H6-E).
- Webhook signal ingestion (receiver, Meta signature, inbox definer; H6-F/G).
- Recurring scheduler and fan-out (no cadence exists; reconciliation is an explicit request).
- Provider write capabilities, including replies (`create_reply`), and the Inbox.
- Full audit provenance hardening (authoritative database emission of the pipeline's actions).
- Any content scope not validated (`any/any`, reels, stories, ads and others).
- Run status in the UI (no status view or polling in H6-C4).
