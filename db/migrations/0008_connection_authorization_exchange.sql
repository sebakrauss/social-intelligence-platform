-- 0008 · Authorization-code exchange coordination (Step 5D; TA §39; 5D decision B2).
-- Forward-only and expand-only. The connect-attempt state machine gains the states that make the
-- out-of-transaction code exchange durably claimable BEFORE the provider call (exactly-once):
--
--   PENDING ──claim──▶ EXCHANGING ──▶ COMPLETED          credential sealed and stored, connection created/updated
--                                 ├─▶ EXCHANGE_FAILED    definite failure (closed failure_code); restart required
--                                 └─▶ OUTCOME_UNKNOWN    the provider may have consumed the code; never replayed
--   PENDING ──▶ DENIED | EXPIRED | CANCELLED            (unchanged)
--
-- EXCHANGING is an INTERMEDIATE state: its claim is exchange_started_at, and closed_at stays NULL until a terminal
-- transition. 0007's closed_recorded CHECK assumed every non-PENDING state was terminal; it is rewritten (exact,
-- pinned in the migration lint) so that PENDING and EXCHANGING are exactly the open states — identical for every
-- pre-0008 status:
--
--   status            exchange_started_at   closed_at          failure_code
--   PENDING           null                  null               null
--   EXCHANGING        set                   null               null
--   COMPLETED         set                   set                null
--   EXCHANGE_FAILED   set                   set                set
--   OUTCOME_UNKNOWN   set                   set                null
--   DENIED / EXPIRED / CANCELLED   null      set                null
--
-- Nothing secret is added: no authorization code, no code envelope and no PKCE verifier (Step 5D decision B1 derives
-- the verifier statelessly). The 0007 PKCE columns stay unused and reserved.

set role app_owner;

-- Status vocabulary: widened only (verified widening: drop → same-name re-add NOT VALID → validate).
alter table connections.connect_attempts drop constraint connect_attempts_status_check;
alter table connections.connect_attempts add constraint connect_attempts_status_check check (status in (
  'PENDING', 'COMPLETED', 'DENIED', 'EXPIRED', 'CANCELLED', 'EXCHANGING', 'EXCHANGE_FAILED', 'OUTCOME_UNKNOWN')) not valid;
alter table connections.connect_attempts validate constraint connect_attempts_status_check;

-- Open states: PENDING and EXCHANGING (pinned rewrite of 0007's (status = 'PENDING') = (closed_at is null)).
alter table connections.connect_attempts drop constraint connect_attempts_closed_recorded;
alter table connections.connect_attempts add constraint connect_attempts_closed_recorded check ((status in ('PENDING', 'EXCHANGING')) = (closed_at is null)) not valid;
alter table connections.connect_attempts validate constraint connect_attempts_closed_recorded;

alter table connections.connect_attempts add column exchange_started_at timestamptz;
alter table connections.connect_attempts add column failure_code text check (failure_code in (
  'CREDENTIAL_INVALID', 'PERMISSION_MISSING', 'REQUEST_REJECTED', 'PROVIDER_UNAVAILABLE', 'RATE_LIMITED',
  'CREDENTIAL_NOT_STORED', 'CONNECTION_UNAVAILABLE'));

-- Exactly the states reached through a claimed exchange carry its start time; nothing else does.
alter table connections.connect_attempts add constraint connect_attempts_exchange_recorded check (
  (status in ('EXCHANGING', 'COMPLETED', 'EXCHANGE_FAILED', 'OUTCOME_UNKNOWN')) = (exchange_started_at is not null));
-- A definite exchange failure always says why (closed code); no other state carries a failure code.
alter table connections.connect_attempts add constraint connect_attempts_failure_recorded check (
  (status = 'EXCHANGE_FAILED') = (failure_code is not null));
-- The claim happens inside the attempt's lifetime.
alter table connections.connect_attempts add constraint connect_attempts_exchange_in_lifetime check (
  exchange_started_at is null or (exchange_started_at >= created_at and exchange_started_at <= expires_at));

create index connect_attempts_exchanging on connections.connect_attempts (workspace_id, created_by)
  where status = 'EXCHANGING';

reset role;

-- The web (the attempt's creator, Owner/Admin, under the 0007 creator_update policy) claims and closes attempts.
grant update (exchange_started_at, failure_code) on connections.connect_attempts to authenticated;
