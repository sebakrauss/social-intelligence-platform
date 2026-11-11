-- 0028 · One-time LIVE validation authorizations (Step 7B-14F1; design 7B-14B alternative B). Forward-only and
-- expand-only: ONE new table in the executor's schema, ONE nullable column on mutations.mutation_intents with its keys,
-- ONE unique index on connections.connected_accounts (the platform-coherence key), three trigger functions and their
-- policies and grants. No existing column, constraint, policy or grant is narrowed; nothing is backfilled or rewritten.
--
-- INERT BY CONSTRUCTION. Nothing here makes a capability AVAILABLE, grants mutation.provider_action, or lets an executor
-- skip a guard: the table only RECORDS an operator's bounded permission and makes its single use durable. Whether (and
-- how) an executor may honour one is decided by a later, separately reviewed gate. Code that does not know the column
-- never writes it (NULL), so no intent of an earlier generation can ever be bound to, or consume, an authorization.
--
--   mutations.validation_authorizations
--       ONE operator's permission to validate ONE operation — meta + instagram + reply_public — on exactly ONE target
--       interaction of ONE connected account in ONE workspace, requested by exactly ONE named member (the initiator who
--       will press Send). It carries the operator's identity and reason (transaction-local declarations, as for the
--       operational switches), a reference to the PREFLIGHT evidence (run reference and completion time), and a
--       lifetime of at most 2 hours (no authorization without expiry). It holds identifiers and timestamps only: no
--       token, no secret, no comment text. Runtime roles never write it: issued and revoked by the privileged operator
--       tooling only; bound and consumed only by the two intent triggers below.
--
--   Lifecycle (every step write-once; nothing is ever un-set):
--       ISSUED ──bind──▶ BOUND ──consume──▶ CONSUMED
--         │               │
--         └───revoke──────┴──▶ REVOKED          (expiry is time: past expires_at nothing binds or consumes)
--
--     bind     an intent INSERTED with validation_authorization_id (AFTER INSERT trigger, same transaction): the
--              authorization row is locked FOR UPDATE, must be live (not revoked, not expired, never bound) and the
--              intent must be PENDING; it then records intent_id + bound_at. One intent per authorization (partial UNIQUE
--              index on the intent side + UNIQUE intent_id on this side); one authorization per intent (a single column,
--              immutable). Scope coherence is declarative: a composite foreign key from the intent to (workspace, id,
--              account, target, initiator, kind) of the authorization — a different workspace, account, target,
--              initiator or operation fails exactly like a non-existent authorization (23503, R5: no existence oracle).
--     consume  the intent's transition INTO EXECUTING (BEFORE UPDATE trigger, the executor's R6 commit BEFORE the
--              provider call): the authorization is locked FOR UPDATE, must still be bound to THIS intent, unrevoked,
--              unexpired and never consumed; it records consumed_at in the SAME transaction as EXECUTING. Any later
--              transition into EXECUTING (a retry after an uncertain outcome, a redelivered run) is refused. An
--              authorized intent follows exactly the intent model's transitions, enters EXECUTING only from PENDING, and
--              reaches CONFIRMED / FAILED / OUTCOME_UNKNOWN only once consumed (Step 7B-14F2, A).
--     revoke   operator only, before consumption (bound or not). After consumption revocation is refused: it cannot stop
--              a call that may already have reached the provider.
--     reissue  a new authorization for a target needs no OPEN one there and NONE ever CONSUMED there (Step 7B-14F2, B:
--              one consumed authorization per target, for ever; a later validation uses another comment). An expired or
--              revoked authorization that was never consumed does not block re-issuance. Issuance runs only under
--              READ COMMITTED (Step 7B-14F2, C).
--
--   THE BOUNDARY (documented, not hidden): the provider call is OUTSIDE every database transaction. Consumption commits
--   with EXECUTING before the call (R6), so a lost response, a timeout, a crash or a FAILED/OUTCOME_UNKNOWN outcome all
--   leave the authorization CONSUMED — it is never recovered, re-bound or re-armed. The converse race is NOT closed here:
--   a revocation committed after EXECUTING cannot recall a call already in flight (PRE-LIVE-1 stays open).
--
-- Every guarantee above is a database invariant (constraints, unique indexes, row locks, triggers): none depends on an
-- in-memory lock or on application discipline.

