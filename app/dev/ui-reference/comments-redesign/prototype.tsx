"use client";
/**
 * Comments experience redesign (Steps 7B-17V and 7B-17V-UX) — DEVELOPMENT ONLY, synthetic data, local state only.
 * The proposed Comments page as one interactive prototype: the conversation as the unit of reading, the comment as the
 * unit of action (Reply · Hide · Labels · More), platform-specific menus (Facebook: Like and Block author; Instagram:
 * neither), deliberate confirmation before Delete and Block, a private-reply reference, exact times and post context
 * on demand, the brand's account named by its verified name when the read model has it, manual labels created and
 * assigned from a comment, and a label filter in the Comments sidebar.
 *
 * Every Facebook and Instagram action here is a SIMULATION in this component's React state: nothing reaches a server
 * action, a pipeline, a database, browser storage, the network or a platform, and everything disappears on reload. A
 * simulated operation stays Sending until a person presses one of the prototype's answers (Confirmed, Failed, No
 * answer, Stopped) — no timer, no request. The rules it applies are the pure functions in ./model.ts.
 *
 * Step 7B-17V-UX2 (PO feedback): three visible actions per comment (Reply · Hide/Unhide · More, labels inside More),
 * no repeated label summaries or per-conversation review notices, the conversation's time shown only while it is
 * collapsed, a compact preview of the source post (shape and words only — no media is drawn), and a second layout to
 * compare: two panels (list + active conversation) next to the expandable list.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Logo } from "@/ui/brand/logo";
import { Icon } from "@/ui/icons/icon";
import { OriginMark, StatePill } from "@/ui/primitives";
import { LocalTime, LocalTimeStamp } from "@/ui/time/local-time";
import { ACCOUNTS, SEED_ASSIGNMENTS, SEED_LABELS, WORKSPACE, type Account, type Comment, type Conversation, type SentReply } from "./fixtures";
import {
  CAPABILITIES,
  EMPTY_SIM,
  PRIVATE_REPLY_DAYS,
  PROTOTYPE_TEXT,
  ROLES,
  THEME_ATTRIBUTE,
  THEME_CHOICES,
  abilitiesOf,
  accountOf,
  answerOp,
  assessmentOf,
  authorKey,
  availabilityOf,
  commenterName,
  contextNotice,
  conversationLabels,
  countText,
  createLabel,
  findLabelByName,
  fullUtc,
  labelCounts,
  labelsOn,
  latestOf,
  metaDocText,
  normalizeName,
  opAvailability,
  opSentence,
  opStatusText,
  opStatusTone,
  ORDERED,
  ownIdentity,
  platformName,
  positionOf,
  postOf,
  previewOf,
  privateReplyClosingSoon,
  privateReplyWindow,
  problemText,
  replyTargetOf,
  requesterOf,
  retryable,
  setAssigned,
  shortUtc,
  sortedLabels,
  sourceTag,
  sourceText,
  startOp,
  threadOf,
  valueOf,
  viewOf,
  visibleConversations,
  withoutKey,
  wrenkindText,
  type ActionId,
  type ActionsMode,
  type Availability,
  type LabelState,
  type Mode,
  type OpAnswer,
  type OpKind,
  type Operation,
  type ReadModel,
  type Role,
  type SimState,
  type ThemeChoice,
  type ThreadEntry,
} from "./model";
import styles from "./prototype.module.css";

const s = (...names: readonly (string | false | undefined)[]): string =>
  names
    .filter((name): name is string => typeof name === "string" && name !== "")
    .map((name) => valueOf(styles, name) ?? "")
    .join(" ");

const INITIAL_LABELS: LabelState = { labels: SEED_LABELS, assignments: SEED_ASSIGNMENTS, nextId: 1 };

type ConfirmAction = "delete" | "block" | "unblock" | "hide";
/** The two layouts the PO compares: two panels (list + active conversation; the review default) and the expandable list. */
export type Layout = "expand" | "split";
type PanelKind = "labels" | "more" | "private" | "confirm" | "reason";
interface PanelState {
  readonly commentId: string;
  readonly kind: PanelKind;
  readonly confirm?: ConfirmAction;
  /** "reason": the unavailable action whose reason is shown, and the reason. */
  readonly reason?: string;
}
type Panel = PanelState | undefined;

/** Everything a conversation and its comments read and do, passed down as one value. */
interface Bench {
  readonly role: Role;
  readonly mode: Mode;
  readonly actions: ActionsMode;
  readonly readModel: ReadModel;
  readonly assess: boolean;
  readonly allHealthy: boolean;
  readonly labels: LabelState;
  readonly sim: SimState;
  readonly panel: Panel;
  readonly details: string | undefined;
  readonly replyTarget: string | undefined;
  readonly drafts: Readonly<Record<string, string>>;
  readonly privateDrafts: Readonly<Record<string, string>>;
  readonly onPanel: (panel: Panel) => void;
  readonly onDetails: (id: string | undefined) => void;
  readonly onReply: (conversation: Conversation, comment: Comment) => void;
  readonly onReplyClose: () => void;
  readonly onDraft: (commentId: string, text: string) => void;
  readonly onPrivateDraft: (commentId: string, text: string) => void;
  readonly onAssign: (commentId: string, owner: string, labelId: string, assigned: boolean) => void;
  readonly onCreate: (name: string, commentId: string | undefined, owner: string | undefined) => string | undefined;
  /** Starts a simulated operation after revalidating it against the current state; false when it was refused. */
  readonly onStart: (conversation: Conversation, comment: Comment, kind: OpKind, text?: string) => boolean;
  readonly onAnswer: (opId: string, answer: OpAnswer) => void;
}

const healthOf = (account: Account | undefined, allHealthy: boolean): Account["health"] => (allHealthy || account === undefined ? "healthy" : account.health);

/* ───────────── time ───────────── */

/** A visible short time with the exact reading for assistive technology (UTC on the server, local in the browser). */
function Stamp({ iso, previous }: { readonly iso: string; readonly previous?: string | undefined }) {
  return <LocalTimeStamp iso={iso} label={shortUtc(iso, previous)} full={fullUtc(iso)} {...(previous === undefined ? {} : { previous })} className={s("time")} />;
}

const Exact = ({ iso }: { readonly iso: string }) => (
  <time dateTime={iso}>
    <LocalTime iso={iso} form="full" fallback={fullUtc(iso)} />
  </time>
);

/* ───────────── small pieces ───────────── */

