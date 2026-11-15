-- 0032 · REPLY_IN_FLIGHT — one open public reply per target (Step 7B-16B; TA §26.3, R6; CLAUDE.md §9). Forward-only and
-- expand-only: ONE partial unique index on mutations.mutation_intents. No table, column, function, trigger, policy,
-- grant, role or RLS setting changes; no existing constraint is relaxed; nothing is backfilled, rewritten or deleted.
--
-- The gap. The idempotency key (0027 mutation_intents_idempotent) recognizes a repeat of the SAME form only. Two
-- requests for the same comment with DIFFERENT keys — two tabs, two members, two server processes, any client — could
-- each commit a PENDING intent, and the executor would then publish two public replies to one comment.
--
-- The rule. Within a workspace, at most ONE public-reply intent per canonical target may hold it: PENDING (may still
-- execute), EXECUTING (may have reached the provider) or OUTCOME_UNKNOWN (may have published). CONFIRMED, FAILED and
-- BLOCKED release it. The intent's own status is the reservation: no separate table, no lease, no expiry — an uncertain
-- outcome holds its target until positive evidence (reconciliation, a late receipt) settles it.
--
--   identity  (workspace_id, target_interaction_id). The target is NOT NULL (0027) and is the canonical interaction:
--             interactions.interactions is unique per (workspace_id, platform, provider_interaction_id), so one real
--             comment has exactly one canonical row per workspace, and two platforms' equal external ids are two rows.
--             The account is determined by the target (0027 mutation_intents_target_owned), so adding it would only
--             weaken the key. `kind` scopes the rule to public replies (another mutation kind gets its own rule).
--   race      a unique index is checked atomically: a second insert of the same key WAITS for the first transaction
--             and then fails (23505, this index's name) if the first committed, or proceeds if it rolled back. This
--             holds across separate server processes and connections; no isolation level beyond READ COMMITTED is needed.
--   path      every intent is inserted by mutations/request (ordinary and validation alike); no migration or function
--             inserts intents. The request service answers this index's 23505 as REPLY_IN_FLIGHT (or as the existing
--             intent when the winner used the same key), inside a savepoint.
--   lifecycle no transition leads from CONFIRMED / FAILED / BLOCKED back into the holding set (mutations/domain/intent.ts),
--             so an executor or reconciliation transition can never collide with this index.
--   tenancy   the key includes the workspace: rows of another workspace never conflict, so the refusal is no oracle.
--             Members who can request (reply.public roles) already read every intent of their workspace (0027 member_read).
--
-- Existing rows. If any workspace already holds two open public-reply intents on one target, CREATE UNIQUE INDEX fails
-- (23505) and the runner rolls this migration back: nothing is deduplicated, closed or deleted automatically — such
-- intents need a reviewed human decision first. Read-only preflight for an authorized environment (before applying):
--
--   select workspace_id, target_interaction_id, count(*) as open_intents
--     from mutations.mutation_intents
--    where kind = 'reply_public' and status in ('PENDING', 'EXECUTING', 'OUTCOME_UNKNOWN')
--    group by workspace_id, target_interaction_id
--   having count(*) > 1;
--
-- Not here: cross-workspace or cross-organization duplicates of the same provider asset (PD D-50 M-01 is per
-- organization; a cross-tenant lock would be an existence oracle), the resolution of permanently uncertain outcomes, and
-- any change to the reply_public capability or the provider-action switches.

set role app_owner;

create unique index mutation_intents_one_open_reply_per_target
  on mutations.mutation_intents (workspace_id, target_interaction_id)
  where kind = 'reply_public' and status in ('PENDING', 'EXECUTING', 'OUTCOME_UNKNOWN');

comment on index mutations.mutation_intents_one_open_reply_per_target is
  'REPLY_IN_FLIGHT (Step 7B-16B): at most one PENDING/EXECUTING/OUTCOME_UNKNOWN public-reply intent per target and workspace.';

reset role;
