"use client";
/**
 * Comments experience redesign — DEVELOPMENT ONLY, synthetic data, local state only.
 *
 * Step UX-04: the integrated interactive workspace of UX-03.1 — two panels (list + active conversation), the views
 * Needs attention · Open · Assigned to me · Escalated · Done, search with two quick filters (Platform, Label) and a
 * Filters menu, a three-zone conversation header (identity and context · management · navigation), conversation
 * management (assign, Urgent, escalate, notes, Done with a resolution, Reopen), manual labels assigned at a comment and
 * managed in Settings, the comment's platform actions (Reply · Reply privately · Hide/Unhide · More), deliberate
 * confirmations, and Details as an overlay drawer. Every action changes one shared state, so list membership, counts,
 * statuses, Previous / Next and the activity all follow.
 *
 * Every Facebook and Instagram action here is a SIMULATION in this component's React state: nothing reaches a server
 * action, a pipeline, a database, the network or a platform, and everything disappears on reload. A simulated
 * operation stays Sending until a person presses one of the prototype's answers — no timer, no request. Conversation
 * management, attention and labels are prototype HYPOTHESES (design/phase-7b/comments-redesign/UX04-DECISION-REGISTER.md),
 * not approved product rules. The rules are the pure functions in ./model.ts.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Logo } from "@/ui/brand/logo";
import { Icon } from "@/ui/icons/icon";
import { OriginMark, StatePill } from "@/ui/primitives";
import { LocalTime, LocalTimeStamp } from "@/ui/time/local-time";
import { ACCOUNTS, ESCALATION_TARGETS, MEMBERS, POSTS, SEED_ASSIGNMENTS, SEED_LABELS, WORKSPACE, type Account, type Comment, type Conversation, type Label, type Marker, type SentReply } from "./fixtures";
import {
  ATTENTION_REASONS,
  CAPABILITIES,
  DEFAULT_MARKER,
  MARKERS,
  ME_MEMBER,
  NO_FILTERS,
  PAGE_SIZE,
  PRIVATE_REPLY_DAYS,
  PROTOTYPE_TEXT,
  ROLES,
  SEED_SIM,
  SEED_WORKFLOW,
  SORTS,
  TARGETS,
  THEME_ATTRIBUTE,
  THEME_CHOICES,
  VIEWS,
  abilitiesOf,
  accountOf,
  activeFilters,
  addNote,
  answerOp,
  assignConversation,
  attentionOf,
  audienceWritesAgain,
  authorHistory,
  authorKey,
  availabilityOf,
  closeEscalation,
  commenterName,
  confirmsBeforeRetry,
  contextNotice,
  conversationAuthor,
  conversationLabels,
  conversationsWithLabel,
  countOf,
  countText,
  createLabel,
  deleteLabel,
  doneBlocker,
  escalateConversation,
  findLabelByName,
  flowFor,
  fullUtc,
  historyOf,
  labelCounts,
  labelUsage,
  labelsOn,
  latestOf,
  leavingNote,
  listOf,
  listedIn,
  logActivity,
  markDone,
  manageProblemText,
  markerName,
  markerOf,
  memberOf,
  menuFilterCount,
  metaDocText,
  normalizeName,
  nowOf,
  opActivityText,
  opAvailability,
  opSentence,
  opStatusText,
  opStatusTone,
  ownIdentity,
  platformName,
  positionOf,
  postOf,
  previewOf,
  privateReplyClosingSoon,
  privateReplyWindow,
  quietStateOf,
  reopenConversation,
  replyTargetOf,
  requesterOf,
  resolutionAfterReply,
  resolutionChoices,
  resolutionName,
  retryable,
  setAssigned,
  setUrgent,
  shortUtc,
  sortName,
  sortedLabels,
  sourceText,
  startOp,
  threadOf,
  unresolvedReplies,
  updateLabel,
  valueOf,
  viewCounts,
  viewName,
  viewOf,
  withPin,
  withFilter,
  withoutFilter,
  withoutKey,
  wrenkindText,
  type ActionId,
  type ActionsMode,
  type Availability,
  type Filters,
  type Flow,
  type LabelState,
  type Mode,
  type OpAnswer,
  type OpKind,
  type Operation,
  type Pin,
  type ReadModel,
  type Resolution,
  type Role,
  type SimState,
  type Sort,
  type SourceFilter,
  type ThemeChoice,
  type ThreadEntry,
  type View,
  type WorkContext,
  type Workflow,
  type WorkflowResult,
} from "./model";
import styles from "./prototype.module.css";

const s = (...names: readonly (string | false | undefined)[]): string =>
  names
    .filter((name): name is string => typeof name === "string" && name !== "")
    .map((name) => valueOf(styles, name) ?? "")
    .join(" ");

const INITIAL_LABELS: LabelState = { labels: SEED_LABELS, assignments: SEED_ASSIGNMENTS, nextId: 1 };

type ConfirmAction = "delete" | "block" | "unblock";
type PanelKind = "labels" | "create" | "more" | "private" | "confirm" | "reason";
interface PanelState {
  readonly commentId: string;
  readonly kind: PanelKind;
  readonly confirm?: ConfirmAction;
  readonly reason?: string;
}
type Panel = PanelState | undefined;
/** The conversation-level popovers of the header (management) — never mixed with a comment's menus. */
type ConvPanel = "assign" | "escalate" | "done" | "more" | undefined;
type Surface = "comments" | "settings";
type SettingsPage = "labels" | "intelligence";
interface Toast {
  readonly id: string;
  readonly index: number;
  readonly text: string;
}
interface DetailsState {
  /** The comment or published reply shown. */
  readonly id: string;
  /** The id of the control that opened it: focus goes back there on close. */
  readonly returnTo: string;
}

/** Everything a conversation and its comments read and do, passed down as one value. */
interface Bench {
  readonly role: Role;
  readonly mode: Mode;
  readonly actions: ActionsMode;
  readonly readModel: ReadModel;
  readonly allHealthy: boolean;
  readonly labels: LabelState;
  readonly sim: SimState;
  readonly wf: Workflow;
  readonly panel: Panel;
  readonly details: DetailsState | undefined;
  readonly replyTarget: string | undefined;
  readonly drafts: Readonly<Record<string, string>>;
  readonly privateDrafts: Readonly<Record<string, string>>;
  readonly onPanel: (panel: Panel) => void;
  readonly onDetails: (details: DetailsState | undefined) => void;
  readonly onReply: (conversation: Conversation, comment: Comment) => void;
  readonly onReplyClose: () => void;
  readonly onDraft: (commentId: string, text: string) => void;
  readonly onPrivateDraft: (commentId: string, text: string) => void;
  readonly onAssign: (conversation: Conversation, commentId: string, owner: string, labelId: string, assigned: boolean) => boolean;
  readonly onCreate: (conversation: Conversation, name: string, commentId: string, owner: string, addHere: boolean, marker: Marker) => string | undefined;
  /** Starts a simulated operation after revalidating it against the current state; false when it was refused. */
  readonly onStart: (conversation: Conversation, comment: Comment, kind: OpKind, text?: string) => boolean;
  readonly onAnswer: (opId: string, answer: OpAnswer) => void;
}

/** A member's name for a narrow control: as written when short; otherwise first name and the initial of the last. */
const compactName = (name: string): string => {
  if (name.length <= 16) return name;
  const words = name.split(" ");
  const last = words.at(-1) ?? "";
  return words.length < 2 ? `${name.slice(0, 15)}…` : `${words[0] ?? ""} ${last.slice(0, 1)}.`;
};

const healthOf = (account: Account | undefined, allHealthy: boolean): Account["health"] => (allHealthy || account === undefined ? "healthy" : account.health);

/* ───────────── time ───────────── */

function Stamp({ iso, previous }: { readonly iso: string; readonly previous?: string | undefined }) {
  return <LocalTimeStamp iso={iso} label={shortUtc(iso, previous)} full={fullUtc(iso)} {...(previous === undefined ? {} : { previous })} className={s("time")} />;
}

const Exact = ({ iso }: { readonly iso: string }) => (
  <time dateTime={iso}>
    <LocalTime iso={iso} form="full" fallback={fullUtc(iso)} />
  </time>
);

/* ───────────── small pieces ───────────── */

/**
 * Recognizable glyphs the kit does not have yet, drawn in the kit's 16px / 1.5 stroke so they sit with it.
 * Prototype-only: a kit addition would be a brand decision.
 */
