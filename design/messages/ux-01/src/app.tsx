/**
 * MESSAGES-UX-01 — Wrenkind Messages, synthetic interactive prototype (iteration 02). One page, real browser navigation
 * (/messages?view=… and /messages/:id?view=…), local state only. Layout follows the approved Direction C: workspace
 * shell (rail + sidebar views), list beside the conversation at 1024 px and wider, one panel below it.
 * Product presentation and prototype controls are separated: a one-line DEMO bar is always visible; scenario, sending
 * variant, theme, future intelligence and reviewer notes live in the "Prototype controls" panel.
 */
import { useEffect, useReducer, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { Logo } from "@/ui/brand/logo";
import { Button } from "@/ui/primitives/button";
import { Icon } from "@/ui/icons/icon";
import { ACCOUNTS, initialState } from "./data";
import { focusHint, hrefOf, isUnread, lastActivity, lastMessage, ME, navigate, parseRoute, reducer, routeSnapshot, shortWhen, subscribeRoute, windowOf, type Action, type Conversation, type Route, type Scenario, type SendMode, type State, type View } from "./model";
import { Thread, type Position } from "./thread";
import { accountLabel, accountOf, Avatar, cx, Dialog, firstName, Marker, PlatformMark, teammate } from "./ui";

const VIEW_NAMES: { readonly [V in View]: string } = { open: "Open", done: "Done", all: "All conversations" };
const DISCONNECTED_ACCOUNT = "a-fb";

interface Filters {
  readonly q: string;
  readonly account: string;
  readonly unread: boolean;
  readonly mine: boolean;
}

const NO_FILTERS: Filters = { q: "", account: "all", unread: false, mine: false };

const link = (href: string, before?: () => void) => (event: MouseEvent<HTMLAnchorElement>) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  before?.();
  navigate(href);
};

/**
 * The view's rows. The Unread filter keeps the conversation you have open (reading it is what cleared its unread
 * state), so its position and Previous/Next stay meaningful while you're in it.
 */
function listFor(state: State, view: View, filters: Filters, openId: string | null): readonly Conversation[] {
  if (state.scenario === "empty" || state.scenario === "loading") return [];
  const term = filters.q.trim().toLowerCase();
  return state.conversations
    .filter((c) => view === "all" || c.state === view)
    .filter((c) => filters.account === "all" || c.accountId === filters.account)
    .filter((c) => !filters.unread || isUnread(c) || c.id === openId)
    .filter((c) => !filters.mine || c.assignee === ME)
    .filter((c) => term === "" || `${c.participant.name} ${c.participant.handle ?? ""} ${c.messages.map((m) => m.text ?? "").join(" ")}`.toLowerCase().includes(term))
    .toSorted((a, b) => lastActivity(b) - lastActivity(a));
}

