/**
 * Step H7-B1b-0 — the shared-dev canonical acceptance fixture of the deterministic Classification runtime. Operator
 * tooling (tools/db/dev-fixture.ts → vitest.dev-fixture.config.ts → classification-acceptance.operator.ts) and the
 * local disposable suite (tests/db/suites/dev-fixture-classification-acceptance.ts) use exactly this module; no
 * deployed runtime imports it.
 *
 * ONE dedicated synthetic chain, nothing borrowed from real data:
 *
 *   hierarchy (fixed synthetic ids, one privileged transaction): organization → workspace (MONITOR_ONLY, no member)
 *     → connection (provider `simulator`, ACTIVE, NO credential) → discovered asset → connected account (facebook)
 *   canonical (the REAL ingestion path, one worker job transaction bound to the fixture workspace): the synthetic
 *     simulator scenario's listing → the trusted DTO mapping (interactionSourceFactFromDto: reconciliation ·
 *     listInteractions · listed — true of the simulator read) → ingestInteractionFact → content, author, interaction,
 *     ONE immutable source text version, state observation, conversation, ONE `created` ingestion event and its
 *     IDs-only `interactions.observed` outbox row (the canonical emitter's; its id is the outbox row's genuine id)
 *
 * Arrival: the canonical rule for a first observation (no watermark → epoch null) — reconciliationArrival → backfill.
 * The provider `simulator` connection is inert in every deployed plane (no simulator composition there). Classification
 * rows are NEVER written here: only the deployed `interactions.observed` consumer may create them (read-only counts).
 *
 * Idempotency is identity, never adoption: an absent object is created; a present one must match the descriptor
 * EXACTLY (the hierarchy row by row, the canonical chain as a whole) or the run stops with FIXTURE_IDENTITY_CONFLICT
 * and writes nothing. A present, matching fixture is ALREADY_PRESENT_MATCH and nothing is written (not even an
 * observation time). The hierarchy commits before the canonical transaction: a failure between them leaves a
 * matching hierarchy without canonical rows, which plan reports as RESUME_CANONICAL and apply completes.
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
import { detectTextSignals } from "@/modules/classification";
import type { AvailabilityInput } from "@/modules/coverage";
import { ingestInteractionFact, interactionSourceFactFromDto, reconciliationArrival } from "@/modules/ingestion";
import { withWorkspaceJobScope, type RuntimeDatabase } from "@/platform/db";
import type { OutboxNotice } from "@/platform/outbox";
import { ingestionStores } from "@/server/persistence/ingestion";
import { isProtectedWorkspace } from "@/tools/db/dev-fixture-guard";

const ROOT = path.resolve(import.meta.dirname, "../../..");

export interface AcceptanceFixtureDescriptor {
  readonly scenarioFile: string;
  readonly credentialId: string;
  readonly organization: { readonly id: string; readonly name: string };
  readonly workspace: { readonly id: string; readonly name: string; readonly mode: "MONITOR_ONLY" };
  readonly connection: { readonly id: string; readonly provider: "simulator"; readonly status: "ACTIVE"; readonly authorizedBy: string };
  readonly discoveredAssetId: string;
  readonly connectedAccountId: string;
  readonly platform: "facebook";
  readonly providerAssetId: string;
  readonly assetClass: "content_bearing";
  readonly assetDisplayName: string;
  readonly providerContentId: string;
  readonly providerInteractionId: string;
  readonly providerAuthorId: string;
}

/** The one fixture (fixed synthetic ids; nothing here resembles a real Page, account or person). */
export const H7_CLASSIFICATION_ACCEPTANCE_FIXTURE: AcceptanceFixtureDescriptor = Object.freeze({
  scenarioFile: "fixtures/providers/simulator/h7-classification-acceptance.scenario.json",
  credentialId: "wrenkind_fixture_h7_b1b_credential",
  organization: Object.freeze({ id: "a7b1b000-0000-4000-8000-000000000001", name: "Wrenkind H7 Acceptance Fixture (synthetic)" }),
  workspace: Object.freeze({ id: "a7b1b000-0000-4000-8000-000000000002", name: "Wrenkind H7 Acceptance Fixture", mode: "MONITOR_ONLY" as const }),
  // authorizedBy: a synthetic actor id (no auth user exists for it; the column has no foreign key).
  connection: Object.freeze({ id: "a7b1b000-0000-4000-8000-000000000003", provider: "simulator" as const, status: "ACTIVE" as const, authorizedBy: "a7b1b000-0000-4000-8000-000000000006" }),
  discoveredAssetId: "a7b1b000-0000-4000-8000-000000000004",
  connectedAccountId: "a7b1b000-0000-4000-8000-000000000005",
  platform: "facebook" as const,
  providerAssetId: "wrenkind_fixture_h7_b1b_page",
  assetClass: "content_bearing" as const,
  assetDisplayName: "Wrenkind H7 Acceptance Fixture (synthetic page)",
  providerContentId: "wrenkind_fixture_h7_b1b_post",
  providerInteractionId: "wrenkind_fixture_h7_b1b_comment",
  providerAuthorId: "wrenkind_fixture_h7_b1b_user",
});