type GlyphName = "eye" | "eyeOff" | "trash" | "ban" | "thumb" | "envelope" | "tag" | "flag" | "check" | "chevronLeft" | "chevronRight" | "chevronDown" | "info";
const GLYPH_PATHS: { readonly [G in GlyphName]: readonly string[] } = {
  eye: ["M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z", "M8 10a2 2 0 100-4 2 2 0 000 4z"],
  eyeOff: ["M2 2l12 12", "M6.6 3.7A6.8 6.8 0 018 3.5c4.1 0 6.5 4.5 6.5 4.5a11 11 0 01-1.9 2.4", "M4.2 4.9C2.4 6.1 1.5 8 1.5 8s2.4 4.5 6.5 4.5c1.1 0 2.1-.3 3-.8", "M6.6 6.6a2 2 0 002.8 2.8"],
  trash: ["M2.5 4.5h11", "M6 4.5V3a1 1 0 011-1h2a1 1 0 011 1v1.5", "M3.8 4.5l.7 9a1 1 0 001 .9h5a1 1 0 001-.9l.7-9", "M6.8 7v5M9.2 7v5"],
  ban: ["M8 14.5a6.5 6.5 0 100-13 6.5 6.5 0 000 13z", "M3.4 3.4l9.2 9.2"],
  thumb: ["M5 7l2.5-5a1.6 1.6 0 011.6 1.9L8.6 6.5H13a1.3 1.3 0 011.3 1.5l-.9 5.2a1.3 1.3 0 01-1.3 1.1H5z", "M5 7H2.5v7.3H5"],
  envelope: ["M2 3.5h12v9H2z", "M2 4l6 4.5L14 4"],
  tag: ["M2 2.5h5.3l6.2 6.2-4.8 4.8-6.2-6.2V2.5z", "M5 5.3h.01"],
  flag: ["M3.5 14.5v-12", "M3.5 2.5h8l-1.6 3 1.6 3h-8"],
  check: ["M3 8.5l3 3 7-7"],
  chevronLeft: ["M10 3.5L5.5 8l4.5 4.5"],
  chevronRight: ["M6 3.5L10.5 8 6 12.5"],
  chevronDown: ["M4 6l4 4 4-4"],
  info: ["M8 14.5a6.5 6.5 0 100-13 6.5 6.5 0 000 13z", "M8 7.2v4", "M8 5h.01"],
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

function SimMarker({ icon, children }: { readonly icon: "estado-lock" | "decision-approve" | "decision-reject" | "util-close"; readonly children: string }) {
  return (
    <span className={s("simMarker")}>
      <Icon name={icon} size={16} />
      <span>{children}</span>
      <span className={s("simMarkerTag")}> (simulated)</span>
    </span>
  );
}

/**
 * A label's marker (PO-approved shape and palette, Manual v1.1 Amendment 2): a compact solid tag, the one presentation
 * used wherever a label appears — sidebar, rows, chips, picker, creation and Settings. Its fill is the workspace
 * label's color, drawn by the stylesheet from the palette identifier through the theme token (never a color value
 * here). Decorative: the label's name is always written beside it.
 */
function LabelMarker({ marker }: { readonly marker: Marker }) {
  return (
    <svg className={s("marker")} data-marker={marker} width="14" height="10" viewBox="0 0 14 10" aria-hidden="true" focusable="false">
      <path d="M1.6 .6h7.7c.5 0 .9.2 1.2.6l2.7 3.3c.2.3.2.7 0 1l-2.7 3.3c-.3.4-.7.6-1.2.6H1.6c-.6 0-1-.4-1-1V1.6c0-.6.4-1 1-1z" />
    </svg>
  );
}

function Avatar({ memberId }: { readonly memberId: string | undefined }) {
  const member = memberOf(memberId);
  return (
    <span className={s("avatar", member === undefined && "avatarEmpty")} aria-hidden="true">
      {member === undefined ? "–" : member.initials}
    </span>
  );
}

/* ───────────── the page ───────────── */

export function CommentsRedesign() {
  const [role, setRole] = useState<Role>("manager");
  const [mode, setMode] = useState<Mode>("standard");
  const [actions, setActions] = useState<ActionsMode>("simulate");
  const [theme, setTheme] = useState<ThemeChoice>("system");
  const [readModel, setReadModel] = useState<ReadModel>("planned");
  const [allHealthy, setAllHealthy] = useState(false);
  const [target, setTarget] = useState(240);
  const [labels, setLabels] = useState<LabelState>(INITIAL_LABELS);
  const [sim, setSim] = useState<SimState>(SEED_SIM);
  const [wf, setWf] = useState<Workflow>(SEED_WORKFLOW);
  const [surface, setSurface] = useState<Surface>("comments");
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("labels");
  const [view, setView] = useState<View>("attention");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("attention");
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [pin, setPin] = useState<Pin | undefined>(undefined);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [panel, setPanel] = useState<Panel>(undefined);
  const [convPanel, setConvPanel] = useState<ConvPanel>(undefined);
  const [details, setDetails] = useState<DetailsState | undefined>(undefined);
  const [replyTarget, setReplyTarget] = useState<string | undefined>(undefined);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [privateDrafts, setPrivateDrafts] = useState<Readonly<Record<string, string>>>({});
  const [kept, setKept] = useState<readonly string[]>([]);
  const [toast, setToast] = useState<Toast | undefined>(undefined);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  /** Where focus goes after the selected conversation changed (Previous / Next keep it on the same control: M-1). */
  const [focusTarget, setFocusTarget] = useState<{ readonly id: string; readonly nav?: "previous" | "next" } | undefined>(undefined);
  const shellRef = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const titleRef = useRef<HTMLHeadingElement>(null);
  const abilities = abilitiesOf(role);

  const ctx: WorkContext = { labels, wf, sim, allHealthy, target };
  const counts = viewCounts(ctx);
  const base = listOf(view, filters, query, sort, ctx);
  const shown = withPin(base, pin, wf);
  const selected = selectedId === undefined ? undefined : shown.find((conversation) => conversation.id === selectedId);
  const selectedIndex = selected === undefined ? -1 : shown.indexOf(selected);
  const visible = shown.slice(0, Math.max(limit, selectedIndex + 1));
  const labelTally = labelCounts(labels);
  const chips = activeFilters(filters, labels);
  const narrowed = chips.length > 0 || query.trim() !== "";

  useEffect(() => {
    if (focusTarget === undefined) return;
    const pane = shellRef.current?.querySelector<HTMLElement>(`#focus-${focusTarget.id}`);
    const nav = focusTarget.nav === undefined ? null : (pane?.querySelector<HTMLButtonElement>(`[data-nav="${focusTarget.nav}"]:not(:disabled)`) ?? null);
    const heading = pane?.querySelector<HTMLElement>(`#pane-${focusTarget.id}`) ?? null;
    (nav ?? heading)?.focus({ preventScroll: true });
  }, [focusTarget]);

  // Theme: the product's override attribute on <html>, set only while Light or Dark is chosen here and put back when
  // the choice returns to System or the prototype closes. Nothing is persisted.
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
    setConvPanel(undefined);
    setDetails(undefined);
    setReplyTarget(undefined);
  };

  /**
   * Select a conversation (or none). The one that was selected may have left the view through what someone did to it
   * (replied, marked done, removed a label): it stayed in place while it was selected and leaves now, with a short note
   * that says where it is and a way back.
   */
  const select = (id: string | undefined, options: { readonly nav?: "previous" | "next"; readonly index?: number } = {}): void => {
    closePanels();
    const leaving = selectedId;
    if (leaving !== undefined && leaving !== id && !listedIn(base, leaving)) {
      const gone = shown.find((conversation) => conversation.id === leaving);
      if (gone !== undefined) {
        const flow = flowFor(wf, leaving);
        const text = `${conversationAuthor(gone)} left ${narrowed ? "this filtered list" : viewName(view)}. ${flow.status === "done" ? `It's Done · ${resolutionName(flow.resolution)}.` : "It's still Open."}`;
        setToast({ id: leaving, index: shown.indexOf(gone), text });
        announce(text);
      }
    }
    setSelectedId(id);
    if (id === undefined) {
      setPin(undefined);
      return;
    }
    const at = base.findIndex((conversation) => conversation.id === id);
    setPin({ id, index: at >= 0 ? at : (options.index ?? 0) });
    setFocusTarget({ id, ...(options.nav === undefined ? {} : { nav: options.nav }) });
  };

  /**
   * A new view, filter, search or sort: the list is recomputed; the selected conversation stays when it is still listed,
   * otherwise the selection clears and says why (never a stale conversation in a list that no longer holds it).
   */
  const reframe = (next: { readonly view?: View; readonly filters?: Filters; readonly query?: string; readonly sort?: Sort }, options: { readonly ctx?: WorkContext; readonly lead?: string } = {}): void => {
    const nextView = next.view ?? view;
    const nextFilters = next.filters ?? filters;
    const nextQuery = next.query ?? query;
    const nextSort = next.sort ?? sort;
    const list = listOf(nextView, nextFilters, nextQuery, nextSort, options.ctx ?? ctx);
    setView(nextView);
    setFilters(nextFilters);
    setQuery(nextQuery);
    setSort(nextSort);
    setLimit(PAGE_SIZE);
    setToast(undefined);
    if (selectedId !== undefined) {
      const at = list.findIndex((conversation) => conversation.id === selectedId);
      if (at >= 0) setPin({ id: selectedId, index: at });
      else {
        closePanels();
        setSelectedId(undefined);
        setPin(undefined);
      }
    }
    const left = selectedId !== undefined && !listedIn(list, selectedId);
    announce(`${options.lead === undefined ? "" : `${options.lead} `}${viewName(nextView)}: ${String(list.length)} ${list.length === 1 ? "conversation" : "conversations"}${left ? ". The conversation you had open isn't in this list, so nothing is selected." : ""}`);
  };

  const goSettings = (page: SettingsPage): void => {
    closePanels();
    setSurface("settings");
    setSettingsPage(page);
  };

  /** Escape in the conversation keeps it selected and returns focus to its row (or its title when the list is hidden). */
  const leavePane = (id: string): void => {
    const row = rows.current.get(id);
    row?.focus();
    if (row === undefined || row.ownerDocument.activeElement !== row) shellRef.current?.querySelector<HTMLElement>(`#pane-${id}`)?.focus();
  };

  const manage = (result: WorkflowResult): boolean => {
    if (!result.ok) {
      announce(`Not changed: ${result.reason}`);
      return false;
    }
    setWf(result.wf);
    announce(result.message);
    return true;
  };

  const assign = (conversation: Conversation, commentId: string, owner: string, labelId: string, on: boolean): boolean => {
    const name = labels.labels.find((label) => label.id === labelId)?.name ?? "";
    const next = setAssigned(labels, role, commentId, labelId, on);
    if (next === labels) {
      announce(abilitiesOf(role).assign ? `No change: ${owner} ${on ? "already has" : "doesn't have"} the label ${name}.` : "Not changed: your role can't change labels.");
      return false;
    }
    setLabels(next);
    const text = on ? `Label ${name} added to ${owner}` : `Label ${name} removed from ${owner}`;
    setWf(logActivity(wf, conversation.id, text));
    announce(text);
    return true;
  };

  const create = (conversation: Conversation, raw: string, commentId: string, owner: string, addHere: boolean, marker: Marker): string | undefined => {
    const result = createLabel(labels, role, raw, addHere ? commentId : undefined, marker);
    if (!result.ok) return manageProblemText(result.problem);
    setLabels(result.state);
    const color = markerOf(result.label) === DEFAULT_MARKER ? "" : ` (${markerName(markerOf(result.label))})`;
    const text = addHere ? `Workspace label ${result.label.name}${color} created and added to ${owner}` : `Workspace label ${result.label.name}${color} created`;
    setWf(logActivity(wf, conversation.id, text));
    announce(text);
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
    const where = account === undefined ? undefined : replyTargetOf(conversation, comment, account.platform);
    if (where?.answering !== undefined && (valueOf(drafts, comment.id) ?? "") === "") setDrafts((current) => ({ ...current, [comment.id]: `@${where.answering ?? ""} ` }));
  };

  const start = (conversation: Conversation, comment: Comment, kind: OpKind, text?: string): boolean => {
    const account = accountOf(conversation.accountId);
    if (account === undefined) return false;
    // Revalidated now, from the current role, mode, actions setting, connection and comment state — whatever panel or
    // button asked for it (UX4 H-1). Monitor-only stays strictly non-mutating, in simulation too.
    const check = opAvailability({ role, mode, actions, accountHealth: healthOf(account, allHealthy), conversation, comment, sim }, kind);
    if (check.kind !== "available") {
      setPanel(undefined);
      announce(check.kind === "unavailable" ? `Not done: ${check.reason}` : "Not done: this action isn't available to you.");
      return false;
    }
    const where = kind === "reply" ? replyTargetOf(conversation, comment, account.platform) : { commentId: comment.id };
    const author = kind === "block" || kind === "unblock" ? authorKey(account.id, comment) : undefined;
    const logged = logActivity(wf, conversation.id, opActivityText(kind, "sending", comment.author.kind === "own" ? "your account" : commenterName(comment)));
    const result = startOp(sim, {
      kind,
      conversationId: conversation.id,
      // Where the platform receives it (Instagram: the top-level comment) and, separately, the exact comment answered.
      commentId: where.commentId,
      targetId: comment.id,
      at: nowOf(logged),
      ...(text === undefined ? {} : { text }),
      ...(where.answering === undefined ? {} : { answering: where.answering }),
      ...(author === undefined ? {} : { author }),
    });
    setSim(result.sim);
    setWf(logged);
    setPanel(undefined);
    const op = result.sim.ops.find((item) => item.id === result.id);
    if (op !== undefined) announce(opSentence(op, platformName(account)));
    return true;
  };

  const answer = (opId: string, value: OpAnswer): void => {
    const next = answerOp(sim, opId, value);
    if (next === sim) return;
    setSim(next);
    const op = next.ops.find((item) => item.id === opId);
    if (op === undefined) return;
    const conversation = shown.find((item) => item.id === op.conversationId) ?? base.find((item) => item.id === op.conversationId);
    const comment = conversation?.comments.find((item) => item.id === op.commentId);
    const who = comment === undefined ? "a" : comment.author.kind === "own" ? "your account" : commenterName(comment);
    setWf(logActivity(wf, op.conversationId, opActivityText(op.kind, op.status, who), "Simulated platform"));
    const account = conversation === undefined ? undefined : accountOf(conversation.accountId);
    announce(`${opStatusText(op.status)}. ${opSentence(op, account === undefined ? "the platform" : platformName(account))}`);
  };

  const reset = (): void => {
    setLabels(INITIAL_LABELS);
    setSim(SEED_SIM);
    setWf(SEED_WORKFLOW);
    setView("attention");
    setFilters(NO_FILTERS);
    setQuery("");
    setSort("attention");
    setSelectedId(undefined);
    setPin(undefined);
    setLimit(PAGE_SIZE);
    closePanels();
    setDrafts({});
    setPrivateDrafts({});
    setKept([]);
    setToast(undefined);
    setFiltersOpen(false);
    setSurface("comments");
    announce("Prototype data reset: labels, workflow, simulated actions, drafts, view, filters and selection. Controls unchanged.");
  };

  const bench: Bench = {
    role,
    mode,
    actions,
    readModel,
    allHealthy,
    labels,
    sim,
    wf,
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

  const position = selected === undefined ? undefined : positionOf(shown, selected.id);

  return (
    <div ref={shellRef} className={s("shell", details !== undefined && "drawerOpen")}>
      <a href="#comments-main" className={s("skip")}>
        Skip to comments
      </a>
      <header className={s("rail")}>
        <nav aria-label="Main navigation">
          <ul className={s("railList")}>
            <li>
              <button type="button" className={s("railItem")} aria-current={surface === "comments" ? "page" : undefined} onClick={() => { setSurface("comments"); }}>
                <Icon name="nav-inbox" size={20} />
                <span>Comments</span>
              </button>
            </li>
            <li>
              <button type="button" className={s("railItem")} aria-current={surface === "settings" ? "page" : undefined} onClick={() => { goSettings(settingsPage); }}>
                <Icon name="nav-settings" size={20} />
                <span>Settings</span>
              </button>
            </li>
          </ul>
        </nav>
      </header>

      {!abilities.view ? (
        <aside className={s("sidebar")} aria-label="Workspace">
          <WorkspaceBlock />
        </aside>
      ) : surface === "settings" ? (
        <SettingsSidebar page={settingsPage} onPage={(page) => { setSettingsPage(page); }} />
      ) : (
        <Sidebar
          view={view}
          counts={counts}
          labels={labels}
          labelTally={labelTally}
          activeLabel={filters.label}
          canManageLabels={abilities.create}
          onView={(next) => { reframe({ view: next }); }}
          onLabel={(labelId) => { reframe({ filters: withFilter(filters, "label", filters.label === labelId ? undefined : labelId) }); }}
          onManage={() => { goSettings("labels"); }}
        />
      )}

      <main id="comments-main" className={s("main")} tabIndex={-1}>
        <PrototypeBar
          role={role}
          mode={mode}
          actions={actions}
          theme={theme}
          readModel={readModel}
          allHealthy={allHealthy}
          target={target}
          selected={selected === undefined ? undefined : conversationAuthor(selected)}
          onRole={(next) => {
            setRole(next);
            if (!abilitiesOf(next).create && surface === "settings") announce("Your new role can't manage labels: Settings is read-only.");
          }}
          onMode={setMode}
          onActions={setActions}
          onTheme={setTheme}
          onReadModel={setReadModel}
          onAllHealthy={setAllHealthy}
          onTarget={setTarget}
          onArrive={() => {
            if (selected === undefined) return;
            setWf(audienceWritesAgain(wf, selected));
            announce(`${conversationAuthor(selected)} wrote again (simulated).`);
          }}
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
        ) : surface === "settings" ? (
          settingsPage === "labels" ? (
            <SettingsLabels
              labels={labels}
              role={role}
              onSave={(labelId, raw, marker) => {
                const label = labels.labels.find((item) => item.id === labelId);
                const before = label?.name ?? "";
                const colorBefore = label === undefined ? DEFAULT_MARKER : markerOf(label);
                // Name and color together, revalidated now (role, name rules, palette): all or nothing.
                const result = updateLabel(labels, role, labelId, raw, marker);
                if (!result.ok) return manageProblemText(result.problem);
                setLabels(result.state);
                const updated = result.state.labels.find((item) => item.id === labelId);
                const after = updated?.name ?? "";
                const colorAfter = updated === undefined ? DEFAULT_MARKER : markerOf(updated);
                const said: string[] = [];
                if (after !== before) {
                  let next = wf;
                  for (const id of conversationsWithLabel(labels, labelId)) next = logActivity(next, id, `Label ${before} renamed to ${after} in Settings`);
                  setWf(next);
                  said.push(`Label ${before} renamed to ${after}.`);
                }
                // A color is presentation: every appearance follows at once; no conversation's activity changes.
                if (colorAfter !== colorBefore) said.push(colorAfter === DEFAULT_MARKER ? `Label ${after} reset to gray.` : `Label ${after} is now ${markerName(colorAfter)}.`);
                if (said.length > 0) announce(said.join(" "));
                return undefined;
              }}
              onDelete={(labelId) => {
                const name = labels.labels.find((label) => label.id === labelId)?.name ?? "";
                const result = deleteLabel(labels, role, labelId);
                if (!result.ok) {
                  announce("Not deleted: your role can't manage labels.");
                  return;
                }
                setLabels(result.state);
                let next = wf;
                for (const id of conversationsWithLabel(labels, labelId)) next = logActivity(next, id, `Label ${name} deleted in Settings · removed from this conversation's comments`);
                setWf(next);
                const said = `Label ${name} deleted. It was removed from ${String(result.removedFrom?.length ?? 0)} comments; no comment was deleted.`;
                // A Label filter on it ends: the list is recomputed from the new labels, so the selected conversation
                // keeps its true place (or is cleared and said), never the position it had in the filtered list (UX-05).
                if (filters.label === labelId) reframe({ filters: withFilter(filters, "label", undefined) }, { ctx: { ...ctx, labels: result.state, wf: next }, lead: said });
                else announce(said);
              }}
              onCreate={(raw, marker) => {
                const result = createLabel(labels, role, raw, undefined, marker);
                if (!result.ok) return manageProblemText(result.problem);
                setLabels(result.state);
                announce(`Workspace label ${result.label.name}${markerOf(result.label) === DEFAULT_MARKER ? "" : ` (${markerName(markerOf(result.label))})`} created`);
                return undefined;
              }}
            />
          ) : (
            <SettingsIntelligence />
          )
        ) : (
          <>
            <header className={s("listHeader")}>
              <div className={s("listTitleRow")}>
                <h1 ref={titleRef} className={s("title")} tabIndex={-1}>
                  {viewName(view)} <span className={s("titleCount")}>{countOf(counts, view)}</span>
                </h1>
                <Coverage allHealthy={allHealthy} />
              </div>
              <ViewPicker view={view} counts={counts} onView={(next) => { reframe({ view: next }); }} />
            </header>

            <section className={s("sheet")} aria-label={`${viewName(view)} conversations`} data-menu-bound="">
              <Toolbar
                query={query}
                filters={filters}
                labels={labels}
                sort={sort}
                view={view}
                filtersOpen={filtersOpen}
                onQuery={(next) => { reframe({ query: next }); }}
                onFilters={(next) => { reframe({ filters: next }); }}
                onSort={(next) => { reframe({ sort: next }); }}
                onFiltersOpen={setFiltersOpen}
                results={base.length}
              />
              {narrowed ? (
                <div className={s("activeRow")}>
                  <p className={s("results")}>
                    <strong>{`${String(base.length)} ${base.length === 1 ? "result" : "results"}`}</strong>
                    <span className={s("muted")}>{` in ${viewName(view)}`}</span>
                  </p>
                  <ul className={s("activeChips")} aria-label="Active filters">
                    {query.trim() === "" ? null : (
                      <li className={s("fpill")}>
                        <span className={s("muted")}>Search:</span>
                        <span>{`“${query.trim()}”`}</span>
                        <button type="button" className={s("fpillRemove")} aria-label="Clear the search" onClick={() => { reframe({ query: "" }); }}>
                          <Icon name="util-close" size={16} />
                        </button>
                      </li>
                    )}
                    {chips.map((chip) => (
                      <li key={chip.key} className={s("fpill")}>
                        <span className={s("muted")}>{`${chip.name}:`}</span>
                        <span className={s("fpillValue")}>{chip.value}</span>
                        <button type="button" className={s("fpillRemove")} aria-label={`Remove the filter ${chip.name}: ${chip.value}`} onClick={() => { reframe({ filters: withoutFilter(filters, chip.key) }); }}>
                          <Icon name="util-close" size={16} />
                        </button>
                      </li>
                    ))}
                  </ul>
                  <span className={s("narrowSummary")}>{`${String(chips.length + (query.trim() === "" ? 0 : 1))} active`}</span>
                  <button type="button" className={s("linkButton")} onClick={() => { reframe({ filters: NO_FILTERS, query: "" }); }}>
                    Clear all
                  </button>
                </div>
              ) : null}

              <div className={s("split", selected !== undefined && "splitActive")}>
                <div className={s("listColumn")}>
                  {shown.length === 0 ? (
                    <div className={s("empty")}>
                      <p>{narrowed ? `No conversation in ${viewName(view)} matches.` : view === "attention" ? "Nothing needs attention right now." : `No conversations in ${viewName(view)}.`}</p>
                      {narrowed ? (
                        <button type="button" className={s("btn", "btnSmall")} onClick={() => { reframe({ filters: NO_FILTERS, query: "" }); }}>
                          Clear search and filters
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <ul className={s("list")} aria-label={viewName(view)}>
                      {visible.map((conversation, index) => (
                        <Row
                          key={conversation.id}
                          conversation={conversation}
                          previousLatest={index === 0 ? undefined : latestOf(visible.at(index - 1) as Conversation)}
                          selected={conversation.id === selectedId}
                          leaving={conversation.id === selectedId && !listedIn(base, conversation.id) ? leavingNote(conversation, view, ctx) : undefined}
                          ctx={ctx}
                          readModel={readModel}
                          register={(element) => {
                            if (element === null) rows.current.delete(conversation.id);
                            else rows.current.set(conversation.id, element);
                          }}
                          onSelect={() => { select(conversation.id); }}
                        />
                      ))}
                    </ul>
                  )}
                  {shown.length > visible.length ? (
                    <button type="button" className={s("btn", "showMore")} onClick={() => { setLimit(limit + PAGE_SIZE); }}>
                      {`Show ${String(Math.min(PAGE_SIZE, shown.length - visible.length))} more of ${String(shown.length - visible.length)}`}
                    </button>
                  ) : null}
                  {toast === undefined ? null : (
                    // Said once, through the page's single live region (select() announces it): the toast itself is silent.
                    <div className={s("toast")}>
                      <Icon name="decision-approve" size={16} />
                      <span>{toast.text}</span>
                      <button
                        type="button"
                        className={s("toastAction")}
                        onClick={() => {
                          const back = toast;
                          setToast(undefined);
                          select(back.id, { index: back.index });
                        }}
                      >
                        Show
                      </button>
                      <button type="button" className={s("toastClose")} aria-label="Dismiss" onClick={() => { setToast(undefined); }}>
                        <Icon name="util-close" size={16} />
                      </button>
                    </div>
                  )}
                </div>
                {selected === undefined ? (
                  <section className={s("pane", "paneEmpty")} aria-label="Conversation">
                    <p className={s("muted")}>Select a conversation to read it here.</p>
                  </section>
                ) : (
                  // Keyed by conversation (UX4 H-2): a new conversation mounts a fresh panel (post details closed, scroll at
                  // the top, no drawer) while the prototype's state stays where it lives.
                  <ConversationPane
                    key={selected.id}
                    conversation={selected}
                    view={view}
                    listName={narrowed ? "this filtered list" : viewName(view)}
                    position={position}
                    bench={bench}
                    ctx={ctx}
                    convPanel={convPanel}
                    nudge={flowFor(wf, selected.id).status === "open" && !kept.includes(selected.id) && doneBlocker(selected.id, sim) === undefined && unresolvedReplies(selected.id, sim).length === 0 ? resolutionAfterReply(selected.id, sim) : undefined}
                    leaving={!listedIn(base, selected.id)}
                    onConvPanel={setConvPanel}
                    onManage={manage}
                    onKeep={() => {
                      setKept([...kept, selected.id]);
                      announce("Kept open.");
                    }}
                    onMove={(id, nav) => { select(id, { nav }); }}
                    onBack={() => {
                      const id = selected.id;
                      select(undefined);
                      rows.current.get(id)?.focus();
                    }}
                    onEscape={() => { leavePane(selected.id); }}
                  />
                )}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

/* ───────────── sidebar, view picker, coverage ───────────── */

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

/**
 * Views (workflow) and labels (a shortcut to the Label filter). Intelligence has no place here while it is not active
 * (UX-03.1): its discovery is Settings › Intelligence.
 */
function Sidebar({ view, counts, labels, labelTally, activeLabel, canManageLabels, onView, onLabel, onManage }: {
  readonly view: View;
  readonly counts: Readonly<Record<View, number>>;
  readonly labels: LabelState;
  readonly labelTally: Readonly<Record<string, number>>;
  readonly activeLabel: string | undefined;
  readonly canManageLabels: boolean;
  readonly onView: (view: View) => void;
  readonly onLabel: (labelId: string) => void;
  readonly onManage: () => void;
}) {
  return (
    <aside className={s("sidebar")} aria-label="Workspace">
      <WorkspaceBlock />
      <nav className={s("sideNav")} aria-label="Comments views">
        <ul className={s("sideList")}>
          {VIEWS.map((item) => (
            <li key={item.id}>
              <button type="button" className={s("sideItem")} aria-current={view === item.id ? "page" : undefined} onClick={() => { onView(item.id); }}>
                <span className={s("sideItemName")}>{item.name}</span>
                {item.id === "done" ? null : <span className={s("count", item.id === "attention" && "countStrong")}>{countOf(counts, item.id)}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className={s("sideGroup")}>
          <div className={s("sideHead")}>
            <p className={s("eyebrow")} id="side-labels">
              Labels
            </p>
            {canManageLabels ? (
              <button type="button" className={s("linkButton", "small")} onClick={onManage}>
                Manage
              </button>
            ) : null}
          </div>
          {labels.labels.length === 0 ? <p className={s("muted", "small", "sideEmpty")}>No labels yet.</p> : null}
          <ul className={s("sideList")} aria-labelledby="side-labels">
            {sortedLabels(labels.labels).map((label) => (
              <li key={label.id}>
                <button type="button" className={s("sideItem")} aria-pressed={activeLabel === label.id} onClick={() => { onLabel(label.id); }}>
                  <LabelMarker marker={markerOf(label)} />
                  <span className={s("sideItemName")}>{label.name}</span>
                  <span className={s("count")}>{countText(labelTally, label.id)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </nav>
    </aside>
  );
}

function SettingsSidebar({ page, onPage }: { readonly page: SettingsPage; readonly onPage: (page: SettingsPage) => void }) {
  return (
    <aside className={s("sidebar")} aria-label="Workspace">
      <WorkspaceBlock />
      <nav className={s("sideNav")} aria-label="Settings">
        <p className={s("eyebrow")}>Settings</p>
        <ul className={s("sideList")}>
          <li>
            <button type="button" className={s("sideItem")} aria-current={page === "labels" ? "page" : undefined} onClick={() => { onPage("labels"); }}>
              <span className={s("sideItemName")}>Labels</span>
            </button>
          </li>
          <li>
            <button type="button" className={s("sideItem")} aria-current={page === "intelligence" ? "page" : undefined} onClick={() => { onPage("intelligence"); }}>
              <span className={s("sideItemName")}>Intelligence</span>
              <span className={s("futureTag")}>Not active</span>
            </button>
          </li>
        </ul>
      </nav>
    </aside>
  );
}

/** Below 1024 px the sidebar is gone: the same views in one native select above the list. */
function ViewPicker({ view, counts, onView }: { readonly view: View; readonly counts: Readonly<Record<View, number>>; readonly onView: (view: View) => void }) {
  const id = useId();
  return (
    <div className={s("viewPicker")}>
      <label htmlFor={id} className="wk-sr-only">
        View
      </label>
      <select id={id} className={s("select", "viewSelect")} value={view} onChange={(event) => { onView(VIEWS.find((item) => item.id === event.target.value)?.id ?? "attention"); }}>
        {VIEWS.map((item) => (
          <option key={item.id} value={item.id}>{item.id === "done" ? item.name : `${item.name} (${String(countOf(counts, item.id))})`}</option>
        ))}
      </select>
    </div>
  );
}

function Coverage({ allHealthy }: { readonly allHealthy: boolean }) {
  const attention = ACCOUNTS.filter((account) => healthOf(account, allHealthy) === "needs_attention");
  return (
    <details className={s("coverage")}>
      <summary className={s("coverageSummary")}>
        {attention.length > 0 ? <Icon name="estado-alert" size={16} /> : null}
        <span>
          <span className={s("coverageLong")}>
            Read through <Stamp iso="2026-11-17T14:52:00Z" />
          </span>
          {attention.length > 0 ? <span>{` · ${String(attention.length)} account needs reconnecting`}</span> : null}
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

/* ───────────── toolbar: search, two quick filters, Filters, sort ───────────── */

function Toolbar({ query, filters, labels, sort, view, filtersOpen, results, onQuery, onFilters, onSort, onFiltersOpen }: {
  readonly query: string;
  readonly filters: Filters;
  readonly labels: LabelState;
  readonly sort: Sort;
  readonly view: View;
  readonly filtersOpen: boolean;
  readonly results: number;
  readonly onQuery: (query: string) => void;
  readonly onFilters: (filters: Filters) => void;
  readonly onSort: (sort: Sort) => void;
  readonly onFiltersOpen: (open: boolean) => void;
}) {
  const id = useId();
  const filtersButton = useRef<HTMLButtonElement>(null);
  const inMenu = menuFilterCount(filters);
  const total = inMenu + (filters.platform === undefined ? 0 : 1) + (filters.label === undefined ? 0 : 1);
  const close = (): void => {
    onFiltersOpen(false);
    filtersButton.current?.focus();
  };
  return (
    <div className={s("toolbar")} role="search">
      <span className={s("searchField")}>
        <Icon name="util-search" size={16} />
        <label htmlFor={`${id}-q`} className="wk-sr-only">
          Search comments and authors
        </label>
        <input
          id={`${id}-q`}
          type="search"
          className={s("input", "searchInput")}
          placeholder="Search comments and authors"
          value={query}
          autoComplete="off"
          onChange={(event) => { onQuery(event.target.value); }}
        />
      </span>
      <span className={s("quickFilters")}>
        <label htmlFor={`${id}-platform`} className="wk-sr-only">
          Platform
        </label>
        <select id={`${id}-platform`} className={s("select", "quick", filters.platform !== undefined && "quickSet")} value={filters.platform ?? ""} onChange={(event) => { onFilters(withFilter(filters, "platform", event.target.value === "facebook" ? "facebook" : event.target.value === "instagram" ? "instagram" : undefined)); }}>
          <option value="">All platforms</option>
          <option value="facebook">Facebook</option>
          <option value="instagram">Instagram</option>
        </select>
        <label htmlFor={`${id}-label`} className="wk-sr-only">
          Label
        </label>
        <select id={`${id}-label`} className={s("select", "quick", filters.label !== undefined && "quickSet")} value={filters.label ?? ""} onChange={(event) => { onFilters(withFilter(filters, "label", event.target.value === "" ? undefined : event.target.value)); }}>
          <option value="">Any label</option>
          {sortedLabels(labels.labels).map((label) => (
            <option key={label.id} value={label.id}>
              {label.name}
            </option>
          ))}
        </select>
      </span>
      <button ref={filtersButton} type="button" className={s("btn", "filtersButton", filtersOpen && "filtersButtonOpen")} aria-expanded={filtersOpen} aria-controls={`${id}-menu`} onClick={() => { onFiltersOpen(!filtersOpen); }}>
        <Icon name="util-filter" size={16} />
        <span>Filters</span>
        {inMenu > 0 ? <span className={s("badge", "badgeDesktop")}>{inMenu}</span> : null}
        {total > 0 ? <span className={s("badge", "badgePhone")}>{total}</span> : null}
        <span className="wk-sr-only">{total > 0 ? `, ${String(total)} applied` : ""}</span>
      </button>
      <span className={s("sortField")}>
        <label htmlFor={`${id}-sort`} className={s("muted", "small")}>
          Sort
        </label>
        <select id={`${id}-sort`} className={s("select", "sortSelect")} value={view === "done" && sort === "attention" ? "newest" : sort} onChange={(event) => { onSort(SORTS.find((item) => item.id === event.target.value)?.id ?? "attention"); }}>
          {SORTS.filter((item) => view !== "done" || item.id !== "attention").map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </span>
      {filtersOpen ? <FilterMenu id={`${id}-menu`} filters={filters} labels={labels} view={view} results={results} onFilters={onFilters} onClose={close} /> : null}
      <span className="wk-sr-only">{`Sorted by ${sortName(view === "done" && sort === "attention" ? "newest" : sort)}`}</span>
    </div>
  );
}

const SOURCES: readonly { readonly id: SourceFilter | ""; readonly name: string }[] = [
  { id: "", name: "Any" },
  { id: "organic", name: "Organic" },
  { id: "paid", name: "Paid" },
  { id: "mixed", name: "Both" },
  { id: "unknown", name: "Not reported" },
];

/**
 * The less frequent filters. Every change applies at once (the list and its count follow); the footer says how many
 * conversations match. On a phone it is a full sheet and also holds Platform and Label.
 */
function FilterMenu({ id, filters, labels, view, results, onFilters, onClose }: {
  readonly id: string;
  readonly filters: Filters;
  readonly labels: LabelState;
  readonly view: View;
  readonly results: number;
  readonly onFilters: (filters: Filters) => void;
  readonly onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => heading.current?.focus(), []);
  useKeptInside(panel);
  const set = <K extends Exclude<keyof Filters, "accounts">>(key: K, value: Filters[K] | undefined): void => { onFilters(withFilter(filters, key, value)); };
  const toggleAccount = (accountId: string, on: boolean): void => { onFilters({ ...filters, accounts: on ? [...filters.accounts, accountId] : filters.accounts.filter((item) => item !== accountId) }); };
  return (
    <div
      ref={panel}
      id={id}
      className={s("popover", "filterMenu")}
      role="dialog"
      aria-labelledby={`${id}-title`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className={s("menuHead")}>
        <h2 id={`${id}-title`} ref={heading} className={s("menuTitle")} tabIndex={-1}>
          Filters
        </h2>
        <button type="button" className={s("iconButton")} aria-label="Close filters" onClick={onClose}>
          <Icon name="util-close" size={16} />
        </button>
      </div>
      <div className={s("filterBody")}>
        <fieldset className={s("filterSet", "phoneOnly")}>
          <legend>Platform</legend>
          <div className={s("segmented")}>
            {([["", "All"], ["facebook", "Facebook"], ["instagram", "Instagram"]] as const).map(([value, name]) => (
              <label key={value} className={s("segment")}>
                <input type="radio" name={`${id}-platform`} checked={(filters.platform ?? "") === value} onChange={() => { set("platform", value === "" ? undefined : value); }} />
                <span>{name}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className={s("filterSet", "phoneOnly")}>
          <legend>Label</legend>
          <select className={s("select")} aria-label="Label" value={filters.label ?? ""} onChange={(event) => { set("label", event.target.value === "" ? undefined : event.target.value); }}>
            <option value="">Any label</option>
            {sortedLabels(labels.labels).map((label) => (
              <option key={label.id} value={label.id}>
                {label.name}
              </option>
            ))}
          </select>
        </fieldset>
        <fieldset className={s("filterSet")}>
          <legend>Account</legend>
          {ACCOUNTS.map((account) => (
            <label key={account.id} className={s("check")}>
              <input type="checkbox" checked={filters.accounts.includes(account.id)} onChange={(event) => { toggleAccount(account.id, event.target.checked); }} />
              <OriginMark platform={account.platform} name={platformName(account)} />
              <span>{account.verifiedName ?? `Your ${platformName(account)} account`}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className={s("filterSet")}>
          <legend>Organic or paid</legend>
          <div className={s("segmented")}>
            {SOURCES.map((item) => (
              <label key={item.id} className={s("segment")}>
                <input type="radio" name={`${id}-source`} checked={(filters.source ?? "") === item.id} onChange={() => { set("source", item.id === "" ? undefined : item.id); }} />
                <span>{item.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className={s("filterSet")}>
          <legend>Assignee</legend>
          <select className={s("select")} aria-label="Assignee" value={filters.assignee ?? ""} onChange={(event) => { set("assignee", event.target.value === "" ? undefined : event.target.value); }}>
            <option value="">Anyone</option>
            <option value="unassigned">Unassigned</option>
            {MEMBERS.map((member) => (
              <option key={member.id} value={member.id}>
                {member.id === ME_MEMBER.id ? `${member.name} (you)` : member.name}
              </option>
            ))}
          </select>
        </fieldset>
        <fieldset className={s("filterSet")}>
          <legend>Latest activity</legend>
          <div className={s("segmented")}>
            {([["", "Any time"], ["day", "Last 24 hours"], ["week", "Last 7 days"]] as const).map(([value, name]) => (
              <label key={value} className={s("segment")}>
                <input type="radio" name={`${id}-date`} checked={(filters.date ?? "") === value} onChange={() => { set("date", value === "" ? undefined : (value)); }} />
                <span>{name}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className={s("filterSet")}>
          <legend>Post</legend>
          <select className={s("select")} aria-label="Post" value={filters.post ?? ""} onChange={(event) => { set("post", event.target.value === "" ? undefined : event.target.value); }}>
            <option value="">Any post</option>
            {POSTS.map((post) => (
              <option key={post.id} value={post.id}>
                {`${post.kind} · ${post.caption ?? "Post not read yet"}`}
              </option>
            ))}
          </select>
        </fieldset>
        {view === "done" ? null : (
          <fieldset className={s("filterSet")}>
            <legend>Why it needs attention</legend>
            <select className={s("select")} aria-label="Why it needs attention" value={filters.reason ?? ""} onChange={(event) => { set("reason", ATTENTION_REASONS.find((item) => item.id === event.target.value)?.id); }}>
              <option value="">Any</option>
              {ATTENTION_REASONS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </fieldset>
        )}
      </div>
      <div className={s("menuFoot")}>
        <button type="button" className={s("linkButton")} onClick={() => { onFilters({ ...NO_FILTERS }); }}>
          Clear all
        </button>
        <button type="button" className={s("btn", "btnPrimary")} onClick={onClose}>
          {`Show ${String(results)} ${results === 1 ? "result" : "results"}`}
        </button>
      </div>
    </div>
  );
}

/* ───────────── a row of the list ───────────── */

function Row({ conversation, previousLatest, selected, leaving, ctx, readModel, register, onSelect }: {
  readonly conversation: Conversation;
  readonly previousLatest: string | undefined;
  readonly selected: boolean;
  /** Selected, but no longer in the list (it stays until the selection moves): why, in a few words. */
  readonly leaving: string | undefined;
  readonly ctx: WorkContext;
  readonly readModel: ReadModel;
  readonly register: (element: HTMLButtonElement | null) => void;
  readonly onSelect: () => void;
}) {
  const anchor = conversation.comments[0] as Comment;
  const account = accountOf(conversation.accountId);
  const accountName = account === undefined ? "Unknown account" : readModel === "planned" && account.verifiedName !== null ? account.verifiedName : platformName(account);
  const flow = flowFor(ctx.wf, conversation.id);
  const attention = attentionOf(conversation, ctx);
  const quiet = flow.status === "open" ? quietStateOf(conversation, ctx) : undefined;
  const ids = conversationLabels(ctx.labels, conversation);
  const names = ids.map((id) => ctx.labels.labels.find((label) => label.id === id)).filter((label): label is Label => label !== undefined);
  const presence = viewOf(ctx.sim, conversation.accountId, anchor).presence;
  const excerpt = presence === "removed" ? "Removed from the platform" : presence === "deleted" ? "Deleted (simulated)" : anchor.text;
  return (
    <li className={s("row", selected && "rowSelected", leaving !== undefined && "rowLeaving")}>
      <h2 className={s("rowHeading")}>
        <button ref={register} id={`row-${conversation.id}`} type="button" className={s("rowButton")} aria-current={selected ? "true" : undefined} onClick={onSelect}>
          <span className={s("rowTop")}>
            {account === undefined ? null : <OriginMark platform={account.platform} name={platformName(account)} />}
            <span className={s("rowAuthor")}>{conversationAuthor(conversation)}</span>
            <span className={s("rowAccount")}>{`on ${accountName}`}</span>
            <span className={s("rowTime")}>
              <span className="wk-sr-only">Latest activity </span>
              <Stamp iso={latestOf(conversation)} previous={previousLatest} />
            </span>
          </span>
          <span className={s("rowExcerpt", presence !== "present" && "muted")}>{excerpt}</span>
          <span className={s("rowMeta")}>
            {leaving !== undefined ? (
              <span className={s("quietState")}>
                <Glyph name="check" />
                {leaving}
              </span>
            ) : (
              <>
                {flow.urgent === undefined || flow.status === "done" ? null : (
                  <span className={s("urgentFlag")}>
                    <Glyph name="flag" />
                    Urgent
                  </span>
                )}
                {attention === undefined ? null : (
                  <span className={s("attention", attention.warn && "attentionWarn")}>
                    <Icon name={attention.reason === "new_reply" ? "conv-reply" : attention.reason === "waiting" ? "estado-sla" : attention.reason === "connection" ? "estado-alert" : "estado-sync"} size={16} />
                    <span className="wk-sr-only">Needs attention: </span>
                    {attention.text}
                  </span>
                )}
                {attention === undefined && flow.escalation !== undefined && flow.status === "open" ? (
                  <span className={s("escalated")}>
                    <Icon name="decision-escalate" size={16} />
                    {`Escalated · ${flow.escalation.to}`}
                  </span>
                ) : null}
                {flow.status === "done" ? (
                  <span className={s("doneState")}>
                    <Icon name="decision-approve" size={16} />
                    {`Done · ${resolutionName(flow.resolution)}`}
                  </span>
                ) : null}
                {attention === undefined && flow.escalation === undefined && quiet !== undefined && flow.status === "open" ? <span className={s("quietState")}>{quiet}</span> : null}
              </>
            )}
            <span className={s("rowSpacer")} />
            {names.length === 0 ? null : (
              <span className={s("rowLabels")}>
                <span className="wk-sr-only">{`Labels on comments in this conversation: ${names.map((label) => label.name).join(", ")}.`}</span>
                {names.slice(0, 2).map((label) => (
                  <span key={label.id} className={s("rowLabel")} aria-hidden="true">
                    <LabelMarker marker={markerOf(label)} />
                    {label.name}
                  </span>
                ))}
                {names.length > 2 ? (
                  <span className={s("rowLabel")} aria-hidden="true">
                    {`+${String(names.length - 2)}`}
                  </span>
                ) : null}
              </span>
            )}
            {flow.assignee === undefined ? null : (
              <span className={s("rowAssignee")}>
                <Avatar memberId={flow.assignee} />
                <span className="wk-sr-only">{`Assigned to ${memberOf(flow.assignee)?.name ?? "a member"}`}</span>
              </span>
            )}
          </span>
        </button>
      </h2>
    </li>
  );
}

/* ───────────── the conversation: header (three zones), source, thread, drawer ───────────── */

const SURFACE_TEXT = { feed: "Feed", live: "Live video — comments can only be managed in the Instagram app", story_ad: "Story ad — comments can only be managed in the Instagram app", dark_post: "Ad that never ran as a Page post" } as const;

function ConversationPane({ conversation, view, listName, position, bench, ctx, convPanel, nudge, leaving, onConvPanel, onManage, onKeep, onMove, onBack, onEscape }: {
  readonly conversation: Conversation;
  readonly view: View;
  /** "Needs attention", or "this filtered list" while a search or filter narrows it. */
  readonly listName: string;
  readonly position: ReturnType<typeof positionOf>;
  readonly bench: Bench;
  readonly ctx: WorkContext;
  readonly convPanel: ConvPanel;
  readonly nudge: Resolution | undefined;
  readonly leaving: boolean;
  readonly onConvPanel: (panel: ConvPanel) => void;
  readonly onManage: (result: WorkflowResult) => boolean;
  readonly onKeep: () => void;
  readonly onMove: (id: string, nav: "previous" | "next") => void;
  readonly onBack: () => void;
  readonly onEscape: () => void;
}) {
  const { readModel, sim, allHealthy, actions, mode, role, details, wf } = bench;
  const account = accountOf(conversation.accountId);
  const identity = account === undefined ? undefined : ownIdentity(account, readModel);
  const accountName = account === undefined ? "" : readModel === "planned" && account.verifiedName !== null ? account.verifiedName : platformName(account);
  const notice = contextNotice(conversation, healthOf(account, allHealthy), actions, mode);
  const entries = threadOf(conversation);
  const simReplies = sim.ops.filter((op) => op.kind === "reply" && op.conversationId === conversation.id);
  const platform = account === undefined ? "the platform" : platformName(account);
  const flow = flowFor(wf, conversation.id);
  const attention = attentionOf(conversation, ctx);
  const quiet = flow.status === "open" ? quietStateOf(conversation, ctx) : undefined;
  const abilities = abilitiesOf(role);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const tag = (event.target as HTMLElement).tagName;
    if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
    event.preventDefault();
    onEscape();
  };
  const nav =
    position === undefined ? null : (
      <nav className={s("convNav")} aria-label={`Move through ${viewName(view)}`}>
        <span className={s("mono", "muted")}>
          {`${String(position.index)} of ${String(position.count)}`}
          <span className={s("navView")}>{` in ${viewName(view)}`}</span>
        </span>
        <button type="button" className={s("iconButton")} data-nav="previous" aria-label="Previous conversation" disabled={position.previous === undefined} onClick={() => { if (position.previous !== undefined) onMove(position.previous, "previous"); }}>
          <Glyph name="chevronLeft" />
        </button>
        <button type="button" className={s("iconButton")} data-nav="next" aria-label="Next conversation" disabled={position.next === undefined} onClick={() => { if (position.next !== undefined) onMove(position.next, "next"); }}>
          <Glyph name="chevronRight" />
        </button>
      </nav>
    );
  return (
    <section id={`focus-${conversation.id}`} className={s("pane")} aria-labelledby={`pane-${conversation.id}`} onKeyDown={onKeyDown}>
      <header className={s("paneHead")}>
        <div className={s("paneTop")}>
          <button type="button" className={s("btn", "btnQuiet", "backButton")} onClick={onBack}>
            <Glyph name="chevronLeft" />
            <span>{viewName(view)}</span>
          </button>
          <div className={s("paneIdentity")}>
          <h2 id={`pane-${conversation.id}`} className={s("paneTitle")} tabIndex={-1}>
            {account === undefined ? null : <OriginMark platform={account.platform} name={platformName(account)} />}
            <span>{conversationAuthor(conversation)}</span>
          </h2>
          <span className={s("rowAccount")}>{`on ${accountName}`}</span>
          {flow.status === "open" ? (
            <span className={s("openState")}>Open</span>
          ) : (
            <span className={s("doneState")}>
              <Icon name="decision-approve" size={16} />
              {`Done · ${resolutionName(flow.resolution)}`}
            </span>
          )}
          </div>
          {nav}
        </div>
        <div className={s("paneContext")}>
          <p className={s("statusLine")}>
            {flow.urgent === undefined ? null : (
              <span className={s("urgentFlag")} title={`Marked urgent by ${flow.urgent.by}`}>
                <Glyph name="flag" />
                Urgent
                <span className="wk-sr-only">{` (marked by ${flow.urgent.by})`}</span>
              </span>
            )}
            {attention === undefined ? null : (
              <span className={s("attention", attention.warn && "attentionWarn")}>
                <Icon name={attention.reason === "new_reply" ? "conv-reply" : attention.reason === "waiting" ? "estado-sla" : attention.reason === "connection" ? "estado-alert" : "estado-sync"} size={16} />
                <span className="wk-sr-only">Needs attention: </span>
                {attention.text}
              </span>
            )}
            {flow.escalation === undefined ? null : (
              <span className={s("escalated")}>
                <Icon name="decision-escalate" size={16} />
                {`Escalated · ${flow.escalation.to}`}
              </span>
            )}
            {attention === undefined && quiet !== undefined ? <span className={s("quietState")}>{quiet}</span> : null}
            {leaving ? <span className={s("quietState")}>{`No longer in ${listName} · stays here until you move on`}</span> : null}
          </p>
          {abilities.manage ? <Management conversation={conversation} flow={flow} mode={mode} role={role} wf={wf} sim={sim} panel={convPanel} onPanel={onConvPanel} onManage={onManage} /> : null}
        </div>
      </header>
      <div className={s("bodyWrap")}>
        {/* While Details covers the reading area nothing under it takes focus or clicks (UX-05 M-1). */}
        <div className={s("paneBody")} inert={details !== undefined} data-reading-area="">
          <SourceCard conversation={conversation} identity={identity} />
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
                <SentItem key={entry.reply.id} reply={entry.reply} depth={entry.depth} replyingTo={entry.replyingTo} previous={previous} identityName={identity?.name ?? "Your account"} identityDescriptor={identity?.descriptor ?? "Your account"} verified={identity?.verified ?? false} details={details} onDetails={bench.onDetails} />
              );
            })}
            {simReplies.map((op) => (
              <SimReplyItem key={op.id} op={op} conversation={conversation} identityName={identity?.name ?? "Your account"} platform={platform} onAnswer={bench.onAnswer} />
            ))}
          </ol>
          {nudge === undefined || !abilities.manage ? null : <Nudge resolution={nudge} leaving={leaving} listName={listName} onDone={() => onManage(markDone(wf, role, mode, conversation.id, nudge, sim))} onKeep={onKeep} />}
        </div>
        {details === undefined ? null : <DetailsDrawer conversation={conversation} target={details} bench={bench} onClose={() => { bench.onDetails(undefined); }} />}
      </div>
    </section>
  );
}

const entryTime = (entry: ThreadEntry): string => (entry.kind === "comment" ? entry.comment.at : entry.reply.publishedAt);

/** After a reply is confirmed: a reply is not a resolution — the person decides (hypothesis H-1: no automatic Done). */
function Nudge({ resolution, leaving, listName, onDone, onKeep }: { readonly resolution: Resolution; readonly leaving: boolean; readonly listName: string; readonly onDone: () => void; readonly onKeep: () => void }) {
  return (
    <div className={s("nudge")} role="group" aria-label="After your reply">
      <p className={s("nudgeText")}>
        <Icon name="decision-approve" size={16} />
        <span>
          <strong>Reply sent.</strong> Is the question answered, or is something still pending?
        </span>
      </p>
      <div className={s("inlineActions")}>
        <button type="button" className={s("btn")} onClick={onDone}>
          <Glyph name="check" />
          <span>{`Mark done · ${resolutionName(resolution)}`}</span>
        </button>
        <button type="button" className={s("btn", "btnQuiet")} onClick={onKeep}>
          Keep open
        </button>
      </div>
      <p className={s("muted", "small")}>{leaving ? `It stays in ${listName} until you move on. A reply alone never closes a conversation.` : "A reply alone never closes a conversation."}</p>
    </div>
  );
}

/**
 * Zone B of the header: Assign · Urgent · Escalate | Mark done… · More. Internal to Wrenkind (allowed in Monitor-only);
 * never in a comment's menus. On a phone only the assignee and More stay; More then holds the rest.
 */
function Management({ conversation, flow, mode, role, wf, sim, panel, onPanel, onManage }: {
  readonly conversation: Conversation;
  readonly flow: Flow;
  readonly mode: Mode;
  readonly role: Role;
  readonly wf: Workflow;
  readonly sim: SimState;
  readonly panel: ConvPanel;
  readonly onPanel: (panel: ConvPanel) => void;
  readonly onManage: (result: WorkflowResult) => boolean;
}) {
  const assignRef = useRef<HTMLButtonElement>(null);
  const escalateRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const urgentRef = useRef<HTMLButtonElement>(null);
  const member = memberOf(flow.assignee);
  const open = flow.status === "open";
  // Decided from the current record each time the panel draws (and again by markDone when a choice is pressed).
  const blocker = doneBlocker(conversation.id, sim);
  const choices = resolutionChoices(mode, conversation.id, sim);
  const close = (focus: ConvPanel): void => {
    onPanel(undefined);
    (focus === "assign" ? assignRef : focus === "escalate" ? escalateRef : focus === "done" ? doneRef : moreRef).current?.focus();
  };
  const toggle = (next: Exclude<ConvPanel, undefined>): void => { onPanel(panel === next ? undefined : next); };
  const act = (result: WorkflowResult, focus: ConvPanel): void => {
    onManage(result);
    close(focus);
  };
  return (
    <div className={s("management")} role="group" aria-label="Manage this conversation">
      <span className={s("anchor")}>
        <button ref={assignRef} type="button" className={s("mbtn", "assignButton")} aria-expanded={panel === "assign"} title={member === undefined ? "Assign" : `Assigned to ${member.name}`} onClick={() => { toggle("assign"); }}>
          <Avatar memberId={flow.assignee} />
          {/* A long name is shown compactly, on purpose ("Maximiliana F."); the full name is in the title and the accessible name. */}
          <span className={s("assignName")}>{member === undefined ? "Assign" : compactName(member.name)}</span>
          <span className="wk-sr-only">{member === undefined ? ": unassigned" : `${compactName(member.name) === member.name ? "" : ` (${member.name})`}, assigned — change`}</span>
          <Glyph name="chevronDown" />
        </button>
        {panel === "assign" ? (
          <MenuPanel label="Assign this conversation" onClose={() => { close("assign"); }} wide>
            {(["Management", "Support", "Sales"] as const).map((team) => (
              <div key={team} className={s("menuGroup")}>
                <p className={s("menuHeading")}>{team}</p>
                {MEMBERS.filter((item) => item.team === team).map((item) => (
                  <button key={item.id} type="button" className={s("menuItem")} aria-pressed={flow.assignee === item.id} onClick={() => { act(assignConversation(wf, role, conversation.id, item.id), "assign"); }}>
                    <Avatar memberId={item.id} />
                    <span>{item.id === ME_MEMBER.id ? `${item.name} (you)` : item.name}</span>
                    {flow.assignee === item.id ? <Glyph name="check" /> : null}
                  </button>
                ))}
              </div>
            ))}
            {flow.assignee === undefined ? null : (
              <>
                <div className={s("menuSep")} />
                <button type="button" className={s("menuItem")} onClick={() => { act(assignConversation(wf, role, conversation.id, undefined), "assign"); }}>
                  <Icon name="util-close" size={16} />
                  <span>Unassign</span>
                </button>
              </>
            )}
          </MenuPanel>
        ) : null}
      </span>
      {open ? (
        <button
          ref={urgentRef}
          type="button"
          className={s("mbtn", "mbtnIcon", "desktopOnly", flow.urgent !== undefined && "mbtnPressed")}
          aria-pressed={flow.urgent !== undefined}
          title={flow.urgent === undefined ? "Mark urgent" : `Urgent · marked by ${flow.urgent.by} — press to remove`}
          onClick={() => { onManage(setUrgent(wf, role, conversation.id, flow.urgent === undefined)); }}
        >
          <Glyph name="flag" />
          <span className="wk-sr-only">Urgent</span>
        </button>
      ) : null}
      {open ? (
        <span className={s("anchor", "desktopOnly")}>
          <button ref={escalateRef} type="button" className={s("mbtn", "mbtnIcon")} aria-expanded={panel === "escalate"} title={flow.escalation === undefined ? "Escalate…" : `Escalated to ${flow.escalation.to}`} onClick={() => { toggle("escalate"); }}>
            <Icon name="decision-escalate" size={16} />
            <span className="wk-sr-only">{flow.escalation === undefined ? "Escalate" : `Escalated to ${flow.escalation.to}`}</span>
          </button>
          {panel === "escalate" ? <EscalatePanel flow={flow} onEscalate={(to, note) => { act(escalateConversation(wf, role, conversation.id, to, note), "escalate"); }} onCloseEscalation={() => { act(closeEscalation(wf, role, conversation.id), "escalate"); }} onClose={() => { close("escalate"); }} /> : null}
        </span>
      ) : null}
      <span className={s("mgSep", "desktopOnly")} aria-hidden="true" />
      <span className={s("anchor", "desktopOnly")}>
        {open ? (
          <button ref={doneRef} type="button" className={s("mbtn", "doneButton")} aria-expanded={panel === "done"} aria-haspopup="true" onClick={() => { toggle("done"); }}>
            <Glyph name="check" />
            <span>Mark done</span>
            <Glyph name="chevronDown" />
          </button>
        ) : (
          <button ref={doneRef} type="button" className={s("mbtn")} onClick={() => { onManage(reopenConversation(wf, role, conversation.id)); }}>
            <span>Reopen</span>
          </button>
        )}
        {panel === "done" && open ? <DonePanel choices={choices} blocker={blocker} onDone={(resolution) => { act(markDone(wf, role, mode, conversation.id, resolution, sim), "done"); }} onClose={() => { close("done"); }} /> : null}
      </span>
      <span className={s("anchor")}>
        <button ref={moreRef} type="button" className={s("mbtn", "mbtnIcon")} aria-expanded={panel === "more"} onClick={() => { toggle("more"); }}>
          <Icon name="util-more" size={16} />
          <span className="wk-sr-only">More for this conversation</span>
        </button>
        {panel === "more" ? (
          <ConversationMore
            flow={flow}
            choices={choices}
            blocker={blocker}
            onUrgent={() => { act(setUrgent(wf, role, conversation.id, flow.urgent === undefined), "more"); }}
            onEscalate={(to, note) => { act(escalateConversation(wf, role, conversation.id, to, note), "more"); }}
            onCloseEscalation={() => { act(closeEscalation(wf, role, conversation.id), "more"); }}
            onDone={(resolution) => { act(markDone(wf, role, mode, conversation.id, resolution, sim), "more"); }}
            onReopen={() => { act(reopenConversation(wf, role, conversation.id), "more"); }}
            onNote={(text) => {
              const result = addNote(wf, role, conversation.id, text);
              if (!result.ok) return result.reason;
              act(result, "more");
              return undefined;
            }}
            onClose={() => { close("more"); }}
          />
        ) : null}
      </span>
    </div>
  );
}

/**
 * UX-05: a panel positioned against a control stays inside the visible workspace. It opens under its control; when it
 * would cross the left or right edge of the workspace (the sheet, or the window, whichever is tighter) it slides back
 * in, and when it would pass the bottom its height is limited to the room below, scrolling inside. Measured after
 * every render (a panel changes size between steps). A phone's full-width sheet is fixed and needs none of this.
 */
function useKeptInside(ref: { readonly current: HTMLElement | null }): void {
  useLayoutEffect(() => {
    const panel = ref.current;
    if (panel === null) return;
    panel.style.removeProperty("right");
    panel.style.removeProperty("max-height");
    // A fixed sheet has no offset parent (and an environment without layout may report none).
    const holder = panel.offsetParent as Element | null | undefined;
    if (holder === null || holder === undefined) return;
    const root = panel.ownerDocument.documentElement;
    const bound = panel.closest("[data-menu-bound]")?.getBoundingClientRect();
    const left = Math.max(0, bound?.left ?? 0) + 8;
    const right = Math.min(root.clientWidth, bound?.right ?? root.clientWidth) - 8;
    const bottom = Math.min(root.clientHeight, bound?.bottom ?? root.clientHeight) - 8;
    const box = panel.getBoundingClientRect();
    // The panel's own right offset as its stylesheet placed it, so a slide adds to it rather than replacing it.
    const placed = holder.getBoundingClientRect().right - box.right;
    if (box.right > right) panel.style.right = `${String(Math.ceil(placed + box.right - right))}px`;
    else if (box.left < left) panel.style.right = `${String(Math.floor(placed - (left - box.left)))}px`;
    if (box.bottom > bottom) panel.style.maxHeight = `${String(Math.max(160, Math.floor(bottom - box.y)))}px`;
  });
}

/**
 * UX-05-FINALFIX: a panel that opens inside a comment (labels, create label, More, a confirmation) is brought fully
 * into view when it opens — the reading area (or, below 1024 px, the page) scrolls the least it can — so no action of it
 * starts below the fold. When it is taller than the visible part of the reading area, its height is limited to that
 * and it scrolls inside, its first control (where focus is) at the top. Focus stays where the panel put it.
 */
function useRevealed(ref: { readonly current: HTMLElement | null }): void {
  useEffect(() => {
    const panel = ref.current;
    if (panel === null) return;
    panel.scrollIntoView({ block: "nearest", inline: "nearest" });
    const area = panel.closest("[data-reading-area]")?.getBoundingClientRect();
    const height = panel.ownerDocument.documentElement.clientHeight;
    const roomTop = Math.max(0, area?.y ?? 0) + 8;
    const roomBottom = Math.min(height, area?.bottom ?? height) - 8;
    if (panel.getBoundingClientRect().height <= roomBottom - roomTop) return;
    panel.style.maxHeight = `${String(Math.max(200, Math.floor(roomBottom - roomTop)))}px`;
    panel.style.overflowY = "auto";
    panel.scrollIntoView({ block: "start", inline: "nearest" });
  }, [ref]);
}

/** A small panel under a header control. Escape closes it and returns focus to the control (the owner decides where). */
function MenuPanel({ label, children, onClose, wide = false }: { readonly label: string; readonly children: ReactNode; readonly onClose: () => void; readonly wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // The first control that is actually drawn takes focus: a phone-only item is not drawn on a desktop (UX-05).
  useEffect(() => {
    const controls = ref.current?.querySelectorAll<HTMLElement>("button, input, select, textarea") ?? [];
    [...controls].find((control) => control.getClientRects().length > 0)?.focus();
  }, []);
  useKeptInside(ref);
  // A press anywhere outside the panel and its control closes it (the control itself toggles it).
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const panel = ref.current;
    if (panel === null) return;
    const owner = panel.ownerDocument;
    const onPress = (event: PointerEvent): void => {
      const anchor = panel.parentElement;
      if ((anchor ?? panel).contains(event.target as Node | null)) return;
      closeRef.current();
    };
    owner.addEventListener("pointerdown", onPress);
    return () => { owner.removeEventListener("pointerdown", onPress); };
  }, []);
  return (
    <div
      ref={ref}
      className={s("popover", "menu", "headMenu", wide && "headMenuWide")}
      role="group"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {children}
    </div>
  );
}

type ResolutionChoice = ReturnType<typeof resolutionChoices>[number];

/**
 * Mark done: the resolutions a person may choose now (UX-05 H-2). While a reply's outcome is unknown nothing is
 * offered and the panel says why; a resolution that would claim a reply no confirmed Sent backs is shown unavailable,
 * with its reason, never chosen for the person.
 */
function DonePanel({ choices, blocker, onDone, onClose }: { readonly choices: readonly ResolutionChoice[]; readonly blocker: string | undefined; readonly onDone: (resolution: Resolution) => void; readonly onClose: () => void }) {
  const reasonId = useId();
  const reasons: string[] = [];
  for (const item of choices) if (item.unavailable !== undefined && !reasons.includes(item.unavailable)) reasons.push(item.unavailable);
  if (blocker !== undefined) {
    return (
      <MenuPanel label="Mark done" onClose={onClose} wide>
        <p className={s("menuHeading")}>Not yet</p>
        <p className={s("blockedNote")} role="note">
          <Icon name="estado-sync" size={16} />
          <span>{blocker}</span>
        </p>
        <div className={s("inlineActions")}>
          <button type="button" className={s("btn", "btnSmall")} onClick={onClose}>
            Close
          </button>
        </div>
      </MenuPanel>
    );
  }
  return (
    <MenuPanel label="Mark done as" onClose={onClose}>
      <p className={s("menuHeading")}>Mark done as</p>
      {choices.map((item) =>
        item.unavailable === undefined ? (
          <button key={item.id} type="button" className={s("menuItem")} onClick={() => { onDone(item.id); }}>
            <span>{item.name}</span>
          </button>
        ) : (
          <button key={item.id} type="button" className={s("menuItem", "menuItemUnavailable")} aria-disabled="true" aria-describedby={`${reasonId}-${String(reasons.indexOf(item.unavailable))}`}>
            <Icon name="estado-lock" size={16} />
            <span>{item.name}</span>
          </button>
        ),
      )}
      {reasons.map((reason, index) => (
        <p key={reason} id={`${reasonId}-${String(index)}`} className={s("menuReason")}>
          {reason}
        </p>
      ))}
      <p className={s("menuNote")}>Clears Urgent and closes an open escalation. It reopens by itself if the author writes again.</p>
    </MenuPanel>
  );
}

function EscalatePanel({ flow, onEscalate, onCloseEscalation, onClose }: { readonly flow: Flow; readonly onEscalate: (to: string, note: string) => void; readonly onCloseEscalation: () => void; readonly onClose: () => void }) {
  const [to, setTo] = useState(flow.escalation?.to ?? ESCALATION_TARGETS[0] ?? "");
  const [note, setNote] = useState("");
  const id = useId();
  return (
    <MenuPanel label="Escalate this conversation" onClose={onClose} wide>
      <p className={s("menuHeading")}>{flow.escalation === undefined ? "Escalate to" : `Escalated to ${flow.escalation.to}`}</p>
      <label htmlFor={`${id}-to`} className="wk-sr-only">
        Escalate to
      </label>
      <select id={`${id}-to`} className={s("select")} value={to} onChange={(event) => { setTo(event.target.value); }}>
        {ESCALATION_TARGETS.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-note`} className={s("small", "muted")}>
        Note (optional)
      </label>
      <textarea id={`${id}-note`} className={s("textarea")} rows={2} value={note} maxLength={500} onChange={(event) => { setNote(event.target.value); }} />
      <p className={s("menuNote")}>Escalating hands the conversation on; it doesn&apos;t make it urgent.</p>
      <div className={s("inlineActions")}>
        <button type="button" className={s("btn", "btnPrimary")} onClick={() => { onEscalate(to, note); }}>
          {flow.escalation === undefined ? "Escalate" : "Escalate again"}
        </button>
        {flow.escalation === undefined ? null : (
          <button type="button" className={s("btn")} onClick={onCloseEscalation}>
            Close escalation
          </button>
        )}
        <button type="button" className={s("btn", "btnQuiet")} onClick={onClose}>
          Cancel
        </button>
      </div>
    </MenuPanel>
  );
}

function ConversationMore({ flow, choices, blocker, onUrgent, onEscalate, onCloseEscalation, onDone, onReopen, onNote, onClose }: {
  readonly flow: Flow;
  readonly choices: readonly ResolutionChoice[];
  readonly blocker: string | undefined;
  readonly onUrgent: () => void;
  readonly onEscalate: (to: string, note: string) => void;
  readonly onCloseEscalation: () => void;
  readonly onDone: (resolution: Resolution) => void;
  readonly onReopen: () => void;
  readonly onNote: (text: string) => string | undefined;
  readonly onClose: () => void;
}) {
  const [step, setStep] = useState<"menu" | "note" | "escalate" | "done">("menu");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const id = useId();
  const open = flow.status === "open";
  if (step === "escalate") return <EscalatePanel flow={flow} onEscalate={onEscalate} onCloseEscalation={onCloseEscalation} onClose={onClose} />;
  if (step === "done") return <DonePanel choices={choices} blocker={blocker} onDone={onDone} onClose={onClose} />;
  return (
    <MenuPanel label="More for this conversation" onClose={onClose} wide={step === "note"}>
      {step === "note" ? (
        <>
          <label htmlFor={`${id}-note`} className={s("menuHeading")}>
            Note for the team
          </label>
          <textarea id={`${id}-note`} className={s("textarea")} rows={3} value={note} maxLength={600} aria-describedby={problem === undefined ? undefined : `${id}-problem`} onChange={(event) => { setNote(event.target.value); setProblem(undefined); }} />
          {problem === undefined ? null : (
            <p id={`${id}-problem`} className={s("problem")} role="alert">
              {problem}
            </p>
          )}
          <p className={s("menuNote")}>Internal to Wrenkind: never posted to the platform.</p>
          <div className={s("inlineActions")}>
            <button type="button" className={s("btn", "btnPrimary")} onClick={() => { setProblem(onNote(note)); }}>
              Add note
            </button>
            <button type="button" className={s("btn", "btnQuiet")} onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          {open ? (
            <>
              <button type="button" className={s("menuItem", "phoneOnly")} onClick={() => { setStep("done"); }}>
                <Glyph name="check" />
                <span>Mark done…</span>
              </button>
              <button type="button" className={s("menuItem", "phoneOnly")} aria-pressed={flow.urgent !== undefined} onClick={onUrgent}>
                <Glyph name="flag" />
                <span>{flow.urgent === undefined ? "Mark urgent" : "Remove urgent"}</span>
              </button>
              <button type="button" className={s("menuItem", "phoneOnly")} onClick={() => { setStep("escalate"); }}>
                <Icon name="decision-escalate" size={16} />
                <span>{flow.escalation === undefined ? "Escalate…" : `Escalated to ${flow.escalation.to}…`}</span>
              </button>
            </>
          ) : (
            <button type="button" className={s("menuItem", "phoneOnly")} onClick={onReopen}>
              <span>Reopen</span>
            </button>
          )}
          {flow.escalation === undefined ? null : (
            <button type="button" className={s("menuItem", "desktopOnly")} onClick={onCloseEscalation}>
              <Icon name="util-close" size={16} />
              <span>{`Close escalation to ${flow.escalation.to}`}</span>
            </button>
          )}
          <button type="button" className={s("menuItem")} onClick={() => { setStep("note"); }}>
            <Icon name="decision-draft" size={16} />
            <span>Add note…</span>
          </button>
        </>
      )}
    </MenuPanel>
  );
}

/** The source post as a compact preview: a tile in the post's shape (no media is drawn), its words, its source. */
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
            {preview === undefined ? null : <span className={s("tag")}>{preview.source}</span>}
            {preview?.context === undefined ? null : <span className={s("tag", "tagContext")}>{preview.context}</span>}
            <span className={s("muted", "small")}>{`· ${String(conversation.comments.length)} ${conversation.comments.length === 1 ? "comment" : "comments"} read`}</span>
          </span>
          <span className={s("contextCaption", (post === undefined || post.caption === null) && "muted")}>{post === undefined || post.caption === null ? "Post not read yet" : `“${post.caption}”`}</span>
        </span>
        <span className={s("postMore")}>About this post</span>
      </summary>
      <dl className={s("facts", "postFacts")}>
        <dt>Platform</dt>
        <dd>{account === undefined ? "Unknown" : platformName(account)}</dd>
        <dt>Connected account</dt>
        <dd>{identity === undefined ? "Unknown" : identity.verified ? `${identity.name} (${identity.descriptor.toLowerCase()})` : identity.descriptor}</dd>
        <dt>Posted by</dt>
        <dd>{post === undefined ? "Not read yet" : post.owner === null ? "Your account" : `${post.owner} (your account is tagged)`}</dd>
        {sourceSurface === undefined ? null : (
          <>
            <dt>Where</dt>
            <dd>{sourceSurface}</dd>
          </>
        )}
        <dt>Organic or paid</dt>
        <dd>{sourceText(post?.source)}</dd>
        <dt>Media and link</dt>
        <dd>Not retrieved — no image, video or platform link in this synthetic data</dd>
      </dl>
    </details>
  );
}

/* ───────────── one comment ───────────── */

function CommentItem({ conversation, bench, entry, previous }: { readonly conversation: Conversation; readonly bench: Bench; readonly entry: Extract<ThreadEntry, { kind: "comment" }>; readonly previous: string | undefined }) {
  const { role, mode, actions, readModel, allHealthy, labels, sim, panel, details, replyTarget, drafts, privateDrafts, onPanel, onDetails, onReply, onReplyClose, onDraft, onPrivateDraft, onAssign, onCreate, onStart, onAnswer } = bench;
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
  const panelOpen = panel?.commentId === comment.id ? panel : undefined;
  const moreButton = useRef<HTMLButtonElement>(null);
  const hideButton = useRef<HTMLButtonElement>(null);
  const replyButton = useRef<HTMLButtonElement>(null);
  const privateButton = useRef<HTMLButtonElement>(null);
  const labelButton = useRef<HTMLButtonElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  /** After a label chip is removed: the position whose neighbour takes focus (UX4 M-2). */
  const chipFocus = useRef<number | undefined>(undefined);
  const hideReasonId = useId();
  const health = healthOf(account, allHealthy);
  const availability = (action: ActionId): Availability => availabilityOf({ action, role, mode, actions, accountHealth: health, conversation, comment, sim });
  /** The same decision start() makes, drawn now: a stale confirmation, composer or "Try again" never offers what start() would refuse. */
  const opCheck = (kind: OpKind): Availability => opAvailability({ role, mode, actions, accountHealth: health, conversation, comment, sim }, kind);
  const replyState = availability("reply");
  const hide = availability("hide");
  const privateState = availability("private_reply");
  const replyHere = replyTarget === comment.id;
  const hidden = view.presence === "hidden";
  const timeId = `time-${comment.id}`;
  const closePanel = (focus: "more" | "hide" | "private" | "label"): void => {
    onPanel(undefined);
    (focus === "hide" ? hideButton : focus === "private" ? privateButton : focus === "label" ? labelButton : moreButton).current?.focus();
  };
  const focusAfterOp = (): void => { (hideButton.current ?? moreButton.current)?.focus(); };
  const run = (kind: OpKind, text?: string): boolean => {
    const ok = onStart(conversation, comment, kind, text);
    const target = kind === "reply" ? replyButton : kind === "private_reply" ? privateButton : kind === "hide" || kind === "unhide" ? hideButton : moreButton;
    (target.current ?? moreButton.current)?.focus();
    return ok;
  };
  useEffect(() => {
    const index = chipFocus.current;
    if (index === undefined) return;
    chipFocus.current = undefined;
    const buttons = [...(articleRef.current?.querySelectorAll<HTMLButtonElement>('ul[aria-label="Labels"] button') ?? [])];
    (buttons.at(Math.min(index, buttons.length - 1)) ?? labelButton.current ?? moreButton.current)?.focus();
  }, [ids]);
  const ops = sim.ops.filter((op) => op.commentId === comment.id && op.kind !== "reply" && op.kind !== "private_reply");
  const lastOp = ops.at(-1);
  const privateOps = sim.ops.filter((op) => op.commentId === comment.id && op.kind === "private_reply");
  const headingId = `c-${comment.id}`;
  const rootAuthor = conversation.comments[0] === undefined ? author : conversation.comments[0].author.kind === "own" ? "your account" : commenterName(conversation.comments[0]);
  const target = account === undefined ? { commentId: comment.id } : replyTargetOf(conversation, comment, account.platform);
  const detailsOpen = details?.id === comment.id;

  const onHide = (): void => {
    if (hide.kind === "unavailable") {
      onPanel(panelOpen?.kind === "reason" ? undefined : { commentId: comment.id, kind: "reason", reason: hide.reason });
      return;
    }
    run(hidden ? "unhide" : "hide");
  };
  const onPrivate = (): void => {
    if (privateState.kind === "unavailable") {
      onPanel(panelOpen?.kind === "reason" && panelOpen.reason === privateState.reason ? undefined : { commentId: comment.id, kind: "reason", reason: privateState.reason });
      return;
    }
    onPanel(panelOpen?.kind === "private" ? undefined : { commentId: comment.id, kind: "private" });
  };

  return (
    <li className={s("entry", entry.depth === 0 ? "entryRoot" : "entryNested", own && "entryOwn", detailsOpen && "entryAnchored")}>
      <article ref={articleRef} className={s("entryBody")} aria-labelledby={headingId}>
        <div className={s("entryHead")}>
          <p id={headingId} className={s("entryAuthor")}>
            {own ? <OwnMark /> : null}
            <span className={s("authorName")}>{author}</span>
            {own && identity !== undefined && identity.verified ? <span className={s("muted", "small", "descriptor")}>{identity.descriptor}</span> : null}
            {entry.replyingTo === undefined ? null : <span className={s("muted", "small", "replyingTo")}>{`Replying to ${entry.replyingTo}`}</span>}
          </p>
          <button
            id={timeId}
            type="button"
            className={s("timeButton")}
            aria-expanded={detailsOpen}
            aria-haspopup="dialog"
            onClick={() => { onDetails(detailsOpen ? undefined : { id: comment.id, returnTo: timeId }); }}
          >
            <Stamp iso={comment.at} previous={previous} />
            {comment.editedAt === null ? null : <span className={s("muted", "small")}> · edited</span>}
            <Glyph name="info" />
            <span className="wk-sr-only">{detailsOpen ? ", close details" : ", details and exact times"}</span>
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

        {/* Management: labels are internal to Wrenkind, separate from the platform actions below. */}
        <div className={s("labelZone")}>
          <Chips
            ids={ids}
            state={labels}
            owner={owner}
            onRemove={
              abilities.assign
                ? (labelId) => {
                    chipFocus.current = ids.indexOf(labelId);
                    onAssign(conversation, comment.id, owner, labelId, false);
                  }
                : undefined
            }
          />
          {abilities.assign && view.presence !== "deleted" ? (
            <button ref={labelButton} type="button" className={s("addLabel")} aria-expanded={panelOpen?.kind === "labels" || panelOpen?.kind === "create"} onClick={() => { onPanel(panelOpen?.kind === "labels" || panelOpen?.kind === "create" ? undefined : { commentId: comment.id, kind: "labels" }); }}>
              <Icon name="util-plus" size={16} />
              <span>Label</span>
              <span className="wk-sr-only">{` ${owner}`}</span>
            </button>
          ) : null}
        </div>

        {panelOpen?.kind === "labels" && abilities.assign ? (
          <LabelPicker
            labels={labels}
            assigned={ids}
            canCreate={abilities.create}
            owner={owner}
            onToggle={(labelId, on) => { onAssign(conversation, comment.id, owner, labelId, on); }}
            onCreateStep={() => { onPanel({ commentId: comment.id, kind: "create" }); }}
            onClose={() => { closePanel("label"); }}
          />
        ) : null}
        {panelOpen?.kind === "create" && abilities.create ? (
          <CreateLabelPanel
            owner={owner}
            onCreate={(name, addHere, marker) => onCreate(conversation, name, comment.id, owner, addHere, marker)}
            onBack={() => { onPanel({ commentId: comment.id, kind: "labels" }); }}
            onClose={() => { closePanel("label"); }}
          />
        ) : null}

        <div className={s("actions")} role="group" aria-label={`Actions for ${owner}`}>
          {replyState.kind === "hidden" ? null : (
            <button ref={replyButton} type="button" className={s("action", replyState.kind === "unavailable" && "actionUnavailable")} aria-expanded={replyHere} onClick={() => { onReply(conversation, comment); }}>
              <Icon name={replyState.kind === "unavailable" ? "estado-lock" : "conv-reply"} size={16} />
              <span>Reply</span>
            </button>
          )}
          {privateState.kind === "hidden" ? null : (
            <button ref={privateButton} type="button" className={s("action", "actionPrivate", privateState.kind === "unavailable" && "actionUnavailable")} aria-expanded={panelOpen?.kind === "private"} aria-disabled={privateState.kind === "unavailable" ? "true" : undefined} onClick={onPrivate}>
              {privateState.kind === "unavailable" ? <Icon name="estado-lock" size={16} /> : <Glyph name="envelope" />}
              <span>Reply privately</span>
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
              <strong>Not available here.</strong> {panelOpen.reason}
            </span>
          </p>
        ) : null}

        {lastOp === undefined ? null : (
          <OpLine
            op={lastOp}
            platform={platform}
            canRetry={opCheck(lastOp.kind).kind === "available"}
            onAnswer={onAnswer}
            onRetry={() => {
              // A failed Delete or Block is offered again only through its confirmation (UX-04): never one click.
              if (confirmsBeforeRetry(lastOp.kind)) onPanel({ commentId: comment.id, kind: "confirm", confirm: lastOp.kind === "delete" ? "delete" : lastOp.kind === "block" ? "block" : "unblock" });
              else run(lastOp.kind);
            }}
            onSettled={focusAfterOp}
          />
        )}

        {panelOpen?.kind === "more" ? (
          <MoreMenu
            platform={platform}
            platformId={platformId}
            simulated={actions === "simulate"}
            items={[
              { id: "like", label: view.liked ? "Unlike" : "Like", availability: availability("like"), onSelect: () => { run(view.liked ? "unlike" : "like"); } },
              { id: "delete", label: "Delete comment…", availability: availability("delete"), danger: true, onSelect: () => { onPanel({ commentId: comment.id, kind: "confirm", confirm: "delete" }); } },
              { id: "block", label: view.authorBlocked ? "Unblock author…" : "Block author…", availability: availability("block"), danger: !view.authorBlocked, onSelect: () => { onPanel({ commentId: comment.id, kind: "confirm", confirm: view.authorBlocked ? "unblock" : "block" }); } },
            ]}
            onClose={() => { closePanel("more"); }}
          />
        ) : null}

        {panelOpen?.kind === "confirm" && panelOpen.confirm !== undefined && opCheck(panelOpen.confirm).kind !== "available" ? (
          <StaleNotice availability={opCheck(panelOpen.confirm)} onClose={() => { closePanel("more"); }} />
        ) : null}

        {panelOpen?.kind === "confirm" && panelOpen.confirm !== undefined && opCheck(panelOpen.confirm).kind === "available" ? (
          <ConfirmPanel
            action={panelOpen.confirm}
            author={author}
            page={identity?.name ?? `your ${platform} account`}
            platform={platform}
            onConfirm={() => {
              const kind = panelOpen.confirm;
              if (kind !== undefined) run(kind);
            }}
            onCancel={() => { closePanel("more"); }}
          />
        ) : null}

        {panelOpen?.kind === "private" && opCheck("private_reply").kind !== "available" ? (
          <StaleNotice availability={opCheck("private_reply")} onClose={() => { closePanel("private"); }} />
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
            onClose={() => { closePanel("private"); }}
          />
        ) : null}

        {privateOps.map((op) => (
          <PrivateRecord key={op.id} op={op} author={author} platform={platform} onAnswer={onAnswer} onSettled={focusAfterOp} />
        ))}

        {replyHere && replyState.kind !== "hidden" ? (
          <ReplyArea
            availability={replyState}
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

function Chips({ ids, state, onRemove, owner }: { readonly ids: readonly string[]; readonly state: LabelState; readonly onRemove?: ((labelId: string) => void) | undefined; readonly owner: string }) {
  const found = ids.map((id) => state.labels.find((label) => label.id === id)).filter((label): label is Label => label !== undefined);
  if (found.length === 0) return null;
  return (
    <ul className={s("chips")} aria-label="Labels">
      {found.map((label) => (
        <li key={label.id} className={s("chip")}>
          <LabelMarker marker={markerOf(label)} />
          <span>{label.name}</span>
          {onRemove === undefined ? null : (
            <button type="button" className={s("chipRemove")} onClick={() => { onRemove(label.id); }} aria-label={`Remove label ${label.name} from ${owner}`}>
              <Icon name="util-close" size={16} />
            </button>
          )}
        </li>
      ))}
    </ul>
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
 * Where the person plays the platform: prototype-only, dashed, and named as such. Never focused on its own (no
 * autoFocus, so a second Enter cannot answer by accident). After an answer pressed here, focus moves to the check's
 * first button (No answer → Checking) or, once settled, to the control the owner names (UX4 M-2).
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
  /** "Try again" is offered only when starting that operation again would be allowed now (UX4 H-1). */
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
          if (retry.current === null) onSettled();
          else retry.current.focus();
        }}
      />
      {retryable(op) && canRetry ? (
        <div className={s("inlineActions")}>
          <button ref={retry} type="button" className={s("btn", "btnSmall")} onClick={onRetry}>
            {confirmsBeforeRetry(op.kind) ? "Try again…" : "Try again"}
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
        {op.status === "checking" ? <p className={s("muted", "small")}>It may already be public — in the product, Wrenkind checks with the platform before anything is written again. Nothing is retried automatically.</p> : null}
        {op.status === "failed" ? <p className={s("muted", "small")}>Not published. Write it again yourself if it&apos;s still needed — failed replies are never resent automatically.</p> : null}
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
        <Glyph name="envelope" />
        <span>{`Private reply to ${author}`}</span>
      </p>
      <p className={s("reviewText")}>{op.text ?? ""}</p>
      <OpStatusLine op={op} platform={platform} />
      <SimControls op={op} onAnswer={onAnswer} onSettled={onSettled} />
      {op.status === "checking" ? <p className={s("muted", "small")}>Delivery unknown: it may have been sent. A private reply is never resent automatically, and only one is allowed per comment.</p> : null}
      {op.status === "sent" ? <p className={s("muted", "small")}>{`If ${author} answers, that conversation continues in ${platform}'s own messages — Wrenkind has no message inbox, so it won't appear here.`}</p> : null}
    </div>
  );
}

/* ───────────── labels on one comment: assigning (anyone who works comments) ≠ creating (managers) ───────────── */

function LabelPicker({ labels, assigned, canCreate, owner, onToggle, onCreateStep, onClose }: {
  readonly labels: LabelState;
  readonly assigned: readonly string[];
  readonly canCreate: boolean;
  readonly owner: string;
  readonly onToggle: (labelId: string, on: boolean) => void;
  readonly onCreateStep: () => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  useRevealed(panel);
  const typed = normalizeName(query);
  const exact = typed === "" ? undefined : findLabelByName(labels.labels, typed);
  const matching = sortedLabels(labels.labels).filter((label) => typed === "" || label.name.toLocaleLowerCase("en").includes(typed.toLocaleLowerCase("en")));
  const partial = typed !== "" && exact === undefined && matching.length > 0;
  return (
    <div
      ref={panel}
      className={s("popover", "labelPanel")}
      role="group"
      aria-label={`Labels on ${owner}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <label htmlFor={id} className={s("small", "muted")}>
        {`Labels on ${owner}`}
      </label>
      <input
        id={id}
        className={s("input")}
        value={query}
        maxLength={80}
        autoFocus
        autoComplete="off"
        placeholder="Search labels"
        onChange={(event) => { setQuery(event.target.value); }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          // Enter acts only on an exact name (UX4 M-3) and never creates: creating a workspace label is its own step.
          if (exact !== undefined) onToggle(exact.id, !assigned.includes(exact.id));
        }}
        aria-describedby={partial || (typed !== "" && matching.length === 0) ? `${id}-hint` : undefined}
      />
      {partial ? (
        <p id={`${id}-hint`} className={s("muted", "small")}>
          Pick a label below — Enter only adds an exact name.
        </p>
      ) : null}
      {typed !== "" && matching.length === 0 ? (
        <p id={`${id}-hint`} className={s("muted", "small")}>
          {canCreate ? `No label named “${typed}”. Create it as a workspace label below.` : `No label named “${typed}”. Owners, admins and managers create labels.`}
        </p>
      ) : null}
      {matching.length === 0 ? null : (
        <ul className={s("checkList")}>
          {matching.map((label) => (
            <li key={label.id}>
              <label className={s("check")}>
                <input type="checkbox" checked={assigned.includes(label.id)} onChange={(event) => { onToggle(label.id, event.target.checked); }} />
                <LabelMarker marker={markerOf(label)} />
                <span>{label.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className={s("menuSep")} />
      {canCreate ? (
        <button type="button" className={s("menuItem")} onClick={onCreateStep}>
          <Icon name="util-plus" size={16} />
          <span>Create workspace label…</span>
        </button>
      ) : (
        <p className={s("menuNote")}>Only owners, admins and managers create labels. Use an existing one, or ask them.</p>
      )}
      <div className={s("inlineActions")}>
        <button type="button" className={s("btn", "btnSmall")} onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

/** Creating a label is a workspace decision, separate from labelling one comment. */
function CreateLabelPanel({ owner, onCreate, onBack, onClose }: { readonly owner: string; readonly onCreate: (name: string, addHere: boolean, marker: Marker) => string | undefined; readonly onBack: () => void; readonly onClose: () => void }) {
  const [name, setName] = useState("");
  const [marker, setMarkerChoice] = useState<Marker>(DEFAULT_MARKER);
  const [addHere, setAddHere] = useState(true);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  useRevealed(panel);
  const submit = (): void => {
    const result = onCreate(name, addHere, marker);
    setProblem(result);
    if (result === undefined) onBack();
  };
  return (
    <div
      ref={panel}
      className={s("popover", "labelPanel")}
      role="group"
      aria-labelledby={`${id}-title`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className={s("menuHead")}>
        <button type="button" className={s("iconButton")} aria-label="Back to labels" onClick={onBack}>
          <Glyph name="chevronLeft" />
        </button>
        <p id={`${id}-title`} className={s("menuTitle")}>
          New workspace label
        </p>
      </div>
      <p className={s("scope")}>
        <Glyph name="tag" />
        <span>{`Labels belong to the ${WORKSPACE.name} workspace: everyone here can use it on any comment.`}</span>
      </p>
      <label htmlFor={`${id}-name`} className={s("small")}>
        Name
      </label>
      <input
        id={`${id}-name`}
        className={s("input")}
        value={name}
        maxLength={80}
        autoFocus
        autoComplete="off"
        aria-invalid={problem === undefined ? undefined : "true"}
        aria-describedby={problem === undefined ? undefined : `${id}-problem`}
        onChange={(event) => {
          setName(event.target.value);
          setProblem(undefined);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        }}
      />
      {problem === undefined ? null : (
        <p id={`${id}-problem`} className={s("problem")} role="alert">
          {problem}
        </p>
      )}
      <MarkerPicker value={marker} onChange={setMarkerChoice} legend="Color" />
      <label className={s("check")}>
        <input type="checkbox" checked={addHere} onChange={(event) => { setAddHere(event.target.checked); }} />
        <span>{`Also add it to ${owner}`}</span>
      </label>
      <div className={s("inlineActions")}>
        <button type="button" className={s("btn", "btnPrimary")} onClick={submit}>
          Create label
        </button>
        <button type="button" className={s("btn")} onClick={onBack}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * A workspace label's color (Manual v1.1 Amendment 2): one of the five approved palette identifiers, gray the default.
 * A native radio group — arrow keys move, the choice is announced by name — and each option shows its marker and its
 * name, so the selection never rests on color: the chosen one is checked, outlined and written in heavier type.
 */
function MarkerPicker({ value, onChange, legend, onReset }: { readonly value: Marker; readonly onChange: (marker: Marker) => void; readonly legend: string; readonly onReset?: (() => void) | undefined }) {
  const id = useId();
  return (
    <fieldset className={s("markerPicker")} aria-describedby={`${id}-meaning`}>
      <legend className={s("small")}>{legend}</legend>
      <div className={s("markerOptions")}>
        {MARKERS.map((item) => (
          <label key={item.id} className={s("markerOption")}>
            <input type="radio" name={`${id}-marker`} value={item.id} checked={value === item.id} onChange={() => { onChange(item.id); }} />
            <LabelMarker marker={item.id} />
            <span>{item.id === DEFAULT_MARKER ? `${item.name} (default)` : item.name}</span>
          </label>
        ))}
      </div>
      <p id={`${id}-meaning`} className={s("muted", "small")}>
        Color only helps you recognize a label. It never means priority, urgency, sentiment or attention.
        {onReset === undefined || value === DEFAULT_MARKER ? null : (
          <>
            {" "}
            <button type="button" className={s("linkButton", "small")} onClick={onReset}>
              Reset to gray
            </button>
          </>
        )}
      </p>
    </fieldset>
  );
}

/* ───────────── More: the platform's less frequent actions, destructive ones last ───────────── */

interface MenuItem {
  readonly id: ActionId;
  readonly label: string;
  readonly availability: Availability;
  readonly danger?: boolean;
  readonly onSelect: () => void;
}

const ITEM_GLYPH: { readonly [A in ActionId]: GlyphName } = { private_reply: "envelope", like: "thumb", delete: "trash", block: "ban", reply: "envelope", hide: "eyeOff" };

/**
 * More: only what the platform supports for this comment (Instagram: no Like, no Block — they are not drawn). An
 * action that exists but is unavailable here shows its reason. "Open on" and "Copy link" need a platform link the
 * synthetic data does not have: they say so instead of pretending.
 */
function MoreMenu({ platform, platformId, simulated, items, onClose }: { readonly platform: string; readonly platformId: "facebook" | "instagram"; readonly simulated: boolean; readonly items: readonly MenuItem[]; readonly onClose: () => void }) {
  const reasonId = useId();
  const first = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => first.current?.focus(), []);
  useRevealed(panel);
  const shown = items.filter((item) => item.availability.kind !== "hidden");
  const safe = shown.filter((item) => item.danger !== true && item.id !== "block");
  const destructive = shown.filter((item) => item.danger === true || item.id === "block");
  const reasons: string[] = [];
  for (const item of shown) if (item.availability.kind === "unavailable" && !reasons.includes(item.availability.reason)) reasons.push(item.availability.reason);
  const reasonIdOf = (item: MenuItem): string | undefined => (item.availability.kind === "unavailable" ? `${reasonId}-${String(reasons.indexOf(item.availability.reason))}` : undefined);
  const draw = (item: MenuItem, index: number): ReactNode => (
    <button
      key={item.id}
      ref={index === 0 ? first : undefined}
      type="button"
      className={s("menuItem", item.availability.kind === "unavailable" && "menuItemUnavailable", item.danger === true && item.availability.kind === "available" && "menuItemDanger")}
      aria-disabled={item.availability.kind === "unavailable" ? "true" : undefined}
      aria-describedby={reasonIdOf(item)}
      onClick={() => { if (item.availability.kind === "available") item.onSelect(); }}
    >
      {item.availability.kind === "unavailable" ? <Icon name="estado-lock" size={16} /> : <Glyph name={valueOf(ITEM_GLYPH, item.id) ?? "tag"} />}
      <span>{item.label}</span>
    </button>
  );
  return (
    <div
      ref={panel}
      className={s("popover", "menu")}
      role="group"
      aria-label="More actions"
      data-platform={platformId}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <p className={s("menuHeading", "menuHeadingPlatform")}>
        <span>{`On ${platform}`}</span>
        {simulated ? <SimBadge /> : null}
      </p>
      {safe.map((item, index) => draw(item, index))}
      <button ref={safe.length === 0 ? first : undefined} type="button" className={s("menuItem", "menuItemUnavailable")} aria-disabled="true" aria-describedby={`${reasonId}-link`}>
        <Icon name="util-external" size={16} />
        <span>{`Open on ${platform}`}</span>
      </button>
      <button type="button" className={s("menuItem", "menuItemUnavailable")} aria-disabled="true" aria-describedby={`${reasonId}-link`}>
        <Icon name="util-copy" size={16} />
        <span>Copy link</span>
      </button>
      <p id={`${reasonId}-link`} className={s("muted", "small", "menuReason")}>
        No platform link in this synthetic data.
      </p>
      {destructive.length === 0 ? null : <div className={s("menuSep")} />}
      {destructive.map((item) => draw(item, -1))}
      {reasons.map((reason, index) => (
        <p key={reason} id={`${reasonId}-${String(index)}`} className={s("muted", "small", "menuReason")}>
          {reason}
        </p>
      ))}
    </div>
  );
}

/* ───────────── deliberate confirmation (Delete, Block, Unblock) ───────────── */

function ConfirmPanel({ action, author, page, platform, onConfirm, onCancel }: {
  readonly action: ConfirmAction;
  readonly author: string;
  readonly page: string;
  readonly platform: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const headingId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useRevealed(panel);
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
        : {
            title: `Unblock ${author}?`,
            points: [`They can interact with ${page} on ${platform} again.`, `If you block them again soon after, ${platform} may refuse it for a while.`],
            confirm: "Unblock author",
          };
  return (
    <div
      ref={panel}
      className={s("popover", "confirm", action !== "unblock" && "confirmDanger")}
      role="group"
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
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
      <p className={s("muted", "small")}>{`Simulated: nothing is sent to ${platform}.`}</p>
      <div className={s("inlineActions")}>
        <button type="button" className={s("btn")} autoFocus onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={s("btn", action === "unblock" ? "btnPrimary" : "btnDanger")} onClick={onConfirm}>
          {copy.confirm}
        </button>
      </div>
    </div>
  );
}

/* ───────────── reply: write → review → simulate publishing ───────────── */

function ReplyArea({ availability, author, rootAuthor, platform, identity, draft, onDraft, onPublish, onClose }: {
  readonly availability: Availability;
  readonly author: string;
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
          event.stopPropagation();
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

/* ───────────── private reply: write → review → confirm; one message, within seven days, no inbox ───────────── */

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
  const [stage, setStage] = useState<"write" | "review">("write");
  const id = useId();
  const opening = privateReplyWindow(comment);
  return (
    <div
      className={s("replyArea", "composer", "privateComposer")}
      role="group"
      aria-labelledby={`${id}-heading`}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (stage === "review") setStage("write");
        else onClose();
      }}
    >
      <p id={`${id}-heading`} className={s("composerHeading")}>
        <Glyph name="envelope" />
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
      {stage === "write" ? (
        <>
          <label htmlFor={id} className="wk-sr-only">
            Your private reply
          </label>
          <textarea id={id} className={s("textarea")} rows={3} value={draft} autoFocus onChange={(event) => { onDraft(event.target.value); }} />
          <div className={s("inlineActions")}>
            <button type="button" className={s("btn", "btnPrimary")} disabled={draft.trim() === ""} onClick={() => { setStage("review"); }}>
              Review private reply
            </button>
            <button type="button" className={s("btn")} onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p className={s("reviewText")}>{draft}</p>
          <p className={s("caution")}>
            <Icon name="estado-alert" size={16} />
            <span>{`You can send only one private reply to this comment. Check it before sending.`}</span>
          </p>
          <div className={s("inlineActions")}>
            <button type="button" className={s("btn", "btnSim")} onClick={() => { onSend(draft.trim()); }}>
              Simulate sending
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

/* ───────────── a reply published earlier through Wrenkind ───────────── */

function SentItem({ reply, depth, replyingTo, previous, identityName, identityDescriptor, verified, details, onDetails }: {
  readonly reply: SentReply;
  readonly depth: 0 | 1;
  readonly replyingTo: string | undefined;
  readonly previous: string | undefined;
  readonly identityName: string;
  readonly identityDescriptor: string;
  readonly verified: boolean;
  readonly details: DetailsState | undefined;
  readonly onDetails: (details: DetailsState | undefined) => void;
}) {
  const open = details?.id === reply.id;
  const headingId = `r-${reply.id}`;
  const timeId = `time-${reply.id}`;
  return (
    <li className={s("entry", depth === 1 ? "entryNested" : "entryRoot", "entryOwn", open && "entryAnchored")}>
      <article className={s("entryBody")} aria-labelledby={headingId}>
        <div className={s("entryHead")}>
          <p id={headingId} className={s("entryAuthor")}>
            <OwnMark />
            <span className={s("authorName")}>{identityName}</span>
            {verified ? <span className={s("muted", "small", "descriptor")}>{identityDescriptor}</span> : null}
            {replyingTo === undefined ? null : <span className={s("muted", "small", "replyingTo")}>{`Replying to ${replyingTo}`}</span>}
          </p>
          <StatePill tone="success" icon="decision-approve">
            Sent
          </StatePill>
          <button id={timeId} type="button" className={s("timeButton")} aria-expanded={open} aria-haspopup="dialog" onClick={() => { onDetails(open ? undefined : { id: reply.id, returnTo: timeId }); }}>
            <Stamp iso={reply.publishedAt} previous={previous} />
            <Glyph name="info" />
            <span className="wk-sr-only">{open ? ", close details" : ", details and exact times"}</span>
          </button>
        </div>
        <p className={s("entryText")}>{reply.text}</p>
        <p className={s("muted", "small")}>Sent from Wrenkind</p>
      </article>
    </li>
  );
}

/* ───────────── Details: an overlay drawer over the reading area (never a third column) ───────────── */

function DetailsDrawer({ conversation, target, bench, onClose }: { readonly conversation: Conversation; readonly target: DetailsState; readonly bench: Bench; readonly onClose: () => void }) {
  const { readModel, wf, role, mode, actions, allHealthy, sim } = bench;
  const heading = useRef<HTMLHeadingElement>(null);
  const returnTo = useRef(target.returnTo);
  const shell = useRef<HTMLElement>(null);
  /** Set when a person closes Details: focus then goes back to the control that opened it. */
  const restore = useRef(false);
  const id = useId();
  // The title is the first focus at every width (UX-05 M-1): below 1024 px it is only visually hidden, never removed.
  useEffect(() => {
    heading.current?.focus();
  }, [target.id]);
  useEffect(() => {
    returnTo.current = target.returnTo;
  });
  // Focus returns once the drawer is gone and the reading area under it is no longer inert — not before, when the
  // control it returns to can't take focus yet. A conversation that changed meanwhile has no such control: nothing moves.
  useEffect(() => {
    const root = shell.current?.closest("section");
    return () => {
      if (!restore.current || root === null || root === undefined || !root.isConnected) return;
      root.querySelector<HTMLElement>(`#${returnTo.current}`)?.focus();
    };
  }, []);
  const close = (): void => {
    restore.current = true;
    onClose();
  };
  const account = accountOf(conversation.accountId);
  const platform = account === undefined ? "the platform" : platformName(account);
  const post = postOf(conversation.postId);
  const comment = conversation.comments.find((item) => item.id === target.id);
  const reply = conversation.sent.find((item) => item.id === target.id);
  const happened = historyOf(conversation, wf, readModel);
  const others = authorHistory(conversation, wf);
  const health = healthOf(account, allHealthy);
  const rows = comment === undefined ? [] : (["reply", "private_reply", "hide", "delete", "like", "block"] as const).map((action) => ({ action, availability: availabilityOf({ action, role, mode, actions, accountHealth: health, conversation, comment, sim }) }));
  const unavailable = rows.filter((row) => row.availability.kind === "unavailable");
  const NAMES = { reply: "Public reply", private_reply: "Private reply", hide: "Hide", delete: "Delete", like: "Like", block: "Block author" } as const;
  const who = comment === undefined ? (reply === undefined ? "" : "your reply") : comment.author.kind === "own" ? "your account's comment" : `${commenterName(comment)}'s comment`;
  return (
    <aside
      ref={shell}
      className={s("drawer")}
      role="dialog"
      aria-labelledby={`${id}-title`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <div className={s("drawerHead")}>
        <button type="button" className={s("btn", "btnQuiet", "drawerBack")} onClick={close}>
          <Glyph name="chevronLeft" />
          <span>Conversation</span>
        </button>
        <h2 id={`${id}-title`} ref={heading} className={s("drawerTitle")} tabIndex={-1}>
          Details
          <span className="wk-sr-only">{` of ${who}`}</span>
        </h2>
        <kbd className={s("kbd")}>Esc</kbd>
        <button type="button" className={s("iconButton", "drawerClose")} aria-label="Close details" onClick={close}>
          <Icon name="util-close" size={16} />
        </button>
      </div>
      <div className={s("drawerAnchor")}>
        <p className={s("small", "muted")}>{`About ${who}`}</p>
        <p className={s("drawerExcerpt")}>{comment?.text ?? reply?.text ?? ""}</p>
      </div>
      <div className={s("drawerBody")}>
        <section className={s("drawerSection")} aria-labelledby={`${id}-when`}>
          <h3 id={`${id}-when`} className={s("eyebrow")}>
            When
          </h3>
          <dl className={s("facts")}>
            {comment === undefined ? null : (
              <>
                <dt>{`Written on ${platform}`}</dt>
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
                {comment.author.kind === "audience" ? (
                  <>
                    <dt>Private reply</dt>
                    <dd>
                      {privateReplyWindow(comment).open ? "Possible until " : "Window closed on "}
                      <Exact iso={privateReplyWindow(comment).closesAt} />
                    </dd>
                  </>
                ) : null}
                {comment.author.kind === "own" ? (
                  <>
                    <dt>Written by</dt>
                    <dd>{`Your account, directly on ${platform} (not from Wrenkind)`}</dd>
                  </>
                ) : null}
              </>
            )}
            {reply === undefined ? null : (
              <>
                <dt>Requested in Wrenkind by</dt>
                <dd>{requesterOf(reply, readModel)}</dd>
                <dt>Requested</dt>
                <dd>
                  <Exact iso={reply.requestedAt} />
                </dd>
                <dt>{`Published on ${platform}`}</dt>
                <dd>
                  <Exact iso={reply.publishedAt} />
                </dd>
              </>
            )}
            <dt>On</dt>
            <dd>{post === undefined ? "Post not read yet" : `${post.kind} · ${sourceText(post.source)}`}</dd>
          </dl>
        </section>
        <section className={s("drawerSection")} aria-labelledby={`${id}-activity`}>
          <h3 id={`${id}-activity`} className={s("eyebrow")}>
            What happened in this conversation
          </h3>
          {happened.length === 0 ? (
            <p className={s("muted", "small")}>Nothing recorded yet.</p>
          ) : (
            <ol className={s("activityList")}>
              {happened.map((item) => (
                <li key={item.id}>
                  <span className={s("activityTime")}>
                    <Stamp iso={item.at} />
                  </span>
                  <span>
                    {item.text}
                    <span className={s("muted")}>{` · ${item.by}`}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
        {comment === undefined || comment.author.kind !== "audience" ? null : (
          <section className={s("drawerSection")} aria-labelledby={`${id}-author`}>
            <h3 id={`${id}-author`} className={s("eyebrow")}>
              {`${commenterName(comment)} in this workspace`}
            </h3>
            {others.length === 0 ? (
              <p className={s("muted", "small")}>No other conversation from them on this account.</p>
            ) : (
              <ul className={s("plainList", "authorList")}>
                {others.map((item) => (
                  <li key={item.conversation.id}>
                    {`“${item.conversation.comments[0]?.text ?? ""}” · ${item.status === "done" ? "Done" : "Open"}`}
                  </li>
                ))}
              </ul>
            )}
            <p className={s("muted", "small")}>Only this workspace — no profile across workspaces.</p>
          </section>
        )}
        {comment === undefined ? null : (
          <details className={s("drawerSection", "capabilityDisclosure")}>
            <summary className={s("disclosureSummary")}>
              <Glyph name="chevronRight" />
              <span>Why some actions aren&apos;t available here</span>
              <span className={s("mono", "muted")}>{unavailable.length}</span>
            </summary>
            {unavailable.length === 0 ? (
              <p className={s("muted", "small")}>Every action your role has is available on this comment.</p>
            ) : (
              <ul className={s("plainList", "capabilityList")}>
                {unavailable.map((row) => (
                  <li key={row.action}>
                    <strong>{valueOf(NAMES, row.action) ?? row.action}</strong>
                    <span className={s("muted")}>{` — ${row.availability.kind === "unavailable" ? row.availability.reason : ""}`}</span>
                  </li>
                ))}
              </ul>
            )}
          </details>
        )}
      </div>
    </aside>
  );
}

/* ───────────── Settings ───────────── */

function SettingsLabels({ labels, role, onSave, onDelete, onCreate }: {
  readonly labels: LabelState;
  readonly role: Role;
  /** Name and color together; a problem to show, or undefined when saved. */
  readonly onSave: (labelId: string, raw: string, marker: Marker) => string | undefined;
  readonly onDelete: (labelId: string) => void;
  readonly onCreate: (raw: string, marker: Marker) => string | undefined;
}) {
  const canManage = abilitiesOf(role).create;
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [deleting, setDeleting] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  /** The color chosen in the open form (New label or Edit): applied on Create / Save, discarded on Cancel. */
  const [marker, setMarkerChoice] = useState<Marker>(DEFAULT_MARKER);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const id = useId();
  // Edit and delete exist only while the role may manage labels: a role change closes them (UX-05), never leaving a
  // form or a confirmation that would only be refused.
  const editingLabel = canManage ? labels.labels.find((label) => label.id === editing) : undefined;
  const deletingLabel = canManage ? labels.labels.find((label) => label.id === deleting) : undefined;
  const [managedBefore, setManagedBefore] = useState(canManage);
  if (managedBefore !== canManage) {
    // Adjusted while rendering (no effect): regaining the permission never brings a closed form back.
    setManagedBefore(canManage);
    if (!canManage) {
      setEditing(undefined);
      setDeleting(undefined);
      setCreating(false);
    }
  }
  const startEdit = (label: Label): void => {
    setDeleting(undefined);
    setCreating(false);
    setEditing(label.id);
    setName(label.name);
    setMarkerChoice(markerOf(label));
    setProblem(undefined);
  };
  /**
   * UX-06-CLOSEOUT: where keyboard focus returns once a form or confirmation closes — the control that opened it
   * (`data-label-action`), set only by a person's Save, Create, Cancel, Delete or Escape, never by a role change. It is
   * applied after the closing render, when that control is enabled again; when it no longer exists (a deleted label)
   * or can't take focus, the page's heading takes it — never document.body, never a detached element.
   */
  const section = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<string | undefined>(undefined);
  useEffect(() => {
    const key = returnFocus.current;
    if (key === undefined) return;
    returnFocus.current = undefined;
    const target = section.current?.querySelector<HTMLButtonElement>(`[data-label-action="${key}"]`) ?? null;
    if (target !== null && target.isConnected && !target.disabled && target.closest("[hidden], [inert]") === null) target.focus();
    else heading.current?.focus();
  });
  const closeEditor = (labelId: string): void => {
    returnFocus.current = `edit-${labelId}`;
    setEditing(undefined);
    setProblem(undefined);
  };
  const closeCreate = (): void => {
    returnFocus.current = "new";
    setCreating(false);
    setProblem(undefined);
  };
  const closeDelete = (labelId: string): void => {
    returnFocus.current = `delete-${labelId}`;
    setDeleting(undefined);
  };
  const onEscape = (event: KeyboardEvent<HTMLElement>, close: () => void): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  return (
    <section ref={section} className={s("settings")} aria-labelledby={`${id}-title`}>
      <div className={s("settingsHead")}>
        <div>
          <h1 id={`${id}-title`} ref={heading} className={s("title")} tabIndex={-1}>
            Labels
          </h1>
          <p className={s("muted", "settingsLead")}>Labels organize comments for your team. A label&apos;s color only helps you recognize it — it never means priority, urgency, sentiment or attention.</p>
        </div>
        {canManage ? (
          <button
            type="button"
            className={s("btn", "btnPrimary")}
            data-label-action="new"
            onClick={() => {
              setEditing(undefined);
              setDeleting(undefined);
              setCreating(true);
              setName("");
              setMarkerChoice(DEFAULT_MARKER);
              setProblem(undefined);
            }}
          >
            <Icon name="util-plus" size={16} />
            <span>New label</span>
          </button>
        ) : null}
      </div>
      {!canManage ? <p className={s("notice")}>Your role can use labels on comments but can&apos;t create, rename or delete them. Owners, admins and managers manage labels.</p> : null}
      {creating && canManage ? (
        <div className={s("settingsForm")} role="group" aria-labelledby={`${id}-new`} onKeyDown={(event) => { onEscape(event, closeCreate); }}>
          <p id={`${id}-new`} className={s("confirmTitle")}>
            New workspace label
          </p>
          <label htmlFor={`${id}-newname`} className={s("small")}>
            Name
          </label>
          <input id={`${id}-newname`} className={s("input")} value={name} maxLength={80} autoFocus aria-invalid={problem === undefined ? undefined : "true"} aria-describedby={problem === undefined ? undefined : `${id}-problem`} onChange={(event) => { setName(event.target.value); setProblem(undefined); }} />
          {problem === undefined ? null : (
            <p id={`${id}-problem`} className={s("problem")} role="alert">
              {problem}
            </p>
          )}
          <MarkerPicker value={marker} onChange={setMarkerChoice} legend="Color" />
          <div className={s("inlineActions")}>
            <button
              type="button"
              className={s("btn", "btnPrimary")}
              onClick={() => {
                const result = onCreate(name, marker);
                setProblem(result);
                if (result === undefined) closeCreate();
              }}
            >
              Create label
            </button>
            <button type="button" className={s("btn")} onClick={closeCreate}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <table className={s("settingsTable")}>
        <thead>
          <tr>
            <th scope="col">Color</th>
            <th scope="col">Name</th>
            <th scope="col">Comments</th>
            <th scope="col">
              <span className="wk-sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedLabels(labels.labels).map((label) =>
            editingLabel?.id === label.id ? (
              <tr key={label.id} className={s("editingRow")} onKeyDown={(event) => { onEscape(event, () => { closeEditor(label.id); }); }}>
                <td>
                  {/* A preview of the color being chosen; the label changes everywhere only on Save. */}
                  <span className={s("colorCell")}>
                    <LabelMarker marker={marker} />
                    <span className={s("muted", "small")}>{markerName(marker)}</span>
                  </span>
                </td>
                <td colSpan={2}>
                  <label htmlFor={`${id}-edit`} className="wk-sr-only">
                    Label name
                  </label>
                  <input id={`${id}-edit`} className={s("input")} value={name} maxLength={80} autoFocus aria-invalid={problem === undefined ? undefined : "true"} aria-describedby={problem === undefined ? `${id}-impact` : `${id}-problem ${id}-impact`} onChange={(event) => { setName(event.target.value); setProblem(undefined); }} />
                  {problem === undefined ? null : (
                    <p id={`${id}-problem`} className={s("problem")} role="alert">
                      {problem}
                    </p>
                  )}
                  <MarkerPicker value={marker} onChange={setMarkerChoice} legend="Color" onReset={() => { setMarkerChoice(DEFAULT_MARKER); }} />
                  <p id={`${id}-impact`} className={s("muted", "small")}>{`Changes apply wherever it appears: ${labelUsage(labels, label.id) === 1 ? "the 1 comment" : `the ${String(labelUsage(labels, label.id))} comments`} that use${labelUsage(labels, label.id) === 1 ? "s" : ""} it, the list and the sidebar.`}</p>
                </td>
                <td>
                  <div className={s("inlineActions")}>
                    <button
                      type="button"
                      className={s("btn", "btnPrimary")}
                      onClick={() => {
                        const result = onSave(label.id, name, marker);
                        setProblem(result);
                        if (result === undefined) closeEditor(label.id);
                      }}
                    >
                      Save
                    </button>
                    <button type="button" className={s("btn")} onClick={() => { closeEditor(label.id); }}>
                      Cancel
                    </button>
                  </div>
                </td>
              </tr>
            ) : (
              <tr key={label.id}>
                <td>
                  <span className={s("colorCell")}>
                    <LabelMarker marker={markerOf(label)} />
                    <span className={s("muted", "small")}>{markerName(markerOf(label))}</span>
                  </span>
                </td>
                <td className={s("labelName")}>{label.name}</td>
                <td className={s("mono")}>{labelUsage(labels, label.id)}</td>
                <td>
                  {canManage ? (
                    <div className={s("inlineActions", "rowActions")}>
                      <button type="button" className={s("btn", "btnQuiet")} data-label-action={`edit-${label.id}`} disabled={editingLabel !== undefined || deletingLabel !== undefined} onClick={() => { startEdit(label); }}>
                        Edit<span className="wk-sr-only">{` ${label.name}`}</span>
                      </button>
                      <button
                        type="button"
                        className={s("btn", "btnQuiet", "btnDangerText")}
                        data-label-action={`delete-${label.id}`}
                        disabled={editingLabel !== undefined || deletingLabel !== undefined}
                        onClick={() => {
                          setCreating(false);
                          setDeleting(label.id);
                        }}
                      >
                        Delete<span className="wk-sr-only">{` ${label.name}`}</span>
                      </button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      <p className={s("muted", "small")}>{`${String(labels.labels.length)} of 50 labels · Managing labels is the proposed “labels.manage” permission (owners, admins, managers); anyone who works on comments can add or remove existing labels.`}</p>
      {deletingLabel === undefined ? null : (
        <div className={s("dialogLayer")}>
          <div
            className={s("popover", "confirm", "confirmDanger", "dialog")}
            role="alertdialog"
            aria-labelledby={`${id}-del`}
            aria-describedby={`${id}-deldesc`}
            onKeyDown={(event) => { onEscape(event, () => { closeDelete(deletingLabel.id); }); }}
          >
            <p id={`${id}-del`} className={s("confirmTitle")}>{`Delete “${deletingLabel.name}”?`}</p>
            <ul id={`${id}-deldesc`} className={s("confirmPoints")}>
              <li>{`It's removed from the ${String(labelUsage(labels, deletingLabel.id))} comments that use it. No comment is deleted.`}</li>
              <li>A Label filter using it stops matching.</li>
              <li>This can&apos;t be undone. Each affected conversation&apos;s activity keeps a record.</li>
            </ul>
            <div className={s("inlineActions")}>
              <button type="button" className={s("btn")} autoFocus onClick={() => { closeDelete(deletingLabel.id); }}>
                Cancel
              </button>
              <button
                type="button"
                className={s("btn", "btnDanger")}
                onClick={() => {
                  // The label is gone afterwards: its Delete control no longer exists, so focus lands on the heading.
                  onDelete(deletingLabel.id);
                  closeDelete(deletingLabel.id);
                }}
              >
                Delete label
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** Where Intelligence is discovered while it is not active: what it would do, said as a future capability. */
function SettingsIntelligence() {
  return (
    <section className={s("settings")} aria-labelledby="intelligence-title">
      <div className={s("settingsHead")}>
        <div>
          <h1 id="intelligence-title" className={s("title")}>
            Intelligence
          </h1>
          <p className={s("muted", "settingsLead")}>Not active for this workspace. Nothing in Comments is classified, prioritized or summarized by Wrenkind today.</p>
        </div>
        <span className={s("futureTag")}>Not active</span>
      </div>
      <div className={s("settingsForm")}>
        <p className={s("confirmTitle")}>When it becomes available</p>
        <ul className={s("confirmPoints")}>
          <li>Signals: Wrenkind&apos;s reading of a comment (for example Question or Complaint), shown as data beside the author, correctable by a person, and never mixed with your Labels.</li>
          <li>Needs review: a view for comments Wrenkind could not assess with confidence.</li>
          <li>Priority: an ordering option. A person&apos;s Urgent flag always wins over it.</li>
          <li>Protection: complaints and accusations against the brand are never hidden automatically.</li>
        </ul>
        <p className={s("muted", "small")}>This page describes a future capability. There is nothing to turn on in this prototype.</p>
      </div>
    </section>
  );
}

/* ───────────── prototype controls and the capability reference (not product UI) ───────────── */

function PrototypeBar({ role, mode, actions, theme, readModel, allHealthy, target, selected, onRole, onMode, onActions, onTheme, onReadModel, onAllHealthy, onTarget, onArrive, onReset }: {
  readonly role: Role;
  readonly mode: Mode;
  readonly actions: ActionsMode;
  readonly theme: ThemeChoice;
  readonly readModel: ReadModel;
  readonly allHealthy: boolean;
  readonly target: number;
  readonly selected: string | undefined;
  readonly onRole: (role: Role) => void;
  readonly onMode: (mode: Mode) => void;
  readonly onActions: (actions: ActionsMode) => void;
  readonly onTheme: (theme: ThemeChoice) => void;
  readonly onReadModel: (readModel: ReadModel) => void;
  readonly onAllHealthy: (allHealthy: boolean) => void;
  readonly onTarget: (minutes: number) => void;
  readonly onArrive: () => void;
  readonly onReset: () => void;
}) {
  const id = useId();
  return (
    <section className={s("protoBar")} aria-label="Prototype controls">
      <p className={s("protoNote")}>
        <span className={s("protoFlag")}>Prototype</span>
        <span>{actions === "simulate" ? "Facebook and Instagram actions are simulated in this tab. Workflow, attention and labels are proposals. Nothing is sent to Meta, saved, or seen by anyone else. Synthetic data." : "Actions are shown as Wrenkind has them today. Nothing is sent, saved, or seen by anyone else. Synthetic data."}</span>
      </p>
      <div className={s("protoControls")}>
        <span className={s("protoField")}>
          <label htmlFor={`${id}-role`}>Role</label>
          <select id={`${id}-role`} className={s("select")} value={role} onChange={(event) => { onRole(ROLES.find((item) => item.id === event.target.value)?.id ?? "manager"); }}>
            {ROLES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </span>
        <span className={s("protoField")}>
          <label htmlFor={`${id}-mode`}>Workspace</label>
          <select id={`${id}-mode`} className={s("select")} value={mode} onChange={(event) => { onMode(event.target.value === "monitor" ? "monitor" : "standard"); }}>
            <option value="standard">Standard</option>
            <option value="monitor">Monitor-only</option>
          </select>
        </span>
        <span className={s("protoField")}>
          <label htmlFor={`${id}-actions`}>Actions</label>
          <select id={`${id}-actions`} className={s("select")} value={actions} onChange={(event) => { onActions(event.target.value === "today" ? "today" : "simulate"); }}>
            <option value="simulate">Simulated (what Meta documents)</option>
            <option value="today">As in Wrenkind today</option>
          </select>
        </span>
        <span className={s("protoField")}>
          <label htmlFor={`${id}-theme`}>Theme</label>
          <select id={`${id}-theme`} className={s("select")} value={theme} onChange={(event) => { onTheme(THEME_CHOICES.find((item) => item.id === event.target.value)?.id ?? "system"); }}>
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
              <label htmlFor={`${id}-target`}>Response target (test value)</label>
              <select id={`${id}-target`} className={s("select")} value={String(target)} onChange={(event) => { onTarget(TARGETS.find((item) => String(item.minutes) === event.target.value)?.minutes ?? 240); }}>
                {TARGETS.map((item) => (
                  <option key={item.minutes} value={String(item.minutes)}>
                    {item.name}
                  </option>
                ))}
              </select>
            </span>
            <span className={s("protoField")}>
              <label htmlFor={`${id}-data`}>Read model</label>
              <select id={`${id}-data`} className={s("select")} value={readModel} onChange={(event) => { onReadModel(event.target.value === "today" ? "today" : "planned"); }}>
                <option value="planned">Planned (account names)</option>
                <option value="today">Today</option>
              </select>
            </span>
            <span className={s("protoField")}>
              <label htmlFor={`${id}-health`}>Connections</label>
              <select id={`${id}-health`} className={s("select")} value={allHealthy ? "healthy" : "data"} onChange={(event) => { onAllHealthy(event.target.value === "healthy"); }}>
                <option value="data">One needs attention</option>
                <option value="healthy">All healthy</option>
              </select>
            </span>
            <button type="button" className={s("btn", "btnSmall", "btnSim")} disabled={selected === undefined} onClick={onArrive}>
              {selected === undefined ? "Simulate a new reply (select a conversation)" : `Simulate a new reply from ${selected}`}
            </button>
          </div>
        </details>
        <button type="button" className={s("btn", "btnSmall")} onClick={onReset} aria-describedby={`${id}-reset`}>
          Reset data
        </button>
        <span id={`${id}-reset`} className="wk-sr-only">
          Restores labels, workflow, simulated actions, drafts, the view, filters and the selection. Role, workspace, actions, theme and scenario stay as chosen.
        </span>
      </div>
      <details className={s("matrix")}>
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
        <li>Conversation management (assign, Urgent, escalate, notes, Done / Reopen), attention and label management have no backend: they live in this tab only.</li>
        <li>Moderating comments on ads (Facebook ads that never ran as Page posts, Instagram ads) needs validation before it is offered.</li>
        <li>Private replies need messaging permissions Wrenkind doesn&apos;t hold, and Wrenkind has no message inbox.</li>
        <li>Intelligence (Signals, Needs review, priority) is not active: nothing is classified, and the prototype shows no AI output.</li>
      </ul>
    </div>
  );
}