set role app_owner;

-- The platform-coherence key the authorization references: a connected account's own (workspace, id, platform) triple.
-- Expand-only on the connections module's table (no column, policy or grant change); unique because (workspace_id, id)
-- already is.
create unique index connected_accounts_workspace_platform_key on connections.connected_accounts (workspace_id, id, platform);

-- ── mutations.validation_authorizations ─────────────────────────────────────────────────────────────────────────
create table mutations.validation_authorizations (
  id                      uuid not null,
  organization_id         uuid not null,
  workspace_id            uuid not null,
  connected_account_id    uuid not null,
  target_interaction_id   uuid not null,
  -- The ONE member who may request the validated intent (the human who presses Send; S8).
  initiator_user_id       uuid not null,
  -- The exact operation: meta + instagram + reply_public. Nothing generic.
  provider                text not null check (provider in ('meta')),
  platform                text not null check (platform in ('instagram')),
  kind                    text not null check (kind in ('reply_public')),
  -- The PREFLIGHT evidence the operator relied on (the run reference only: never its content).
  preflight_run_reference text not null check (preflight_run_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  preflight_completed_at  timestamptz not null,
  -- Who issued it and why (from the transaction-local operator declaration; the guard refuses without one).
  issued_by               text not null check (issued_by ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$'),
  issue_reason            text not null check (issue_reason in ('live_validation', 'test')),
  issued_at               timestamptz not null default pg_catalog.now(),
  expires_at              timestamptz not null,
  revoked_at              timestamptz,
  revoked_by              text check (revoked_by ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$'),
  revocation_reason       text check (revocation_reason in ('incident', 'rollback', 'maintenance', 'superseded', 'test')),
  intent_id               uuid,
  bound_at                timestamptz,
  consumed_at             timestamptz,
  primary key (workspace_id, id),
  -- At most 2 hours, never open-ended (the operational value is 60 minutes; the tooling picks it).
  constraint validation_authorizations_lifetime check (expires_at > issued_at and expires_at <= issued_at + interval '2 hours'),
  constraint validation_authorizations_preflight_first check (preflight_completed_at <= issued_at),
  constraint validation_authorizations_revocation_shape check (
    (revoked_at is null) = (revoked_by is null) and (revoked_at is null) = (revocation_reason is null)
    and (revoked_at is null or revoked_at >= issued_at)),
  constraint validation_authorizations_binding_shape check (
    (intent_id is null) = (bound_at is null) and (bound_at is null or (bound_at >= issued_at and bound_at < expires_at))),
  constraint validation_authorizations_consumption_shape check (
    consumed_at is null or (bound_at is not null and consumed_at >= bound_at and consumed_at < expires_at)),
  -- A revoked authorization is never consumed, and a consumed one is never revoked.
  constraint validation_authorizations_consumed_or_revoked check (consumed_at is null or revoked_at is null),
  -- One intent per authorization, from this side too.
  constraint validation_authorizations_one_intent unique (workspace_id, intent_id),
  -- Referenced by the intent: an intent names exactly its authorization's account, target, initiator and operation.
  constraint validation_authorizations_scope unique (workspace_id, id, connected_account_id, target_interaction_id, initiator_user_id, kind),
  constraint validation_authorizations_workspace foreign key (organization_id, workspace_id) references tenancy.workspaces (organization_id, id) on delete cascade,
  -- The account is THIS workspace's and is an Instagram account (composite keys, R5).
  constraint validation_authorizations_account foreign key (workspace_id, connected_account_id, platform)
    references connections.connected_accounts (workspace_id, id, platform),
  -- The target is THIS workspace's canonical interaction OWNED by that account.
  constraint validation_authorizations_target foreign key (workspace_id, target_interaction_id, connected_account_id)
    references interactions.interactions (workspace_id, id, connected_account_id)
);
create index validation_authorizations_by_target on mutations.validation_authorizations (workspace_id, target_interaction_id, issued_at);

alter table mutations.validation_authorizations enable row level security;
alter table mutations.validation_authorizations force row level security;

-- ── The intent's binding: ONE nullable column, its keys, and its one-per-authorization index ─────────────────────
-- NULL for every ordinary intent (and for every intent written by code that does not know the column): the ordinary
-- request and execution contract is unchanged.
alter table mutations.mutation_intents add column validation_authorization_id uuid;
-- Scope coherence (R5): the intent's workspace, account, target, initiator and kind are the authorization's own. A
-- composite key with a NULL member is not checked, so ordinary intents are untouched.
alter table mutations.mutation_intents add constraint mutation_intents_validation_scope
  foreign key (workspace_id, validation_authorization_id, connected_account_id, target_interaction_id, initiator_user_id, kind)
  references mutations.validation_authorizations (workspace_id, id, connected_account_id, target_interaction_id, initiator_user_id, kind);
-- The key the authorization's back-reference uses: the intent's own (workspace, id, authorization) triple.
alter table mutations.mutation_intents add constraint mutation_intents_validation_binding unique (workspace_id, id, validation_authorization_id);
-- One intent per authorization: a second intent naming it is a unique violation, whatever the timing (the index entry
-- of a concurrent uncommitted insert makes the second wait, then fail).
create unique index mutation_intents_one_per_validation_authorization on mutations.mutation_intents (workspace_id, validation_authorization_id)
  where validation_authorization_id is not null;
-- The back-reference names an intent that names THIS authorization (both directions coherent).
alter table mutations.validation_authorizations add constraint validation_authorizations_intent
  foreign key (workspace_id, intent_id, id) references mutations.mutation_intents (workspace_id, id, validation_authorization_id);
-- Step 7B-14F2 (B), declarative backstop: at most ONE consumed authorization per target and operation, for ever (the
-- issuance guard refuses a new one first). It only ever covers consumed rows, so an expired or revoked authorization
-- that was never consumed blocks nothing.
create unique index validation_authorizations_one_consumed_per_target on mutations.validation_authorizations (workspace_id, target_interaction_id, kind)
  where consumed_at is not null;

-- ── The authorization's own guard (every write, every role) ──────────────────────────────────────────────────────
-- SECURITY INVOKER: issuance and revocation run as the privileged operator tooling (no runtime role holds INSERT,
-- UPDATE or DELETE); binding and consumption run inside the two definer triggers below (as the owner, through the owner
-- policies). It reads OLD/NEW, and — on issuance only — the account, its connection, the initiator's membership and the
-- target's other authorizations.
--   INSERT  needs app.operator_id and app.change_reason (as the switch tooling); issued_by / issue_reason must equal
--           them (filled when omitted); issued_at is the transaction's time; nothing bound, consumed or revoked; not
--           already expired; the account is ACTIVE on a Meta connection; the initiator is a member with a replying role
--           (the `reply.public` roles); no other OPEN authorization (unrevoked, unconsumed, unexpired) exists for the
--           same target; and NO authorization was ever CONSUMED for the same target and operation (Step 7B-14F2, B: one
--           consumed authorization per target, for ever — whatever the intent's outcome, provider id or not, revoked or
--           expired since, other initiator or reason; a later validation uses another comment; no override exists).
--           Both checks run after a transaction-scoped advisory lock per target, and ONLY under READ COMMITTED
--           (Step 7B-14F2, C): there each query of this VOLATILE function takes a fresh snapshot, so the check after
--           the lock sees every authorization committed before it; under REPEATABLE READ or SERIALIZABLE the snapshot
--           predates the lock and two issuers could both pass, so issuance is refused there (never silently changed).
--   UPDATE  the scope, the operator attribution, the preflight reference and the lifetime never change; every state
--           field is write-once. Binding and consumption happen only from the intent triggers (trigger depth > 1);
--           revocation only directly (depth 1), declared (operator + reason), before consumption.
--   DELETE  refused while the workspace exists (an authorization is revoked, never erased); the tenant-removal cascade
--           passes. A bound one is also held by the intent's foreign key.
create function mutations.validation_authorization_guard() returns trigger
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_operator text := nullif(pg_catalog.current_setting('app.operator_id', true), '');
  v_reason   text := nullif(pg_catalog.current_setting('app.change_reason', true), '');
  v_now      timestamptz := pg_catalog.clock_timestamp();
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from tenancy.workspaces w where w.id = old.workspace_id) then
      raise exception 'a validation authorization is revoked, never deleted' using errcode = '42501';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
      raise exception 'a validation authorization is issued only under READ COMMITTED' using errcode = '25000';
    end if;
    if v_operator is null or v_reason is null then
      raise exception 'issuing a validation authorization requires app.operator_id and app.change_reason' using errcode = '42501';
    end if;
    if pg_catalog.pg_trigger_depth() > 1 then
      raise exception 'a validation authorization is issued directly by the operator tooling' using errcode = '42501';
    end if;
    if (new.issued_by is not null and new.issued_by <> v_operator) or (new.issue_reason is not null and new.issue_reason <> v_reason) then
      raise exception 'issued_by and issue_reason are the declared operator and reason' using errcode = '42501';
    end if;
    new.issued_by := v_operator;
    new.issue_reason := v_reason;
    if new.issued_at is distinct from pg_catalog.now() then
      raise exception 'issued_at is the issuing transaction''s time' using errcode = '42501';
    end if;
    if new.intent_id is not null or new.bound_at is not null or new.consumed_at is not null
       or new.revoked_at is not null or new.revoked_by is not null or new.revocation_reason is not null then
      raise exception 'a validation authorization is issued unbound, unconsumed and unrevoked' using errcode = '42501';
    end if;
    if new.expires_at <= v_now then
      raise exception 'a validation authorization is issued unexpired' using errcode = '42501';
    end if;
    if not exists (
      select 1 from connections.connected_accounts a join connections.connections c on c.workspace_id = a.workspace_id and c.id = a.connection_id
       where a.workspace_id = new.workspace_id and a.id = new.connected_account_id
         and a.platform = new.platform and a.status = 'ACTIVE' and c.provider = new.provider) then
      raise exception 'the account is not an active account of that provider and platform' using errcode = '42501';
    end if;
    if not exists (
      select 1 from tenancy.workspace_memberships m
       where m.workspace_id = new.workspace_id and m.user_id = new.initiator_user_id
         and m.role in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER')) then
      raise exception 'the initiator is not a replying member of the workspace' using errcode = '42501';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'mutations.validation_authorization:' || new.workspace_id::text || ':' || new.target_interaction_id::text, 0));
    if exists (
      select 1 from mutations.validation_authorizations v
       where v.workspace_id = new.workspace_id and v.target_interaction_id = new.target_interaction_id
         and v.revoked_at is null and v.consumed_at is null and v.expires_at > v_now) then
      raise exception 'another open validation authorization exists for this target' using errcode = '23505';
    end if;
    if exists (
      select 1 from mutations.validation_authorizations v
       where v.workspace_id = new.workspace_id and v.target_interaction_id = new.target_interaction_id
         and v.kind = new.kind and v.consumed_at is not null) then
      raise exception 'a validation authorization was already consumed for this target' using errcode = '23505';
    end if;
    return new;
  end if;

  -- UPDATE: scope, attribution, evidence and lifetime are immutable.
  if new.id is distinct from old.id or new.organization_id is distinct from old.organization_id
     or new.workspace_id is distinct from old.workspace_id or new.connected_account_id is distinct from old.connected_account_id
     or new.target_interaction_id is distinct from old.target_interaction_id or new.initiator_user_id is distinct from old.initiator_user_id
     or new.provider is distinct from old.provider or new.platform is distinct from old.platform or new.kind is distinct from old.kind
     or new.preflight_run_reference is distinct from old.preflight_run_reference or new.preflight_completed_at is distinct from old.preflight_completed_at
     or new.issued_by is distinct from old.issued_by or new.issue_reason is distinct from old.issue_reason
     or new.issued_at is distinct from old.issued_at or new.expires_at is distinct from old.expires_at then
    raise exception 'a validation authorization''s scope, attribution, evidence and lifetime never change' using errcode = '42501';
  end if;
  -- Every state field is write-once.
  if (old.intent_id is not null and new.intent_id is distinct from old.intent_id)
     or (old.bound_at is not null and new.bound_at is distinct from old.bound_at)
     or (old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at)
     or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at)
     or (old.revoked_by is not null and new.revoked_by is distinct from old.revoked_by)
     or (old.revocation_reason is not null and new.revocation_reason is distinct from old.revocation_reason) then
    raise exception 'a validation authorization''s state is write-once' using errcode = '42501';
  end if;
  -- Binding and consumption: only from the intent triggers.
  if (old.intent_id is null and new.intent_id is not null) or (old.consumed_at is null and new.consumed_at is not null) then
    if pg_catalog.pg_trigger_depth() < 2 then
      raise exception 'a validation authorization is bound and consumed only through its intent' using errcode = '42501';
    end if;
  end if;
  -- Revocation: only directly, declared, before consumption.
  if old.revoked_at is null and new.revoked_at is not null then
    if pg_catalog.pg_trigger_depth() > 1 then
      raise exception 'a validation authorization is revoked directly by the operator tooling' using errcode = '42501';
    end if;
    if v_operator is null or v_reason is null then
      raise exception 'revoking a validation authorization requires app.operator_id and app.change_reason' using errcode = '42501';
    end if;
    if old.consumed_at is not null then
      raise exception 'a consumed validation authorization cannot be revoked' using errcode = '42501';
    end if;
    if (new.revoked_by is not null and new.revoked_by <> v_operator) or (new.revocation_reason is not null and new.revocation_reason <> v_reason) then
      raise exception 'revoked_by and revocation_reason are the declared operator and reason' using errcode = '42501';
    end if;
    if new.revoked_at is distinct from pg_catalog.now() then
      raise exception 'revoked_at is the revoking transaction''s time' using errcode = '42501';
    end if;
    new.revoked_by := v_operator;
    new.revocation_reason := v_reason;
  elsif old.revoked_at is null and (new.revoked_by is not null or new.revocation_reason is not null) then
    raise exception 'a revocation records its time, operator and reason together' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function mutations.validation_authorization_guard() from public;
