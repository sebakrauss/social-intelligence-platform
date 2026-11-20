/**
 * MESSAGES-UX-01 — the private conversation. Header hierarchy: who (participant, channel, receiving account, state) →
 * handling (assignee, escalation, Mark done) → context on demand (quiet position/arrows, More menu, ⓘ details).
 * Layout: header and composer are fixed parts of the conversation column and only the timeline scrolls (its own
 * container, at every width), so long histories never push the header or the composer away. It opens at the latest
 * activity and only follows new items when you're at the bottom or just posted something yourself.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Button } from "@/ui/primitives/button";
import { StatePill } from "@/ui/primitives/state-pill";
import { Icon } from "@/ui/icons/icon";
import { Composer } from "./composer";
import { ESCALATION_REASONS, TEAM } from "./data";
import { dayLabel, focusHint, fullOf, LANG_NAMES, ME, navigate, PLATFORM_NAMES, sameDay, timeOf, type Action, type Conversation, type Draft, type Lang, type Message, type Note, type SavedReply, type SendMode, type SystemEvent } from "./model";
import { accountOf, accountTarget, Avatar, cx, Dialog, firstName, Info, Marker, PlatformMark, teammate, useDismiss, useMenuKeys } from "./ui";

export interface Position {
  readonly label: string;
  readonly previous: string | null;
  readonly next: string | null;
  readonly back: string;
  readonly backLabel: string;
  /** The row that takes this one's place when it leaves the view (next, else previous). */
  readonly neighbor: string | null;
  /** Mark done / Reopen moves the conversation out of the current view (Open or Done, not All). */
  readonly leavesOnStateChange: boolean;
}

const go = (href: string, focus?: "previous" | "next") => (event: MouseEvent<HTMLAnchorElement>) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  navigate(href, false, focus === undefined ? null : { focus });
};

