import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { WORKSPACE_ROLES, type WorkspaceRole } from "@/domain/access";
import { WORKSPACE_ROLE_PERMISSIONS } from "@/platform/permissions/catalog";
import { t } from "@/server/i18n";
import {
  buildConversationDetail,
  buildInboxPage,
  INBOX_COVERAGE_ACCOUNTS,
  INBOX_PAGE_SIZE,
  INBOX_THREAD_LIMIT,
  INBOX_VERSION_LIMIT,
} from "@/server/queries/inbox";
import {
  COMMENTS_DEFAULT_VIEW,
  COMMENTS_VIEW_PARAM,
  parseCommentsView,
  type CommentsView,
} from "@/server/routes";
import { AppShell } from "@/ui/shell/app-shell";
import { TextLink } from "@/ui/primitives/text-link";
import {
  CommentsListView,
  type CommentsSelectionView,
} from "@/app/workspaces/[workspaceId]/comments/views";
import { ClosedState } from "@/app/workspaces/[workspaceId]/inbox/read-views";
import { simulateWorkflowAction } from "./actions";
import {
  HARNESS_PATH,
  HARNESS_WORKSPACE,
  harnessState,
  resetHarness,
  type HarnessItem,
  type HarnessMode,
} from "./store";
import styles from "./harness.module.css";

