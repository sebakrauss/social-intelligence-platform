# MESSAGES-UX-01 — Wrenkind Messages, synthetic interactive prototype

**Status:** design prototype for product-owner review (gate MESSAGES-UX-01, PD v1.4 §21.5, UX v1.3 §30.4).
**Not product code.** Synthetic data only. Nothing is read from or sent to Meta, stored, or seen by anyone else.
No AI model, translation service or provider is called. "Send (demo)" only adds a local message marked DEMO ONLY.

## Run it

From the repository root (uses the Vite already in `node_modules`; nothing to install):

```sh
npx vite --config design/messages/ux-01/vite.config.mjs
```

Open <http://localhost:3101/messages>. The server uses port 3101 only (never the app's 3000) and keeps Vite's cache in
the system temp directory. Stop it with Ctrl-C.

## What it reuses (read-only)

- Wrenkind foundations: `ui/foundations/{reset,tokens,base,motion}.css` and the brand font files.
- Primitives: `Button`, `StatePill`, `OriginMark` (IG/FB monogram), `Icon` (brand kit), `Logo` (wordmark).
- Direction C structure and breakpoints from the approved Comments UI: rail 56 px + sidebar 220 px, list 380 px beside
  the conversation at ≥1024 px, rail + top strip with a view picker at 768–1023 px, one panel with a bottom bar < 768 px.
- The Comments prototype's PROTOTYPE banner convention and the sidebar view pattern (Open · Needs attention (future) ·
  Done · All conversations set apart).

Nothing under `app/`, `ui/`, `server/` or any other production directory is modified.

## Files

| File | Purpose |
|---|---|
| `index.html`, `vite.config.mjs` | Isolated preview (port 3101, `@` → repository root, SPA fallback) |
| `src/main.tsx`, `src/fonts.css` | Entry; loads Wrenkind foundations and fonts |
| `src/model.ts` | Types, reducer (in-memory state, system events, per-teammate unread), review reasons (Variant B), routing (History API), fixed clock, formatting |
| `src/data.ts` | Fictional accounts, teammates, conversations, saved-reply families with variants, illustrative translation fixtures, sample drafts, emoji |
| `src/app.tsx` | Shell, DEMO bar + Prototype controls panel, sidebar views, top strip, bottom bar, list with search and filters, scenarios, toasts |
| `src/thread.tsx` | Conversation header (who → handling → context), assignment, escalation, More menu, routing explainer, future insight, timeline with events and notes |
| `src/composer.tsx` | Reply / Internal note (separate drafts), Send (demo) with Variant A/B review, take over, emoji, Saved Replies, translate |
| `src/ui.tsx`, `src/messages.module.css` | Shared pieces (menus, dialogs, dismiss/focus helpers) and styles (semantic tokens only) |
| `verify/verify.mjs` | Reproducible browser verification (remediation findings + regression of approved behavior) |

## Iteration 02 (product review)

- **Header hierarchy:** who (participant, channel → receiving account, Open/Done) → handling (assignee, escalation,
  Mark done) → context on demand (quiet position and arrows, ⓘ details, More menu with Escalate, Mark unread for you,
  “Who can reply on the platform?”, Labels later).
- **Sending experiences** (switch in *Prototype controls*): **A · fast** — human presses Send (demo); **B · contextual
  review** (default) — direct send, plus a short review only when the draft was translated, a teammate is also
  replying, the conversation is escalated, or a synthetic high-risk marker applies. Never inferred from a provider
  capability; never autonomous; never closes the conversation.
- **Internal notes:** prototype-local honey palette (light and dark), lock icon, “Only your team can see this”, “Add
  note”; separate Reply and Note drafts per conversation; published notes use the same language in the timeline.
- **Ownership:** assignment (Wrenkind), presence (viewing), collision (also replying) and Meta Conversation Routing
  are separate; “Take over in Wrenkind” is confirmed and internal only.
- **List:** three lines, one status at most, per-teammate internal unread (never a platform read receipt).
- **Saved Replies:** families with language variants (direction only; OQ-23 open), shortcut-first ranking, person’s
  language first, ↑↓/Enter, clear empty state, session-only creation.
- **Translation fixtures:** incoming ES→EN (Hotel Andes), incoming PT→ES/EN and outgoing draft ES→PT (Nina Lab),
  restore, explicit “no fixture” state. Illustrative only.
- **Thread:** Wrenkind system events, opens at latest activity, follows new items only at the bottom.
- **Mobile:** conversation takes the full screen (strip and bottom bar hidden), compact composer, bottom sheets with
  a title bar and safe-area padding.
- **Prototype controls** (side panel) hold scenario, sending variant, theme, future-intelligence preview, legend and
  reviewer notes; a one-line DEMO bar stays visible.

## Final remediation (independent audit, 8 × P2)

- **Scroll architecture:** the list and the conversation sit in one bounded grid row (`overflow: clip`); in a
  conversation only the timeline scrolls, at every width. Header and composer never move; the page itself never
  scrolls in a conversation. Opens at the latest message.
- **Phones:** a compact header (← back to the view · name · Open/Done · where; assignee · Mark done · More) stays on
  screen; the list's scroll position and focus come back on Back.
- **Composer at 1024 px:** `minmax(0, 1fr)` columns, and the list narrows (min 300 px) at 1024–1279 px.
- **Menus:** bottom sheets with a scrim below 768 px; focus moves into the menu, ↑ ↓ Home End, Tab/Escape close.
- **Mark as unread for you:** returns to the list; unread stays until you open it again (only for you; no receipt).
- **List row:** “X is replying” and “Escalated” are shown together.
- **Take over:** accurate copy (internal assignee, draft not transferred, Conversation Routing unchanged, no platform
  action, teammate not notified); the event is recorded.
- **Focus:** review heading, reply/note field, Previous/Next kept, sheet ✕ and Escape back to the trigger, dialogs
  never leave focus on `<body>`. P3: Mark done returns to the list (Undo kept); filters vs. views; 44 px targets;
  short phones; `<main>`; placeholder contrast.

## Verify

With the preview running, from the repository root (nothing is installed; playwright-core must already exist
somewhere on the machine):

```sh
PLAYWRIGHT_CORE_FROM=/dir/with/node_modules CHROME_PATH=/path/to/chrome \
  node design/messages/ux-01/verify/verify.mjs all --verbose [--shots=DIR --label=after]
```

Checks are named by finding (P2-1…P2-8, P3-A…P3-E) and R for regressions (views, unread, assign, escalate, take
over, reply vs note, Saved Replies, translations, Variant A/B, demo send, Back/Forward, mobile, overflow, console).
Exit code 0 = all passed.

## Interactive vs. illustrative

- **Interactive (local state):** views, search and filters, selection, browser Back/Forward, previous/next, assignment,
  Mark done / Reopen with Undo, escalation, internal notes, drafts per conversation (kept while the tab is open),
  emoji, Saved Replies (search, categories, `/shortcut`, ↑↓ + Enter, new reply for the session), predefined
  translations (incoming messages and known drafts, with restore), Send (demo) with Variant A/B, take over in
  Wrenkind, mark unread for you, scenarios (normal, Messenger needs reconnecting, loading, empty), theme.
- **Provider-dependent (shown, not verified):** reply windows, message requests, receipts (Messenger delivered/seen;
  Instagram seen), reactions, edits, unsends, attachment links, history depth. Validation is MESSAGES-EXP-01.
- **Future (labeled, never active):** Needs attention, intent, urgency, summaries, suggestions (hand-written
  illustrations), operational labels, attachments, copying saved replies between accounts.
