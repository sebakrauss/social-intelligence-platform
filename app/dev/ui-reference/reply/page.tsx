import { notFound } from "next/navigation";
import type { Metadata } from "next";
import type { ConversationDetail } from "@/server/inbox/inbox";
import { InboxPanes } from "@/ui/inbox/inbox";
import { ConversationView, replyOutcomeMessages } from "@/app/workspaces/[workspaceId]/inbox/views";
import { simulateReplyAction } from "./actions";

/**
 * Reply harness (Step 7B-3) — DEVELOPMENT ONLY, synthetic data. The real conversation view with the reply affordance
 * AVAILABLE, posting to a simulated action (./actions.ts) that never reaches the pipeline, a database or a provider:
 * walk Comment → Reply → write → review → publish → state, and provoke each closed outcome with the first word of the
 * text (`deny`, `monitor`, `refuse`, `gone`, `again`, `fail`, `out`). `?platform=facebook` draws the Facebook variant
 * (no top-level restriction note). A 404 in every build that is not `next dev`.
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "UI reference · reply", robots: { index: false, follow: false } };

/** The simulation sends nothing and adds nothing to the thread: its "success" says exactly that, never "on its way". */
const DEMO_OUTCOME = "Demo only — no reply was sent.";

const IS_DEVELOPMENT = process.env.NODE_ENV === "development";
const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "66666666-6666-4666-8666-666666666666";
const at = (iso: string): Date => new Date(iso);

const DETAIL: ConversationDetail = {
  conversationId: CONVERSATION,
  workflowState: "open",
  platform: "instagram",
  source: "paid",
  contentKind: "post",
  anchorInteractionId: "a1111111-1111-4111-8111-111111111111",
  truncated: false,
  reply: { kind: "available", connectedAccountId: ACCOUNT, platform: "instagram", maxChars: 2200, limitation: null },
  outbound: [{ intentId: "b2222222-2222-4222-8222-222222222222", parentInteractionId: "a5555555-5555-4555-8555-555555555555", text: "Gracias por avisar, lo revisamos.", state: "sent", outcomeCode: null, createdAt: at("2026-11-08T23:21:00Z"), confirmedAt: at("2026-11-08T23:21:30Z") }],
  thread: [
    { interactionId: "a1111111-1111-4111-8111-111111111111", parentInteractionId: null, kind: "comment", observed: true, author: "audience", authorLabel: "caro.m", text: "Pedí el 2 de octubre y todavía no llega. ¿Alguien me puede responder?", presence: "present", providerCreatedAt: at("2026-11-08T22:50:00Z"), providerEditedAt: null, textObservedAt: at("2026-11-08T23:14:00Z"), earlierVersions: [], olderVersionsOmitted: false, facts: [] },
    { interactionId: "a2222222-2222-4222-8222-222222222222", parentInteractionId: "a1111111-1111-4111-8111-111111111111", kind: "reply", observed: true, author: "own_account", authorLabel: null, text: "Gracias por avisar, te escribimos por privado para revisar el pedido.", presence: "present", providerCreatedAt: at("2026-11-08T23:05:00Z"), providerEditedAt: null, textObservedAt: at("2026-11-08T23:14:00Z"), earlierVersions: [], olderVersionsOmitted: false, facts: ["author_own_brand"] },
    { interactionId: "a3333333-3333-4333-8333-333333333333", parentInteractionId: "a1111111-1111-4111-8111-111111111111", kind: "reply", observed: true, author: "audience", authorLabel: "caro.m", text: "ok, espero el mensaje 🙏 <b>gracias</b>", presence: "present", providerCreatedAt: at("2026-11-08T23:10:00Z"), providerEditedAt: null, textObservedAt: at("2026-11-08T23:14:00Z"), earlierVersions: [], olderVersionsOmitted: false, facts: [] },
    { interactionId: "a5555555-5555-4555-8555-555555555555", parentInteractionId: null, kind: "comment", observed: true, author: "audience", authorLabel: "Marta P.", text: "Me pasó lo mismo la semana pasada.", presence: "present", providerCreatedAt: at("2026-11-08T23:12:00Z"), providerEditedAt: null, textObservedAt: at("2026-11-08T23:14:00Z"), earlierVersions: [], olderVersionsOmitted: false, facts: [] },
    { interactionId: "a6666666-6666-4666-8666-666666666666", parentInteractionId: null, kind: "comment", observed: true, author: "audience", authorLabel: "lucas_mz", text: "¿Hay envío a Rosario?", presence: "hidden", providerCreatedAt: at("2026-11-08T23:13:00Z"), providerEditedAt: null, textObservedAt: at("2026-11-08T23:14:00Z"), earlierVersions: [], olderVersionsOmitted: false, facts: [] },
  ],
};

export default async function ReplyReferencePage({ searchParams }: { readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>> }) {
  if (!IS_DEVELOPMENT) notFound();
  const platform = (await searchParams)["platform"] === "facebook" ? "facebook" : "instagram";
  const detail: ConversationDetail = platform === "facebook" ? { ...DETAIL, platform, source: "organic", reply: { ...DETAIL.reply, platform } as ConversationDetail["reply"] } : DETAIL;
  return (
    <main>
      <InboxPanes selected skipToDetail={{ href: "#conversation", label: "Skip to conversation" }} list={<div />} detail={<ConversationView workspaceId={WS} detail={detail} cursor={undefined} replyAction={simulateReplyAction} replyOutcomes={{ ...replyOutcomeMessages(), requested: DEMO_OUTCOME, existing: DEMO_OUTCOME }} />} />
    </main>
  );
}
