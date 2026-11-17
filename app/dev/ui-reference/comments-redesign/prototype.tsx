"use client";
/**
 * Comments experience redesign (Step 7B-17V) — DEVELOPMENT ONLY, synthetic data, local state only. The proposed
 * Comments page as one interactive prototype: content first, three actions at the comment (Reply · Labels · More),
 * exact times and conversation facts on demand, the brand's account named by its verified name when the read model
 * has it, manual labels created and assigned from a comment, and a label filter in the Comments sidebar.
 *
 * Nothing here reaches a server action, a pipeline, a database, browser storage, the network or a platform: every
 * change lives in this component's React state and disappears on reload. The reply composer is a preview that cannot
 * publish. The rules it applies are the pure functions in ./model.ts.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Logo } from "@/ui/brand/logo";
import { Icon } from "@/ui/icons/icon";
import { OriginMark, StatePill } from "@/ui/primitives";
import { LocalTime, LocalTimeStamp } from "@/ui/time/local-time";
import { ACCOUNTS, SEED_ASSIGNMENTS, SEED_LABELS, WORKSPACE, type Comment, type Conversation, type SentReply } from "./fixtures";
import {
  ROLES,
  abilitiesOf,
  accountOf,
  answerable,
  commenterName,
  conversationLabels,
  countText,
  createLabel,
  findLabelByName,
  fullUtc,
  labelCounts,
  labelsOn,
  latestOf,
  normalizeName,
  ORDERED,
  ownIdentity,
  platformName,
  positionOf,
  postOf,
  problemText,
  requesterOf,
  setAssigned,
  shortUtc,
  sortedLabels,
  sourceTag,
  sourceText,
  threadOf,
  valueOf,
  visibleConversations,
  withoutKey,
  type LabelState,
  type ReadModel,
  type Role,
  type ThreadEntry,
} from "./model";
import styles from "./prototype.module.css";

const s = (...names: readonly (string | false | undefined)[]): string =>
  names
    .filter((name): name is string => typeof name === "string" && name !== "")
    .map((name) => valueOf(styles, name) ?? "")
    .join(" ");

const INITIAL_LABELS: LabelState = { labels: SEED_LABELS, assignments: SEED_ASSIGNMENTS, nextId: 1 };

type Mode = "standard" | "monitor";
type ReplyMode = "today" | "preview";
type Panel = { readonly commentId: string; readonly kind: "labels" | "more" } | undefined;

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

function Chips({ ids, state, max, onRemove, owner }: { readonly ids: readonly string[]; readonly state: LabelState; readonly max: number; readonly onRemove?: ((labelId: string) => void) | undefined; readonly owner?: string }) {
  const names = ids.map((id) => state.labels.find((label) => label.id === id)).filter((label) => label !== undefined);
  if (names.length === 0) return null;
  const shown = names.slice(0, max);
  const more = names.length - shown.length;
  return (
    <ul className={s("chips")} aria-label="Labels">
      {shown.map((label) => (
        <li key={label.id} className={s("chip")}>
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
 * The same chips inside a row header (a button): phrasing content only, never interactive, and read as one sentence
 * ("Labels: Delivery, Follow up Monday") inside the button's name.
 */
