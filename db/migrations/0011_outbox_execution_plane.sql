-- 0011 · Outbox execution plane (Step 7E.4B.2B; TA §19.3; R6, R7). Expand-only and forward-only: one nullable column,
-- three CHECK constraints, one invoker trigger guard and one column grant. Nothing is narrowed or removed, no existing
-- grant, policy or function changes, and system.outbox_runs is untouched.
--
--   system.outbox.execution_plane   the SEMANTIC execution plane ('main' | 'integration') a delivery is bound to — never
--                                   a vendor project ref, key, slug or environment name. NULL = never bound (no claim
--                                   has ever happened). Once bound, every dispatch attempt and every R7 recovery
--                                   generation of the row stays on that plane until it is terminal: a later routing
--                                   change affects only unbound work and never re-interprets an already-claimed delivery.
--
-- Binding happens ONLY in the delivery claim (B2): the same UPDATE that acquires (or renews) the row's lease. In the
-- repository the claim is the only statement that sets claimed_until to a non-null value (platform/db/outbox-delivery.ts
-- claimDueRows), and it changes nothing but claimed_until. The guard recognises exactly that transition:
--
--   genuine claim  ⇔  OLD.status = NEW.status = 'PENDING', no outcome / diagnostic before or after,
--                     NEW.claimed_until IS NOT NULL and (OLD.claimed_until IS NULL or NEW.claimed_until > OLD.claimed_until),
--                     and every other delivery column unchanged.
--
-- Guard (system.outbox_execution_plane_guard, BEFORE INSERT OR UPDATE OF execution_plane, claimed_until):
--   INSERT                       execution_plane must be NULL: producers never choose execution routing.
--   UPDATE, already bound        execution_plane can never change (main ↔ integration, or back to NULL).
--   UPDATE, unbound, claim       NULL → 'main' | 'integration' (an explicit plane from the claiming relay), or — 0011
--                                COMPATIBILITY ONLY — a claim that leaves it NULL is bound to 'main': every relay that
--                                predates this column dispatches only to the single historical Trigger.dev project,
--                                which is the MAIN execution plane.
--   UPDATE, unbound, not claim   execution_plane stays NULL: nothing but a claim can bind.
-- UPDATE OF execution_plane, claimed_until is sufficient: a statement can change execution_plane only by naming it (there
-- is no other trigger on system.outbox that could rewrite NEW), and every claim names claimed_until. Every INSERT fires.
-- The function is SECURITY INVOKER with an empty search_path: it reads only OLD/NEW and needs no privilege.
--
-- Constraints:
--   outbox_execution_plane_known   NULL or one of the two semantic planes.
--   outbox_dispatched_bound        a DISPATCHED row always has a plane.
--   outbox_unbound_untouched       an unbound row has never entered delivery: still PENDING, never claimed, never
--                                  attempted, never recovered, no outcome or diagnostic. Proven by the state machine:
--                                  every claim binds (above), every dispatch attempt (markDispatched / markDispatchFailed)
--                                  follows a claim, recovery and outcomes happen only to DISPATCHED rows. It also makes
--                                  a future claim without a plane fail closed once the compatibility branch is removed.
--
-- Historical backfill (run BEFORE the guard exists, by the migration role): every row with evidence of having entered
-- delivery processing under the single historical project is bound to 'main':
--   status = 'DISPATCHED' or dispatch_attempts > 0 or claimed_until IS NOT NULL or recovery_count > 0
--   or run_outcome IS NOT NULL or run_diagnostic IS NOT NULL or a system.outbox_runs row exists.
-- (A non-null claimed_until without an attempt is a claim whose relay may already have enqueued: conservatively MAIN.)
-- Never-claimed PENDING rows stay NULL and adopt the routing registry in effect at their first future claim. The
-- constraints are added after the backfill, so a backfill that missed any processed row aborts this migration.
--
-- Grants: app_system (the only claiming role) gains UPDATE(execution_plane); it already holds only column-level
-- UPDATE grants on system.outbox, so this does not widen any table-wide privilege. authenticated and app_worker keep
-- INSERT only (the guard keeps the column NULL for them); no other role gains anything.
--
-- Future 0012 (contract; NOT part of this migration): once no relay deployment predating this column remains, replace the
-- guard so a claim that leaves execution_plane NULL is no longer bound to 'main' — outbox_unbound_untouched then makes it
-- fail closed. The column stays nullable: NULL legitimately means never-bound work. Not to be dropped after cutover: it
-- is routing lineage.

set role app_owner;

alter table system.outbox
  add column execution_plane text,
  add constraint outbox_execution_plane_known check (execution_plane is null or execution_plane in ('main', 'integration'));

reset role;

-- ── Historical backfill (migration role; before the guard and the binding constraints exist) ─────────────────────────
-- backfill:begin
update system.outbox o
   set execution_plane = 'main'
 where o.execution_plane is null
   and (o.status = 'DISPATCHED'
        or o.dispatch_attempts > 0
        or o.claimed_until is not null
        or o.recovery_count > 0
        or o.run_outcome is not null
        or o.run_diagnostic is not null
        or exists (select 1 from system.outbox_runs r where r.outbox_id = o.id));
-- backfill:end

set role app_owner;

alter table system.outbox
  add constraint outbox_dispatched_bound check (status <> 'DISPATCHED' or execution_plane is not null),
  add constraint outbox_unbound_untouched check (
    execution_plane is not null
    or (status = 'PENDING' and dispatch_attempts = 0 and claimed_until is null and recovery_count = 0
        and run_outcome is null and run_diagnostic is null));

create function system.outbox_execution_plane_guard() returns trigger
language plpgsql volatile security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.execution_plane is not null then
      raise exception 'outbox execution plane is bound only by a delivery claim' using errcode = '42501';
    end if;
    return new;
  end if;

  if old.execution_plane is not null then
    if new.execution_plane is distinct from old.execution_plane then
      raise exception 'outbox execution plane is immutable once bound' using errcode = '42501';
    end if;
    return new;
  end if;

  if old.status = 'PENDING' and new.status = 'PENDING'
     and old.run_outcome is null and new.run_outcome is null
     and old.run_diagnostic is null and new.run_diagnostic is null
     and new.claimed_until is not null
     and (old.claimed_until is null or new.claimed_until > old.claimed_until)
     and (new.dispatch_attempts, new.next_dispatch_at, new.recovery_count, new.dispatched_at, new.last_failure_class,
          new.slo_breached_at, new.run_outcome_at, new.run_diagnostic_at)
         is not distinct from
         (old.dispatch_attempts, old.next_dispatch_at, old.recovery_count, old.dispatched_at, old.last_failure_class,
          old.slo_breached_at, old.run_outcome_at, old.run_diagnostic_at) then
    if new.execution_plane is null then
      new.execution_plane := 'main'; -- 0011 compatibility: a claim by a relay that predates this column (removed in 0012)
    end if;
    return new;
  end if;

  if new.execution_plane is not null then
    raise exception 'outbox execution plane is bound only by a delivery claim' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger outbox_execution_plane_guard before insert or update of execution_plane, claimed_until on system.outbox
  for each row execute function system.outbox_execution_plane_guard();

grant update (execution_plane) on system.outbox to app_system;

reset role;