/** The fixture's read was gated on this availability (the scenario's simulated grants include sim.read_interactions). */
const AVAILABILITY: AvailabilityInput = { state: "AVAILABLE", reason: "CAPABILITY_SUPPORTED", limitationCode: null };
const LISTING: TimeWindow = {
  from: parseIsoInstant("2026-10-01T00:00:00.000Z") ?? (() => { throw new Error("instant"); })(),
  to: parseIsoInstant("2026-10-30T00:00:00.000Z") ?? (() => { throw new Error("instant"); })(),
};
const SIMULATED_WEBHOOK_KEY = "synthetic-h7-fixture-webhook-key-not-a-secret";

export type FixturePlanStatus = "CREATE_ALL" | "RESUME_CANONICAL" | "ALREADY_PRESENT_MATCH" | "FIXTURE_IDENTITY_CONFLICT" | "REFUSED_PROTECTED_WORKSPACE";
export type FixtureApplyStatus = "CREATED" | "RESUMED" | "ALREADY_PRESENT_MATCH" | "FIXTURE_IDENTITY_CONFLICT" | "REFUSED_PROTECTED_WORKSPACE";

type Presence = "absent" | "match" | "mismatch";

export interface FixtureCanonicalIds {
  readonly interactionId: string;
  readonly sourceTextVersionId: string;
  readonly ingestionEventId: string;
  readonly outboxId: string;
  readonly conversationId: string | null;
  readonly contentItemId: string;
}

export interface FixtureInspection {
  readonly hierarchy: Readonly<Record<"organization" | "workspace" | "connection" | "discoveredAsset" | "connectedAccount", Presence>>;
  readonly foreignAssetUses: number;
  readonly credentials: number;
  readonly canonical: Presence;
  readonly canonicalIds: FixtureCanonicalIds | null;
  readonly outboxStatus: string | null;
  readonly counts: Readonly<Record<string, number>>;
  readonly conflicts: readonly string[];
}

export interface FixtureReport {
  readonly status: FixturePlanStatus | FixtureApplyStatus;
  readonly workspaceId: string;
  readonly ids: FixtureCanonicalIds | null;
  readonly text: { readonly length: number; readonly sha256: string };
  readonly expectedSignals: readonly string[];
  readonly arrival: "backfill" | "reconciliation";
  readonly outboxStatus: string | null;
  readonly counts: Readonly<Record<string, number>>;
  readonly conflicts: readonly string[];
  readonly outboxNotices: number;
}

