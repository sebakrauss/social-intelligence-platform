/**
 * Schema classification (TA §11.1.1, §54, §64; R4). Every table in a schema this application owns must be
 * listed here with its isolation class, the exact policies it carries and the exact privileges each
 * non-owner role holds. Introspection tests compare the live catalog against this registry: an
 * unclassified table, a missing FORCE ROW LEVEL SECURITY, an extra policy or an unexpected grant fails CI.
 *
 * Privileges are written as "SELECT", "INSERT", "UPDATE", "DELETE" (table level) or "UPDATE(column)".
 * Policies are written as "<name> <command> <role,…>".
 */

export const TABLE_CLASSES = [
  /** Organization-level rows: readable by the organization's members, managed by its Owners/Admins. */
  "organization",
  /** Workspace-scoped tenant rows (the primary isolation boundary). */
  "workspace_tenant",
  /** Append-only history: INSERT only for runtime roles; never UPDATE or DELETE. */
  "append_only_history",
  /** System metadata (identifiers only); no user reads. */
  "system",
  /** Secrets readable only by the owner through reviewed definer functions. */
  "privileged",
  /** Migration bookkeeping, owned by the migration role; no runtime access. */
  "migration_ledger",
  /** Operational configuration (flags, kill switches): readable by runtimes, written only by operators. */
  "operational_config",
  /** TEST ONLY: the T-26 isolation fixture (never created by migrations). */
  "test_fixture",
] as const;
export type TableClass = (typeof TABLE_CLASSES)[number];

export type RuntimeGrantee = "authenticated" | "app_worker" | "app_system";

export interface TableClassification {
  readonly class: TableClass;
  readonly policies: readonly string[];
  readonly privileges: Readonly<Partial<Record<RuntimeGrantee, readonly string[]>>>;
}

const ALL_DML = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

/** Schemas owned by this application. Any other schema owned by app_owner fails the classification test. */
export const APPLICATION_SCHEMAS = ["app", "app_private", "tenancy", "audit", "system", "idempotency", "app_migrations", "t26_fixture"] as const;

/** Schema USAGE per runtime role (no other role may hold USAGE or CREATE). */
export const SCHEMA_USAGE: Readonly<Record<(typeof APPLICATION_SCHEMAS)[number], readonly RuntimeGrantee[]>> = {
  app: ["authenticated", "app_worker"],
  app_private: [],
  tenancy: ["authenticated", "app_worker"],
  audit: ["authenticated", "app_worker"],
  system: ["authenticated", "app_worker", "app_system"],
  idempotency: ["app_worker"],
  app_migrations: [],
  t26_fixture: ["authenticated", "app_worker"],
};

