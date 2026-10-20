-- 0013 · Capability vocabulary: read_content (Step 7G-H5.5; TA §16; Model §6). Forward-only and additive: ONE exact
-- pinned rewrite of a closed vocabulary. No table, column, policy, grant, function or role changes.
--
--   capability.profile_entries.capability  gains 'read_content': importing an account's top-level content (posts,
--                                          reels, videos…) is its own provider operation (listContent / getContent)
--                                          and permission, distinct from reading the conversation under it
--                                          (read_interactions). Same values as 0009 plus exactly this one.
--
-- Existing rows are unaffected (every stored value stays admitted). Profiles evaluated before this vocabulary rest on
-- catalog revision 1 and are stale by revision from Step 7G-H5.5 on: the application refuses them as PROFILE_STALE
-- and requests their re-evaluation; nothing is rewritten here (derived state is recomputed, never patched).

set role app_owner;

alter table capability.profile_entries drop constraint profile_entries_capability_check;
alter table capability.profile_entries add constraint profile_entries_capability_check check (capability in (
  'read_content', 'read_interactions', 'read_history', 'read_paid_context', 'reply_public', 'reply_private', 'hide',
  'delete', 'block', 'detect_native_replies')) not valid;
alter table capability.profile_entries validate constraint profile_entries_capability_check;

reset role;
