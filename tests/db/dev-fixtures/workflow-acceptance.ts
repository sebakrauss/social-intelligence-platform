/**
 * W12-PREP-01 — the shared-dev Comments Workflow acceptance fixture (DEV-PREFLIGHT-01 §8; W12-UNBLOCK-01 option B).
 * Operator tooling (tools/db/workflow-acceptance.ts → vitest.workflow-acceptance.config.ts → workflow-acceptance.operator.ts)
 * and the local disposable suite (tests/db/suites/workflow-acceptance-fixture.ts) use exactly this module; no deployed
 * runtime imports it.
 *
 * ONE synthetic organization, nothing borrowed from real data:
 *
 *   hierarchy (fixed synthetic ids in the 12acce00- namespace, one privileged SERIALIZABLE transaction):
 *     organization "W12 Workflow Acceptance — SYNTHETIC" → workspaces A (STANDARD), B (STANDARD), M (MONITOR_ONLY), no
 *     member → per workspace: connection (provider `simulator`, ACTIVE, NO credential) → discovered asset → connected
 *     account (facebook). Exactly the H7-B1b-0 precedent's shape (tests/db/dev-fixtures/classification-acceptance.ts).
 *   conversations (the REAL ingestion path, one worker job transaction per interaction, bound to its workspace): the
 *     synthetic simulator scenario's listing → the trusted DTO mapping → ingestInteractionFact, which writes the
 *     canonical chain AND (server/persistence/ingestion.ts) the Workflow projection in the same transaction: a work item
 *     OPEN, version 1, and its `created` event. A: C1…C5, B: one, M: one — seven audience-rooted conversations.
 *   replies (on demand, A-10): one audience reply, then one account reply, into C2 by the same path. Preconditions are
 *     checked against the live work item (C2 must be DONE) and the outcome is verified (audience → auto-reopen,
 *     version + 1, one `system_auto_reopen` event; account → no state or version change).
 *
 * The tool NEVER writes workflow, audit, outbox, classification, credential, membership or mutation rows itself: every
 * such row comes from the production code it calls. Idempotency is identity, never adoption: an absent object is
 * created; a present one must match EXACTLY or the run stops with FIXTURE_IDENTITY_CONFLICT and writes nothing. There
 * is no delete, reset or repair path: every row is permanent (PO acceptance, W12-UNBLOCK-01 §3B).
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { parseCorrelationId } from "@/domain/correlation";
import { parseWorkspaceId } from "@/domain/ids";
import { parseInstant } from "@/domain/instant";
import type { ContentDto, InteractionDto, Page, PageCursor, ProviderAccess, ProviderReadPort, TimeWindow } from "@/integrations/providers/contract";
import { parseIsoInstant } from "@/integrations/providers/contract";
import { SimulatorWorld, createSimulatorReadPort, parseScenario, type SimulatorScenario } from "@/integrations/providers/simulator";
import { SIMULATOR_CATALOG } from "@/modules/capability";
import type { AvailabilityInput } from "@/modules/coverage";
import { ingestInteractionFact, interactionSourceFactFromDto, reconciliationArrival } from "@/modules/ingestion";
import { withWorkspaceJobScope, type RuntimeDatabase } from "@/platform/db";
import type { OutboxNotice } from "@/platform/outbox";
import { ingestionStores } from "@/server/persistence/ingestion";
import { isProtectedWorkspace } from "@/tools/db/dev-fixture-guard";
import type { ReplyKind } from "@/tools/db/workflow-acceptance-guard";

const ROOT = path.resolve(import.meta.dirname, "../../..");

export const WORKSPACE_KEYS = ["A", "B", "M"] as const;
export type WorkspaceKey = (typeof WORKSPACE_KEYS)[number];
export const WORKSPACE_MODES = ["STANDARD", "MONITOR_ONLY"] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export interface AcceptanceWorkspace {
  readonly key: WorkspaceKey;
  readonly id: string;
  readonly name: string;
  readonly mode: WorkspaceMode;
  readonly connectionId: string;
  readonly discoveredAssetId: string;
  readonly connectedAccountId: string;
  readonly providerAssetId: string;
  readonly assetDisplayName: string;
  readonly providerContentId: string;
  /** Audience-rooted conversations (provider interaction ids), in order. */
  readonly roots: readonly string[];
}

export interface WorkflowAcceptanceDescriptor {
  readonly scenarioFile: string;
  readonly credentialId: string;
  readonly organization: { readonly id: string; readonly name: string };
  readonly platform: "facebook";
  readonly assetClass: "content_bearing";
  /** A synthetic actor id (no auth user exists for it; the column has no foreign key). */
  readonly connectionAuthorizedBy: string;
  readonly workspaces: readonly AcceptanceWorkspace[];
  /** C2 of workspace A and its two A-10 replies. */
  readonly c2: { readonly root: string; readonly audienceReply: string; readonly accountReply: string };
}

const id = (suffix: string): string => `12acce00-0000-4000-8000-${suffix.padStart(12, "0")}`;
const workspace = (key: WorkspaceKey, slot: string, mode: WorkspaceMode, roots: readonly string[]): AcceptanceWorkspace => Object.freeze({
  key,
  id: id(`${slot}0`),
  name: `W12 Acceptance ${key} — SYNTHETIC (${mode})`,
  mode,
  connectionId: id(`${slot}1`),
  discoveredAssetId: id(`${slot}2`),
  connectedAccountId: id(`${slot}3`),
  providerAssetId: `wrenkind_fixture_w12_page_${key.toLowerCase()}`,
  assetDisplayName: `W12 Acceptance ${key} (synthetic page)`,
  providerContentId: `wrenkind_fixture_w12_post_${key.toLowerCase()}`,
  roots: Object.freeze([...roots]),
});

/** The one fixture (fixed synthetic ids; nothing here resembles a real Page, account or person). */
export const W12_WORKFLOW_ACCEPTANCE_FIXTURE: WorkflowAcceptanceDescriptor = Object.freeze({
  scenarioFile: "fixtures/providers/simulator/w12-workflow-acceptance.scenario.json",
  credentialId: "wrenkind_fixture_w12_credential",
  organization: Object.freeze({ id: id("1"), name: "W12 Workflow Acceptance — SYNTHETIC" }),
  platform: "facebook" as const,
  assetClass: "content_bearing" as const,
  connectionAuthorizedBy: id("99"),
  workspaces: Object.freeze([
    workspace("A", "a", "STANDARD", ["wrenkind_fixture_w12_a_c1", "wrenkind_fixture_w12_a_c2", "wrenkind_fixture_w12_a_c3", "wrenkind_fixture_w12_a_c4", "wrenkind_fixture_w12_a_c5"]),
    workspace("B", "b", "STANDARD", ["wrenkind_fixture_w12_b_c1"]),
    workspace("M", "c", "MONITOR_ONLY", ["wrenkind_fixture_w12_m_c1"]),
  ]),
  c2: Object.freeze({ root: "wrenkind_fixture_w12_a_c2", audienceReply: "wrenkind_fixture_w12_a_c2_audience_reply", accountReply: "wrenkind_fixture_w12_a_c2_account_reply" }),
});