interface Queryable {
  query<T extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** The synthetic scenario, validated, and its ONE interaction (it must agree with the descriptor exactly). */
export function loadAcceptanceScenario(d: AcceptanceFixtureDescriptor = H7_CLASSIFICATION_ACCEPTANCE_FIXTURE): { readonly scenario: SimulatorScenario; readonly text: string } {
  const scenario = parseScenario(JSON.parse(readFileSync(path.join(ROOT, d.scenarioFile), "utf8")));
  const [asset] = scenario.assets;
  const [content] = scenario.contents;
  const [interaction] = scenario.interactions;
  if (scenario.assets.length !== 1 || scenario.contents.length !== 1 || scenario.interactions.length !== 1 || asset === undefined || content === undefined || interaction === undefined) {
    throw new Error("fixture_scenario_shape");
  }
  if (asset.id !== d.providerAssetId || asset.platform !== d.platform || asset.assetClass !== d.assetClass || content.id !== d.providerContentId || content.account !== asset.id
    || interaction.id !== d.providerInteractionId || interaction.content !== content.id || interaction.parent !== null || interaction.author !== d.providerAuthorId
    || scenario.authors.find((author) => author.id === d.providerAuthorId)?.role !== "user" || !scenario.credentials.some((credential) => credential.id === d.credentialId)) {
    throw new Error("fixture_scenario_descriptor_mismatch");
  }
  return { scenario, text: interaction.text };
}

const rowsOf = async <T extends pg.QueryResultRow>(db: Queryable, sql: string, values: unknown[]): Promise<readonly T[]> => (await db.query<T>(sql, values)).rows;
/** Exactly one row, or undefined (none, or an ambiguous several — the caller has already required exactly one). */
const one = async <T extends pg.QueryResultRow>(db: Queryable, sql: string, values: unknown[]): Promise<T | undefined> => {
  const rows = await rowsOf<T>(db, sql, values);
  return rows.length === 1 ? rows[0] : undefined;
};
/** No row → absent; exactly one row equal to the descriptor on every listed field → match; anything else → mismatch. */
const presence = (rows: readonly Readonly<Record<string, unknown>>[], expected: Readonly<Record<string, unknown>>): Presence => {
  const [row] = rows;
  if (row === undefined) return "absent";
  return rows.length === 1 && Object.entries(expected).every(([key, value]) => row[key] === value) ? "match" : "mismatch";
};

/** Read-only: what exists at the fixture's identity, and whether it is exactly the fixture. */
export async function inspectAcceptanceFixture(db: Queryable, d: AcceptanceFixtureDescriptor = H7_CLASSIFICATION_ACCEPTANCE_FIXTURE): Promise<FixtureInspection> {
  const { text } = loadAcceptanceScenario(d);
  const ws = d.workspace.id;
  const hierarchy = {
    organization: presence(await rowsOf(db, "select id::text, name from tenancy.organizations where id = $1", [d.organization.id]), { id: d.organization.id, name: d.organization.name }),
    workspace: presence(await rowsOf(db, "select id::text, organization_id::text, name, mode from tenancy.workspaces where id = $1", [ws]),
      { id: ws, organization_id: d.organization.id, name: d.workspace.name, mode: d.workspace.mode }),
    connection: presence(await rowsOf(db, `select id::text, organization_id::text, workspace_id::text, provider, status, active_credential_id::text, authorized_by::text
                                          from connections.connections where id = $1`, [d.connection.id]),
      { id: d.connection.id, organization_id: d.organization.id, workspace_id: ws, provider: d.connection.provider, status: d.connection.status, active_credential_id: null, authorized_by: d.connection.authorizedBy }),
    discoveredAsset: presence(await rowsOf(db, `select id::text, organization_id::text, workspace_id::text, connection_id::text, platform, provider_asset_id, asset_class, display_name
                                               from connections.discovered_assets where id = $1`, [d.discoveredAssetId]),
      { id: d.discoveredAssetId, organization_id: d.organization.id, workspace_id: ws, connection_id: d.connection.id, platform: d.platform, provider_asset_id: d.providerAssetId, asset_class: d.assetClass, display_name: d.assetDisplayName }),
    connectedAccount: presence(await rowsOf(db, `select id::text, organization_id::text, workspace_id::text, connection_id::text, platform, provider_asset_id, asset_class, status, deactivated_at
                                                from connections.connected_accounts where id = $1`, [d.connectedAccountId]),
      { id: d.connectedAccountId, organization_id: d.organization.id, workspace_id: ws, connection_id: d.connection.id, platform: d.platform, provider_asset_id: d.providerAssetId, asset_class: d.assetClass, status: "ACTIVE", deactivated_at: null }),
  };
  const count = async (sql: string, values: unknown[]): Promise<number> => (await db.query<{ n: number }>(sql, values)).rows[0]?.n ?? -1;
  const foreignAssetUses = await count(
    `select (select count(*) from connections.connected_accounts where platform = $1 and provider_asset_id = $2 and id <> $3)
          + (select count(*) from connections.discovered_assets where platform = $1 and provider_asset_id = $2 and id <> $4) as n`, [d.platform, d.providerAssetId, d.connectedAccountId, d.discoveredAssetId]);
  const credentials = await count("select count(*)::int as n from credentials.provider_credentials where workspace_id = $1", [ws]);
  const tables = ["content.content_items", "interactions.authors", "interactions.interactions", "interactions.source_text_versions", "interactions.state_observations",
    "conversations.conversations", "ingestion.ingestion_events", "system.outbox", "classification.understanding_requests", "classification.signals", "classification.assessments"];
  const counts: Record<string, number> = {};
  for (const table of tables) counts[table] = await count(`select count(*)::int as n from ${table} where workspace_id = $1`, [ws]);

  // The canonical chain, as a whole: exactly one of each, and each exactly the fixture's.
  const canonicalTotal = ["content.content_items", "interactions.authors", "interactions.interactions", "interactions.source_text_versions", "interactions.state_observations",
    "conversations.conversations", "ingestion.ingestion_events", "system.outbox"].reduce((sum, table) => sum + (counts[table] ?? 0), 0);
  let canonical: Presence = canonicalTotal === 0 ? "absent" : "mismatch";
  let canonicalIds: FixtureCanonicalIds | null = null;
  let outboxStatus: string | null = null;
  const conflicts: string[] = [];
  if (canonicalTotal > 0) {
    const exactlyOne = ["content.content_items", "interactions.authors", "interactions.interactions", "interactions.source_text_versions", "interactions.state_observations",
      "conversations.conversations", "ingestion.ingestion_events", "system.outbox"].every((table) => counts[table] === 1);
    const interaction = !exactlyOne ? undefined : await one<{ id: string; observed: boolean; kind: string; author_role: string; connected_account_id: string; provider_asset_id: string; provider_content_id: string;
      parent: string | null; visibility: string; availability: string; current_version: string | null; conversation_id: string | null; content_item_id: string }>(db,
      `select id::text, observed, kind, author_role, connected_account_id::text, provider_asset_id, provider_content_id, parent_interaction_id::text as parent,
              current_visibility as visibility, current_availability as availability, current_source_text_version_id::text as current_version,
              conversation_id::text, content_item_id::text
         from interactions.interactions where workspace_id = $1 and platform = $2 and provider_interaction_id = $3`, [ws, d.platform, d.providerInteractionId]);
    const version = interaction === undefined ? undefined : await one<{ id: string; text_hash: string; same_text: boolean }>(db,
      "select id::text, text_hash, source_text = $3 as same_text from interactions.source_text_versions where workspace_id = $1 and interaction_id = $2", [ws, interaction.id, text]);
    const event = interaction === undefined ? undefined : await one<{ id: string; conversation_id: string | null; version: string | null; change: string; arrival: string }>(db,
      "select id::text, conversation_id::text, source_text_version_id::text as version, change, arrival from ingestion.ingestion_events where workspace_id = $1 and interaction_id = $2", [ws, interaction.id]);
    const outbox = event === undefined ? undefined : await one<{ id: string; topic: string; subjects: Record<string, string>; status: string }>(db,
      "select id::text, topic, subject_ids as subjects, status from system.outbox where workspace_id = $1 and subject_ids ->> 'ingestion_event_id' = $2", [ws, event.id]);
    const content = !exactlyOne ? undefined : await one<{ id: string; provider_content_id: string; connected_account_id: string }>(db,
      "select id::text, provider_content_id, connected_account_id::text from content.content_items where workspace_id = $1", [ws]);
    const author = !exactlyOne ? undefined : await one<{ provider_author_id: string; role: string }>(db, "select provider_author_id, role from interactions.authors where workspace_id = $1", [ws]);
    const expectedSubjects = interaction === undefined || version === undefined || event === undefined ? undefined : {
      ingestion_event_id: event.id, interaction_id: interaction.id, source_text_version_id: version.id, ...(interaction.conversation_id === null ? {} : { conversation_id: interaction.conversation_id }),
    };
    const coherent = interaction !== undefined && version !== undefined && event !== undefined && outbox !== undefined && content !== undefined && author !== undefined
      && interaction.observed && interaction.kind === "comment" && interaction.author_role === "user" && interaction.parent === null
      && interaction.connected_account_id === d.connectedAccountId && interaction.provider_asset_id === d.providerAssetId && interaction.provider_content_id === d.providerContentId
      && interaction.visibility === "visible" && interaction.availability === "available" && interaction.current_version === version.id && interaction.content_item_id === content.id
      && version.text_hash === sha256(text) && version.same_text
      && event.change === "created" && event.version === version.id && event.arrival === "backfill" && event.conversation_id === interaction.conversation_id
      && outbox.topic === "interactions.observed" && JSON.stringify(Object.entries(outbox.subjects).sort()) === JSON.stringify(Object.entries(expectedSubjects ?? {}).sort())
      && content.provider_content_id === d.providerContentId && content.connected_account_id === d.connectedAccountId
      && author.provider_author_id === d.providerAuthorId && author.role === "user";
    if (coherent) {
      canonical = "match";
      canonicalIds = { interactionId: interaction.id, sourceTextVersionId: version.id, ingestionEventId: event.id, outboxId: outbox.id, conversationId: interaction.conversation_id, contentItemId: content.id };
      outboxStatus = outbox.status;
    } else conflicts.push("canonical chain differs from the fixture");
  }
  for (const [name, state] of Object.entries(hierarchy)) if (state === "mismatch") conflicts.push(`${name} differs from the fixture`);
  const states = Object.values(hierarchy);
  if (states.includes("absent") && states.includes("match")) conflicts.push("hierarchy is partially present");
  if (states.includes("absent") && canonicalTotal > 0) conflicts.push("canonical rows without the fixture hierarchy");
  if (foreignAssetUses > 0) conflicts.push("the fixture asset id is used outside the fixture");
  if (credentials !== 0) conflicts.push("a credential exists in the fixture workspace");
  return { hierarchy, foreignAssetUses, credentials, canonical, canonicalIds, outboxStatus, counts, conflicts };
}

const planStatus = (inspection: FixtureInspection): FixturePlanStatus => {
  if (inspection.conflicts.length > 0) return "FIXTURE_IDENTITY_CONFLICT";
  const states = Object.values(inspection.hierarchy);
  if (states.every((state) => state === "absent")) return "CREATE_ALL";
  return inspection.canonical === "absent" ? "RESUME_CANONICAL" : "ALREADY_PRESENT_MATCH";
};

const reportOf = (status: FixtureReport["status"], d: AcceptanceFixtureDescriptor, inspection: FixtureInspection | null, outboxNotices: number): FixtureReport => {
  const { scenario, text } = loadAcceptanceScenario(d);
  const providerCreatedAt = parseInstant(scenario.interactions[0]?.createdAt ?? "");
  if (providerCreatedAt === undefined) throw new Error("fixture_scenario_instant");
  return {
    status,
    workspaceId: d.workspace.id,
    ids: inspection?.canonicalIds ?? null,
    text: { length: text.length, sha256: sha256(text) },
    expectedSignals: detectTextSignals(text).map((signal) => signal.kind),
    arrival: reconciliationArrival({ epoch: null, providerCreatedAt }),
    outboxStatus: inspection?.outboxStatus ?? null,
    counts: inspection?.counts ?? {},
    conflicts: inspection?.conflicts ?? [],
    outboxNotices,
  };
};

/** Read-only plan (one READ ONLY transaction). */
export async function planAcceptanceFixture(privileged: pg.Pool, d: AcceptanceFixtureDescriptor = H7_CLASSIFICATION_ACCEPTANCE_FIXTURE): Promise<FixtureReport> {
  if (isProtectedWorkspace(d.workspace.id) || isProtectedWorkspace(d.organization.id)) return reportOf("REFUSED_PROTECTED_WORKSPACE", d, null, 0);
  const client = await privileged.connect();
  try {
    await client.query("begin read only");
    const inspection = await inspectAcceptanceFixture(client, d);
    await client.query("rollback");
    return reportOf(planStatus(inspection), d, inspection, 0);
  } finally {
    client.release();
  }
}

export interface ApplyDependencies {
  readonly privileged: pg.Pool;
  readonly worker: RuntimeDatabase<"worker">;
  readonly clock?: { readonly newId: () => string; readonly now: () => Date };
  /** Test seam: runs after the hierarchy committed and before the canonical transaction. */
  readonly beforeCanonical?: () => Promise<void>;
}

/** The hierarchy rows, in one SERIALIZABLE transaction that re-inspects first (absent → insert; anything else → stop). */
async function createHierarchy(privileged: pg.Pool, d: AcceptanceFixtureDescriptor): Promise<FixtureInspection | undefined> {
  const client = await privileged.connect();
  try {
    await client.query("begin isolation level serializable");
    const before = await inspectAcceptanceFixture(client, d);
    if (planStatus(before) !== "CREATE_ALL") {
      await client.query("rollback");
      return before;
    }
    await client.query("insert into tenancy.organizations (id, name, created_at) values ($1, $2, now())", [d.organization.id, d.organization.name]);
    await client.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, $3, $4, now())", [d.workspace.id, d.organization.id, d.workspace.name, d.workspace.mode]);
    await client.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, $4, $5, null, $6, now(), 1, now(), now())`, [d.connection.id, d.organization.id, d.workspace.id, d.connection.provider, d.connection.status, d.connection.authorizedBy]);
    await client.query(
      `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now(), now(), now())`, [d.discoveredAssetId, d.organization.id, d.workspace.id, d.connection.id, d.platform, d.providerAssetId, d.assetClass, d.assetDisplayName]);
    await client.query(
      `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', now(), now(), now())`, [d.connectedAccountId, d.organization.id, d.workspace.id, d.connection.id, d.platform, d.providerAssetId, d.assetClass]);
    const after = await inspectAcceptanceFixture(client, d);
    if (planStatus(after) !== "RESUME_CANONICAL") throw new Error("fixture_hierarchy_not_established");
    await client.query("commit");
    return undefined;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The canonical chain through the real ingestion path (the synthetic simulator listing → mapping → ingestInteractionFact). */
