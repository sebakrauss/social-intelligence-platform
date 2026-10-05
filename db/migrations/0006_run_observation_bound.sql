-- 0006 · Bounded observation of UNKNOWN run status (R7 correction). Expand-only: new columns, grants and an
-- index; nothing is narrowed or removed.
--
-- A run whose status the job runtime can't report (UNKNOWN: not found, or an unrecognized status) is never
-- re-dispatched and never classified as FAILED, CRASHED or SYSTEM_FAILURE. The outcome sweeper re-checks it
-- only within an explicit bound (configured checks / seconds); past the bound the row enters an explicit
-- operational diagnostic state, is alerted once and is no longer polled. Its run outcome stays NULL (it is
-- genuinely unknown), and the vendor run ID and the full run history are kept for diagnosis.
--
--   system.outbox_runs   + unknown_checks / first_unknown_at: the current streak of consecutive UNKNOWN
--                          observations of that run (reset when a known status is observed)
--   system.outbox        + run_diagnostic / run_diagnostic_at: 'OBSERVATION_EXHAUSTED' once the bound is hit

set role app_owner;

alter table system.outbox_runs
  add column unknown_checks   integer not null default 0 check (unknown_checks >= 0),
  add column first_unknown_at timestamptz,
  add constraint outbox_runs_unknown_streak check ((unknown_checks = 0) = (first_unknown_at is null));

alter table system.outbox
  add column run_diagnostic    text check (run_diagnostic in ('OBSERVATION_EXHAUSTED')),
  add column run_diagnostic_at timestamptz,
  add constraint outbox_diagnostic_recorded check ((run_diagnostic is null) = (run_diagnostic_at is null)),
  add constraint outbox_diagnostic_without_outcome check (run_diagnostic is null or run_outcome is null);

-- The outcome sweeper polls only rows without an outcome AND without a diagnostic.
create index outbox_observable on system.outbox (dispatched_at)
  where status = 'DISPATCHED' and run_outcome is null and run_diagnostic is null;

grant update (run_diagnostic, run_diagnostic_at) on system.outbox to app_system;
grant update (unknown_checks, first_unknown_at) on system.outbox_runs to app_system;

reset role;