/** The read the fixture models was gated on this availability (the scenario's simulated grants include sim.read_interactions). */
const AVAILABILITY: AvailabilityInput = { state: "AVAILABLE", reason: "CAPABILITY_SUPPORTED", limitationCode: null };
const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(what);
  return value;
};
const LISTING: TimeWindow = { from: must(parseIsoInstant("2026-11-01T00:00:00.000Z"), "instant"), to: must(parseIsoInstant("2026-12-01T00:00:00.000Z"), "instant") };
const SIMULATED_WEBHOOK_KEY = "synthetic-w12-fixture-webhook-key-not-a-secret";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Presence = "absent" | "match" | "mismatch";
export type FixtureStatus =
  | "CREATE_ALL" | "RESUME_CONVERSATIONS" | "ALREADY_PRESENT_MATCH" | "CREATED" | "RESUMED"
  | "FIXTURE_IDENTITY_CONFLICT" | "REFUSED_PROTECTED_WORKSPACE" | "REFUSED_INVALID_DESCRIPTOR" | "OUTSIDE_DATA_CHANGED" | "CONTAINMENT_VIOLATION" | "POSTCONDITION_FAILED";
export type ReplyStatus =
  | "READY" | "INGESTED" | "ALREADY_PRESENT_MATCH" | "REFUSED_PRECONDITION" | "FIXTURE_IDENTITY_CONFLICT" | "REFUSED_INVALID_DESCRIPTOR" | "REFUSED_PROTECTED_WORKSPACE"
  | "POSTCONDITION_FAILED" | "OUTSIDE_DATA_CHANGED" | "CONTAINMENT_VIOLATION";

export interface Queryable {
  query<T extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const rowsOf = async <T extends pg.QueryResultRow>(db: Queryable, sql: string, values: unknown[]): Promise<readonly T[]> => (await db.query<T>(sql, values)).rows;
const countOf = async (db: Queryable, sql: string, values: unknown[]): Promise<number> => (await db.query<{ n: number }>(sql, values)).rows[0]?.n ?? -1;
const presence = (rows: readonly Readonly<Record<string, unknown>>[], expected: Readonly<Record<string, unknown>>): Presence => {
  const [row] = rows;
  if (row === undefined) return "absent";
  return rows.length === 1 && Object.entries(expected).every(([key, value]) => row[key] === value) ? "match" : "mismatch";
};

export const workspaceIds = (d: WorkflowAcceptanceDescriptor): readonly string[] => d.workspaces.map((w) => w.id);
export const workspaceOf = (d: WorkflowAcceptanceDescriptor, key: WorkspaceKey): AcceptanceWorkspace => must(d.workspaces.find((w) => w.key === key), `workspace ${key}`);

/** Every reason the descriptor is not exactly the approved shape (A and B STANDARD, M MONITOR_ONLY, labelled, distinct ids). */
export function descriptorProblems(d: WorkflowAcceptanceDescriptor): readonly string[] {
  const problems: string[] = [];
  const keys = d.workspaces.map((w) => w.key).join(",");
  if (keys !== "A,B,M") problems.push("workspaces must be exactly A, B, M");
  for (const w of d.workspaces) {
    if (!(WORKSPACE_MODES as readonly string[]).includes(w.mode)) problems.push(`workspace ${w.key}: mode ${w.mode} is not a workspace mode`);
    if (w.mode !== (w.key === "M" ? "MONITOR_ONLY" : "STANDARD")) problems.push(`workspace ${w.key} must be ${w.key === "M" ? "MONITOR_ONLY" : "STANDARD"}`);
    if (!w.name.includes("SYNTHETIC")) problems.push(`workspace ${w.key} is not labelled SYNTHETIC`);
  }
  if (!d.organization.name.includes("SYNTHETIC")) problems.push("the organization is not labelled SYNTHETIC");
  const ids = [d.organization.id, d.connectionAuthorizedBy, ...d.workspaces.flatMap((w) => [w.id, w.connectionId, w.discoveredAssetId, w.connectedAccountId])];
  if (!ids.every((value) => UUID.test(value))) problems.push("every fixture id must be a canonical UUID");
  if (new Set(ids).size !== ids.length) problems.push("fixture ids must be distinct");
  const roots = d.workspaces.flatMap((w) => w.roots);
  if (roots.length !== 7 || workspaceOf(d, "A").roots.length !== 5) problems.push("seven conversations: five in A, one in B, one in M");
  if (!workspaceOf(d, "A").roots.includes(d.c2.root)) problems.push("C2 must be a conversation of A");
  return problems;
}

export const isProtectedDescriptor = (d: WorkflowAcceptanceDescriptor): boolean =>
  isProtectedWorkspace(d.organization.id) || d.workspaces.some((w) => isProtectedWorkspace(w.id));

interface ScenarioIndex {
  readonly scenario: SimulatorScenario;
  readonly text: ReadonlyMap<string, string>;
}

/** The synthetic scenario, validated against the descriptor exactly (assets, posts, roots and the two C2 replies). */
export function loadWorkflowAcceptanceScenario(d: WorkflowAcceptanceDescriptor = W12_WORKFLOW_ACCEPTANCE_FIXTURE): ScenarioIndex {
  const scenario = parseScenario(JSON.parse(readFileSync(path.join(ROOT, d.scenarioFile), "utf8")));
  const text = new Map<string, string>();
  const author = (authorId: string) => scenario.authors.find((a) => a.id === authorId);
  if (!scenario.credentials.some((c) => c.id === d.credentialId)) throw new Error("fixture_scenario_credential");
  const expectedInteractions = new Set([...d.workspaces.flatMap((w) => w.roots), d.c2.audienceReply, d.c2.accountReply]);
  if (scenario.interactions.length !== expectedInteractions.size || scenario.assets.length !== 3 || scenario.contents.length !== 3) throw new Error("fixture_scenario_shape");
  for (const w of d.workspaces) {
    const asset = scenario.assets.find((a) => a.id === w.providerAssetId);
    const content = scenario.contents.find((c) => c.id === w.providerContentId);
    if (asset === undefined || asset.platform !== d.platform || asset.assetClass !== d.assetClass || content === undefined || content.account !== asset.id) throw new Error(`fixture_scenario_asset_${w.key}`);
    for (const root of w.roots) {
      const interaction = scenario.interactions.find((i) => i.id === root);
      if (interaction === undefined || interaction.content !== content.id || interaction.parent !== null || author(interaction.author)?.role !== "user") throw new Error(`fixture_scenario_root_${root}`);
      text.set(root, interaction.text);
    }
  }
  const a = workspaceOf(d, "A");
  const identity = scenario.assets.find((asset) => asset.id === a.providerAssetId)?.identity;
  for (const [replyId, role] of [[d.c2.audienceReply, "user"], [d.c2.accountReply, "account_identity"]] as const) {
    const reply = scenario.interactions.find((i) => i.id === replyId);
    if (reply === undefined || reply.content !== a.providerContentId || reply.parent !== d.c2.root || author(reply.author)?.role !== role) throw new Error(`fixture_scenario_reply_${replyId}`);
    if (role === "account_identity" && reply.author !== identity) throw new Error("fixture_scenario_account_reply_author");
    text.set(replyId, reply.text);
  }
  return { scenario, text };
}

interface InteractionRow {
  id: string; observed: boolean; kind: string; author_role: string; connected_account_id: string; provider_asset_id: string; provider_content_id: string;
  parent: string | null; current_version: string | null; conversation_id: string | null; content_item_id: string;
}

export interface InteractionInspection {
  readonly providerInteractionId: string;
  readonly workspace: WorkspaceKey;
  readonly presence: Presence;
  readonly interactionId: string | null;
  readonly conversationId: string | null;
  readonly problems: readonly string[];
}

/** Read-only coherence of ONE fixture interaction's canonical chain (and, for a root, its conversation and work item). */
async function inspectInteraction(db: Queryable, d: WorkflowAcceptanceDescriptor, w: AcceptanceWorkspace, providerInteractionId: string, text: string,
  expected: { readonly kind: "comment" | "reply"; readonly authorRole: "user" | "account_identity"; readonly parentInteractionId: string | null }): Promise<InteractionInspection> {
  const rows = await rowsOf<InteractionRow>(db,
    `select id::text, observed, kind, author_role, connected_account_id::text, provider_asset_id, provider_content_id, parent_interaction_id::text as parent,
            current_source_text_version_id::text as current_version, conversation_id::text, content_item_id::text
       from interactions.interactions where workspace_id = $1 and platform = $2 and provider_interaction_id = $3`, [w.id, d.platform, providerInteractionId]);
  const base = { providerInteractionId, workspace: w.key };
  if (rows.length === 0) return { ...base, presence: "absent", interactionId: null, conversationId: null, problems: [] };
  const problems: string[] = [];
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) return { ...base, presence: "mismatch", interactionId: null, conversationId: null, problems: ["duplicate interaction rows"] };
  if (!row.observed || row.kind !== expected.kind || row.author_role !== expected.authorRole || row.parent !== expected.parentInteractionId) problems.push("interaction identity differs");
  if (row.connected_account_id !== w.connectedAccountId || row.provider_asset_id !== w.providerAssetId || row.provider_content_id !== w.providerContentId) problems.push("interaction account or content differs");
  if (row.conversation_id === null) problems.push("interaction has no conversation");
  const versions = await rowsOf<{ id: string; text_hash: string; same: boolean }>(db,
    "select id::text, text_hash, source_text = $3 as same from interactions.source_text_versions where workspace_id = $1 and interaction_id = $2", [w.id, row.id, text]);
  const version = versions[0];
  if (versions.length !== 1 || version === undefined || version.text_hash !== sha256(text) || !version.same || row.current_version !== version.id) problems.push("source text version differs");
  const events = await rowsOf<{ id: string; conversation_id: string | null; change: string }>(db,
    "select id::text, conversation_id::text, change from ingestion.ingestion_events where workspace_id = $1 and interaction_id = $2", [w.id, row.id]);
  const event = events[0];
  if (events.length !== 1 || event === undefined || event.change !== "created" || event.conversation_id !== row.conversation_id) problems.push("ingestion event differs");
  else {
    const outbox = await rowsOf<{ topic: string }>(db, "select topic from system.outbox where workspace_id = $1 and subject_ids ->> 'ingestion_event_id' = $2", [w.id, event.id]);
    if (outbox.length !== 1 || outbox[0]?.topic !== "interactions.observed") problems.push("outbox row differs");
  }
  if (expected.kind === "comment" && row.conversation_id !== null) {
    const conversation = await rowsOf<{ anchor: string }>(db, "select anchor_interaction_id::text as anchor from conversations.conversations where workspace_id = $1 and id = $2", [w.id, row.conversation_id]);
    if (conversation.length !== 1 || conversation[0]?.anchor !== row.id) problems.push("conversation differs");
    const item = await rowsOf<{ subject: string }>(db, "select subject_kind as subject from workflow.work_items where workspace_id = $1 and id = $2", [w.id, row.conversation_id]);
    if (item.length !== 1 || item[0]?.subject !== "comment_conversation") problems.push("work item missing");
    const created = await countOf(db, "select count(*)::int as n from workflow.workflow_events where workspace_id = $1 and work_item_id = $2 and kind = 'created' and initiator_kind = 'system_ingestion'", [w.id, row.conversation_id]);
    if (created !== 1) problems.push("work item created event differs");
  }
  return { ...base, presence: problems.length === 0 ? "match" : "mismatch", interactionId: row.id, conversationId: row.conversation_id, problems };
}

