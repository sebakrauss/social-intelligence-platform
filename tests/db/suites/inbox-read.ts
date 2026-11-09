/**
 * Step 7A — the Inbox read side on the real database (migrations 0017 and 0024), simulator only (no Meta, no network).
 * Canonical rows are seeded the way production writes them: the simulator's own listings → trusted mapping →
 * ingestInteractionFact in worker transactions bound to one workspace. The Inbox is then read exactly as the web does:
 * the REAL action pipeline over the REAL PostgreSQL unit of work (web login role, `authenticated`, transaction-local
 * claims, sealed workspace) with a server-validated synthetic identity.
 *
 *   authorization   every non-guest role reads; a client guest is PERMISSION_DENIED (pipeline) AND reads 0 rows (RLS);
 *                   a member of another workspace is NOT_FOUND; another workspace's conversation is NOT_FOUND here
 *   content         conversations newest-activity first; platform and organic/paid from the content; the anchor is a
 *                   top-level audience comment; your account's replies are marked yours; counts are what was READ
 *   versions        a text edit at the platform leaves the earlier version visible as history, the new one current
 *   coverage        "what has been read" per account and kind, with as-of; Instagram replies honestly not covered
 *   facts           a persisted deterministic signal of the current text appears as a fact; never as a label
 *   pagination      a one-row page walks every conversation exactly once through server-issued positions
 *   no writes       the read commands append no audit event and no outbox row
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCorrelationId, type CorrelationId } from "@/domain/correlation";
import { parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import { parseInstant, type Instant } from "@/domain/instant";
import type { ContentDto, InteractionDto, Page, PageCursor, ProviderAccess, TimeWindow } from "@/integrations/providers/contract";
import { CONTENT_KINDS, parseIsoInstant } from "@/integrations/providers/contract";
import { createPostgresClassificationStore } from "@/modules/classification/persistence";
import type { AvailabilityInput } from "@/modules/coverage";
import { createPostgresCoverageReadStore } from "@/modules/coverage/persistence";
import { ingestInteractionFact, interactionSourceFactFromDto, orderParentsFirst, recordIngestionCoverage, type IngestionStores } from "@/modules/ingestion";
import type { InteractionSourceFact } from "@/modules/interactions";
import { createPostgresInteractionReadStore } from "@/modules/interactions/persistence";
import { withUserScope, withWorkspaceJobScope, type DatabaseTransaction, type RuntimeDatabase } from "@/platform/db";
import { createLogger } from "@/platform/observability";
import { ingestionStores } from "@/server/persistence/ingestion";
import { createPostgresUnitOfWork } from "@/server/persistence/postgres-unit-of-work";
import { createActionPipeline, type ActionPipeline } from "@/server/pipeline";
import { INBOX_PAGE_SIZE, encodeCursor, inboxConversationCommand, inboxListCommand, parseCursor } from "@/server/queries/inbox";
import { resolveConversation, resolveInboxPage } from "@/server/inbox/inbox";
import { createBaselineSimulator } from "../../providers/support/simulator-harness";
import { FakeIdentity, verifiedUser } from "../../support/in-memory";
import { privilegedPool, runtimeDatabase, type DbTarget } from "../support/target";
import { cleanupWorld } from "../support/world";

const FB: AvailabilityInput = { state: "AVAILABLE", reason: "CAPABILITY_SUPPORTED", limitationCode: null };
const IG: AvailabilityInput = { state: "AVAILABLE_WITH_LIMITATION", reason: "CAPABILITY_LIMITATION", limitationCode: "REPLIES_NOT_READ" };
const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(what);
  return value;
};
const instant = (iso: string): Instant => must(parseInstant(iso), "instant");
const correlation = (): CorrelationId => must(parseCorrelationId(`inbox7a-${randomUUID()}`), "correlation");
const LISTING: TimeWindow = { from: must(parseIsoInstant("2026-01-01T00:00:00.000Z"), "instant"), to: must(parseIsoInstant("2027-01-01T00:00:00.000Z"), "instant") };
const ROLES = ["OWNER", "ADMIN", "MANAGER", "RESPONDER", "ANALYST_VIEWER", "CLIENT_GUEST"] as const;

interface Tenant {
  readonly organizationId: string;
  readonly workspaceId: WorkspaceId;
  readonly users: Readonly<Record<(typeof ROLES)[number], string>>;
  readonly accounts: Readonly<Record<"fb_page_aurora" | "ig_acct_aurora", string>>;
}
type Simulator = ReturnType<typeof createBaselineSimulator>;

export function defineInboxReadSuite(getTarget: () => DbTarget): void {
  let privileged: pg.Pool;
  let web: RuntimeDatabase<"web">;
  let worker: RuntimeDatabase<"worker">;
  const organizations: string[] = [];
  const clock = { newId: randomUUID, now: () => new Date() };
  const oracle = async <T extends pg.QueryResultRow>(query: string, values: readonly unknown[] = []): Promise<T[]> => (await privileged.query<T>(query, [...values])).rows;

  const tenant = async (): Promise<Tenant> => {
    const organizationId = randomUUID();
    const workspaceId = must(parseWorkspaceId(randomUUID()), "workspace");
    organizations.push(organizationId);
    await privileged.query("insert into tenancy.organizations (id, name, created_at) values ($1, 'Inbox', now())", [organizationId]);
    await privileged.query("insert into tenancy.workspaces (id, organization_id, name, mode, created_at) values ($1, $2, 'W', 'MONITOR_ONLY', now())", [workspaceId, organizationId]);
    const users = {} as Record<(typeof ROLES)[number], string>;
    for (const role of ROLES) {
      const user = randomUUID();
      users[role] = user;
      await privileged.query("insert into tenancy.organization_memberships values ($1, $2, $3, now())", [organizationId, user, role === "OWNER" ? "OWNER" : "MEMBER"]);
      await privileged.query("insert into tenancy.workspace_memberships values ($1, $2, $3, $4, '{}', now())", [organizationId, workspaceId, user, role]);
    }
    const connection = randomUUID();
    await privileged.query(
      `insert into connections.connections (id, organization_id, workspace_id, provider, status, active_credential_id, authorized_by, authorized_at, version, created_at, updated_at)
       values ($1, $2, $3, 'meta', 'ACTIVE', null, $4, now(), 1, now(), now())`,
      [connection, organizationId, workspaceId, users.OWNER],
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
    return { organizationId, workspaceId, users, accounts: accounts as Tenant["accounts"] };
  };

  // ── Seeding through the production ingestion path (simulator listings) ───────────────────────────────────────────
  const access = (sim: Simulator, asset: string): ProviderAccess => sim.access("cred_meta_main", asset);
  const contentDto = async (sim: Simulator, asset: string, contentId: string): Promise<ContentDto> => {
    let cursor: PageCursor | null = null;
    for (;;) {
      const page: Page<ContentDto> = (await sim.read.listContent(access(sim, asset), LISTING, cursor)).data;
      const found = page.items.find((item) => item.ref.id === contentId);
      if (found !== undefined) return found;
      if (page.next.kind === "end") throw new Error("content not listed");
      cursor = page.next.cursor;
    }
  };
  const listed = async (sim: Simulator, asset: string, content: ContentDto): Promise<InteractionDto[]> => {
    const out: InteractionDto[] = [];
    let cursor: PageCursor | null = null;
    for (;;) {
      const page: Page<InteractionDto> = (await sim.read.listInteractions(access(sim, asset), { kind: "content", content: content.ref }, LISTING, cursor)).data;
      out.push(...page.items);
      if (page.next.kind === "end") return out;
      cursor = page.next.cursor;
    }
  };
  const stores = (tx: DatabaseTransaction): IngestionStores => ingestionStores({ tx, noteOutbox: () => undefined });
  const sync = async (t: Tenant, sim: Simulator, asset: keyof Tenant["accounts"], contentId: string, availability: AvailabilityInput): Promise<void> => {
    sim.world.advanceClock(60);
    const content = await contentDto(sim, asset, contentId);
    const facts: readonly InteractionSourceFact[] = orderParentsFirst(
      (await listed(sim, asset, content)).map((dto) =>
        interactionSourceFactFromDto(dto, {
          workspaceId: t.workspaceId, connectedAccountId: t.accounts[asset], providerAssetId: asset, mechanism: "reconciliation", operation: "listInteractions", provenance: "listed",
          observedAt: instant(sim.world.now()), catalogRevision: 5, profileRevision: 5,
        }),
      ),
    );
    for (const fact of facts) {
      await withWorkspaceJobScope(worker, t.workspaceId, (tx) =>
        ingestInteractionFact(stores(tx), clock, { fact, content: { contentKind: content.contentKind, reportedSource: content.reportedSource }, availability, arrival: "reconciliation", correlationId: correlation() }));
    }
    await withWorkspaceJobScope(worker, t.workspaceId, (tx) =>
      recordIngestionCoverage(stores(tx), clock, {
        workspaceId: t.workspaceId, connectedAccountId: t.accounts[asset], contentItemId: null, from: instant("2026-09-10T00:00:00.000Z"), to: instant("2026-09-11T00:00:00.000Z"),
        asOf: instant(sim.world.now()), availability, result: "completed", correlationId: correlation(),
      }));
  };

  // ── The web, exactly as production composes it ──────────────────────────────────────────────────────────────────
  const logs: string[] = [];
  const pipelineAs = (user: string | undefined): ActionPipeline =>
    createActionPipeline({
      identity: new FakeIdentity(user === undefined ? undefined : verifiedUser(must(parseWorkspaceId(user), "user") as never)),
      unitOfWork: createPostgresUnitOfWork(web),
      clock: () => new Date(),
      newId: randomUUID,
      logger: createLogger({ sink: (line) => logs.push(line) }),
    });
  const list = (user: string, workspaceId: unknown, cursor?: string) => resolveInboxPage(pipelineAs(user), workspaceId, cursor);
  const view = (user: string, workspaceId: unknown, conversationId: unknown) => resolveConversation(pipelineAs(user), workspaceId, conversationId);
  const readyList = async (user: string, workspaceId: unknown, cursor?: string) => {
    const state = await list(user, workspaceId, cursor);
    if (state.kind !== "ready") throw new Error(`expected ready, got ${state.kind}`);
    return state.page;
  };
  const readyView = async (user: string, workspaceId: unknown, conversationId: unknown) => {
    const state = await view(user, workspaceId, conversationId);
    if (state.kind !== "ready") throw new Error(`expected ready, got ${state.kind}`);
    return state.detail;
  };
  const rowOf = async (t: Tenant, providerInteractionId: string) =>
    must((await oracle<{ id: string; conversation_id: string | null; current_source_text_version_id: string | null }>(
      "select id, conversation_id, current_source_text_version_id from interactions.interactions where workspace_id = $1 and provider_interaction_id = $2", [t.workspaceId, providerInteractionId]))[0], providerInteractionId);

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

  describe("the Inbox over simulator-ingested Facebook and Instagram conversations", () => {
    let a: Tenant;
    let b: Tenant;
    let sim: Simulator;
    beforeAll(async () => {
      a = await tenant();
      b = await tenant();
      sim = createBaselineSimulator();
      await sync(a, sim, "fb_page_aurora", "fb_post_organic_01", FB);
      await sync(a, sim, "ig_acct_aurora", "ig_post_unknown_11", IG);
      await sync(b, createBaselineSimulator(), "fb_page_aurora", "fb_post_organic_01", FB);
    });

    it("lists conversations newest-activity first with platform, organic/paid, an audience anchor and counts of what was READ", async () => {
      const page = await readyList(a.users.OWNER, a.workspaceId);
      const expected = (await oracle<{ n: number }>("select count(*)::int as n from conversations.conversations where workspace_id = $1", [a.workspaceId]))[0]?.n ?? -1;
      expect(expected).toBeGreaterThan(0);
      expect(page.items).toHaveLength(expected);
      expect(page.emptyReason).toBeNull();
      expect(page.nextCursor).toBeNull();
      const times = page.items.map((item) => item.latestActivityAt.getTime());
      expect([...times].sort((x, y) => y - x)).toEqual(times);
      expect(new Set(page.items.map((item) => item.platform))).toEqual(new Set(["facebook", "instagram"]));
      for (const item of page.items) {
        expect(["organic", "paid", "mixed", "unknown"]).toContain(item.source);
        expect(CONTENT_KINDS).toContain(item.contentKind);
        expect(item.workflowState).toBe("open");
        expect(item.observedCount).toBeGreaterThanOrEqual(1);
        expect(item.anchor.observed).toBe(true);
        if (item.anchor.observed) expect(item.anchor.author).not.toBe("own_account");
      }
      // "What has been read": both accounts, newest as-of, Instagram replies honestly NOT covered.
      expect(page.asOf).not.toBeNull();
      const fb = page.coverage.find((c) => c.connectedAccountId === a.accounts.fb_page_aurora);
      const ig = page.coverage.find((c) => c.connectedAccountId === a.accounts.ig_acct_aurora);
      expect(fb).toMatchObject({ platform: "facebook", active: true, comments: { state: "complete", scope: "account" }, replies: { state: "complete" } });
      expect(ig).toMatchObject({ platform: "instagram", active: true, comments: { state: "complete" }, replies: { state: "unavailable", reason: "CAPABILITY_LIMITATION", limitationCode: "REPLIES_NOT_READ" } });
    });

    it("every non-guest role reads the same page; a client guest is denied by the pipeline AND reads nothing through RLS", async () => {
      const owner = await readyList(a.users.OWNER, a.workspaceId);
      for (const role of ROLES.filter((r) => r !== "CLIENT_GUEST" && r !== "OWNER")) {
        const page = await readyList(a.users[role], a.workspaceId);
        expect(page.items.map((i) => i.conversationId), role).toEqual(owner.items.map((i) => i.conversationId));
      }
      expect(await list(a.users.CLIENT_GUEST, a.workspaceId)).toEqual({ kind: "not_allowed" });
      const direct = await withUserScope(web, { sub: a.users.CLIENT_GUEST, role: "authenticated" }, a.workspaceId, (tx) => createPostgresInteractionReadStore(tx).listConversationActivity({ limit: 10, before: null }));
      expect(direct).toEqual([]);
    });

    it("tenant isolation: another workspace's member is NOT_FOUND; another workspace's conversation is NOT_FOUND here; RLS shows nothing across", async () => {
      expect(await list(b.users.OWNER, a.workspaceId)).toEqual({ kind: "workspace_not_found" });
      const foreign = must((await readyList(b.users.OWNER, b.workspaceId)).items[0], "b item");
      expect(await view(a.users.OWNER, a.workspaceId, foreign.conversationId)).toEqual({ kind: "conversation_not_found" });
      // A foreign workspace that parses as a UUID is indistinguishable from a missing conversation: existence is never revealed.
      expect(await view(a.users.OWNER, b.workspaceId, foreign.conversationId)).toEqual({ kind: "conversation_not_found" });
      const across = await withUserScope(web, { sub: b.users.OWNER, role: "authenticated" }, a.workspaceId, (tx) => createPostgresInteractionReadStore(tx).listConversationActivity({ limit: 10, before: null }));
      expect(across).toEqual([]);
    });

    it("a conversation: the thread oldest first from its audience anchor, your account's replies marked yours, the content context inherited", async () => {
      const page = await readyList(a.users.RESPONDER, a.workspaceId);
      const fbItem = must(page.items.find((i) => i.platform === "facebook" && i.observedCount > 1), "a Facebook conversation with replies");
      const detail = await readyView(a.users.RESPONDER, a.workspaceId, fbItem.conversationId);
      expect(detail).toMatchObject({ conversationId: fbItem.conversationId, platform: "facebook", contentKind: fbItem.contentKind, workflowState: "open", truncated: false });
      expect(detail.thread).toHaveLength(fbItem.observedCount + fbItem.notYetReadCount);
      const first = must(detail.thread[0], "anchor");
      expect(first.interactionId).toBe(detail.anchorInteractionId);
      expect(first).toMatchObject({ kind: "comment", parentInteractionId: null, observed: true });
      expect(first.author).not.toBe("own_account");
      expect(typeof first.text).toBe("string");
      for (const member of detail.thread.slice(1)) expect(member.kind).toBe("reply");
      const brand = await oracle<{ id: string }>("select id from interactions.interactions where workspace_id = $1 and conversation_id = $2 and author_role = 'account_identity'", [a.workspaceId, fbItem.conversationId]);
      expect(detail.thread.filter((m) => m.author === "own_account").map((m) => m.interactionId).sort()).toEqual(brand.map((r) => r.id).sort());
      expect(await view(a.users.OWNER, a.workspaceId, randomUUID())).toEqual({ kind: "conversation_not_found" });
    });

    it("a text edit at the platform: the new text is current, the earlier version stays visible as history", async () => {
      const before = await rowOf(a, "fb_c_004");
      sim.world.advanceClock(60);
      sim.world.editInteraction("fb_c_004", "Synthetic edited comment (7A).");
      await sync(a, sim, "fb_page_aurora", "fb_post_organic_01", FB);
      const after = await rowOf(a, "fb_c_004");
      expect(after.current_source_text_version_id).not.toBe(before.current_source_text_version_id);
      const detail = await readyView(a.users.ANALYST_VIEWER, a.workspaceId, must(after.conversation_id ?? undefined, "conversation of fb_c_004"));
      const member = must(detail.thread.find((m) => m.interactionId === after.id), "member");
      expect(member.text).toBe("Synthetic edited comment (7A).");
      expect(member.earlierVersions).toHaveLength(1);
      expect(member.earlierVersions[0]?.text).not.toBe(member.text);
    });

    it("a persisted deterministic signal of the current text appears as an observed fact (and only for that version)", async () => {
      const row = await rowOf(a, "fb_c_004");
      const version = must(row.current_source_text_version_id ?? undefined, "current version");
      const stale = must((await oracle<{ id: string }>("select id from interactions.source_text_versions where workspace_id = $1 and interaction_id = $2 and id <> $3", [a.workspaceId, row.id, version]))[0], "earlier version").id;
      await withWorkspaceJobScope(worker, a.workspaceId, async (tx) => {
        const store = createPostgresClassificationStore(tx);
        const signal = (sourceTextVersionId: string, kind: "link_present" | "text_emoji_only") => ({ id: randomUUID(), organizationId: a.organizationId, workspaceId: a.workspaceId, interactionId: row.id, sourceTextVersionId, kind, signalsVersion: "signals.v1", spans: kind === "link_present" ? [{ start: 0, end: 5 }] : null, truncated: false, now: new Date() });
        expect(await store.recordSignal(signal(version, "link_present"))).toBe("inserted");
        expect(await store.recordSignal(signal(stale, "text_emoji_only"))).toBe("inserted");
      });
      const detail = await readyView(a.users.MANAGER, a.workspaceId, must(row.conversation_id ?? undefined, "conversation"));
      expect(must(detail.thread.find((m) => m.interactionId === row.id), "member").facts).toEqual(["link_present"]);
    });

    it("pagination: one-row pages issued by the server walk every conversation exactly once, newest first", async () => {
      const all = await readyList(a.users.OWNER, a.workspaceId);
      const seen: string[] = [];
      let before = parseCursor(undefined) ?? null;
      for (let i = 0; i <= all.items.length; i += 1) {
        const rows = await withUserScope(web, { sub: a.users.OWNER, role: "authenticated" }, a.workspaceId, (tx) => createPostgresInteractionReadStore(tx).listConversationActivity({ limit: 1, before }));
        const row = rows[0];
        if (row === undefined) break;
        seen.push(row.conversationId);
        before = { latestActivityAt: row.latestActivityAt, conversationId: row.conversationId };
      }
      expect(seen).toEqual(all.items.map((item) => item.conversationId));
      expect(new Set(seen).size).toBe(seen.length);
      expect(INBOX_PAGE_SIZE).toBeGreaterThan(all.items.length);
    });

    it("the read commands write nothing: no audit event, no outbox row, through the pipeline", async () => {
      const count = async (table: string) => (await oracle<{ n: number }>(`select count(*)::int as n from ${table} where organization_id = $1`, [a.organizationId]))[0]?.n ?? -1;
      const [audit, outbox] = [await count("audit.audit_events"), await count("system.outbox")];
      const pipeline = pipelineAs(a.users.OWNER);
      const page = await pipeline.run(inboxListCommand, { workspaceId: a.workspaceId, input: {} });
      expect(page.status).toBe("ok");
      const first = page.status === "ok" ? page.value.items[0] : undefined;
      expect((await pipeline.run(inboxConversationCommand, { workspaceId: a.workspaceId, input: { conversationId: must(first, "item").conversationId } })).status).toBe("ok");
      expect(await count("audit.audit_events")).toBe(audit);
      expect(await count("system.outbox")).toBe(outbox);
    });
  });

  describe("bounded reads under volume (independent review fixes)", () => {
    let t: Tenant;
    let sim: Simulator;
    beforeAll(async () => {
      t = await tenant();
      sim = createBaselineSimulator();
      await sync(t, sim, "fb_page_aurora", "fb_post_organic_01", FB);
      await sync(t, sim, "ig_acct_aurora", "ig_post_unknown_11", IG);
    });

    it("coverage: 600 newer records of one account never displace the earlier records of another; both keep their correct state", async () => {
      const before = await readyList(t.users.OWNER, t.workspaceId);
      const igBefore = must(before.coverage.find((c) => c.connectedAccountId === t.accounts.ig_acct_aurora), "ig coverage");
      expect(igBefore.replies).toMatchObject({ state: "unavailable", limitationCode: "REPLIES_NOT_READ" });
      // 600 Facebook records (comment and reply, account-wide and one content item), every one newer than anything Instagram has, shaped like 0017 rows.
      const fbContent = must((await oracle<{ id: string }>("select id from content.content_items where workspace_id = $1 and connected_account_id = $2 limit 1", [t.workspaceId, t.accounts.fb_page_aurora]))[0], "fb content").id;
      await privileged.query(
        `insert into coverage.coverage_records (id, organization_id, workspace_id, connected_account_id, capability, content_item_id, interaction_kind, interval_start, interval_end, state, reason, limitation_code, slice_outcome, correlation_id, as_of, created_at)
         select gen_random_uuid(), $1, $2, $3, 'read_interactions', case when n % 3 = 0 then $4::uuid else null end, case when n % 2 = 0 then 'comment' else 'reply' end,
                timestamptz '2026-10-01T00:00:00Z' + make_interval(hours => n), timestamptz '2026-10-01T01:00:00Z' + make_interval(hours => n),
                'COMPLETE', 'VALIDATED_SCOPE_READ', null, 'COMPLETE', 'inbox7a-flood-' || n, timestamptz '2027-06-01T00:00:00Z' + make_interval(secs => n), now()
           from generate_series(1, 600) as s(n)`,
        [t.organizationId, t.workspaceId, t.accounts.fb_page_aurora, fbContent],
      );
      const after = await readyList(t.users.MANAGER, t.workspaceId);
      expect(after.coverageOmitted).toBe(false);
      expect(after.coverage.find((c) => c.connectedAccountId === t.accounts.ig_acct_aurora)).toEqual(igBefore);
      const fb = must(after.coverage.find((c) => c.connectedAccountId === t.accounts.fb_page_aurora), "fb coverage");
      const newest = must((await oracle<{ until: Date; as_of: Date }>(
        "select max(interval_end) as until, max(as_of) as as_of from coverage.coverage_records where workspace_id = $1 and connected_account_id = $2 and interaction_kind = 'comment' and content_item_id is null", [t.workspaceId, t.accounts.fb_page_aurora]))[0], "newest");
      expect(fb.comments).toEqual({ state: "complete", reason: "VALIDATED_SCOPE_READ", limitationCode: null, scope: "account", coveredUntil: newest.until });
      expect(fb.asOf?.getTime()).toBeGreaterThanOrEqual(newest.as_of.getTime());
      expect(after.asOf?.getTime()).toBeGreaterThan(must(igBefore.asOf ?? undefined, "ig as-of").getTime());
      // The store itself returns one row per (account, kind, scope level) for the accounts asked: six here, whatever the volume.
      const rows = await withUserScope(web, { sub: t.users.OWNER, role: "authenticated" }, t.workspaceId, (tx) => createPostgresCoverageReadStore(tx).latestPerAccountAndKind([t.accounts.fb_page_aurora, t.accounts.ig_acct_aurora]));
      expect(rows.map((r) => [r.connectedAccountId === t.accounts.fb_page_aurora ? "fb" : "ig", r.interactionKind, r.contentItemId === null ? "account" : "content"]).sort()).toEqual(
        [["fb", "comment", "account"], ["fb", "comment", "content"], ["fb", "reply", "account"], ["fb", "reply", "content"], ["ig", "comment", "account"], ["ig", "reply", "account"]],
      );
    });

    it("text versions: a comment changed 14 times shows its 10 most recent earlier versions and says older ones exist; every other comment's history stays complete", async () => {
      const row = await rowOf(t, "fb_c_004");
      const conversationId = must(row.conversation_id ?? undefined, "conversation of fb_c_004");
      const pristine = must((await readyView(t.users.RESPONDER, t.workspaceId, conversationId)).thread.find((m) => m.interactionId === row.id), "member");
      expect(pristine).toMatchObject({ earlierVersions: [], olderVersionsOmitted: false });
      // 14 further retained versions, shaped as ingestion retains them (append-only, hashed; 0017), observed before the current one.
      await privileged.query(
        `insert into interactions.source_text_versions (id, organization_id, workspace_id, interaction_id, text_hash, source_text, provider_edited_at, observed_at, created_at)
         select gen_random_uuid(), $1, $2, $3, encode(sha256(convert_to('Synthetic history ' || n, 'UTF8')), 'hex'), 'Synthetic history ' || n, null,
                timestamptz '2026-01-02T00:00:00Z' + make_interval(mins => n), now()
           from generate_series(1, 14) as s(n)`,
        [t.organizationId, t.workspaceId, row.id],
      );
      const detail = await readyView(t.users.RESPONDER, t.workspaceId, conversationId);
      const member = must(detail.thread.find((m) => m.interactionId === row.id), "member");
      expect(member.text).toBe(pristine.text);
      expect(member.olderVersionsOmitted).toBe(true);
      expect(member.earlierVersions.map((v) => v.text)).toEqual(Array.from({ length: 10 }, (_, i) => `Synthetic history ${String(i + 5)}`));
      for (const other of detail.thread.filter((m) => m.interactionId !== row.id)) expect(other.olderVersionsOmitted, other.interactionId).toBe(false);
      // The store reads a window PER interaction, never a global cap: asking for the newest 3 of two interactions yields at most 3 each.
      const other = must((await oracle<{ id: string }>("select id from interactions.interactions where workspace_id = $1 and observed and id <> $2 and current_source_text_version_id is not null limit 1", [t.workspaceId, row.id]))[0], "another observed comment").id;
      const windowed = await withUserScope(web, { sub: t.users.OWNER, role: "authenticated" }, t.workspaceId, (tx) => createPostgresInteractionReadStore(tx).textVersions([row.id, other], 3));
      expect(windowed.filter((v) => v.interactionId === row.id)).toHaveLength(3);
      expect(windowed.filter((v) => v.interactionId === other)).toHaveLength(1);
      expect(windowed.map((v) => v.observedAt.getTime())).toEqual([...windowed.map((v) => v.observedAt.getTime())].sort((x, y) => x - y));
    });

    it("pagination: conversations whose latest activity differs only below the millisecond are neither skipped nor repeated across server-issued positions", async () => {
      // PostgreSQL keeps six fractional digits; a position carries three. Give every conversation one not-yet-read member (a
      // placeholder, whose activity is its creation time — 0017 keeps observed rows' provider times immutable) created in the
      // SAME millisecond as every other conversation's, apart by microseconds only. The placeholder is shaped as ingestion
      // creates one: scope copied from the conversation's anchor, nothing else known.
      const conversations = await oracle<{ id: string }>("select id from conversations.conversations where workspace_id = $1 order by id", [t.workspaceId]);
      expect(conversations.length).toBeGreaterThan(2);
      await privileged.query(
        `with ranked as (select c.id, c.anchor_interaction_id, row_number() over (order by c.id) as rn from conversations.conversations c where c.workspace_id = $1)
         insert into interactions.interactions (id, organization_id, workspace_id, platform, provider_interaction_id, connected_account_id, provider_asset_id, content_item_id, provider_content_id, observed, conversation_id, created_at, updated_at)
         select gen_random_uuid(), a.organization_id, a.workspace_id, a.platform, 'ph7a_' || ranked.rn, a.connected_account_id, a.provider_asset_id, a.content_item_id, a.provider_content_id, false, ranked.id,
                timestamptz '2026-12-31T12:00:00.123000Z' + make_interval(secs => ((ranked.rn % 3) * 100) / 1e6), now()
           from ranked join interactions.interactions a on a.workspace_id = $1 and a.id = ranked.anchor_interaction_id`,
        [t.workspaceId],
      );
      const micro = await oracle<{ n: number }>("select count(distinct created_at)::int as n from interactions.interactions where workspace_id = $1 and provider_interaction_id like 'ph7a%'", [t.workspaceId]);
      expect(micro[0]?.n).toBe(3);
      const all = await readyList(t.users.OWNER, t.workspaceId);
      expect(all.items).toHaveLength(conversations.length);
      const seen: string[] = [];
      let before = parseCursor(undefined) ?? null;
      for (let i = 0; i <= conversations.length; i += 1) {
        const rows = await withUserScope(web, { sub: t.users.OWNER, role: "authenticated" }, t.workspaceId, (tx) => createPostgresInteractionReadStore(tx).listConversationActivity({ limit: 1, before }));
        const next = rows[0];
        if (next === undefined) break;
        seen.push(next.conversationId);
        // Exactly what a browser carries: the position re-parsed from its encoded form (millisecond instant + id).
        before = must(parseCursor(encodeCursor({ latestActivityAt: next.latestActivityAt, conversationId: next.conversationId })), "cursor");
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.sort()).toEqual(conversations.map((c) => c.id).sort());
      expect(seen.length).toBe(all.items.length);
    });
  });

  describe("a workspace with 260 managed accounts", () => {
    it("summarizes exactly the first 250 (stable order) with each one's own state, reads coverage for those only, and says the rest are not shown — none appears as unknown", async () => {
      const t = await tenant();
      const connection = must((await oracle<{ id: string }>("select id from connections.connections where workspace_id = $1", [t.workspaceId]))[0], "connection").id;
      // 258 more content-bearing accounts (260 in all), shaped as the connect flow creates them (0007; M-01 unique per asset).
      await privileged.query(
        `with asset as (
           insert into connections.discovered_assets (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, display_name, last_seen_at, created_at, updated_at)
           select gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, case when n % 2 = 0 then 'facebook' else 'instagram' end, 'bulk_' || replace($4::text, '-', '') || '_' || lpad(n::text, 3, '0'), 'content_bearing', 'Synthetic', now(), now(), now()
             from generate_series(1, 258) as s(n)
           returning organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class)
         insert into connections.connected_accounts (id, organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, status, activated_at, created_at, updated_at)
         select gen_random_uuid(), organization_id, workspace_id, connection_id, platform, provider_asset_id, asset_class, 'ACTIVE', now(), now(), now() from asset`,
        [t.organizationId, t.workspaceId, connection, t.workspaceId],
      );
      // Every account gets a comment record (COMPLETE or PARTIAL, alternating); every other account also a reply record (not read).
      await privileged.query(
        `with ranked as (select id, row_number() over (order by platform, provider_asset_id, id) as rn from connections.connected_accounts where workspace_id = $1)
         insert into coverage.coverage_records (id, organization_id, workspace_id, connected_account_id, capability, content_item_id, interaction_kind, interval_start, interval_end, state, reason, limitation_code, slice_outcome, correlation_id, as_of, created_at)
         select gen_random_uuid(), $2::uuid, $1::uuid, id, 'read_interactions', null::uuid, 'comment', timestamptz '2026-10-01T00:00:00Z', timestamptz '2026-10-02T00:00:00Z',
                case when rn % 2 = 0 then 'COMPLETE' else 'PARTIAL' end, 'VALIDATED_SCOPE_READ', null, 'COMPLETE', 'inbox7a-many-c-' || rn, timestamptz '2026-10-02T00:00:00Z' + make_interval(secs => rn), now()
           from ranked
         union all
         select gen_random_uuid(), $2::uuid, $1::uuid, id, 'read_interactions', null::uuid, 'reply', timestamptz '2026-10-01T00:00:00Z', timestamptz '2026-10-02T00:00:00Z',
                'UNAVAILABLE', 'CAPABILITY_LIMITATION', 'REPLIES_NOT_READ', 'LIMITED', 'inbox7a-many-r-' || rn, timestamptz '2026-10-02T00:00:00Z' + make_interval(secs => rn), now()
           from ranked where rn % 2 = 0`,
        [t.workspaceId, t.organizationId],
      );
      const ordered = await oracle<{ id: string; rn: number }>("select id, row_number() over (order by platform, provider_asset_id, id)::int as rn from connections.connected_accounts where workspace_id = $1", [t.workspaceId]);
      expect(ordered).toHaveLength(260);
      const expectedIds = ordered.filter((a) => a.rn <= 250).map((a) => a.id);

      const page = await readyList(t.users.ANALYST_VIEWER, t.workspaceId);
      expect(page.coverageOmitted).toBe(true);
      expect(page.coverage).toHaveLength(250);
      expect(page.coverage.map((c) => c.connectedAccountId).sort()).toEqual([...expectedIds].sort());
      for (const view of page.coverage) {
        const rn = must(ordered.find((a) => a.id === view.connectedAccountId), "account").rn;
        expect(view.comments, view.connectedAccountId).toMatchObject({ state: rn % 2 === 0 ? "complete" : "partial", scope: "account" });
        expect(view.replies, view.connectedAccountId).toMatchObject(rn % 2 === 0 ? { state: "unavailable", limitationCode: "REPLIES_NOT_READ" } : { state: "unknown" });
        expect(view.active).toBe(true);
      }
      expect(page.coverage.filter((c) => c.comments.state === "unknown")).toEqual([]);
      expect(page.asOf?.toISOString()).toBe(new Date(Date.UTC(2026, 9, 2, 0, 4, 10)).toISOString());
      // The store, asked directly for the 250 included accounts, answers for those only: nothing of the other ten is read.
      const rows = await withUserScope(web, { sub: t.users.OWNER, role: "authenticated" }, t.workspaceId, (tx) => createPostgresCoverageReadStore(tx).latestPerAccountAndKind(expectedIds));
      expect(new Set(rows.map((r) => r.connectedAccountId)).size).toBe(250);
      expect(rows).toHaveLength(250 + 125);
      // The bound counts MANAGED accounts, not active ones: deactivating the ten beyond it leaves 260 managed, so the notice stays.
      await privileged.query("update connections.connected_accounts set status = 'INACTIVE', deactivated_at = now(), deactivation_reason = 'UNLINKED', updated_at = now() where workspace_id = $1 and id = any($2::uuid[])", [t.workspaceId, ordered.filter((a) => a.rn > 250).map((a) => a.id)]);
      expect((await readyList(t.users.OWNER, t.workspaceId)).coverageOmitted).toBe(true);
    });
  });

  describe("an empty workspace", () => {
    it("says nothing has been read yet (no coverage record), never a zero", async () => {
      const t = await tenant();
      const page = await readyList(t.users.ANALYST_VIEWER, t.workspaceId);
      expect(page.items).toEqual([]);
      expect(page.emptyReason).toBe("nothing_read_yet");
      expect(page.asOf).toBeNull();
      expect(page.coverage.map((c) => [c.connectedAccountId, c.comments.state, c.replies.state]).sort()).toEqual(
        [[t.accounts.fb_page_aurora, "unknown", "unknown"], [t.accounts.ig_acct_aurora, "unknown", "unknown"]].sort(),
      );
    });
  });
}
