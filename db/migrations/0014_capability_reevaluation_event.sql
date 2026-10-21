-- 0014 · Capability re-evaluation recovery (Step 7G-H5.5-P2-B1; TA §16.1; Model §6). Forward-only and additive:
-- two closed-vocabulary widenings, ONE new CHECK and one audit-vocabulary widening. No table, column, index, policy,
-- grant, function or role changes.
--
--   connections.connected_account_events.event_type   gains 'REEVALUATION_REQUESTED': an Owner/Admin explicitly asked
--                                                      for a NEW capability evaluation of an ACTIVE account (the
--                                                      account's lifecycle is unchanged; the event is the identity of
--                                                      that request and of its dispatch key ...:reeval.{event id}).
--   connections.connected_account_events.reason_code  gains 'USER_REQUESTED_REEVALUATION'.
--   connected_account_events_reevaluation_check       a REEVALUATION_REQUESTED event is exactly a user's request:
--                                                      actor_type = 'user', reason_code = USER_REQUESTED_REEVALUATION
--                                                      and no move; that reason is used by no other event type.
--                                                      Existing rows satisfy it trivially (neither value existed), and
--                                                      the 0007 actor (user ⇔ actor_user_id) and move checks still apply.
--   audit.audit_events.action                         gains 'connected_account.capability_reevaluation_requested'.
--
-- Same values as before plus exactly these ones; existing rows are unaffected. Who may append the event is unchanged:
-- the 0007 manage_append policy (OWNER/ADMIN of the bound workspace, actor_type = 'user', actor_user_id = auth.uid())
-- already covers it, and worker_append (actor_type = 'system') can never write it because of the new CHECK.

set role app_owner;

alter table connections.connected_account_events drop constraint connected_account_events_event_type_check;
alter table connections.connected_account_events add constraint connected_account_events_event_type_check check (event_type in (
  'LINKED', 'UNLINKED', 'MOVED_OUT', 'MOVED_IN', 'DEACTIVATED', 'REEVALUATION_REQUESTED')) not valid;
alter table connections.connected_account_events validate constraint connected_account_events_event_type_check;

alter table connections.connected_account_events drop constraint connected_account_events_reason_code_check;
alter table connections.connected_account_events add constraint connected_account_events_reason_code_check check (reason_code in (
  'USER_LINKED', 'USER_UNLINKED', 'MOVE', 'CONNECTION_DISCONNECTED', 'CONNECTION_REMOVED', 'USER_REQUESTED_REEVALUATION')) not valid;
alter table connections.connected_account_events validate constraint connected_account_events_reason_code_check;

alter table connections.connected_account_events add constraint connected_account_events_reevaluation_check check (
  ((event_type = 'REEVALUATION_REQUESTED') = (reason_code = 'USER_REQUESTED_REEVALUATION'))
  and (event_type <> 'REEVALUATION_REQUESTED' or (actor_type = 'user' and move_id is null))) not valid;
alter table connections.connected_account_events validate constraint connected_account_events_reevaluation_check;

alter table audit.audit_events drop constraint audit_events_action_check;
alter table audit.audit_events add constraint audit_events_action_check check (action in (
  'organization.created', 'workspace.created', 'workspace.mode_changed',
  'workspace_membership.role_changed', 'workspace_membership.grants_changed', 'workspace_membership.removed',
  'organization_membership.role_changed', 'organization_membership.removed',
  'invitation.created', 'invitation.revoked', 'invitation.accepted',
  'connection.created', 'connection.credential_replaced', 'connection.validated', 'connection.status_changed',
  'connection.removed',
  'connected_account.linked', 'connected_account.unlinked', 'connected_account.move_requested',
  'connected_account.moved_out', 'connected_account.moved_in', 'connected_account.move_failed',
  'connected_account.move_rejected', 'connected_account.capability_reevaluation_requested')) not valid;
alter table audit.audit_events validate constraint audit_events_action_check;

reset role;