export interface HierarchyInspection {
  readonly organization: Presence;
  readonly workspaces: Readonly<Record<WorkspaceKey, Readonly<Record<"workspace" | "connection" | "discoveredAsset" | "connectedAccount", Presence>>>>;
}

async function inspectHierarchy(db: Queryable, d: WorkflowAcceptanceDescriptor): Promise<HierarchyInspection> {
  const organization = presence(await rowsOf(db, "select id::text, name from tenancy.organizations where id = $1", [d.organization.id]), { id: d.organization.id, name: d.organization.name });
  const workspaces = {} as Record<WorkspaceKey, Record<"workspace" | "connection" | "discoveredAsset" | "connectedAccount", Presence>>;
  for (const w of d.workspaces) {
    workspaces[w.key] = {
      workspace: presence(await rowsOf(db, "select id::text, organization_id::text, name, mode from tenancy.workspaces where id = $1", [w.id]),
        { id: w.id, organization_id: d.organization.id, name: w.name, mode: w.mode }),
      connection: presence(await rowsOf(db, `select id::text, organization_id::text, workspace_id::text, provider, status, active_credential_id::text, authorized_by::text
                                              from connections.connections where id = $1`, [w.connectionId]),
        { id: w.connectionId, organization_id: d.organization.id, workspace_id: w.id, provider: "simulator", status: "ACTIVE", active_credential_id: null, authorized_by: d.connectionAuthorizedBy }),
      discoveredAsset: presence(await rowsOf(db, `select id::text, organization_id::text, workspace_id::text, connection_id::text, platform, provider_asset_id, asset_class, display_name
                                                   from connections.discovered_assets where id = $1`, [w.discoveredAssetId]),
        { id: w.discoveredAssetId, organization_id: d.organization.id, workspace_id: w.id, connection_id: w.connectionId, platform: d.platform, provider_asset_id: w.providerAssetId, asset_class: d.assetClass, display_name: w.assetDisplayName }),
      connectedAccount: presence(await rowsOf(db, `select id::text, organization_id::text, workspace_id::text, connection_id::text, platform, provider_asset_id, asset_class, status, deactivated_at
                                                    from connections.connected_accounts where id = $1`, [w.connectedAccountId]),
        { id: w.connectedAccountId, organization_id: d.organization.id, workspace_id: w.id, connection_id: w.connectionId, platform: d.platform, provider_asset_id: w.providerAssetId, asset_class: d.assetClass, status: "ACTIVE", deactivated_at: null }),
    };
  }
  return { organization, workspaces };
}

