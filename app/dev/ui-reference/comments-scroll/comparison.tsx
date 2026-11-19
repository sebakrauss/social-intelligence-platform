"use client";

/**
 * COMMENTS-UX-07A — DEVELOPMENT ONLY. Three scroll models for the Comments workspace, side by side in one page so the
 * Product Owner can feel them with a wheel, a trackpad and a keyboard:
 *   A  Independent panels — the page never moves; the list and the conversation each scroll on their own.
 *   B  Full page — the page is the one scroller; list and conversation flow with it; nothing sticks.
 *   C  Hybrid — the page is the scroller and carries the conversation; the list stays in view beside it (the only inner
 *      scroller), and the conversation's header sticks while you read.
 * Same synthetic conversations, density and Direction C tokens in all three; the width presets reproduce the tablet and
 * phone layouts inside a desktop window (container queries). Labels belong to the conversation (UX-07A §3): shown in the
 * list row and the header, managed from the header only; no reply carries a label control. The comment menu shows the
 * proposed wording only (nothing is actionable). Nothing is read, stored or sent; there is no composer.
 */
import { useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Icon } from "@/ui/icons/icon";
import { classOf, LONG_THREAD_ID, SCROLL_CONVERSATIONS, SCROLL_LABELS, SHORT_THREAD_ID, type ScrollConversation, type ScrollEntry } from "./data";
import styles from "./comparison.module.css";

type Mode = "a" | "b" | "c";
type Width = "fit" | "1280" | "834" | "390";
type Sheet = "compare" | "conventions";
type Pending =
  | { readonly kind: "open"; readonly via: "row" | "previous" | "next" | "guide"; readonly id: string }
  | { readonly kind: "back"; readonly id: string }
  | { readonly kind: "reply" }
  | { readonly kind: "replyBack"; readonly id: string }
  | { readonly kind: "top" };

const c = (...names: readonly (string | false | undefined)[]): string =>
  names
    .filter((name): name is string => typeof name === "string" && name !== "")
    .map((name) => classOf(styles, name))
    .join(" ");

/* ───────────── glyphs: one 16px family, 1.5 stroke (prototype-only, like the approved prototype's) ───────────── */

type GlyphName = "chevronLeft" | "chevronRight" | "chevronUp" | "chevronDown" | "eyeOff" | "trash" | "ban" | "info" | "tag";
const GLYPHS = new Map<GlyphName, readonly string[]>([
  ["chevronLeft", ["M10 3.5L5.5 8l4.5 4.5"]],
  ["chevronRight", ["M6 3.5L10.5 8 6 12.5"]],
  ["chevronUp", ["M3.5 10L8 5.5l4.5 4.5"]],
  ["chevronDown", ["M3.5 6L8 10.5 12.5 6"]],
  ["eyeOff", ["M2 2l12 12", "M6.6 3.7A6.8 6.8 0 018 3.5c4.1 0 6.5 4.5 6.5 4.5a11 11 0 01-1.9 2.4", "M4.2 4.9C2.4 6.1 1.5 8 1.5 8s2.4 4.5 6.5 4.5c1.1 0 2.1-.3 3-.8", "M6.6 6.6a2 2 0 002.8 2.8"]],
  ["trash", ["M2.5 4.5h11", "M6 4.5V3a1 1 0 011-1h2a1 1 0 011 1v1.5", "M3.8 4.5l.7 9a1 1 0 001 .9h5a1 1 0 001-.9l.7-9", "M6.8 7v5M9.2 7v5"]],
  ["ban", ["M8 14.5a6.5 6.5 0 100-13 6.5 6.5 0 000 13z", "M3.4 3.4l9.2 9.2"]],
  ["info", ["M8 14.5a6.5 6.5 0 100-13 6.5 6.5 0 000 13z", "M8 7.2v4", "M8 5h.01"]],
  ["tag", ["M2 2.5h5.3l6.2 6.2-4.8 4.8-6.2-6.2V2.5z", "M5 5.3h.01"]],
]);