create trigger validation_authorization_guard before insert or update or delete on mutations.validation_authorizations
  for each row execute function mutations.validation_authorization_guard();

-- ── bind: an intent inserted WITH an authorization reserves it, atomically, in the same transaction ───────────────
-- AFTER INSERT (the intent row exists for the back-reference). The authorization row is locked FOR UPDATE: a concurrent
-- binder waits and then sees it bound; a concurrent revocation either committed first (seen) or waits for this one.
create function mutations.bind_validation_authorization() returns trigger
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_now  timestamptz := pg_catalog.clock_timestamp();
  v_auth record;
begin
  select v.* into v_auth from mutations.validation_authorizations v
   where v.workspace_id = new.workspace_id and v.id = new.validation_authorization_id
   for update;
  if not found then
    raise exception 'unknown validation authorization' using errcode = '23503';
  end if;
  if v_auth.connected_account_id <> new.connected_account_id or v_auth.target_interaction_id <> new.target_interaction_id
     or v_auth.initiator_user_id <> new.initiator_user_id or v_auth.kind <> new.kind then
    raise exception 'unknown validation authorization' using errcode = '23503';
  end if;
  if new.status <> 'PENDING' or new.attempt <> 0 then
    raise exception 'a validation authorization binds a PENDING intent only' using errcode = '42501';
  end if;
  if v_auth.intent_id is not null then
    raise exception 'the validation authorization is already bound' using errcode = '23505';
  end if;
  if v_auth.revoked_at is not null then
    raise exception 'the validation authorization is revoked' using errcode = '42501';
  end if;
  if v_now >= v_auth.expires_at then
    raise exception 'the validation authorization is expired' using errcode = '42501';
  end if;
  update mutations.validation_authorizations set intent_id = new.id, bound_at = v_now
   where workspace_id = new.workspace_id and id = new.validation_authorization_id;
  return null;