const hierarchyStates = (h: HierarchyInspection): readonly Presence[] => [h.organization, ...Object.values(h.workspaces).flatMap((w) => Object.values(w))];

export interface FixtureInspection {
  readonly hierarchy: HierarchyInspection;
  readonly roots: readonly InteractionInspection[];
  readonly replies: readonly InteractionInspection[];
  readonly conflicts: readonly string[];
}

/** Read-only: what exists at the fixture's identity, and whether it is exactly the fixture. */
export async function inspectWorkflowAcceptanceFixture(db: Queryable, d: WorkflowAcceptanceDescriptor = W12_WORKFLOW_ACCEPTANCE_FIXTURE): Promise<FixtureInspection> {
  const { text } = loadWorkflowAcceptanceScenario(d);
  const hierarchy = await inspectHierarchy(db, d);
  const ids = workspaceIds(d);
  const roots: InteractionInspection[] = [];
  for (const w of d.workspaces) {
    for (const root of w.roots) roots.push(await inspectInteraction(db, d, w, root, text.get(root) ?? "", { kind: "comment", authorRole: "user", parentInteractionId: null }));
  }
  const a = workspaceOf(d, "A");
  const c2 = roots.find((r) => r.providerInteractionId === d.c2.root);
  const replies: InteractionInspection[] = [];
  for (const [replyId, authorRole] of [[d.c2.audienceReply, "user"], [d.c2.accountReply, "account_identity"]] as const) {
    replies.push(await inspectInteraction(db, d, a, replyId, text.get(replyId) ?? "", { kind: "reply", authorRole, parentInteractionId: c2?.interactionId ?? null }));
  }
  const conflicts: string[] = [];
  const states = hierarchyStates(hierarchy);
  if (states.includes("mismatch")) conflicts.push("a hierarchy row differs from the fixture");
  if (states.includes("absent") && states.includes("match")) conflicts.push("the hierarchy is partially present");
  for (const r of [...roots, ...replies]) if (r.presence === "mismatch") conflicts.push(`${r.providerInteractionId}: ${r.problems.join("; ")}`);
  const fixtureInteractions = [...roots, ...replies].filter((r) => r.presence !== "absent").length;
  if (states.includes("absent") && fixtureInteractions > 0) conflicts.push("interactions without the fixture hierarchy");
  if (replies.some((r) => r.presence !== "absent") && c2?.presence !== "match") conflicts.push("a C2 reply without C2");
  if (replies[1]?.presence !== "absent" && replies[0]?.presence === "absent") conflicts.push("the account reply precedes the audience reply");
  const known = [...d.workspaces.flatMap((w) => w.roots), d.c2.audienceReply, d.c2.accountReply];
  const extra = await countOf(db, "select count(*)::int as n from interactions.interactions where workspace_id = any($1::uuid[]) and not (provider_interaction_id = any($2::text[]))", [ids, known]);
  if (extra !== 0) conflicts.push("interactions in the fixture workspaces that are not the fixture's");
  const assets = d.workspaces.map((w) => w.providerAssetId);
  const ownRows = d.workspaces.flatMap((w) => [w.connectedAccountId, w.discoveredAssetId]);
  const foreignAssetUses = await countOf(db,
    `select ((select count(*) from connections.connected_accounts where provider_asset_id = any($1::text[]) and not (id = any($2::uuid[])))
           + (select count(*) from connections.discovered_assets where provider_asset_id = any($1::text[]) and not (id = any($2::uuid[]))))::int as n`, [assets, ownRows]);
  if (foreignAssetUses !== 0) conflicts.push("a fixture asset id is used outside the fixture");
  const ownIds = [d.organization.id, ...ids];
  const namespaceSquatters = await countOf(db,
    `select ((select count(*) from tenancy.organizations where id::text like '12acce00-%' and not (id = any($1::uuid[])))
           + (select count(*) from tenancy.workspaces where id::text like '12acce00-%' and not (id = any($1::uuid[]))))::int as n`, [ownIds]);
  if (namespaceSquatters !== 0) conflicts.push("another organization or workspace uses the fixture id namespace");
  const credentials = await countOf(db, "select count(*)::int as n from credentials.provider_credentials where workspace_id = any($1::uuid[])", [ids]);
  if (credentials !== 0) conflicts.push("a credential exists in a fixture workspace");
  return { hierarchy, roots, replies, conflicts };
}

export function fixtureStatus(inspection: FixtureInspection): FixtureStatus {
  if (inspection.conflicts.length > 0) return "FIXTURE_IDENTITY_CONFLICT";
  const states = hierarchyStates(inspection.hierarchy);
  if (states.every((s) => s === "absent")) return "CREATE_ALL";
  return inspection.roots.every((r) => r.presence === "match") ? "ALREADY_PRESENT_MATCH" : "RESUME_CONVERSATIONS";
}

/**
 * The permanent rows a complete stage-1 apply produces from nothing, per table, exactly (the operator compares the
 * measured delta to it). Replies add, each: interaction, source text version, state observation, ingestion event,
 * outbox row, author (new) — and the audience reply one `state_changed` workflow event and one system audit row.
 */
export function expectedFixtureFootprint(d: WorkflowAcceptanceDescriptor = W12_WORKFLOW_ACCEPTANCE_FIXTURE): Readonly<Record<string, number>> {
  const roots = d.workspaces.flatMap((w) => w.roots).length;
  const n = d.workspaces.length;
  return {
    "tenancy.organizations": 1, "tenancy.workspaces": n, "connections.connections": n, "connections.discovered_assets": n, "connections.connected_accounts": n,
    "content.content_items": n, "interactions.authors": roots, "interactions.interactions": roots, "interactions.source_text_versions": roots,
    "interactions.state_observations": roots, "conversations.conversations": roots, "ingestion.ingestion_events": roots, "system.outbox": roots,
    "workflow.work_items": roots, "workflow.workflow_events": roots, "audit.audit_events": 0, "tenancy.workspace_memberships": 0, "tenancy.organization_memberships": 0,
  };
}

/** Tables the fixture or its deployed consumer may ever hold rows in (per fixture workspace); every OTHER workspace-scoped table must stay empty. */
export const FIXTURE_TABLES = Object.freeze([
  "tenancy.workspaces", "tenancy.workspace_memberships", "connections.connections", "connections.discovered_assets", "connections.connected_accounts",
  "content.content_items", "interactions.authors", "interactions.interactions", "interactions.source_text_versions", "interactions.state_observations",
  "conversations.conversations", "ingestion.ingestion_events", "system.outbox", "workflow.work_items", "workflow.workflow_events", "audit.audit_events",
]);
/** Written by the deployed `interactions.observed` consumer (deterministic classification; the relay's own state). */
export const CONSUMER_TABLES = Object.freeze(["classification.understanding_requests", "classification.signals", "system.outbox_runs"]);

