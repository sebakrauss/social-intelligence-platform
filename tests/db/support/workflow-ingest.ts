/**
 * WORKFLOW-WF-2C — synthetic ingestion through the PRODUCTION path for the workflow suites (TEST BOOTSTRAP, synthetic
 * only): a tenant with a Meta connection and the simulator's Facebook page, the simulator's organic post, and synthetic
 * sightings built from its first listed comment, ingested by ingestInteractionFact in a worker transaction.
 *
 * `generation: "previous"` models the worker build BEFORE WF-2B: the same canonical writes with NO workflow projection
 * (the membership sink does nothing) — what a deployment gap between migration 0034 and the new worker produces.
 */
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { parseCorrelationId, type CorrelationId } from "@/domain/correlation";
import { parseInstant, type Instant } from "@/domain/instant";
import type { ContentDto, InteractionDto, Page, PageCursor, ProviderAccess, TimeWindow } from "@/integrations/providers/contract";
import { parseIsoInstant } from "@/integrations/providers/contract";
import type { AvailabilityInput } from "@/modules/coverage";
import { ingestInteractionFact, interactionSourceFactFromDto, type IngestionStores, type IngestOutcome } from "@/modules/ingestion";
import { parseInteractionSourceFact, type InteractionSourceFact } from "@/modules/interactions";
import { withWorkspaceJobScope, type RuntimeDatabase } from "@/platform/db";
import { ingestionStores } from "@/server/persistence/ingestion";
import { createBaselineSimulator } from "../../providers/support/simulator-harness";

const FB: AvailabilityInput = { state: "AVAILABLE", reason: "CAPABILITY_SUPPORTED", limitationCode: null };
const LISTING: TimeWindow = { from: must(parseIsoInstant("2026-01-01T00:00:00.000Z"), "instant"), to: must(parseIsoInstant("2027-01-01T00:00:00.000Z"), "instant") };
export const INGEST_ROLES = ["OWNER", "MANAGER", "RESPONDER", "ANALYST_VIEWER"] as const;
export type IngestRole = (typeof INGEST_ROLES)[number];

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(what);
  return value;
}

export interface IngestTenant {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly users: Readonly<Record<IngestRole, string>>;
  readonly account: string;
}

export async function ingestTenant(privileged: pg.Pool | pg.Client): Promise<IngestTenant> {
  const organizationId = randomUUID();
  const workspaceId = randomUUID();
  await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Workflow WF-2C', now())", [organizationId]);
  await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'STANDARD', now())", [workspaceId, organizationId]);
  const users = {} as Record<IngestRole, string>;
  for (const role of INGEST_ROLES) {
    const user = randomUUID();
    users[role] = user;
    await privileged.query("insert into tenancy.organization_memberships values ($1, $2, $3, now())", [organizationId, user, role === "OWNER" ? "OWNER" : "MEMBER"]);
    await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, $4, '{}', now())", [organizationId, workspaceId, user, role]);
  }
  const connection = randomUUID();
  await privileged.query(
    `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
     values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`, [connection, organizationId, workspaceId, users.OWNER]);
  const discovered = randomUUID();
  await privileged.query(
    `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
     values ($1, $2, $3, $4, 'facebook', 'fb_page_aurora', 'content_bearing', 'Synthetic', now(), now(), now())`, [discovered, organizationId, workspaceId, connection]);
  const account = randomUUID();
  await privileged.query(
    `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
     select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`, [account, discovered]);
  return { organizationId, workspaceId, users, account };
}

/** The simulator's organic post and a template fact (its first comment) for synthetic sightings. */
export async function organicTemplate(t: IngestTenant): Promise<{ readonly content: ContentDto; readonly base: InteractionSourceFact }> {
  const sim = createBaselineSimulator();
  const access: ProviderAccess = sim.access("cred_meta_main", "fb_page_aurora");
  let content: ContentDto | undefined;
  for (let cursor: PageCursor | null = null; content === undefined;) {
    const page: Page<ContentDto> = (await sim.read.listContent(access, LISTING, cursor)).data;
    content = page.items.find((item) => item.ref.id === "fb_post_organic_01");
    if (content === undefined && page.next.kind === "end") throw new Error("content not listed");
    if (page.next.kind !== "end") cursor = page.next.cursor;
  }
  let dto: InteractionDto | undefined;
  for (let cursor: PageCursor | null = null; dto === undefined;) {
    const page: Page<InteractionDto> = (await sim.read.listInteractions(access, { kind: "content", content: content.ref }, LISTING, cursor)).data;
    dto = page.items.find((item) => item.ref.id === "fb_c_001");
    if (dto === undefined && page.next.kind === "end") throw new Error("fb_c_001");
    if (page.next.kind !== "end") cursor = page.next.cursor;
  }
  const instant: Instant = must(parseInstant(sim.world.now()), "instant");
  const base = interactionSourceFactFromDto(dto, { workspaceId: t.workspaceId as never, connectedAccountId: t.account, providerAssetId: "fb_page_aurora", mechanism: "reconciliation", operation: "listInteractions", provenance: "listed", observedAt: instant, catalogRevision: 5, profileRevision: 5 });
  return { content, base };
}

/** A synthetic sighting: its own provider id, parent, author, platform time and observation time. */
export function sighting(base: InteractionSourceFact, input: { readonly id: string; readonly parent: string | null; readonly author: "user" | "brand"; readonly createdAt: string; readonly observedAt: string }): InteractionSourceFact {
  const text = `synthetic ${input.id}`;
  const parsed = parseInteractionSourceFact({
    ...base,
    identity: { ...base.identity, interactionId: input.id, parentId: input.parent, kind: input.parent === null ? "comment" : "reply" },
    author: input.author === "brand" ? { ref: "fb_author_aurora", role: "account_identity", label: null } : { ref: `fb_user_${input.id}`, role: "user", label: null },
    text: { sourceText: text, textHash: createHash("sha256").update(text).digest("hex") },
    state: { ...base.state, visibility: "visible", availability: "available", removalBasis: null },
    time: { providerCreatedAt: input.createdAt, providerEditedAt: null, observedAt: input.observedAt },
  });
  if (!parsed.ok) throw new Error(`fact invalid: ${parsed.violations.join(",")}`);
  return parsed.fact;
}

export function ingestAs(worker: RuntimeDatabase<"worker">, t: IngestTenant, content: ContentDto, fact: InteractionSourceFact, options: { readonly generation?: "current" | "previous"; readonly wrap?: (stores: IngestionStores) => IngestionStores } = {}): Promise<IngestOutcome> {
  const correlationId: CorrelationId = must(parseCorrelationId(`wf2c-ing-${randomUUID()}`), "correlation");
  return withWorkspaceJobScope(worker, t.workspaceId, (tx) => {
    const current = ingestionStores({ tx, noteOutbox: () => undefined });
    const generation: IngestionStores = options.generation === "previous" ? { ...current, workflow: { membersJoined: () => Promise.resolve() } } : current;
    return ingestInteractionFact(options.wrap === undefined ? generation : options.wrap(generation), { newId: randomUUID, now: () => new Date() }, {
      fact, content: { contentKind: content.contentKind, reportedSource: content.reportedSource }, availability: FB, arrival: "reconciliation", correlationId });
  });
}
