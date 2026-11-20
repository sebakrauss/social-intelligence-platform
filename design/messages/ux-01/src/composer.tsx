/**
 * MESSAGES-UX-01 — the composer (iteration 02). Reply and Internal note keep separate drafts (a note never moves into a
 * reply). Sending is always a human pressing Send (DEMO ONLY): Variant A sends directly; Variant B asks for a short
 * review only when the context warrants it (translated draft, a teammate also replying, escalation, a synthetic
 * high-risk marker) — never because of a provider capability. Emoji, Saved Replies (families with language variants)
 * and illustrative translation fixtures. Nothing here calls a model, a translation service or a provider.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button } from "@/ui/primitives/button";
import { Icon } from "@/ui/icons/icon";
import { detectFixtureLang, EMOJI, EMOJI_GROUPS, translateDraft, type Emoji } from "./data";
import { bytesOf, duration, EMPTY_DRAFT, fullOf, insertAt, LANG_NAMES, ME, NOW, PLATFORM_NAMES, reviewReasons, windowOf, type Action, type Conversation, type Draft, type Lang, type SavedReply, type SendMode } from "./model";
import { accountOf, accountTarget, cx, Dialog, firstName, Info, Marker, SheetHead, teammate, useDismiss } from "./ui";

type Panel = "emoji" | "saved" | "translate" | null;

const IG_LIMIT = 1000;
const LANGS: readonly Lang[] = ["en", "es", "pt"];

export function Composer({ conversation, draft, dispatch, savedReplies, showFuture, disconnected, sendMode, onOwnPost }: {
  readonly conversation: Conversation;
  readonly draft: Draft | undefined;
  readonly dispatch: (action: Action) => void;
  readonly savedReplies: readonly SavedReply[];
  readonly showFuture: boolean;
  readonly disconnected: boolean;
  readonly sendMode: SendMode;
  /** Called before the user's own send or note, so the thread follows to the bottom. */
  readonly onOwnPost: () => void;
}) {
  const current = draft ?? EMPTY_DRAFT;
  const mode = current.mode;
  const account = accountOf(conversation.accountId);
  const win = windowOf(conversation);
  const [panel, setPanel] = useState<Panel>(null);
  const [query, setQuery] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [confirmTakeOver, setConfirmTakeOver] = useState(false);
  const [noTranslation, setNoTranslation] = useState<Lang | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const reviewTitle = useRef<HTMLHeadingElement>(null);
  const caret = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const ids = useId();
  const replyAvailable = win.open && !disconnected;
  const replying = conversation.presence !== null && conversation.presence.doing === "replying" && conversation.presence.who !== ME ? teammate(conversation.presence.who) : null;
  const text = mode === "reply" ? current.reply : current.note;
  const bytes = bytesOf(current.reply);
  const over = account.platform === "instagram" && bytes > IG_LIMIT;
  const reasons = sendMode === "contextual" ? reviewReasons(conversation, current) : [];
  const canSend = replyAvailable && current.reply.trim() !== "" && !over;

  const closePanel = () => {
    setPanel(null);
  };
  // Escape and the sheet's ✕ give the focus back to the tool that opened the panel (or the field, for "/").
  useDismiss(panel !== null, closePanel, panelRef, triggerRef, textarea);
  const dismissPanel = () => {
    (triggerRef.current ?? textarea.current)?.focus();
    setPanel(null);
  };

  // Entering the contextual review moves focus to its heading, so it's read and the next Tab reaches Send.
  useEffect(() => {
    if (reviewing) reviewTitle.current?.focus();
  }, [reviewing]);

  // Put the caret where an insertion ended (after React wrote the new text).
  useEffect(() => {
    const at = caret.current;
    const field = textarea.current;
    if (at === null || field === null) return;
    caret.current = null;
    field.focus();
    field.setSelectionRange(at, at);
  });

  const write = (next: Draft) => {
    dispatch({ type: "draft", id: conversation.id, draft: next });
  };
  const setText = (next: string) => {
    if (mode === "reply") write({ ...current, reply: next });
    else write({ ...current, note: next });
  };
  const setMode = (next: "reply" | "note") => {
    setReviewing(false);
    setPanel(null);
    write({ ...current, mode: next });
  };
  /** Switch mode from a control that disappears with the switch (unavailable panel, collision line): focus the field. */
  const writeIn = (next: "reply" | "note") => {
    setMode(next);
    caret.current = (next === "reply" ? current.reply : current.note).length;
  };

  const insert = (value: string, replaceAll = false) => {
    const field = textarea.current;
    const start = replaceAll ? 0 : (field?.selectionStart ?? text.length);
    const end = replaceAll ? text.length : (field?.selectionEnd ?? text.length);
    const result = insertAt(text, value, start, end);
    caret.current = result.caret;
    setText(result.text);
  };

  const openPanel = (next: Panel, trigger: HTMLButtonElement) => {
    triggerRef.current = trigger;
    setNoTranslation(null);
    setPanel(panel === next ? null : next);
  };

  const addNote = () => {
    if (current.note.trim() === "") return;
    onOwnPost();
    dispatch({ type: "addNote", id: conversation.id });
    caret.current = 0;
  };

  const send = () => {
    onOwnPost();
    dispatch({ type: "sendDemo", id: conversation.id });
    setReviewing(false);
    caret.current = 0;
  };

  /** The one Send action: direct in Variant A or when nothing warrants a review; otherwise the short review. */
  const requestSend = () => {
    if (!canSend) return;
    setPanel(null);
    if (reasons.length === 0) send();
    else setReviewing(true);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (mode === "note") addNote();
      else requestSend();
    }
  };

  const translate = (to: Lang) => {
    const result = translateDraft(current.reply, to);
    if (result === null) {
      setNoTranslation(to);
      return;
    }
    write({ ...current, reply: result.text, original: current.original ?? current.reply, translated: { from: current.translated?.from ?? result.from, to } });
    setPanel(null);
    caret.current = result.text.length;
  };

  const restore = () => {
    if (current.original === null) return;
    caret.current = current.original.length;
    write({ ...current, reply: current.original, original: null, translated: null });
  };

  const head = (
    <div className={cx("composerHead")}>
      <div className={cx("composerTabs")} role="tablist" aria-label="Write">
        {(["reply", "note"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`${ids}-${value}`}
            aria-selected={mode === value}
            aria-controls={`${ids}-panel`}
            className={cx("composerTab", mode === value && "composerTabOn", value === "note" && "composerTabNote")}
            onClick={() => {
              setMode(value);
            }}
          >
            {value === "reply" ? "Reply" : (
              <>
                <Icon name="decision-draft" size={16} /> Internal note
              </>
            )}
            {value === "note" && current.note.trim() !== "" && mode !== "note" ? <span className={cx("tabDot")} aria-label="(has a draft)" /> : null}
            {value === "reply" && current.reply.trim() !== "" && mode !== "reply" ? <span className={cx("tabDot")} aria-label="(has a draft)" /> : null}
          </button>
        ))}
      </div>
      {mode === "reply" ? (
        <span className={cx("windowLine", !replyAvailable && "windowLineClosed")}>
          {disconnected ? "Needs reconnecting" : win.open ? (
            <>
              <span className={cx("windowLabel")}>Reply window · </span>
              <span className={cx("long")}>{`${duration(win.at - NOW)} left`}</span>
              <span className={cx("short")}>{`${String(Math.floor((win.at - NOW) / 3_600_000))} h left`}</span>
            </>
          ) : (
            "Reply window closed"
          )}
          <Info label="About the reply window" align="end">
            {PLATFORM_NAMES[account.platform]} lets a business reply within 24 hours of the person’s last message (Meta policy). How this applies per account and API setup is still being validated — this prototype only illustrates it.
          </Info>
        </span>
      ) : (
        <span className={cx("noteLine")}>
          <Icon name="estado-lock" size={16} />
          Only your team can see this
        </span>
      )}
    </div>
  );

  // Reply unavailable: the window closed or the account needs reconnecting. Notes stay available.
  if (mode === "reply" && !replyAvailable) {
    return (
      <section className={cx("composer")} aria-label="Reply">
        {head}
        <div id={`${ids}-panel`} role="tabpanel" aria-labelledby={`${ids}-reply`} className={cx("unavailable")}>
          <p className={cx("unavailableTitle")}>{disconnected ? "Replying isn’t available until this account is reconnected." : "Replying isn’t available: the 24-hour reply window closed."}</p>
          <p className={cx("unavailableText")}>
            {disconnected
              ? "Messages from this account may be missing. An admin can reconnect it in Settings › Connections."
              : `It closed ${duration(NOW - win.at)} ago (${fullOf(win.at)}). Meta’s 7-day Human Agent extension needs Meta’s review and isn’t enabled.`}
          </p>
          <div className={cx("rowGap")}>
            <Button
              variant="secondary"
              size="sm"
              icon="decision-draft"
              onClick={() => {
                writeIn("note");
              }}
            >
              Add an internal note
            </Button>
            <span className={cx("muted")}>To reach {conversation.participant.name}, use {PLATFORM_NAMES[account.platform]}’s own inbox.</span>
          </div>
        </div>
      </section>
    );
  }

  if (reviewing && mode === "reply") {
    return (
      <section className={cx("composer")} aria-label="Review before sending">
        {head}
        <div id={`${ids}-panel`} role="tabpanel" aria-labelledby={`${ids}-reply`} className={cx("review")}>
          <h3 ref={reviewTitle} className={cx("reviewTitle")} tabIndex={-1}>
            Check before sending
          </h3>
          <ul className={cx("reviewReasons")}>
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p className={cx("reviewText")}>{current.reply.trim()}</p>
          <p className={cx("muted")}>
            To {conversation.participant.name} on {PLATFORM_NAMES[account.platform]} · from {accountTarget(account)}
          </p>
          <div className={cx("rowGap")}>
            <Button variant="primary" onClick={send}>
              Send (demo)
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setReviewing(false);
                caret.current = current.reply.length;
              }}
            >
              Back to editing
            </Button>
            <Marker kind="demo">Demo — nothing is sent</Marker>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={cx("composer", mode === "note" && "composerNote")} aria-label={mode === "reply" ? "Reply" : "Internal note"}>
      {head}
      {replying !== null && mode === "reply" ? (
        <div className={cx("collision")} role="status">
          <span className={cx("presenceDot")} aria-hidden="true" />
          <span className={cx("collisionText")}>
            <strong>{firstName(replying.name)}</strong> <span className={cx("long")}>is also replying.</span>
            <span className={cx("short")}>is replying</span>
          </span>
          <span className={cx("collisionActions")}>
            <button
              type="button"
              className={cx("linkButton")}
              onClick={() => {
                writeIn("note");
              }}
            >
              Leave a note
            </button>
            <button
              type="button"
              className={cx("linkButton")}
              onClick={() => {
                setConfirmTakeOver(true);
              }}
            >
              Take over…
            </button>
          </span>
        </div>
      ) : null}
      {current.translated !== null && mode === "reply" ? (
        <div className={cx("translated")} role="status">
          <span>
            Draft translated {LANG_NAMES[current.translated.from]} → {LANG_NAMES[current.translated.to]} · <em className={cx("fixture")}>illustrative fixture</em>
          </span>
          <button type="button" className={cx("linkButton")} onClick={restore}>
            Restore original
          </button>
        </div>
      ) : null}
      <div id={`${ids}-panel`} role="tabpanel" aria-labelledby={`${ids}-${mode}`} className={cx("editor")}>
        <label htmlFor={`${ids}-text`} className="wk-sr-only">
          {mode === "reply" ? `Reply to ${conversation.participant.name}` : "Internal note — only your team can see this"}
        </label>
        <textarea
          id={`${ids}-text`}
          ref={textarea}
          className={cx("textarea", "composerField")}
          rows={2}
          value={text}
          placeholder={mode === "reply" ? `Reply to ${firstName(conversation.participant.name)}… · / for saved replies` : "Note for your team…"}
          aria-describedby={`${ids}-hint`}
          aria-invalid={over}
          onKeyDown={onKeyDown}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            if (mode === "reply" && /^\/\S*$/.test(next)) {
              triggerRef.current = null;
              setQuery(next.slice(1));
              setPanel("saved");
            } else if (panel === "saved" && mode === "reply" && !next.startsWith("/")) setPanel(null);
          }}
        />
        <div className={cx("toolbarRow")}>
          <div className={cx("toolbar")} role="toolbar" aria-label="Tools">
            <button
              type="button"
              className={cx("tool", panel === "emoji" && "toolOn")}
              aria-label="Emoji"
              aria-expanded={panel === "emoji"}
              aria-controls={`${ids}-emoji`}
              onClick={(event) => {
                openPanel("emoji", event.currentTarget);
              }}
            >
              <span aria-hidden="true" className={cx("emojiGlyph")}>☺</span>
            </button>
            {mode === "reply" ? (
              <>
                <button
                  type="button"
                  className={cx("tool", "toolText", panel === "saved" && "toolOn")}
                  aria-expanded={panel === "saved"}
                  aria-controls={`${ids}-saved`}
                  onClick={(event) => {
                    setQuery("");
                    openPanel("saved", event.currentTarget);
                  }}
                >
                  <span className={cx("long")}>Saved replies</span>
                  <span className={cx("short")}>Saved</span>
                </button>
                <button
                  type="button"
                  className={cx("tool", "toolText", panel === "translate" && "toolOn")}
                  aria-expanded={panel === "translate"}
                  aria-controls={`${ids}-translate`}
                  onClick={(event) => {
                    openPanel("translate", event.currentTarget);
                  }}
                >
                  Translate
                </button>
                <button type="button" className={cx("tool", "toolText", "toolLater")} aria-disabled="true" title="Attachments are a design candidate — not available in this prototype">
                  Attach <span className="wk-sr-only">(not available in this prototype)</span>
                </button>
                {showFuture && conversation.future?.suggestion !== undefined ? (
                  <button
                    type="button"
                    className={cx("tool", "toolText")}
                    onClick={() => {
                      insert(conversation.future?.suggestion ?? "", current.reply.trim() === "");
                    }}
                  >
                    Suggest <Marker kind="future">Future</Marker>
                  </button>
                ) : null}
              </>
            ) : (
              <span className={cx("hint", "toolHint")}>@mentions · later</span>
            )}
          </div>
          <div className={cx("composerEnd")}>
            {mode === "reply" && account.platform === "instagram" && bytes > IG_LIMIT - 200 ? (
              <span className={cx("counter", over && "counterOver")}>
                {String(bytes)} / {String(IG_LIMIT)} bytes
              </span>
            ) : null}
            {mode === "reply" ? (
              <Button variant="primary" size="sm" disabled={!canSend} onClick={requestSend}>
                {reasons.length === 0 ? (
                  "Send (demo)"
                ) : (
                  <>
                    <span className={cx("long")}>Review &amp; send (demo)</span>
                    <span className={cx("short")}>Review (demo)</span>
                  </>
                )}
              </Button>
            ) : (
              <Button variant="primary" size="sm" icon="decision-draft" disabled={current.note.trim() === ""} onClick={addNote}>
                Add note
              </Button>
            )}
          </div>
        </div>
        {over ? (
          <p className={cx("notice")} role="status">
            Too long for Instagram: shorten the reply (Meta documents a 1,000-byte limit).
          </p>
        ) : null}
        <p id={`${ids}-hint`} className={cx("hint", "composerHint")}>
          {mode === "reply" ? "⌘/Ctrl + Enter to send · Demo only: nothing reaches Instagram or Messenger · Drafts stay while this tab is open." : "⌘/Ctrl + Enter to add · Notes are never sent to the person."}
        </p>
        {panel === "emoji" ? (
          <div ref={panelRef} id={`${ids}-emoji`} className={cx("popover", "emojiPopover")}>
            <SheetHead title="Emoji" onClose={dismissPanel} />
            <EmojiPicker
              onPick={(emoji) => {
                insert(emoji.char);
                setPanel(null);
              }}
            />
          </div>
        ) : null}
        {panel === "saved" && mode === "reply" ? (
          <div ref={panelRef} id={`${ids}-saved`} className={cx("popover", "savedPopover")}>
            <SheetHead title="Saved replies" onClose={dismissPanel} />
            <SavedReplies
              replies={savedReplies}
              conversation={conversation}
              query={query}
              onQuery={setQuery}
              onInsert={(text) => {
                insert(text, current.reply.trim() === "" || current.reply.startsWith("/"));
                setPanel(null);
              }}
              onAdd={(reply) => {
                dispatch({ type: "addSavedReply", reply });
              }}
            />
          </div>
        ) : null}
        {panel === "translate" && mode === "reply" ? (
          <div ref={panelRef} id={`${ids}-translate`} className={cx("popover", "translatePopover")}>
            <SheetHead title="Translate draft" onClose={dismissPanel} />
            <TranslatePanel draft={current} conversation={conversation} missing={noTranslation} onTranslate={translate} />
          </div>
        ) : null}
      </div>
      <Dialog
        open={confirmTakeOver}
        title="Take over in Wrenkind?"
        onClose={() => {
          setConfirmTakeOver(false);
        }}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmTakeOver(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                dispatch({ type: "assign", id: conversation.id, to: ME, takeOver: conversation.presence?.who ?? "" });
                setConfirmTakeOver(false);
                caret.current = current.reply.length;
              }}
            >
              Take over in Wrenkind
            </Button>
          </>
        }
      >
        <p>
          You become the <strong>internal assignee</strong> of this conversation in Wrenkind.
        </p>
        <ul className={cx("dialogList")}>
          <li>{replying === null ? "Your teammate’s" : `${firstName(replying.name)}’s`} unsent draft isn’t transferred to you — it stays with them.</li>
          <li>Meta’s Conversation Routing doesn’t change: this doesn’t give Wrenkind control of who can reply on {PLATFORM_NAMES[account.platform]}.</li>
          <li>No platform action happens and nothing is sent to {conversation.participant.name}. The change is recorded in this conversation’s history.</li>
        </ul>
        <p className={cx("muted")}>{replying === null ? "Your teammate" : firstName(replying.name)} isn’t notified — this prototype has no notifications.</p>
      </Dialog>
    </section>
  );
}