/** Row counts of EVERY table with a workspace_id column, for the fixture workspaces (plus the organization rows). */
export async function fixtureCensus(db: Queryable, d: WorkflowAcceptanceDescriptor = W12_WORKFLOW_ACCEPTANCE_FIXTURE): Promise<Readonly<Record<string, number>>> {
  const ids = workspaceIds(d);
  // pg_catalog, not information_schema: the latter hides tables the current role holds no privilege on (silently skipped).
  const tables = await rowsOf<{ name: string }>(db,
    `select n.nspname || '.' || c.relname as name from pg_catalog.pg_attribute a
       join pg_catalog.pg_class c on c.oid = a.attrelid and c.relkind in ('r', 'p')
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where a.attname = 'workspace_id' and a.attnum > 0 and not a.attisdropped and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_%'
      order by 1`, []);
  const out: Record<string, number> = {
    "tenancy.organizations": await countOf(db, "select count(*)::int as n from tenancy.organizations where id = $1", [d.organization.id]),
    "tenancy.organization_memberships": await countOf(db, "select count(*)::int as n from tenancy.organization_memberships where organization_id = $1", [d.organization.id]),
    "tenancy.workspaces": await countOf(db, "select count(*)::int as n from tenancy.workspaces where id = any($1::uuid[])", [ids]),
  };
  for (const { name } of tables) {
    const [schema, table] = name.split(".");
    if (schema === undefined || table === undefined || !/^[a-z_][a-z0-9_]*$/.test(schema) || !/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error("unexpected table name");
    out[name] = await countOf(db, `select count(*)::int as n from "${schema}"."${table}" where workspace_id = any($1::uuid[])`, [ids]);
  }
  return out;
}

export interface Containment {
  readonly ok: boolean;
  readonly unexpectedTables: readonly string[];
  readonly outboxTopics: readonly string[];
  readonly aiRequests: number;
  /** Per fixture workspace, any hierarchy table whose row count is not exactly one (e.g. a second connection from a connect flow). */
  readonly hierarchyCountProblems: readonly string[];
}

/** Side-effect containment of the fixture workspaces: no row outside the known tables, IDs-only ingestion topic only, no AI state. */
export async function fixtureContainment(db: Queryable, d: WorkflowAcceptanceDescriptor = W12_WORKFLOW_ACCEPTANCE_FIXTURE): Promise<Containment> {
  const census = await fixtureCensus(db, d);
  const allowed = new Set<string>(["tenancy.organizations", "tenancy.organization_memberships", ...FIXTURE_TABLES, ...CONSUMER_TABLES]);
  const unexpectedTables = Object.entries(census).filter(([table, n]) => n !== 0 && !allowed.has(table)).map(([table]) => table);
  const ids = workspaceIds(d);
  const outboxTopics = (await rowsOf<{ topic: string }>(db, "select distinct topic from system.outbox where workspace_id = any($1::uuid[]) order by topic", [ids])).map((r) => r.topic);
  // Every AI-stage request (0025: ai_generation is set exactly for AI_PENDING, AI_RUNNING, COMPLETED and AI_FAILED).
  const aiRequests = await countOf(db,
    "select count(*)::int as n from classification.understanding_requests where workspace_id = any($1::uuid[]) and (ai_generation is not null or state in ('AI_PENDING', 'AI_RUNNING', 'COMPLETED', 'AI_FAILED'))", [ids]);
  const hierarchyCountProblems: string[] = [];
  const organizationWorkspaces = await countOf(db, "select count(*)::int as n from tenancy.workspaces where organization_id = $1", [d.organization.id]);
  if (organizationWorkspaces !== 0 && organizationWorkspaces !== d.workspaces.length) hierarchyCountProblems.push(`the synthetic organization holds ${String(organizationWorkspaces)} workspaces`);
  for (const w of d.workspaces) {
    for (const table of ["connections.connections", "connections.discovered_assets", "connections.connected_accounts", "content.content_items"]) {
      const n = await countOf(db, `select count(*)::int as n from ${table} where workspace_id = $1`, [w.id]);
      if (n > 1) hierarchyCountProblems.push(`${w.key}: ${table} holds ${String(n)} rows`);
    }
  }
  const ok = unexpectedTables.length === 0 && outboxTopics.every((topic) => topic === "interactions.observed") && aiRequests === 0 && hierarchyCountProblems.length === 0;
  return { ok, unexpectedTables, outboxTopics, aiRequests, hierarchyCountProblems };
}

/**
 * A digest of the rows OUTSIDE the fixture (the existing DEV data): Workflow items and events, conversations, interactions,
 * audit, memberships, organizations, workspaces, connections and connected accounts. Outbox and classification rows are
 * excluded on purpose (the relay and its consumer legitimately update them). Before and after are separate reads, so
 * concurrent real DEV activity is reported too (fail-safe: the cause must then be attributed by hand).
 */
export async function outsideDigest(db: Queryable, d: WorkflowAcceptanceDescriptor = W12_WORKFLOW_ACCEPTANCE_FIXTURE): Promise<string> {
  const ids = workspaceIds(d);
  const parts: string[] = [];
  for (const table of ["workflow.work_items", "workflow.workflow_events", "conversations.conversations", "interactions.interactions", "audit.audit_events", "tenancy.workspace_memberships"]) {
    const rows = await rowsOf<{ d: string | null; n: number }>(db,
      `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as d, count(*)::int as n from ${table} t where t.workspace_id is null or not (t.workspace_id = any($1::uuid[]))`, [ids]);
    parts.push(`${table}:${String(rows[0]?.n ?? -1)}:${rows[0]?.d ?? "-"}`);
  }
  for (const [table, column] of [["tenancy.organization_memberships", "organization_id"], ["tenancy.organizations", "id"]] as const) {
    const rows = await rowsOf<{ d: string | null }>(db, `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as d from ${table} t where t.${column} <> $1`, [d.organization.id]);
    parts.push(`${table}:${rows[0]?.d ?? "-"}`);
  }
  for (const [table, column] of [["tenancy.workspaces", "id"], ["connections.connections", "workspace_id"], ["connections.connected_accounts", "workspace_id"]] as const) {
    const rows = await rowsOf<{ d: string | null }>(db, `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as d from ${table} t where not (t.${column} = any($1::uuid[]))`, [ids]);
    parts.push(`${table}:${rows[0]?.d ?? "-"}`);
  }
  return sha256(parts.join(";")).slice(0, 32);
}

export interface FixtureReport {
  readonly status: FixtureStatus;
  readonly organizationId: string;
  readonly workspaces: readonly { readonly key: WorkspaceKey; readonly id: string; readonly mode: WorkspaceMode; readonly conversations: number }[];
  readonly hierarchyToCreate: readonly string[];
  readonly conversationsToIngest: readonly string[];
  readonly expectedFootprintFromEmpty: Readonly<Record<string, number>>;
  readonly measuredDelta: Readonly<Record<string, number>> | null;
  readonly workItems: readonly { readonly conversation: string; readonly state: string; readonly version: number }[];
  readonly conflicts: readonly string[];
  readonly containment: Containment | null;
  readonly outsideDigestBefore: string | null;
  readonly outsideDigestAfter: string | null;
  readonly correlationId: string | null;
  readonly outboxNotices: number;
}

async function workItemsOf(db: Queryable, d: WorkflowAcceptanceDescriptor, inspection: FixtureInspection | null): Promise<FixtureReport["workItems"]> {
  if (inspection === null) return [];
  const out: { conversation: string; state: string; version: number }[] = [];
  for (const root of inspection.roots) {
    if (root.conversationId === null) continue;
    const w = workspaceOf(d, root.workspace);
    const [row] = await rowsOf<{ state: string; version: number }>(db, "select state, version from workflow.work_items where workspace_id = $1 and id = $2", [w.id, root.conversationId]);
    if (row !== undefined) out.push({ conversation: root.providerInteractionId, state: row.state, version: row.version });
  }
  return out;
}

const reportOf = async (db: Queryable | null, status: FixtureStatus, d: WorkflowAcceptanceDescriptor, inspection: FixtureInspection | null,
  extra: Partial<Pick<FixtureReport, "measuredDelta" | "containment" | "outsideDigestBefore" | "outsideDigestAfter" | "correlationId" | "outboxNotices">> = {}): Promise<FixtureReport> => {
  const hierarchyToCreate = inspection === null ? [] : [
    ...(inspection.hierarchy.organization === "absent" ? ["organization"] : []),
    ...Object.entries(inspection.hierarchy.workspaces).flatMap(([key, rows]) => Object.entries(rows).filter(([, p]) => p === "absent").map(([name]) => `${key}.${name}`)),
  ];
  return {
    status,
    organizationId: d.organization.id,
    workspaces: d.workspaces.map((w) => ({ key: w.key, id: w.id, mode: w.mode, conversations: w.roots.length })),
    hierarchyToCreate,
    conversationsToIngest: inspection === null ? [] : inspection.roots.filter((r) => r.presence === "absent").map((r) => r.providerInteractionId),
    expectedFootprintFromEmpty: expectedFixtureFootprint(d),
    measuredDelta: extra.measuredDelta ?? null,
    workItems: db === null ? [] : await workItemsOf(db, d, inspection),
    conflicts: inspection?.conflicts ?? [],
    containment: extra.containment ?? null,
    outsideDigestBefore: extra.outsideDigestBefore ?? null,
    outsideDigestAfter: extra.outsideDigestAfter ?? null,
    correlationId: extra.correlationId ?? null,
    outboxNotices: extra.outboxNotices ?? 0,
  };
};

async function readOnly<T>(privileged: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await privileged.connect();
  try {
    await client.query("begin isolation level repeatable read, read only");
    const result = await work(client);
    await client.query("rollback");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Read-only plan of stage 1 (one REPEATABLE READ, READ ONLY transaction). */
export async function planWorkflowAcceptanceFixture(privileged: pg.Pool, d: WorkflowAcceptanceDescriptor = W12_WORKFLOW_ACCEPTANCE_FIXTURE): Promise<FixtureReport> {
  if (descriptorProblems(d).length > 0) return reportOf(null, "REFUSED_INVALID_DESCRIPTOR", d, null);
  if (isProtectedDescriptor(d)) return reportOf(null, "REFUSED_PROTECTED_WORKSPACE", d, null);
  return readOnly(privileged, async (client) => {
    const inspection = await inspectWorkflowAcceptanceFixture(client, d);
    return reportOf(client, fixtureStatus(inspection), d, inspection, { containment: await fixtureContainment(client, d), outsideDigestBefore: await outsideDigest(client, d) });
  });
}

export interface ApplyDependencies {
  readonly privileged: pg.Pool;
  readonly worker: RuntimeDatabase<"worker">;
  readonly clock?: { readonly newId: () => string; readonly now: () => Date };
  /** Test seam: runs after the hierarchy committed and before the first conversation. */
  readonly beforeConversations?: () => Promise<void>;
  /** Test seam: runs after each ingested interaction (its transaction committed). */
  readonly afterInteraction?: (providerInteractionId: string) => Promise<void>;
}

/** The hierarchy rows, in one SERIALIZABLE transaction that re-inspects first (absent → insert; anything else → stop). */
async function createHierarchy(privileged: pg.Pool, d: WorkflowAcceptanceDescriptor): Promise<FixtureInspection | undefined> {
  const client = await privileged.connect();
  try {
    await client.query("begin isolation level serializable");
    const before = await inspectWorkflowAcceptanceFixture(client, d);
    if (fixtureStatus(before) !== "CREATE_ALL") {
      await client.query("rollback");
      return before;
    }
    await client.query("insert into tenancy.organizations (id, name, created_at) values ($1, $2, now())", [d.organization.id, d.organization.name]);
    for (const w of d.workspaces) {
      await client.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, $3, $4, now())", [w.id, d.organization.id, w.name, w.mode]);
      await client.query(
        `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
         values ($1, $2, $3, 'simulator', 'ACTIVE', null, $4, now(), 1, now(), now())`, [w.connectionId, d.organization.id, w.id, d.connectionAuthorizedBy]);
      await client.query(
        `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, now(), now(), now())`, [w.discoveredAssetId, d.organization.id, w.id, w.connectionId, d.platform, w.providerAssetId, d.assetClass, w.assetDisplayName]);
      await client.query(
        `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', now(), now(), now())`, [w.connectedAccountId, d.organization.id, w.id, w.connectionId, d.platform, w.providerAssetId, d.assetClass]);
    }
    const after = await inspectWorkflowAcceptanceFixture(client, d);
    if (fixtureStatus(after) !== "RESUME_CONVERSATIONS") throw new Error("fixture_hierarchy_not_established");
    await client.query("commit");
    return undefined;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** ONE interaction through the real ingestion path: the synthetic simulator's listing → trusted mapping → ingestInteractionFact. */
async function ingestOne(worker: RuntimeDatabase<"worker">, clock: { readonly newId: () => string; readonly now: () => Date }, d: WorkflowAcceptanceDescriptor,
  w: AcceptanceWorkspace, providerInteractionId: string, correlation: string, notices: OutboxNotice[]): Promise<void> {
  const { scenario } = loadWorkflowAcceptanceScenario(d);
  const world = new SimulatorWorld(scenario);
  const read: ProviderReadPort = createSimulatorReadPort(world, { webhookSigningKey: SIMULATED_WEBHOOK_KEY });
  const access: ProviderAccess = { credential: world.credential(d.credentialId), account: world.assetRef(w.providerAssetId) };
  const content = await findListed<ContentDto>((cursor) => read.listContent(access, LISTING, cursor), (item) => item.ref.id === w.providerContentId);
  const dto = await findListed<InteractionDto>((cursor) => read.listInteractions(access, { kind: "content", content: content.ref }, LISTING, cursor), (item) => item.ref.id === providerInteractionId);
  const observedAt = parseInstant(clock.now().toISOString());
  const workspaceId = parseWorkspaceId(w.id);
  const correlationId = parseCorrelationId(correlation);
  if (observedAt === undefined || workspaceId === undefined || correlationId === undefined) throw new Error("fixture_identity_invalid");
  const fact = interactionSourceFactFromDto(dto, {
    workspaceId,
    connectedAccountId: w.connectedAccountId,
    providerAssetId: w.providerAssetId,
    mechanism: "reconciliation",
    operation: "listInteractions",
    provenance: "listed",
    observedAt,
    // The evaluation context is not persisted; the fixture accounts have no capability profile (revision 1 = none read).
    catalogRevision: SIMULATOR_CATALOG.revision,
    profileRevision: 1,
  });
  const outcome = await withWorkspaceJobScope(worker, workspaceId, (tx) => ingestInteractionFact(ingestionStores({ tx, noteOutbox: (notice) => notices.push(notice) }), clock, {
    fact,
    content: { contentKind: content.contentKind, reportedSource: content.reportedSource },
    availability: AVAILABILITY,
    // First observation of an account with no watermark: the canonical arrival rule (epoch null).
    arrival: reconciliationArrival({ epoch: null, providerCreatedAt: fact.time.providerCreatedAt }),
    correlationId,
  }));
  if (outcome.kind !== "applied" || outcome.changes.length !== 1 || outcome.changes[0] !== "created") throw new Error(`fixture_ingestion_unexpected_${outcome.kind}`);
}

async function findListed<T extends { readonly ref: { readonly id: string } }>(list: (cursor: PageCursor | null) => Promise<{ readonly data: Page<T> }>, match: (item: T) => boolean): Promise<T> {
  let cursor: PageCursor | null = null;
  for (let page = 0; page < 20; page += 1) {
    const listed: Page<T> = (await list(cursor)).data;
    const found = listed.items.find(match);
    if (found !== undefined) return found;
    if (listed.next.kind === "end") break;
    cursor = listed.next.cursor;
  }
  throw new Error("fixture_scenario_item_not_listed");
}

const delta = (before: Readonly<Record<string, number>>, after: Readonly<Record<string, number>>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const change = (after[key] ?? 0) - (before[key] ?? 0);
    if (change !== 0) out[key] = change;
  }
  return out;
};

/** Creates (or resumes) stage 1 once; a present, matching fixture is left exactly as it is. */
export async function applyWorkflowAcceptanceFixture(deps: ApplyDependencies, d: WorkflowAcceptanceDescriptor = W12_WORKFLOW_ACCEPTANCE_FIXTURE): Promise<FixtureReport> {
  const initial = await planWorkflowAcceptanceFixture(deps.privileged, d);
  if (initial.status !== "CREATE_ALL" && initial.status !== "RESUME_CONVERSATIONS") return initial;
  const clock = deps.clock ?? { newId: randomUUID, now: () => new Date() };
  const correlationId = `w12-acceptance.fixture.${randomUUID()}`;
  const [censusBefore, outsideBefore] = await readOnly(deps.privileged, async (c) => [await fixtureCensus(c, d), await outsideDigest(c, d)] as const);
  let created = false;
  if (initial.status === "CREATE_ALL") {
    // Something appeared between the plan and the transaction: never adopt it.
    const refused = await createHierarchy(deps.privileged, d);
    if (refused !== undefined) return readOnly(deps.privileged, (c) => reportOf(c, "FIXTURE_IDENTITY_CONFLICT", d, refused));
    created = true;
  }
  await deps.beforeConversations?.();
  const resumed = await readOnly(deps.privileged, (c) => inspectWorkflowAcceptanceFixture(c, d));
  if (fixtureStatus(resumed) !== "RESUME_CONVERSATIONS") return readOnly(deps.privileged, (c) => reportOf(c, fixtureStatus(resumed), d, resumed));
  const notices: OutboxNotice[] = [];
  for (const root of resumed.roots.filter((r) => r.presence === "absent")) {
    await ingestOne(deps.worker, clock, d, workspaceOf(d, root.workspace), root.providerInteractionId, correlationId, notices);
    await deps.afterInteraction?.(root.providerInteractionId);
  }
  return readOnly(deps.privileged, async (c) => {
    const final = await inspectWorkflowAcceptanceFixture(c, d);
    if (fixtureStatus(final) !== "ALREADY_PRESENT_MATCH") throw new Error("fixture_not_established");
    const censusAfter = await fixtureCensus(c, d);
    const measuredDelta = delta(censusBefore, censusAfter);
    const outsideAfter = await outsideDigest(c, d);
    const containment = await fixtureContainment(c, d);
    // Stage 1 complete = exactly the approved footprint (the consumer's own tables excluded: it may already be running).
    const footprintExact = Object.entries(expectedFixtureFootprint(d)).every(([table, n]) => (censusAfter[table] ?? 0) === n);
    const status: FixtureStatus = outsideAfter !== outsideBefore ? "OUTSIDE_DATA_CHANGED" : !containment.ok ? "CONTAINMENT_VIOLATION"
      : !footprintExact ? "POSTCONDITION_FAILED" : created ? "CREATED" : "RESUMED";
    return reportOf(c, status, d, final, { measuredDelta, containment, outsideDigestBefore: outsideBefore, outsideDigestAfter: outsideAfter, correlationId, outboxNotices: notices.length });
  });
}

export interface ReplyReport {
  readonly status: ReplyStatus;
  readonly kind: ReplyKind;
  readonly reason: string | null;
  readonly c2Before: { readonly state: string; readonly version: number } | null;
  readonly c2After: { readonly state: string; readonly version: number } | null;
  readonly reopenEvent: { readonly cause: string | null; readonly versionAfter: number } | null;
  readonly measuredDelta: Readonly<Record<string, number>> | null;
  readonly containment: Containment | null;
  readonly outsideDigestBefore: string | null;
  readonly outsideDigestAfter: string | null;
  readonly correlationId: string | null;
}

interface C2State { readonly state: string; readonly version: number; readonly conversationId: string; readonly interactionId: string }

async function c2State(db: Queryable, d: WorkflowAcceptanceDescriptor, inspection: FixtureInspection): Promise<C2State | null> {
  const c2 = inspection.roots.find((r) => r.providerInteractionId === d.c2.root);
  if (c2?.conversationId === null || c2?.conversationId === undefined || c2.interactionId === null) return null;
  const [row] = await rowsOf<{ state: string; version: number }>(db, "select state, version from workflow.work_items where workspace_id = $1 and id = $2", [workspaceOf(d, "A").id, c2.conversationId]);
  return row === undefined ? null : { state: row.state, version: row.version, conversationId: c2.conversationId, interactionId: c2.interactionId };
}

const replyReport = (status: ReplyStatus, kind: ReplyKind, reason: string | null, extra: Partial<Omit<ReplyReport, "status" | "kind" | "reason">> = {}): ReplyReport => ({
  status, kind, reason, c2Before: extra.c2Before ?? null, c2After: extra.c2After ?? null, reopenEvent: extra.reopenEvent ?? null, measuredDelta: extra.measuredDelta ?? null,
  containment: extra.containment ?? null, outsideDigestBefore: extra.outsideDigestBefore ?? null, outsideDigestAfter: extra.outsideDigestAfter ?? null, correlationId: extra.correlationId ?? null,
});

/** Preconditions of one A-10 reply, read-only: stage 1 complete, the reply order, and C2 DONE (otherwise the check proves nothing). */
async function replyDecision(db: Queryable, d: WorkflowAcceptanceDescriptor, kind: ReplyKind): Promise<{ readonly report: ReplyReport; readonly c2: C2State | null }> {
  const inspection = await inspectWorkflowAcceptanceFixture(db, d);
  const status = fixtureStatus(inspection);
  if (status === "FIXTURE_IDENTITY_CONFLICT") return { report: replyReport("FIXTURE_IDENTITY_CONFLICT", kind, inspection.conflicts.join("; ")), c2: null };
  if (status !== "ALREADY_PRESENT_MATCH") return { report: replyReport("REFUSED_PRECONDITION", kind, "the fixture (stage 1) is not complete"), c2: null };
  const [audience, account] = inspection.replies;
  const target = kind === "audience" ? audience : account;
  const c2 = await c2State(db, d, inspection);
  const before = c2 === null ? null : { state: c2.state, version: c2.version };
  if (target?.presence === "match") return { report: replyReport("ALREADY_PRESENT_MATCH", kind, null, { c2Before: before }), c2 };
  if (kind === "account" && audience?.presence !== "match") return { report: replyReport("REFUSED_PRECONDITION", kind, "the audience reply (A-10 first half) is not present", { c2Before: before }), c2 };
  if (c2 === null) return { report: replyReport("REFUSED_PRECONDITION", kind, "C2 has no work item"), c2 };
  if (c2.state !== "DONE") return { report: replyReport("REFUSED_PRECONDITION", kind, "C2 must be DONE first (U1 marks it done in the acceptance web)", { c2Before: before }), c2 };
  return { report: replyReport("READY", kind, null, { c2Before: before }), c2 };
}

export async function planWorkflowAcceptanceReply(privileged: pg.Pool, kind: ReplyKind, d: WorkflowAcceptanceDescriptor = W12_WORKFLOW_ACCEPTANCE_FIXTURE): Promise<ReplyReport> {
  if (descriptorProblems(d).length > 0) return replyReport("REFUSED_INVALID_DESCRIPTOR", kind, descriptorProblems(d).join("; "));
  if (isProtectedDescriptor(d)) return replyReport("REFUSED_PROTECTED_WORKSPACE", kind, null);
  return readOnly(privileged, async (c) => (await replyDecision(c, d, kind)).report);
}

/** Ingests ONE C2 reply once, then proves the outcome (audience → auto-reopen, version + 1; account → nothing changes). */
export async function applyWorkflowAcceptanceReply(deps: ApplyDependencies, kind: ReplyKind, d: WorkflowAcceptanceDescriptor = W12_WORKFLOW_ACCEPTANCE_FIXTURE): Promise<ReplyReport> {
  const plan = await planWorkflowAcceptanceReply(deps.privileged, kind, d);
  if (plan.status !== "READY") return plan;
  const clock = deps.clock ?? { newId: randomUUID, now: () => new Date() };
  const correlationId = `w12-acceptance.reply-${kind}.${randomUUID()}`;
  const before = await readOnly(deps.privileged, async (c) => {
    const decision = await replyDecision(c, d, kind);
    return { decision, census: await fixtureCensus(c, d), outside: await outsideDigest(c, d) };
  });
  if (before.decision.report.status !== "READY" || before.decision.c2 === null) return before.decision.report;
  const c2 = before.decision.c2;
  const notices: OutboxNotice[] = [];
  await ingestOne(deps.worker, clock, d, workspaceOf(d, "A"), kind === "audience" ? d.c2.audienceReply : d.c2.accountReply, correlationId, notices);
  return readOnly(deps.privileged, async (c) => {
    const inspection = await inspectWorkflowAcceptanceFixture(c, d);
    const after = await c2State(c, d, inspection);
    const reply = inspection.replies[kind === "audience" ? 0 : 1];
    const measuredDelta = delta(before.census, await fixtureCensus(c, d));
    const outsideAfter = await outsideDigest(c, d);
    const containment = await fixtureContainment(c, d);
    const events = await rowsOf<{ cause: string | null; version_after: number; initiator_kind: string; from_state: string; to_state: string }>(c,
      `select cause_interaction_id::text as cause, version_after, initiator_kind, from_state, to_state from workflow.workflow_events
        where workspace_id = $1 and work_item_id = $2 and kind = 'state_changed' and version_after > $3 order by version_after`, [workspaceOf(d, "A").id, c2.conversationId, c2.version]);
    const [event] = events;
    // Audit attributable to THIS ingestion only (the auto-reopen's system audit row carries the ingestion's correlation id):
    // concurrent web activity in A cannot make the check pass or fail.
    const replyAudit = await countOf(c, "select count(*)::int as n from audit.audit_events where workspace_id = $1 and correlation_id = $2", [workspaceOf(d, "A").id, correlationId]);
    const common = { c2Before: { state: c2.state, version: c2.version }, c2After: after === null ? null : { state: after.state, version: after.version }, measuredDelta, containment,
      outsideDigestBefore: before.outside, outsideDigestAfter: outsideAfter, correlationId, reopenEvent: event === undefined ? null : { cause: event.cause, versionAfter: event.version_after } };
    if (outsideAfter !== before.outside) return replyReport("OUTSIDE_DATA_CHANGED", kind, "data outside the fixture changed", common);
    if (!containment.ok) return replyReport("CONTAINMENT_VIOLATION", kind, "a side effect outside the allowed tables or topics", common);
    const proven = reply?.presence === "match" && after !== null && (kind === "audience"
      ? after.state === "OPEN" && after.version === c2.version + 1 && events.length === 1 && event?.initiator_kind === "system_auto_reopen" && event.cause === reply.interactionId
        && event.from_state === "DONE" && event.to_state === "OPEN" && replyAudit === 1
      : after.state === "DONE" && after.version === c2.version && events.length === 0 && replyAudit === 0);
    return replyReport(proven ? "INGESTED" : "POSTCONDITION_FAILED", kind, proven ? null : "the Workflow outcome is not the expected one", common);
  });
}

/** The safe, single-line operator summary (ids, counts, states, digests; never text, URLs or credentials). */
export function formatWorkflowAcceptanceReport(command: string, mode: "plan" | "apply", report: object): string {
  return JSON.stringify({ fixture: "w12-workflow-acceptance", command, mode, ...report });
}
