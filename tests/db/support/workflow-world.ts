/**
 * WORKFLOW-WF-2B — synthetic canonical rows for the workflow suites (TEST BOOTSTRAP, privileged connection, fresh random
 * ids per run; cleanupWorld deletes exactly this run's organizations). No real user, account, text or provider id.
 *
 * A tenant: one organization, one workspace (mode chosen), a member per workspace role plus a second MANAGER whose
 * membership a test revokes, one connection, one Facebook connected account and one content item. Conversations are
 * an observed top-level audience comment (the anchor) plus optional members, inserted the way the canonical model
 * requires: the interaction first (no conversation), the conversation, then the interaction joins it.
 *
 * Work items are NOT created here: the suites create them through the workflow module's own worker path.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";

export const WORKSPACE_ROLES = ["OWNER", "ADMIN", "MANAGER", "RESPONDER", "ANALYST_VIEWER", "CLIENT_GUEST"] as const;
export type TenantRole = (typeof WORKSPACE_ROLES)[number] | "REVOKED";

export interface WorkflowTenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly users: Readonly<Record<TenantRole, string>>;
  readonly accountId: string;
  readonly contentId: string;
}

export async function workflowTenant(privileged: pg.Pool, mode: "STANDARD" | "MONITOR_ONLY" = "STANDARD"): Promise<WorkflowTenant> {
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Workflow', now())", [organizationId]);
  await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', $3, now())", [workspaceId, organizationId, mode]);
  const users = {} as Record<TenantRole, string>;
  for (const role of [...WORKSPACE_ROLES, "REVOKED"] as const) {
    const user = randomUUID();
    users[role] = user;
    await privileged.query("insert into tenancy.organization_memberships values ($1, $2, $3, now())", [organizationId, user, role === "OWNER" ? "OWNER" : "MEMBER"]);
    await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, $4, '{}', now())", [organizationId, workspaceId, user, role === "REVOKED" ? "MANAGER" : role]);
  }
  const connection = randomUUID();
  await privileged.query(
    `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
     values ($1, $2, $3, 'simulator', 'ACTIVE', null, $4, now(), 1, now(), now())`,
    [connection, organizationId, workspaceId, users.OWNER],
  );
  const asset = `fb_wf2b_${workspaceId.slice(0, 8)}`;
  const discovered = randomUUID();
  await privileged.query(
    `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
     values ($1, $2, $3, $4, 'facebook', $5, 'content_bearing', 'Synthetic', now(), now(), now())`,
    [discovered, organizationId, workspaceId, connection, asset],
  );
  const accountId = randomUUID();
  await privileged.query(
    `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
     values ($1, $2, $3, $4, 'facebook', $5, 'content_bearing', 'ACTIVE', now(), now(), now())`,
    [accountId, organizationId, workspaceId, connection, asset],
  );
  const contentId = randomUUID();
  await privileged.query(
    `insert into content.content_items (id, organization_id, workspace_id, platform, connected_account_id, provider_asset_id, provider_content_id,
                                        content_kind, reported_source, source_state, first_observed_at, latest_observed_at, created_at, updated_at)
     values ($1, $2, $3, 'facebook', $4, $5, $6, 'post', 'organic', 'available', now(), now(), now(), now())`,
    [contentId, organizationId, workspaceId, accountId, asset, `post_${contentId.slice(0, 8)}`],
  );
  return { organizationId, workspaceId, users, accountId, contentId };
}

const insertInteraction = async (privileged: pg.Pool, t: WorkflowTenant, input: { readonly id: string; readonly parent: string | null; readonly authorRole: "user" | "account_identity" | "unknown"; readonly at: Date; readonly conversationId: string | null }): Promise<void> => {
  await privileged.query(
    `insert into interactions.interactions (
       id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id, provider_content_id,
       observed, parent_interaction_id, kind, author_id, author_role, conversation_id, current_source_text_version_id, text_observed_at,
       current_visibility, current_availability, current_removal_basis, provider_created_at, provider_edited_at, state_observed_at,
       first_observed_at, latest_observed_at, created_at, updated_at)
     select $1, c.organization_id, c.workspace_id, 'facebook', $7, c.connected_account_id, c.provider_asset_id, c.id, c.provider_content_id,
            true, $3, case when $3::uuid is null then 'comment' else 'reply' end, null, $4, $6, null, null,
            'visible', 'available', null, $5, null, $5, $5, $5, $5, $5
       from content.content_items c where c.id = $2`,
    [input.id, t.contentId, input.parent, input.authorRole, input.at, input.conversationId, `i_${input.id.replaceAll("-", "")}`],
  );
};

/** One conversation: an observed top-level audience comment at `at`, anchored. Returns the conversation (= work item) id. */
export async function seedConversation(privileged: pg.Pool, t: WorkflowTenant, at: Date): Promise<{ readonly conversationId: string; readonly anchorId: string }> {
  const anchorId = randomUUID();
  const conversationId = randomUUID();
  await insertInteraction(privileged, t, { id: anchorId, parent: null, authorRole: "user", at, conversationId: null });
  await privileged.query(
    `insert into conversations.conversations (id, organization_id, workspace_id, anchor_interaction_id, anchor_observed, workflow_state, created_by, created_at, updated_at)
     values ($1, $2, $3, $4, true, 'OPEN', 'system_ingestion', $5, $5)`,
    [conversationId, t.organizationId, t.workspaceId, anchorId, at],
  );
  await privileged.query("update interactions.interactions set conversation_id = $1 where id = $2", [conversationId, anchorId]);
  return { conversationId, anchorId };
}

/** One more member of a conversation (a reply to its anchor), already in the conversation. Returns the interaction id. */
export async function seedReply(privileged: pg.Pool, t: WorkflowTenant, conversation: { readonly conversationId: string; readonly anchorId: string }, at: Date, authorRole: "user" | "account_identity" | "unknown" = "user"): Promise<string> {
  const id = randomUUID();
  await insertInteraction(privileged, t, { id, parent: conversation.anchorId, authorRole, at, conversationId: conversation.conversationId });
  return id;
}
