import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Button } from "@/ui/primitives/button";
import { AppShell } from "@/ui/shell/app-shell";
import { replyFormKey, replyOutcomeMessages } from "@/app/workspaces/[workspaceId]/inbox/views";
import { simulateReplyAction } from "../reply/actions";
import { WORKSPACE } from "./fixtures";
import { CommentsList, ContextDrawer, ListIntro, OpenConversation, PrototypeBar, hrefOf, readQuery } from "./prototype";
import styles from "./prototype.module.css";

/**
 * Inbox › Comments prototype (Step 7B-15N) — DEVELOPMENT ONLY, synthetic data. The proposed Comments experience inside
 * the real app shell, in two visual directions (`?d=focus` | `?d=triage`), navigable by links alone: select a
 * conversation, move between conversations, open the post, write → review → publish through the UNCHANGED reply
 * composer against the reply harness's simulated action (nothing is read or sent; its success says "demo"). `?data=`
 * shows what today's data supports (`now`), planned read-model data (`planned`) and demonstration intelligence (`demo`,
 * always marked). A 404 in every build that is not `next dev`.
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "UI reference · comments prototype", robots: { index: false, follow: false } };

/** The simulation sends nothing: its request outcomes read "demo", never "on its way". */
const DEMO_OUTCOME = "Demo only — no reply was sent.";
/** Proposed copy for the unknown outcome: honest without promising that a duplicate is impossible (backend gate pending). */
const UNKNOWN_OUTCOME = "We couldn't confirm the request. The reply may already be on its way — check this conversation before writing another.";

const IS_DEVELOPMENT = process.env.NODE_ENV === "development";

export default async function CommentsPrototypePage({ searchParams }: { readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>> }) {
  if (!IS_DEVELOPMENT) notFound();
  const query = readQuery(await searchParams);
  const wiring = { action: simulateReplyAction, outcomes: { ...replyOutcomeMessages(), requested: DEMO_OUTCOME, existing: DEMO_OUTCOME, unavailable: UNKNOWN_OUTCOME }, formKey: replyFormKey };
  const open = query.c === undefined ? undefined : <OpenConversation query={query} wiring={wiring} />;
  const home = hrefOf({ ...query, c: undefined, reply: undefined, ctx: false });
  return (
    <AppShell
      texts={{ brand: "wrenkind", skipToContent: "Skip to content", navigation: "Main navigation", workspace: "Workspace", workspaceUnavailable: "This workspace isn't available to you.", switchWorkspace: "Switch workspace", monitorOnly: "Monitor-only", account: "Account" }}
      workspace={{ name: WORKSPACE.name, organizationName: WORKSPACE.organization, monitorOnly: query.monitor }}
      switcher={[{ id: "other", name: "Lumen Coffee · Brasil", organizationName: WORKSPACE.organization, href: home }]}
      nav={[
        { key: "inbox", label: "Inbox", href: home, icon: "nav-inbox", current: true },
        { key: "settings", label: "Settings", href: home, icon: "nav-settings", current: false },
      ]}
      sidebar={{ heading: "Inbox", items: [{ label: "Comments", href: home, current: true }] }}
      account={
        <Button type="button" variant="secondary" size="sm">
          Sign out
        </Button>
      }
    >
      <div className={styles["page"]} data-direction={query.d} data-selected={open === undefined ? "false" : "true"}>
        <PrototypeBar query={query} />
        {open === undefined ? null : (
          <a href="#conversation" className={styles["skip"]}>
            Skip to the open conversation
          </a>
        )}
        <header className={styles["header"]}>
          <h1 className={styles["title"]}>Comments</h1>
          <p className={styles["subtitle"]}>Comments and replies on your posts and ads</p>
        </header>
        <ListIntro query={query} />
        <CommentsList query={query} expanded={open} />
        <ContextDrawer query={query} />
      </div>
    </AppShell>
  );
}
