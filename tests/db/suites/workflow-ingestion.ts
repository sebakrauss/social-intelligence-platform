/**
 * WORKFLOW-WF-2B — the activity projection and the objective auto-reopen on the real database, through the PRODUCTION
 * ingestion path: simulator listings → trusted mapping → ingestInteractionFact in worker transactions bound to one
 * workspace, with the workflow projection composed in by server/persistence/ingestion.ts (same transaction). Done and
 * Reopen go through the REAL action pipeline over the REAL web unit of work (definer workflow.change_state).
 *
 *   W1  a conversation's work item is created with it: OPEN, version 1, a `created` event; activity = the list's own
 *       definition (oracle from the source rows); a brand-rooted thread has none
 *   W2  a new AUDIENCE reply reopens a Done conversation: event (cause = that reply), system audit event, version + 1
 *   W3  no reopen and no version change from: the account's own reply, a duplicate delivery, an edit, a visibility change
 *   W4  REGRESSION (WF-2A §7): a new audience reply classified `arrival = backfill` still reopens
 *   W5  out of order: a reply the platform dates before everything, observed now, reopens; the activity does not move back
 *   W6  a reply that arrived before its parent joins with it later: both join, the conversation reopens (cause = parent)
 *   W7  stale Done: a new audience reply advances the version, so a Done sent against the older one is CONFLICT; an
 *       account reply does not, so a Done sent against the same version still applies
 *   W8  concurrent ingestion of two members of one conversation: neither is lost (lock, then recompute)
 *   W9  rebuild / reconciliation: drift and a missing work item are repaired; state and version are untouched
 *   W10 Monitor-only: ingestion projects and Mark Done / Reopen work (internal workflow)
 *   W11 the conversation view carries the work item's state and version, and whether THIS member may change it
 */
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parseCorrelationId, type CorrelationId } from "@/domain/correlation";
import { parseUserId, parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import { parseInstant, type Instant } from "@/domain/instant";
import type { ContentDto, InteractionDto, Page, PageCursor, ProviderAccess, TimeWindow } from "@/integrations/providers/contract";
import { parseIsoInstant } from "@/integrations/providers/contract";
import type { AvailabilityInput } from "@/modules/coverage";
import { ingestInteractionFact, interactionSourceFactFromDto, type IngestionStores, type IngestOutcome, type ObservedArrival } from "@/modules/ingestion";
import { parseInteractionSourceFact, type InteractionSourceFact } from "@/modules/interactions";
import { createPostgresAuditLog } from "@/modules/audit/persistence";
import { createPostgresInteractionStore } from "@/modules/interactions/persistence";
import { rebuildWorkItem } from "@/modules/workflow";
import { createPostgresWorkflowProjectionStore } from "@/modules/workflow/persistence";
import { withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { createLogger } from "@/platform/observability";
import { markDoneCommand, reopenCommand } from "@/server/commands/workflow";
import { ingestionStores } from "@/server/persistence/ingestion";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { createActionPipeline, type PipelineResult } from "@/server/pipeline";
import { inboxConversationCommand } from "@/server/queries/inbox";
import { createBaselineSimulator } from "../../providers/support/simulator-harness";
import { FakeIdentity, verifiedUser } from "../../support/in-memory";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";

const FB: AvailabilityInput = { state: "AVAILABLE", reason: "CAPABILITY_SUPPORTED", limitationCode: null };
const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(what);
  return value;
};
const instant = (iso: string): Instant => must(parseInstant(iso), "instant");
const correlation = (): CorrelationId => must(parseCorrelationId(`wf2b-ing-${randomUUID()}`), "correlation");
const LISTING: TimeWindow = { from: must(parseIsoInstant("2026-01-01T00:00:00.000Z"), "instant"), to: must(parseIsoInstant("2027-01-01T00:00:00.000Z"), "instant") };
const ROLES = ["OWNER", "MANAGER", "RESPONDER", "ANALYST_VIEWER"] as const;
type Role = (typeof ROLES)[number];

interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: WorkspaceId;
  readonly users: Readonly<Record<Role, string>>;
  readonly account: string;
}
type Simulator = ReturnType<typeof createBaselineSimulator>;

