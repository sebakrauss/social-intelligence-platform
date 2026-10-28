-- 0021 · Outbox member-topic provenance: every INTERNAL topic — one whose producer authority is a reviewed SECURITY
-- DEFINER or the job runtime — is removed from the members' direct outbox append in ONE auditable place (Step H6-E1,
-- before the ingestion.confirm_interaction release; TL decision "complete internal inventory + closure guard").
-- Forward-only: one RESTRICTIVE INSERT policy for `authenticated` on system.outbox. No table, column, grant, function
-- or other policy changes; no outbox row is read, rewritten or deleted (historical rows stay exactly as they are); no
-- topic, task, payload or runtime behavior changes.
--
-- Before: 0004's generic `append_own` admits ANY topic a member appends as themselves into their bound workspace, less
-- what two earlier RESTRICTIVE policies remove (0010: the three Move saga topics; 0019: the three reconciliation
-- topics). H6-E's `ingestion.confirm_interaction` — a privileged INTEGRATION workflow whose only producer is the job
-- runtime's requestInteractionConfirmation — was therefore directly appendable by a member. Bounded (own workspace only,
-- every fact re-derived server-side from the interaction id, nothing removable on Meta), but a privilege no member holds.
--
-- After: a member's direct append may carry none of the registry's tenant tasks the web never appends itself
-- (jobs/registry.ts; the full inventory at this source):
--   connections.move.release_source / activate_destination / reject_destination   only connections.route_move_step (0010)
--   ingestion.reconcile_account                                                     only ingestion.request_reconciliation (0019)
--   ingestion.reconcile_slice, interactions.observed                                only the job runtime (0019)
--   ingestion.confirm_interaction                                                   only the job runtime (H6-E; NEW here)
-- The two topics the action pipeline appends AS the member (asset discovery after a completed exchange, capability
-- evaluation after an activation or re-evaluation) stay admitted by `append_own`, unchanged. Restrictive policies
-- intersect: 0010 and 0019 keep applying exactly as before; this policy overlaps them on purpose so that ONE policy is
-- the complete inventory. app_worker (its own append policy), app_owner (the definers' owner policies) and app_system
-- are untouched. System-scope tasks (outbox.*) are never outbox topics: the relay refuses such a row as unknown_task.
--
-- Closure is pinned by test, not by SQL (tests/architecture/outbox-member-topics-guards): every tenant task registered
-- in PRODUCTION_TASKS that is not one of the two member topics must be named here, so a new internal topic registered
-- without a policy fails CI. The repository's permanent suites exercise the generic member append with synthetic
-- topics through the real web pipeline, which is why this is an inventory of internal topics and not an allowlist.

set role app_owner;

create policy no_direct_internal_topics on system.outbox as restrictive for insert to authenticated
  with check (topic not in (
    'connections.move.release_source', 'connections.move.activate_destination', 'connections.move.reject_destination',
    'ingestion.reconcile_account', 'ingestion.reconcile_slice', 'ingestion.confirm_interaction',
    'interactions.observed'));

reset role;
