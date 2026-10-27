-- 0016 · Capability limitation REPLIES_NOT_READ (Step 7G-H5.5-P12-D2a; design P12-D1; TA §16; Model §6). Forward-only
-- and additive: ONE closed-vocabulary widening. No table, column, index, primary key, policy, grant, function or role
-- changes, and no data change.
--
--   capability.profile_entries.limitation_code   gains 'REPLIES_NOT_READ' (profile rows only; the catalog is code):
--                                                Wrenkind reads the top-level comments of this capability and scope,
--                                                but does not read their replies. It is a limitation of an available
--                                                capability, never a claim that the platform lacks replies (that would
--                                                be UNSUPPORTED, which needs authoritative negative evidence).
--
-- Unchanged: NULL stays admitted (no limitation); every earlier code stays admitted; any other value stays refused. The
-- 0009 shape checks still hold a limitation exactly on AVAILABLE_WITH_LIMITATION (profile_entries_limitation_shape) and
-- a value only with a code (profile_entries_limitation_value); 0015's state ↔ reason coherence is untouched. One
-- limitation per row, as before.
--
-- No backfill: no stored row carries the new code (no catalog entry names it yet; catalog r5 is a later gate and must
-- not be released before this migration is applied). The constraint is re-added NOT VALID and then validated, so the
-- migration fails if any stored row were outside the widened set. Neither catalog revision changes.

set role app_owner;

alter table capability.profile_entries drop constraint profile_entries_limitation_code_check;
alter table capability.profile_entries add constraint profile_entries_limitation_code_check check (limitation_code in (
  'HISTORY_DEPTH_LIMITED', 'HIDE_VISIBLE_TO_AUTHOR', 'REPLIES_NOT_READ')) not valid;
alter table capability.profile_entries validate constraint profile_entries_limitation_code_check;

reset role;
