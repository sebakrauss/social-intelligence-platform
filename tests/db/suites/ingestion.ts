/**
 * Step H6-B — canonical source persistence, coverage persistence and the simulator ingestion service on the real
 * database (migration 0017). The main path is the simulator's own listing: simulator list DTOs → the trusted mapping
 * (interactionSourceFactFromDto) → parents-first batch order → ingestInteractionFact in a worker transaction bound to
 * one workspace (app_worker + sealed workspace). Only tenants, connections and accounts are bootstrapped synthetically
 * (privileged); no canonical row is hand-written for the main path. No provider is called. Synthetic data only.
 *
 *   acceptance    FB post: comments, a brand reply, a nested reply; hidden; content row; authors; conversations OPEN
 *   idempotency   duplicate · text edit (append-only versions) · text revert · stale text · state change · stale
 *                 state (history only, once) · removal (explicit signal) · absence ≠ deletion
 *   conflicts     content / account / parent / kind / placeholder / parent-scope / thread-anchor → rollback, no write
 *   threads       reply before parent (placeholder, provisional anchor, completion) · IG comment · IG reply refused
 *   events        one append-only event + one IDs-only outbox row per change, atomic with the state (injected failure)
 *   coverage      the nine slice outcomes, idempotent re-record, no record = UNKNOWN, cross-workspace FK refused
 *   security      RLS by workspace and role (guest denied) · append-only grants · column grants · scope guard ·
 *                 conversation OPEN-only · cross-workspace composite FKs · stored authority (persistence-issued)
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCorrelationId, type CorrelationId } from "@/domain/correlation";
import { parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import { parseInstant, type Instant } from "@/domain/instant";
import { parseProviderId, type ProviderId } from "@/domain/provider-identity";
import type { ContentDto, InteractionDto, Page, PageCursor, ProviderAccess, TimeWindow } from "@/integrations/providers/contract";
import { parseIsoInstant } from "@/integrations/providers/contract";
import { measuredInteractionCount, type AvailabilityInput, type SliceReadResult } from "@/modules/coverage";
import { createPostgresCoverageStore } from "@/modules/coverage/persistence";
import {
  IngestionAuthorityConflict,
  ingestInteractionFact,
  interactionSourceFactFromDto,
  orderParentsFirst,
  recordIngestionCoverage,
  type IngestOutcome,
  type IngestionStores,
  type ObservedArrival,
} from "@/modules/ingestion";
import { isStoredInteractionAuthority, parseInteractionSourceFact, verifyStoredReread, type InteractionSourceFact } from "@/modules/interactions";
import { loadStoredInteractionAuthority } from "@/modules/interactions/persistence";
import { withUserScope, withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import type { OutboxNotice } from "@/platform/outbox";
import { ingestionStores } from "@/server/persistence/ingestion";
import { createBaselineSimulator } from "../../providers/support/simulator-harness";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";
import { sqlState } from "./helpers";

const FB: AvailabilityInput = { state: "AVAILABLE", reason: "CAPABILITY_SUPPORTED", limitationCode: null };
const IG: AvailabilityInput = { state: "AVAILABLE_WITH_LIMITATION", reason: "CAPABILITY_LIMITATION", limitationCode: "REPLIES_NOT_READ" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_TABLES = [
  "content.content_items",
  "interactions.authors",
  "interactions.interactions",
  "interactions.source_text_versions",
  "interactions.state_observations",
  "conversations.conversations",
  "coverage.coverage_records",
  "ingestion.ingestion_events",
] as const;

const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(what);
  return value;
};
const instant = (iso: string): Instant => must(parseInstant(iso), "instant");
const providerId = (value: string): ProviderId => must(parseProviderId(value), "provider id");
const correlation = (): CorrelationId => must(parseCorrelationId(`h6b-${randomUUID()}`), "correlation");
const LISTING: TimeWindow = {
  from: must(parseIsoInstant("2026-01-01T00:00:00.000Z"), "instant"),
  to: must(parseIsoInstant("2027-01-01T00:00:00.000Z"), "instant"),
};

interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: WorkspaceId;
  readonly owner: string;
  readonly analyst: string;
  readonly guest: string;
  /** Connected Account ids by simulator asset id. */
  readonly accounts: Readonly<Record<"fb_page_aurora" | "ig_acct_aurora", string>>;
}

type Simulator = ReturnType<typeof createBaselineSimulator>;