export function Thread({ conversation, position, dispatch, draft, savedReplies, showFuture, disconnected, sendMode }: {
  readonly conversation: Conversation;
  readonly position: Position;
  readonly dispatch: (action: Action) => void;
  readonly draft: Draft | undefined;
  readonly savedReplies: readonly SavedReply[];
  readonly showFuture: boolean;
  readonly disconnected: boolean;
  readonly sendMode: SendMode;
}) {
  const account = accountOf(conversation.accountId);
  const [escalating, setEscalating] = useState(false);
  const [routing, setRouting] = useState(false);
  const viewing = conversation.presence !== null && conversation.presence.who !== ME && conversation.presence.doing === "viewing" ? teammate(conversation.presence.who) : null;
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const jump = useRef(false);
  const count = conversation.messages.length + conversation.notes.length + conversation.events.length;

  // Previous/Next keep the focus on the arrow that was used (the conversation behind it changes, the control doesn't).
  useEffect(() => {
    const hint = focusHint().focus;
    if (hint === undefined) return;
    (document.querySelector<HTMLElement>(`[data-nav="${hint}"][href]`) ?? document.getElementById("thread-title"))?.focus({ preventScroll: true });
  }, []);

  // Chat convention: open at the latest activity. Afterwards follow new items only when the reader is already at the
  // bottom or just posted something themselves — never pull them away from older messages they're reading.
  useEffect(() => {
    const el = scroller.current;
    if (el === null) return;
    const measure = () => {
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      el.removeEventListener("scroll", measure);
    };
  }, []);
  useEffect(() => {
    const el = scroller.current;
    if (el === null || (!atBottom.current && !jump.current)) return;
    jump.current = false;
    el.scrollTo({ top: el.scrollHeight });
    atBottom.current = true;
  }, [count]);

  const changeState = () => {
    const leaving = position.leavesOnStateChange;
    dispatch({ type: "setState", id: conversation.id, state: conversation.state === "open" ? "done" : "open" });
    // Leaving the view returns to its list (Undo stays in the toast) instead of a "Not in Open" dead end.
    if (leaving) navigate(position.back, false, { focusRow: position.neighbor });
  };

  return (
    <article className={cx("thread")} aria-labelledby="thread-title">
      <header className={cx("threadHead")}>
        <div className={cx("threadTop")}>
          <a className={cx("backLink")} href={position.back} onClick={go(position.back)} aria-label={`Back to ${position.backLabel}`}>
            <span aria-hidden="true">←</span>
            <span className={cx("backText")} aria-hidden="true">
              {position.backLabel}
            </span>
          </a>
          <span className={cx("threadAvatar")}>
            <Avatar initials={conversation.participant.initials} size="lg" />
          </span>
          <div className={cx("identityText")}>
            <div className={cx("titleLine")}>
              <h2 id="thread-title" className={cx("threadTitle")} tabIndex={-1}>
                {conversation.participant.name}
              </h2>
              <span className={cx("titlePill")}>
                <StatePill tone={conversation.state === "done" ? "success" : "neutral"}>{conversation.state === "done" ? "Done" : "Open"}</StatePill>
              </span>
            </div>
            <p className={cx("identityMeta")}>
              <span className={cx("metaState")}>{conversation.state === "done" ? "Done" : "Open"} ·</span>
              <PlatformMark platform={account.platform} />
              <span className={cx("identityWhere")} title={`${conversation.participant.handle === undefined ? PLATFORM_NAMES[account.platform] : `@${conversation.participant.handle} on ${PLATFORM_NAMES[account.platform]}`} · to ${accountTarget(account)}`}>
                {conversation.participant.handle === undefined ? PLATFORM_NAMES[account.platform] : `@${conversation.participant.handle} on ${PLATFORM_NAMES[account.platform]}`} · to <strong>{accountTarget(account)}</strong>
              </span>
              {conversation.request ? (
                <span className={cx("requestTag")}>
                  Message request
                  <Info label="About message requests">The person doesn’t follow this account, so Instagram shows the conversation as a request. How requests behave through Meta’s API is still being validated.</Info>
                </span>
              ) : null}
            </p>
          </div>
          <nav className={cx("threadNav")} aria-label="Conversation navigation">
            <span className={cx("position")}>{position.label}</span>
            <a className={cx("navMove", position.previous === null && "navEnd")} data-nav="previous" href={position.previous ?? undefined} aria-disabled={position.previous === null} onClick={position.previous === null ? undefined : go(position.previous, "previous")} aria-label="Previous conversation">
              <span aria-hidden="true">↑</span>
            </a>
            <a className={cx("navMove", position.next === null && "navEnd")} data-nav="next" href={position.next ?? undefined} aria-disabled={position.next === null} onClick={position.next === null ? undefined : go(position.next, "next")} aria-label="Next conversation">
              <span aria-hidden="true">↓</span>
            </a>
          </nav>
        </div>
        <div className={cx("handling")}>
          <AssignMenu conversation={conversation} dispatch={dispatch} />
          {conversation.escalation === null ? null : (
            <button
              type="button"
              className={cx("escalatedChip")}
              onClick={() => {
                setEscalating(true);
              }}
            >
              <Icon name="decision-escalate" size={16} />
              Escalated{conversation.escalation.to === null ? "" : ` to ${firstName(teammate(conversation.escalation.to)?.name ?? "")}`}
            </button>
          )}
          {viewing === null ? null : (
            <span className={cx("viewing")}>
              <span className={cx("presenceDot")} aria-hidden="true" />
              {firstName(viewing.name)} is viewing
            </span>
          )}
          <span className={cx("handlingEnd")}>
            <Button
              size="sm"
              variant={conversation.state === "open" ? "primary" : "secondary"}
              {...(conversation.state === "open" ? { icon: "decision-approve" as const } : {})}
              onClick={changeState}
            >
              {conversation.state === "open" ? "Mark done" : "Reopen"}
            </Button>
            <MoreMenu
              conversation={conversation}
              dispatch={dispatch}
              back={position.back}
              onEscalate={() => {
                setEscalating(true);
              }}
              onRouting={() => {
                setRouting(true);
              }}
            />
          </span>
        </div>
        {showFuture && conversation.future !== null ? <FutureInsight conversation={conversation} /> : null}
      </header>
      <div ref={scroller} className={cx("scroller")}>
        <Timeline conversation={conversation} />
      </div>
      <Composer
        conversation={conversation}
        draft={draft}
        dispatch={dispatch}
        savedReplies={savedReplies}
        showFuture={showFuture}
        disconnected={disconnected}
        sendMode={sendMode}
        onOwnPost={() => {
          jump.current = true;
        }}
      />
      <EscalateDialog
        open={escalating}
        conversation={conversation}
        onClose={() => {
          setEscalating(false);
        }}
        dispatch={dispatch}
      />
      <Dialog
        open={routing}
        title="Who can reply on the platform"
        onClose={() => {
          setRouting(false);
        }}
        footer={
          <Button
            variant="primary"
            onClick={() => {
              setRouting(false);
            }}
          >
            Close
          </Button>
        }
      >
        <p>
          <strong>Assignment</strong> decides who handles this conversation <em>inside Wrenkind</em>. It never changes anything on {PLATFORM_NAMES[account.platform]}.
        </p>
        <p>
          <strong>Platform routing</strong> is Meta’s setting (Conversation Routing) that decides which connected app — for example Meta Business Suite or Wrenkind — may answer a conversation. It’s configured per account and isn’t managed here.
        </p>
        <p className={cx("muted")}>How routing affects replies from Wrenkind is still being validated with test accounts. This prototype doesn’t read or change it.</p>
      </Dialog>
    </article>
  );
}

