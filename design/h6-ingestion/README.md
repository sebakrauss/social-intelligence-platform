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
