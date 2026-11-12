# R4a — privileged function inventory (Step 7B-14P1)

**Status: evidence for the independent review. Not an authorization.** Generated on a disposable local PostgreSQL 17
cluster (embedded, synthetic data only) from the catalogs, before 0031 (migrations 0001–0030) and after it (0001–0031).
Nothing here was read from a managed environment.

## How to reproduce

On any database migrated by this repository, as the migration role (read-only):

```sql
select n.nspname, p.oid::regprocedure, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig,
       (select array_agg(pg_get_userbyid(a.grantee)) from aclexplode(p.proacl) a where a.grantee <> p.proowner) as execute_grantees
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspowner = 'app_owner'::regrole or p.proowner = 'app_owner'::regrole
 order by 1, 2;
-- dependants: pg_depend where refclassid = 'pg_proc'::regclass (policies, CHECK constraints, triggers)
-- event triggers: select * from pg_event_trigger;
```

The permanent checks are `tests/db/suites/introspection.ts` (exact pin on every application function),
`tests/db/suites/t26.ts` cases 30–32 (adversarial probe) and `tests/architecture/database-guards.test.ts` (R4a).

## Scope

| Set | Count |
|---|---|
| Application functions (owned by `app_owner` / in `app_owner` schemas) | 67 |
| — SECURITY DEFINER | 45 |
| — SECURITY INVOKER | 22 |
| Pinned to `pg_catalog, pg_temp` by 0030 (operator path, Step 7B-14I3H) | 15 |
| Pinned to `pg_catalog, pg_temp` by 0031 (this step) | 52 |
| Overloaded names | 0 |
| Triggers on application tables | 18 (all call application functions listed below) |
| Event triggers | 0 |
| Views / materialized views in application schemas | 0 |
| Non-application functions (not modified) | `auth.uid()` (supabase_admin) |
| Dynamic SQL (`execute`) in any application function | none |

Roles: runtime `authenticated` (web_login), `app_worker` (worker_login), `app_system` (system_login),
`app_validation_operator` (validation_operator_* logins), owner `app_owner`, migration role `postgres`. Every runtime
role holds TEMP on the database (through PUBLIC). Nobody but `supabase_admin` can create in `pg_catalog`; no schema
precedes it on the pinned path.

Risk legend: **R** = privileged execution of caller-controlled pg_temp objects reproduced from a runtime session
(web/worker/system) before 0031; **P** = reproduced in the privileged context (as app_owner) before 0031;
**D** = definer reachable by runtimes (directly, by policy or by trigger) but not reproduced with the probe's inputs;
**I** = invoker that can run under a definer's identity (trigger / CHECK / helper) — defense in depth.
**fixed by 0030** = the operator path pinned in Step 7B-14I3H (its privileged execution was reproduced there). After 0031
the same probes reproduce nothing (0 of every set).