function RowChips({ ids, state, max }: { readonly ids: readonly string[]; readonly state: LabelState; readonly max: number }) {
  const names = ids.map((id) => state.labels.find((label) => label.id === id)?.name).filter((name) => name !== undefined);
  if (names.length === 0) return null;
  const shown = names.slice(0, max);
  const more = names.length - shown.length;
  return (
    <span className={s("chips")} data-row-chips="">
      <span className="wk-sr-only">{`Labels: ${names.join(", ")}.`}</span>
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

export function CommentsRedesign() {
  const [role, setRole] = useState<Role>("manager");
  const [mode, setMode] = useState<Mode>("standard");
  const [readModel, setReadModel] = useState<ReadModel>("planned");
  const [replyMode, setReplyMode] = useState<ReplyMode>("today");
  const [labels, setLabels] = useState<LabelState>(INITIAL_LABELS);
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const [panel, setPanel] = useState<Panel>(undefined);
  const [details, setDetails] = useState<string | undefined>(undefined);
  const [replyTarget, setReplyTarget] = useState<string | undefined>(undefined);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [announcement, setAnnouncement] = useState("");
  const [focusTarget, setFocusTarget] = useState<{ readonly id: string; readonly scroll: boolean } | undefined>(undefined);
  const headers = useRef(new Map<string, HTMLButtonElement>());
  const abilities = abilitiesOf(role);

  const list = useMemo(() => visibleConversations(labels, filter), [labels, filter]);
  const counts = useMemo(() => labelCounts(labels), [labels]);
  const activeFilter = filter === undefined ? undefined : labels.labels.find((label) => label.id === filter);

  // Moving focus after a render (each request is a new object, so the effect runs once per request) that changed which conversation is open (Previous / Next / Escape / filter).
  useEffect(() => {
    if (focusTarget === undefined) return;
    const button = headers.current.get(focusTarget.id);
    button?.focus({ preventScroll: true });
    if (focusTarget.scroll && typeof button?.scrollIntoView === "function") button.scrollIntoView({ block: "start" });
  }, [focusTarget]);

  const announce = (message: string): void => { setAnnouncement(message); };

  const toggle = (id: string): void => {
    setPanel(undefined);
    setDetails(undefined);
    setOpenId((current) => (current === id ? undefined : id));
  };

  const move = (id: string): void => {
    setPanel(undefined);
    setDetails(undefined);
    setOpenId(id);
    setFocusTarget({ id, scroll: true });
  };

  const collapse = (id: string): void => {
    setPanel(undefined);
    setDetails(undefined);
    setOpenId(undefined);
    setFocusTarget({ id, scroll: false });
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

  const assign = (commentId: string, owner: string, labelId: string, assigned: boolean): void => {
    const name = labels.labels.find((label) => label.id === labelId)?.name ?? "";
    setLabels((current) => setAssigned(current, role, commentId, labelId, assigned));
    announce(assigned ? `Label ${name} added to ${owner}` : `Label ${name} removed from ${owner}`);
  };

  const create = (raw: string, commentId: string | undefined, owner: string | undefined): string | undefined => {
    const result = createLabel(labels, role, raw, commentId);
    if (!result.ok) return result.problem === "not_allowed" ? "Only owners, admins and managers can create labels." : problemText(result.problem);
    setLabels(result.state);
    announce(owner === undefined ? `Label ${result.label.name} created` : `Label ${result.label.name} created and added to ${owner}`);
    return undefined;
  };

  const reset = (): void => {
    setLabels(INITIAL_LABELS);
    setFilter(undefined);
    setOpenId(undefined);
    setPanel(undefined);
    setDetails(undefined);
    setReplyTarget(undefined);
    setDrafts({});
    announce("Prototype reset");
  };

  const title = activeFilter === undefined ? "All comments" : activeFilter.name;

  return (
    <div className={s("shell")}>
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
        <PrototypeBar role={role} mode={mode} readModel={readModel} replyMode={replyMode} onRole={setRole} onMode={setMode} onReadModel={setReadModel} onReplyMode={setReplyMode} onReset={reset} />
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
                <h1 className={s("title")}>{title}</h1>
                <Coverage />
              </div>
              <p className={s("muted", "listMeta")}>
                {`${String(list.length)} ${list.length === 1 ? "conversation" : "conversations"} · Newest activity first`}
              </p>
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
            ) : (
              <ul className={s("list")} aria-label={title}>
                {list.map((conversation, index) => (
                  <Row
                    key={conversation.id}
                    conversation={conversation}
                    previousLatest={index === 0 ? undefined : latestOf(list.at(index - 1) as Conversation)}
                    open={conversation.id === openId}
                    labels={labels}
                    readModel={readModel}
                    register={(element) => {
                      if (element === null) headers.current.delete(conversation.id);
                      else headers.current.set(conversation.id, element);
                    }}
                    onToggle={() => { toggle(conversation.id); }}
                  >
                    {conversation.id === openId ? (
                      <Focus
                        conversation={conversation}
                        list={list}
                        role={role}
                        mode={mode}
                        readModel={readModel}
                        replyMode={replyMode}
                        labels={labels}
                        panel={panel}
                        details={details}
                        replyTarget={replyTarget}
                        drafts={drafts}
                        onMove={move}
                        onCollapse={() => { collapse(conversation.id); }}
                        onPanel={setPanel}
                        onDetails={setDetails}
                        onReplyTarget={setReplyTarget}
                        onDraft={(commentId, text) => { setDrafts((current) => (text === "" ? withoutKey(current, commentId) : { ...current, [commentId]: text })); }}
                        onAssign={assign}
                        onCreate={create}
                      />
                    ) : null}
                  </Row>
                ))}
              </ul>
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

/** What has been read: one quiet line; the per-account record on demand; a warning only where an account is partial. */
function Coverage() {
  const partial = ACCOUNTS.filter((account) => account.coverage === "partial");
  return (
    <details className={s("coverage")}>
      <summary className={s("coverageSummary")}>
        {partial.length > 0 ? <Icon name="estado-alert" size={16} /> : null}
        <span>
          Read through <Stamp iso="2026-11-17T14:52:00Z" />
          {partial.length > 0 ? ` · ${String(partial.length)} account partly read` : ""}
        </span>
      </summary>
      <div className={s("coverageBody")}>
        <ul className={s("plainList")}>
          {ACCOUNTS.map((account) => {
            return (
              <li key={account.id} className={s("coverageRow")}>
                <OriginMark platform={account.platform} name={platformName(account)} />
                <span>{account.verifiedName ?? `Your ${platformName(account)} account`}</span>
                <span className={s("muted")}>{account.coverage === "complete" ? "Comments and replies read" : "Comments partly read — older comments may be missing"}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}

/* ───────────── a row of the list (the Focus disclosure) ───────────── */

function Row({ conversation, previousLatest, open, labels, readModel, register, onToggle, children }: {
  readonly conversation: Conversation;
  readonly previousLatest: string | undefined;
  readonly open: boolean;
  readonly labels: LabelState;
  readonly readModel: ReadModel;
  readonly register: (element: HTMLButtonElement | null) => void;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  const anchor = conversation.comments[0] as Comment;
  const account = accountOf(conversation.accountId);
  const post = postOf(conversation.postId);
  const tag = sourceTag(post);
  const accountName = account === undefined ? "Unknown account" : readModel === "planned" && account.verifiedName !== null ? account.verifiedName : platformName(account);
  const repliesSent = conversation.sent.length + conversation.comments.filter((comment) => comment.author.kind === "own").length;
  const ids = conversationLabels(labels, conversation);
  const panelId = `focus-${conversation.id}`;
  const headerId = `row-${conversation.id}`;
  return (
    <li className={s("row", open && "rowOpen")}>
      <div className={s("rowHead", open && "rowHeadOpen")}>
        <h2 className={s("rowHeading")}>
          <button ref={register} id={headerId} type="button" className={s("rowButton")} aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={onToggle}>
            <span className={s("rowTop")}>
              <span className={s("rowOrigin")}>
                {account === undefined ? null : <OriginMark platform={account.platform} name={platformName(account)} />}
                <span className={s("rowAccount")}>{accountName}</span>
                {tag === undefined ? null : <span className={s("tag")}>{tag}</span>}
              </span>
              <span className={s("rowAuthor")}>{anchor.author.kind === "own" ? "Your account" : commenterName(anchor)}</span>
              <Stamp iso={latestOf(conversation)} previous={previousLatest} />
            </span>
            <span className={s("rowExcerpt", anchor.presence !== "present" && "muted")}>{anchor.presence === "removed" ? "Removed from the platform" : anchor.text}</span>
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
              {anchor.presence === "hidden" ? (
                <span className={s("metaItem")}>
                  <Icon name="estado-lock" size={16} />
                  Hidden
                </span>
              ) : null}
              <RowChips ids={ids} state={labels} max={2} />
            </span>
            <Chevron open={open} />
            <span className="wk-sr-only">{open ? ", collapse conversation" : ", open conversation"}</span>
          </button>
        </h2>
      </div>
      {open ? (
        <section id={panelId} className={s("focus")} aria-labelledby={headerId}>
          {children}
        </section>
      ) : null}
    </li>
  );
}

/* ───────────── the open conversation ───────────── */

interface FocusProps {
  readonly conversation: Conversation;
  readonly list: readonly Conversation[];
  readonly role: Role;
  readonly mode: Mode;
  readonly readModel: ReadModel;
  readonly replyMode: ReplyMode;
  readonly labels: LabelState;
  readonly panel: Panel;
  readonly details: string | undefined;
  readonly replyTarget: string | undefined;
  readonly drafts: Readonly<Record<string, string>>;
  readonly onMove: (id: string) => void;
  readonly onCollapse: () => void;
  readonly onPanel: (panel: Panel) => void;
  readonly onDetails: (id: string | undefined) => void;
  readonly onReplyTarget: (id: string | undefined) => void;
  readonly onDraft: (commentId: string, text: string) => void;
  readonly onAssign: (commentId: string, owner: string, labelId: string, assigned: boolean) => void;
  readonly onCreate: (name: string, commentId: string | undefined, owner: string | undefined) => string | undefined;
}

function Focus(props: FocusProps) {
  const { conversation, list, readModel, onMove, onCollapse } = props;
  const position = positionOf(list, conversation.id);
  const account = accountOf(conversation.accountId);
  const post = postOf(conversation.postId);
  const tag = sourceTag(post);
  const entries = threadOf(conversation);
  const identity = account === undefined ? undefined : ownIdentity(account, readModel);
  // Escape anywhere in the open conversation (outside a field or an open panel, which handle it first) closes it.
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
        <p className={s("contextLine")}>
          <Icon name={post?.kind === "Ad" ? "conv-ad" : "conv-post"} size={16} />
          {post === undefined || post.caption === null ? (
            <span className={s("muted")}>Post not read yet</span>
          ) : (
            <>
              <span className={s("contextKind")}>{post.kind}</span>
              <span className={s("contextCaption")}>{`“${post.caption}”`}</span>
            </>
          )}
          {tag === undefined || (tag === "Ad" && post?.kind === "Ad") ? null : <span className={s("tag")}>{tag}</span>}
        </p>
        {position === undefined ? null : (
          <nav className={s("convNav")} aria-label="Move between conversations">
            <span className={s("muted", "mono")}>{`${String(position.index)} of ${String(position.count)}`}</span>
            <button type="button" className={s("btn", "btnSmall")} disabled={position.previous === undefined} onClick={() => { if (position.previous !== undefined) onMove(position.previous); }}>
              Previous
            </button>
            <button type="button" className={s("btn", "btnSmall")} disabled={position.next === undefined} onClick={() => { if (position.next !== undefined) onMove(position.next); }}>
              Next
            </button>
          </nav>
        )}
      </div>

      <ol className={s("thread")} aria-label="Comments and replies">
        {entries.map((entry, index) => {
          const previous = index === 0 ? undefined : entryTime(entries.at(index - 1) as ThreadEntry);
          return entry.kind === "comment" ? (
            <CommentItem key={entry.comment.id} {...props} entry={entry} previous={previous} />
          ) : (
            <SentItem key={entry.reply.id} reply={entry.reply} depth={entry.depth} replyingTo={entry.replyingTo} previous={previous} identityName={identity?.name ?? "Your account"} identityDescriptor={identity?.descriptor ?? "Your account"} verified={identity?.verified ?? false} platform={account === undefined ? "the platform" : platformName(account)} readModel={readModel} details={props.details} onDetails={props.onDetails} />
          );
        })}
      </ol>

      <footer className={s("focusFooter")}>
        <p className={s("muted", "small")}>Not automatically reviewed yet: safety and priority haven&apos;t been assessed.</p>
        <details className={s("convDetails")}>
          <summary className={s("convDetailsSummary")}>Conversation details</summary>
          <dl className={s("facts")}>
            <dt>Platform</dt>
            <dd>{account === undefined ? "Unknown" : platformName(account)}</dd>
            <dt>Connected account</dt>
            <dd>{identity === undefined ? "Unknown" : identity.verified ? `${identity.name} (${identity.descriptor.toLowerCase()})` : identity.descriptor}</dd>
            <dt>Post</dt>
            <dd>{post === undefined || post.caption === null ? "Not read yet" : `${post.kind} · “${post.caption}”`}</dd>
            <dt>Organic or paid</dt>
            <dd>{sourceText(post?.source)}</dd>
            <dt>Comments read</dt>
            <dd>{conversation.comments.length}</dd>
          </dl>
        </details>
        <button type="button" className={s("btn", "btnSmall")} onClick={onCollapse}>
          Close conversation
        </button>
      </footer>
    </div>
  );
}

const entryTime = (entry: ThreadEntry): string => (entry.kind === "comment" ? entry.comment.at : entry.reply.publishedAt);

/* ───────────── one comment ───────────── */

function CommentItem(props: FocusProps & { readonly entry: Extract<ThreadEntry, { kind: "comment" }>; readonly previous: string | undefined }) {
  const { entry, conversation, role, mode, readModel, replyMode, labels, panel, details, replyTarget, drafts, onPanel, onDetails, onReplyTarget, onDraft, onAssign, onCreate, previous } = props;
  const { comment } = entry;
  const abilities = abilitiesOf(role);
  const account = accountOf(conversation.accountId);
  const platform = account === undefined ? "the platform" : platformName(account);
  const own = comment.author.kind === "own";
  const identity = account === undefined ? undefined : ownIdentity(account, readModel);
  const author = own ? (identity?.name ?? "Your account") : commenterName(comment);
  const owner = own ? "your account's comment" : `${author}'s comment`;
  const ids = labelsOn(labels, comment.id);
  const panelOpen = panel?.commentId === comment.id ? panel.kind : undefined;
  const labelsButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const canReply = abilities.reply && answerable(comment);
  const replyHere = replyTarget === comment.id;
  const closePanel = (kind: "labels" | "more"): void => {
    onPanel(undefined);
    (kind === "labels" ? labelsButton : moreButton).current?.focus();
  };
  const headingId = `c-${comment.id}`;
  return (
    <li className={s("entry", entry.depth === 1 && "entryNested", own && "entryOwn")}>
      <article className={s("entryBody")} aria-labelledby={headingId}>
        <div className={s("entryHead")}>
          <p id={headingId} className={s("entryAuthor")}>
            {own ? <OwnMark /> : null}
            <span className={s("authorName")}>{author}</span>
            {own && identity !== undefined && identity.verified ? <span className={s("muted", "small")}>{identity.descriptor}</span> : null}
            {entry.replyingTo === undefined ? null : <span className={s("muted", "small")}>{`Replying to ${entry.replyingTo}`}</span>}
          </p>
          <button type="button" className={s("timeButton")} aria-expanded={details === comment.id} onClick={() => { onDetails(details === comment.id ? undefined : comment.id); }}>
            <Stamp iso={comment.at} previous={previous} />
            {comment.editedAt === null ? null : <span className={s("muted", "small")}> · edited</span>}
            <span className="wk-sr-only">{details === comment.id ? ", hide details" : ", show details"}</span>
          </button>
          <div className={s("actions")} role="group" aria-label={`Actions for ${owner}`}>
            {canReply ? (
              <button type="button" className={s("action")} aria-expanded={replyHere} onClick={() => { onReplyTarget(replyHere ? undefined : comment.id); }}>
                <Icon name="conv-reply" size={16} />
                <span>Reply</span>
              </button>
            ) : null}
            {abilities.assign ? (
              <button ref={labelsButton} type="button" className={s("action")} aria-expanded={panelOpen === "labels"} onClick={() => { onPanel(panelOpen === "labels" ? undefined : { commentId: comment.id, kind: "labels" }); }}>
                <Icon name="util-tag" size={16} />
                <span>Labels</span>
              </button>
            ) : null}
            <button ref={moreButton} type="button" className={s("action", "actionIcon")} aria-expanded={panelOpen === "more"} onClick={() => { onPanel(panelOpen === "more" ? undefined : { commentId: comment.id, kind: "more" }); }}>
              <Icon name="util-more" size={16} />
              <span className="wk-sr-only">{`More for ${owner}`}</span>
            </button>
          </div>
        </div>

        {comment.presence === "present" ? (
          <p className={s("entryText")}>{comment.text}</p>
        ) : (
          <p className={s("entryText")}>
            <StatePill icon="estado-lock">{comment.presence === "hidden" ? `Hidden on ${platform}` : `Removed from ${platform}`}</StatePill>
            {comment.presence === "hidden" ? <span className={s("hiddenText")}>{comment.text}</span> : null}
          </p>
        )}

        <Chips ids={ids} state={labels} max={3} owner={owner} onRemove={abilities.assign ? (labelId) => { onAssign(comment.id, owner, labelId, false); } : undefined} />

        {panelOpen === "labels" ? <LabelEditor labels={labels} assigned={ids} canCreate={abilities.create} owner={owner} onToggle={(labelId, on) => { onAssign(comment.id, owner, labelId, on); }} onCreate={(name) => onCreate(name, comment.id, owner)} onClose={() => { closePanel("labels"); }} /> : null}

        {panelOpen === "more" ? (
          <MoreMenu
            platform={platform}
            reason={mode === "monitor" ? "This workspace is Monitor-only." : "Not available in Wrenkind yet."}
            providerActions={!own && comment.presence === "present"}
            detailsOpen={details === comment.id}
            onDetails={() => {
              onDetails(details === comment.id ? undefined : comment.id);
              onPanel(undefined);
            }}
            onClose={() => { closePanel("more"); }}
          />
        ) : null}

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
          </dl>
        ) : null}

        {replyHere && canReply ? <ReplyArea comment={comment} author={author} platform={platform} mode={mode} replyMode={replyMode} identity={identity?.name ?? "your account"} draft={valueOf(drafts, comment.id) ?? ""} onDraft={(text) => { onDraft(comment.id, text); }} onClose={() => { onReplyTarget(undefined); }} /> : null}
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
    <li className={s("entry", depth === 1 && "entryNested", "entryOwn")}>
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
        {canCreate ? "Find or create a label" : "Find a label"}
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
          // Enter: the label named exactly; otherwise the only label that matches; otherwise a new label.
          const only = matching.length === 1 ? matching[0] : undefined;
          if (exact !== undefined) onToggle(exact.id, !assigned.includes(exact.id));
          else if (typed !== "" && only !== undefined) onToggle(only.id, !assigned.includes(only.id));
          else if (canCreate && typed !== "") create();
        }}
        aria-describedby={problem === undefined ? undefined : `${id}-problem`}
      />
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
      <div className={s("inlineActions")}>
        <button type="button" className={s("btn", "btnSmall")} onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

/* ───────────── More: details, then the platform's actions (unavailable) ───────────── */

function MoreMenu({ platform, reason, providerActions, detailsOpen, onDetails, onClose }: {
  readonly platform: string;
  readonly reason: string;
  readonly providerActions: boolean;
  readonly detailsOpen: boolean;
  readonly onDetails: () => void;
  readonly onClose: () => void;
}) {
  const reasonId = useId();
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  return (
    <div
      className={s("popover", "menu")}
      role="group"
      aria-label="More actions"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <p className={s("menuHeading")}>In Wrenkind</p>
      <button ref={first} type="button" className={s("menuItem")} onClick={onDetails}>
        <Icon name="util-calendar" size={16} />
        <span>{detailsOpen ? "Hide details" : "Details and exact times"}</span>
      </button>
      {providerActions ? (
        <>
          <p className={s("menuHeading")}>{`On ${platform}`}</p>
          {["Reply privately", "Hide comment"].map((name) => (
            <button key={name} type="button" className={s("menuItem", "menuItemUnavailable")} aria-disabled="true" aria-describedby={reasonId}>
              <Icon name="estado-lock" size={16} />
              <span>{name}</span>
            </button>
          ))}
          <p id={reasonId} className={s("muted", "small", "menuReason")}>
            {reason}
          </p>
        </>
      ) : null}
    </div>
  );
}

/* ───────────── reply: the reason at the point of work, or a composer preview that cannot publish ───────────── */

function ReplyArea({ comment, author, platform, mode, replyMode, identity, draft, onDraft, onClose }: {
  readonly comment: Comment;
  readonly author: string;
  readonly platform: string;
  readonly mode: Mode;
  readonly replyMode: ReplyMode;
  readonly identity: string;
  readonly draft: string;
  readonly onDraft: (text: string) => void;
  readonly onClose: () => void;
}) {
  const [stage, setStage] = useState<"write" | "review">("write");
  const [restored] = useState(draft !== "");
  const id = useId();
  if (mode === "monitor") {
    return (
      <div className={s("replyArea")}>
        <p className={s("reason")}>
          <Icon name="estado-lock" size={16} />
          <span>
            <strong>Reply unavailable.</strong> This workspace is Monitor-only.
          </span>
        </p>
      </div>
    );
  }
  if (replyMode === "today") {
    return (
      <div className={s("replyArea")}>
        <p className={s("reason")}>
          <Icon name="estado-lock" size={16} />
          <span>Replying from Wrenkind isn&apos;t available yet.</span>
        </p>
      </div>
    );
  }
  return (
    <div className={s("replyArea", "composer")} aria-labelledby={`${id}-heading`} role="group" data-comment={comment.id}>
      <p id={`${id}-heading`} className={s("composerHeading")}>
        {`Reply to ${author}`}
        <span className={s("previewBadge")}>Preview — nothing is sent</span>
      </p>
      <p className={s("muted", "small")}>{`Would be published by ${identity} on ${platform}, visible to everyone.`}</p>
      {restored && stage === "write" ? <p className={s("muted", "small")}>Draft kept from earlier in this tab.</p> : null}
      {stage === "write" ? (
        <>
          <label htmlFor={id} className="wk-sr-only">
            Your reply
          </label>
          <textarea id={id} className={s("textarea")} rows={3} value={draft} autoFocus onChange={(event) => { onDraft(event.target.value); }} />
          <div className={s("inlineActions")}>
            <button type="button" className={s("btn", "btnPrimary")} disabled={draft.trim() === ""} onClick={() => { setStage("review"); }}>
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
            <span>Publishing isn&apos;t part of this preview. In the product, this is where Publish would be.</span>
          </p>
          <div className={s("inlineActions")}>
            <button type="button" className={s("btn")} onClick={() => { setStage("write"); }}>
              Edit
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ───────────── prototype controls (not product UI) ───────────── */

function PrototypeBar({ role, mode, readModel, replyMode, onRole, onMode, onReadModel, onReplyMode, onReset }: {
  readonly role: Role;
  readonly mode: Mode;
  readonly readModel: ReadModel;
  readonly replyMode: ReplyMode;
  readonly onRole: (role: Role) => void;
  readonly onMode: (mode: Mode) => void;
  readonly onReadModel: (readModel: ReadModel) => void;
  readonly onReplyMode: (replyMode: ReplyMode) => void;
  readonly onReset: () => void;
}) {
  const id = useId();
  return (
    <section className={s("protoBar")} aria-label="Prototype controls">
      <p className={s("protoNote")}>
        <strong>Prototype</strong> · synthetic data · changes live in this tab only · nothing is saved or sent
      </p>
      <div className={s("protoControls")}>
        <label htmlFor={`${id}-role`}>Role</label>
        <select id={`${id}-role`} className={s("select")} value={role} onChange={(event) => { onRole(event.target.value as Role); }}>
          {ROLES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-mode`}>Workspace</label>
        <select id={`${id}-mode`} className={s("select")} value={mode} onChange={(event) => { onMode(event.target.value as Mode); }}>
          <option value="standard">Standard</option>
          <option value="monitor">Monitor-only</option>
        </select>
        <label htmlFor={`${id}-data`}>Read model</label>
        <select id={`${id}-data`} className={s("select")} value={readModel} onChange={(event) => { onReadModel(event.target.value as ReadModel); }}>
          <option value="planned">Planned (account names)</option>
          <option value="today">Today</option>
        </select>
        <label htmlFor={`${id}-reply`}>Reply</label>
        <select id={`${id}-reply`} className={s("select")} value={replyMode} onChange={(event) => { onReplyMode(event.target.value as ReplyMode); }}>
          <option value="today">As today (unavailable)</option>
          <option value="preview">Composer preview</option>
        </select>
        <button type="button" className={s("btn", "btnSmall")} onClick={onReset}>
          Reset
        </button>
      </div>
    </section>
  );
}