export function App() {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const location = useSyncExternalStore(subscribeRoute, routeSnapshot);
  const route = parseRoute(location.split("?")[0] ?? "", location.includes("?") ? location.slice(location.indexOf("?")) : "");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const [controls, setControls] = useState(false);
  const previousId = useRef<string | null | undefined>(undefined);
  const listY = useRef(0);

  const items = listFor(state, route.view, filters, route.id);
  const selected = route.id === null ? null : (state.conversations.find((c) => c.id === route.id) ?? null);

  // Explicitly opening a conversation clears *your* internal unread state only — never a platform read receipt. It
  // runs when the open conversation changes, so "Mark as unread for you" isn't undone by the conversation on screen.
  useEffect(() => {
    if (route.id !== null) dispatch({ type: "open", id: route.id });
  }, [route.id]);

  // Focus and position (Comments UX-19 rules). Opening: focus stays where the person acted (the row beside the
  // conversation, or Previous/Next); when it was lost (one panel, browser Back) it goes to the conversation's title.
  // Going back to the list: the list's scroll position comes back and focus returns to the row (or the row that took
  // its place when it left the view).
  useEffect(() => {
    const before = previousId.current;
    previousId.current = route.id;
    if (before === undefined || before === route.id) return;
    const single = window.matchMedia("(max-width: 1023px)").matches;
    if (route.id !== null) {
      const active = document.activeElement;
      if (active === null || active === document.body || active.getClientRects().length === 0) document.getElementById("thread-title")?.focus({ preventScroll: true });
      if (!single) document.querySelector(`[data-row="${route.id}"]`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (before === null) return;
    if (single) window.scrollTo({ top: listY.current });
    const hint = focusHint().focusRow ?? null;
    const row = document.querySelector<HTMLElement>(`[data-row="${before}"]`) ?? (hint === null ? null : document.querySelector<HTMLElement>(`[data-row="${hint}"]`)) ?? document.querySelector<HTMLElement>("[data-row]");
    (row ?? document.getElementById("message-search"))?.focus({ preventScroll: single });
  }, [route.id]);

  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset["theme"];
    else document.documentElement.dataset["theme"] = theme;
  }, [theme]);

  // Toasts leave on their own: 5 s, or 8 s when they offer Undo.
  useEffect(() => {
    if (state.toast === null) return;
    const timer = window.setTimeout(
      () => {
        dispatch({ type: "dismissToast" });
      },
      state.toast.undo === null ? 5000 : 8000,
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [state.toast]);

  // Escape closes the conversation (when no dialog, menu or field has it).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || route.id === null || document.querySelector("dialog[open]") !== null) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && /^(TEXTAREA|INPUT|SELECT)$/.test(target.tagName)) return;
      navigate(hrefOf({ view: route.view, id: null }));
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [route.id, route.view]);

  const index = selected === null ? -1 : items.findIndex((c) => c.id === selected.id);
  const inView = selected !== null && (route.view === "all" || selected.state === route.view);
  const position: Position = {
    // View membership and the extra filters are different things: a filtered-out Open conversation is still Open.
    label: index >= 0 ? `${String(index + 1)} of ${String(items.length)}` : inView ? "Outside current filters" : `Not in ${VIEW_NAMES[route.view]}`,
    previous: index > 0 ? hrefOf({ view: route.view, id: items[index - 1]?.id ?? null }) : null,
    next: index >= 0 && index < items.length - 1 ? hrefOf({ view: route.view, id: items[index + 1]?.id ?? null }) : null,
    back: hrefOf({ view: route.view, id: null }),
    backLabel: VIEW_NAMES[route.view],
    neighbor: index < 0 ? null : (items[index + 1]?.id ?? items[index - 1]?.id ?? null),
    leavesOnStateChange: route.view !== "all",
  };
  const rememberList = () => {
    listY.current = window.scrollY;
  };
  const counts = state.scenario === "empty" || state.scenario === "loading" ? null : { open: state.conversations.filter((c) => c.state === "open").length, unread: state.conversations.filter((c) => c.state === "open" && isUnread(c)).length };

  return (
    <div className={cx("app")} data-selected={route.id === null ? "false" : "true"}>
      <Rail />
      <Sidebar route={route} counts={counts} />
      <main className={cx("main")}>
        <DemoBar
          sendMode={state.sendMode}
          onOpen={() => {
            setControls(true);
          }}
        />
        <TopStrip route={route} />
        <div className={cx("pageHead")}>
          <h1 className={cx("pageTitle")}>Messages</h1>
          <p className={cx("pageSub")}>Instagram Direct and Messenger</p>
        </div>
        {state.scenario === "disconnected" ? (
          <p className={cx("connectionBanner")} role="status">
            <Icon name="estado-alert" size={16} /> <span>Messenger for <strong>Lumen Coffee</strong> needs reconnecting. Its conversations may be incomplete and replying is paused until an admin reconnects it.</span>
          </p>
        ) : null}
        <div className={cx("split")} data-selected={route.id === null ? "false" : "true"}>
          <section className={cx("listColumn")} aria-label={`${VIEW_NAMES[route.view]} conversations`}>
            <Toolbar filters={filters} onFilters={setFilters} />
            <p className="wk-sr-only" role="status">
              {state.scenario === "loading" ? "Loading conversations" : selected === null ? `${VIEW_NAMES[route.view]}: ${String(items.length)} conversations` : `${selected.participant.name}, ${position.label}`}
            </p>
            <ConversationList items={items} route={route} state={state} onOpen={rememberList} />
          </section>
          <div className={cx("pane")}>
            {selected === null ? (
              <div className={cx("paneEmpty")}>
                {route.id === null ? (
                  <>
                    <Icon name="conv-thread" size={32} />
                    <p>Select a conversation to read it here.</p>
                  </>
                ) : (
                  <p>This conversation doesn’t exist in the prototype’s synthetic data.</p>
                )}
              </div>
            ) : (
              <Thread
                key={selected.id}
                conversation={selected}
                position={position}
                dispatch={dispatch}
                draft={state.drafts[selected.id]}
                savedReplies={state.savedReplies}
                showFuture={state.showFuture}
                disconnected={state.scenario === "disconnected" && selected.accountId === DISCONNECTED_ACCOUNT}
                sendMode={state.sendMode}
              />
            )}
          </div>
        </div>
      </main>
      <BottomNav />
      {state.toast === null ? null : (
        <div className={cx("toast")} role="status" key={state.toast.id}>
          <span>{state.toast.text}</span>
          {state.toast.undo === null ? null : (
            <button
              type="button"
              className={cx("linkButton")}
              onClick={() => {
                dispatch({ type: "undo" });
              }}
            >
              Undo
            </button>
          )}
          <button
            type="button"
            className={cx("iconButton")}
            aria-label="Dismiss"
            onClick={() => {
              dispatch({ type: "dismissToast" });
            }}
          >
            ✕
          </button>
        </div>
      )}
      <Dialog
        side
        open={controls}
        title="Prototype controls"
        onClose={() => {
          setControls(false);
        }}
        footer={
          <Button
            variant="primary"
            onClick={() => {
              setControls(false);
            }}
          >
            Done
          </Button>
        }
      >
        <Controls state={state} dispatch={dispatch} theme={theme} onTheme={setTheme} />
      </Dialog>
    </div>
  );
}

/** Inert destinations are shown as unavailable items, never as links that do nothing. */
function NavItem({ icon, label, current, bottom = false }: { readonly icon: "nav-inbox" | "conv-thread" | "nav-settings"; readonly label: string; readonly current: boolean; readonly bottom?: boolean }) {
  const base = bottom ? "bottomItem" : "railItem";
  if (current) {
    return (
      <a className={cx(base, `${base}On`)} href="/messages" aria-current="page" onClick={link("/messages")}>
        <Icon name={icon} size={20} />
        <span>{label}</span>
      </a>
    );
  }
  return (
    <span className={cx(base, `${base}Off`)} aria-disabled="true" title={`${label} isn’t part of this prototype`}>
      <Icon name={icon} size={20} />
      <span>{label}</span>
      <span className="wk-sr-only"> (not part of this prototype)</span>
    </span>
  );
}

function Rail() {
  return (
    <nav className={cx("rail")} aria-label="Wrenkind">
      <NavItem icon="nav-inbox" label="Comments" current={false} />
      <NavItem icon="conv-thread" label="Messages" current />
      <NavItem icon="nav-settings" label="Settings" current={false} />
    </nav>
  );
}

function BottomNav() {
  return (
    <nav className={cx("bottomNav")} aria-label="Wrenkind">
      <NavItem icon="nav-inbox" label="Comments" current={false} bottom />
      <NavItem icon="conv-thread" label="Messages" current bottom />
      <NavItem icon="nav-settings" label="Settings" current={false} bottom />
    </nav>
  );
}

function Workspace() {
  return (
    <div className={cx("workspace")}>
      <p className={cx("eyebrow")}>Workspace</p>
      <p className={cx("workspaceName")}>Lumen Coffee</p>
      <p className={cx("workspaceOrg")}>Lumen Group</p>
    </div>
  );
}

function Sidebar({ route, counts }: { readonly route: Route; readonly counts: { readonly open: number; readonly unread: number } | null }) {
  const item = (view: View, count: number | null, unread: number | null = null) => (
    <li>
      <a className={cx("sideItem", route.view === view && "sideItemOn")} href={hrefOf({ view, id: null })} aria-current={route.view === view ? "page" : undefined} onClick={link(hrefOf({ view, id: null }))}>
        <span>{VIEW_NAMES[view]}</span>
        {count === null ? null : (
          <span className={cx("count")}>
            {unread === null || unread === 0 ? null : <span className={cx("countUnread")} aria-label={`${String(unread)} unread`}>{String(unread)} new · </span>}
            {String(count)}
          </span>
        )}
      </a>
    </li>
  );
  return (
    <aside className={cx("side")}>
      <div className={cx("brand")}>
        <Logo variant="wordmark" title="wrenkind" />
      </div>
      <Workspace />
      <nav aria-label="Messages views">
        <p className={cx("sideHeading")}>Messages</p>
        <ul className={cx("sideList")}>
          {item("open", counts?.open ?? null, counts?.unread ?? null)}
          <li>
            <span className={cx("sideItem", "sideItemLater")} aria-disabled="true">
              <span>Needs attention</span>
              <span className={cx("laterTag")}>Not yet</span>
            </span>
          </li>
          {item("done", null)}
        </ul>
        <ul className={cx("sideList", "sideListApart")}>{item("all", null)}</ul>
      </nav>
      <div className={cx("sideAccounts")}>
        <p className={cx("sideHeading")}>Connected accounts</p>
        <ul className={cx("accountList")}>
          {ACCOUNTS.map((a) => (
            <li key={a.id}>
              <PlatformMark platform={a.platform} />
              <span>{accountLabel(a)}</span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

function TopStrip({ route }: { readonly route: Route }) {
  return (
    <div className={cx("strip")}>
      <div className={cx("stripBrand")}>
        <Logo variant="wordmark-small" title="wrenkind" />
        <Workspace />
      </div>
      <label className={cx("stripPicker")}>
        <span className={cx("eyebrow")}>Messages</span>
        <select
          className={cx("select", "viewSelect")}
          value={route.view}
          aria-label="View"
          onChange={(event) => {
            navigate(hrefOf({ view: event.target.value as View, id: null }));
          }}
        >
          <option value="open">Open</option>
          <option value="attention" disabled>
            Needs attention (not yet)
          </option>
          <option value="done">Done</option>
          <option value="all">All conversations</option>
        </select>
      </label>
    </div>
  );
}

function DemoBar({ sendMode, onOpen }: { readonly sendMode: SendMode; readonly onOpen: () => void }) {
  return (
    <div className={cx("demoBar")} role="note" aria-label="Prototype">
      <span className={cx("prototypeTag")}>DEMO</span>
      <span className={cx("demoText")}>
        <span className={cx("long")}>Synthetic prototype — nothing is sent, saved or seen by others.</span>
        <span className={cx("short")}>Synthetic — nothing is sent.</span>
      </span>
      <span className={cx("demoMode")}>Sending: {sendMode === "fast" ? "A · fast" : "B · contextual review"}</span>
      <button type="button" className={cx("demoButton")} onClick={onOpen} aria-label="Prototype controls">
        <span className={cx("long")}>Prototype controls</span>
        <span className={cx("short")}>Controls</span>
      </button>
    </div>
  );
}

function Controls({ state, dispatch, theme, onTheme }: { readonly state: State; readonly dispatch: (action: Action) => void; readonly theme: "system" | "light" | "dark"; readonly onTheme: (t: "system" | "light" | "dark") => void }) {
  return (
    <div className={cx("controls")}>
      <fieldset className={cx("controlGroup")}>
        <legend>Sending experience</legend>
        {(
          [
            ["fast", "A · Fast human send", "Write, press Send (demo). No review step."],
            ["contextual", "B · Contextual review", "Send directly, but ask for a short review when the draft was translated, a teammate is also replying, the conversation is escalated, or a synthetic high-risk example applies."],
          ] as const
        ).map(([value, label, help]) => (
          <label key={value} className={cx("radio")}>
            <input
              type="radio"
              name="send-mode"
              checked={state.sendMode === value}
              onChange={() => {
                dispatch({ type: "sendMode", mode: value });
              }}
            />
            <span>
              <strong>{label}</strong>
              <span className={cx("muted")}>{help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className={cx("fieldLabel")}>
        Scenario
        <select
          className={cx("select")}
          value={state.scenario}
          onChange={(event) => {
            dispatch({ type: "scenario", scenario: event.target.value as Scenario });
          }}
        >
          <option value="normal">Normal</option>
          <option value="disconnected">Messenger needs reconnecting</option>
          <option value="loading">Loading</option>
          <option value="empty">No conversations yet</option>
        </select>
      </label>
      <label className={cx("fieldLabel")}>
        Theme
        <select
          className={cx("select")}
          value={theme}
          onChange={(event) => {
            onTheme(event.target.value as "system" | "light" | "dark");
          }}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <label className={cx("check")}>
        <input
          type="checkbox"
          checked={state.showFuture}
          onChange={() => {
            dispatch({ type: "toggleFuture" });
          }}
        />
        Preview future intelligence concepts <Marker kind="future">Off by default</Marker>
      </label>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          dispatch({ type: "reset", state: initialState() });
        }}
      >
        Reset synthetic data
      </Button>
      <details className={cx("legend")} open>
        <summary>What’s real and what’s simulated</summary>
        <p>
          <strong>Interactive, local only:</strong> views, search and filters, selection, browser Back/Forward, assignment, take over, Mark done / Reopen with Undo, escalation, internal notes, separate reply and note drafts per conversation (kept while the tab is open), emoji, Saved Replies, illustrative translations, Send (demo).
        </p>
        <p>
          <strong>Demo only:</strong> “Send (demo)” adds a local message marked “Demo — not sent”. Nothing reaches Instagram, Messenger or anyone else.
        </p>
        <p>
          <strong>Depends on Meta, not verified:</strong> reply windows, message requests, receipts (Messenger delivered/seen; Instagram seen), reactions, edits, unsends, attachment links and history depth. Validation is a separate gate (MESSAGES-EXP-01). Each is explained with an ⓘ where it appears.
        </p>
        <p>
          <strong>Future, off by default:</strong> intent, urgency, summaries and suggestions are hand-written illustrations; no AI ran. Labels, attachments, @mentions and copying saved replies between accounts are later gates.
        </p>
      </details>
      <details className={cx("legend")}>
        <summary>Notes for reviewers</summary>
        <p>Counts are synthetic. Real counts need the indexed work-queue read model (PD D-59); Comments finding M-2 stays open.</p>
        <p>Unread is per teammate and internal: opening a conversation clears it only for you and never sends a read receipt to the platform.</p>
        <p>Assignment and “Take over” change who handles a conversation inside Wrenkind. Meta’s Conversation Routing (which app may reply) is separate and isn’t read or changed.</p>
        <p>Translations are illustrative fixtures for a few known texts — no service or model is called.</p>
      </details>
    </div>
  );
}

function Toolbar({ filters, onFilters }: { readonly filters: Filters; readonly onFilters: (f: Filters) => void }) {
  return (
    <div className={cx("listToolbar")}>
      <label className="wk-sr-only" htmlFor="message-search">
        Search conversations
      </label>
      <input
        id="message-search"
        className={cx("input", "search")}
        type="search"
        placeholder="Search people and messages"
        value={filters.q}
        onChange={(event) => {
          onFilters({ ...filters, q: event.target.value });
        }}
      />
      <div className={cx("filterRow")}>
        <label className="wk-sr-only" htmlFor="message-account">
          Account
        </label>
        <select
          id="message-account"
          className={cx("select", "accountSelect")}
          value={filters.account}
          onChange={(event) => {
            onFilters({ ...filters, account: event.target.value });
          }}
        >
          <option value="all">All accounts</option>
          {ACCOUNTS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.platform === "instagram" ? `Instagram · ${a.handle}` : accountLabel(a)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={cx("chip", filters.unread && "chipOn")}
          aria-pressed={filters.unread}
          onClick={() => {
            onFilters({ ...filters, unread: !filters.unread });
          }}
        >
          Unread
        </button>
        <button
          type="button"
          className={cx("chip", filters.mine && "chipOn")}
          aria-pressed={filters.mine}
          onClick={() => {
            onFilters({ ...filters, mine: !filters.mine });
          }}
        >
          Mine
        </button>
      </div>
    </div>
  );
}

function ConversationList({ items, route, state, onOpen }: { readonly items: readonly Conversation[]; readonly route: Route; readonly state: State; readonly onOpen: () => void }) {
  if (state.scenario === "loading") {
    return (
      <ol className={cx("list")} aria-label="Loading conversations" aria-busy="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <li key={i} className={cx("skeleton")} aria-hidden="true">
            <span className={cx("skeletonAvatar")} />
            <span className={cx("skeletonLines")}>
              <span />
              <span />
            </span>
          </li>
        ))}
      </ol>
    );
  }
  if (items.length === 0) {
    return (
      <div className={cx("listEmpty")}>
        {state.scenario === "empty" ? (
          <>
            <p className={cx("listEmptyTitle")}>No private conversations yet</p>
            <p>New Instagram Direct and Messenger conversations appear here once Messages is turned on for a connected account. Older history may be limited by the platform.</p>
          </>
        ) : (
          <>
            <p className={cx("listEmptyTitle")}>No conversations here</p>
            <p>Nothing in {VIEW_NAMES[route.view]} matches the current search and filters.</p>
          </>
        )}
      </div>
    );
  }
  return (
    <ol className={cx("list")} aria-label={`${VIEW_NAMES[route.view]}, ${String(items.length)} conversations`}>
      {items.map((c) => (
        <Row key={c.id} conversation={c} route={route} state={state} onOpen={onOpen} />
      ))}
    </ol>
  );
}

/**
 * One row, three lines and selective emphasis: name + time (unread = bold + dot) · preview (draft wins) · one quiet
 * meta line: account, then status — a teammate replying and an escalation are shown together when both apply (one
 * never hides the other); otherwise window closed, or Done in All — and the assignee's initials at the end. The meta
 * line wraps on narrow screens rather than clipping.
 */
function Row({ conversation: c, route, state, onOpen }: { readonly conversation: Conversation; readonly route: Route; readonly state: State; readonly onOpen: () => void }) {
  const account = accountOf(c.accountId);
  const last = lastMessage(c);
  const assignee = teammate(c.assignee);
  const href = hrefOf({ view: route.view, id: c.id });
  const current = route.id === c.id;
  const unread = isUnread(c);
  const draft = state.drafts[c.id];
  const hasDraft = draft !== undefined && draft.reply.trim() !== "" && !current;
  const win = windowOf(c);
  const preview = last === undefined ? "" : last.unsent === true ? "Message unsent" : (last.text ?? (last.attachments?.[0] === undefined ? "" : `Sent an attachment · ${last.attachments[0].detail}`));
  const from = last === undefined || last.dir === "in" ? "" : last.demo === true ? "Demo: " : "You: ";
  const replying = c.presence !== null && c.presence.who !== ME && c.presence.doing === "replying" ? teammate(c.presence.who) : null;
  const activity = [
    ...(replying === null ? [] : [{ text: `${firstName(replying.name)} is replying`, tone: "human" }]),
    ...(c.escalation === null ? [] : [{ text: "Escalated", tone: "escalated" }]),
  ];
  const fallback = !win.open && c.state === "open" ? { text: "Reply window closed", tone: "warn" } : route.view === "all" && c.state === "done" ? { text: "Done", tone: "neutral" } : null;
  const statuses = activity.length > 0 ? activity : fallback === null ? [] : [fallback];
  return (
    <li className={cx("item")}>
      <a className={cx("row", current && "rowOn", unread && "rowUnread")} href={href} data-row={c.id} aria-current={current ? "page" : undefined} onClick={link(href, onOpen)}>
        <Avatar initials={c.participant.initials} />
        <span className={cx("rowMain")}>
          <span className={cx("rowTop")}>
            {unread ? <span className={cx("unreadDot")} aria-hidden="true" /> : null}
            <span className={cx("rowName")}>{c.participant.name}</span>
            {unread ? <span className="wk-sr-only">, unread</span> : null}
            <span className={cx("rowTime")}>
              <time dateTime={new Date(lastActivity(c)).toISOString()}>{shortWhen(lastActivity(c))}</time>
            </span>
          </span>
          <span className={cx("rowPreview")}>
            {hasDraft ? (
              <>
                <span className={cx("draftTag")}>Draft: </span>
                {draft.reply}
              </>
            ) : (
              `${from}${preview}`
            )}
          </span>
          <span className={cx("rowMeta")}>
            <span className={cx("rowWhere")}>
              <PlatformMark platform={account.platform} />
              <span className={cx("rowAccount")}>{accountLabel(account)}</span>
            </span>
            {c.request ? <span className={cx("rowFlag")}>· Request</span> : null}
            {statuses.map((status) => (
              <span key={status.text} className={cx("rowStatus", `rowStatus-${status.tone}`)}>
                · {status.text}
              </span>
            ))}
            {state.showFuture && c.future !== null && c.state === "open" ? <span className={cx("rowFuture")}>· {c.future.intent} (future)</span> : null}
            {assignee === null ? null : (
              <span className={cx("rowAssignee")} title={`Assigned to ${assignee.name}`}>
                <Avatar initials={assignee.initials} size="xs" tone="team" />
                <span className="wk-sr-only">Assigned to {c.assignee === ME ? "you" : assignee.name}</span>
              </span>
            )}
          </span>
        </span>
      </a>
    </li>
  );
}
