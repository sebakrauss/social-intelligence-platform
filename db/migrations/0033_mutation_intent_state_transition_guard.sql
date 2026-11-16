-- 0033 · Mutation intent state-transition integrity (Step 7B-16E; TA §26, R6; CLAUDE.md §9). Forward-only and
-- expand-only: ONE trigger function and ONE trigger on mutations.mutation_intents. No table, column, row, constraint,
-- index, policy, grant or role changes; nothing is backfilled, rewritten or deleted.
--
-- The gap (Step 7B-16C audit, reproduced locally in Step 7B-16E). 0027 lets the bound worker UPDATE an intent's status
-- (column grants + worker_update policy) without checking the transition; 0028's consume trigger checks the intent model's
-- transitions ONLY for intents that carry a validation authorization. For an ORDINARY intent the database therefore
-- accepted all 22 status changes the domain forbids — a terminal intent resurrected (BLOCKED / FAILED / CONFIRMED →
-- PENDING or EXECUTING), a provider outcome without EXECUTING (PENDING → CONFIRMED / FAILED / OUTCOME_UNKNOWN), a step
-- back (EXECUTING / OUTCOME_UNKNOWN → PENDING). The executor never writes those (mutations/executor settles through
-- assertTransition and a compare-and-set store), but the database did not refuse them.
--
-- The rule — exactly mutations/domain/intent.ts TRANSITIONS, for EVERY intent, every role (owner included):
--
--     PENDING          → EXECUTING | BLOCKED
--     EXECUTING        → CONFIRMED | FAILED | BLOCKED | OUTCOME_UNKNOWN
--     OUTCOME_UNKNOWN  → CONFIRMED | FAILED
--     CONFIRMED, FAILED, BLOCKED → nothing (terminal)
--
-- Any other status change raises 42501 (the SQLSTATE 0028 uses for "not a transition of an authorized intent") and the
-- statement — with the transaction around it — writes nothing. A test derives the expected matrix from the domain's own
-- assertTransition and compares it with what this database does for all 30 changes (tests/db/suites/mutations.ts).
--
--   scope     BEFORE UPDATE OF status, WHEN the status actually changes. An update that leaves the status unchanged is
--             untouched (as before 0033: same-status metadata writes remain the store's compare-and-set concern). INSERT
--             is not a transition: runtime roles can only insert PENDING already (0027 member_request; the worker has no
--             INSERT grant), and legacy or seeded rows of any status are left as they are.
--   order     BEFORE triggers fire in name order: consume_validation_authorization (0028), intent_mode_guard (0027),
--             intent_transition_guard (this). An authorized intent keeps 0028's own refusals first; a refusal by any of
--             them rolls the whole statement back, so the order changes which message is seen, never the outcome.
--   0032      no allowed transition leads from CONFIRMED / FAILED / BLOCKED back into PENDING / EXECUTING /
--             OUTCOME_UNKNOWN, so a released target can never be re-held by a transition; the open-reply index still
--             governs every INSERT.
--   security  SECURITY INVOKER (it reads only OLD and NEW: no table, no privilege needed), search_path pinned to
--             pg_catalog, pg_temp (TA §11 R4a), EXECUTE revoked from PUBLIC (a trigger function nobody calls directly).
--
-- Not here: history completeness (a status change is still not tied to a history row by the database), outcome-code ↔
-- status coherence beyond 0027's shape CHECKs, attempt monotonicity, and same-status metadata rewrites — documented as
-- residuals of Step 7B-16E.

set role app_owner;

create function mutations.intent_transition_guard() returns trigger
language plpgsql volatile security invoker set search_path = pg_catalog, pg_temp as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if (old.status = 'PENDING' and new.status in ('EXECUTING', 'BLOCKED'))
     or (old.status = 'EXECUTING' and new.status in ('CONFIRMED', 'FAILED', 'BLOCKED', 'OUTCOME_UNKNOWN'))
     or (old.status = 'OUTCOME_UNKNOWN' and new.status in ('CONFIRMED', 'FAILED')) then
    return new;
  end if;
  raise exception 'not a transition of the mutation intent model: % → %', old.status, new.status using errcode = '42501';
end
$$;
revoke all on function mutations.intent_transition_guard() from public;

create trigger intent_transition_guard before update of status on mutations.mutation_intents
  for each row when (old.status is distinct from new.status) execute function mutations.intent_transition_guard();

reset role;