function TranslatePanel({ draft, conversation, missing, onTranslate }: { readonly draft: Draft; readonly conversation: Conversation; readonly missing: Lang | null; readonly onTranslate: (to: Lang) => void }) {
  const from = draft.translated?.to ?? detectFixtureLang(draft.reply);
  return (
    <div className={cx("translatePanel")}>
      <p className={cx("muted")}>
        From: <strong>{from === null ? "unknown (no fixture for this text)" : LANG_NAMES[from]}</strong> · {conversation.participant.name} writes in {LANG_NAMES[conversation.lang]}
      </p>
      <div className={cx("rowGap")} role="group" aria-label="Translate to">
        {LANGS.filter((lang) => lang !== from).map((lang) => (
          <Button
            key={lang}
            size="sm"
            variant={lang === conversation.lang ? "primary" : "secondary"}
            disabled={draft.reply.trim() === ""}
            onClick={() => {
              onTranslate(lang);
            }}
          >
            {`To ${LANG_NAMES[lang]}`}
          </Button>
        ))}
      </div>
      {missing === null ? null : (
        <p className={cx("notice")} role="status">
          This prototype has no translation of this text into {LANG_NAMES[missing]}. Try a saved reply, or the sample drafts in Nina Lab (Spanish → Portuguese) and Hotel Andes.
        </p>
      )}
      <p className={cx("hint")}>Illustrative fixtures written for this prototype — no translation service or AI is called, and nothing here is verified. Translating private messages needs its own legal and product gate.</p>
    </div>
  );
}

