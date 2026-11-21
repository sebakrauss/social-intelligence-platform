/**
 * COMMENTS-INT-03C-2 — the Comments views (Open, Done, All conversations) are the Inbox's own list query narrowed on the
 * server, and stay that way:
 *
 *   - the state filter is composed from the owner modules' read PORTS (the interactions module's activity keyset, the
 *     conversations module's states): no module's persistence reads another module's tables, and the query layer holds
 *     no SQL of its own;
 *   - the narrowing happens before the page is cut, with a bound (no unbounded scan per request);
 *   - the Inbox passes no state (its list is unchanged), and only views backed by real data have an address — no
 *     simulated Needs attention, Assigned to me or Escalated anywhere in the real route;
 *   - nothing here writes: the list command stays a read (no audit, no outbox), and the views never count;
 *   - M-1: the views are the workspace sidebar's (an opt-in, address-driven shell navigation that only the Comments
 *     section uses): the planned views keep their place as text only, and the page draws no navigation of its own.
 */
import { describe, expect, it } from "vitest";
import { COMMENTS_VIEW_PARAM, COMMENTS_VIEWS } from "@/server/routes";
import { QUEUE_MAX_LIMIT } from "@/modules/workflow/persistence";
import { INBOX_PAGE_SIZE, inboxListCommand } from "@/server/queries/inbox";
import { codeOf } from "../support/source-scan";

const QUERY = "server/queries/inbox.ts";
const INTERACTIONS_READ = "modules/interactions/persistence/read-store.ts";
const CONVERSATIONS_STORE = "modules/conversations/persistence/store.ts";
const WORKFLOW_PERSISTENCE = ["modules/workflow/persistence/read-store.ts", "modules/workflow/persistence/state-changer.ts", "modules/workflow/persistence/projection-store.ts", "modules/workflow/persistence/tables.ts"];
const SHELL_NAV = "ui/shell/shell-view-nav.tsx";
const ROUTE_FILES = [
  "app/workspaces/[workspaceId]/comments/page.tsx",
  "app/workspaces/[workspaceId]/comments/[conversationId]/page.tsx",
  "app/workspaces/[workspaceId]/comments/views.tsx",
  "ui/inbox/comments.tsx",
  "server/inbox/comments.ts",
];

/** The body of one top-level function of a file (from its declaration to the next top-level declaration). */
function functionBody(file: string, name: string): string {
  const code = codeOf(file);
  const start = code.indexOf(`async function ${name}(`);
  if (start === -1) return "";
  const next = code.slice(start + 1).search(/\n(?:async function|function|const|export|let) /);
  return next === -1 ? code.slice(start) : code.slice(start, start + 1 + next);
}