async function ingestCanonical(worker: RuntimeDatabase<"worker">, clock: { readonly newId: () => string; readonly now: () => Date }, d: AcceptanceFixtureDescriptor, notices: OutboxNotice[]): Promise<void> {
  const { scenario } = loadAcceptanceScenario(d);
  const world = new SimulatorWorld(scenario);
  const read: ProviderReadPort = createSimulatorReadPort(world, { webhookSigningKey: SIMULATED_WEBHOOK_KEY });
  const access: ProviderAccess = { credential: world.credential(d.credentialId), account: world.assetRef(d.providerAssetId) };
  const content = await findListed<ContentDto>((cursor) => read.listContent(access, LISTING, cursor), (item) => item.ref.id === d.providerContentId);
  const dto = await findListed<InteractionDto>((cursor) => read.listInteractions(access, { kind: "content", content: content.ref }, LISTING, cursor), (item) => item.ref.id === d.providerInteractionId);
  const observedAt = parseInstant(clock.now().toISOString());
  const workspaceId = parseWorkspaceId(d.workspace.id);
  const correlationId = parseCorrelationId(`dev-fixture.h7-b1b.${randomUUID()}`);
  if (observedAt === undefined || workspaceId === undefined || correlationId === undefined) throw new Error("fixture_identity_invalid");
  const fact = interactionSourceFactFromDto(dto, {
    workspaceId,
    connectedAccountId: d.connectedAccountId,
    providerAssetId: d.providerAssetId,
    mechanism: "reconciliation",
    operation: "listInteractions",
    provenance: "listed",
    observedAt,
    // The evaluation context is not persisted; the fixture account has no capability profile (revision 1 = none read).
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

/** Creates (or resumes) the fixture once; a present, matching fixture is left exactly as it is. */
export async function applyAcceptanceFixture(deps: ApplyDependencies, d: AcceptanceFixtureDescriptor = H7_CLASSIFICATION_ACCEPTANCE_FIXTURE): Promise<FixtureReport> {
  if (isProtectedWorkspace(d.workspace.id) || isProtectedWorkspace(d.organization.id)) return reportOf("REFUSED_PROTECTED_WORKSPACE", d, null, 0);
  const clock = deps.clock ?? { newId: randomUUID, now: () => new Date() };
  const initial = await planAcceptanceFixture(deps.privileged, d);
  if (initial.status === "FIXTURE_IDENTITY_CONFLICT" || initial.status === "ALREADY_PRESENT_MATCH") return initial;
  let created = false;
  if (initial.status === "CREATE_ALL") {
    // Something appeared between the plan and the transaction: never adopt it.
    const refused = await createHierarchy(deps.privileged, d);
    if (refused !== undefined) return reportOf("FIXTURE_IDENTITY_CONFLICT", d, refused, 0);
    created = true;
  }
  await deps.beforeCanonical?.();
  const resumed = await planAcceptanceFixture(deps.privileged, d);
  if (resumed.status !== "RESUME_CANONICAL") return resumed;
  const notices: OutboxNotice[] = [];
  await ingestCanonical(deps.worker, clock, d, notices);
  const client = await deps.privileged.connect();
  try {
    await client.query("begin read only");
    const final = await inspectAcceptanceFixture(client, d);
    await client.query("rollback");
    if (planStatus(final) !== "ALREADY_PRESENT_MATCH") throw new Error("fixture_not_established");
    return reportOf(created ? "CREATED" : "RESUMED", d, final, notices.length);
  } finally {
    client.release();
  }
}

/** The safe, single-line operator summary (ids, counts, digests; never text, URLs or credentials). */
export function formatFixtureReport(mode: "plan" | "apply", report: FixtureReport): string {
  return JSON.stringify({ fixture: "h7-classification-acceptance", mode, ...report });
}