function AssignMenu({ conversation, dispatch }: { readonly conversation: Conversation; readonly dispatch: (action: Action) => void }) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  useDismiss(open, close, panel, trigger);
  const onMenuKey = useMenuKeys(open, panel, close);
  const current = teammate(conversation.assignee);
  return (
    <div className={cx("menuWrap")}>
      <button
        ref={trigger}
        type="button"
        className={cx("assign")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Assigned to ${current === null ? "nobody" : current.name}. Change assignee`}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {current === null ? <span className={cx("avatar", "avatar-sm", "avatarEmpty")} aria-hidden="true" /> : <Avatar initials={current.initials} size="sm" tone="team" />}
        <span className={cx("assignLabel")}>Assignee</span>
        <span className={cx("long")}>{current === null ? "Unassigned" : conversation.assignee === ME ? "You" : current.name}</span>
        <span className={cx("short")}>{current === null ? "Assign" : conversation.assignee === ME ? "You" : firstName(current.name)}</span>
        <span aria-hidden="true" className={cx("caret")}>▾</span>
      </button>
      {open ? <div className={cx("menuScrim")} aria-hidden="true" /> : null}
      {open ? (
        <div ref={panel} className={cx("menu")} role="menu" aria-label="Assign in Wrenkind" onKeyDown={onMenuKey}>
          <p className={cx("menuNote")}>Who handles it in Wrenkind</p>
          {[ME, ...TEAM.map((t) => t.id).filter((id) => id !== ME), null].map((id) => {
            const person = teammate(id);
            return (
              <button
                key={id ?? "none"}
                type="button"
                role="menuitemradio"
                aria-checked={conversation.assignee === id}
                className={cx("menuItem")}
                onClick={() => {
                  if (conversation.assignee !== id) dispatch({ type: "assign", id: conversation.id, to: id });
                  setOpen(false);
                  trigger.current?.focus();
                }}
              >
                <span className={cx("menuItemMain")}>
                  {person === null ? <span className={cx("avatar", "avatar-xs", "avatarEmpty")} aria-hidden="true" /> : <Avatar initials={person.initials} size="xs" tone="team" />}
                  {person === null ? "Unassigned" : id === ME ? `${person.name} (you)` : person.name}
                </span>
                {conversation.assignee === id ? <span aria-hidden="true">✓</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function MoreMenu({ conversation, dispatch, back, onEscalate, onRouting }: { readonly conversation: Conversation; readonly dispatch: (action: Action) => void; readonly back: string; readonly onEscalate: () => void; readonly onRouting: () => void }) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  useDismiss(open, close, panel, trigger);
  const onMenuKey = useMenuKeys(open, panel, close);
  // Focus goes back to the More button first, so a dialog opened from the menu returns it there when it closes.
  const item = (label: ReactNode, action: () => void) => (
    <button
      type="button"
      role="menuitem"
      className={cx("menuItem")}
      onClick={() => {
        trigger.current?.focus();
        setOpen(false);
        action();
      }}
    >
      {label}
    </button>
  );
  return (
    <div className={cx("menuWrap")}>
      <button
        ref={trigger}
        type="button"
        className={cx("iconButton")}
        aria-label="More actions for this conversation"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name="util-more" size={20} />
      </button>
      {open ? <div className={cx("menuScrim")} aria-hidden="true" /> : null}
      {open ? (
        <div ref={panel} className={cx("menu", "menuEnd")} role="menu" aria-label="More actions" onKeyDown={onMenuKey}>
          {item(conversation.escalation === null ? "Escalate…" : "View or close escalation…", onEscalate)}
          {item("Mark as unread for you", () => {
            // Unread for you only (never a platform read receipt). Back to the list so opening doesn't clear it again.
            dispatch({ type: "markUnread", id: conversation.id });
            navigate(back, false, { focusRow: conversation.id });
          })}
          {item("Who can reply on the platform?", onRouting)}
          <div className={cx("menuDivider")} role="separator" />
          <button type="button" role="menuitem" aria-disabled="true" className={cx("menuItem", "menuItemOff")}>
            Labels <Marker kind="later">Later</Marker>
          </button>
          <button type="button" role="menuitem" aria-disabled="true" className={cx("menuItem", "menuItemOff")}>
            Open in {PLATFORM_NAMES[accountOf(conversation.accountId).platform]} <span className={cx("menuHint")}>not in prototype</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function EscalateDialog({ open, conversation, onClose, dispatch }: { readonly open: boolean; readonly conversation: Conversation; readonly onClose: () => void; readonly dispatch: (action: Action) => void }) {
  const [reason, setReason] = useState<string>(conversation.escalation?.reason ?? ESCALATION_REASONS[0]);
  const [to, setTo] = useState<string>(conversation.escalation?.to ?? "t-ana");
  const [note, setNote] = useState(conversation.escalation?.note ?? "");
  return (
    <Dialog
      open={open}
      title={conversation.escalation === null ? "Escalate conversation" : "Escalation"}
      onClose={onClose}
      footer={
        <>
          {conversation.escalation === null ? null : (
            <Button
              variant="ghost"
              onClick={() => {
                dispatch({ type: "escalate", id: conversation.id, escalation: null });
                onClose();
              }}
            >
              Close escalation
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => {
              dispatch({ type: "escalate", id: conversation.id, escalation: { reason, to, note: note.trim() } });
              onClose();
            }}
          >
            {conversation.escalation === null ? "Escalate" : "Update"}
          </Button>
        </>
      }
    >
      <p className={cx("muted")}>Raises this conversation to a teammate inside this workspace. Nothing is sent outside Wrenkind.</p>
      <label className={cx("fieldLabel")}>
        Reason
        <select
          className={cx("select")}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        >
          {ESCALATION_REASONS.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
      <label className={cx("fieldLabel")}>
        To
        <select
          className={cx("select")}
          value={to}
          onChange={(event) => {
            setTo(event.target.value);
          }}
        >
          {TEAM.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label className={cx("fieldLabel")}>
        Note (optional)
        <textarea
          className={cx("textarea")}
          rows={3}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </label>
    </Dialog>
  );
}

function FutureInsight({ conversation }: { readonly conversation: Conversation }) {
  const insight = conversation.future;
  if (insight === null) return null;
  return (
    <details className={cx("future")}>
      <summary className={cx("futureSummary")}>
        <Marker kind="future">Future · not active</Marker>
        <span>{insight.intent}</span>
        <span className={cx("muted")}>· Urgency {insight.urgency.toLowerCase()} · why?</span>
      </summary>
      <div className={cx("futureBody")}>
        <p>{insight.summary}</p>
        <ul>
          {insight.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <p className={cx("hint")}>Illustration written by hand for this prototype — no classification or AI ran. Intelligence over private messages needs legal review and its own gates.</p>
      </div>
    </details>
  );
}

type Entry =
  | { readonly kind: "message"; readonly at: number; readonly message: Message }
  | { readonly kind: "note"; readonly at: number; readonly note: Note }
  | { readonly kind: "event"; readonly at: number; readonly event: SystemEvent };

function Timeline({ conversation }: { readonly conversation: Conversation }) {
  const entries: Entry[] = [
    ...conversation.messages.map((message): Entry => ({ kind: "message", at: Date.parse(message.at), message })),
    ...conversation.notes.map((note): Entry => ({ kind: "note", at: Date.parse(note.at), note })),
    ...conversation.events.map((event): Entry => ({ kind: "event", at: Date.parse(event.at), event })),
  ].sort((a, b) => a.at - b.at);
  const account = accountOf(conversation.accountId);
  const byId = new Map(conversation.messages.map((m) => [m.id, m]));
  const rendered: ReactNode[] = [];
  let previous: Entry | undefined;
  for (const entry of entries) {
    if (previous === undefined || !sameDay(previous.at, entry.at)) {
      rendered.push(
        <li key={`day-${String(entry.at)}`} className={cx("day")}>
          <span>{dayLabel(entry.at)}</span>
        </li>,
      );
    }
    if (entry.kind === "note") rendered.push(<NoteItem key={entry.note.id} note={entry.note} />);
    else if (entry.kind === "event") rendered.push(<EventItem key={entry.event.id} event={entry.event} />);
    else {
      const grouped = previous?.kind === "message" && previous.message.dir === entry.message.dir && (entry.message.dir !== "out" || previous.message.sender === entry.message.sender) && entry.at - previous.at < 15 * 60_000;
      rendered.push(<Bubble key={entry.message.id} message={entry.message} conversation={conversation} quoted={entry.message.replyTo === undefined ? undefined : byId.get(entry.message.replyTo)} grouped={grouped} platform={account.platform} />);
    }
    previous = entry;
  }
  return (
    <section className={cx("timelineWrap")} aria-label="Conversation">
      {conversation.partialHistory ? (
        <p className={cx("history")}>
          <Icon name="estado-sync" size={16} />
          <span>Earlier messages aren’t available — for conversations that started before the account was connected, Instagram only provides the most recent ones.</span>
        </p>
      ) : null}
      <ol className={cx("timeline")}>{rendered}</ol>
    </section>
  );
}

function EventItem({ event }: { readonly event: SystemEvent }) {
  return (
    <li className={cx("event")}>
      <span>
        {event.text} · <time dateTime={event.at}>{timeOf(event.at)}</time>
      </span>
    </li>
  );
}

function NoteItem({ note }: { readonly note: Note }) {
  const author = teammate(note.author);
  return (
    <li className={cx("note")} aria-label={`Internal note by ${author?.name ?? "a teammate"}`}>
      <span className={cx("noteHead")}>
        <Icon name="decision-draft" size={16} />
        <strong>Internal note</strong>
        <span>
          · {author?.name ?? "Teammate"} · <time dateTime={note.at}>{timeOf(note.at)}</time>
        </span>
        <span className={cx("noteScope")}>Only your team</span>
      </span>
      <p className={cx("noteText")}>{note.text}</p>
    </li>
  );
}

function Bubble({ message, conversation, quoted, grouped, platform }: { readonly message: Message; readonly conversation: Conversation; readonly quoted: Message | undefined; readonly grouped: boolean; readonly platform: "instagram" | "messenger" }) {
  const [shown, setShown] = useState<Lang | null>(null);
  const mine = message.dir !== "in";
  const account = accountOf(conversation.accountId);
  const targets = message.translations === undefined ? [] : (Object.keys(message.translations) as Lang[]);
  const sender =
    message.dir === "in" ? conversation.participant.name : message.dir === "native" ? `${account.name} · from ${message.app ?? "another app"}` : `${account.name} · ${message.sender === ME ? "you" : (teammate(message.sender ?? null)?.name ?? "teammate")}`;
  const translated = shown === null ? undefined : message.translations?.[shown];
  return (
    <li className={cx("message", mine ? "messageOut" : "messageIn", grouped && "messageGrouped")}>
      {grouped ? null : <span className={cx("sender")}>{sender}</span>}
      {quoted === undefined ? null : (
        <span className={cx("quote")}>
          <span className="wk-sr-only">Replying to: </span>
          {quoted.text ?? "an attachment"}
        </span>
      )}
      <div className={cx("bubble", mine ? "bubbleOut" : "bubbleIn", message.dir === "native" && "bubbleNative", message.demo === true && "bubbleDemo", message.text === undefined && message.unsent !== true && "bubbleBare", message.unsent === true && "bubbleUnsent")}>
        {message.unsent === true ? (
          <p className={cx("unsent")}>{conversation.participant.name} unsent a message. Its content was removed.</p>
        ) : (
          <>
            {message.text === undefined ? null : (
              <p className={cx("bubbleText")} lang={translated === undefined ? message.lang : (shown ?? undefined)}>
                {translated ?? message.text}
              </p>
            )}
            {message.attachments?.map((attachment) => (
              <span key={attachment.name} className={cx("attachment", !attachment.available && "attachmentGone")}>
                <span className={cx("attachmentIcon")} aria-hidden="true">
                  <Icon name={attachment.kind === "image" ? "conv-post" : attachment.kind === "file" ? "util-download" : "conv-link"} size={20} />
                </span>
                <span>
                  <span className={cx("attachmentName")}>{attachment.available ? attachment.name : `${attachment.detail} no longer available`}</span>
                  <span className={cx("attachmentDetail")}>{attachment.available ? `${attachment.detail} · preview not stored` : `The ${PLATFORM_NAMES[platform]} link expired — ask ${firstName(conversation.participant.name)} to send it again.`}</span>
                </span>
              </span>
            ))}
          </>
        )}
      </div>
      <span className={cx("meta")}>
        <time dateTime={message.at} title={fullOf(message.at)}>
          {timeOf(message.at)}
        </time>
        {message.edited === true ? <span>· Edited</span> : null}
        {message.reaction === undefined ? null : (
          <span className={cx("reaction")} role="img" aria-label={`Reacted ${message.reaction}`}>
            {message.reaction}
          </span>
        )}
        {mine && message.receipt !== undefined ? <span>· {message.receipt === "seen" ? "Seen" : message.receipt === "delivered" ? "Delivered" : "Sent"}</span> : null}
        {message.demo === true ? <Marker kind="demo">Demo — not sent</Marker> : null}
      </span>
      {message.lang === undefined || targets.length === 0 ? null : (
        <span className={cx("translateRow")}>
          {translated === undefined ? (
            targets.map((lang) => (
              <button
                key={lang}
                type="button"
                className={cx("linkButton")}
                onClick={() => {
                  setShown(lang);
                }}
              >
                Translate to {LANG_NAMES[lang]}
              </button>
            ))
          ) : (
            <>
              <span>
                {LANG_NAMES[message.lang]} → {LANG_NAMES[shown ?? "en"]} · <em className={cx("fixture")}>illustrative fixture</em>
              </span>
              <button
                type="button"
                className={cx("linkButton")}
                onClick={() => {
                  setShown(null);
                }}
              >
                Show original
              </button>
            </>
          )}
        </span>
      )}
    </li>
  );
}