| Schema | Function | Mode | Owner | search_path before → after | EXECUTE | Used by | Risk | Change |
|---|---|---|---|---|---|---|---|---|
| app | `bind_workspace(uuid)` | DEFINER | app_owner | pg_catalog, pg_temp → pg_catalog, pg_temp | authenticated, app_worker | — | fixed by 0030 | 0030 (unchanged here) |
| app | `can_bootstrap_organization_owner(uuid)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | authenticated | policy: tenancy.organization_memberships | D | 0031 ALTER FUNCTION … SET search_path |
| app | `can_bootstrap_workspace_owner(uuid,uuid)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | authenticated | policy: tenancy.workspace_memberships | R+P | 0031 ALTER FUNCTION … SET search_path |
| app | `current_invitation()` | DEFINER | app_owner | '' → pg_catalog, pg_temp | authenticated | policy: tenancy.invitations | R+P | 0031 ALTER FUNCTION … SET search_path |
| app | `current_workspace()` | DEFINER | app_owner | pg_catalog, pg_temp → pg_catalog, pg_temp | authenticated, app_worker | policy: audit.audit_events, capability.account_profiles, capability.profile_entries, classification.ai_attempts, classification. | fixed by 0030 | 0030 (unchanged here) |
| app | `current_workspace_organization()` | DEFINER | app_owner | pg_catalog, pg_temp → pg_catalog, pg_temp | app_worker | policy: audit.audit_events, connections.connected_accounts, ingestion.reconciliation_runs, system.operational_switches, system.o | fixed by 0030 | 0030 (unchanged here) |
| app | `invitation_admits_organization_membership(uuid,text)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | authenticated | policy: tenancy.organization_memberships | R+P | 0031 ALTER FUNCTION … SET search_path |
| app | `invitation_admits_workspace_membership(uuid,uuid,text,text[])` | DEFINER | app_owner | '' → pg_catalog, pg_temp | authenticated | policy: tenancy.workspace_memberships | R+P | 0031 ALTER FUNCTION … SET search_path |
| app | `invitation_workspace()` | DEFINER | app_owner | '' → pg_catalog, pg_temp | authenticated | policy: tenancy.workspaces | R+P | 0031 ALTER FUNCTION … SET search_path |
| app | `my_organization_role(uuid)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | authenticated | policy: audit.audit_events, system.operational_switches, tenancy.invitations, tenancy.organization_memberships, tenancy.organiza | R+P | 0031 ALTER FUNCTION … SET search_path |
| app | `my_workspace_role(uuid)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | authenticated | policy: audit.audit_events, capability.account_profiles, capability.profile_entries, classification.assessments, classification. | R+P | 0031 ALTER FUNCTION … SET search_path |
| app | `present_invitation(text)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | authenticated | — | R+P | 0031 ALTER FUNCTION … SET search_path |
| app_private | `claimed_user()` | DEFINER | app_owner | '' → pg_catalog, pg_temp | — | policy: ingestion.reconciliation_runs, system.outbox, system.provider_event_hints, system.provider_event_inbox | P | 0031 ALTER FUNCTION … SET search_path |
| app_private | `context_seal(text,text)` | DEFINER | app_owner | pg_catalog, pg_temp → pg_catalog, pg_temp | — | — | fixed by 0030 | 0030 (unchanged here) |
| audit | `bound_workspace_organization()` | DEFINER | app_owner | '' → pg_catalog, pg_temp | authenticated | policy: audit.audit_events | R+P | 0031 ALTER FUNCTION … SET search_path |
| audit | `is_organization_membership_state(jsonb)` | invoker | app_owner | '' → pg_catalog, pg_temp | authenticated, app_worker | — | I | 0031 ALTER FUNCTION … SET search_path |
| audit | `is_valid_change(jsonb)` | invoker | app_owner | '' → pg_catalog, pg_temp | authenticated, app_worker | CHECK: audit.audit_events | I | 0031 ALTER FUNCTION … SET search_path |
| audit | `is_workspace_membership_state(jsonb)` | invoker | app_owner | '' → pg_catalog, pg_temp | authenticated, app_worker | — | I | 0031 ALTER FUNCTION … SET search_path |
| classification | `ai_budget_reservation_guard()` | invoker | app_owner | '' → pg_catalog, pg_temp | — | trigger: classification.ai_budget_reservations | I | 0031 ALTER FUNCTION … SET search_path |
| classification | `assessment_values_valid(text,text,text[],text[],numeric[],text[])` | invoker | app_owner | '' → pg_catalog, pg_temp | authenticated, app_worker | CHECK: classification.assessments | I | 0031 ALTER FUNCTION … SET search_path |
| classification | `reserve_ai_budget(text,date,integer,bigint,integer,bigint)` | invoker | app_owner | '' → pg_catalog, pg_temp | app_worker | — | I | 0031 ALTER FUNCTION … SET search_path |
| classification | `source_spans_valid(integer[],integer[],integer)` | invoker | app_owner | '' → pg_catalog, pg_temp | app_worker | CHECK: classification.ai_results, classification.signals | I | 0031 ALTER FUNCTION … SET search_path |
| classification | `understanding_request_guard()` | invoker | app_owner | '' → pg_catalog, pg_temp | — | trigger: classification.understanding_requests | I | 0031 ALTER FUNCTION … SET search_path |
| classification | `watch_phrases_valid(text[],integer)` | invoker | app_owner | '' → pg_catalog, pg_temp | app_worker | CHECK: classification.watch_terms | I | 0031 ALTER FUNCTION … SET search_path |
| connections | `invalidate_open_fresh_meta_attempts(timestamp with time zone)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | authenticated | — | R+P | 0031 ALTER FUNCTION … SET search_path |
| connections | `locate_active_link(uuid)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | authenticated, app_worker | — | R+P | 0031 ALTER FUNCTION … SET search_path |
| connections | `move_initiator_can_manage(uuid)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | app_worker | — | R+P | 0031 ALTER FUNCTION … SET search_path |
| connections | `record_move_audit(uuid,text,text)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | app_worker | — | R+P | 0031 ALTER FUNCTION … SET search_path |
| connections | `route_move_step(uuid,text,text,timestamp with time zone)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | authenticated, app_worker | — | R+P | 0031 ALTER FUNCTION … SET search_path |
| credentials | `delete_envelope(uuid)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | authenticated, app_worker | — | R+P | 0031 ALTER FUNCTION … SET search_path |
| credentials | `load_envelope(uuid)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | app_worker | — | R+P | 0031 ALTER FUNCTION … SET search_path |
| credentials | `store_envelope(uuid,uuid,integer,bytea,timestamp with time zone)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | authenticated, app_worker | — | R+P | 0031 ALTER FUNCTION … SET search_path |
| ingestion | `begin_signal_confirmation_read(uuid,uuid)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | app_worker | — | R+P | 0031 ALTER FUNCTION … SET search_path |
| ingestion | `claim_signal_confirmation(uuid,uuid)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | app_worker | — | R+P | 0031 ALTER FUNCTION … SET search_path |
| ingestion | `complete_signal_confirmation_read(uuid,uuid,timestamp with time zone)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | app_worker | — | R+P | 0031 ALTER FUNCTION … SET search_path |
| ingestion | `provider_event_hint(uuid,uuid)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | app_worker | — | R+P | 0031 ALTER FUNCTION … SET search_path |
| ingestion | `reconciliation_run_guard()` | invoker | app_owner | '' → pg_catalog, pg_temp | — | trigger: ingestion.reconciliation_runs | I | 0031 ALTER FUNCTION … SET search_path |
| ingestion | `reconciliation_slice_guard()` | invoker | app_owner | '' → pg_catalog, pg_temp | — | trigger: ingestion.reconciliation_slices | I | 0031 ALTER FUNCTION … SET search_path |
| ingestion | `reconciliation_slice_park_cursor()` | invoker | app_owner | '' → pg_catalog, pg_temp | — | trigger: ingestion.reconciliation_slices | I | 0031 ALTER FUNCTION … SET search_path |
| ingestion | `reconciliation_watermark_guard()` | invoker | app_owner | '' → pg_catalog, pg_temp | — | trigger: ingestion.reconciliation_watermarks | I | 0031 ALTER FUNCTION … SET search_path |
| ingestion | `request_reconciliation(uuid,text,timestamp with time zone,jsonb)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | authenticated, app_worker | — | R+P | 0031 ALTER FUNCTION … SET search_path |
| ingestion | `signal_mark_confirmation_guard()` | invoker | app_owner | '' → pg_catalog, pg_temp | — | trigger: ingestion.signal_marks | I | 0031 ALTER FUNCTION … SET search_path |
| interactions | `interactions_scope_guard()` | invoker | app_owner | '' → pg_catalog, pg_temp | — | trigger: interactions.interactions | I | 0031 ALTER FUNCTION … SET search_path |
| mutations | `bind_validation_authorization()` | DEFINER | app_owner | pg_catalog, pg_temp → pg_catalog, pg_temp | — | trigger: mutations.mutation_intents | fixed by 0030 | 0030 (unchanged here) |
| mutations | `consume_validation_authorization()` | DEFINER | app_owner | pg_catalog, pg_temp → pg_catalog, pg_temp | — | trigger: mutations.mutation_intents | fixed by 0030 | 0030 (unchanged here) |
| mutations | `initiator_workspace_role(uuid)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | app_worker | — | D | 0031 ALTER FUNCTION … SET search_path |
| mutations | `intent_mode_guard()` | DEFINER | app_owner | '' → pg_catalog, pg_temp | — | trigger: mutations.mutation_intents | P | 0031 ALTER FUNCTION … SET search_path |
| mutations | `issue_validation_authorization(uuid,uuid,uuid,text,integer,boolean)` | DEFINER | app_owner | pg_catalog, pg_temp → pg_catalog, pg_temp | app_validation_operator | — | fixed by 0030 | 0030 (unchanged here) |
| mutations | `record_validation_preflight(uuid,uuid,uuid,uuid,text,text,integer,boolean,boolean,integer,integer,boolean)` | DEFINER | app_owner | pg_catalog, pg_temp → pg_catalog, pg_temp | app_worker | — | fixed by 0030 | 0030 (unchanged here) |
| mutations | `revoke_validation_authorization(uuid,uuid,text)` | DEFINER | app_owner | pg_catalog, pg_temp → pg_catalog, pg_temp | app_validation_operator | — | fixed by 0030 | 0030 (unchanged here) |
| mutations | `validation_authorization_guard()` | invoker | app_owner | pg_catalog, pg_temp → pg_catalog, pg_temp | — | trigger: mutations.validation_authorizations | fixed by 0030 | 0030 (unchanged here) |
| mutations | `validation_authorization_status(uuid,uuid)` | DEFINER | app_owner | pg_catalog, pg_temp → pg_catalog, pg_temp | app_validation_operator | — | fixed by 0030 | 0030 (unchanged here) |
| mutations | `validation_operator_bind(uuid)` | invoker | app_owner | pg_catalog, pg_temp → pg_catalog, pg_temp | — | — | fixed by 0030 | 0030 (unchanged here) |
| mutations | `validation_operator_event_guard()` | invoker | app_owner | pg_catalog, pg_temp → pg_catalog, pg_temp | — | trigger: mutations.validation_operator_events | fixed by 0030 | 0030 (unchanged here) |
| mutations | `validation_operator_login()` | invoker | app_owner | pg_catalog, pg_temp → pg_catalog, pg_temp | — | — | fixed by 0030 | 0030 (unchanged here) |
| mutations | `validation_preflight_guard()` | invoker | app_owner | pg_catalog, pg_temp → pg_catalog, pg_temp | — | trigger: mutations.validation_preflights | fixed by 0030 | 0030 (unchanged here) |
| mutations | `workspace_mode_for_execution()` | DEFINER | app_owner | '' → pg_catalog, pg_temp | app_worker | — | D | 0031 ALTER FUNCTION … SET search_path |
| system | `dispatch_due_signal_marks(integer)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | app_system | — | R+P | 0031 ALTER FUNCTION … SET search_path |
| system | `expire_signal_marks(integer)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | app_system | — | R+P | 0031 ALTER FUNCTION … SET search_path |
| system | `is_identifier_map(jsonb)` | invoker | app_owner | '' → pg_catalog, pg_temp | authenticated, app_worker, app_system | CHECK: system.outbox | I | 0031 ALTER FUNCTION … SET search_path |
| system | `outbox_execution_plane_guard()` | invoker | app_owner | '' → pg_catalog, pg_temp | — | trigger: system.outbox | I | 0031 ALTER FUNCTION … SET search_path |
| system | `purge_provider_events(integer)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | app_system | — | R+P | 0031 ALTER FUNCTION … SET search_path |
| system | `record_provider_webhook(text,text,text,bytea,integer,boolean,integer,integer,integer,integer,integer,jsonb)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | authenticated | — | R+P | 0031 ALTER FUNCTION … SET search_path |
| system | `record_switch_change()` | DEFINER | app_owner | '' → pg_catalog, pg_temp | — | trigger: system.operational_switches | P | 0031 ALTER FUNCTION … SET search_path |
| system | `route_provider_hint(uuid)` | DEFINER | app_owner | '' → pg_catalog, pg_temp | app_system | — | R+P | 0031 ALTER FUNCTION … SET search_path |
| tenancy | `organization_keeps_an_owner()` | DEFINER | app_owner | '' → pg_catalog, pg_temp | — | trigger: tenancy.organization_memberships | D | 0031 ALTER FUNCTION … SET search_path |
| tenancy | `workspace_keeps_an_owner()` | DEFINER | app_owner | '' → pg_catalog, pg_temp | — | trigger: tenancy.workspace_memberships | D | 0031 ALTER FUNCTION … SET search_path |