/**
 * Comments Workflow harness (WORKFLOW-WF-2D) — DEVELOPMENT ONLY, synthetic data. The REAL Comments list and pane
 * (CommentsListView: rows, header, WorkflowControl) inside the REAL shell with its REAL view navigation, built by the
 * REAL view-model builders (buildInboxPage, buildConversationDetail) from an in-memory synthetic workspace, with the
 * REAL permission catalog deciding who may change a state. The one substitution is the action: the local simulation
 * (./actions.ts) instead of the real one, through the view's `workflowAction` prop (as the reply harness does).
 * No session, database, provider or external service. A 404 in every build that is not `next dev`.
 *
 *   ?view=open|done|all   the view (the shell's navigation sets it)      ?c=<id>   the selected conversation
 *   ?role=<workspace role> who is looking (default MANAGER)              ?mode=normal|slow|fail-once
 *   ?seed=default|open    reset the synthetic workspace       (role, mode and seed are applied once, then dropped)
 * Row, Previous / Next and "back" links in the real views lead to the REAL route (they are not followed here).
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "UI reference · comments workflow",
  robots: { index: false, follow: false },
};

const IS_DEVELOPMENT = process.env.NODE_ENV === "development";
const ACCOUNTS = {
  instagram: "66666666-6666-4666-8666-666666666666",
  facebook: "77777777-7777-4777-8777-777777777777",
} as const;
const MODES: readonly HarnessMode[] = ["normal", "slow", "fail-once"];
const VIEW_LABELS = {
  open: "comments.views.open",
  done: "comments.views.done",
  all: "comments.views.all",
} as const;
const one = (value: string | string[] | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;
const contentOf = (item: HarnessItem): string =>
  `${item.id.slice(0, 24)}0000000000c1`;

function pageFor(items: readonly HarnessItem[], view: CommentsView) {
  const shown = items
    .filter(
      (item) =>
        view === "all" || item.state === (view === "open" ? "OPEN" : "DONE"),
    )
    .sort(
      (a, b) =>
        b.latestActivityAt.getTime() - a.latestActivityAt.getTime() ||
        (a.id < b.id ? 1 : -1),
    );
  return buildInboxPage({
    activity: shown.map((item) => ({
      conversationId: item.id,
      latestActivityAt: item.latestActivityAt,
      observedCount: item.members,
      placeholderCount: 0,
      anyHidden: false,
      anyRemovedAtSource: false,
    })),
    conversations: shown.map((item) => ({
      id: item.id,
      anchorInteractionId: item.anchorId,
      workflowState: item.state,
      createdAt: item.latestActivityAt,
    })),
    anchors: shown.map((item) => anchorOf(item)),
    contents: shown.map((item) => ({
      id: contentOf(item),
      platform: item.platform,
      connectedAccountId: ACCOUNTS[item.platform],
      providerAssetId: `${item.platform}_harness`,
      providerContentId: `post_${item.id.slice(0, 8)}`,
      contentKind: item.contentKind,
      reportedSource: item.source,
      latestObservedAt: item.latestActivityAt,
    })),
    coverage: (["instagram", "facebook"] as const).flatMap((platform) =>
      (["comment", "reply"] as const).map((kind) => ({
        connectedAccountId: ACCOUNTS[platform],
        contentItemId: null,
        interactionKind: kind,
        state: "COMPLETE",
        reason: "VALIDATED_SCOPE_READ",
        limitationCode: null,
        sliceOutcome: "COMPLETE",
        intervalStart: new Date("2026-08-01T00:00:00Z"),
        intervalEnd: new Date("2026-11-08T23:30:00Z"),
        asOf: new Date("2026-11-08T23:30:00Z"),
      })),
    ),
    accounts: [
      { id: ACCOUNTS.instagram, platform: "instagram", status: "ACTIVE" },
      { id: ACCOUNTS.facebook, platform: "facebook", status: "ACTIVE" },
    ],
    pageSize: INBOX_PAGE_SIZE,
    coverageAccountLimit: INBOX_COVERAGE_ACCOUNTS,
    ...(view === "all" ? {} : { state: view }),
  });
}

function anchorOf(item: HarnessItem) {
  return {
    id: item.anchorId,
    providerInteractionId: `harness_${item.anchorId.slice(0, 8)}`,
    conversationId: item.id,
    contentItemId: contentOf(item),
    connectedAccountId: ACCOUNTS[item.platform],
    platform: item.platform,
    observed: true,
    kind: "comment",
    parentInteractionId: null,
    authorRole: "user",
    authorLabel: item.author,
    currentSourceTextVersionId: null,
    currentText: item.text,
    currentVisibility: "visible",
    currentAvailability: "available",
    providerCreatedAt: item.latestActivityAt,
    providerEditedAt: null,
    textObservedAt: item.latestActivityAt,
    firstObservedAt: item.latestActivityAt,
    latestObservedAt: item.latestActivityAt,
  };
}

function selectionFor(
  items: readonly HarnessItem[],
  selected: string | undefined,
  role: WorkspaceRole,
): CommentsSelectionView {
  const item = items.find((candidate) => candidate.id === selected);
  if (selected === undefined) return { kind: "none" };
  if (item === undefined)
    return {
      kind: "closed",
      message: <ClosedState kind="conversation_not_found" />,
    };
  return {
    kind: "conversation",
    detail: buildConversationDetail({
      conversation: {
        id: item.id,
        anchorInteractionId: item.anchorId,
        workflowState: item.state,
        createdAt: item.latestActivityAt,
      },
      thread: [anchorOf(item)],
      versions: [],
      signals: [],
      content: {
        id: contentOf(item),
        platform: item.platform,
        connectedAccountId: ACCOUNTS[item.platform],
        providerAssetId: `${item.platform}_harness`,
        providerContentId: `post_${item.id.slice(0, 8)}`,
        contentKind: item.contentKind,
        reportedSource: item.source,
        latestObservedAt: item.latestActivityAt,
      },
      threadLimit: INBOX_THREAD_LIMIT,
      versionLimit: INBOX_VERSION_LIMIT,
      reply: { kind: "hidden" },
      outbound: [],
      // The REAL permission contract decides: workflow.internal (OWNER, ADMIN, MANAGER, RESPONDER).
      workflow: {
        state: item.state === "DONE" ? "done" : "open",
        resolution: item.resolution,
        version: item.version,
        canChange: WORKSPACE_ROLE_PERMISSIONS[role].has("workflow.internal"),
      },
    }),
  };
}

export default async function CommentsWorkflowHarnessPage({
  searchParams,
}: {
  readonly searchParams: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}) {
  if (!IS_DEVELOPMENT) notFound();
  const query = await searchParams;
  const state = harnessState();
  const view = parseCommentsView(query[COMMENTS_VIEW_PARAM]);
  const selected = one(query["c"]);
  // seed / role / mode are one-shot commands: applied once, then the address drops them, so the re-render that follows
  // an action (revalidatePath) never re-applies them (a reset there would silently undo the change just made).
  if (
    query["seed"] !== undefined ||
    query["role"] !== undefined ||
    query["mode"] !== undefined
  ) {
    const seed = one(query["seed"]);
    if (seed === "default" || seed === "open") resetHarness(seed);
    const role = WORKSPACE_ROLES.find(
      (candidate) => candidate === one(query["role"]),
    );
    if (role !== undefined) state.role = role;
    const mode = MODES.find((candidate) => candidate === one(query["mode"]));
    if (mode !== undefined) state.mode = mode;
    const kept = new URLSearchParams({
      ...(view === COMMENTS_DEFAULT_VIEW ? {} : { view }),
      ...(selected === undefined ? {} : { c: selected }),
    }).toString();
    redirect(kept === "" ? HARNESS_PATH : `${HARNESS_PATH}?${kept}`);
  }
  const permissions = WORKSPACE_ROLE_PERMISSIONS[state.role];
  const viewItem = (value: CommentsView, apart = false) => ({
    kind: "view" as const,
    label: t(VIEW_LABELS[value]),
    value: value === COMMENTS_DEFAULT_VIEW ? undefined : value,
    ...(apart ? { apart: true } : {}),
  });
  const later = (label: string) => ({ kind: "later" as const, label });
  const here = (extra: Record<string, string>) =>
    `${HARNESS_PATH}?${new URLSearchParams({ ...(view === COMMENTS_DEFAULT_VIEW ? {} : { view }), ...(selected === undefined ? {} : { c: selected }), ...extra }).toString()}`;
  return (
    <AppShell
      texts={{
        brand: "wrenkind",
        skipToContent: t("shell.skip_to_content"),
        navigation: t("shell.nav.label"),
        workspace: t("shell.workspace.label"),
        workspaceUnavailable: t("shell.workspace.unavailable"),
        switchWorkspace: t("shell.workspace.switch"),
        monitorOnly: t("shell.workspace.monitor_only"),
        account: t("shell.account.label"),
      }}
      workspace={{
        name: "Synthetic Coffee (harness)",
        organizationName: "Synthetic Group",
        monitorOnly: false,
      }}
      switcher={[]}
      nav={[
        {
          key: "inbox",
          label: t("shell.nav.inbox"),
          href: HARNESS_PATH,
          icon: "nav-inbox",
          current: true,
        },
      ]}
      sidebar={undefined}
      views={
        permissions.has("workspace.read_operational")
          ? {
              label: t("comments.views.label"),
              heading: t("shell.section.inbox.heading"),
              base: HARNESS_PATH,
              param: COMMENTS_VIEW_PARAM,
              pickerLabel: t("comments.views.picker"),
              laterNote: t("comments.views.later"),
              laterTag: t("comments.views.later_tag"),
              items: [
                viewItem("open"),
                later(t("comments.views.attention")),
                later(t("comments.views.assigned")),
                later(t("comments.views.escalated")),
                viewItem("done"),
                viewItem("all", true),
              ],
            }
          : undefined
      }
      account={<span>{state.role}</span>}
    >
      <aside
        className={styles["harness"]}
        aria-label="Development harness controls (synthetic)"
      >
        <strong>
          Development harness — synthetic data, simulated action, no session or
          database.
        </strong>
        <span>
          Role:{" "}
          {WORKSPACE_ROLES.map((candidate) => (
            <span key={candidate} className={styles["choice"]}>
              {candidate === state.role ? (
                <b>{candidate}</b>
              ) : (
                <TextLink href={here({ role: candidate })}>
                  {candidate}
                </TextLink>
              )}
            </span>
          ))}
        </span>
        <span>
          Mode:{" "}
          {MODES.map((candidate) => (
            <span key={candidate} className={styles["choice"]}>
              {candidate === state.mode ? (
                <b>{candidate}</b>
              ) : (
                <TextLink href={here({ mode: candidate })}>
                  {candidate}
                </TextLink>
              )}
            </span>
          ))}
          {" · "}
          <TextLink href={`${HARNESS_PATH}?seed=default`}>
            reset
          </TextLink> ·{" "}
          <TextLink href={`${HARNESS_PATH}?seed=open`}>
            reset (none Done)
          </TextLink>
        </span>
        {permissions.has("workspace.read_operational") ? (
          <span>
            Select:{" "}
            {state.items.map((item, n) => (
              <span key={item.id} className={styles["choice"]}>
                <TextLink
                  href={`${HARNESS_PATH}?${new URLSearchParams({ ...(view === COMMENTS_DEFAULT_VIEW ? {} : { view }), c: item.id }).toString()}`}
                >{`#${String(n + 1)} ${item.author}`}</TextLink>
              </span>
            ))}
          </span>
        ) : null}
      </aside>
      {/* As the real route: a member without workspace.read_operational (a client guest) gets the closed state only. */}
      <main>
        {permissions.has("workspace.read_operational") ? (
          <CommentsListView
            workspaceId={HARNESS_WORKSPACE}
            view={view}
            page={pageFor(state.items, view)}
            cursor={undefined}
            selection={selectionFor(state.items, selected, state.role)}
            workflowAction={simulateWorkflowAction}
          />
        ) : (
          <ClosedState kind="not_allowed" />
        )}
      </main>
    </AppShell>
  );
}