function EmojiPicker({ onPick }: { readonly onPick: (emoji: Emoji) => void }) {
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState<Emoji["group"]>("Smileys");
  const [active, setActive] = useState(0);
  const grid = useRef<HTMLDivElement>(null);
  const ids = useId();
  const term = search.trim().toLowerCase();
  const shown = term === "" ? EMOJI.filter((e) => e.group === group) : EMOJI.filter((e) => e.name.includes(term));
  const columns = 8;
  const move = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const delta: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns };
    const step = delta[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = Math.min(shown.length - 1, Math.max(0, active + step));
    setActive(next);
    grid.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  };
  return (
    <div className={cx("emoji")}>
      <label htmlFor={`${ids}-search`} className="wk-sr-only">
        Search emoji
      </label>
      <input
        id={`${ids}-search`}
        className={cx("input")}
        type="search"
        placeholder="Search emoji (e.g. coffee, heart)"
        value={search}
        autoFocus
        onChange={(event) => {
          setSearch(event.target.value);
          setActive(0);
        }}
      />
      {term === "" ? (
        <div className={cx("emojiGroups")} role="tablist" aria-label="Emoji categories">
          {EMOJI_GROUPS.map((g) => (
            <button
              key={g}
              type="button"
              role="tab"
              aria-selected={g === group}
              className={cx("chip", g === group && "chipOn")}
              onClick={() => {
                setGroup(g);
                setActive(0);
              }}
            >
              {g}
            </button>
          ))}
        </div>
      ) : null}
      <div ref={grid} className={cx("emojiGrid")} role="group" aria-label={term === "" ? group : "Search results"} onKeyDown={move}>
        {shown.map((emoji, index) => (
          <button
            key={emoji.char}
            type="button"
            className={cx("emojiButton")}
            tabIndex={index === active ? 0 : -1}
            aria-label={emoji.name}
            title={emoji.name}
            onClick={() => {
              onPick(emoji);
            }}
          >
            {emoji.char}
          </button>
        ))}
      </div>
      {shown.length === 0 ? <p className={cx("muted")}>No emoji match “{search}”.</p> : <p className={cx("hint")}>Arrow keys move · Enter inserts at the cursor · Esc closes</p>}
    </div>
  );
}