describe("COMMENTS-INT-03C-2: the views are the Inbox's own list, narrowed on the server through the owners' ports", () => {
  it("no module reads another module's tables: the activity store never names the conversations schema, and the reverse; the workflow persistence names neither", () => {
    expect(codeOf(INTERACTIONS_READ)).not.toMatch(/conversations\.conversations|conversationRows|pgSchema\("conversations"\)|workflow_state|modules\/conversations/);
    expect(codeOf(CONVERSATIONS_STORE)).not.toMatch(/interactions\.|interactionRows|pgSchema\("interactions"\)|modules\/interactions/);
    // WORKFLOW-WF-2B: the queue's activity is recomputed from the interactions OWNER's port (composed in), never read here.
    for (const file of WORKFLOW_PERSISTENCE) expect(codeOf(file), file).not.toMatch(/interactions\.interactions|conversations\.conversations|interactionRows|conversationRows|pgSchema\("(interactions|conversations)"\)|modules\/(interactions|conversations)/);
  });

  it("the query layer holds no SQL: it composes the owners' read ports only — the workflow queue chooses the page, then only the shown rows are completed", () => {
    const code = codeOf(QUERY);
    expect(code).not.toMatch(/from "drizzle-orm|from "@\/platform\/db|\bsql`|tx\.execute|tx\.select/);
    const page = functionBody(QUERY, "readInboxPage");
    expect(page).not.toBe("");
    // WORKFLOW-WF-2B: exactly three owner reads, in this order: the queue (workflow), the shown conversations' anchors
    // (conversations), the shown conversations' member counts and flags (interactions).
    expect([...page.matchAll(/tx\.(workflow\.reads|inbox)\.([a-zA-Z.]+)\(/g)].map((match) => `${match[1] ?? ""}.${match[2] ?? ""}`)).toEqual(["workflow.reads.queue", "inbox.conversations.findMany", "inbox.interactions.conversationActivity"]);
    expect(code).not.toMatch(/readFilteredPage|INBOX_FILTER_BATCH|INBOX_FILTER_ROUNDS|listConversationActivity|continueAt|partial: true/);
  });

  it("WORKFLOW-WF-2B: one bounded queue read per page, chosen before it is cut, always with the explicit bound-workspace predicate", () => {
    const page = functionBody(QUERY, "readInboxPage");
    // No batch loop and no second queue read: the page plus one row (that only proves an older page exists).
    expect(page).not.toMatch(/\bfor \(|\bwhile \(/);
    expect([...page.matchAll(/tx\.workflow\.reads\.queue\(/g)]).toHaveLength(1);
    expect(page).toMatch(/tx\.workflow\.reads\.queue\(\{ workspaceId, view: state \?\? "all", before: .+?, limit: INBOX_PAGE_SIZE \+ 1 \}\)/);
    // The workspace is the command's resolved, bound workspace (never input).
    expect(codeOf(QUERY)).toMatch(/execute: \(context, input, tx\) => readInboxPage\(tx, context\.workspaceId, input\.cursor\?\.cursor, input\.state\),/);
    expect(INBOX_PAGE_SIZE + 1).toBeLessThanOrEqual(QUEUE_MAX_LIMIT);
    // The queue store's every statement opens its WHERE with the explicit predicate (WF-2A Candidate 2).
    const store = codeOf("modules/workflow/persistence/read-store.ts");
    const wheres = [...store.matchAll(/from workflow\.work_items\s+where ([^\n]+)/g)].map((match) => (match[1] ?? "").trim());
    expect(wheres).toEqual(["workspace_id = ${input.workspaceId}::uuid", "workspace_id = ${input.workspaceId}::uuid"]);
  });

  it("the list command stays a read: same name and permission, no Standard-mode requirement, nothing audited", () => {
    expect(inboxListCommand.name).toBe("inbox.conversations.list");
    expect(inboxListCommand.permission).toBe("workspace.read_operational");
    expect(inboxListCommand.requiresStandardMode).toBe(false);
    expect(inboxListCommand.audit(undefined as never)).toBeUndefined();
  });

  it("the Inbox passes no state: its pages call the list read with the workspace and position only", () => {
    for (const file of ["app/workspaces/[workspaceId]/inbox/page.tsx", "app/workspaces/[workspaceId]/inbox/[conversationId]/page.tsx"]) {
      const calls = [...codeOf(file).matchAll(/currentInboxPage\(([^)]*)\)/g)].map((match) => match[1] ?? "");
      expect(calls.length, file).toBeGreaterThan(0);
      for (const args of calls) expect(args.split(",").map((arg) => arg.trim()), file).toHaveLength(2);
    }
  });

  it("only views backed by real data have an address, and the real route draws no simulated view and no count", () => {
    expect(COMMENTS_VIEWS).toEqual(["open", "done", "all"]);
    for (const file of ROUTE_FILES) expect(codeOf(file), file).not.toMatch(/attention|assigned|escalat|priority|urgent/i);
    // The views are server identifiers, URL-safe as they are (the shell builds addresses from them without encoding).
    for (const view of [...COMMENTS_VIEWS, COMMENTS_VIEW_PARAM]) expect(view).toMatch(/^[a-z]+$/);
    // A view entry is a name and the view it names — never a count (the read model has no total).
    const choice = codeOf(SHELL_NAV).match(/export interface ShellViewChoice \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect([...choice.matchAll(/readonly (\w+)\??:/g)].map((match) => match[1])).toEqual(["kind", "label", "value", "apart"]);
  });

  it("M-1: the views are the workspace sidebar's — opt-in, only the Comments section uses them, and the page draws none of its own", () => {
    const shell = codeOf("app/workspaces/[workspaceId]/workspace-shell.tsx");
    expect(shell).toMatch(/const views = section === "comments" \? commentsViewsFor\(current, access\) : undefined;/);
    expect(shell).toMatch(/const sidebar = section === "comments" \? undefined : sidebarFor\(current, access, section\);/);
    // Exactly the views backed by data are views (Open the default: no parameter); the planned ones are text only.
    expect(shell).toMatch(/items: \[view\("open"\), later\(t\("comments\.views\.attention"\)\), later\(t\("comments\.views\.assigned"\)\), later\(t\("comments\.views\.escalated"\)\), view\("done"\), view\("all", true\)\]/);
    expect(shell).toMatch(/param: COMMENTS_VIEW_PARAM,/);
    // S-1: the views lead to the Comments list, from the route helper's validated address (never the address on screen).
    expect(shell).toMatch(/const base = workspaceCommentsPath\(current\.id\);\n  if \(base === undefined\) return undefined;/);
    expect(shell).toMatch(/\n    base,\n    param: COMMENTS_VIEW_PARAM,/);
    // Only the Comments layout asks for that section; Inbox and Settings keep their own.
    expect(codeOf("app/workspaces/[workspaceId]/comments/layout.tsx")).toMatch(/section="comments"/);
    expect(codeOf("app/workspaces/[workspaceId]/inbox/layout.tsx")).toMatch(/section="inbox"/);
    expect(codeOf("app/workspaces/[workspaceId]/settings/layout.tsx")).toMatch(/section="settings"/);
    for (const file of ROUTE_FILES) expect(codeOf(file), file).not.toMatch(/CommentsViews|comments-view-|<select|comments\.views\.label/);
  });

  it("M-1: the shell's view navigation reads the address and moves — nothing else: no effect, timer, listener, storage, fetch or document access", () => {
    const code = codeOf(SHELL_NAV);
    expect(code).toMatch(/^"use client";/);
    expect([...code.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1])).toEqual(["next/navigation", "react", "@/ui/navigation/app-link", "./app-shell.module.css"]);
    // S-1: the address on screen is read for the current view only (its query); where the views lead is the server's base.
    expect(code).toMatch(/import \{ useRouter, useSearchParams \} from "next\/navigation";/);
    expect(code).not.toMatch(/usePathname/);
    expect(code).toMatch(/const hrefOf = \(choice: ShellViewChoice\): string => \(choice\.value === undefined \? views\.base : `\$\{views\.base\}\?\$\{views\.param\}=\$\{choice\.value\}`\);/);
    expect(code).toMatch(/import \{ useId, useOptimistic, useTransition \} from "react";/);
    expect(code).not.toMatch(/useEffect|useLayoutEffect|useState|useRef|addEventListener|setTimeout|setInterval|requestAnimationFrame|Storage|\bfetch\b|document\.|window\.|location\.|history\.|dangerouslySetInnerHTML|\.replace\(|\.refresh\(|\.prefetch\(/);
    // One move only: the picker's push to the chosen view; the list entries are in-app links.
    expect([...code.matchAll(/router\.push\(/g)]).toHaveLength(1);
    expect([...code.matchAll(/<AppLink\b[^>]*>/g)].map((match) => match[0])).toEqual(['<AppLink href={hrefOf(item)} className={styles["sideItem"]} pendingClassName={styles["linkPending"]} current={item === current}>']);
    // A planned view is never a link or an enabled choice.
    expect(code).toMatch(/item\.kind === "later" \? \(\s*<li key=\{item\.label\}>\s*<span className=\{styles\["sideItemLater"\]\}>/);
    expect(code).toMatch(/<span className=\{styles\["laterTag"\]\} aria-hidden="true">/);
    expect(code).toMatch(/<option key=\{item\.label\} value=\{`later:\$\{item\.label\}`\} disabled>/);
    // The AppShell draws it only when the section asks for views.
    expect(codeOf("ui/shell/app-shell.tsx")).toMatch(/\{views !== undefined \? \(\s*<ShellViewNav views=\{views\} \/>/);
  });
});