function Glyph({ name }: { readonly name: GlyphName }) {
  return (
    <svg className={c("glyph")} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {(GLYPHS.get(name) ?? []).map((d) => (
        <path key={d} d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

/* ───────────── the three models, in the words the guide uses ───────────── */

const MODES: readonly { readonly id: Mode; readonly letter: string; readonly name: string; readonly behaves: string; readonly notice: readonly string[] }[] = [
  {
    id: "a",
    letter: "A",
    name: "Independent panels",
    behaves: "The page never moves. The list and the conversation are two separate scroll areas; the wheel scrolls whichever one the pointer is over.",
    notice: [
      "With the pointer over the list, the wheel moves the list; over the margins or the header, nothing moves.",
      "Your place in the list never changes when you open a conversation.",
      "Keyboard: Page Down scrolls the area that has focus — after clicking a row, that is the list, not the conversation.",
      "On a phone, the browser bar does not collapse: the page itself never scrolls.",
    ],
  },
  {
    id: "b",
    letter: "B",
    name: "Full page",
    behaves: "The page is the only scroller. The list and the conversation flow with it, one under the other's height; nothing sticks.",
    notice: [
      "The wheel works anywhere on the page, with no trapping.",
      "Opening a conversation from far down the list scrolls the page up to the conversation, and the list goes with it: you lose your place.",
      "A short conversation next to a long list leaves a long empty reading column.",
      "Previous / Next become the practical way to move between conversations.",
    ],
  },
  {
    id: "c",
    letter: "C",
    name: "Hybrid",
    behaves: "The page scrolls and carries the conversation. The list stays in view beside it (its own scroll area, the only one), and the conversation's header sticks while you read.",
    notice: [
      "The wheel over the conversation, the margins or the header scrolls the page — the long thread reads like a document.",
      "The list stays where you left it while you read and when you open another conversation.",
      "Over the list, the wheel scrolls the list; at its ends it hands over to the page.",
      "Keyboard: after clicking a row, Page Down scrolls the list; Tab into the conversation (or Previous / Next) to read with the keyboard.",
    ],
  },
];

const WIDTHS: readonly { readonly id: Width; readonly name: string }[] = [
  { id: "fit", name: "Fit window" },
  { id: "1280", name: "Laptop 1280" },
  { id: "834", name: "Tablet 834" },
  { id: "390", name: "Phone 390" },
];

const LABEL_NAMES = new Map(SCROLL_LABELS.map((label) => [label.id, label.name]));

export function ScrollComparison() {
  const [mode, setMode] = useState<Mode>("a");
  const [width, setWidth] = useState<Width>("fit");
  const [sheet, setSheet] = useState<Sheet>("compare");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [labels, setLabels] = useState<ReadonlyMap<string, readonly string[]>>(() => new Map(SCROLL_CONVERSATIONS.map((item) => [item.id, item.seedLabels])));
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // The comparison's own controls can be hidden, so model A is judged with the whole viewport (as B and C scroll them away).
  const [controlsShown, setControlsShown] = useState(true);

  const pending = useRef<Pending | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLElement>(null);
  const listColRef = useRef<HTMLElement>(null);
  const readTopRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const previousRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const replyHeadingRef = useRef<HTMLHeadingElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const replyButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  const schedule = (next: Pending): void => {
    pending.current = next;
    setTick((value) => value + 1);
  };

  // Scroll and focus after the change is drawn: one place, so the three models differ only by their CSS.
  useLayoutEffect(() => {
    const next = pending.current;
    pending.current = null;
    if (next === null) return;
    // The list column is not drawn on single-panel widths while a conversation is open.
    const single = (listColRef.current?.getClientRects().length ?? 0) === 0;
    if (next.kind === "open") {
      readTopRef.current?.scrollIntoView({ block: single ? "start" : "nearest" });
      if (next.via === "row" && !single) rowRefs.current.get(next.id)?.focus({ preventScroll: true });
      else if (next.via === "previous" || next.via === "next") {
        const button = (next.via === "previous" ? previousRef : nextRef).current;
        if (button !== null && !button.disabled) button.focus({ preventScroll: true });
        else headingRef.current?.focus({ preventScroll: true });
      } else if (next.via === "row") backRef.current?.focus({ preventScroll: true });
      else headingRef.current?.focus({ preventScroll: true });
    } else if (next.kind === "back") {
      const row = rowRefs.current.get(next.id);
      row?.scrollIntoView({ block: "center" });
      row?.focus({ preventScroll: true });
    } else if (next.kind === "reply") {
      replyHeadingRef.current?.scrollIntoView({ block: "nearest" });
      replyHeadingRef.current?.focus({ preventScroll: true });
    } else if (next.kind === "replyBack") {
      const button = replyButtonRefs.current.get(next.id);
      button?.scrollIntoView({ block: "nearest" });
      button?.focus({ preventScroll: true });
    } else {
      rootRef.current?.scrollIntoView({ block: "start" });
      for (const scroller of rootRef.current?.querySelectorAll("[data-scroller]") ?? []) scroller.scrollTop = 0;
    }
  }, [tick]);

  const selected = SCROLL_CONVERSATIONS.find((item) => item.id === selectedId);
  const index = selected === undefined ? -1 : selected.position - 1;
  const previous = index > 0 ? SCROLL_CONVERSATIONS.at(index - 1) : undefined;
  const next = index >= 0 ? SCROLL_CONVERSATIONS.at(index + 1) : undefined;
  const activeMode = MODES.find((item) => item.id === mode) ?? MODES[0];

  const open = (id: string, via: "row" | "previous" | "next" | "guide"): void => {
    setSheet("compare");
    setSelectedId(id);
    setLabelsOpen(false);
    setMenuFor(null);
    setReplyTo(null);
    schedule({ kind: "open", via, id });
  };
  const back = (): void => {
    if (selectedId === null) return;
    const id = selectedId;
    setSelectedId(null);
    setLabelsOpen(false);
    setMenuFor(null);
    setReplyTo(null);
    schedule({ kind: "back", id });
  };
  const reset = (change: () => void): void => {
    change();
    setLabelsOpen(false);
    setMenuFor(null);
    schedule({ kind: "top" });
  };
  const toggleLabel = (conversationId: string, labelId: string): void => {
    setLabels((current) => {
      const now = current.get(conversationId) ?? [];
      const nextLabels = now.includes(labelId) ? now.filter((id) => id !== labelId) : [...now, labelId];
      return new Map([...current, [conversationId, nextLabels]]);
    });
  };

  return (
    <div ref={rootRef} className={c("root")} data-mode={mode}>
      {controlsShown ? (
      <section ref={controlsRef} className={c("controls")} aria-labelledby="cmp-title">
        <div className={c("controlsHead")}>
          <h1 id="cmp-title" className={c("controlsTitle")}>
            Comments — scroll comparison
          </h1>
          <p className={c("controlsNote")}>UX-07A · development only · synthetic conversations from the approved prototype · nothing is saved or sent · Light / Dark follows your system setting</p>
        </div>
        <div className={c("controlsRow")}>
          <div className={c("segment")} role="group" aria-label="Scroll model">
            <span className={c("segmentLabel")} aria-hidden="true">
              Scroll model
            </span>
            {MODES.map((item) => (
              <button key={item.id} type="button" className={c("segmentButton")} aria-pressed={mode === item.id} onClick={() => { reset(() => { setMode(item.id); }); }}>
                <span className={c("segmentLetter")}>{item.letter}</span>
                <span>{item.name}</span>
              </button>
            ))}
          </div>
          <div className={c("segment")} role="group" aria-label="Frame width">
            <span className={c("segmentLabel")} aria-hidden="true">
              Width
            </span>
            {WIDTHS.map((item) => (
              <button key={item.id} type="button" className={c("segmentButton")} aria-pressed={width === item.id} onClick={() => { reset(() => { setWidth(item.id); }); }}>
                {item.name}
              </button>
            ))}
          </div>
          <div className={c("segment")} role="group" aria-label="Sheet">
            <button type="button" className={c("segmentButton")} aria-pressed={sheet === "compare"} onClick={() => { reset(() => { setSheet("compare"); }); }}>
              Comparison
            </button>
            <button type="button" className={c("segmentButton")} aria-pressed={sheet === "conventions"} onClick={() => { reset(() => { setSheet("conventions"); }); }}>
              Proposed conventions
            </button>
          </div>
          <button type="button" className={c("btn", "btnSmall")} onClick={() => { reset(() => { setControlsShown(false); }); }}>
            Hide controls
          </button>
        </div>
        <details className={c("guide")} open>
          <summary className={c("guideSummary")}>
            <Glyph name="chevronRight" />
            <span>{`${activeMode?.letter ?? ""} · ${activeMode?.name ?? ""}: how it behaves and what to try`}</span>
          </summary>
          <div className={c("guideBody")}>
            <p className={c("guideBehaves")}>{activeMode?.behaves}</p>
            <ul className={c("guideList")}>
              {(activeMode?.notice ?? []).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <div className={c("guideActions")}>
              <button type="button" className={c("btn")} onClick={() => { open(LONG_THREAD_ID, "guide"); }}>
                Open the long thread
              </button>
              <button type="button" className={c("btn")} onClick={() => { open(SHORT_THREAD_ID, "guide"); }}>
                Open a short conversation
              </button>
              <button type="button" className={c("btn")} disabled={selectedId === null} onClick={() => { reset(() => { setSelectedId(null); }); }}>
                Close the conversation
              </button>
            </div>
            <p className={c("guideHint")}>
              Try each model the same way: read the long thread to the end (wheel or trackpad, with the pointer over the thread, then over the list, then over the margin), scroll the list near its end and open a conversation there, use Previous / Next, Tab into the thread and press Space or Page Down, and press Reply on a deep reply. Then switch the width to Tablet or Phone, open a conversation and come back with All comments.
            </p>
          </div>
        </details>
      </section>
      ) : null}

      {sheet === "compare" ? (
        <div className={c("frameWrap")}>
          <div className={c("frame")} data-width={width} data-view={selected === undefined ? "list" : "conversation"}>
            <div className={c("app")}>
              <ShellDecoration />
              <main className={c("workspace")} aria-label="Comments">
                <header className={c("pageHead")}>
                  <h2 className={c("pageTitle")}>Comments</h2>
                  <p className={c("pageMeta")}>{`${String(SCROLL_CONVERSATIONS.length)} open conversations · most recent activity first`}</p>
                </header>
                <div className={c("split")}>
                  <section ref={listColRef} className={c("listCol")} aria-label="Conversations" tabIndex={mode === "b" ? undefined : 0} data-scroller="">
                    <ol className={c("list")}>
                      {SCROLL_CONVERSATIONS.map((item) => (
                        <Row
                          key={item.id}
                          conversation={item}
                          labels={labels.get(item.id) ?? []}
                          selected={item.id === selectedId}
                          refFor={(element) => {
                            if (element === null) rowRefs.current.delete(item.id);
                            else rowRefs.current.set(item.id, element);
                          }}
                          onOpen={() => { open(item.id, "row"); }}
                        />
                      ))}
                    </ol>
                    <p className={c("listEnd")}>{`End of the list · ${String(SCROLL_CONVERSATIONS.length)} conversations`}</p>
                  </section>
                  <section className={c("readCol")} aria-label={selected === undefined ? "Conversation" : `Conversation with ${selected.author}`}>
                    {selected === undefined ? (
                      <div className={c("emptyPane")}>
                        <p>Select a conversation to read it here.</p>
                      </div>
                    ) : (
                      <ConversationPane
                        key={selected.id}
                        conversation={selected}
                        labels={labels.get(selected.id) ?? []}
                        mode={mode}
                        previous={previous}
                        next={next}
                        labelsOpen={labelsOpen}
                        menuFor={menuFor}
                        replyTo={replyTo}
                        readTopRef={readTopRef}
                        headingRef={headingRef}
                        backRef={backRef}
                        previousRef={previousRef}
                        nextRef={nextRef}
                        replyHeadingRef={replyHeadingRef}
                        replyButtonRef={(id, element) => {
                          if (element === null) replyButtonRefs.current.delete(id);
                          else replyButtonRefs.current.set(id, element);
                        }}
                        onBack={back}
                        onPrevious={() => { if (previous !== undefined) open(previous.id, "previous"); }}
                        onNext={() => { if (next !== undefined) open(next.id, "next"); }}
                        onLabelsOpen={setLabelsOpen}
                        onToggleLabel={(labelId) => { toggleLabel(selected.id, labelId); }}
                        onMenu={setMenuFor}
                        onReply={(id) => { setMenuFor(null); setReplyTo(id); schedule({ kind: "reply" }); }}
                        onReplyCancel={() => { const id = replyTo; setReplyTo(null); if (id !== null) schedule({ kind: "replyBack", id }); }}
                      />
                    )}
                  </section>
                </div>
              </main>
            </div>
          </div>
        </div>
      ) : (
        <Conventions />
      )}

      <nav className={c("pill")} aria-label="Switch scroll model">
        {MODES.map((item) => (
          <button key={item.id} type="button" className={c("pillButton")} aria-pressed={mode === item.id && sheet === "compare"} title={item.name} onClick={() => { reset(() => { setSheet("compare"); setMode(item.id); }); }}>
            {item.letter}
            <span className="wk-sr-only">{` — ${item.name}`}</span>
          </button>
        ))}
        <button
          type="button"
          className={c("pillButton", "pillWide")}
          onClick={() => {
            if (controlsShown) controlsRef.current?.scrollIntoView({ block: "start" });
            else reset(() => { setControlsShown(true); });
          }}
        >
          {controlsShown ? "Controls" : "Show controls"}
        </button>
      </nav>
    </div>
  );
}

/** The app shell's rail and sidebar, drawn for realistic widths only: decorative, not interactive. */
function ShellDecoration() {
  return (
    <>
      <div className={c("rail")} aria-hidden="true">
        {(["nav-home", "nav-inbox", "nav-insights", "nav-reports", "nav-settings"] as const).map((name) => (
          <span key={name} className={c("railItem", name === "nav-inbox" && "railActive")}>
            <Icon name={name} size={20} />
          </span>
        ))}
      </div>
      <div className={c("sidebar")} aria-hidden="true">
        <p className={c("sideWorkspace")}>Lumen Coffee</p>
        <p className={c("sideItem", "sideActive")}>Comments</p>
        <p className={c("sideItem")}>Settings</p>
      </div>
    </>
  );
}

function LabelChips({ ids, limit }: { readonly ids: readonly string[]; readonly limit?: number }) {
  if (ids.length === 0) return null;
  const shown = limit === undefined ? ids : ids.slice(0, limit);
  const rest = ids.length - shown.length;
  return (
    <ul className={c("chips")} aria-label="Labels">
      {shown.map((id) => (
        <li key={id} className={c("chip")}>
          <Glyph name="tag" />
          <span>{LABEL_NAMES.get(id) ?? id}</span>
        </li>
      ))}
      {rest > 0 ? (
        <li className={c("chip", "chipMore")}>
          <span>{`+${String(rest)}`}</span>
          <span className="wk-sr-only">{` more: ${ids.slice(shown.length).map((id) => LABEL_NAMES.get(id) ?? id).join(", ")}`}</span>
        </li>
      ) : null}
    </ul>
  );
}

function Row({ conversation, labels, selected, refFor, onOpen }: {
  readonly conversation: ScrollConversation;
  readonly labels: readonly string[];
  readonly selected: boolean;
  readonly refFor: (element: HTMLButtonElement | null) => void;
  readonly onOpen: () => void;
}) {
  return (
    <li className={c("row")}>
      <button ref={refFor} id={`row-${conversation.id}`} type="button" className={c("rowButton")} aria-current={selected ? "true" : undefined} data-selected={selected ? "" : undefined} onClick={onOpen}>
        <span className={c("rowTop")}>
          <span className={c("rowAuthor")}>{conversation.author}</span>
          <span className={c("rowAccount")}>{`${conversation.platform} · ${conversation.account}`}</span>
          <span className={c("rowTime")}>{conversation.time}</span>
        </span>
        <span className={c("rowExcerpt")}>{conversation.excerpt}</span>
        <span className={c("rowMeta")}>
          <span className={c("rowReplies")}>{conversation.replies === 0 ? "No replies" : conversation.replies === 1 ? "1 reply" : `${String(conversation.replies)} replies`}</span>
          <LabelChips ids={labels} limit={2} />
        </span>
      </button>
    </li>
  );
}


/** Closes a popover when focus leaves it (a click elsewhere, Tab past its end) and on Escape, returning focus to its trigger. */
function usePopover(onClose: () => void, trigger: RefObject<HTMLButtonElement | null>) {
  return {
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget)) return;
      onClose();
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      trigger.current?.focus();
    },
  };
}

function ConversationPane(props: {
  readonly conversation: ScrollConversation;
  readonly labels: readonly string[];
  readonly mode: Mode;
  readonly previous: ScrollConversation | undefined;
  readonly next: ScrollConversation | undefined;
  readonly labelsOpen: boolean;
  readonly menuFor: string | null;
  readonly replyTo: string | null;
  readonly readTopRef: RefObject<HTMLDivElement | null>;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly backRef: RefObject<HTMLButtonElement | null>;
  readonly previousRef: RefObject<HTMLButtonElement | null>;
  readonly nextRef: RefObject<HTMLButtonElement | null>;
  readonly replyHeadingRef: RefObject<HTMLHeadingElement | null>;
  readonly replyButtonRef: (id: string, element: HTMLButtonElement | null) => void;
  readonly onBack: () => void;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  readonly onLabelsOpen: (open: boolean) => void;
  readonly onToggleLabel: (labelId: string) => void;
  readonly onMenu: (id: string | null) => void;
  readonly onReply: (id: string) => void;
  readonly onReplyCancel: () => void;
}) {
  const { conversation, labels, readTopRef, headingRef, backRef, previousRef, nextRef, replyHeadingRef } = props;
  const labelsButton = useRef<HTMLButtonElement>(null);
  const labelsPopover = usePopover(() => { props.onLabelsOpen(false); }, labelsButton);
  const replying = conversation.entries.find((entry) => entry.id === props.replyTo);
  return (
    <div className={c("pane")}>
      <div ref={readTopRef} className={c("readTop")} />
      <header className={c("convBar")}>
        <div className={c("convTop")}>
          <button ref={backRef} type="button" className={c("btn", "btnQuiet", "backButton")} onClick={props.onBack}>
            <Glyph name="chevronLeft" />
            <span>All comments</span>
          </button>
          <h3 ref={headingRef} className={c("convTitle")} tabIndex={-1}>
            {conversation.author}
          </h3>
          <span className={c("convAccount")}>{`${conversation.platform} · ${conversation.account}`}</span>
          <nav className={c("convNav")} aria-label="Move through the list">
            <span className={c("convPosition")}>{`${String(conversation.position)} of ${String(SCROLL_CONVERSATIONS.length)}`}</span>
            <button ref={previousRef} type="button" className={c("iconButton")} aria-label="Previous conversation" title="Previous conversation" disabled={props.previous === undefined} onClick={props.onPrevious}>
              <Glyph name="chevronUp" />
            </button>
            <button ref={nextRef} type="button" className={c("iconButton")} aria-label="Next conversation" title="Next conversation" disabled={props.next === undefined} onClick={props.onNext}>
              <Glyph name="chevronDown" />
            </button>
          </nav>
        </div>
        <div className={c("convLabels")}>
          <LabelChips ids={labels} />
          <span className={c("anchor")} {...(props.labelsOpen ? labelsPopover : {})}>
            <button
              ref={labelsButton}
              type="button"
              className={c("btn", "btnSmall")}
              aria-expanded={props.labelsOpen}
              aria-controls={props.labelsOpen ? `labels-${conversation.id}` : undefined}
              onClick={() => { props.onLabelsOpen(!props.labelsOpen); }}
            >
              <Icon name="util-tag" size={16} />
              <span>Labels</span>
            </button>
            {props.labelsOpen ? (
              <div id={`labels-${conversation.id}`} className={c("popover")} role="group" aria-labelledby={`labels-${conversation.id}-title`}>
                <p id={`labels-${conversation.id}-title`} className={c("popoverTitle")}>
                  Labels for this conversation
                </p>
                <p className={c("popoverNote")}>
                  {conversation.siblings > 0
                    ? `Applies to ${conversation.author}'s comment and its replies — not to the ${String(conversation.siblings)} other conversation${conversation.siblings === 1 ? "" : "s"} on this post.`
                    : `Applies to ${conversation.author}'s comment and its replies.`}
                </p>
                <ul className={c("checkList")}>
                  {SCROLL_LABELS.map((label) => (
                    <li key={label.id}>
                      <label className={c("check")}>
                        <input type="checkbox" checked={labels.includes(label.id)} onChange={() => { props.onToggleLabel(label.id); }} />
                        <span>{label.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                <p className={c("popoverFoot")}>Local preview: labels reset when the page reloads.</p>
              </div>
            ) : null}
          </span>
        </div>
      </header>
      <div className={c("readBody")} data-scroller="" tabIndex={props.mode === "a" ? 0 : undefined} aria-label={props.mode === "a" ? "Thread" : undefined} role={props.mode === "a" ? "region" : undefined}>
        <p className={c("postContext")}>
          <span>{`On ${conversation.platform} · ${conversation.postKind}`}</span>
          {conversation.postCaption === null ? <span className={c("muted")}> · Post details not available</span> : <span className={c("muted")}>{` · “${conversation.postCaption}”`}</span>}
          {conversation.siblings > 0 ? <span className={c("muted")}>{` · ${String(conversation.siblings)} other conversation${conversation.siblings === 1 ? "" : "s"} on this post`}</span> : null}
        </p>
        <ol className={c("thread")} aria-label="Comment and replies">
          {conversation.entries.map((entry) => (
            <Entry
              key={entry.id}
              entry={entry}
              menuOpen={props.menuFor === entry.id}
              replyButtonRef={(element) => { props.replyButtonRef(entry.id, element); }}
              onMenu={(open) => { props.onMenu(open ? entry.id : null); }}
              onReply={() => { props.onReply(entry.id); }}
            />
          ))}
        </ol>
        <section className={c("replyArea")} aria-labelledby={`reply-${conversation.id}`}>
          <h4 id={`reply-${conversation.id}`} ref={replyHeadingRef} className={c("replyTitle")} tabIndex={-1}>
            {replying === undefined ? `Reply to ${conversation.author}` : `Replying to ${replying.author}`}
          </h4>
          <p className={c("replyNote")}>The existing reply composer appears here, unchanged. It is not part of this comparison.</p>
          {replying === undefined ? null : (
            <button type="button" className={c("btn", "btnSmall")} onClick={props.onReplyCancel}>
              Back to the comment
            </button>
          )}
        </section>
      </div>
    </div>
  );
}

function Entry({ entry, menuOpen, replyButtonRef, onMenu, onReply }: {
  readonly entry: ScrollEntry;
  readonly menuOpen: boolean;
  readonly replyButtonRef: (element: HTMLButtonElement | null) => void;
  readonly onMenu: (open: boolean) => void;
  readonly onReply: () => void;
}) {
  const moreButton = useRef<HTMLButtonElement>(null);
  const popover = usePopover(() => { onMenu(false); }, moreButton);
  const removed = entry.presence === "removed";
  return (
    <li className={c("entry", entry.own && "entryOwn")} data-depth={String(Math.min(entry.depth, 3))}>
      <article className={c("entryBody")} aria-labelledby={`c-${entry.id}`}>
        <p className={c("entryHead")}>
          <span id={`c-${entry.id}`} className={c("entryAuthor")}>
            {entry.author}
          </span>
          {entry.own ? <span className={c("tag")}>Your reply</span> : null}
          {entry.presence === "hidden" ? <span className={c("tag")}>Hidden</span> : null}
          <span className={c("entryTime")}>{entry.time}</span>
        </p>
        {entry.replyingTo !== null && entry.depth > 1 ? <p className={c("replyingTo")}>{`Replying to ${entry.replyingTo}`}</p> : null}
        <p className={c("entryText", removed && "muted")}>{removed ? "This comment was removed on the platform." : entry.text}</p>
        {entry.own || removed ? null : (
          <div className={c("entryActions")}>
            <button ref={replyButtonRef} type="button" className={c("btn", "btnQuiet", "btnSmall")} onClick={onReply}>
              Reply
            </button>
            <span className={c("anchor")} {...(menuOpen ? popover : {})}>
              <button
                ref={moreButton}
                type="button"
                className={c("iconButton")}
                aria-label={`More actions for ${entry.author}'s comment`}
                title="More actions"
                aria-expanded={menuOpen}
                onClick={() => { onMenu(!menuOpen); }}
              >
                <Icon name="util-more" size={16} />
              </button>
              {menuOpen ? (
                <div className={c("popover", "popoverMenu")} role="group" aria-label="Comment actions (wording preview)">
                  <p className={c("popoverNote")}>Wording preview — nothing here acts. In the product each opens its confirmation, and an action the platform does not support stays visible but unavailable, with its reason.</p>
                  <MenuItem glyph="eyeOff" text="Hide comment" />
                  <MenuItem glyph="trash" text="Delete comment" danger />
                  <MenuItem glyph="ban" text="Block author" danger />
                </div>
              ) : null}
            </span>
          </div>
        )}
      </article>
    </li>
  );
}

function MenuItem({ glyph, text, danger = false }: { readonly glyph: GlyphName; readonly text: string; readonly danger?: boolean }) {
  return (
    <button type="button" className={c("menuItem", danger && "menuDanger")} aria-disabled="true">
      <Glyph name={glyph} />
      <span>{text}</span>
    </button>
  );
}

/* ───────────── the reference sheet: Labels, icons, wording ───────────── */

function Cell({ children }: { readonly children: ReactNode }) {
  return <td className={c("cell")}>{children}</td>;
}

function Conventions() {
  return (
    <div className={c("sheet")}>
      <section className={c("sheetSection")} aria-labelledby="conv-labels">
        <h2 id="conv-labels" className={c("sheetTitle")}>
          Labels belong to the conversation
        </h2>
        <p className={c("sheetLead")}>A conversation is one root comment and every reply under it. Manual labels are assigned to that conversation — never to a single reply, and never to every conversation on the same post.</p>
        <table className={c("table")}>
          <thead>
            <tr>
              <th scope="col">Where</th>
              <th scope="col">Shows labels</th>
              <th scope="col">Assigns labels</th>
            </tr>
          </thead>
          <tbody>
            <tr><Cell>Conversation list row</Cell><Cell>Yes — up to two names, then “+N”</Cell><Cell>No</Cell></tr>
            <tr><Cell>Conversation header</Cell><Cell>Yes — all of them</Cell><Cell>Yes — the one “Labels” button (tag icon + word)</Cell></tr>
            <tr><Cell>Root comment</Cell><Cell>No (the header above it already shows them)</Cell><Cell>No</Cell></tr>
            <tr><Cell>Nested replies</Cell><Cell>No</Cell><Cell>No — replies keep Reply and More actions only</Cell></tr>
            <tr><Cell>Details drawer</Cell><Cell>No</Cell><Cell>No</Cell></tr>
            <tr><Cell>Other conversations on the same post</Cell><Cell>Their own labels only</Cell><Cell>Unaffected</Cell></tr>
            <tr><Cell>Settings › Labels</Cell><Cell>The workspace’s label set</Cell><Cell>Creates, renames, recolors (unchanged)</Cell></tr>
          </tbody>
        </table>
        <h3 className={c("sheetSub")}>What changes now, and what needs backend work later</h3>
        <ul className={c("sheetList")}>
          <li><strong>Visual (prototype):</strong> remove “+ Label” from every comment; add the “Labels” button and chips to the conversation header; the row shows the conversation’s labels; the label filter lists conversations that carry the label.</li>
          <li><strong>Future backend (not built here):</strong> one association per workspace, conversation and label — unique, carrying who assigned it and when, with its history and audit written in the same transaction; the conversation key is the Inbox’s existing conversation identity (root comment thread), not the post and not a comment; workspace-scoped references (R5) under forced RLS; the label set itself stays a workspace list.</li>
          <li><strong>Seed data:</strong> the approved prototype stores labels on comments; this comparison rolls them up to their conversation. Any later data migration would do the same, once.</li>
        </ul>
      </section>

      <section className={c("sheetSection")} aria-labelledby="conv-icons">
        <h2 id="conv-icons" className={c("sheetTitle")}>
          One meaning per arrow
        </h2>
        <p className={c("sheetLead")}>The kit has no chevrons; these 16px glyphs match its stroke. Left means back, up and down move through the list, a turning chevron opens in place, a trailing down chevron opens a choice, and dots mean more actions.</p>
        <table className={c("table")}>
          <thead>
            <tr>
              <th scope="col">Control</th>
              <th scope="col">Today (approved prototype)</th>
              <th scope="col">Proposed</th>
            </tr>
          </thead>
          <tbody>
            <tr><Cell>Back to the list</Cell><Cell><Glyph name="chevronLeft" /> + the view name</Cell><Cell><Glyph name="chevronLeft" /> “All comments” — the destination; only on tablet and phone</Cell></tr>
            <tr><Cell>Previous / Next conversation</Cell><Cell><Glyph name="chevronLeft" /> <Glyph name="chevronRight" /> — the same left chevron as Back</Cell><Cell><Glyph name="chevronUp" /> <Glyph name="chevronDown" /> with “3 of 48”: the list is vertical, and Back keeps the left chevron to itself</Cell></tr>
            <tr><Cell>Expand / Collapse in place</Cell><Cell><Glyph name="chevronRight" /> on one disclosure</Cell><Cell><Glyph name="chevronRight" /> closed, turning to <Glyph name="chevronDown" /> open — disclosures only</Cell></tr>
            <tr><Cell>Open a choice (Assign, Mark done)</Cell><Cell>Trailing <Glyph name="chevronDown" /></Cell><Cell>Trailing <Glyph name="chevronDown" /> — the only trailing chevron</Cell></tr>
            <tr><Cell>More actions</Cell><Cell><Icon name="util-more" size={16} /></Cell><Cell><Icon name="util-more" size={16} /> — never a chevron</Cell></tr>
            <tr><Cell>Details drawer</Cell><Cell><Glyph name="info" /> Details; the drawer has “<Glyph name="chevronLeft" /> Conversation” and <Icon name="util-close" size={16} /></Cell><Cell><Glyph name="info" /> Details opens it; <Icon name="util-close" size={16} /> or Esc closes it — drop the second “back” control</Cell></tr>
            <tr><Cell>Pagination</Cell><Cell>“Show more”</Cell><Cell>“Show older conversations” — words, no arrows</Cell></tr>
            <tr><Cell>Leave Wrenkind (view on the platform)</Cell><Cell><Icon name="util-external" size={16} /></Cell><Cell><Icon name="util-external" size={16} /> — only for leaving</Cell></tr>
          </tbody>
        </table>
      </section>

      <section className={c("sheetSection")} aria-labelledby="conv-wording">
        <h2 id="conv-wording" className={c("sheetTitle")}>
          Action menu wording
        </h2>
        <table className={c("table")}>
          <thead>
            <tr>
              <th scope="col">Today</th>
              <th scope="col">Proposed</th>
              <th scope="col">What stays</th>
            </tr>
          </thead>
          <tbody>
            <tr><Cell>Delete comment…</Cell><Cell>Delete comment</Cell><Cell>The confirmation step, its danger color and its “Delete comment” button</Cell></tr>
            <tr><Cell>Block author…</Cell><Cell>Block author</Cell><Cell>The confirmation step; Unblock author likewise</Cell></tr>
            <tr><Cell>Hide</Cell><Cell>Hide comment</Cell><Cell>No confirmation (reversible), as today</Cell></tr>
            <tr><Cell>Any action the platform does not support</Cell><Cell>Unchanged</Cell><Cell>Visible but unavailable, with its reason and the lock — never offered as available</Cell></tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}