const CATEGORIES = ["All", "Shipping", "Orders", "Wholesale", "Products", "Store info", "Apologies"] as const;

function SavedReplies({ replies, conversation, query, onQuery, onInsert, onAdd }: {
  readonly replies: readonly SavedReply[];
  readonly conversation: Conversation;
  readonly query: string;
  readonly onQuery: (q: string) => void;
  readonly onInsert: (text: string) => void;
  readonly onAdd: (reply: SavedReply) => void;
}) {
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("All");
  const [selected, setSelected] = useState<string | null>(null);
  const [variant, setVariant] = useState<Lang | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: "", text: "", lang: conversation.lang, category: "Orders" });
  const ids = useId();
  const term = query.trim().toLowerCase();
  // Then: replies with a variant in the person's language, then replies made for this account.
  const hasLang = (r: SavedReply): number => Number(r.variants.some((v) => v.lang === conversation.lang));
  const usable = replies.filter((r) => r.account === null || r.account === conversation.accountId);
  // Ranking: shortcut, then name, then any variant's text — so "/ship" lands on "Shipping times".
  const rank = (r: SavedReply): number =>
    term === "" ? 0 : r.shortcut.slice(1).toLowerCase().startsWith(term) ? 0 : r.title.toLowerCase().includes(term) ? 1 : r.variants.some((v) => v.text.toLowerCase().includes(term)) ? 2 : 3;
  const shown = usable.filter((r) => (category === "All" || r.category === category) && rank(r) < 3).toSorted((a, b) => rank(a) - rank(b) || hasLang(b) - hasLang(a) || Number(b.account !== null) - Number(a.account !== null));
  const preview = shown.find((r) => r.id === selected) ?? shown[0];
  const lang = preview === undefined ? conversation.lang : (preview.variants.find((v) => v.lang === (variant ?? conversation.lang)) ?? preview.variants[0])?.lang ?? "en";
  const text = preview?.variants.find((v) => v.lang === lang)?.text ?? "";
  const step = (delta: number) => {
    const at = preview === undefined ? -1 : shown.indexOf(preview);
    const next = shown[Math.min(shown.length - 1, Math.max(0, at + delta))];
    if (next !== undefined) {
      setSelected(next.id);
      setVariant(null);
    }
  };
  if (adding) {
    return (
      <form
        className={cx("savedForm")}
        onSubmit={(event) => {
          event.preventDefault();
          if (form.title.trim() === "" || form.text.trim() === "") return;
          onAdd({ id: `local-${String(replies.length + 1)}`, title: form.title.trim(), category: form.category, account: null, shortcut: "", variants: [{ lang: form.lang, text: form.text.trim() }], local: true });
          setAdding(false);
        }}
      >
        <label className={cx("fieldLabel")} htmlFor={`${ids}-title`}>
          Name
        </label>
        <input
          id={`${ids}-title`}
          className={cx("input")}
          value={form.title}
          onChange={(event) => {
            setForm({ ...form, title: event.target.value });
          }}
        />
        <label className={cx("fieldLabel")} htmlFor={`${ids}-text`}>
          Text
        </label>
        <textarea
          id={`${ids}-text`}
          className={cx("textarea")}
          rows={3}
          value={form.text}
          onChange={(event) => {
            setForm({ ...form, text: event.target.value });
          }}
        />
        <div className={cx("rowGap")}>
          <label className={cx("fieldLabel")}>
            Language
            <select
              className={cx("select")}
              value={form.lang}
              onChange={(event) => {
                setForm({ ...form, lang: event.target.value as Lang });
              }}
            >
              {LANGS.map((l) => (
                <option key={l} value={l}>
                  {LANG_NAMES[l]}
                </option>
              ))}
            </select>
          </label>
          <label className={cx("fieldLabel")}>
            Category
            <select
              className={cx("select")}
              value={form.category}
              onChange={(event) => {
                setForm({ ...form, category: event.target.value });
              }}
            >
              {CATEGORIES.filter((c) => c !== "All").map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
        </div>
        <p className={cx("hint")}>Kept in this tab’s memory only — nothing is saved.</p>
        <div className={cx("rowGap")}>
          <Button type="submit" variant="primary" size="sm">
            Save for this session
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setAdding(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div className={cx("saved")}>
      <div className={cx("savedHead")}>
        <label htmlFor={`${ids}-q`} className="wk-sr-only">
          Search saved replies
        </label>
        <input
          id={`${ids}-q`}
          className={cx("input")}
          type="search"
          placeholder="Search by name, text or /shortcut"
          value={query}
          autoFocus
          aria-describedby={`${ids}-keys`}
          onChange={(event) => {
            onQuery(event.target.value.replace(/^\//, ""));
            setSelected(null);
            setVariant(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              step(event.key === "ArrowDown" ? 1 : -1);
            }
            if (event.key === "Enter" && text !== "") {
              event.preventDefault();
              onInsert(text);
            }
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          icon="util-plus"
          onClick={() => {
            setAdding(true);
          }}
        >
          New
        </Button>
      </div>
      <div className={cx("chips", "chipsScroll")} role="group" aria-label="Categories">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={c === category}
            className={cx("chip", c === category && "chipOn")}
            onClick={() => {
              setCategory(c);
              setSelected(null);
            }}
          >
            {c}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <div className={cx("savedEmpty")} role="status">
          <p>
            No saved reply matches {term === "" ? `in ${category}` : `“${query}”`}.
          </p>
          <div className={cx("rowGap")}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                onQuery("");
                setCategory("All");
              }}
            >
              Show all saved replies
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setForm({ ...form, title: query });
                setAdding(true);
              }}
            >
              Create one for this session
            </Button>
          </div>
        </div>
      ) : (
        <div className={cx("savedBody")}>
          <ul className={cx("savedList")} aria-label="Saved replies">
            {shown.map((reply) => (
              <li key={reply.id}>
                <button
                  type="button"
                  className={cx("savedItem", reply.id === preview?.id && "savedItemOn")}
                  aria-current={reply.id === preview?.id}
                  onFocus={() => {
                    setSelected(reply.id);
                    setVariant(null);
                  }}
                  onClick={() => {
                    setSelected(reply.id);
                    setVariant(null);
                  }}
                  onDoubleClick={() => {
                    onInsert(reply.variants.find((v) => v.lang === conversation.lang)?.text ?? reply.variants[0]?.text ?? "");
                  }}
                >
                  <span className={cx("savedTitle")}>{reply.title}</span>
                  <span className={cx("savedMeta")}>
                    {reply.shortcut === "" ? null : <span className={cx("mono")}>{reply.shortcut}</span>}
                    <span>{reply.variants.map((v) => v.lang.toUpperCase()).join(" · ")}</span>
                    {reply.account === null ? null : <span>{accountTarget(accountOf(reply.account))} only</span>}
                    {reply.local === true ? <span>This session</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {preview === undefined ? null : (
            <div className={cx("savedPreview")}>
              <div className={cx("variantTabs")} role="radiogroup" aria-label="Language">
                {preview.variants.map((v) => (
                  <button
                    key={v.lang}
                    type="button"
                    role="radio"
                    aria-checked={v.lang === lang}
                    className={cx("variant", v.lang === lang && "variantOn")}
                    onClick={() => {
                      setVariant(v.lang);
                    }}
                  >
                    {LANG_NAMES[v.lang]}
                    {v.lang === conversation.lang ? <span className="wk-sr-only"> (the person’s language)</span> : null}
                  </button>
                ))}
              </div>
              <p className={cx("savedText")} lang={lang}>
                {text}
              </p>
              <p className={cx("savedPreviewMeta")}>
                {preview.category} · {preview.account === null ? "All accounts" : `${accountTarget(accountOf(preview.account))} only`}
              </p>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  onInsert(text);
                }}
              >
                {`Insert ${LANG_NAMES[lang]}`}
              </Button>
            </div>
          )}
        </div>
      )}
      <p id={`${ids}-keys`} className={cx("hint")}>
        Type / in the reply to search · ↑ ↓ choose · Enter inserts · Copy to another account <Marker kind="later">Later</Marker>
      </p>
    </div>
  );
}