export function defineIngestionSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  const organizations: string[] = [];
  const notices: OutboxNotice[] = [];
  const clock = { newId: randomUUID, now: () => new Date() };

  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;
  const countIn = async (table: string, workspaceId: string, where = "true", values: readonly unknown[] = []): Promise<number> =>
    (await oracle<{ n: number }>(`select count(*)::int as n from ${table} where workspace_id = $1 and (${where})`, [workspaceId, ...values]))[0]?.n ?? -1;
  /** Every canonical table's and the outbox's row count for one workspace (the rollback oracle). */
  const snapshot = async (workspaceId: string): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const table of [...CANONICAL_TABLES, "system.outbox"]) out[table] = await countIn(table, workspaceId);
    return out;
  };

  // ── Synthetic tenant: organization, workspace, members, an ACTIVE Meta connection and the two Meta accounts ─────────
  const tenant = async (): Promise<Tenant> => {
    const organizationId = randomUUID();
    const workspaceId = must(parseWorkspaceId(randomUUID()), "workspace");
    const owner = randomUUID();
    const analyst = randomUUID();
    const guest = randomUUID();
    organizations.push(organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Ingestion', now())", [organizationId]);
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'MONITOR_ONLY', now())", [workspaceId, organizationId]);
    for (const [user, orgRole, role] of [[owner, "OWNER", "OWNER"], [analyst, "MEMBER", "ANALYST_VIEWER"], [guest, "MEMBER", "CLIENT_GUEST"]] as const) {
      await privileged.query("insert into tenancy.organization_memberships values ($1, $2, $3, now())", [organizationId, user, orgRole]);
      await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, $4, '{}', now())", [organizationId, workspaceId, user, role]);
    }
    const connection = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`,
      [connection, organizationId, workspaceId, owner],
    );
    const accounts: Record<string, string> = {};
    for (const [asset, platform] of [["fb_page_aurora", "facebook"], ["ig_acct_aurora", "instagram"]] as const) {
      const discovered = randomUUID();
      await privileged.query(
        `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, 'content_bearing', 'Synthetic', now(), now(), now())`,
        [discovered, organizationId, workspaceId, connection, platform, asset],
      );
      const account = randomUUID();
      await privileged.query(
        `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
         select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now()
           from connections.discovered_assets where id = $2`,
        [account, discovered],
      );
      accounts[asset] = account;
    }
    return { organizationId, workspaceId, owner, analyst, guest, accounts: accounts as Tenant["accounts"] };
  };

  // ── The simulator acceptance path ────────────────────────────────────────────────────────────────────────────
  const metaAccess = (sim: Simulator, asset: string): ProviderAccess => sim.access("cred_meta_main", asset);
  const contentDto = async (sim: Simulator, asset: string, contentId: string): Promise<ContentDto> => {
    let cursor: PageCursor | null = null;
    for (;;) {
      const page: Page<ContentDto> = (await sim.read.listContent(metaAccess(sim, asset), LISTING, cursor)).data;
      const found = page.items.find((item) => item.ref.id === contentId);
      if (found !== undefined) return found;
      if (page.next.kind === "end") throw new Error("content not listed");
      cursor = page.next.cursor;
    }
  };
  /** Every page of one content's interactions, as the simulator lists them (newest first). */
  const listedDtos = async (sim: Simulator, asset: string, content: ContentDto): Promise<InteractionDto[]> => {
    const out: InteractionDto[] = [];
    let cursor: PageCursor | null = null;
    for (;;) {
      const page: Page<InteractionDto> = (await sim.read.listInteractions(metaAccess(sim, asset), { kind: "content", content: content.ref }, LISTING, cursor)).data;
      out.push(...page.items);
      if (page.next.kind === "end") return out;
      cursor = page.next.cursor;
    }
  };
  const factOf = (t: Tenant, sim: Simulator, asset: keyof Tenant["accounts"], dto: InteractionDto, operation: "listInteractions" | "getInteraction" = "listInteractions"): InteractionSourceFact =>
    interactionSourceFactFromDto(dto, {
      workspaceId: t.workspaceId,
      connectedAccountId: t.accounts[asset],
      providerAssetId: asset,
      mechanism: "reconciliation",
      operation,
      provenance: "listed",
      observedAt: instant(sim.world.now()),
      catalogRevision: 5,
      profileRevision: 5,
    });
  const patched = (fact: InteractionSourceFact, patch: Record<string, unknown>): InteractionSourceFact => {
    const parsed = parseInteractionSourceFact({ ...fact, ...patch });
    if (!parsed.ok) throw new Error(`patched fact invalid: ${parsed.violations.join(",")}`);
    return parsed.fact;
  };
  const storesFor = (tx: DatabaseTransaction): IngestionStores => ingestionStores({ tx, noteOutbox: (notice) => notices.push(notice) });
  const ingest = (t: Tenant, fact: InteractionSourceFact, content: ContentDto, availability: AvailabilityInput, options: { readonly arrival?: ObservedArrival; readonly wrap?: (stores: IngestionStores) => IngestionStores } = {}): Promise<IngestOutcome> =>
    withWorkspaceJobScope(worker, t.workspaceId, (tx) => {
      const stores = storesFor(tx);
      return ingestInteractionFact(options.wrap === undefined ? stores : options.wrap(stores), clock, {
        fact,
        content: { contentKind: content.contentKind, reportedSource: content.reportedSource },
        availability,
        arrival: options.arrival ?? "reconciliation",
        correlationId: correlation(),
      });
    });
  /** One reconciliation pass over one content: list → map → parents-first → ingest, one transaction per fact. */
  const sync = async (t: Tenant, sim: Simulator, asset: keyof Tenant["accounts"], contentId: string, availability: AvailabilityInput): Promise<IngestOutcome[]> => {
    sim.world.advanceClock(60);
    const content = await contentDto(sim, asset, contentId);
    const facts = orderParentsFirst((await listedDtos(sim, asset, content)).map((dto) => factOf(t, sim, asset, dto)));
    const outcomes: IngestOutcome[] = [];
    for (const fact of facts) outcomes.push(await ingest(t, fact, content, availability));
    return outcomes;
  };
  const conflictOf = async (promise: Promise<unknown>): Promise<readonly string[]> => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof IngestionAuthorityConflict) return error.conflicts;
      throw error;
    }
    throw new Error("expected an authority conflict");
  };
  const row = async (t: Tenant, providerInteractionId: string) =>
    must((await oracle<{ id: string; observed: boolean; kind: string | null; parent_interaction_id: string | null; conversation_id: string | null; current_source_text_version_id: string | null;
      current_visibility: string | null; current_availability: string | null; current_removal_basis: string | null; author_role: string | null; text_observed_at: Date | null; provider_edited_at: Date | null }>(
      "select * from interactions.interactions where workspace_id = $1 and provider_interaction_id = $2", [t.workspaceId, providerInteractionId]))[0], `row ${providerInteractionId}`);
  const kinds = (outcomes: readonly IngestOutcome[]): string[] => outcomes.map((o) => (o.kind === "applied" ? o.changes.join("+") : o.kind));

  beforeAll(() => {
    const target = getTarget();
    privileged = privilegedPool(target);
    web = runtimeDatabase(target, "web");
    worker = runtimeDatabase(target, "worker");
  });
  afterAll(async () => {
    await Promise.all([web.end(), worker.end()]);
    await cleanupWorld(privileged, organizations);
    await privileged.end();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("simulator acceptance (Facebook post with comments, a brand reply and a nested reply)", () => {
    let t: Tenant;
    let sim: Simulator;
    let first: IngestOutcome[];
    beforeAll(async () => {
      t = await tenant();
      sim = createBaselineSimulator();
      first = await sync(t, sim, "fb_page_aurora", "fb_post_organic_01", FB);
    });

    it("lists newest first, ingests parents first, and creates every listed interaction once", async () => {
      const raw = (await listedDtos(sim, "fb_page_aurora", await contentDto(sim, "fb_page_aurora", "fb_post_organic_01"))).map((d): string => d.ref.id);
      expect(raw.indexOf("fb_c_003")).toBeLessThan(raw.indexOf("fb_c_002"));
      expect(raw.indexOf("fb_c_002")).toBeLessThan(raw.indexOf("fb_c_001"));
      // Removed (signaled) and vanished interactions are not listed: 001–006.
      expect(first).toHaveLength(6);
      expect(kinds(first)).toEqual(Array(6).fill("created"));
      expect(await countIn("interactions.interactions", t.workspaceId)).toBe(6);
      expect(await countIn("interactions.interactions", t.workspaceId, "not observed")).toBe(0);
    });

    it("persists the content row, privacy-minimal authors and exact text versions", async () => {
      const content = await oracle<{ content_kind: string; reported_source: string; source_state: string; connected_account_id: string }>(
        "select content_kind, reported_source, source_state, connected_account_id from content.content_items where workspace_id = $1", [t.workspaceId]);
      expect(content).toEqual([{ content_kind: "post", reported_source: "organic", source_state: "available", connected_account_id: t.accounts.fb_page_aurora }]);
      const authors = await oracle<{ provider_author_id: string; role: string }>("select provider_author_id, role from interactions.authors where workspace_id = $1 order by provider_author_id", [t.workspaceId]);
      expect(authors.map((a) => a.provider_author_id)).toEqual(["fb_author_aurora", "fb_user_01", "fb_user_02", "fb_user_03", "fb_user_04"]);
      expect(authors.find((a) => a.provider_author_id === "fb_author_aurora")?.role).toBe("account_identity");
      const columns = await oracle<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'interactions' and table_name = 'authors'");
      expect(columns.map((c) => c.column_name).sort()).toEqual(["created_at", "id", "label", "organization_id", "platform", "provider_author_id", "role", "updated_at", "workspace_id"]);
      const dto = must((await listedDtos(sim, "fb_page_aurora", await contentDto(sim, "fb_page_aurora", "fb_post_organic_01"))).find((d) => d.ref.id === "fb_c_001"), "dto");
      const version = await oracle<{ source_text: string; text_hash: string }>(
        "select v.source_text, v.text_hash from interactions.source_text_versions v join interactions.interactions i on i.workspace_id = v.workspace_id and i.current_source_text_version_id = v.id where i.workspace_id = $1 and i.provider_interaction_id = 'fb_c_001'",
        [t.workspaceId]);
      expect(version).toHaveLength(1);
      expect(version[0]?.source_text).toBe(dto.text);
      expect(await countIn("interactions.source_text_versions", t.workspaceId)).toBe(6);
      expect(await countIn("interactions.state_observations", t.workspaceId)).toBe(6);
      expect((await row(t, "fb_c_006")).current_visibility).toBe("hidden");
    });

    it("anchors one OPEN conversation per top-level audience comment; replies (brand and nested) join it", async () => {
      const c1 = await row(t, "fb_c_001");
      const c2 = await row(t, "fb_c_002");
      const c3 = await row(t, "fb_c_003");
      expect(c2.kind).toBe("reply");
      expect(c2.author_role).toBe("account_identity");
      expect(c2.parent_interaction_id).toBe(c1.id);
      expect(c3.parent_interaction_id).toBe(c2.id);
      expect(c1.conversation_id).not.toBeNull();
      expect(c2.conversation_id).toBe(c1.conversation_id);
      expect(c3.conversation_id).toBe(c1.conversation_id);
      const conversations = await oracle<{ anchor_interaction_id: string; anchor_observed: boolean; workflow_state: string; created_by: string }>(
        "select anchor_interaction_id, anchor_observed, workflow_state, created_by from conversations.conversations where workspace_id = $1", [t.workspaceId]);
      // 001 (with 002, 003), 004, 005, 006.
      expect(conversations).toHaveLength(4);
      expect(new Set(conversations.map((c) => `${c.workflow_state}/${c.created_by}/${String(c.anchor_observed)}`))).toEqual(new Set(["OPEN/system_ingestion/true"]));
      expect(conversations.map((c) => c.anchor_interaction_id)).toContain(c1.id);
    });

    it("writes one append-only event and one IDs-only interactions.observed outbox row per change", async () => {
      const events = await oracle<{ id: string; change: string; arrival: string; initiator: string; interaction_id: string }>("select id, change, arrival, initiator, interaction_id from ingestion.ingestion_events where workspace_id = $1", [t.workspaceId]);
      expect(events).toHaveLength(6);
      expect(new Set(events.map((e) => `${e.change}/${e.arrival}/${e.initiator}`))).toEqual(new Set(["created/reconciliation/system"]));
      const outbox = await oracle<{ topic: string; subject_ids: Record<string, string>; dispatch_key: string; initiator_type: string; status: string }>(
        "select topic, subject_ids, dispatch_key, initiator_type, status from system.outbox where workspace_id = $1", [t.workspaceId]);
      expect(outbox).toHaveLength(6);
      const texts = (await oracle<{ source_text: string }>("select source_text from interactions.source_text_versions where workspace_id = $1", [t.workspaceId])).map((v) => v.source_text);
      for (const message of outbox) {
        expect(message.topic).toBe("interactions.observed");
        expect(message.initiator_type).toBe("system");
        for (const value of Object.values(message.subject_ids)) expect(value).toMatch(UUID);
        const serialized = JSON.stringify(message);
        for (const text of texts) expect(serialized).not.toContain(text);
        expect(serialized).not.toMatch(/fb_c_|fb_user_|fb_page_|fb_post_/);
      }
      expect(new Set(outbox.map((o) => o.dispatch_key)).size).toBe(6);
      for (const event of events) expect(outbox.some((o) => Object.values(o.subject_ids).includes(event.id))).toBe(true);
    });

    it("duplicate: a second identical pass changes nothing (no row, no event, no outbox row)", async () => {
      const before = await snapshot(t.workspaceId);
      const again = await sync(t, sim, "fb_page_aurora", "fb_post_organic_01", FB);
      expect(kinds(again)).toEqual(Array(6).fill("unchanged"));
      expect(await snapshot(t.workspaceId)).toEqual(before);
    });

    it("text edit: appends an immutable version, advances the pointer, keeps the old text", async () => {
      const before = await row(t, "fb_c_004");
      const oldText = must((await oracle<{ source_text: string }>("select source_text from interactions.source_text_versions where workspace_id = $1 and id = $2", [t.workspaceId, before.current_source_text_version_id]))[0], "old").source_text;
      sim.world.advanceClock(60);
      sim.world.editInteraction("fb_c_004", "Synthetic edited comment (H6-B).");
      const outcomes = await sync(t, sim, "fb_page_aurora", "fb_post_organic_01", FB);
      expect(kinds(outcomes).filter((k) => k !== "unchanged")).toEqual(["text_changed"]);
      const after = await row(t, "fb_c_004");
      expect(after.current_source_text_version_id).not.toBe(before.current_source_text_version_id);
      expect(after.provider_edited_at?.toISOString()).not.toBe(before.provider_edited_at?.toISOString());
      const versions = await oracle<{ id: string; source_text: string }>("select id, source_text from interactions.source_text_versions where workspace_id = $1 and interaction_id = $2", [t.workspaceId, after.id]);
      expect(versions).toHaveLength(2);
      expect(versions.find((v) => v.id === before.current_source_text_version_id)?.source_text).toBe(oldText);
      expect(versions.find((v) => v.id === after.current_source_text_version_id)?.source_text).toBe("Synthetic edited comment (H6-B).");
      const event = await oracle<{ source_text_version_id: string }>("select source_text_version_id from ingestion.ingestion_events where workspace_id = $1 and interaction_id = $2 and change = 'text_changed'", [t.workspaceId, after.id]);
      expect(event.map((e) => e.source_text_version_id)).toEqual([after.current_source_text_version_id]);
    });

    it("text revert and stale text: the pointer follows the newest text; a stale sighting changes nothing", async () => {
      const original = await row(t, "fb_c_005");
      sim.world.advanceClock(60);
      sim.world.editInteraction("fb_c_005", "Synthetic interim text.");
      const content = await contentDto(sim, "fb_page_aurora", "fb_post_organic_01");
      sim.world.advanceClock(60);
      const interim = factOf(t, sim, "fb_page_aurora", must((await listedDtos(sim, "fb_page_aurora", content)).find((d) => d.ref.id === "fb_c_005"), "dto"));
      expect(kinds([await ingest(t, interim, content, FB)])).toEqual(["text_changed"]);
      const originalText = must((await oracle<{ source_text: string }>("select source_text from interactions.source_text_versions where id = $1", [original.current_source_text_version_id]))[0], "text").source_text;
      sim.world.advanceClock(60);
      sim.world.editInteraction("fb_c_005", originalText);
      const reverted = await sync(t, sim, "fb_page_aurora", "fb_post_organic_01", FB);
      expect(kinds(reverted).filter((k) => k !== "unchanged")).toEqual(["text_changed"]);
      // One version per distinct text: the pointer returns to the original version.
      expect(await countIn("interactions.source_text_versions", t.workspaceId, "interaction_id = $2", [original.id])).toBe(2);
      expect((await row(t, "fb_c_005")).current_source_text_version_id).toBe(original.current_source_text_version_id);
      // Replaying the interim sighting (older edit time) is stale: no pointer move, no event.
      const before = await snapshot(t.workspaceId);
      expect(kinds([await ingest(t, interim, content, FB)])).toEqual(["unchanged"]);
      expect(await snapshot(t.workspaceId)).toEqual(before);
      expect((await row(t, "fb_c_005")).current_source_text_version_id).toBe(original.current_source_text_version_id);
    });

    it("state change: hide and unhide are recorded; a stale replay is history only and written once", async () => {
      sim.world.nativeHide("fb_c_005");
      const content = await contentDto(sim, "fb_page_aurora", "fb_post_organic_01");
      sim.world.advanceClock(60);
      const hidden = factOf(t, sim, "fb_page_aurora", must((await listedDtos(sim, "fb_page_aurora", content)).find((d) => d.ref.id === "fb_c_005"), "dto"));
      expect(kinds([await ingest(t, hidden, content, FB)])).toEqual(["state_changed"]);
      expect((await row(t, "fb_c_005")).current_visibility).toBe("hidden");
      sim.world.nativeUnhide("fb_c_005");
      expect(kinds(await sync(t, sim, "fb_page_aurora", "fb_post_organic_01", FB)).filter((k) => k !== "unchanged")).toEqual(["state_changed"]);
      expect((await row(t, "fb_c_005")).current_visibility).toBe("visible");
      const observations = await countIn("interactions.state_observations", t.workspaceId);
      const events = await countIn("ingestion.ingestion_events", t.workspaceId);
      // Replaying the earlier "hidden" sighting: already recorded at that time, so nothing is written.
      expect(kinds([await ingest(t, hidden, content, FB)])).toEqual(["unchanged"]);
      expect(await countIn("interactions.state_observations", t.workspaceId)).toBe(observations);
      // A NEW late sighting (observed before the current state, never seen): history only — one row, no event, no move.
      const late = patched(hidden, { time: { ...hidden.time, observedAt: instant(new Date(Date.parse(hidden.time.observedAt) + 1_000).toISOString()) } });
      expect(kinds([await ingest(t, late, content, FB)])).toEqual(["unchanged"]);
      expect(await countIn("interactions.state_observations", t.workspaceId)).toBe(observations + 1);
      expect((await row(t, "fb_c_005")).current_visibility).toBe("visible");
      expect(await countIn("ingestion.ingestion_events", t.workspaceId)).toBe(events);
      expect(kinds([await ingest(t, late, content, FB)])).toEqual(["unchanged"]);
      expect(await countIn("interactions.state_observations", t.workspaceId)).toBe(observations + 1);
    });

    it("removal: an explicit provider signal sets removed_at_source and keeps the text; absence alone changes nothing", async () => {
      const content = await contentDto(sim, "fb_page_aurora", "fb_post_organic_01");
      const listed = must((await listedDtos(sim, "fb_page_aurora", content)).find((d) => d.ref.id === "fb_c_004"), "dto");
      const before = await row(t, "fb_c_004");
      sim.world.advanceClock(60);
      sim.world.removeAtSource("fb_c_004", { signaled: true });
      const reread = (await sim.read.getInteraction(metaAccess(sim, "fb_page_aurora"), { kind: "listed", listed })).data;
      expect(reread.availability).toBe("removed_at_source");
      const outcome = await ingest(t, factOf(t, sim, "fb_page_aurora", reread, "getInteraction"), content, FB);
      expect(kinds([outcome])).toEqual(["removed_at_source"]);
      const after = await row(t, "fb_c_004");
      expect(after.current_availability).toBe("removed_at_source");
      expect(after.current_removal_basis).toBe("explicit_provider_signal");
      expect(after.current_source_text_version_id).toBe(before.current_source_text_version_id);
      // fb_c_006 vanishes without a signal: it is no longer listed, and nothing about it changes.
      const vanishing = await row(t, "fb_c_006");
      sim.world.removeAtSource("fb_c_006", { signaled: false });
      const snapshotBefore = await snapshot(t.workspaceId);
      const pass = await sync(t, sim, "fb_page_aurora", "fb_post_organic_01", FB);
      expect(pass.every((o) => o.kind === "unchanged")).toBe(true);
      expect(await snapshot(t.workspaceId)).toEqual(snapshotBefore);
      expect(await row(t, "fb_c_006")).toEqual(vanishing);
    });

    it("stored authority: issued by the persistence loader from the canonical row; re-reads verify against it", async () => {
      await withWorkspaceJobScope(worker, t.workspaceId, async (tx) => {
        const authority = must(await loadStoredInteractionAuthority(tx, t.workspaceId, "facebook", "fb_c_003"), "authority");
        expect(isStoredInteractionAuthority(authority)).toBe(true);
        expect(authority).toMatchObject({ canonicalId: (await row(t, "fb_c_003")).id, platform: "facebook", interactionId: "fb_c_003", contentId: "fb_post_organic_01", parentId: "fb_c_002", kind: "reply", connectedAccountId: t.accounts.fb_page_aurora });
        const context = { workspaceId: t.workspaceId, connectedAccountId: t.accounts.fb_page_aurora, platform: "facebook" as const, providerAssetId: providerId("fb_page_aurora") };
        const observed = { interactionId: providerId("fb_c_003"), contentId: providerId("fb_post_organic_01"), parentId: providerId("fb_c_002"), kind: "reply" as const };
        expect(verifyStoredReread(authority, context, observed)).toEqual([]);
        expect(verifyStoredReread(authority, context, { ...observed, parentId: providerId("fb_c_001") })).toEqual(["PARENT_MISMATCH"]);
        expect(verifyStoredReread({ ...authority }, context, observed)).toEqual(["NOT_AN_ISSUED_AUTHORITY"]);
        expect(await loadStoredInteractionAuthority(tx, t.workspaceId, "facebook", "fb_c_999")).toBeUndefined();
        expect(await loadStoredInteractionAuthority(tx, t.workspaceId, "instagram", "fb_c_003")).toBeUndefined();
      });
    });

    it("authority conflicts fail closed before any write: the transaction rolls back", async () => {
      const content = await contentDto(sim, "fb_page_aurora", "fb_post_organic_01");
      const dtos = await listedDtos(sim, "fb_page_aurora", content);
      const fact = (id: string) => factOf(t, sim, "fb_page_aurora", must(dtos.find((d) => d.ref.id === id), id));
      const before = await snapshot(t.workspaceId);
      const f1 = fact("fb_c_001");
      expect(await conflictOf(ingest(t, patched(f1, { identity: { ...f1.identity, contentId: "fb_post_boosted_02" } }), content, FB))).toContain("CONTENT_CHANGED");
      expect(await conflictOf(ingest(t, patched(f1, { scope: { ...f1.scope, connectedAccountId: t.accounts.ig_acct_aurora } }), content, FB))).toEqual(["CONTENT_SCOPE_CONFLICT"]);
      const f3 = fact("fb_c_003");
      expect(await conflictOf(ingest(t, patched(f3, { identity: { ...f3.identity, parentId: "fb_c_001" } }), content, FB))).toEqual(["PARENT_CHANGED"]);
      const f2 = fact("fb_c_002");
      expect(await conflictOf(ingest(t, patched(f2, { identity: { ...f2.identity, parentId: null, kind: "comment" } }), content, FB))).toEqual(expect.arrayContaining(["PARENT_CHANGED", "KIND_CHANGED"]));
      // A new reply on another content whose parent is fb_c_001 (this content): the parent's scope refuses it.
      const boosted = await contentDto(sim, "fb_page_aurora", "fb_post_boosted_02");
      const f11 = factOf(t, sim, "fb_page_aurora", must((await listedDtos(sim, "fb_page_aurora", boosted)).find((d) => d.ref.id === "fb_c_011"), "dto"));
      expect(await conflictOf(ingest(t, patched(f11, { identity: { ...f11.identity, parentId: "fb_c_001", kind: "reply" } }), boosted, FB))).toEqual(["PARENT_SCOPE_CONFLICT"]);
      expect(await snapshot(t.workspaceId)).toEqual(before);
    });

    it("an event write failure rolls back the whole change set (state, history, event, outbox are atomic)", async () => {
      const content = await contentDto(sim, "fb_page_aurora", "fb_post_boosted_02");
      const dto = must((await listedDtos(sim, "fb_page_aurora", content)).find((d) => d.ref.id === "fb_c_010"), "dto");
      const before = await snapshot(t.workspaceId);
      const failing = (stores: IngestionStores): IngestionStores => ({
        ...stores,
        events: { emit: async (...args) => { await stores.events.emit(...args); throw new Error("injected_event_failure"); } },
      });
      await expect(ingest(t, factOf(t, sim, "fb_page_aurora", dto), content, FB, { wrap: failing })).rejects.toThrow("injected_event_failure");
      expect(await snapshot(t.workspaceId)).toEqual(before);
      expect(await countIn("interactions.interactions", t.workspaceId, "provider_interaction_id = 'fb_c_010'")).toBe(0);
      // The same fact then applies cleanly, with its content row and its own event and outbox row.
      expect(kinds([await ingest(t, factOf(t, sim, "fb_page_aurora", dto), content, FB)])).toEqual(["created"]);
      expect(await countIn("content.content_items", t.workspaceId)).toBe(must(before["content.content_items"], "count") + 1);
      expect(await countIn("system.outbox", t.workspaceId)).toBe(must(before["system.outbox"], "count") + 1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("reply before parent", () => {
    it("creates a minimal placeholder parent and a provisional OPEN conversation; the parent's arrival completes both", async () => {
      const t = await tenant();
      const sim = createBaselineSimulator();
      const content = await contentDto(sim, "fb_page_aurora", "fb_post_organic_01");
      const dtos = await listedDtos(sim, "fb_page_aurora", content);
      const fact = (id: string) => factOf(t, sim, "fb_page_aurora", must(dtos.find((d) => d.ref.id === id), id));
      sim.world.advanceClock(60);
      expect(kinds([await ingest(t, fact("fb_c_002"), content, FB)])).toEqual(["created"]);
      const placeholder = await row(t, "fb_c_001");
      expect(placeholder).toMatchObject({ observed: false, kind: null, parent_interaction_id: null, current_source_text_version_id: null, current_visibility: null, author_role: null });
      const reply = await row(t, "fb_c_002");
      expect(reply.parent_interaction_id).toBe(placeholder.id);
      expect(reply.conversation_id).toBe(placeholder.conversation_id);
      const provisional = await oracle<{ id: string; anchor_interaction_id: string; anchor_observed: boolean; workflow_state: string }>("select id, anchor_interaction_id, anchor_observed, workflow_state from conversations.conversations where workspace_id = $1", [t.workspaceId]);
      expect(provisional).toEqual([{ id: reply.conversation_id, anchor_interaction_id: placeholder.id, anchor_observed: false, workflow_state: "OPEN" }]);
      // A placeholder is not observed: no stored authority for it.
      expect(await withWorkspaceJobScope(worker, t.workspaceId, (tx) => loadStoredInteractionAuthority(tx, t.workspaceId, "facebook", "fb_c_001"))).toBeUndefined();
      // A sighting of the placeholder on another content is refused.
      const f1 = fact("fb_c_001");
      const before = await snapshot(t.workspaceId);
      expect(await conflictOf(ingest(t, patched(f1, { identity: { ...f1.identity, contentId: "fb_post_boosted_02" } }), await contentDto(sim, "fb_page_aurora", "fb_post_boosted_02"), FB))).toEqual(["PLACEHOLDER_SCOPE_CONFLICT"]);
      expect(await snapshot(t.workspaceId)).toEqual(before);
      // The parent arrives: the SAME row becomes observed, the conversation's anchor is observed, no second conversation.
      expect(kinds([await ingest(t, f1, content, FB)])).toEqual(["created"]);
      const completed = await row(t, "fb_c_001");
      expect(completed).toMatchObject({ id: placeholder.id, observed: true, kind: "comment", conversation_id: reply.conversation_id });
      expect(completed.current_source_text_version_id).not.toBeNull();
      expect(await oracle("select anchor_observed from conversations.conversations where workspace_id = $1", [t.workspaceId])).toEqual([{ anchor_observed: true }]);
      // The nested reply joins the same thread.
      expect(kinds([await ingest(t, fact("fb_c_003"), content, FB)])).toEqual(["created"]);
      expect((await row(t, "fb_c_003")).conversation_id).toBe(reply.conversation_id);
      expect(await countIn("ingestion.ingestion_events", t.workspaceId)).toBe(3);
    });

    it("a placeholder anchor that turns out to be a reply is refused (no re-threading in H6-B): nothing is applied", async () => {
      const t = await tenant();
      const sim = createBaselineSimulator();
      const content = await contentDto(sim, "fb_page_aurora", "fb_post_organic_01");
      const dtos = await listedDtos(sim, "fb_page_aurora", content);
      const fact = (id: string) => factOf(t, sim, "fb_page_aurora", must(dtos.find((d) => d.ref.id === id), id));
      // Raw listing order without the batch ordering: the nested reply first.
      expect(kinds([await ingest(t, fact("fb_c_003"), content, FB)])).toEqual(["created"]);
      const before = await snapshot(t.workspaceId);
      expect(await conflictOf(ingest(t, fact("fb_c_002"), content, FB))).toEqual(["THREAD_ANCHOR_CONFLICT"]);
      expect(await snapshot(t.workspaceId)).toEqual(before);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("Instagram under REPLIES_NOT_READ", () => {
    it("ingests an Instagram comment and refuses an Instagram reply without writing anything", async () => {
      const t = await tenant();
      const sim = createBaselineSimulator();
      const created = await sync(t, sim, "ig_acct_aurora", "ig_post_unknown_11", IG);
      expect(kinds(created)).toEqual(["created"]);
      const comment = await row(t, "ig_c_010");
      expect(comment).toMatchObject({ observed: true, kind: "comment" });
      expect(await oracle("select content_kind, reported_source from content.content_items where workspace_id = $1", [t.workspaceId])).toEqual([{ content_kind: "carousel", reported_source: "unknown" }]);
      sim.world.advanceClock(60);
      sim.world.audienceReply("ig_c_010", "ig_user_01", "Synthetic Instagram reply (H6-B).");
      const before = await snapshot(t.workspaceId);
      const pass = await sync(t, sim, "ig_acct_aurora", "ig_post_unknown_11", IG);
      expect(kinds(pass).sort()).toEqual(["rejected", "unchanged"]);
      expect(pass.find((o) => o.kind === "rejected")).toEqual({ kind: "rejected", reason: "KIND_NOT_COVERED" });
      expect(await snapshot(t.workspaceId)).toEqual(before);
      expect(await countIn("interactions.interactions", t.workspaceId, "kind = 'reply' or not observed")).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("coverage persistence", () => {
    let t: Tenant;
    let other: Tenant;
    let contentItem: string;
    const from = instant("2026-09-10T00:00:00.000Z");
    const to = instant("2026-09-11T00:00:00.000Z");
    const asOf = instant("2026-09-15T12:00:00.000Z");
    beforeAll(async () => {
      t = await tenant();
      other = await tenant();
      const sim = createBaselineSimulator();
      await sync(t, sim, "fb_page_aurora", "fb_post_organic_01", FB);
      contentItem = must((await oracle<{ id: string }>("select id from content.content_items where workspace_id = $1", [t.workspaceId]))[0], "content").id;
    });
    const record = (tenantOf: Tenant, account: string, availability: AvailabilityInput, result: SliceReadResult, contentItemId: string | null = null, correlationId = correlation()) =>
      withWorkspaceJobScope(worker, tenantOf.workspaceId, (tx) =>
        recordIngestionCoverage(storesFor(tx), clock, { workspaceId: tenantOf.workspaceId, connectedAccountId: account, contentItemId, from, to, asOf, availability, result, correlationId }));
    const stored = (account: string) => oracle<{ interaction_kind: string; state: string; reason: string; slice_outcome: string; limitation_code: string | null }>(
      "select interaction_kind, state, reason, slice_outcome, limitation_code from coverage.coverage_records where workspace_id = $1 and connected_account_id = $2 order by created_at, interaction_kind", [t.workspaceId, account]);
    const cases: readonly { readonly name: string; readonly availability: AvailabilityInput; readonly result: SliceReadResult; readonly outcome: string; readonly rows: readonly [string, string, string][] }[] = [
      { name: "1 Facebook read completed", availability: FB, result: "completed", outcome: "COMPLETE", rows: [["comment", "COMPLETE", "VALIDATED_SCOPE_READ"], ["reply", "COMPLETE", "VALIDATED_SCOPE_READ"]] },
      { name: "2 Instagram REPLIES_NOT_READ", availability: IG, result: "completed", outcome: "LIMITED", rows: [["comment", "COMPLETE", "VALIDATED_SCOPE_READ"], ["reply", "UNAVAILABLE", "CAPABILITY_LIMITATION"]] },
      { name: "3 slice in progress", availability: FB, result: "in_progress", outcome: "IN_PROGRESS", rows: [["comment", "IMPORTING", "IN_PROGRESS"], ["reply", "IMPORTING", "IN_PROGRESS"]] },
      { name: "4 transient provider failure", availability: FB, result: "failed_transient", outcome: "TEMPORARILY_FAILED", rows: [["comment", "FAILED", "PROVIDER_FAILURE"], ["reply", "FAILED", "PROVIDER_FAILURE"]] },
      { name: "5 slice not attempted", availability: FB, result: "not_attempted", outcome: "TEMPORARILY_FAILED", rows: [["comment", "UNKNOWN", "PROVIDER_FAILURE"], ["reply", "UNKNOWN", "PROVIDER_FAILURE"]] },
      { name: "6 permission missing", availability: { state: "UNAVAILABLE", reason: "ACCOUNT_PERMISSION_MISSING", limitationCode: null }, result: "not_attempted", outcome: "AUTHORIZATION_MISSING", rows: [["comment", "UNAVAILABLE", "ACCOUNT_PERMISSION_MISSING"], ["reply", "UNAVAILABLE", "ACCOUNT_PERMISSION_MISSING"]] },
      { name: "7 platform unsupported", availability: { state: "UNAVAILABLE", reason: "CAPABILITY_UNSUPPORTED", limitationCode: null }, result: "not_attempted", outcome: "PLATFORM_UNSUPPORTED", rows: [["comment", "UNAVAILABLE", "CAPABILITY_UNSUPPORTED"], ["reply", "UNAVAILABLE", "CAPABILITY_UNSUPPORTED"]] },
      { name: "8 capability not validated", availability: { state: "UNAVAILABLE", reason: "CAPABILITY_NOT_VALIDATED", limitationCode: null }, result: "not_attempted", outcome: "NOT_VALIDATED", rows: [["comment", "UNAVAILABLE", "CAPABILITY_NOT_VALIDATED"], ["reply", "UNAVAILABLE", "CAPABILITY_NOT_VALIDATED"]] },
      { name: "9 connection temporarily unavailable", availability: { state: "TEMPORARILY_UNAVAILABLE", reason: "CONNECTION_DEGRADED", limitationCode: null }, result: "not_attempted", outcome: "TEMPORARILY_FAILED", rows: [["comment", "FAILED", "CONNECTION_UNAVAILABLE"], ["reply", "FAILED", "CONNECTION_UNAVAILABLE"]] },
    ];

    it.each(cases)("case $name: persists exactly the domain's intervals and slice outcome", async ({ availability, result, outcome, rows }) => {
      // A fresh account row per case keeps the cases independent (same connection, synthetic).
      const account = randomUUID();
      const asset = `fb_cov_${randomUUID().slice(0, 8)}`;
      const discovered = randomUUID();
      await privileged.query(
        `insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
         select $1, organization_id, workspace_id, connection_id, platform, $3, 'ad_account', 'Synthetic', now(), now(), now() from connections.connected_accounts where id = $2`,
        [discovered, t.accounts.fb_page_aurora, asset]);
      await privileged.query(
        `insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
         select $1, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from connections.discovered_assets where id = $2`,
        [account, discovered]);
      const correlationId = correlation();
      const first = await record(t, account, availability, result, null, correlationId);
      expect(first.coverage.outcome).toBe(outcome);
      expect(first.written).toBe(rows.length);
      const persisted = await stored(account);
      expect(persisted.map((r) => [r.interaction_kind, r.state, r.reason])).toEqual(rows);
      expect(new Set(persisted.map((r) => r.slice_outcome))).toEqual(new Set([outcome]));
      // The same slice recorded again writes nothing new.
      expect((await record(t, account, availability, result, null, correlationId)).written).toBe(0);
      expect(await stored(account)).toHaveLength(rows.length);
    });

    it("Instagram replies are never a zero: their count is NOT_AVAILABLE while comments are measured", async () => {
      const { coverage } = await record(t, t.accounts.ig_acct_aurora, IG, "completed");
      const comment = must(coverage.intervals.find((i) => i.interactionKind === "comment"), "comment");
      const reply = must(coverage.intervals.find((i) => i.interactionKind === "reply"), "reply");
      expect(measuredInteractionCount(comment, 1)).toEqual({ state: "AVAILABLE", value: 1 });
      expect(measuredInteractionCount(reply, 0)).toEqual({ state: "NOT_AVAILABLE", reason: "CAPABILITY_LIMITATION" });
      expect((await stored(t.accounts.ig_acct_aurora)).find((r) => r.interaction_kind === "reply")?.limitation_code).toBe("REPLIES_NOT_READ");
    });

    it("content-scoped coverage binds to the workspace's own content row; another workspace's row is refused; no record reads as nothing", async () => {
      expect((await record(t, t.accounts.fb_page_aurora, FB, "completed", contentItem)).written).toBe(2);
      expect(await sqlState(record(other, other.accounts.fb_page_aurora, FB, "completed", contentItem))).toMatchObject({ code: "23503" });
      expect(await withWorkspaceJobScope(worker, other.workspaceId, (tx) => createPostgresCoverageStore(tx).forAccount(other.accounts.fb_page_aurora))).toEqual([]);
      // Bound to the other workspace, this workspace's records are invisible.
      expect(await withWorkspaceJobScope(worker, other.workspaceId, (tx) => createPostgresCoverageStore(tx).forAccount(t.accounts.fb_page_aurora))).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("tenancy, grants and structural guards", () => {
    let a: Tenant;
    let b: Tenant;
    beforeAll(async () => {
      a = await tenant();
      b = await tenant();
      await sync(a, createBaselineSimulator(), "fb_page_aurora", "fb_post_organic_01", FB);
    });
    const asWorker = <T>(t: Tenant, work: (tx: DatabaseTransaction) => Promise<T>) => withWorkspaceJobScope(worker, t.workspaceId, work);
    const asUser = <T>(t: Tenant, user: string, work: (tx: DatabaseTransaction) => Promise<T>) => withUserScope(web, { sub: user, role: "authenticated" }, t.workspaceId, work);
    const visible = async (tx: DatabaseTransaction, table: string): Promise<number> =>
      (await tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`))).rows[0]?.n ?? -1;

    it("members read their workspace's canonical rows; a guest and other workspaces read nothing", async () => {
      for (const table of CANONICAL_TABLES.filter((name) => name !== "coverage.coverage_records")) {
        const expected = await countIn(table, a.workspaceId);
        expect(expected, table).toBeGreaterThan(0);
        expect(await asUser(a, a.owner, (tx) => visible(tx, table)), table).toBe(expected);
        expect(await asUser(a, a.analyst, (tx) => visible(tx, table)), table).toBe(expected);
        expect(await asUser(a, a.guest, (tx) => visible(tx, table)), table).toBe(0);
        expect(await asUser(b, b.owner, (tx) => visible(tx, table)), table).toBe(0);
        expect(await asWorker(b, (tx) => visible(tx, table)), table).toBe(0);
      }
    });

    it("the same provider ids in another workspace are a separate identity (unique per workspace, platform, id)", async () => {
      const outcomes = await sync(b, createBaselineSimulator(), "fb_page_aurora", "fb_post_organic_01", FB);
      expect(kinds(outcomes)).toEqual(Array(6).fill("created"));
      expect((await row(b, "fb_c_001")).id).not.toBe((await row(a, "fb_c_001")).id);
    });

    it("cross-workspace references fail like missing ones (composite FKs)", async () => {
      const contentA = must((await oracle<{ id: string }>("select id from content.content_items where workspace_id = $1", [a.workspaceId]))[0], "content").id;
      const interactionA = (await row(a, "fb_c_001")).id;
      const conversationA = must((await row(a, "fb_c_001")).conversation_id, "conversation");
      const orgB = b.organizationId;
      expect(await sqlState(asWorker(b, (tx) => tx.execute(sql`insert into interactions.interactions (id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id, provider_content_id, observed, created_at, updated_at)
        values (${randomUUID()}, ${orgB}, ${b.workspaceId}, 'facebook', 'fb_x_cross', ${b.accounts.fb_page_aurora}, 'fb_page_aurora', ${contentA}, 'fb_post_organic_01', false, now(), now())`)))).toMatchObject({ code: "23503" });
      expect(await sqlState(asWorker(b, (tx) => tx.execute(sql`insert into conversations.conversations (id, organization_id, workspace_id, anchor_interaction_id, anchor_observed, workflow_state, created_by, created_at, updated_at)
        values (${randomUUID()}, ${orgB}, ${b.workspaceId}, ${interactionA}, true, 'OPEN', 'system_ingestion', now(), now())`)))).toMatchObject({ code: "23503" });
      const interactionB = (await row(b, "fb_c_004")).id;
      // A conversation of another workspace: the composite FK (or, once set, the scope guard) refuses it.
      expect(["23503", "23514"]).toContain((await sqlState(asWorker(b, (tx) => tx.execute(sql`update interactions.interactions set conversation_id = ${conversationA} where id = ${interactionB}`)))).code);
      expect(await sqlState(asWorker(b, (tx) => tx.execute(sql`insert into ingestion.ingestion_events (id, organization_id, workspace_id, interaction_id, conversation_id, source_text_version_id, change, arrival, observed_at, correlation_id, initiator, created_at)
        values (${randomUUID()}, ${orgB}, ${b.workspaceId}, ${interactionA}, null, null, 'created', 'reconciliation', now(), 'h6b-cross-workspace', 'system', now())`)))).toMatchObject({ code: "23503" });
    });

    it("history is append-only and source identity is immutable (grants and the scope guard)", async () => {
      const r2 = await row(a, "fb_c_002");
      const r4 = await row(a, "fb_c_004");
      const r5 = await row(a, "fb_c_005");
      for (const statement of [
        sql`update interactions.source_text_versions set source_text = 'rewritten'`,
        sql`delete from interactions.source_text_versions`,
        sql`update interactions.state_observations set visibility = 'hidden'`,
        sql`delete from interactions.state_observations`,
        sql`update ingestion.ingestion_events set change = 'state_changed'`,
        sql`delete from ingestion.ingestion_events`,
        sql`update coverage.coverage_records set state = 'COMPLETE'`,
        sql`update interactions.interactions set provider_interaction_id = 'fb_c_rewritten'`,
        sql`update interactions.interactions set content_item_id = content_item_id`,
        sql`delete from interactions.interactions`,
        sql`update conversations.conversations set workflow_state = 'DONE'`,
        sql`update content.content_items set provider_content_id = 'rewritten'`,
        sql`update interactions.authors set provider_author_id = 'rewritten'`,
      ]) {
        expect(await sqlState(asWorker(a, (tx) => tx.execute(statement)))).toMatchObject({ code: "42501" });
      }
      for (const statement of [
        sql`update interactions.interactions set kind = 'comment', parent_interaction_id = null where id = ${r2.id}`,
        sql`update interactions.interactions set observed = false where id = ${r4.id}`,
        sql`update interactions.interactions set provider_created_at = now() where id = ${r4.id}`,
        sql`update interactions.interactions set conversation_id = ${r5.conversation_id} where id = ${r4.id}`,
      ]) {
        expect(await sqlState(asWorker(a, (tx) => tx.execute(statement)))).toMatchObject({ code: "23514" });
      }
      // Ingestion creates conversations OPEN only, as the system.
      expect(await sqlState(asWorker(a, (tx) => tx.execute(sql`insert into conversations.conversations (id, organization_id, workspace_id, anchor_interaction_id, anchor_observed, workflow_state, created_by, created_at, updated_at)
        values (${randomUUID()}, ${a.organizationId}, ${a.workspaceId}, ${r4.id}, true, 'DONE', 'system_ingestion', now(), now())`)))).toMatchObject({ code: "42501" });
      // Web members never write canonical rows.
      expect(await sqlState(asUser(a, a.owner, (tx) => tx.execute(sql`insert into interactions.authors (id, organization_id, workspace_id, platform, provider_author_id, role, label, created_at, updated_at)
        values (${randomUUID()}, ${a.organizationId}, ${a.workspaceId}, 'facebook', 'fb_user_web', 'user', null, now(), now())`)))).toMatchObject({ code: "42501" });
      expect(await sqlState(asUser(a, a.owner, (tx) => tx.execute(sql`update interactions.interactions set current_visibility = 'hidden'`)))).toMatchObject({ code: "42501" });
    });

    it("the text hash is the SHA-256 of the exact stored text (database CHECK)", async () => {
      const r1 = await row(a, "fb_c_001");
      expect(await sqlState(asWorker(a, (tx) => tx.execute(sql`insert into interactions.source_text_versions (id, organization_id, workspace_id, interaction_id, text_hash, source_text, provider_edited_at, observed_at, created_at)
        values (${randomUUID()}, ${a.organizationId}, ${a.workspaceId}, ${r1.id}, ${"0".repeat(64)}, 'Synthetic', null, now(), now())`)))).toMatchObject({ code: "23514" });
    });
  });
}