end
$$;
revoke all on function mutations.bind_validation_authorization() from public;
create trigger bind_validation_authorization after insert on mutations.mutation_intents
  for each row when (new.validation_authorization_id is not null) execute function mutations.bind_validation_authorization();

-- ── consume: the transition INTO EXECUTING spends the authorization, in the same transaction, before the call ──────
-- BEFORE UPDATE (every update, every role — the privileged tooling included): the binding column is immutable for
-- everyone. Ordinary intents (NULL) pass unchanged. For an AUTHORIZED intent every status change is checked against the
-- authorization, locked FOR UPDATE (Step 7B-14F2, A):
--   * EXECUTING is entered exactly once, ONLY from PENDING (never from BLOCKED or any other status), while the
--     authorization is bound to it, unconsumed, unrevoked and unexpired; that transition records consumed_at.
--   * every other change must be one of the intent model's own transitions (mutations/domain/intent.ts TRANSITIONS):
--     PENDING → BLOCKED; EXECUTING → CONFIRMED | FAILED | BLOCKED | OUTCOME_UNKNOWN; OUTCOME_UNKNOWN → CONFIRMED | FAILED.
--     Nothing leaves CONFIRMED, FAILED or BLOCKED.
--   * CONFIRMED, FAILED and OUTCOME_UNKNOWN presuppose a provider attempt: they need the authorization CONSUMED (so
--     PENDING → CONFIRMED / FAILED / OUTCOME_UNKNOWN, which would skip EXECUTING, is refused).
--   Consumption is irreversible: no transition clears it (the authorization's guard keeps consumed_at write-once).
create function mutations.consume_validation_authorization() returns trigger
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_now  timestamptz := pg_catalog.clock_timestamp();
  v_auth record;
begin
  if new.validation_authorization_id is distinct from old.validation_authorization_id then
    raise exception 'an intent''s validation authorization never changes' using errcode = '42501';
  end if;
  if new.validation_authorization_id is null or new.status = old.status then
    return new;
  end if;
  select v.* into v_auth from mutations.validation_authorizations v
   where v.workspace_id = new.workspace_id and v.id = new.validation_authorization_id
   for update;
  if not found or v_auth.intent_id is distinct from new.id then
    raise exception 'the validation authorization is not bound to this intent' using errcode = '42501';
  end if;
  if new.status = 'EXECUTING' then
    if v_auth.consumed_at is not null then
      raise exception 'the validation authorization is already consumed' using errcode = '42501';
    end if;
    if old.status <> 'PENDING' then
      raise exception 'an authorized intent enters EXECUTING only from PENDING' using errcode = '42501';
    end if;
    if v_auth.revoked_at is not null then
      raise exception 'the validation authorization is revoked' using errcode = '42501';
    end if;
    if v_now >= v_auth.expires_at then
      raise exception 'the validation authorization is expired' using errcode = '42501';
    end if;
    update mutations.validation_authorizations set consumed_at = v_now
     where workspace_id = new.workspace_id and id = new.validation_authorization_id;
    return new;
  end if;
  if new.status in ('CONFIRMED', 'FAILED', 'OUTCOME_UNKNOWN') and v_auth.consumed_at is null then
    raise exception 'an authorized intent reaches a provider outcome only after consuming its authorization' using errcode = '42501';
  end if;
  if not ((old.status = 'PENDING' and new.status = 'BLOCKED')
       or (old.status = 'EXECUTING' and new.status in ('CONFIRMED', 'FAILED', 'BLOCKED', 'OUTCOME_UNKNOWN'))
       or (old.status = 'OUTCOME_UNKNOWN' and new.status in ('CONFIRMED', 'FAILED'))) then
    raise exception 'not a transition of an authorized intent' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function mutations.consume_validation_authorization() from public;
create trigger consume_validation_authorization before update on mutations.mutation_intents
  for each row execute function mutations.consume_validation_authorization();

reset role;

-- ── Policies ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- Members: only the designated initiator, in the BOUND workspace, with a replying role, reads their own authorization
-- (a later request needs its identifier); everyone else — other members, analysts, guests, other workspaces — reads
-- nothing. The bound worker reads its workspace's rows (a later executor re-check). The owner reads and transitions
-- through the two definer triggers only (the guard decides what a transition may change). No runtime role writes.
create policy member_read on mutations.validation_authorizations for select to authenticated
  using (workspace_id = (select app.current_workspace())
         and initiator_user_id = (select auth.uid())
         and app.my_workspace_role(workspace_id) in ('OWNER', 'ADMIN', 'MANAGER', 'RESPONDER'));
create policy worker_read on mutations.validation_authorizations for select to app_worker
  using (workspace_id = (select app.current_workspace()));
create policy owner_read on mutations.validation_authorizations for select to app_owner using (true);
create policy owner_transition on mutations.validation_authorizations for update to app_owner using (true) with check (true);

-- ── Grants (explicit, least privilege: read only; no runtime INSERT, UPDATE or DELETE) ─────────────────────────────
set role app_owner;

grant select on mutations.validation_authorizations to authenticated, app_worker;

reset role;