export const TABLE_CLASSIFICATION: Readonly<Record<string, TableClassification>> = {
  "app_private.context_secret": {
    class: "privileged",
    policies: ["owner_read SELECT app_owner"],
    privileges: {},
  },
  "app_migrations.applied": {
    class: "migration_ledger",
    policies: [],
    privileges: {},
  },
  "tenancy.organizations": {
    class: "organization",
    policies: ["create_organization INSERT authenticated", "member_read SELECT authenticated", "owner_read SELECT app_owner"],
    privileges: { authenticated: ["INSERT", "SELECT"] },
  },
  "tenancy.workspaces": {
    class: "workspace_tenant",
    policies: [
      "create_workspace INSERT authenticated",
      "manage_bound_workspace UPDATE authenticated",
      "member_read SELECT authenticated",
      "owner_read SELECT app_owner",
      "worker_bound_workspace SELECT app_worker",
    ],
    privileges: { authenticated: ["INSERT", "SELECT", "UPDATE(mode)"], app_worker: ["SELECT"] },
  },
  "tenancy.organization_memberships": {
    class: "organization",
    policies: [
      "join_self INSERT authenticated",
      "manage UPDATE authenticated",
      "owner_read SELECT app_owner",
      "read_own_or_managed SELECT authenticated",
      "remove DELETE authenticated",
    ],
    privileges: { authenticated: ["DELETE", "INSERT", "SELECT", "UPDATE(role)"] },
  },
  "tenancy.workspace_memberships": {
    class: "workspace_tenant",
    policies: [
      "join_self INSERT authenticated",
      "manage_bound_workspace UPDATE authenticated",
      "owner_read SELECT app_owner",
      "read_own_or_managed SELECT authenticated",
      "remove DELETE authenticated",
    ],
    privileges: { authenticated: ["DELETE", "INSERT", "SELECT", "UPDATE(grants)", "UPDATE(role)"] },
  },
  "tenancy.invitations": {
    class: "organization",
    policies: [
      "invite INSERT authenticated",
      "managed_or_presented SELECT authenticated",
      "owner_read SELECT app_owner",
      "revoke_or_accept UPDATE authenticated",
    ],
    privileges: { authenticated: ["INSERT", "SELECT", "UPDATE(accepted_by)", "UPDATE(closed_at)", "UPDATE(status)"] },
  },
  "audit.audit_events": {
    class: "append_only_history",
    policies: ["append_bound_workspace INSERT app_worker", "append_own INSERT authenticated"],
    privileges: { authenticated: ["INSERT"], app_worker: ["INSERT"] },
  },
  "system.outbox": {
    class: "system",
    policies: [
      "append_bound_workspace INSERT app_worker",
      "append_own INSERT authenticated",
      "delivery_metadata SELECT app_system",
      "delivery_status UPDATE app_system",
    ],
    privileges: {
      authenticated: ["INSERT"],
      app_worker: ["INSERT"],
      app_system: [
        "SELECT",
        "UPDATE(claimed_until)",
        "UPDATE(dispatch_attempts)",
        "UPDATE(dispatched_at)",
        "UPDATE(last_failure_class)",
        "UPDATE(next_dispatch_at)",
        "UPDATE(recovery_count)",
        "UPDATE(run_diagnostic)",
        "UPDATE(run_diagnostic_at)",
        "UPDATE(run_outcome)",
        "UPDATE(run_outcome_at)",
        "UPDATE(slo_breached_at)",
        "UPDATE(status)",
      ],
    },
  },
  "system.outbox_runs": {
    class: "system",
    policies: ["delivery_runs ALL app_system"],
    privileges: {
      app_system: [
        "INSERT",
        "SELECT",
        "UPDATE(attempt_count)",
        "UPDATE(first_unknown_at)",
        "UPDATE(last_status)",
        "UPDATE(status_checked_at)",
        "UPDATE(terminal_at)",
        "UPDATE(unknown_checks)",
      ],
    },
  },
  "idempotency.effect_keys": {
    class: "append_only_history",
    policies: ["worker_claim INSERT app_worker", "worker_read SELECT app_worker"],
    privileges: { app_worker: ["INSERT", "SELECT"] },
  },
  "system.operational_switches": {
    class: "operational_config",
    policies: ["member_read SELECT authenticated", "system_read SELECT app_system", "worker_read SELECT app_worker"],
    privileges: { authenticated: ["SELECT"], app_worker: ["SELECT"], app_system: ["SELECT"] },
  },
  "system.operational_switch_changes": {
    class: "append_only_history",
    policies: ["owner_append INSERT app_owner"],
    privileges: {},
  },
  "t26_fixture.conversations": {
    class: "test_fixture",
    policies: ["user_content ALL authenticated", "worker_bound ALL app_worker"],
    privileges: { authenticated: [...ALL_DML].sort(), app_worker: [...ALL_DML].sort() },
  },
  "t26_fixture.interactions": {
    class: "test_fixture",
    policies: ["user_content ALL authenticated", "worker_bound ALL app_worker"],
    privileges: { authenticated: [...ALL_DML].sort(), app_worker: [...ALL_DML].sort() },
  },
  "t26_fixture.guest_projections": {
    class: "test_fixture",
    policies: ["member_read SELECT authenticated", "worker_bound ALL app_worker"],
    privileges: { authenticated: ["SELECT"], app_worker: [...ALL_DML].sort() },
  },
};

/** EXECUTE grants per function (non-owner grantees). Every function in an application schema is listed. */
export const FUNCTION_EXECUTE: Readonly<Record<string, readonly RuntimeGrantee[]>> = {
  "app.current_workspace()": ["app_worker", "authenticated"],
  "app.bind_workspace(uuid)": ["app_worker", "authenticated"],
  "app.my_workspace_role(uuid)": ["authenticated"],
  "app.my_organization_role(uuid)": ["authenticated"],
  "app.can_bootstrap_organization_owner(uuid)": ["authenticated"],
  "app.can_bootstrap_workspace_owner(uuid,uuid)": ["authenticated"],
  "app.current_invitation()": ["authenticated"],
  "app.present_invitation(text)": ["authenticated"],
  "app.invitation_workspace()": ["authenticated"],
  "app.invitation_admits_organization_membership(uuid,text)": ["authenticated"],
  "app.invitation_admits_workspace_membership(uuid,uuid,text,text[])": ["authenticated"],
  "app_private.context_seal(text,text)": [],
  "app_private.claimed_user()": [],
  "tenancy.workspace_keeps_an_owner()": [],
  "tenancy.organization_keeps_an_owner()": [],
  "audit.is_valid_change(jsonb)": ["app_worker", "authenticated"],
  "audit.is_workspace_membership_state(jsonb)": ["app_worker", "authenticated"],
  "audit.is_organization_membership_state(jsonb)": ["app_worker", "authenticated"],
  "system.is_identifier_map(jsonb)": ["app_system", "app_worker", "authenticated"],
  "system.record_switch_change()": [],
  "app.current_workspace_organization()": ["app_worker"],
};
