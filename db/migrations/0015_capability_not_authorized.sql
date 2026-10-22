-- 0015 · Capability profile state NOT_AUTHORIZED (Step 7G-H5.5-P4-C; TA §16; Model §6). Forward-only and additive:
-- ONE closed-vocabulary widening and ONE new CHECK. No table, column, index, primary key, policy, grant, function or
-- role changes, and no data change.
--
--   capability.profile_entries.state         gains 'NOT_AUTHORIZED' (profile rows only; the catalog is code): the
--                                            platform supports the capability (validated catalog entry), but this
--                                            connected account currently lacks the provider authorization Wrenkind
--                                            needs. A missing authorization was stored as UNSUPPORTED before; it never
--                                            is again: UNSUPPORTED is reserved for authoritative non-support.
--   profile_entries_state_reasons            state ↔ reason coherence. Every reason a row carries must belong to its
--                                            state (cardinality 1–8 stays with profile_entries_reason_codes_check):
--                                              SUPPORTED                  CATALOG_SUPPORTED
--                                              AVAILABLE_WITH_LIMITATION  CATALOG_LIMITATION
--                                              UNSUPPORTED                CATALOG_UNSUPPORTED, OBSERVED_NOT_ELIGIBLE
--                                              NOT_AUTHORIZED             ACCOUNT_PERMISSION_MISSING, OBSERVED_PERMISSION_MISSING
--                                              UNKNOWN_NOT_VALIDATED      CATALOG_NOT_VALIDATED, ACCOUNT_FACTS_UNAVAILABLE,
--                                                                         ACCOUNT_FACTS_INCONSISTENT
--                                            So UNSUPPORTED + a permission reason and NOT_AUTHORIZED + a non-support
--                                            reason are both refused. NOT_AUTHORIZED never carries a limitation: the
--                                            0009 profile_entries_limitation_shape check already admits a limitation
--                                            only on AVAILABLE_WITH_LIMITATION.
--
-- No backfill. Both constraints are added NOT VALID and then validated: VALIDATE fails, and the migration with it, if
-- any stored row still has the old UNSUPPORTED + permission shape (none existed when this was written), so no such row
-- can survive silently. Neither catalog revision changes: no entry, capability key or scope changed.

set role app_owner;

alter table capability.profile_entries drop constraint profile_entries_state_check;
alter table capability.profile_entries add constraint profile_entries_state_check check (state in (
  'SUPPORTED', 'AVAILABLE_WITH_LIMITATION', 'UNSUPPORTED', 'NOT_AUTHORIZED', 'UNKNOWN_NOT_VALIDATED')) not valid;
alter table capability.profile_entries validate constraint profile_entries_state_check;

alter table capability.profile_entries add constraint profile_entries_state_reasons check (case state
  when 'SUPPORTED' then reason_codes <@ array['CATALOG_SUPPORTED']::text[]
  when 'AVAILABLE_WITH_LIMITATION' then reason_codes <@ array['CATALOG_LIMITATION']::text[]
  when 'UNSUPPORTED' then reason_codes <@ array['CATALOG_UNSUPPORTED', 'OBSERVED_NOT_ELIGIBLE']::text[]
  when 'NOT_AUTHORIZED' then reason_codes <@ array['ACCOUNT_PERMISSION_MISSING', 'OBSERVED_PERMISSION_MISSING']::text[]
  when 'UNKNOWN_NOT_VALIDATED' then reason_codes <@ array['CATALOG_NOT_VALIDATED', 'ACCOUNT_FACTS_UNAVAILABLE', 'ACCOUNT_FACTS_INCONSISTENT']::text[]
  else false
end) not valid;
alter table capability.profile_entries validate constraint profile_entries_state_reasons;

reset role;