function Chevron({ open }: { readonly open: boolean }) {
  return (
    <svg className={s("chevron", open && "chevronOpen")} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Recognizable action glyphs the kit does not have yet (an eye, a bin, a "no" sign, a thumb, an envelope), drawn in
 * the kit's 16px / 1.5 stroke so they sit with it. Prototype-only: a kit addition would be a brand decision.
 */
type GlyphName = "eye" | "eyeOff" | "trash" | "ban" | "thumb" | "envelope" | "tag" | "collapse";
const GLYPH_PATHS: { readonly [G in GlyphName]: readonly string[] } = {
  eye: ["M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z", "M8 10a2 2 0 100-4 2 2 0 000 4z"],
  eyeOff: ["M2 2l12 12", "M6.6 3.7A6.8 6.8 0 018 3.5c4.1 0 6.5 4.5 6.5 4.5a11 11 0 01-1.9 2.4", "M4.2 4.9C2.4 6.1 1.5 8 1.5 8s2.4 4.5 6.5 4.5c1.1 0 2.1-.3 3-.8", "M6.6 6.6a2 2 0 002.8 2.8"],
  trash: ["M2.5 4.5h11", "M6 4.5V3a1 1 0 011-1h2a1 1 0 011 1v1.5", "M3.8 4.5l.7 9a1 1 0 001 .9h5a1 1 0 001-.9l.7-9", "M6.8 7v5M9.2 7v5"],
  ban: ["M8 14.5a6.5 6.5 0 100-13 6.5 6.5 0 000 13z", "M3.4 3.4l9.2 9.2"],
  thumb: ["M5 7l2.5-5a1.6 1.6 0 011.6 1.9L8.6 6.5H13a1.3 1.3 0 011.3 1.5l-.9 5.2a1.3 1.3 0 01-1.3 1.1H5z", "M5 7H2.5v7.3H5"],
  envelope: ["M2 3.5h12v9H2z", "M2 4l6 4.5L14 4"],
  tag: ["M2 2.5h5.3l6.2 6.2-4.8 4.8-6.2-6.2V2.5z", "M5 5.3h.01"],
  collapse: ["M4 10l4-4 4 4"],
};

function Glyph({ name }: { readonly name: GlyphName }) {
  return (
    <svg className={s("glyph")} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {(valueOf(GLYPH_PATHS, name) ?? []).map((d) => (
        <path key={d} d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

/** The one mark every simulated thing carries: dashed, never a product state of its own. */
function SimBadge({ children = "Simulated" }: { readonly children?: string }) {
  return <span className={s("simBadge")}>{children}</span>;
}

/** A state a simulation produced on a comment ("Hidden", "Author blocked"…), drawn dashed so it never reads as real. */
function SimMarker({ icon, children }: { readonly icon: "estado-lock" | "decision-approve" | "decision-reject" | "util-close"; readonly children: string }) {
  return (
    <span className={s("simMarker")}>
      <Icon name={icon} size={16} />
      <span>{children}</span>
      <span className={s("simMarkerTag")}> (simulated)</span>
    </span>
  );
}

function Chips({ ids, state, max, onRemove, owner }: { readonly ids: readonly string[]; readonly state: LabelState; readonly max: number; readonly onRemove?: ((labelId: string) => void) | undefined; readonly owner?: string }) {
  const names = ids.map((id) => state.labels.find((label) => label.id === id)).filter((label) => label !== undefined);
  if (names.length === 0) return null;
  const shown = names.slice(0, max);
  const more = names.length - shown.length;
  return (
    <ul className={s("chips")} aria-label="Labels">
      {shown.map((label) => (
        <li key={label.id} className={s("chip")}>
          <Icon name="util-tag" size={16} />
          <span>{label.name}</span>
          {onRemove === undefined ? null : (
            <button type="button" className={s("chipRemove")} onClick={() => { onRemove(label.id); }} aria-label={`Remove label ${label.name}${owner === undefined ? "" : ` from ${owner}`}`}>
              <Icon name="util-close" size={16} />
            </button>
          )}
        </li>
      ))}
      {more > 0 ? (
        <li className={s("chip", "chipMore")}>
          <span aria-hidden="true">+{more}</span>
          <span className="wk-sr-only">{`and ${String(more)} more: ${names
            .slice(max)
            .map((label) => label.name)
            .join(", ")}`}</span>
        </li>
      ) : null}
    </ul>
  );
}

/**
 * The labels of a conversation inside its row header (a button): phrasing content only, never interactive, and read
 * as one sentence that says where they are — on comments of the conversation, not on the conversation itself.
 */
function RowChips({ ids, state, max }: { readonly ids: readonly string[]; readonly state: LabelState; readonly max: number }) {
  const names = ids.map((id) => state.labels.find((label) => label.id === id)?.name).filter((name) => name !== undefined);
  if (names.length === 0) return null;
  const shown = names.slice(0, max);
  const more = names.length - shown.length;
  return (
    <span className={s("chips", "rowChips")} data-row-chips="">
      <span className="wk-sr-only">{`Labels on comments in this conversation: ${names.join(", ")}.`}</span>
      <Icon name="util-tag" size={16} />
      {shown.map((name) => (
        <span key={name} className={s("chip")} aria-hidden="true">
          {name}
        </span>
      ))}
      {more > 0 ? (
        <span className={s("chip", "chipMore")} aria-hidden="true">
          +{more}
        </span>
      ) : null}
    </span>
  );
}

/* ───────────── the page ───────────── */

export function CommentsRedesign({ initialLayout = "split" }: { readonly initialLayout?: Layout }) {
  const [role, setRole] = useState<Role>("manager");
  const [mode, setMode] = useState<Mode>("standard");
  const [actions, setActions] = useState<ActionsMode>("simulate");
  const [layout, setLayout] = useState<Layout>(initialLayout);
  const [theme, setTheme] = useState<ThemeChoice>("system");
  const shellRef = useRef<HTMLDivElement>(null);
  const [readModel, setReadModel] = useState<ReadModel>("planned");
  const [assess, setAssess] = useState(false);
  const [allHealthy, setAllHealthy] = useState(false);
  const [labels, setLabels] = useState<LabelState>(INITIAL_LABELS);
  const [sim, setSim] = useState<SimState>(EMPTY_SIM);
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const [panel, setPanel] = useState<Panel>(undefined);
  const [details, setDetails] = useState<string | undefined>(undefined);
  const [replyTarget, setReplyTarget] = useState<string | undefined>(undefined);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [privateDrafts, setPrivateDrafts] = useState<Readonly<Record<string, string>>>({});
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  /**
   * Where focus goes after the open conversation changed: the row in the list (expandable list, Escape), or — in two
   * panels — the same Previous / Next in the new conversation (its title when that button is now disabled), so a person
   * moving through conversations stays in the panel they are reading (audit M-1).
   */
  const [focusTarget, setFocusTarget] = useState<{ readonly id: string; readonly scroll: boolean; readonly place: "row" | "pane"; readonly nav?: "previous" | "next" } | undefined>(undefined);
  const headers = useRef(new Map<string, HTMLButtonElement>());
  const titleRef = useRef<HTMLHeadingElement>(null);
  const matrixRef = useRef<HTMLDetailsElement>(null);
  const abilities = abilitiesOf(role);

  const list = useMemo(() => visibleConversations(labels, filter), [labels, filter]);
  const counts = useMemo(() => labelCounts(labels), [labels]);
  const activeFilter = filter === undefined ? undefined : labels.labels.find((label) => label.id === filter);

  // Moving focus after a render (each request is a new object, so the effect runs once per request) that changed which conversation is open (Previous / Next / Escape / filter).
  useEffect(() => {
    if (focusTarget === undefined) return;
    if (focusTarget.place === "pane") {
      const pane = shellRef.current?.querySelector<HTMLElement>(`#focus-${focusTarget.id}`);
      const nav = focusTarget.nav === undefined ? null : (pane?.querySelector<HTMLButtonElement>(`[data-nav="${focusTarget.nav}"]:not(:disabled)`) ?? null);
      const heading = pane?.querySelector<HTMLElement>(`#pane-${focusTarget.id}`) ?? null;
      (nav ?? heading)?.focus({ preventScroll: true });
      if (focusTarget.scroll && typeof heading?.scrollIntoView === "function") heading.scrollIntoView({ block: "nearest" });
      return;
    }
    const button = headers.current.get(focusTarget.id);
    button?.focus({ preventScroll: true });
    if (focusTarget.scroll && typeof button?.scrollIntoView === "function") button.scrollIntoView({ block: "start" });
  }, [focusTarget]);

  // Theme: the product's override attribute on <html>, set only while a person has chosen Light or Dark here, and put
  // back as it was when the choice returns to System or the prototype closes. Nothing is stored; the first render is
  // the server's (no attribute), so there is no hydration mismatch and no flash until someone chooses.
  useEffect(() => {
    const root = shellRef.current?.ownerDocument.documentElement;
    if (root === undefined || theme === "system") return;
    const before = root.getAttribute(THEME_ATTRIBUTE);
    root.setAttribute(THEME_ATTRIBUTE, theme);
    return () => {
      if (before === null) root.removeAttribute(THEME_ATTRIBUTE);
      else root.setAttribute(THEME_ATTRIBUTE, before);
    };
  }, [theme]);

  const announce = (message: string): void => { setAnnouncement(message); };

  const closePanels = (): void => {
    setPanel(undefined);
    setDetails(undefined);
  };

  const toggle = (id: string): void => {
    closePanels();
    // Two panels: a row selects its conversation (selecting it again keeps it); the list: a row opens and closes.
    setOpenId((current) => (layout === "split" ? id : current === id ? undefined : id));
  };

  const move = (id: string, nav?: "previous" | "next"): void => {
    closePanels();
    setOpenId(id);
    setFocusTarget(layout === "split" ? { id, scroll: true, place: "pane", ...(nav === undefined ? {} : { nav }) } : { id, scroll: true, place: "row" });
  };

  const collapse = (id: string): void => {
    closePanels();
    setOpenId(undefined);
    setFocusTarget({ id, scroll: false, place: "row" });
  };

  /**
   * Escape in two panels keeps the selection (audit: Escape no longer empties the panel): focus returns to the selected
   * row, or — where the list is not shown (one panel at a time) — stays on the conversation's title.
   */
  const leavePane = (id: string): void => {
    const row = headers.current.get(id);
    row?.focus();
    if (row === undefined || row.ownerDocument.activeElement !== row) shellRef.current?.querySelector<HTMLElement>(`#pane-${id}`)?.focus();
  };

  const chooseFilter = (next: string | undefined): void => {
    setFilter(next);
    setPanel(undefined);
    const shown = visibleConversations(labels, next);
    // The open conversation stays open when the filter still lists it; otherwise the list starts closed.
    if (openId !== undefined && !shown.some((conversation) => conversation.id === openId)) setOpenId(undefined);
    const name = next === undefined ? "All comments" : labels.labels.find((label) => label.id === next)?.name;
    announce(`${name ?? "All comments"}: ${String(shown.length)} conversations`);
  };

  /**
   * Assign or remove a label. A refused change says so (audit: no false success). When a label filter is on and the
   * change takes the open conversation out of the filtered list, the selection is cleared and the reason announced
   * (audit M-4) — never a stale open conversation or an unexplained empty panel.
   */
  const assign = (commentId: string, owner: string, labelId: string, assigned: boolean): boolean => {
    const name = labels.labels.find((label) => label.id === labelId)?.name ?? "";
    const next = setAssigned(labels, role, commentId, labelId, assigned);
    if (next === labels) {
      announce(abilitiesOf(role).assign ? `No change: ${owner} ${assigned ? "already has" : "doesn't have"} the label ${name}.` : `Not changed: your role can't change labels.`);
      return false;
    }
    setLabels(next);
    const base = assigned ? `Label ${name} added to ${owner}` : `Label ${name} removed from ${owner}`;
    const filterName = filter === undefined ? undefined : next.labels.find((label) => label.id === filter)?.name;
    if (filterName !== undefined && openId !== undefined && !visibleConversations(next, filter).some((conversation) => conversation.id === openId)) {
      setOpenId(undefined);
      setPanel(undefined);
      setDetails(undefined);
      announce(`${base}. The conversation no longer has a comment labelled ${filterName}, so it left this list.`);
      titleRef.current?.focus();
      return true;
    }
    announce(base);
    return true;
  };

  const create = (raw: string, commentId: string | undefined, owner: string | undefined): string | undefined => {
    const result = createLabel(labels, role, raw, commentId);
    if (!result.ok) return result.problem === "not_allowed" ? "Only owners, admins and managers can create labels." : problemText(result.problem);
    setLabels(result.state);
    announce(owner === undefined ? `Label ${result.label.name} created` : `Label ${result.label.name} created and added to ${owner}`);
    return undefined;
  };

  /** Reply: opens (or closes) the composer at this comment. An Instagram reply to a reply starts by naming that person. */
  const reply = (conversation: Conversation, comment: Comment): void => {
    if (replyTarget === comment.id) {
      setReplyTarget(undefined);
      return;
    }
    setPanel(undefined);
    setReplyTarget(comment.id);
    const account = accountOf(conversation.accountId);
    const target = account === undefined ? undefined : replyTargetOf(conversation, comment, account.platform);
    if (target?.answering !== undefined && (valueOf(drafts, comment.id) ?? "") === "") setDrafts((current) => ({ ...current, [comment.id]: `@${target.answering ?? ""} ` }));
  };

  const start = (conversation: Conversation, comment: Comment, kind: OpKind, text?: string): boolean => {
    const account = accountOf(conversation.accountId);
    if (account === undefined) return false;
    // Revalidated now, from the current role, mode, actions setting, connection and comment state — whatever panel or
    // button asked for it (audit H-1). Monitor-only stays strictly non-mutating, in simulation too.
    const check = opAvailability({ role, mode, actions, accountHealth: healthOf(account, allHealthy), conversation, comment, sim }, kind);
    if (check.kind !== "available") {
      setPanel(undefined);
      announce(check.kind === "unavailable" ? `Not done: ${check.reason}` : "Not done: this action isn't available to you.");
      return false;
    }
    const target = kind === "reply" ? replyTargetOf(conversation, comment, account.platform) : { commentId: comment.id };
    const author = kind === "block" || kind === "unblock" ? authorKey(account.id, comment) : undefined;
    const result = startOp(sim, {
      kind,
      conversationId: conversation.id,
      commentId: target.commentId,
      ...(text === undefined ? {} : { text }),
      ...(target.answering === undefined ? {} : { answering: target.answering }),
      ...(author === undefined ? {} : { author }),
    });
    setSim(result.sim);
    setPanel(undefined);
    const op = result.sim.ops.find((item) => item.id === result.id);
    if (op !== undefined) announce(opSentence(op, platformName(account)));
    return true;
  };

  const answer = (opId: string, value: OpAnswer): void => {
    const next = answerOp(sim, opId, value);
    setSim(next);
    const op = next.ops.find((item) => item.id === opId);
    const account = op === undefined ? undefined : accountOf(ORDERED.find((conversation) => conversation.id === op.conversationId)?.accountId ?? "");
    if (op !== undefined) announce(`${opStatusText(op.status)}. ${opSentence(op, account === undefined ? "the platform" : platformName(account))}`);
  };

  const reset = (): void => {
    setLabels(INITIAL_LABELS);
    setSim(EMPTY_SIM);
    setFilter(undefined);
    setOpenId(undefined);
    closePanels();
    setReplyTarget(undefined);
    setDrafts({});
    setPrivateDrafts({});
    announce("Prototype data reset: labels, simulated actions, drafts, filter and selection. Controls unchanged.");
  };

  const bench: Bench = {
    role,
    mode,
    actions,
    readModel,
    assess,
    allHealthy,
    labels,
    sim,
    panel,
    details,
    replyTarget,
    drafts,
    privateDrafts,
    onPanel: setPanel,
    onDetails: setDetails,
    onReply: reply,
    onReplyClose: () => { setReplyTarget(undefined); },
    onDraft: (commentId, text) => { setDrafts((current) => (text === "" ? withoutKey(current, commentId) : { ...current, [commentId]: text })); },
    onPrivateDraft: (commentId, text) => { setPrivateDrafts((current) => (text === "" ? withoutKey(current, commentId) : { ...current, [commentId]: text })); },
    onAssign: assign,
    onCreate: create,
    onStart: start,
    onAnswer: answer,
  };

  const title = activeFilter === undefined ? "All comments" : activeFilter.name;

  return (
    <div ref={shellRef} className={s("shell")}>
      <a href="#comments-main" className={s("skip")}>
        Skip to comments
      </a>
      <header className={s("rail")}>
        <nav aria-label="Main navigation">
          <ul className={s("railList")}>
            <li>
              <a href="#comments-main" className={s("railItem")} aria-current="page">
                <Icon name="nav-inbox" size={20} />
                <span>Comments</span>
              </a>
            </li>
            <li>
              <span className={s("railItem", "railItemQuiet")} title="Not part of this prototype">
                <Icon name="nav-settings" size={20} />
                <span>Settings</span>
              </span>
            </li>
          </ul>
        </nav>
      </header>

      {abilities.view ? (
        <Sidebar labels={labels} counts={counts} filter={filter} total={ORDERED.length} canCreate={abilities.create} onFilter={chooseFilter} onCreate={(name) => create(name, undefined, undefined)} />
      ) : (
        <aside className={s("sidebar")} aria-label="Workspace">
          <WorkspaceBlock />
        </aside>
      )}

      <main id="comments-main" className={s("main")} tabIndex={-1}>
        <PrototypeBar
          role={role}
          mode={mode}
          actions={actions}
          layout={layout}
          theme={theme}
          readModel={readModel}
          assess={assess}
          allHealthy={allHealthy}
          matrixOpen={matrixOpen}
          matrixRef={matrixRef}
          onRole={setRole}
          onMode={setMode}
          onActions={setActions}
          onTheme={setTheme}
          onLayout={(next) => {
            setLayout(next);
            closePanels();
          }}
          onReadModel={setReadModel}
          onAssess={setAssess}
          onAllHealthy={setAllHealthy}
          onMatrix={setMatrixOpen}
          onReset={reset}
        />
        <p className="wk-sr-only" role="status" aria-live="polite">
          {announcement}
        </p>

        {!abilities.view ? (
          <section className={s("denied")} aria-labelledby="denied-title">
            <h1 id="denied-title" className={s("title")}>
              Comments aren&apos;t available to you
            </h1>
            <p className={s("muted")}>Client guests see Insights and Reports only. Nothing from this workspace&apos;s comments is shown.</p>
          </section>
        ) : (
          <>
            <header className={s("listHeader")}>
              <div className={s("listTitleRow")}>
                <h1 ref={titleRef} className={s("title")} tabIndex={-1}>
                  {title}
                </h1>
                <Coverage allHealthy={allHealthy} />
              </div>
              <p className={s("muted", "listMeta")}>
                {`${String(list.length)} ${list.length === 1 ? "conversation" : "conversations"} · Newest activity first`}
              </p>
              {/* Said once for the whole list, not in every conversation. */}
              <p className={s("muted", "small", "assessLine")}>{assess ? "Assessments shown are synthetic examples: Wrenkind hasn't assessed these comments." : "Automatic assessment isn't on yet: comments aren't classified or prioritized."}</p>
              <ViewPicker labels={labels} counts={counts} filter={filter} total={ORDERED.length} onFilter={chooseFilter} />
              {activeFilter === undefined ? null : (
                <p className={s("filterLine")}>
                  <span className={s("filterChip")}>
                    <span>Label: {activeFilter.name}</span>
                    <button type="button" className={s("chipRemove")} onClick={() => { chooseFilter(undefined); }} aria-label={`Clear the label filter ${activeFilter.name}`}>
                      <Icon name="util-close" size={16} />
                    </button>
                  </span>
                </p>
              )}
            </header>

            {list.length === 0 ? (
              <p className={s("empty")}>No conversation has a comment with this label.</p>
            ) : layout === "expand" ? (
              <ul className={s("list")} aria-label={title}>
                {list.map((conversation, index) => (
                  <Row
                    key={conversation.id}
                    conversation={conversation}
                    previousLatest={index === 0 ? undefined : latestOf(list.at(index - 1) as Conversation)}
                    open={conversation.id === openId}
                    selectMode={false}
                    labels={labels}
                    sim={sim}
                    readModel={readModel}
                    register={(element) => {
                      if (element === null) headers.current.delete(conversation.id);
                      else headers.current.set(conversation.id, element);
                    }}
                    onToggle={() => { toggle(conversation.id); }}
                  >
                    {conversation.id === openId ? <Focus conversation={conversation} list={list} bench={bench} onMove={move} onCollapse={() => { collapse(conversation.id); }} /> : null}
                  </Row>
                ))}
              </ul>
            ) : (
              <SplitView
                list={list}
                title={title}
                openId={openId}
                bench={bench}
                register={(id, element) => {
                  if (element === null) headers.current.delete(id);
                  else headers.current.set(id, element);
                }}
                onSelect={toggle}
                onMove={move}
                onBack={(id) => { collapse(id); }}
                onEscape={leavePane}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

/* ───────────── sidebar and view picker ───────────── */

function WorkspaceBlock() {
  return (
    <>
      <div className={s("brand")}>
        <Logo variant="wordmark" title="wrenkind" />
      </div>
      <div className={s("workspace")}>
        <p className={s("eyebrow")}>Workspace</p>
        <p className={s("workspaceName")}>{WORKSPACE.name}</p>
        <p className={s("muted", "small")}>{WORKSPACE.organization}</p>
      </div>
    </>
  );
}

function Sidebar({ labels, counts, filter, total, canCreate, onFilter, onCreate }: {
  readonly labels: LabelState;
  readonly counts: Readonly<Record<string, number>>;
  readonly filter: string | undefined;
  readonly total: number;
  readonly canCreate: boolean;
  readonly onFilter: (id: string | undefined) => void;
  readonly onCreate: (name: string) => string | undefined;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const fieldId = useId();
  const submit = (): void => {
    const result = onCreate(name);
    setProblem(result);
    if (result === undefined) {
      setName("");
      setCreating(false);
    }
  };
  return (
    <aside className={s("sidebar")} aria-label="Workspace">
      <WorkspaceBlock />
      {/* The rail already says "Comments": the sidebar lists the views of Comments without repeating the module name. */}
      <nav className={s("sideNav")} aria-label="Comments views">
        <ul className={s("sideList")}>
          <li>
            <button type="button" className={s("sideItem")} aria-current={filter === undefined ? "page" : undefined} onClick={() => { onFilter(undefined); }}>
              <span>All comments</span>
              <span className={s("count")}>{total}</span>
            </button>
          </li>
        </ul>
        <details className={s("sideGroup")} open>
          <summary className={s("sideHeading")}>Labels</summary>
          {labels.labels.length === 0 ? <p className={s("muted", "small", "sideEmpty")}>No labels yet.</p> : null}
          <ul className={s("sideList")}>
            {sortedLabels(labels.labels).map((label) => (
              <li key={label.id}>
                <button type="button" className={s("sideItem")} aria-current={filter === label.id ? "page" : undefined} onClick={() => { onFilter(filter === label.id ? undefined : label.id); }}>
                  <span className={s("sideItemName")}>{label.name}</span>
                  <span className={s("count")}>{countText(counts, label.id)}</span>
                </button>
              </li>
            ))}
          </ul>
          {canCreate ? (
            creating ? (
              <form
                className={s("sideCreate")}
                onSubmit={(event) => {
                  event.preventDefault();
                  submit();
                }}
              >
                <label htmlFor={fieldId} className={s("small")}>
                  New label
                </label>
                <input id={fieldId} className={s("input")} value={name} maxLength={80} autoFocus onChange={(event) => { setName(event.target.value); }} onKeyDown={(event) => { if (event.key === "Escape") setCreating(false); }} aria-describedby={problem === undefined ? undefined : `${fieldId}-problem`} />
                {problem === undefined ? null : (
                  <p id={`${fieldId}-problem`} className={s("problem")} role="alert">
                    {problem}
                  </p>
                )}
                <div className={s("inlineActions")}>
                  <button type="submit" className={s("btn", "btnPrimary")}>
                    Create
                  </button>
                  <button type="button" className={s("btn")} onClick={() => { setCreating(false); }}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button type="button" className={s("sideItem", "sideAdd")} onClick={() => { setCreating(true); }}>
                <Icon name="util-plus" size={16} />
                <span>New label</span>
              </button>
            )
          ) : null}
        </details>
      </nav>
    </aside>
  );
}

/** Below 1024 px the sidebar is gone: the same views in one native select above the list. */
function ViewPicker({ labels, counts, filter, total, onFilter }: { readonly labels: LabelState; readonly counts: Readonly<Record<string, number>>; readonly filter: string | undefined; readonly total: number; readonly onFilter: (id: string | undefined) => void }) {
  const id = useId();
  return (
    <div className={s("viewPicker")}>
      <label htmlFor={id} className={s("small", "muted")}>
        View
      </label>
      <select id={id} className={s("select")} value={filter ?? ""} onChange={(event) => { onFilter(event.target.value === "" ? undefined : event.target.value); }}>
        <option value="">{`All comments (${String(total)})`}</option>
        {sortedLabels(labels.labels).map((label) => (
          <option key={label.id} value={label.id}>{`Label: ${label.name} (${countText(counts, label.id)})`}</option>
        ))}
      </select>
    </div>
  );
}

/** What has been read: one quiet line; the per-account record on demand; a warning only where an account is partial or needs attention. */
function Coverage({ allHealthy }: { readonly allHealthy: boolean }) {
  const partial = ACCOUNTS.filter((account) => account.coverage === "partial");
  const attention = ACCOUNTS.filter((account) => healthOf(account, allHealthy) === "needs_attention");
  const notes = [partial.length > 0 ? `${String(partial.length)} account partly read` : undefined, attention.length > 0 ? `${String(attention.length)} needs reconnecting` : undefined].filter((note) => note !== undefined);
  return (
    <details className={s("coverage")}>
      <summary className={s("coverageSummary")}>
        {notes.length > 0 ? <Icon name="estado-alert" size={16} /> : null}
        <span>
          Read through <Stamp iso="2026-11-17T14:52:00Z" />
          {notes.length > 0 ? ` · ${notes.join(" · ")}` : ""}
        </span>
      </summary>
      <div className={s("coverageBody")}>
        <ul className={s("plainList")}>
          {ACCOUNTS.map((account) => (
            <li key={account.id} className={s("coverageRow")}>
              <OriginMark platform={account.platform} name={platformName(account)} />
              <span>{account.verifiedName ?? `Your ${platformName(account)} account`}</span>
              <span className={s("muted")}>
                {account.coverage === "complete" ? "Comments and replies read" : "Comments partly read — older comments may be missing"}
                {healthOf(account, allHealthy) === "needs_attention" ? " · Connection needs attention: reconnect in Settings › Connections" : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

/* ───────────── a row of the list (the Focus disclosure) ───────────── */

function Row({ conversation, previousLatest, open, selectMode, labels, sim, readModel, register, onToggle, children }: {
  readonly conversation: Conversation;
  readonly previousLatest: string | undefined;
  readonly open: boolean;
  /** Two panels: the row selects the conversation shown beside the list instead of opening under itself. */
  readonly selectMode: boolean;
  readonly labels: LabelState;
  readonly sim: SimState;
  readonly readModel: ReadModel;
  readonly register: (element: HTMLButtonElement | null) => void;
  readonly onToggle: () => void;
  readonly children?: ReactNode;
}) {
  const anchor = conversation.comments[0] as Comment;
  const account = accountOf(conversation.accountId);
  const post = postOf(conversation.postId);
  const tag = sourceTag(post);
  const accountName = account === undefined ? "Unknown account" : readModel === "planned" && account.verifiedName !== null ? account.verifiedName : platformName(account);
  const repliesSent = conversation.sent.length + conversation.comments.filter((comment) => comment.author.kind === "own").length + sim.ops.filter((op) => op.kind === "reply" && op.conversationId === conversation.id && op.status === "sent").length;
  const ids = conversationLabels(labels, conversation);
  const view = viewOf(sim, conversation.accountId, anchor);
  const panelId = `focus-${conversation.id}`;
  const headerId = `row-${conversation.id}`;
  const excerpt = view.presence === "removed" ? "Removed from the platform" : view.presence === "deleted" ? "Deleted (simulated)" : anchor.text;
  return (
    <li className={s("row", open && !selectMode && "rowOpen", open && selectMode && "rowSelected")}>
      <div className={s("rowHead", open && !selectMode && "rowHeadOpen")}>
        <h2 className={s("rowHeading")}>
          <button
            ref={register}
            id={headerId}
            type="button"
            className={s("rowButton")}
            aria-expanded={selectMode ? undefined : open}
            aria-current={selectMode && open ? "true" : undefined}
            aria-controls={open ? panelId : undefined}
            onClick={onToggle}
          >
            <span className={s("rowTop")}>
              {account === undefined ? null : <OriginMark platform={account.platform} name={platformName(account)} />}
              <span className={s("rowAuthor")}>{anchor.author.kind === "own" ? "Your account" : commenterName(anchor)}</span>
              <span className={s("rowAccount")}>{`on ${accountName}`}</span>
              {tag === undefined ? null : <span className={s("tag")}>{tag}</span>}
              {/* The conversation's latest activity: shown while collapsed; once open, every comment carries its own time. */}
              <span className={s("rowTime")} title="Latest activity in this conversation">
                <span className="wk-sr-only">Latest activity </span>
                <Stamp iso={latestOf(conversation)} previous={previousLatest} />
              </span>
            </span>
            <span className={s("rowExcerpt", view.presence !== "present" && "muted")}>{excerpt}</span>
            <span className={s("rowMeta")}>
              {conversation.comments.length > 1 ? (
                <span className={s("metaItem")}>
                  <Icon name="conv-thread" size={16} />
                  {`${String(conversation.comments.length)} comments`}
                </span>
              ) : null}
              {repliesSent > 0 ? (
                <span className={s("metaItem")}>
                  <Icon name="conv-reply" size={16} />
                  {repliesSent === 1 ? "You replied" : `You replied ${String(repliesSent)}×`}
                </span>
              ) : null}
              {view.presence === "hidden" ? (
                <span className={s("metaItem")}>
                  <Icon name="estado-lock" size={16} />
                  {view.simulated ? "Hidden (simulated)" : "Hidden"}
                </span>
              ) : null}
              <RowChips ids={ids} state={labels} max={2} />
            </span>
            {selectMode ? null : <Chevron open={open} />}
            <span className="wk-sr-only">{selectMode ? (open ? ", shown beside the list" : ", show beside the list") : open ? ", collapse conversation" : ", open conversation"}</span>
          </button>
        </h2>
      </div>
      {open && !selectMode ? (
        <section id={panelId} className={s("focus")} aria-labelledby={headerId}>
          {children}
        </section>
      ) : null}
    </li>
  );
}

/* ───────────── the open conversation ───────────── */

const SURFACE_TEXT = { feed: "Feed", live: "Live video — comments can only be managed in the Instagram app", story_ad: "Story ad — comments can only be managed in the Instagram app", dark_post: "Ad that never ran as a Page post" } as const;

/**
 * The source post as a compact preview: a tile in the post's shape with its kind (no media is drawn — none was
 * retrieved and none is invented), its first words, its source said explicitly, and any context that limits what can
 * be done. Everything else (account, owner, exact source, comments read) on demand under "Details".
 */
function SourceCard({ conversation, identity }: { readonly conversation: Conversation; readonly identity: ReturnType<typeof ownIdentity> | undefined }) {
  const account = accountOf(conversation.accountId);
  const post = postOf(conversation.postId);
  const preview = previewOf(post);
  const sourceSurface = post === undefined ? undefined : valueOf(SURFACE_TEXT, post.surface);
  return (
    <details className={s("postCard")}>
      <summary className={s("postSummary")}>
        <span className={s("tile", preview === undefined ? "tileSquare" : preview.shape === "portrait" ? "tilePortrait" : preview.shape === "landscape" ? "tileLandscape" : "tileSquare")} aria-hidden="true">
          <Icon name={post?.kind === "Ad" || post?.kind === "Story ad" ? "conv-ad" : "conv-post"} size={16} />
        </span>
        <span className={s("postText")}>
          <span className={s("postLine")}>
            <span className={s("contextKind")}>{preview === undefined ? "Post" : preview.kind}</span>
            {preview === undefined ? null : <span className={s("tag", preview.source === "Paid" && "tagAd")}>{preview.source}</span>}
            {preview?.context === undefined ? null : <span className={s("tag", "tagContext")}>{preview.context}</span>}
          </span>
          <span className={s("contextCaption", (post === undefined || post.caption === null) && "muted")}>{post === undefined || post.caption === null ? "Post not read yet" : `“${post.caption}”`}</span>
        </span>
        <span className={s("postMore")}>Details</span>
      </summary>
      <dl className={s("facts", "postFacts")}>
        <dt>Platform</dt>
        <dd>{account === undefined ? "Unknown" : platformName(account)}</dd>
        <dt>Connected account</dt>
        <dd>{identity === undefined ? "Unknown" : identity.verified ? `${identity.name} (${identity.descriptor.toLowerCase()})` : identity.descriptor}</dd>
        <dt>Posted by</dt>
        <dd>{post === undefined ? "Not read yet" : post.owner === null ? "Your account" : `${post.owner} (your account is tagged)`}</dd>
        <dt>Post</dt>
        <dd>{post === undefined || post.caption === null ? "Not read yet" : `${post.kind} · “${post.caption}”`}</dd>
        {sourceSurface === undefined ? null : (
          <>
            <dt>Where</dt>
            <dd>{sourceSurface}</dd>
          </>
        )}
        <dt>Organic or paid</dt>
        <dd>{sourceText(post?.source)}</dd>
        <dt>Media</dt>
        <dd>Not retrieved — no image or video is shown</dd>
        <dt>Comments read</dt>
        <dd>{conversation.comments.length}</dd>
      </dl>
    </details>
  );
}

function Focus({ conversation, list, bench, onMove, onCollapse, split = false }: { readonly conversation: Conversation; readonly list: readonly Conversation[]; readonly bench: Bench; readonly onMove: (id: string, nav?: "previous" | "next") => void; readonly onCollapse: () => void; readonly split?: boolean }) {
  const { readModel, sim, allHealthy, actions, mode } = bench;
  const position = positionOf(list, conversation.id);
  const account = accountOf(conversation.accountId);
  const entries = threadOf(conversation);
  const identity = account === undefined ? undefined : ownIdentity(account, readModel);
  const notice = contextNotice(conversation, healthOf(account, allHealthy), actions, mode);
  const simReplies = sim.ops.filter((op) => op.kind === "reply" && op.conversationId === conversation.id);
  const platform = account === undefined ? "the platform" : platformName(account);
  // Escape anywhere in the open conversation (outside a field or an open panel, which handle it first): the list closes
  // it; two panels keep it selected and return focus to its row (see leavePane).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT") return;
    event.preventDefault();
    onCollapse();
  };
  return (
    <div className={s("focusInner")} onKeyDown={onKeyDown}>
      <div className={s("contextBar")}>
        <SourceCard conversation={conversation} identity={identity} />
        {position === undefined ? null : (
          <nav className={s("convNav")} aria-label="Move between conversations">
            <span className={s("muted", "mono")}>{`${String(position.index)} of ${String(position.count)}`}</span>
            <button type="button" className={s("btn", "btnSmall")} data-nav="previous" disabled={position.previous === undefined} onClick={() => { if (position.previous !== undefined) onMove(position.previous, "previous"); }}>
              Previous
            </button>
            <button type="button" className={s("btn", "btnSmall")} data-nav="next" disabled={position.next === undefined} onClick={() => { if (position.next !== undefined) onMove(position.next, "next"); }}>
              Next
            </button>
          </nav>
        )}
      </div>

      {/* Only what blocks work here is said above the thread: Monitor-only or a connection to repair. A platform context
          is in the post preview, and each unavailable action gives its reason when pressed. */}
      {notice === undefined || notice.cause === "platform" ? null : (
        <p className={s("notice", notice.cause === "connection" && "noticeConnection")} data-cause={notice.cause}>
          <Icon name={notice.cause === "connection" ? "estado-alert" : "estado-lock"} size={16} />
          <span>{notice.text}</span>
        </p>
      )}

      <ol className={s("thread")} aria-label="Comments and replies">
        {entries.map((entry, index) => {
          const previous = index === 0 ? undefined : entryTime(entries.at(index - 1) as ThreadEntry);
          return entry.kind === "comment" ? (
            <CommentItem key={entry.comment.id} conversation={conversation} bench={bench} entry={entry} previous={previous} />
          ) : (
            <SentItem key={entry.reply.id} reply={entry.reply} depth={entry.depth} replyingTo={entry.replyingTo} previous={previous} identityName={identity?.name ?? "Your account"} identityDescriptor={identity?.descriptor ?? "Your account"} verified={identity?.verified ?? false} platform={platform} readModel={readModel} details={bench.details} onDetails={bench.onDetails} />
          );
        })}
        {simReplies.map((op) => (
          <SimReplyItem key={op.id} op={op} conversation={conversation} identityName={identity?.name ?? "Your account"} platform={platform} onAnswer={bench.onAnswer} />
        ))}
      </ol>

      {split ? null : (
        <footer className={s("focusFooter")}>
          {/* Collapsing only folds the panel: the conversation's status does not change. */}
          <button type="button" className={s("btn", "btnSmall", "btnQuiet")} onClick={onCollapse}>
            <Glyph name="collapse" />
            <span>Collapse</span>
            <span className="wk-sr-only"> this conversation (nothing about it changes)</span>
          </button>
        </footer>
      )}
    </div>
  );
}

/** Two panels: the list on the left, the active conversation on the right; below 1024 px one at a time. */
function SplitView({ list, title, openId, bench, register, onSelect, onMove, onBack, onEscape }: {
  readonly list: readonly Conversation[];
  readonly title: string;
  readonly openId: string | undefined;
  readonly bench: Bench;
  readonly register: (id: string, element: HTMLButtonElement | null) => void;
  readonly onSelect: (id: string) => void;
  readonly onMove: (id: string, nav?: "previous" | "next") => void;
  readonly onBack: (id: string) => void;
  readonly onEscape: (id: string) => void;
}) {
  const active = openId === undefined ? undefined : list.find((conversation) => conversation.id === openId);
  const anchor = active?.comments[0];
  const account = active === undefined ? undefined : accountOf(active.accountId);
  const accountName = account === undefined ? "" : bench.readModel === "planned" && account.verifiedName !== null ? account.verifiedName : platformName(account);
  return (
    <div className={s("split", active !== undefined && "splitActive")}>
      <ul className={s("list", "splitList")} aria-label={title}>
        {list.map((conversation, index) => (
          <Row
            key={conversation.id}
            conversation={conversation}
            previousLatest={index === 0 ? undefined : latestOf(list.at(index - 1) as Conversation)}
            open={conversation.id === openId}
            selectMode
            labels={bench.labels}
            sim={bench.sim}
            readModel={bench.readModel}
            register={(element) => { register(conversation.id, element); }}
            onToggle={() => { onSelect(conversation.id); }}
          />
        ))}
      </ul>
      {active === undefined || anchor === undefined ? (
        <section className={s("pane", "paneEmpty")} aria-label="Conversation">
          <p className={s("muted")}>Select a conversation to read it here.</p>
        </section>
      ) : (
        // Keyed by conversation (audit H-2): moving to another conversation mounts a fresh panel — its post details
        // closed, its scroll at the top — while the prototype's state (labels, drafts, simulations) stays where it lives.
        <section key={active.id} id={`focus-${active.id}`} className={s("pane")} aria-labelledby={`pane-${active.id}`}>
          <div className={s("paneHead")}>
            <button type="button" className={s("btn", "btnSmall", "btnQuiet", "backButton")} onClick={() => { onBack(active.id); }}>
              Back to list
            </button>
            <h2 id={`pane-${active.id}`} className={s("paneTitle")} tabIndex={-1}>
              {account === undefined ? null : <OriginMark platform={account.platform} name={platformName(account)} />}
              <span>{anchor.author.kind === "own" ? "Your account" : commenterName(anchor)}</span>
              <span className={s("rowAccount")}>{`on ${accountName}`}</span>
            </h2>
          </div>
          <Focus conversation={active} list={list} bench={bench} onMove={onMove} onCollapse={() => { onEscape(active.id); }} split />
        </section>
      )}
    </div>
  );
}

const entryTime = (entry: ThreadEntry): string => (entry.kind === "comment" ? entry.comment.at : entry.reply.publishedAt);

/* ───────────── one comment ───────────── */

function CommentItem({ conversation, bench, entry, previous }: { readonly conversation: Conversation; readonly bench: Bench; readonly entry: Extract<ThreadEntry, { kind: "comment" }>; readonly previous: string | undefined }) {
  const { role, mode, actions, readModel, assess, allHealthy, labels, sim, panel, details, replyTarget, drafts, privateDrafts, onPanel, onDetails, onReply, onReplyClose, onDraft, onPrivateDraft, onAssign, onCreate, onStart, onAnswer } = bench;
  const { comment } = entry;
  const abilities = abilitiesOf(role);
  const account = accountOf(conversation.accountId);
  const platformId = account?.platform ?? "facebook";
  const platform = account === undefined ? "the platform" : platformName(account);
  const own = comment.author.kind === "own";
  const identity = account === undefined ? undefined : ownIdentity(account, readModel);
  const author = own ? (identity?.name ?? "Your account") : commenterName(comment);
  const owner = own ? "your account's comment" : `${author}'s comment`;
  const ids = labelsOn(labels, comment.id);
  const view = viewOf(sim, conversation.accountId, comment);
  const assessment = assess ? assessmentOf(comment.id) : undefined;
  const panelOpen = panel?.commentId === comment.id ? panel : undefined;
  const moreButton = useRef<HTMLButtonElement>(null);
  const hideButton = useRef<HTMLButtonElement>(null);
  const replyButton = useRef<HTMLButtonElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  /** After a label chip is removed: the position whose neighbour takes focus (audit M-2). */
  const chipFocus = useRef<number | undefined>(undefined);
  const hideReasonId = useId();
  const availability = (action: ActionId): Availability => availabilityOf({ action, role, mode, actions, accountHealth: healthOf(account, allHealthy), conversation, comment, sim });
  /** The same decision start() makes, drawn now: a stale confirmation, composer or "Try again" never offers what start() would refuse. */
  const opCheck = (kind: OpKind): Availability => opAvailability({ role, mode, actions, accountHealth: healthOf(account, allHealthy), conversation, comment, sim }, kind);
  const reply = availability("reply");
  const hide = availability("hide");
  const replyHere = replyTarget === comment.id;
  const hidden = view.presence === "hidden";
  const closePanel = (focus: "more" | "hide"): void => {
    onPanel(undefined);
    (focus === "hide" ? hideButton : moreButton).current?.focus();
  };
  /** Focus after a simulated operation settles: the Hide/Unhide toggle when it is still there, otherwise More. */
  const focusAfterOp = (): void => { (hideButton.current ?? moreButton.current)?.focus(); };
  /**
   * Start an operation and put focus on a control that still exists (the panel that asked is gone): Reply for a reply,
   * the Hide toggle for hide/unhide, More for the rest — never the simulation's answer buttons, so pressing Enter twice
   * cannot confirm a simulated outcome by accident.
   */
  const run = (kind: OpKind, text?: string): boolean => {
    const ok = onStart(conversation, comment, kind, text);
    const target = kind === "reply" ? replyButton : kind === "hide" || kind === "unhide" ? hideButton : moreButton;
    (target.current ?? moreButton.current)?.focus();
    return ok;
  };
  useEffect(() => {
    const index = chipFocus.current;
    if (index === undefined) return;
    chipFocus.current = undefined;
    const buttons = [...(articleRef.current?.querySelectorAll<HTMLButtonElement>('ul[aria-label="Labels"] button') ?? [])];
    (buttons.at(Math.min(index, buttons.length - 1)) ?? moreButton.current)?.focus();
  }, [ids]);
  const ops = sim.ops.filter((op) => op.commentId === comment.id && op.kind !== "reply" && op.kind !== "private_reply");
  const lastOp = ops.at(-1);
  const privateOps = sim.ops.filter((op) => op.commentId === comment.id && op.kind === "private_reply");
  const headingId = `c-${comment.id}`;
  const rootAuthor = conversation.comments[0] === undefined ? author : conversation.comments[0].author.kind === "own" ? "your account" : commenterName(conversation.comments[0]);
  const target = account === undefined ? { commentId: comment.id } : replyTargetOf(conversation, comment, account.platform);

  const onHide = (): void => {
    if (hide.kind === "unavailable") {
      onPanel(panelOpen?.kind === "reason" ? undefined : { commentId: comment.id, kind: "reason", reason: hide.reason });
      return;
    }
    if (!hidden && assessment?.protected === true) {
      onPanel({ commentId: comment.id, kind: "confirm", confirm: "hide" });
      return;
    }
    run(hidden ? "unhide" : "hide");
  };

  return (
    <li className={s("entry", entry.depth === 0 ? "entryRoot" : "entryNested", own && "entryOwn")}>
      <article ref={articleRef} className={s("entryBody")} aria-labelledby={headingId}>
        <div className={s("entryHead")}>
          <p id={headingId} className={s("entryAuthor")}>
            {own ? <OwnMark /> : null}
            <span className={s("authorName")}>{author}</span>
            {own && identity !== undefined && identity.verified ? <span className={s("muted", "small")}>{identity.descriptor}</span> : null}
            {entry.replyingTo === undefined ? null : <span className={s("muted", "small")}>{`Replying to ${entry.replyingTo}`}</span>}
          </p>
          {assessment === undefined ? null : <AssessmentTag meaning={assessment.meaning} isProtected={assessment.protected} />}
          <button type="button" className={s("timeButton")} aria-expanded={details === comment.id} onClick={() => { onDetails(details === comment.id ? undefined : comment.id); }}>
            <Stamp iso={comment.at} previous={previous} />
            {comment.editedAt === null ? null : <span className={s("muted", "small")}> · edited</span>}
            <span className="wk-sr-only">{details === comment.id ? ", hide details" : ", show details"}</span>
          </button>
        </div>

        {view.presence === "present" ? (
          <p className={s("entryText")}>{comment.text}</p>
        ) : (
          <div className={s("entryText")}>
            {view.simulated ? (
              <SimMarker icon={view.presence === "deleted" ? "util-close" : "estado-lock"}>{view.presence === "deleted" ? `Deleted from ${platform}` : `Hidden on ${platform}`}</SimMarker>
            ) : (
              <StatePill icon="estado-lock">{view.presence === "hidden" ? `Hidden on ${platform}` : `Removed from ${platform}`}</StatePill>
            )}
            {view.presence === "removed" ? null : <span className={s("hiddenText")}>{comment.text}</span>}
          </div>
        )}

        {view.liked || view.authorBlocked || (view.simulated && view.presence === "present") ? (
          <p className={s("markers")}>
            {view.simulated && view.presence === "present" ? <SimMarker icon="decision-approve">{`Unhidden on ${platform}`}</SimMarker> : null}
            {view.liked ? <SimMarker icon="decision-approve">{`Liked by ${identity?.name ?? "your Page"}`}</SimMarker> : null}
            {view.authorBlocked ? <SimMarker icon="decision-reject">{`${author} blocked by ${identity?.name ?? "your Page"}`}</SimMarker> : null}
          </p>
        ) : null}

        <Chips
          ids={ids}
          state={labels}
          max={3}
          owner={owner}
          onRemove={
            abilities.assign
              ? (labelId) => {
                  chipFocus.current = ids.indexOf(labelId);
                  onAssign(comment.id, owner, labelId, false);
                }
              : undefined
          }
        />

        <div className={s("actions")} role="group" aria-label={`Actions for ${owner}`}>
          {reply.kind === "hidden" ? null : (
            <button ref={replyButton} type="button" className={s("action", reply.kind === "unavailable" && "actionUnavailable")} aria-expanded={replyHere} onClick={() => { onReply(conversation, comment); }}>
              <Icon name={reply.kind === "unavailable" ? "estado-lock" : "conv-reply"} size={16} />
              <span>Reply</span>
            </button>
          )}
          {hide.kind === "hidden" ? null : (
            <button ref={hideButton} type="button" className={s("action", hide.kind === "unavailable" && "actionUnavailable")} aria-disabled={hide.kind === "unavailable" ? "true" : undefined} aria-describedby={hide.kind === "unavailable" ? hideReasonId : undefined} onClick={onHide}>
              {hide.kind === "unavailable" ? <Icon name="estado-lock" size={16} /> : <Glyph name={hidden ? "eye" : "eyeOff"} />}
              <span>{hidden ? "Unhide" : "Hide"}</span>
              {hide.kind === "unavailable" ? (
                <span id={hideReasonId} className="wk-sr-only">
                  {hide.reason}
                </span>
              ) : null}
            </button>
          )}
          <button ref={moreButton} type="button" className={s("action", "actionIcon")} aria-expanded={panelOpen?.kind === "more"} onClick={() => { onPanel(panelOpen?.kind === "more" ? undefined : { commentId: comment.id, kind: "more" }); }}>
            <Icon name="util-more" size={16} />
            <span className="wk-sr-only">{`More for ${owner}`}</span>
          </button>
        </div>

        {panelOpen?.kind === "reason" && panelOpen.reason !== undefined ? (
          <p className={s("reason", "reasonInline")} role="note">
            <Icon name="estado-lock" size={16} />
            <span>
              <strong>{hidden ? "Unhide unavailable." : "Hide unavailable."}</strong> {panelOpen.reason}
            </span>
          </p>
        ) : null}

        {lastOp === undefined ? null : <OpLine op={lastOp} platform={platform} canRetry={opCheck(lastOp.kind).kind === "available"} onAnswer={onAnswer} onRetry={() => { run(lastOp.kind); }} onSettled={focusAfterOp} />}

        {panelOpen?.kind === "labels" && abilities.assign ? <LabelEditor labels={labels} assigned={ids} canCreate={abilities.create} owner={owner} onToggle={(labelId, on) => { onAssign(comment.id, owner, labelId, on); }} onCreate={(name) => onCreate(name, comment.id, owner)} onClose={() => { closePanel("more"); }} /> : null}

        {panelOpen?.kind === "more" ? (
          <MoreMenu
            platform={platform}
            platformId={platformId}
            simulated={actions === "simulate"}
            items={[
              { id: "private_reply", label: "Reply privately", availability: availability("private_reply"), onSelect: () => { onPanel({ commentId: comment.id, kind: "private" }); } },
              { id: "like", label: view.liked ? "Unlike" : "Like", availability: availability("like"), onSelect: () => { run(view.liked ? "unlike" : "like"); } },
              { id: "delete", label: "Delete comment…", availability: availability("delete"), danger: true, onSelect: () => { onPanel({ commentId: comment.id, kind: "confirm", confirm: "delete" }); } },
              { id: "block", label: view.authorBlocked ? "Unblock author…" : "Block author…", availability: availability("block"), danger: !view.authorBlocked, onSelect: () => { onPanel({ commentId: comment.id, kind: "confirm", confirm: view.authorBlocked ? "unblock" : "block" }); } },
            ]}
            labelsItem={abilities.assign ? () => { onPanel({ commentId: comment.id, kind: "labels" }); } : undefined}
            labelCount={ids.length}
            detailsOpen={details === comment.id}
            onDetails={() => {
              onDetails(details === comment.id ? undefined : comment.id);
              closePanel("more"); // the menu item is gone: focus returns to More (audit M-2)
            }}
            onClose={() => { closePanel("more"); }}
          />
        ) : null}

        {panelOpen?.kind === "confirm" && panelOpen.confirm !== undefined && opCheck(panelOpen.confirm).kind !== "available" ? (
          <StaleNotice availability={opCheck(panelOpen.confirm)} onClose={() => { closePanel(panelOpen.confirm === "hide" ? "hide" : "more"); }} />
        ) : null}

        {panelOpen?.kind === "confirm" && panelOpen.confirm !== undefined && opCheck(panelOpen.confirm).kind === "available" ? (
          <ConfirmPanel
            action={panelOpen.confirm}
            author={author}
            page={identity?.name ?? `your ${platform} account`}
            platform={platform}
            protectedMeaning={assessment?.protected === true ? assessment.meaning : undefined}
            onConfirm={() => {
              const kind = panelOpen.confirm;
              if (kind !== undefined) run(kind);
            }}
            onCancel={() => { closePanel(panelOpen.confirm === "hide" ? "hide" : "more"); }}
          />
        ) : null}

        {panelOpen?.kind === "private" && opCheck("private_reply").kind !== "available" ? (
          <StaleNotice availability={opCheck("private_reply")} onClose={() => { closePanel("more"); }} />
        ) : null}

        {panelOpen?.kind === "private" && opCheck("private_reply").kind === "available" ? (
          <PrivateReplyArea
            comment={comment}
            author={author}
            platform={platform}
            identity={identity?.name ?? `your ${platform} account`}
            draft={valueOf(privateDrafts, comment.id) ?? ""}
            onDraft={(text) => { onPrivateDraft(comment.id, text); }}
            onSend={(text) => {
              if (run("private_reply", text)) onPrivateDraft(comment.id, "");
            }}
            onClose={() => { closePanel("more"); }}
          />
        ) : null}

        {privateOps.map((op) => (
          <PrivateRecord key={op.id} op={op} author={author} platform={platform} onAnswer={onAnswer} onSettled={focusAfterOp} />
        ))}

        {details === comment.id ? (
          <dl className={s("facts", "entryFacts")} aria-label={`Details of ${owner}`}>
            <dt>Written on {platform}</dt>
            <dd>
              <Exact iso={comment.at} />
            </dd>
            {comment.editedAt === null ? null : (
              <>
                <dt>Edited</dt>
                <dd>
                  <Exact iso={comment.editedAt} />
                </dd>
              </>
            )}
            <dt>Read by Wrenkind</dt>
            <dd>
              <Exact iso={comment.readAt} />
            </dd>
            {own ? (
              <>
                <dt>Written by</dt>
                <dd>{`${identity?.descriptor ?? "Your account"}, directly on ${platform} (not from Wrenkind)`}</dd>
              </>
            ) : null}
            {own || comment.author.kind === "unknown" ? null : (
              <>
                <dt>Private reply</dt>
                <dd>
                  {privateReplyWindow(comment).open ? "Possible until " : "Window closed on "}
                  <Exact iso={privateReplyWindow(comment).closesAt} />
                </dd>
              </>
            )}
          </dl>
        ) : null}

        {replyHere && reply.kind !== "hidden" ? (
          <ReplyArea
            availability={reply}
            author={author}
            rootAuthor={target.commentId === comment.id ? undefined : rootAuthor}
            platform={platform}
            identity={identity?.name ?? "your account"}
            draft={valueOf(drafts, comment.id) ?? ""}
            onDraft={(text) => { onDraft(comment.id, text); }}
            onPublish={(text) => {
              // The draft goes once the (simulated) request is accepted, as in the product (ui/inbox/reply-drafts.ts); a
              // refused start keeps it and the composer shows why.
              if (run("reply", text)) {
                onDraft(comment.id, "");
                onReplyClose();
              }
            }}
            onClose={onReplyClose}
          />
        ) : null}
      </article>
    </li>
  );
}

function OwnMark() {
  return (
    <span className={s("ownMark")} aria-hidden="true">
      <Icon name="decision-human" size={16} />
    </span>
  );
}

/** A synthetic automatic assessment: round and marked as Wrenkind's reading, never confused with a person's label. */
function AssessmentTag({ meaning, isProtected }: { readonly meaning: string; readonly isProtected: boolean }) {
  return (
    <span className={s("assessment", isProtected && "assessmentProtected")}>
      <span className="wk-sr-only">Automatic assessment, synthetic example: </span>
      <span>{meaning}</span>
      {isProtected ? <span className={s("assessmentNote")}>· never auto-hidden</span> : null}
    </span>
  );
}

/** A confirmation or composer whose action is no longer possible (role, mode, connection or the comment changed). */
function StaleNotice({ availability, onClose }: { readonly availability: Availability; readonly onClose: () => void }) {
  return (
    <div className={s("reason", "reasonInline")} role="note">
      <Icon name="estado-lock" size={16} />
      <span>
        <strong>No longer possible.</strong> {availability.kind === "unavailable" ? availability.reason : "This action isn't available to you."}
      </span>
      <button type="button" className={s("btn", "btnSmall", "btnQuiet")} onClick={onClose}>
        Close
      </button>
    </div>
  );
}

/* ───────────── simulated operations ───────────── */

const ANSWERS: readonly (readonly [OpAnswer, string])[] = [
  ["sent", "Confirmed"],
  ["failed", "Failed"],
  ["checking", "No answer"],
  ["blocked", "Stopped"],
];
const CHECKS: readonly (readonly [OpAnswer, string])[] = [
  ["sent", "It went through"],
  ["failed", "It didn't"],
];

/**
 * Where the person plays the platform: prototype-only, dashed, and named as such. Never focused on its own (audit: no
 * autoFocus, so a second Enter cannot answer by accident). After an answer pressed here, focus moves to the check's
 * first button (No answer → Checking) or, once settled, to the control the owner names (audit M-2).
 */
function SimControls({ op, onAnswer, onSettled }: { readonly op: Operation; readonly onAnswer: (opId: string, answer: OpAnswer) => void; readonly onSettled?: (() => void) | undefined }) {
  const first = useRef<HTMLButtonElement>(null);
  const pressed = useRef(false);
  const settled = useRef(onSettled);
  useEffect(() => {
    settled.current = onSettled;
  });
  useEffect(() => {
    if (!pressed.current) return;
    pressed.current = false;
    if (op.status === "checking") first.current?.focus();
    else settled.current?.();
  }, [op.status]);
  const answers = op.status === "sending" ? ANSWERS : op.status === "checking" ? CHECKS : [];
  if (answers.length === 0) return null;
  return (
    <div className={s("simControls")} role="group" aria-label={op.status === "sending" ? "Prototype: simulate the platform's answer" : "Prototype: simulate the check"}>
      <span className={s("simControlsLabel")}>{op.status === "sending" ? "Prototype — simulate the answer:" : "Prototype — simulate the check:"}</span>
      {answers.map(([value, name], index) => (
        <button
          key={`${op.status}-${value}`}
          ref={index === 0 ? first : undefined}
          type="button"
          className={s("simButton")}
          onClick={() => {
            pressed.current = true;
            onAnswer(op.id, value);
          }}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

const PILL_ICON = { sending: "estado-sync", sent: "decision-approve", failed: "estado-alert", checking: "estado-sync", blocked: "estado-alert" } as const;

function OpStatusLine({ op, platform }: { readonly op: Operation; readonly platform: string }) {
  return (
    <p className={s("opStatus")}>
      <SimBadge />
      <StatePill tone={opStatusTone(op.status)} icon={valueOf(PILL_ICON, op.status) ?? "estado-sync"}>
        {opStatusText(op.status)}
      </StatePill>
      <span className={s("opSentence")}>{opSentence(op, platform)}</span>
    </p>
  );
}

/** A moderation operation on one comment (hide, unhide, like, unlike, delete, block, unblock). */
function OpLine({ op, platform, canRetry, onAnswer, onRetry, onSettled }: {
  readonly op: Operation;
  readonly platform: string;
  /** "Try again" is offered only when starting that operation again would be allowed now (audit H-1). */
  readonly canRetry: boolean;
  readonly onAnswer: (opId: string, answer: OpAnswer) => void;
  readonly onRetry: () => void;
  readonly onSettled: () => void;
}) {
  const retry = useRef<HTMLButtonElement>(null);
  return (
    <div className={s("opLine")} data-op-status={op.status}>
      <OpStatusLine op={op} platform={platform} />
      <SimControls
        op={op}
        onAnswer={onAnswer}
        onSettled={() => {
          // A failure that may be tried again focuses "Try again"; anything else hands focus back to the comment.
          if (retry.current === null) onSettled();
          else retry.current.focus();
        }}
      />
      {retryable(op) && canRetry ? (
        <div className={s("inlineActions")}>
          <button ref={retry} type="button" className={s("btn", "btnSmall")} onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** A simulated public reply, in the thread after everything already there. */
function SimReplyItem({ op, conversation, identityName, platform, onAnswer }: { readonly op: Operation; readonly conversation: Conversation; readonly identityName: string; readonly platform: string; readonly onAnswer: (opId: string, answer: OpAnswer) => void }) {
  const attachedTo = conversation.comments.find((comment) => comment.id === op.commentId);
  const attachedName = attachedTo === undefined ? undefined : attachedTo.author.kind === "own" ? "your account" : commenterName(attachedTo);
  const answering = op.answering ?? (attachedTo === conversation.comments[0] ? undefined : attachedName);
  const replyEntry = useRef<HTMLElement>(null);
  return (
    <li className={s("entry", "entryNested", "entryOwn", "entrySim")} data-sim-reply={op.id}>
      <article ref={replyEntry} className={s("entryBody")} aria-label={`Simulated reply from ${identityName}`} tabIndex={-1}>
        <div className={s("entryHead")}>
          <p className={s("entryAuthor")}>
            <OwnMark />
            <span className={s("authorName")}>{identityName}</span>
            {answering === undefined ? null : <span className={s("muted", "small")}>{`Replying to ${answering}`}</span>}
          </p>
        </div>
        <p className={s("entryText")}>{op.text ?? ""}</p>
        <OpStatusLine op={op} platform={platform} />
        {op.status === "checking" ? <p className={s("muted", "small")}>It may already be public — in the product, check on the platform before writing another reply.</p> : null}
        <SimControls op={op} onAnswer={onAnswer} onSettled={() => { replyEntry.current?.focus(); }} />
      </article>
    </li>
  );
}

/** A simulated private reply: shown at its comment, never in the public thread, and never a conversation of its own. */
function PrivateRecord({ op, author, platform, onAnswer, onSettled }: { readonly op: Operation; readonly author: string; readonly platform: string; readonly onAnswer: (opId: string, answer: OpAnswer) => void; readonly onSettled: () => void }) {
  return (
    <div className={s("privateRecord")}>
      <p className={s("privateHeading")}>
        <Icon name="conv-mention" size={16} />
        <span>{`Private reply to ${author}`}</span>
      </p>
      <p className={s("reviewText")}>{op.text ?? ""}</p>
      <OpStatusLine op={op} platform={platform} />
      <SimControls op={op} onAnswer={onAnswer} onSettled={onSettled} />
      {op.status === "sent" ? <p className={s("muted", "small")}>{`If ${author} answers, that conversation continues in ${platform}'s own messages — Wrenkind has no message inbox, so it won't appear here.`}</p> : null}
    </div>
  );
}

/* ───────────── labels on one comment ───────────── */

function LabelEditor({ labels, assigned, canCreate, owner, onToggle, onCreate, onClose }: {
  readonly labels: LabelState;
  readonly assigned: readonly string[];
  readonly canCreate: boolean;
  readonly owner: string;
  readonly onToggle: (labelId: string, on: boolean) => void;
  readonly onCreate: (name: string) => string | undefined;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const id = useId();
  const typed = normalizeName(query);
  const exact = typed === "" ? undefined : findLabelByName(labels.labels, typed);
  const matching = sortedLabels(labels.labels).filter((label) => typed === "" || label.name.toLocaleLowerCase("en").includes(typed.toLocaleLowerCase("en")));
  /** Something typed that only partly matches existing labels: Enter does nothing, and the hint says why. */
  const partial = typed !== "" && exact === undefined && matching.length > 0;
  const create = (): void => {
    const result = onCreate(query);
    setProblem(result);
    if (result === undefined) setQuery("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };
  return (
    <div className={s("popover")} role="group" aria-label={`Labels for ${owner}`} onKeyDown={onKeyDown}>
      <label htmlFor={id} className={s("small", "muted")}>
        {canCreate ? "Find or create a label for this comment" : "Find a label for this comment"}
      </label>
      <input
        id={id}
        className={s("input")}
        value={query}
        maxLength={80}
        autoFocus
        autoComplete="off"
        onChange={(event) => {
          setQuery(event.target.value);
          setProblem(undefined);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          // Enter acts only on an exact name (audit M-3): it toggles the label named exactly, or creates a new one when no
          // existing label even partly matches. A partial name ("Refund" while "Refund request" exists) never toggles or
          // creates anything: the person picks the label below or presses Create explicitly.
          if (exact !== undefined) onToggle(exact.id, !assigned.includes(exact.id));
          else if (canCreate && typed !== "" && matching.length === 0) create();
        }}
        aria-describedby={[problem === undefined ? undefined : `${id}-problem`, partial ? `${id}-hint` : undefined].filter((value) => value !== undefined).join(" ") || undefined}
      />
      {partial ? (
        <p id={`${id}-hint`} className={s("muted", "small")}>
          {canCreate ? "Pick a label below, or use Create — Enter only adds an exact name." : "Pick a label below — Enter only adds an exact name."}
        </p>
      ) : null}
      {matching.length === 0 ? null : (
        <ul className={s("checkList")}>
          {matching.map((label) => (
            <li key={label.id}>
              <label className={s("check")}>
                <input type="checkbox" checked={assigned.includes(label.id)} onChange={(event) => { onToggle(label.id, event.target.checked); }} />
                <span>{label.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {labels.labels.length === 0 && typed === "" ? <p className={s("muted", "small")}>{canCreate ? "No labels yet. Type a name to create the first one." : "No labels yet. Owners, admins and managers create them."}</p> : null}
      {typed !== "" && exact === undefined ? (
        canCreate ? (
          <button type="button" className={s("btn", "btnCreate")} onClick={create}>
            <Icon name="util-plus" size={16} />
            <span>{`Create “${typed}” and add it`}</span>
          </button>
        ) : (
          <p className={s("muted", "small")}>{`No label named “${typed}”. Owners, admins and managers create labels.`}</p>
        )
      ) : null}
      {problem === undefined ? null : (
        <p id={`${id}-problem`} className={s("problem")} role="alert">
          {problem}
        </p>
      )}
      <p className={s("muted", "small")}>Labels are internal to Wrenkind and apply to this comment only.</p>
      <div className={s("inlineActions")}>
        <button type="button" className={s("btn", "btnSmall")} onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

/* ───────────── More: details, then the platform's less frequent actions ───────────── */

interface MenuItem {
  readonly id: ActionId;
  readonly label: string;
  readonly availability: Availability;
  readonly danger?: boolean;
  readonly onSelect: () => void;
}

const ITEM_GLYPH: { readonly [A in ActionId]: GlyphName } = { private_reply: "envelope", like: "thumb", delete: "trash", block: "ban", reply: "envelope", hide: "eyeOff" };

/**
 * More: the comment's less frequent actions. First what stays in Wrenkind (labels, details), then what would act on the
 * platform (marked Simulated). An unavailable action shows its reason in the person's terms; the API detail behind it
 * lives in the prototype's capability reference, not here.
 */
function MoreMenu({ platform, platformId, simulated, items, labelsItem, labelCount, detailsOpen, onDetails, onClose }: {
  readonly platform: string;
  readonly platformId: "facebook" | "instagram";
  readonly simulated: boolean;
  readonly items: readonly MenuItem[];
  readonly labelsItem: (() => void) | undefined;
  readonly labelCount: number;
  readonly detailsOpen: boolean;
  readonly onDetails: () => void;
  readonly onClose: () => void;
}) {
  const reasonId = useId();
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  const shown = items.filter((item) => item.availability.kind !== "hidden");
  const reasons: string[] = [];
  for (const item of shown) if (item.availability.kind === "unavailable" && !reasons.includes(item.availability.reason)) reasons.push(item.availability.reason);
  const reasonIdOf = (item: MenuItem): string | undefined => (item.availability.kind === "unavailable" ? `${reasonId}-${String(reasons.indexOf(item.availability.reason))}` : undefined);
  return (
    <div
      className={s("popover", "menu")}
      role="group"
      aria-label="More actions"
      data-platform={platformId}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      {labelsItem === undefined ? null : (
        <button ref={first} type="button" className={s("menuItem")} onClick={labelsItem}>
          <Glyph name="tag" />
          <span>Labels…</span>
          {labelCount > 0 ? <span className={s("menuCount")}>{labelCount}</span> : null}
        </button>
      )}
      <button ref={labelsItem === undefined ? first : undefined} type="button" className={s("menuItem")} onClick={onDetails}>
        <Icon name="util-calendar" size={16} />
        <span>{detailsOpen ? "Hide details" : "Details and exact times"}</span>
      </button>
      {shown.length === 0 ? null : (
        <>
          <p className={s("menuHeading", "menuHeadingPlatform")}>
            <span>{`On ${platform}`}</span>
            {simulated ? <SimBadge /> : null}
          </p>
          {shown.map((item) => (
            <button
              key={item.id}
              type="button"
              className={s("menuItem", item.availability.kind === "unavailable" && "menuItemUnavailable", item.danger === true && item.availability.kind === "available" && "menuItemDanger")}
              aria-disabled={item.availability.kind === "unavailable" ? "true" : undefined}
              aria-describedby={reasonIdOf(item)}
              onClick={() => { if (item.availability.kind === "available") item.onSelect(); }}
            >
              {item.availability.kind === "unavailable" ? <Icon name="estado-lock" size={16} /> : <Glyph name={valueOf(ITEM_GLYPH, item.id) ?? "tag"} />}
              <span>{item.label}</span>
            </button>
          ))}
          {reasons.map((reason, index) => (
            <p key={reason} id={`${reasonId}-${String(index)}`} className={s("muted", "small", "menuReason")}>
              {reason}
            </p>
          ))}
        </>
      )}
    </div>
  );
}

/* ───────────── deliberate confirmation (Delete, Block, Unblock; Hide on a protected comment) ───────────── */

function ConfirmPanel({ action, author, page, platform, protectedMeaning, onConfirm, onCancel }: {
  readonly action: ConfirmAction;
  readonly author: string;
  readonly page: string;
  readonly platform: string;
  readonly protectedMeaning: string | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const headingId = useId();
  const copy =
    action === "delete"
      ? {
          title: `Delete ${author}'s comment from ${platform}?`,
          points: [`It's removed from ${platform} for everyone and can't be restored there.`, "Replies under it may be removed with it.", "Wrenkind keeps its own record of what it read."],
          confirm: "Delete comment",
        }
      : action === "block"
        ? {
            title: `Block ${author} from ${page}?`,
            points: [`This acts on the person, not on this comment: they won't be able to interact with ${page} on ${platform}.`, "Their existing comments stay unless you hide or delete them.", "You can unblock them later."],
            confirm: "Block author",
          }
        : action === "unblock"
          ? {
              title: `Unblock ${author}?`,
              points: [`They can interact with ${page} on ${platform} again.`, `If you block them again soon after, ${platform} may refuse it for a while.`],
              confirm: "Unblock author",
            }
          : {
              title: `Hide ${author}'s comment?`,
              points: [`Hiding is reversible: you can unhide it later.`],
              confirm: "Hide comment",
            };
  return (
    <div
      className={s("popover", "confirm", action !== "unblock" && action !== "hide" && "confirmDanger")}
      role="group"
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <p id={headingId} className={s("confirmTitle")}>
        {copy.title}
      </p>
      <ul className={s("confirmPoints")}>
        {copy.points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      {protectedMeaning === undefined || action === "unblock" ? null : (
        <p className={s("caution")}>
          <Icon name="estado-alert" size={16} />
          <span>{`Assessed as “${protectedMeaning}” (synthetic example). Wrenkind never hides or removes these automatically; doing it yourself is your decision.`}</span>
        </p>
      )}
      <p className={s("muted", "small")}>{`Simulated: nothing is sent to ${platform}.`}</p>
      <div className={s("inlineActions")}>
        <button type="button" className={s("btn")} autoFocus onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={s("btn", action === "unblock" || action === "hide" ? "btnPrimary" : "btnDanger")} onClick={onConfirm}>
          {copy.confirm}
        </button>
      </div>
    </div>
  );
}

/* ───────────── reply: the reason at the point of work, or a composer whose publishing is simulated ───────────── */

function ReplyArea({ availability, author, rootAuthor, platform, identity, draft, onDraft, onPublish, onClose }: {
  readonly availability: Availability;
  readonly author: string;
  /** Instagram: the top-level comment's author, when this reply will be attached there instead. */
  readonly rootAuthor: string | undefined;
  readonly platform: string;
  readonly identity: string;
  readonly draft: string;
  readonly onDraft: (text: string) => void;
  readonly onPublish: (text: string) => void;
  readonly onClose: () => void;
}) {
  const [stage, setStage] = useState<"write" | "review">("write");
  const [restored] = useState(draft.trim() !== "" && draft.trim() !== `@${author}`);
  const id = useId();
  if (availability.kind !== "available") {
    return (
      <div className={s("replyArea")}>
        <p className={s("reason")}>
          <Icon name="estado-lock" size={16} />
          <span>
            <strong>Reply unavailable.</strong> {availability.kind === "unavailable" ? availability.reason : ""}
          </span>
        </p>
      </div>
    );
  }
  return (
    <div
      className={s("replyArea", "composer")}
      aria-labelledby={`${id}-heading`}
      role="group"
      onKeyDown={(event) => {
        if (event.key === "Escape" && stage === "review") {
          event.preventDefault();
          setStage("write");
        }
      }}
    >
      <p id={`${id}-heading`} className={s("composerHeading")}>
        {`Reply to ${author}`}
        <span className={s("previewBadge")}>Preview — nothing is sent</span>
      </p>
      <p className={s("muted", "small")}>{`Would be published by ${identity} on ${platform}, visible to everyone.`}</p>
      {rootAuthor === undefined ? null : (
        <p className={s("note")}>
          <Icon name="conv-thread" size={16} />
          <span>{`Instagram attaches replies to the top-level comment: this reply would appear under ${rootAuthor}'s comment, naming ${author}.`}</span>
        </p>
      )}
      {restored && stage === "write" ? <p className={s("muted", "small")}>Draft kept from earlier in this tab.</p> : null}
      {stage === "write" ? (
        <>
          <label htmlFor={id} className="wk-sr-only">
            Your reply
          </label>
          <textarea id={id} className={s("textarea")} rows={3} value={draft} autoFocus onChange={(event) => { onDraft(event.target.value); }} />
          <div className={s("inlineActions")}>
            <button type="button" className={s("btn", "btnPrimary")} disabled={draft.trim() === "" || draft.trim() === `@${author}`} onClick={() => { setStage("review"); }}>
              Review reply
            </button>
            <button
              type="button"
              className={s("btn")}
              onClick={() => {
                onDraft("");
                onClose();
              }}
            >
              Discard
            </button>
          </div>
        </>
      ) : (
        <>
          <p className={s("reviewText")}>{draft}</p>
          <p className={s("reason")}>
            <Icon name="estado-lock" size={16} />
            <span>Publishing isn&apos;t part of this preview. “Simulate publishing” shows what would happen next, without sending anything.</span>
          </p>
          <div className={s("inlineActions")}>
            <button type="button" className={s("btn", "btnSim")} onClick={() => { onPublish(draft.trim()); }}>
              Simulate publishing
            </button>
            <button type="button" className={s("btn")} onClick={() => { setStage("write"); }}>
              Edit
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ───────────── private reply: one message, within seven days, no inbox ───────────── */

function PrivateReplyArea({ comment, author, platform, identity, draft, onDraft, onSend, onClose }: {
  readonly comment: Comment;
  readonly author: string;
  readonly platform: string;
  readonly identity: string;
  readonly draft: string;
  readonly onDraft: (text: string) => void;
  readonly onSend: (text: string) => void;
  readonly onClose: () => void;
}) {
  const id = useId();
  const opening = privateReplyWindow(comment);
  return (
    <div
      className={s("replyArea", "composer", "privateComposer")}
      role="group"
      aria-labelledby={`${id}-heading`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <p id={`${id}-heading`} className={s("composerHeading")}>
        <Icon name="conv-mention" size={16} />
        {`Reply privately to ${author}`}
        <SimBadge />
      </p>
      <ul className={s("privateRules")}>
        <li>{`A message from ${identity} to ${author}, linked to this comment. It isn't shown in the public thread.`}</li>
        <li>
          {`One per comment, within ${String(PRIVATE_REPLY_DAYS)} days of it — until `}
          <Exact iso={opening.closesAt} />.
        </li>
        <li>{`If ${author} answers, the conversation continues in ${platform}'s own messages. Wrenkind has no message inbox.`}</li>
      </ul>
      {privateReplyClosingSoon(comment) ? (
        <p className={s("caution")}>
          <Icon name="estado-sla" size={16} />
          <span>The window closes in less than a day.</span>
        </p>
      ) : null}
      <label htmlFor={id} className="wk-sr-only">
        Your private reply
      </label>
      <textarea id={id} className={s("textarea")} rows={3} value={draft} autoFocus onChange={(event) => { onDraft(event.target.value); }} />
      <div className={s("inlineActions")}>
        <button type="button" className={s("btn", "btnSim")} disabled={draft.trim() === ""} onClick={() => { onSend(draft.trim()); }}>
          Simulate sending
        </button>
        <button type="button" className={s("btn")} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ───────────── a reply published earlier through Wrenkind ───────────── */

function SentItem({ reply, depth, replyingTo, previous, identityName, identityDescriptor, verified, platform, readModel, details, onDetails }: {
  readonly reply: SentReply;
  readonly depth: 0 | 1;
  readonly replyingTo: string | undefined;
  readonly previous: string | undefined;
  readonly identityName: string;
  readonly identityDescriptor: string;
  readonly verified: boolean;
  readonly platform: string;
  readonly readModel: ReadModel;
  readonly details: string | undefined;
  readonly onDetails: (id: string | undefined) => void;
}) {
  const open = details === reply.id;
  const headingId = `r-${reply.id}`;
  return (
    <li className={s("entry", depth === 1 ? "entryNested" : "entryRoot", "entryOwn")}>
      <article className={s("entryBody")} aria-labelledby={headingId}>
        <div className={s("entryHead")}>
          <p id={headingId} className={s("entryAuthor")}>
            <OwnMark />
            <span className={s("authorName")}>{identityName}</span>
            {verified ? <span className={s("muted", "small")}>{identityDescriptor}</span> : null}
            {replyingTo === undefined ? null : <span className={s("muted", "small")}>{`Replying to ${replyingTo}`}</span>}
          </p>
          <StatePill tone="success" icon="decision-approve">
            Sent
          </StatePill>
          <button type="button" className={s("timeButton")} aria-expanded={open} onClick={() => { onDetails(open ? undefined : reply.id); }}>
            <Stamp iso={reply.publishedAt} previous={previous} />
            <span className="wk-sr-only">{open ? ", hide details" : ", show details"}</span>
          </button>
        </div>
        <p className={s("entryText")}>{reply.text}</p>
        <p className={s("muted", "small")}>Sent from Wrenkind</p>
        {open ? (
          <dl className={s("facts", "entryFacts")} aria-label="Details of this reply">
            <dt>Published as</dt>
            <dd>{verified ? `${identityName} (${identityDescriptor.toLowerCase()})` : identityDescriptor}</dd>
            <dt>Requested in Wrenkind by</dt>
            <dd>{requesterOf(reply, readModel)}</dd>
            <dt>Requested</dt>
            <dd>
              <Exact iso={reply.requestedAt} />
            </dd>
            <dt>Published on {platform}</dt>
            <dd>
              <Exact iso={reply.publishedAt} />
            </dd>
          </dl>
        ) : null}
      </article>
    </li>
  );
}

/* ───────────── prototype controls and the capability reference (not product UI) ───────────── */

function PrototypeBar({ role, mode, actions, layout, theme, readModel, assess, allHealthy, matrixOpen, matrixRef, onRole, onMode, onActions, onTheme, onLayout, onReadModel, onAssess, onAllHealthy, onMatrix, onReset }: {
  readonly role: Role;
  readonly mode: Mode;
  readonly actions: ActionsMode;
  readonly layout: Layout;
  readonly theme: ThemeChoice;
  readonly readModel: ReadModel;
  readonly assess: boolean;
  readonly allHealthy: boolean;
  readonly matrixOpen: boolean;
  readonly matrixRef: RefObject<HTMLDetailsElement | null>;
  readonly onRole: (role: Role) => void;
  readonly onMode: (mode: Mode) => void;
  readonly onActions: (actions: ActionsMode) => void;
  readonly onLayout: (layout: Layout) => void;
  readonly onTheme: (theme: ThemeChoice) => void;
  readonly onReadModel: (readModel: ReadModel) => void;
  readonly onAssess: (assess: boolean) => void;
  readonly onAllHealthy: (allHealthy: boolean) => void;
  readonly onMatrix: (open: boolean) => void;
  readonly onReset: () => void;
}) {
  const id = useId();
  return (
    <section className={s("protoBar")} aria-label="Prototype controls">
      <p className={s("protoNote")}>
        <span className={s("protoFlag")}>Prototype</span>
        <span>{actions === "simulate" ? "Facebook and Instagram actions are simulated in this tab. Nothing is sent to Meta, saved, or seen by anyone else. Synthetic data." : "Actions are shown as Wrenkind has them today. Nothing is sent, saved, or seen by anyone else. Synthetic data."}</span>
      </p>
      <div className={s("protoControls")}>
        <span className={s("protoField")}>
          <label htmlFor={`${id}-role`}>Role</label>
          <select id={`${id}-role`} className={s("select")} value={role} onChange={(event) => { onRole(event.target.value as Role); }}>
            {ROLES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </span>
        <span className={s("protoField")}>
          <label htmlFor={`${id}-mode`}>Workspace</label>
          <select id={`${id}-mode`} className={s("select")} value={mode} onChange={(event) => { onMode(event.target.value as Mode); }}>
            <option value="standard">Standard</option>
            <option value="monitor">Monitor-only</option>
          </select>
        </span>
        <span className={s("protoField")}>
          <label htmlFor={`${id}-actions`}>Actions</label>
          <select id={`${id}-actions`} className={s("select")} value={actions} onChange={(event) => { onActions(event.target.value as ActionsMode); }}>
            <option value="simulate">Simulated (what Meta documents)</option>
            <option value="today">As in Wrenkind today</option>
          </select>
        </span>
        <span className={s("protoField")}>
          <label htmlFor={`${id}-layout`}>Layout</label>
          <select id={`${id}-layout`} className={s("select")} value={layout} onChange={(event) => { onLayout(event.target.value as Layout); }}>
            <option value="split">Two panels</option>
            <option value="expand">Expandable list</option>
          </select>
        </span>
        <span className={s("protoField")}>
          <label htmlFor={`${id}-theme`}>Theme</label>
          <select id={`${id}-theme`} className={s("select")} value={theme} onChange={(event) => { onTheme(event.target.value as ThemeChoice); }}>
            {THEME_CHOICES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </span>
        <details className={s("protoMore")}>
          <summary className={s("protoMoreSummary")}>Scenario</summary>
          <div className={s("protoControls")}>
            <span className={s("protoField")}>
              <label htmlFor={`${id}-data`}>Read model</label>
              <select id={`${id}-data`} className={s("select")} value={readModel} onChange={(event) => { onReadModel(event.target.value as ReadModel); }}>
                <option value="planned">Planned (account names)</option>
                <option value="today">Today</option>
              </select>
            </span>
            <span className={s("protoField")}>
              <label htmlFor={`${id}-assess`}>Assessments</label>
              <select id={`${id}-assess`} className={s("select")} value={assess ? "examples" : "none"} onChange={(event) => { onAssess(event.target.value === "examples"); }}>
                <option value="none">None yet (as today)</option>
                <option value="examples">Synthetic examples</option>
              </select>
            </span>
            <span className={s("protoField")}>
              <label htmlFor={`${id}-health`}>Connections</label>
              <select id={`${id}-health`} className={s("select")} value={allHealthy ? "healthy" : "data"} onChange={(event) => { onAllHealthy(event.target.value === "healthy"); }}>
                <option value="data">One needs attention</option>
                <option value="healthy">All healthy</option>
              </select>
            </span>
          </div>
        </details>
        <button type="button" className={s("btn", "btnSmall")} onClick={onReset} aria-describedby={`${id}-reset`} title="Restores labels, simulated actions, drafts, the filter and the selection. Role, workspace, actions, layout, theme and scenario stay as chosen.">
          Reset data
        </button>
        <span id={`${id}-reset`} className="wk-sr-only">
          Restores labels, simulated actions, drafts, the filter and the selection. Role, workspace, actions, layout, theme and scenario stay as chosen.
        </span>
      </div>
      <details
        ref={matrixRef}
        className={s("matrix")}
        open={matrixOpen}
        onToggle={(event) => { onMatrix(event.currentTarget.open); }}
      >
        <summary className={s("matrixSummary")}>What&apos;s real and what&apos;s simulated</summary>
        <CapabilityMatrix />
      </details>
    </section>
  );
}

function CapabilityMatrix() {
  return (
    <div className={s("matrixBody")}>
      <table className={s("matrixTable")}>
        <caption className={s("matrixCaption")}>
          Comment actions: what Meta documents (Graph API v27.0 reference — Wrenkind targets v25.0), what Wrenkind has built, and what this prototype simulates. A documented action is not an enabled one.
        </caption>
        <thead>
          <tr>
            <th scope="col">Action</th>
            <th scope="col">Platform</th>
            <th scope="col">Meta documentation</th>
            <th scope="col">Wrenkind today</th>
            <th scope="col">This prototype</th>
          </tr>
        </thead>
        <tbody>
          {CAPABILITIES.map((row) => (
            <tr key={`${row.action}-${row.platform}`} data-meta={row.meta} data-simulation={row.simulation}>
              <th scope="row">{row.name}</th>
              <td data-label="Platform">{row.platform === "facebook" ? "Facebook" : "Instagram"}</td>
              <td data-label="Meta documentation">
                <span className={s("docState")}>{metaDocText(row.meta)}</span>
                <span className={s("muted", "small", "docNote")}>{row.metaNote}</span>
              </td>
              <td data-label="Wrenkind today">{wrenkindText(row.wrenkind)}</td>
              <td data-label="This prototype">{row.simulation === "simulated" ? <SimBadge>{PROTOTYPE_TEXT.simulated}</SimBadge> : PROTOTYPE_TEXT.not_offered}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className={s("matrixNotes")}>
        <li>Nothing here is enabled in Wrenkind: the only built path, Instagram public reply, is turned off, and every other action needs implementation and validation first.</li>
        <li>Moderating comments on ads (Facebook ads that never ran as Page posts, Instagram ads) needs validation before it is offered.</li>
        <li>Private replies need messaging permissions Wrenkind doesn&apos;t hold, and Wrenkind has no message inbox.</li>
        <li>
          There is no Mute. Silencing notifications in Wrenkind, blocking an author on Facebook and hiding an author&apos;s future comments automatically are three different capabilities; the last is out of scope, and complaints are never hidden
          automatically.
        </li>
      </ul>
    </div>
  );
}