export function defineWorkflowIngestionSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  let worker2: RuntimeDatabase<"worker">;
  const organizations: string[] = [];
  const clock = { newId: randomUUID, now: () => new Date() };
  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;

  const tenant = async (mode: "STANDARD" | "MONITOR_ONLY" = "STANDARD"): Promise<Tenant> => {
    const organizationId = randomUUID();
    const workspaceId = must(parseWorkspaceId(randomUUID()), "workspace");
    organizations.push(organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Workflow ingestion', now())", [organizationId]);
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', $3, now())", [workspaceId, organizationId, mode]);
    const users = {} as Record<Role, string>;
    for (const role of ROLES) {
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
  };

  // ── the simulator's organic post and its first listed comment, as templates for synthetic sightings ────────────
  const access = (sim: Simulator): ProviderAccess => sim.access("cred_meta_main", "fb_page_aurora");
  const organicPost = async (sim: Simulator): Promise<ContentDto> => {
    let cursor: PageCursor | null = null;
    for (;;) {
      const page: Page<ContentDto> = (await sim.read.listContent(access(sim), LISTING, cursor)).data;
      const found = page.items.find((item) => item.ref.id === "fb_post_organic_01");
      if (found !== undefined) return found;
      if (page.next.kind === "end") throw new Error("content not listed");
      cursor = page.next.cursor;
    }
  };
  const templateOf = async (t: Tenant, sim: Simulator, content: ContentDto): Promise<InteractionSourceFact> => {
    let cursor: PageCursor | null = null;
    let dto: InteractionDto | undefined;
    for (;;) {
      const page: Page<InteractionDto> = (await sim.read.listInteractions(access(sim), { kind: "content", content: content.ref }, LISTING, cursor)).data;
      dto = page.items.find((item) => item.ref.id === "fb_c_001");
      if (dto !== undefined || page.next.kind === "end") break;
      cursor = page.next.cursor;
    }
    if (dto === undefined) throw new Error("fb_c_001");
    return interactionSourceFactFromDto(dto, { workspaceId: t.workspaceId, connectedAccountId: t.account, providerAssetId: "fb_page_aurora", mechanism: "reconciliation", operation: "listInteractions", provenance: "listed", observedAt: instant(sim.world.now()), catalogRevision: 5, profileRevision: 5 });
  };
  const patched = (fact: InteractionSourceFact, patch: Record<string, unknown>): InteractionSourceFact => {
    const parsed = parseInteractionSourceFact({ ...fact, ...patch });
    if (!parsed.ok) throw new Error(`fact invalid: ${parsed.violations.join(",")}`);
    return parsed.fact;
  };
  const textOf = (text: string) => ({ sourceText: text, textHash: createHash("sha256").update(text).digest("hex") });
  /** A synthetic sighting: its own provider id, parent, author, platform time and observation time. */
  const sighting = (base: InteractionSourceFact, input: { readonly id: string; readonly parent: string | null; readonly author: "user" | "brand"; readonly createdAt: string; readonly observedAt: string; readonly text?: string; readonly visibility?: "visible" | "hidden" }): InteractionSourceFact =>
    patched(base, {
      identity: { ...base.identity, interactionId: input.id, parentId: input.parent, kind: input.parent === null ? "comment" : "reply" },
      author: input.author === "brand" ? { ref: "fb_author_aurora", role: "account_identity", label: null } : { ref: `fb_user_${input.id}`, role: "user", label: null },
      text: textOf(input.text ?? `synthetic ${input.id}`),
      state: { ...base.state, visibility: input.visibility ?? "visible", availability: "available", removalBasis: null },
      time: { providerCreatedAt: input.createdAt, providerEditedAt: null, observedAt: input.observedAt },
    });

  const ingest = (t: Tenant, content: ContentDto, fact: InteractionSourceFact, options: { readonly arrival?: ObservedArrival; readonly database?: RuntimeDatabase<"worker">; readonly wrap?: (stores: IngestionStores) => IngestionStores } = {}): Promise<IngestOutcome> =>
    withWorkspaceJobScope(options.database ?? worker, t.workspaceId, (tx) => {
      const stores = ingestionStores({ tx, noteOutbox: () => undefined });
      return ingestInteractionFact(options.wrap === undefined ? stores : options.wrap(stores), clock, {
        fact, content: { contentKind: content.contentKind, reportedSource: content.reportedSource }, availability: FB, arrival: options.arrival ?? "reconciliation", correlationId: correlation() });
    });

  const pipelineAs = (user: string) => createActionPipeline({
    identity: new FakeIdentity(verifiedUser(must(parseUserId(user), "user"))),
    unitOfWork: createPostgresUnitOfWork(web),
    clock: () => new Date(),
    newId: randomUUID,
    logger: createLogger({ sink: () => undefined }),
  });
  const ok = <R>(result: PipelineResult<R>): R => {
    if (result.status !== "ok") throw new Error(`pipeline ${result.status}${result.status === "error" ? `: ${result.error.code}` : ""}`);
    return result.value;
  };
  const codeOf = (result: PipelineResult<unknown>): string => (result.status === "error" ? result.error.code : result.status);

  interface ItemRow { state: string; resolution: string | null; version: number; latest: Date; by: string }
  const item = async (t: Tenant, conversationId: string): Promise<ItemRow | undefined> =>
    (await oracle<ItemRow>("select state, resolution, version, latest_activity_at as latest, state_changed_by_kind as by from workflow.work_items where workspace_id = $1 and id = $2", [t.workspaceId, conversationId]))[0];
  /** The list's own definition, from the source rows (never from the projection). */
  const trueActivity = async (t: Tenant, conversationId: string): Promise<Date> =>
    must((await oracle<{ at: Date }>("select date_trunc('milliseconds', max(coalesce(provider_created_at, first_observed_at, created_at))) as at from interactions.interactions where workspace_id = $1 and conversation_id = $2", [t.workspaceId, conversationId]))[0]?.at, "activity");
  const canonical = async (t: Tenant, providerId: string): Promise<{ id: string; conversation_id: string | null }> =>
    must((await oracle<{ id: string; conversation_id: string | null }>("select id, conversation_id from interactions.interactions where workspace_id = $1 and provider_interaction_id = $2", [t.workspaceId, providerId]))[0], providerId);
  const events = async (t: Tenant, conversationId: string) =>
    oracle<{ kind: string; from_state: string | null; to_state: string; initiator_kind: string; cause_interaction_id: string | null; version_after: number }>(
      "select kind, from_state, to_state, initiator_kind, cause_interaction_id, version_after from workflow.workflow_events where workspace_id = $1 and work_item_id = $2 order by version_after, occurred_at", [t.workspaceId, conversationId]);
  const done = async (t: Tenant, conversationId: string, version: number, role: Role = "MANAGER") =>
    pipelineAs(t.users[role]).run(markDoneCommand, { workspaceId: t.workspaceId, input: { conversationId, expectedVersion: version, resolution: "no_reply_needed" } });

  /** A tenant whose organic post has one audience root (fb_r1, platform time T, observed T + 1 min), marked Done (v2). */
  const doneConversation = async (mode: "STANDARD" | "MONITOR_ONLY" = "STANDARD") => {
    const t = await tenant(mode);
    const sim = createBaselineSimulator();
    const content = await organicPost(sim);
    const base = await templateOf(t, sim, content);
    await ingest(t, content, sighting(base, { id: "fb_r1", parent: null, author: "user", createdAt: "2026-10-01T10:00:00.000Z", observedAt: "2026-10-01T10:01:00.000Z" }));
    const conversationId = must((await canonical(t, "fb_r1")).conversation_id ?? undefined, "conversation");
    expect(ok(await done(t, conversationId, 1))).toMatchObject({ state: "DONE", version: 2 });
    return { t, sim, content, base, conversationId };
  };

  beforeAll(() => {
    const target = getTarget();
    privileged = privilegedPool(target);
    web = runtimeDatabase(target, "web");
    worker = runtimeDatabase(target, "worker");
    worker2 = runtimeDatabase(target, "worker");
  });

  afterAll(async () => {
    await cleanupWorld(privileged, organizations);
    await Promise.all([web.end(), worker.end(), worker2.end()]);
    await privileged.end();
  });

  it("W1 · a conversation's work item is created with it — OPEN, version 1, `created` — with the list's own activity; a brand-rooted thread has none", async () => {
    const t = await tenant();
    const sim = createBaselineSimulator();
    const content = await organicPost(sim);
    const base = await templateOf(t, sim, content);
    await ingest(t, content, sighting(base, { id: "fb_r1", parent: null, author: "user", createdAt: "2026-10-01T10:00:00.000Z", observedAt: "2026-10-01T10:05:00.000Z" }));
    await ingest(t, content, sighting(base, { id: "fb_r1_a", parent: "fb_r1", author: "user", createdAt: "2026-10-01T12:00:00.123Z", observedAt: "2026-10-01T12:05:00.000Z" }));
    const conversationId = must((await canonical(t, "fb_r1")).conversation_id ?? undefined, "conversation");
    const row = must(await item(t, conversationId), "work item");
    expect(row).toMatchObject({ state: "OPEN", resolution: null, by: "system_ingestion" });
    // The second member joined an OPEN item: the version advanced (a Done sent against version 1 would now be stale).
    expect(row.version).toBe(2);
    expect(row.latest.toISOString()).toBe((await trueActivity(t, conversationId)).toISOString());
    expect(row.latest.toISOString()).toBe("2026-10-01T12:00:00.123Z");
    expect(await events(t, conversationId)).toEqual([{ kind: "created", from_state: null, to_state: "OPEN", initiator_kind: "system_ingestion", cause_interaction_id: null, version_after: 1 }]);
    // A thread rooted by the account itself has no conversation, so no work item.
    await ingest(t, content, sighting(base, { id: "fb_brand_root", parent: null, author: "brand", createdAt: "2026-10-02T10:00:00.000Z", observedAt: "2026-10-02T10:01:00.000Z" }));
    expect((await canonical(t, "fb_brand_root")).conversation_id).toBeNull();
    expect(Number((await oracle("select count(*) as n from workflow.work_items where workspace_id = $1", [t.workspaceId]))[0]?.["n"])).toBe(1);
  });

  it("W2 · a new AUDIENCE reply reopens a Done conversation: its event names the reply, a system audit event records it, version + 1", async () => {
    const { t, content, base, conversationId } = await doneConversation();
    await ingest(t, content, sighting(base, { id: "fb_r1_new", parent: "fb_r1", author: "user", createdAt: "2026-10-03T09:00:00.000Z", observedAt: "2026-10-03T09:01:00.000Z" }));
    const reply = await canonical(t, "fb_r1_new");
    expect(await item(t, conversationId)).toMatchObject({ state: "OPEN", resolution: null, version: 3, by: "system_auto_reopen" });
    expect((await events(t, conversationId)).at(-1)).toEqual({ kind: "state_changed", from_state: "DONE", to_state: "OPEN", initiator_kind: "system_auto_reopen", cause_interaction_id: reply.id, version_after: 3 });
    const audit = await oracle<{ actor_type: string; actor_user_id: string | null; change: unknown }>("select actor_type, actor_user_id, change from audit.audit_events where workspace_id = $1 and target_id = $2 order by occurred_at", [t.workspaceId, conversationId]);
    expect(audit.map((row) => row.actor_type)).toEqual(["user", "system"]);
    expect(audit[1]).toEqual({ actor_type: "system", actor_user_id: null, change: { kind: "workflow_state", previous: { state: "DONE", resolution: "no_reply_needed" }, current: { state: "OPEN", resolution: null } } });
    expect((must(await item(t, conversationId), "item")).latest.toISOString()).toBe((await trueActivity(t, conversationId)).toISOString());
  });

  it("W3 · no reopen and no version change from the account's own reply, a duplicate delivery, an edit or a visibility change", async () => {
    const { t, content, base, conversationId } = await doneConversation();
    const r1 = sighting(base, { id: "fb_r1", parent: null, author: "user", createdAt: "2026-10-01T10:00:00.000Z", observedAt: "2026-10-01T10:01:00.000Z" });
    // The account replies (native brand reply): activity moves, the state and version do not (no automatic Done/reopen).
    await ingest(t, content, sighting(base, { id: "fb_brand_reply", parent: "fb_r1", author: "brand", createdAt: "2026-10-04T08:00:00.000Z", observedAt: "2026-10-04T08:01:00.000Z" }));
    expect(await item(t, conversationId)).toMatchObject({ state: "DONE", version: 2 });
    expect((must(await item(t, conversationId), "item")).latest.toISOString()).toBe("2026-10-04T08:00:00.000Z");
    // A duplicate delivery of the root, an edit of its text, and a visibility change: no new member joined.
    expect((await ingest(t, content, patched(r1, { time: { ...r1.time, observedAt: "2026-10-05T00:00:00.000Z" } }))).kind).toBe("unchanged");
    await ingest(t, content, patched(r1, { text: textOf("edited text"), time: { providerCreatedAt: r1.time.providerCreatedAt, providerEditedAt: "2026-10-05T01:00:00.000Z", observedAt: "2026-10-05T01:01:00.000Z" } }));
    await ingest(t, content, patched(r1, { text: textOf("edited text"), state: { ...r1.state, visibility: "hidden" }, time: { providerCreatedAt: r1.time.providerCreatedAt, providerEditedAt: "2026-10-05T01:00:00.000Z", observedAt: "2026-10-05T02:00:00.000Z" } }));
    expect(await item(t, conversationId)).toMatchObject({ state: "DONE", version: 2, by: "user" });
    expect((await events(t, conversationId)).map((event) => event.kind)).toEqual(["created", "state_changed"]);
  });

  it("W4 · REGRESSION (WF-2A §7): a new audience reply classified `arrival = backfill` still reopens a Done conversation", async () => {
    const { t, content, base, conversationId } = await doneConversation();
    await ingest(t, content, sighting(base, { id: "fb_r1_backfilled", parent: "fb_r1", author: "user", createdAt: "2026-10-03T09:00:00.000Z", observedAt: "2026-10-03T09:01:00.000Z" }), { arrival: "backfill" });
    const arrival = (await oracle<{ arrival: string }>("select e.arrival from ingestion.ingestion_events e join interactions.interactions i on i.workspace_id = e.workspace_id and i.id = e.interaction_id where e.workspace_id = $1 and i.provider_interaction_id = 'fb_r1_backfilled'", [t.workspaceId]))[0]?.arrival;
    expect(arrival).toBe("backfill");
    expect(await item(t, conversationId)).toMatchObject({ state: "OPEN", version: 3, by: "system_auto_reopen" });
  });

  it("W5 · out of order: a reply dated by the platform before everything, but observed only now, reopens — and the activity does not move back", async () => {
    const { t, content, base, conversationId } = await doneConversation();
    const before = must(await item(t, conversationId), "item").latest.toISOString();
    await ingest(t, content, sighting(base, { id: "fb_r1_late", parent: "fb_r1", author: "user", createdAt: "2026-09-01T00:00:00.000Z", observedAt: "2026-10-06T00:00:00.000Z" }));
    const after = must(await item(t, conversationId), "item");
    expect(after).toMatchObject({ state: "OPEN", version: 3 });
    expect(after.latest.toISOString()).toBe(before);
    expect(after.latest.toISOString()).toBe((await trueActivity(t, conversationId)).toISOString());
  });

  it("W6 · a reply that arrived before its parent joins with it later: both join, the Done conversation reopens (cause = the parent)", async () => {
    const { t, content, base, conversationId } = await doneConversation();
    // fb_x replies to fb_p, a reply to fb_r1 not read yet: fb_p is a placeholder, fb_x has no conversation.
    await ingest(t, content, sighting(base, { id: "fb_x", parent: "fb_p", author: "user", createdAt: "2026-10-07T10:00:00.000Z", observedAt: "2026-10-07T10:01:00.000Z" }));
    expect((await canonical(t, "fb_x")).conversation_id).toBeNull();
    expect(await item(t, conversationId)).toMatchObject({ state: "DONE", version: 2 });
    await ingest(t, content, sighting(base, { id: "fb_p", parent: "fb_r1", author: "user", createdAt: "2026-10-07T09:00:00.000Z", observedAt: "2026-10-07T11:00:00.000Z" }));
    expect((await canonical(t, "fb_x")).conversation_id).toBe(conversationId);
    expect(await item(t, conversationId)).toMatchObject({ state: "OPEN", version: 3 });
    expect((await events(t, conversationId)).at(-1)?.cause_interaction_id).toBe((await canonical(t, "fb_p")).id);
    expect(must(await item(t, conversationId), "item").latest.toISOString()).toBe("2026-10-07T10:00:00.000Z");
  });

  it("W7 · stale Done: a new audience reply makes a Done sent against the older version CONFLICT; an account reply does not", async () => {
    const t = await tenant();
    const sim = createBaselineSimulator();
    const content = await organicPost(sim);
    const base = await templateOf(t, sim, content);
    await ingest(t, content, sighting(base, { id: "fb_s1", parent: null, author: "user", createdAt: "2026-10-01T10:00:00.000Z", observedAt: "2026-10-01T10:01:00.000Z" }));
    const conversationId = must((await canonical(t, "fb_s1")).conversation_id ?? undefined, "conversation");
    // The page showed version 1; an audience reply arrives before the click.
    await ingest(t, content, sighting(base, { id: "fb_s1_new", parent: "fb_s1", author: "user", createdAt: "2026-10-02T10:00:00.000Z", observedAt: "2026-10-02T10:01:00.000Z" }));
    expect(codeOf(await done(t, conversationId, 1))).toBe("CONFLICT");
    expect(await item(t, conversationId)).toMatchObject({ state: "OPEN", version: 2 });
    // The page now shows version 2; the account replies before the click: the Done still applies.
    await ingest(t, content, sighting(base, { id: "fb_s1_brand", parent: "fb_s1", author: "brand", createdAt: "2026-10-02T11:00:00.000Z", observedAt: "2026-10-02T11:01:00.000Z" }));
    expect(ok(await done(t, conversationId, 2))).toMatchObject({ state: "DONE", version: 3 });
  });

  it("W8 · concurrency: concurrent ingestion of two members loses neither, and a concurrent projection waits on the work item's lock, then recomputes with the other member in sight", async () => {
    const t = await tenant();
    const sim = createBaselineSimulator();
    const content = await organicPost(sim);
    const base = await templateOf(t, sim, content);
    await ingest(t, content, sighting(base, { id: "fb_c1", parent: null, author: "user", createdAt: "2026-10-01T10:00:00.000Z", observedAt: "2026-10-01T10:01:00.000Z" }));
    const conversationId = must((await canonical(t, "fb_c1")).conversation_id ?? undefined, "conversation");
    /** Runs `first` (holding its transaction open after its projection) and `second` concurrently; returns what `second` waited on. */
    const interleave = async (first: (wrap: (stores: IngestionStores) => IngestionStores) => Promise<unknown>, second: () => Promise<unknown>): Promise<string | undefined> => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let projected!: () => void;
      const holding = new Promise<void>((resolve) => { projected = resolve; });
      const a = first((stores) => ({ ...stores, workflow: { membersJoined: async (input) => { await stores.workflow.membersJoined(input); projected(); await gate; } } }));
      await holding;
      const b = second();
      let waitedOn: string | undefined;
      try {
        for (let n = 0; n < 100 && waitedOn === undefined; n += 1) {
          // pg_locks (readable by the test role, unlike other roles' pg_stat_activity wait columns): a backend with an
          // ungranted lock is waiting; the relations it holds (tuple) locks on tell what it waits on.
          waitedOn = (await oracle<{ on: string | null }>(
            `select string_agg(distinct coalesce(l.relation::regclass::text, l.locktype), ',' order by coalesce(l.relation::regclass::text, l.locktype)) as on
               from pg_locks l where l.pid in (select w.pid from pg_locks w where not w.granted)`))[0]?.on ?? undefined;
          if (waitedOn === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } finally {
        release();
      }
      await Promise.all([a, b]);
      return waitedOn;
    };

    // 1. Two ingestions of members of the same conversation, the OLDER one committing second: neither is lost.
    const waited1 = await interleave(
      (wrap) => ingest(t, content, sighting(base, { id: "fb_c1_newer", parent: "fb_c1", author: "user", createdAt: "2026-10-09T10:00:00.000Z", observedAt: "2026-10-09T10:01:00.000Z" }), { wrap }),
      () => ingest(t, content, sighting(base, { id: "fb_c1_older", parent: "fb_c1", author: "user", createdAt: "2026-10-08T10:00:00.000Z", observedAt: "2026-10-09T10:02:00.000Z" }), { database: worker2 }),
    );
    expect(waited1).toBeDefined(); // the second really ran while the first held its transaction
    let row = must(await item(t, conversationId), "item");
    expect(row.latest.toISOString()).toBe("2026-10-09T10:00:00.000Z");
    expect(row.latest.toISOString()).toBe((await trueActivity(t, conversationId)).toISOString());
    expect(row.version).toBe(3); // two audience members joined an OPEN item

    // 2. A projection running WHILE another member's ingestion holds the work item: it waits on the work item itself,
    //    then recomputes AFTER that commit — so it writes the newer activity, never the stale one it would have read first.
    const waited2 = await interleave(
      (wrap) => ingest(t, content, sighting(base, { id: "fb_c1_newest", parent: "fb_c1", author: "user", createdAt: "2026-10-11T10:00:00.000Z", observedAt: "2026-10-11T10:01:00.000Z" }), { wrap }),
      () => withWorkspaceJobScope(worker2, t.workspaceId, (tx: DatabaseTransaction) =>
        rebuildWorkItem(createPostgresWorkflowProjectionStore(tx, createPostgresAuditLog(tx)), { latestActivity: (c) => createPostgresInteractionStore(tx).latestConversationActivity(c) }, clock, { conversationId, organizationId: t.organizationId, workspaceId: t.workspaceId, correlationId: correlation() })),
    );
    expect(waited2).toMatch(/work_items/);
    row = must(await item(t, conversationId), "item");
    expect(row.latest.toISOString()).toBe("2026-10-11T10:00:00.000Z");
    expect(row.latest.toISOString()).toBe((await trueActivity(t, conversationId)).toISOString());
    expect(row.version).toBe(4);
  });

  it("W9 · rebuild / reconciliation: activity drift and a missing work item are repaired; a Done state and its version are untouched", async () => {
    const { t, content, base, conversationId } = await doneConversation();
    await ingest(t, content, sighting(base, { id: "fb_r2", parent: null, author: "user", createdAt: "2026-10-10T10:00:00.000Z", observedAt: "2026-10-10T10:01:00.000Z" }));
    const second = must((await canonical(t, "fb_r2")).conversation_id ?? undefined, "conversation");
    // Drift (an operator mistake or a lost write) on the first; the second's work item missing altogether.
    await privileged.query("update workflow.work_items set latest_activity_at = '2020-01-01T00:00:00Z' where workspace_id = $1 and id = $2", [t.workspaceId, conversationId]);
    await privileged.query("delete from workflow.work_items where workspace_id = $1 and id = $2", [t.workspaceId, second]);
    for (const id of [conversationId, second]) {
      const outcome = await withWorkspaceJobScope(worker, t.workspaceId, (tx: DatabaseTransaction) =>
        rebuildWorkItem(createPostgresWorkflowProjectionStore(tx, createPostgresAuditLog(tx)), { latestActivity: (c) => createPostgresInteractionStore(tx).latestConversationActivity(c) }, clock, { conversationId: id, organizationId: t.organizationId, workspaceId: t.workspaceId, correlationId: correlation() }));
      expect(outcome.kind).toBe("projected");
    }
    expect(await item(t, conversationId)).toMatchObject({ state: "DONE", resolution: "no_reply_needed", version: 2 });
    expect(must(await item(t, conversationId), "item").latest.toISOString()).toBe((await trueActivity(t, conversationId)).toISOString());
    expect(await item(t, second)).toMatchObject({ state: "OPEN", version: 1, by: "system_ingestion" });
    expect(must(await item(t, second), "item").latest.toISOString()).toBe((await trueActivity(t, second)).toISOString());
    // A second pass finds nothing to do.
    const again = await withWorkspaceJobScope(worker, t.workspaceId, (tx: DatabaseTransaction) =>
      rebuildWorkItem(createPostgresWorkflowProjectionStore(tx, createPostgresAuditLog(tx)), { latestActivity: (c) => createPostgresInteractionStore(tx).latestConversationActivity(c) }, clock, { conversationId, organizationId: t.organizationId, workspaceId: t.workspaceId, correlationId: correlation() }));
    expect(again).toEqual({ kind: "unchanged" });
  });

  it("W10 · Monitor-only: ingestion projects, Mark Done and Reopen work (internal workflow only)", async () => {
    const { t, conversationId } = await doneConversation("MONITOR_ONLY");
    expect(ok(await pipelineAs(t.users.RESPONDER).run(reopenCommand, { workspaceId: t.workspaceId, input: { conversationId, expectedVersion: 2 } }))).toMatchObject({ state: "OPEN", version: 3 });
  });

  it("W11 · the conversation view carries the work item's state, resolution and version, and whether THIS member may change it", async () => {
    const { t, conversationId } = await doneConversation();
    const view = async (role: Role) => ok(await pipelineAs(t.users[role]).run(inboxConversationCommand, { workspaceId: t.workspaceId, input: { conversationId } }));
    expect((await view("RESPONDER")).workflow).toEqual({ state: "done", resolution: "no_reply_needed", version: 2, canChange: true });
    expect((await view("ANALYST_VIEWER")).workflow).toEqual({ state: "done", resolution: "no_reply_needed", version: 2, canChange: false });
    expect((await view("RESPONDER")).workflowState).toBe("done");
    // The legacy column is not the authority (it still says OPEN).
    expect((await oracle<{ s: string }>("select workflow_state as s from conversations.conversations where id = $1", [conversationId]))[0]?.s).toBe("OPEN");
  });
}
