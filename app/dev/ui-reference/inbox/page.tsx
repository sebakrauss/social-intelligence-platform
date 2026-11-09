import { notFound } from "next/navigation";
import type { Metadata } from "next";
import type { ConversationDetail, InboxPage } from "@/server/inbox/inbox";
import { InboxPanes } from "@/ui/inbox/inbox";
import { ClosedState, ConversationView, DetailEmpty, InboxListView } from "@/app/workspaces/[workspaceId]/inbox/views";

/**
 * Inbox reference (UI-4) — DEVELOPMENT ONLY, synthetic data. Draws the Inbox views with hand-written view models so
 * the list, the detail and every state can be reviewed in both themes and at every width without a session or a
 * database: no read, no action. `?view=` picks the state. A 404 in every build that is not `next dev`.
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "UI reference · inbox", robots: { index: false, follow: false } };

const IS_DEVELOPMENT = process.env.NODE_ENV === "development";
const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const IDS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"] as const;
const ACCOUNT_IG = "66666666-6666-4666-8666-666666666666";
const ACCOUNT_FB = "77777777-7777-4777-8777-777777777777";
const at = (iso: string): Date => new Date(iso);

const PAGE: InboxPage = {
  items: [
    { conversationId: IDS[0], workflowState: "open", platform: "instagram", source: "paid", contentKind: "post", anchor: { observed: true, author: "audience", authorLabel: "caro.m", excerpt: "Pedí el 2 de octubre y todavía no llega. ¿Alguien me puede responder? Ya escribí dos veces por privado y nadie contesta.", presence: "present" }, latestActivityAt: at("2026-11-08T23:14:00Z"), observedCount: 3, notYetReadCount: 0, anyHidden: false, anyRemovedAtSource: false },
    { conversationId: IDS[1], workflowState: "open", platform: "facebook", source: "organic", contentKind: "post", anchor: { observed: true, author: "audience", authorLabel: "Marta P.", excerpt: "¿Abren el domingo por la mañana? Quiero pasar con mi familia.", presence: "present" }, latestActivityAt: at("2026-11-08T21:02:00Z"), observedCount: 1, notYetReadCount: 0, anyHidden: false, anyRemovedAtSource: false },
    { conversationId: IDS[2], workflowState: "open", platform: "instagram", source: "mixed", contentKind: "reel", anchor: { observed: true, author: "audience", authorLabel: "lucas_mz", excerpt: "O preço subiu de novo? Achei caro demais para o que entrega. <b>não</b> recomendo https://example.test/promo", presence: "hidden" }, latestActivityAt: at("2026-11-08T19:40:00Z"), observedCount: 2, notYetReadCount: 1, anyHidden: true, anyRemovedAtSource: false },
    { conversationId: IDS[3], workflowState: "done", platform: "facebook", source: "unknown", contentKind: null, anchor: { observed: true, author: "own_account", authorLabel: null, excerpt: "Gracias a todos por venir ayer. Volvemos el jueves con la segunda tanda.", presence: "present" }, latestActivityAt: at("2026-11-07T15:00:00Z"), observedCount: 1, notYetReadCount: 0, anyHidden: false, anyRemovedAtSource: true },
    { conversationId: IDS[4], workflowState: "open", platform: "instagram", source: "organic", contentKind: "post", anchor: { observed: false }, latestActivityAt: at("2026-11-06T08:30:00Z"), observedCount: 0, notYetReadCount: 2, anyHidden: false, anyRemovedAtSource: false },
  ],
  nextCursor: "2026-11-06T08:30:00.000Z~55555555-5555-4555-8555-555555555555",
  asOf: at("2026-11-08T23:28:00Z"),
  coverage: [
    { connectedAccountId: ACCOUNT_IG, platform: "instagram", active: true, comments: { state: "complete", reason: "VALIDATED_SCOPE_READ", limitationCode: null, scope: "content", coveredUntil: at("2026-11-08T23:28:00Z") }, replies: { state: "unavailable", reason: "CAPABILITY_LIMITATION", limitationCode: "REPLIES_NOT_READ", scope: "content", coveredUntil: null }, asOf: at("2026-11-08T23:28:00Z") },
    { connectedAccountId: ACCOUNT_FB, platform: "facebook", active: true, comments: { state: "complete", reason: "VALIDATED_SCOPE_READ", limitationCode: null, scope: "account", coveredUntil: at("2026-11-08T23:00:00Z") }, replies: { state: "complete", reason: "VALIDATED_SCOPE_READ", limitationCode: null, scope: "account", coveredUntil: at("2026-11-08T23:00:00Z") }, asOf: at("2026-11-08T23:00:00Z") },
  ],
  coverageOmitted: false,
  emptyReason: null,
};

const PARTIAL: InboxPage = {
  ...PAGE,
  coverage: [
    { connectedAccountId: ACCOUNT_IG, platform: "instagram", active: true, comments: { state: "partial", reason: "TRAVERSAL_INCOMPLETE", limitationCode: null, scope: "account", coveredUntil: at("2026-11-07T10:00:00Z") }, replies: { state: "unknown", reason: null, limitationCode: null, scope: "account", coveredUntil: null }, asOf: at("2026-11-07T10:00:00Z") },
    { connectedAccountId: ACCOUNT_FB, platform: "facebook", active: false, comments: { state: "failed", reason: "PROVIDER_FAILURE", limitationCode: null, scope: "account", coveredUntil: null }, replies: { state: "importing", reason: "IN_PROGRESS", limitationCode: null, scope: "account", coveredUntil: null }, asOf: at("2026-11-08T23:00:00Z") },
  ],
  coverageOmitted: true,
};

const EMPTY: InboxPage = { items: [], nextCursor: null, asOf: null, coverage: [], coverageOmitted: false, emptyReason: "nothing_read_yet" };
const NONE: InboxPage = { ...PAGE, items: [], nextCursor: null, emptyReason: "no_conversations_in_coverage" };

const DETAIL: ConversationDetail = {
  conversationId: IDS[0],
  workflowState: "open",
  platform: "instagram",
  source: "paid",
  contentKind: "post",
  anchorInteractionId: "a1111111-1111-4111-8111-111111111111",
  truncated: false,
  thread: [
    { interactionId: "a1111111-1111-4111-8111-111111111111", parentInteractionId: null, kind: "comment", observed: true, author: "audience", authorLabel: "caro.m", text: "Pedí el 2 de octubre y todavía no llega. ¿Alguien me puede responder?\nYa escribí dos veces por privado y nadie contesta.", presence: "present", providerCreatedAt: at("2026-11-08T22:50:00Z"), providerEditedAt: at("2026-11-08T22:58:00Z"), textObservedAt: at("2026-11-08T23:14:00Z"), earlierVersions: [{ text: "Pedí el 2 de octubre y todavía no llega.", observedAt: at("2026-11-08T22:55:00Z"), providerEditedAt: null }], olderVersionsOmitted: true, facts: ["link_present"] },
    { interactionId: "a2222222-2222-4222-8222-222222222222", parentInteractionId: "a1111111-1111-4111-8111-111111111111", kind: "reply", observed: true, author: "own_account", authorLabel: null, text: "Gracias por avisar, te escribimos por privado para revisar el pedido.", presence: "present", providerCreatedAt: at("2026-11-08T23:05:00Z"), providerEditedAt: null, textObservedAt: at("2026-11-08T23:14:00Z"), earlierVersions: [], olderVersionsOmitted: false, facts: ["author_own_brand"] },
    { interactionId: "a3333333-3333-4333-8333-333333333333", parentInteractionId: "a1111111-1111-4111-8111-111111111111", kind: "reply", observed: true, author: "audience", authorLabel: "caro.m", text: "<script>alert(1)</script> ok, espero el mensaje 🙏", presence: "hidden", providerCreatedAt: at("2026-11-08T23:10:00Z"), providerEditedAt: null, textObservedAt: at("2026-11-08T23:14:00Z"), earlierVersions: [], olderVersionsOmitted: false, facts: [] },
    { interactionId: "a4444444-4444-4444-8444-444444444444", parentInteractionId: "a1111111-1111-4111-8111-111111111111", kind: "reply", observed: false, author: "unknown", authorLabel: null, text: null, presence: "unknown", providerCreatedAt: null, providerEditedAt: null, textObservedAt: null, earlierVersions: [], olderVersionsOmitted: false, facts: [] },
    { interactionId: "a5555555-5555-4555-8555-555555555555", parentInteractionId: null, kind: "comment", observed: true, author: "audience", authorLabel: null, text: "Me pasó lo mismo la semana pasada.", presence: "removed_at_source", providerCreatedAt: at("2026-11-08T23:12:00Z"), providerEditedAt: null, textObservedAt: at("2026-11-08T23:14:00Z"), earlierVersions: [], olderVersionsOmitted: false, facts: ["watch_term_match"] },
  ],
};

const VIEWS = ["list", "selected", "detail", "empty", "none", "partial", "unavailable", "not_allowed", "not_found"] as const;
type View = (typeof VIEWS)[number];
const isView = (value: unknown): value is View => typeof value === "string" && (VIEWS as readonly string[]).includes(value);

export default async function InboxReferencePage({ searchParams }: { readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>> }) {
  if (!IS_DEVELOPMENT) notFound();
  const raw = (await searchParams)["view"];
  const view: View = isView(raw) ? raw : "list";
  const cursor = "2026-11-08T23:14:00.000Z~11111111-1111-4111-8111-111111111111";
  const list = (page: InboxPage, selectedId?: string) => <InboxListView workspaceId={WS} page={page} cursor={cursor} {...(selectedId === undefined ? {} : { selectedId })} />;
  return (
    <main>
      {view === "list" ? <InboxPanes selected={false} list={list(PAGE)} detail={<DetailEmpty />} /> : null}
      {view === "selected" || view === "detail" ? <InboxPanes selected={view === "detail"} skipToDetail={{ href: "#conversation", label: "Skip to conversation" }} list={list(PAGE, IDS[0])} detail={<ConversationView workspaceId={WS} detail={DETAIL} cursor={cursor} />} /> : null}
      {view === "empty" ? <InboxPanes selected={false} list={list(EMPTY)} detail={null} /> : null}
      {view === "none" ? <InboxPanes selected={false} list={list(NONE)} detail={null} /> : null}
      {view === "partial" ? <InboxPanes selected={false} list={list(PARTIAL)} detail={<DetailEmpty />} /> : null}
      {view === "unavailable" ? <InboxPanes selected={false} list={<ClosedState kind="unavailable" />} detail={null} /> : null}
      {view === "not_allowed" ? <InboxPanes selected={false} list={<ClosedState kind="not_allowed" />} detail={null} /> : null}
      {view === "not_found" ? <InboxPanes selected list={list(PAGE)} detail={<ClosedState kind="conversation_not_found" />} /> : null}
    </main>
  );
}
