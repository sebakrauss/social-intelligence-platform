# Inbox 2.0 — product & frontend architecture blueprint (Step 7B-15A)

**Status: DESIGN ONLY. Not an authorization, not an approved-document change.** Written against commit `ff5269c`
(deployed: web `dpl_xHHMMYih` gru1, Trigger `20261113.1` 10/1/11, DEV ledger 31/31). Nothing here enables a capability,
changes a switch, or amends PD / IA / UX / Model / TA. Every "missing" item below needs its own authorized gate.

> **Status update — Step 7B-15V (2026-11-15).** The product owner adopted Direction A · Focus and the Phase 1 draft
> contract (§17) as **UX-19** and **UX-20** in `docs/core-ux-flows-v1.md` §8.10 (v1.2, wording pending formal approval).
> §1 below is the 7B-15A snapshot (two-pane Inbox) and is kept as history. **D1 is unchanged: no DM surface exists**;
> any DM work still needs a formal PD scope amendment first. Ordinary `reply_public` stays default-deny until the
> backend `REPLY_IN_FLIGHT` admission gate (§17, "Known gap").

Baseline evidence: the first real Instagram public reply (2026-11-13, intent `6d283cc6…` CONFIRMED, provider reply
`18459869950193217`, one POST, verified by GET) went through the exceptional validation path. `mutation.provider_action`
is still 18/18 DENY and `reply_public` is still `UNKNOWN_NOT_VALIDATED` in catalog r5. **The ordinary composer has never
been shown to a real user**, and that comment is spent for validation forever.

---

## 0. Governance findings (read first)

| # | Requested (7B-15A) | Approved sources | Finding | Consequence for this blueprint |
|---|---|---|---|---|
| **D1** | §2-B: a DM inbox (conversation list + chronological history + reply field). §2-C.3: "message inside an existing DM conversation". | PD §10 ("A DM inbox, DM threads or DM follow-up workflows… [out of MVP]"), D-07, C-03/D-36; Model §36 + **S9** ("No full DM Inbox. No incoming DM object"); IA §8.3 ("There is no private thread view, no DM list, no DM status"), IA anti-pattern 13; UX F-09 §12 ("no incoming DM, no DM list, no DM status"); CLAUDE.md §7 + TA §69 ("a DM model 'for later'"). | **Direct contradiction** with CONFIRMED decisions. CLAUDE.md §2: contradiction → STOP and report; never reconcile implicitly. | DM sections (§4-G, §4-H, §5.2) are written as **input to a product-owner amendment phase**, clearly marked **BLOCKED**. No DM phase is scheduled, no DM data contract is proposed as approved, and nothing DM-related may be implemented, including "visual only" shells. |
| **D2** | §2-A: show "classification, sentiment and AI priority" on the comment (list surface). | IA §7.5-A: "Not in the list: sentiment, confidence, full label set…"; sentiment is progressive disclosure (§7.5-C). S1: sentiment never feeds automation/moderation. | Partial conflict, for **sentiment in the list** only. Primary label, "Why it's here" and response need ARE list content in IA. | The list shows one primary label plus the short "Why it's here". Sentiment and confidence appear only in the expanded/drawer "All understanding" disclosure. Changing this needs an IA amendment. |
| **D3** | §2-A: no permanent third column; inline expandable composer; temporary side panel. | IA §8: the detail order is "importance (not layout)"; IA §7.5-B "on selection". UX §9 two-pane wording is presentational. | **Compatible.** The layout is a presentation choice; information order (IA §8 table) and content are preserved. | Proceed. |
| **D4** | §2-C.2: private reply from a comment. | PD D-36/C-03 (MVP, one-shot, human-triggered, recorded as a history marker, availability VALIDATE); IA §8.3; UX F-09; Model §36. | **Compatible**, as a one-shot action only. | Designed in §4-I. Its contract is a backend gate (Phase 5); capability stays UNKNOWN until validated. |

**The product owner must resolve D1 (and optionally D2) through a formal amendment phase** before any DM design is
treated as a requirement. Until then, the authoritative DM behavior is: *no DM surface exists.*

---

## 1. Diagnosis of the current Inbox

### 1.1 What a user sees today

- **`/workspaces/[ws]/inbox`**: a list of conversations (IA-01: one per top-level comment), newest activity first,
  keyset pagination (25 per page, a server-issued cursor). A coverage disclosure ("what has been read"). From 1280 px,
  an empty detail pane sits beside the list.
- **`/workspaces/[ws]/inbox/[conversationId]`**: the same list plus the conversation detail pane. Below 1280 px only
  the detail is shown, with a back link that keeps the list position.
- **Detail**:
  - a context line: platform mark, content kind, Organic/Paid/Mixed/Unknown, workflow state;
  - a permanent "understanding pending" notice;
  - the thread: comments and replies with author, time, presence state, "text read at", earlier text versions in a
    disclosure, and persisted deterministic facts;
  - a single "reply unavailable — reason" line;
  - a per-member contextual composer (write → review → publish) when available;
  - outbound replies with their real state.
- **No** filters, views, priority, labels, AI understanding, moderation actions, workflow actions (assign, done,
  escalate, note), author context, activity history, content preview, or auto-refresh.

### 1.2 Feature classification

| Feature | Status | Evidence |
|---|---|---|
| Conversation list (read), keyset pagination, coverage disclosure | **Implemented and validated** (real FB/IG data on DEV; user Inbox smoke 2026-11-11) | `server/queries/inbox.ts`, `views.tsx` |
| Conversation detail: thread, versions, presence, facts | **Implemented and validated** (read side) | `ConversationView`, `Member` |
| Navigation latency/regional alignment (gru1) | **Implemented and validated** (7B-8E) | memory 7B-8E |
| Public reply via the **validation exception** (validation composer, server-resolved authorization) | **Implemented and validated** (1 real POST, CONFIRMED, GET-verified) | 14P2G2 |
| Public reply via the **ordinary** composer (`reply.kind = "available"`) | **Implemented, never validated for real** (provider_action DENY, catalog UNKNOWN) | `ordinaryReplyModel` |
| Outbound states: Sending, Sent | **Sending and Sent validated live** (the UI showed "Sending" until reload) | 14P2G2 |
| Outbound states: Failed, Checking (OUTCOME_UNKNOWN), Blocked | **Implemented, never validated for real** (simulator and tests only) | `OUTBOUND_STATE_OF` |
| Refusal and blocked messages of the reply action | Implemented, unit-tested | `REPLY_REFUSAL_MESSAGES`, `reply-state.ts` |
| Workflow state | **Partial**: read-only OPEN/DONE pill, no command | `conversations.workflow_state` |
| Deterministic signals ("facts") | **Partial**: 5 fact kinds, 1 observed live (`link_present`) | `FACT_MESSAGES` |
| AI understanding (assessments: safety, authenticity, intent, sentiment, risk, response_need, language) | **Partial**: persisted (`classification.assessments`, 1 interaction on DEV), AI kill ACTIVE (`ai.task_kill` classification_understanding), **not read by the Inbox** | 0024; DEV read-only count |
| Priority / "Why it's here" / primary label | **Not implemented** | — |
| Filters, views, grouping, saved views | **Not implemented** | — |
| Moderation (hide/unhide/delete/block) | **Not implemented end to end**: in the provider contract and simulator only; no Meta adapter, request service or UI | `contract/mutation-port.ts` |
| Private reply from a comment | **Not implemented**: contract `replyPrivately`, capability key `reply_private` (simulator SUPPORTED, Meta UNKNOWN); no Meta adapter, request, intent kind or UI | `contract/mutation-port.ts`, capability `vocabulary.ts` |
| Content preview (caption, media, permalink, account display name) | **Not implemented**: `content.content_items` stores ids, kind, source and state only; no caption, permalink or media | 0017 |
| Author context, activity history UI, assign/notes/escalate, saved replies, suggestions | **Not implemented** | — |
| Realtime / auto-refresh of outbound state | **Not implemented** (TA-Q-21 VALIDATE) | — |
| DM anything | **Out of MVP** (D1) | PD §10 |
| Locales | **EN only** (`platform/i18n/catalogs/development-reference.ts`); the i18n infrastructure supports locale tags | `platform/i18n` |

---

## 2. Component inventory

| Layer | Component | Kind | Reuse in 2.0 |
|---|---|---|---|
| `ui/inbox/inbox.tsx` | `InboxPanes` | server, layout (two panes, `data-selected`) | **Replace** with `InboxWorkspace` (wide list plus optional drawer). Keep for one release behind the same routes only if needed for rollback. |
| | `InboxHeader`, `InboxEmpty`, `PaneMessage`, `Pagination`, `NoticeSlot` | server | Keep |
| | `ConversationList`, `ConversationRow` | server; the row is one `<a>` | **Extend**: the row becomes a summary plus an optional expanded region (`aria-expanded`), still link-based |
| | `ConversationDetail`, `SectionLabel`, `Thread`, `ThreadMember`, `VersionList`, `Version`, `Facts` | server | Keep; render inside the expanded row (thread) and the drawer (full history) |
| | `OutboundReply`, `ReplyUnavailable` | server | Keep; add a "View on platform" slot later (needs a permalink) |
| | `CoverageBlock` / `CoverageSummaryLabel` / `CoverageAccounts` / `CoverageAccount` | server | Keep (move into the filter bar's "Coverage" disclosure) |
| `ui/inbox/reply-composer.tsx` | `ReplyComposer` (**the only Inbox client component**) | client; write → review → publish; `useActionState`; posts exactly the reviewed text | **Keep the protocol unchanged.** Wrap it later in a mode selector (public / private). Never fork its submit path. |
| `ui/primitives/*` | `Button`, `Notice`, `StatePill`, `DataTag`, `Disclosure`, `OriginMark`, `TextLink`, `Field` | server-safe | Keep; add `Drawer` (new) and `SegmentedControl` (new) in a code gate |
| `ui/shell/app-shell.tsx`, `app/…/workspace-shell.tsx` | app shell and workspace nav | server | Keep; the Inbox sub-nav ("Comments") lives in the Inbox header, not in the shell |
| `ui/icons`, `ui/foundations/tokens.ts` | catalog and tokens | — | Keep; no new icon family ("not saturated with icons") |
| `app/…/inbox/views.tsx` | `InboxListView`, `Row`, `ConversationView`, `Member`, `replyEligible`, `composerLabels`, `replyOutcomeMessages`, `replyFormKey`, `ListPaneFor` | server composition | Refactor the composition only; keep `replyEligible`, `replyFormKey` and the outcome mapping verbatim |
| `server/inbox/actions.ts` | `publishReplyAction` | Server Action | **Unchanged** (validated path) |
| `server/inbox/inbox.ts`, `runtime.ts`, `reply-state.ts` | message maps, view-state resolution, pipeline | server | Keep; extend message maps only through catalog keys |
| `server/queries/inbox.ts` | `inbox.conversations.list`, `inbox.conversation.view`, `buildReplyModel`, `validationReplyModel` | read commands | Keep. Filters and understanding are **additive** read-model changes (Phase 3) |

---

## 3. Route and dependency map (current)

```
app/workspaces/[ws]/inbox/layout.tsx ── WorkspaceShell(section="inbox")
├── page.tsx                      → currentInboxPage() ─► inbox.conversations.list (pipeline, workspace.read_operational)
│                                   InboxPanes(list=InboxListView, detail=DetailEmpty)
└── [conversationId]/page.tsx     → Promise.all(currentConversation(), currentInboxPage())
                                    InboxPanes(list=InboxListView(selectedId), detail=ConversationView)
                                    ConversationView ─► Member ─► ReplyComposer(action=publishReplyAction)
server/inbox/runtime.ts  → createActionPipeline(identity=requestAuth, unitOfWork=webUnitOfWork)   [no outbox notifier]
server/inbox/actions.ts  → requestPublicReplyCommand ─► mutations/request.requestPublicReply
                           ─► intent PENDING + outbound_replies + history + audit + outbox row (one transaction)
server/queries/inbox.ts  → tx.inbox.* (interactions, conversations, content, coverage, signals)
                           tx.mutations.guards / .validation / .replies (read)
outbox row ─► MAIN outbox.dispatch_sweep (cron * * * * *, rows ≥ 60 s old) ─► INTEGRATION mutations.execute_intent
           ─► executor (two gates, H1 credential binding) ─► Meta POST (one) ─► CONFIRMED / FAILED / BLOCKED / OUTCOME_UNKNOWN
```

Boundaries that must not move: `app/` and `ui/` never import `platform/db`, `integrations/`, `ai/providers` or
`mutations/` (only `mutations/request` types via `server/`); the web bundle has no executor, no KMS decrypt, and no
integration-plane key.

---

## 4. Proposed UX architecture

### A. Inbox navigation

- The Inbox header carries a **work-type switch**. In the MVP it has exactly one live item, **Comments**. A second item
  ("Messages") appears **only** if D1 is amended, never as a disabled placeholder (IA: no out-of-MVP capability has a
  home).
- Below it: **System views** as tabs or a select, per IA §7.3. Phase 1 has **Open** and **Done** (`workflow_state` is
  real). Priority, Needs review, Escalated and Assigned to me arrive with their data (Phases 3+), and a view with no
  backing data is not shown.
- The source scope **All · Organic · Paid** is persistent (IA §7.7). Phase 3 needs a server filter; Phase 1 omits it
  rather than faking it.

### B. Comments view (main surface)

- **One wide list** (max reading width about 960–1040 px; the rest is margin or the temporary drawer). One row per
  conversation (IA-01).
- **Row, collapsed (IA §7.5-A):**
  - origin mark (platform plus Paid);
  - author;
  - excerpt (160 characters, plain text, links inert);
  - content reference ("on Post · 2d ago" when content context exists);
  - waiting time or last activity;
  - workflow state (if not open);
  - read count / not-yet-read;
  - Hidden / Removed;
  - **one** primary label plus the short "Why it's here", only once understanding is read (Phase 3).
- **Row, expanded (selected):** expands **in place** under the summary, pushing the rest of the list down. It contains,
  in IA §8 order:
  1. context strip: platform · account · content kind · source · "Open content";
  2. "Why it's here" (when it exists);
  3. **thread** (compact; replies beyond 3 collapsed with "Show N more replies");
  4. labels (primary type, topic, risk, response need; "All understanding" disclosure);
  5. **composer region** (public / private selector, §I);
  6. **action bar** (§E).
- **Exactly one row is expanded at a time.** Selection is the route: `/inbox/[conversationId]?cursor=…` server-renders
  the list with that row expanded. This keeps deep links, Back/Forward, `revalidatePath` and every existing test seam,
  and needs **no new client state** for selection.
- **Exactly one composer is open at a time** per expanded row. On Instagram only the top-level comment is eligible
  (`replyEligible`), so normally there is one candidate. When several members are eligible (Facebook), opening one
  closes the others. This needs a small client coordinator (Phase 2) or a server rule "composer only under the selected
  member" (`?reply=<interactionId>`, Phase 1-compatible, no client state). **Recommendation: the server rule in
  Phase 1.**
- **Temporary side panel ("Context drawer")**, opened from the expanded row ("Full context"):
  - full post (Phase 2+ when content preview exists);
  - full thread, with every earlier version;
  - outbound history and activity history (when it exists);
  - author context in this workspace.

  It overlays the right side (desktop) or the full screen (mobile), never takes layout space when closed, and its
  state is in the URL (`&panel=context`), so it is server-rendered and shareable.

### C. Inline reply (expandable)

- **Reuse `ReplyComposer` unchanged**: closed → "Reply" button; write (textarea, count, help); review (exact text
  preview, "Publish reply"); done (a closed outcome notice). It posts exactly the reviewed text, with a server-issued
  idempotency key per render.
- The destination line keeps "To: <author> · As: <platform> account". Add the account display name once the model
  carries it (Phase 2; `connections.discovered_assets.display_name` exists, the Inbox model doesn't carry it).
- The validation variant keeps its warning notice and server-side resolution (`validation: true`, never an id).

### D. Publication context

- **Phase 1 (existing data only):**
  - platform · content kind · Organic/Paid/Mixed/Unknown. Nothing the model does not carry is inferred or displayed;
  - "Open content" is omitted until a permalink exists (never a constructed URL).
- **Phase 2+ needs a backend content-context contract (missing):**
  - caption excerpt (a source fact, written by ingestion; versioned like text);
  - permalink;
  - media type;
  - thumbnail.
- **Thumbnails:**
  - provider CDN URLs expire and are third-party origins (CSP `img-src`, privacy, SSRF if ever fetched server-side —
    TA §38.7);
  - recommendation: no hot-linking in the first iteration, show a typed placeholder plus the caption excerpt;
  - a storage-proxied thumbnail is its own decision.

### E. Moderation and filters

- **Action bar hierarchy (IA §8.1):**
  - **Primary:** Reply · Mark done · Assign.
  - **Secondary** ("More"): Reply privately · Hide/Unhide · Escalate · Note · No reply needed · Correct labels ·
    Open content.
  - **Destructive** (separated, with a confirmation that names the consequence): Delete · Block author.
- **Never hide an action because of a platform limit.** Only role limits hide (IA §18). Every unavailable action shows
  **one** reason from the server resolver (Monitor-only → platform → connection → paused). Text labels, few icons.
- **Server contract needed (Phase 3, read-only):** generalize `ReplyModel` into an `ActionAvailability` map
  `{ public_reply, private_reply, hide, unhide, delete, block, mark_done, assign }`, each
  `hidden | unavailable(reason) | available`, decided by the same guards the commands use. **Today only `public_reply`
  has a request path.** Every other action renders as unavailable with its true reason. Moderation stays not
  implemented.
- **Filters backed by data today** (Phase 3 adds them server-side, validated query params, keyset-compatible):
  - platform;
  - source (organic/paid/mixed/unknown);
  - workflow state (open/done);
  - content kind;
  - presence (hidden/removed);
  - managed account.
- **Filters NOT backed yet:** classification type, risk, response need, sentiment (and only in "More filters", D2),
  assignee, language, topic. They appear only once their read model exists. **No UI filter may be applied
  client-side over a single page** (that misrepresents coverage, S11).

### F. Publication states

| Intent | UI state | Tone | Copy rule | Next step offered |
|---|---|---|---|---|
| PENDING / EXECUTING | **Sending…** | neutral | "Requested at T" | none (never "retry") |
| CONFIRMED | **Sent** | success | "Requested T · Confirmed T2" (+ "View on platform" when a permalink exists) | — |
| FAILED | **Failed** | danger | an outcome-language reason by `outcome_code` (permission, token, not eligible, rejected) | none automatic; "Open on platform" |
| OUTCOME_UNKNOWN | **Checking** | warning | "We're confirming with <platform>. Don't reply again manually." | none; reconciliation only |
| BLOCKED | **Not sent** | warning | the guard reason (paused, connection, authorization) | — |

- **Auto-refresh (Phase 2):** while any outbound item in the expanded row is Sending or Checking, re-render the server
  view (`router.refresh()`) every 5 s for 2 minutes, then every 30 s up to 10 minutes, then stop and show "Still
  sending — refresh to check". This is a new small client component (the guard change is explicit) and is
  **read-only**.
- **Never** optimistic UI, a "send again" button, or client-side state inference.

### G. DM view — **BLOCKED (D1)**

The input for the amendment phase is in §5.2. **No DM UI, route, component, placeholder or data contract is
authorized.** If the product owner amends PD/Model/IA/UX, the requested shape (list left, chronological history right,
composer) is the natural layout. It requires a separate backend program: inbound message ingestion and webhooks,
messaging permissions, platform messaging windows, retention and privacy, assignment and notes, and the DM-specific
mutation contract.

### H. Private conversation — **BLOCKED (D1)**

Same as G. Note for the amendment: a private reply from a comment (D-36) must stay a **one-shot outbound record plus
a history marker** unless the amendment explicitly changes Model §36.

### I. Public / private reply selector

A **segmented control** at the top of the inline composer: **Public reply** | **Private reply (one message)**.

| | Public reply to the comment | Private reply started from the comment | Message in an existing DM conversation |
|---|---|---|---|
| Scope | MVP | MVP, one-shot (D-36) | **Out of MVP (D1)** |
| Capability key | `reply_public` | `reply_private` | — |
| Intent kind | `reply_public` (exists) | `reply_private` (**missing**) | — |
| Provider operation | `createInstagramCommentReply` (exists, validated once) | `replyPrivately` (contract only; **Meta adapter missing**) | — |
| Result in Wrenkind | `outbound_replies` row, later read back as a thread member | an outbound record plus a **history marker**; never an Interaction (Model §36, S9) | — |
| Meta specifics | validated once | **VALIDATE**: endpoint, permissions (messaging permissions differ from comment permissions), time window after the comment, one-per-comment limit, account eligibility | — |

- **Private mode, before sending (IA §8.3, F-09):**
  - "This sends one private message to <author>. If they answer, the conversation continues in <Platform>'s inbox,
    not here.";
  - the eligibility line (window / already sent / not supported);
  - the destination ("to <author> via <Platform> messages, as <account>").
- **Availability:** until `reply_private` is validated for a platform, private mode is **visible but unavailable**
  with the platform reason. The control is never removed for platform reasons.
- **The success of the public reply validates nothing about private replies or DMs** (different endpoint, permissions
  and token type; TA-Q-22 / PD OQ-26 class).

### J. Empty, loading, error, expiry and permission states

| State | Behavior |
|---|---|
| Nothing read yet / nothing in coverage | existing `InboxEmpty` copy; the coverage disclosure opens automatically |
| Loading | route-level `loading.tsx` skeleton (rows, not spinners); the expanded row streams its thread |
| Unavailable (database/composition) | existing danger notice; no partial data |
| Signed out | redirect to `/sign-in` with a return URL to the conversation (today the redirect loses it; seen in 14P2G) |
| Verification required | existing info notice |
| Conversation not found / other workspace | existing neutral message (NOT_FOUND, never "forbidden") |
| Role cannot reply | affordance **hidden** (IA §18) |
| Monitor-only | Inbox-level notice; composer replaced by an explanation; actions unavailable with the mode reason |
| Validation authorization expired | **new copy:** "This validation authorization has expired. Nothing was sent." (today it silently falls back to "not enabled"; 14P2G diagnosis). Server model: `validation_expired` only for the initiator's own most recent expired, unconsumed authorization |
| Reply refused / blocked | existing closed outcome notices |

### K. Responsive behavior

| Width | Layout |
|---|---|
| ≥ 1280 px | Wide list (centered column); expanded row inline; drawer overlays the right (about 480 px), list stays visible |
| 768–1279 px | Same list; drawer overlays the full height (about 70 % width) |
| < 768 px | List only; selecting navigates to the conversation route rendered full-screen (today's one-screen behavior); composer inline; action bar sticky at the bottom of the expanded content; drawer is a full-screen sheet |

### L. Accessibility

- Rows stay native links (selection = navigation). The expanded region has a heading; on navigation, focus moves to
  it (`autoFocus` on the server-rendered heading via the `#conversation` fragment, as today).
- The composer keeps label, help, live character count and live outcome notices. The selector is a radio group
  (`role="radiogroup"`), fully keyboard-operable.
- The drawer is a **modal dialog** on mobile and a **non-modal complementary region** on desktop. Esc closes it and
  focus returns to the opener.
- State is never conveyed by color alone (pills carry text). Respect `prefers-reduced-motion` (no expand animation
  beyond 150 ms).
- Destructive confirmations use `alertdialog` with the consequence in the description.

### M. Internationalization (EN / ES / PT)

- Every string through catalog keys (already enforced; client components receive translated labels as props).
- Templates with named parameters and no concatenation; plural-safe counts (`{count}` with plural forms when ES/PT
  catalogs are added).
- Dates and times through one locale-aware formatter (`displayTime` → locale parameter).
- No truncation by character count in components (the server shapes excerpts). Layouts tolerate +35 % string length
  (PT/ES).
- Platform names stay untranslated; audience text is never translated in place (translation is an IA §7.5-C
  on-demand feature).

---

## 5. Wireframes (descriptive)

### 5.1 Comments (desktop ≥ 1280 px)

```
┌ App shell ───────────────────────────────────────────────────────────────────────────────────────────────┐
│ Inbox                                                       [Comments]                                     │
│ [Open ▾ Done]   Platform ▾  Source: All|Organic|Paid  Account ▾  State ▾   ·  Coverage: as of 12:40 ▸       │
├────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ◉ IG  Ana R.                        "¿Tienen envíos a Valparaíso? …"            on Post · 2d   3h ago       │
│ ◉ FB  Unknown author                "Precio?"                       Hidden      on Reel · 5d   1d ago       │
│▼◉ IG  Seba K.                       "Wrenkind test 7b-14D3"                     on Post · 2d   1h ago       │
│ │  Instagram · @account · Post · Organic                                       [Full context ▸]             │
│ │  ── Thread ───────────────────────────────────────────────────────────────────────────────────────────   │
│ │  Seba K. · Comment · Nov 11 14:37             Wrenkind test 7b-14D3                                        │
│ │     └ You · Reply · Sent ✓  Requested 12:37 · Confirmed 12:39                                             │
│ │  ── Reply ─────────────────────────────────  ( Public reply | Private reply (one message) )              │
│ │  To Seba K. · As Instagram account                                                                        │
│ │  [ textarea …………………………………………………… ]  1000 left                                    [Cancel] [Review]    │
│ │  ── Actions ───────────────────────────────────────────────────────────────────────────────────────────  │
│ │  [Mark done] [Assign]   More ▾ (Reply privately · Hide · Escalate · Note · No reply needed)   ⋯ Delete…   │
│ ◉ IG  …                                                                                                      │
│                                                                              [Older →]                       │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
Drawer (on "Full context"): Post (caption, media placeholder, Open on Instagram) · Full thread + versions ·
Outbound history · Activity history · Author context (this workspace). Esc closes.
```

Unavailable actions render as `[Hide]` with a one-line reason on focus/hover **and** as visible text in the "More"
menu ("Instagram hiding isn't available in Wrenkind yet").

### 5.2 Messages (DM) — **BLOCKED (D1); for the amendment discussion only**

```
┌ Conversations ───────────┬ Ana R. · Instagram · @account ───────────────────────────────┐
│ ● Ana R.   IG  2m        │  (chronological history)                                      │
│   Seba K.  FB  1h        │  …                                                            │
│                          │  [composer — only if messaging send is validated]             │
└──────────────────────────┴───────────────────────────────────────────────────────────────┘
```

Questions the amendment must answer:
1. **Scope:** does PD §10 change (D-07/C-03)? Does Model S9/§36 change?
2. **Messaging contracts:** inbound ingestion (webhooks, polling, history depth), sender identity and retention.
3. **Platform rules:** permissions (messaging differs from comments), platform messaging windows and human-agent
   rules, rate limits.
4. **Data handling:** privacy and data classes (private content is more sensitive than public comments), guest and
   analytics exclusions.
5. **Workflow:** assignment, notes and read states.
6. **AI:** whether AI understands DMs (cost, consent).
7. **Product interplay:** how private replies from comments join DM threads.

---

## 6. Data contracts — existing and missing

| Need | Existing | Missing (gate type) |
|---|---|---|
| Row summary (platform, source, kind, author, excerpt, presence, counts, workflow) | `InboxConversationItem` | waiting-since (time of the oldest unhandled audience comment) — read-model change |
| Content context | platform, `contentKind`, `source` | caption excerpt, permalink, media type, account display name — **ingestion + schema + read model** (backend) |
| Thread | `ThreadItem` (text, versions, presence, facts) | — |
| Outbound | `OutboundReplyItem` (state, outcomeCode, times) | provider permalink for "View on platform" (VALIDATE: whether Meta returns it or it must be fetched) |
| Reply availability | `ReplyModel` (hidden / unavailable / available / validation) | `validation_expired` variant; generalized `ActionAvailability` map |
| Understanding (labels, priority, why-here, response need) | persisted `classification.assessments` (not read); `classification.signals` (read as facts) | Inbox read model over assessments (latest per dimension and current text version, precedence M-05: human > rule > AI > hint); priority/why-here composition — **Step 8 scope** |
| Filters | — | validated query params plus filtered keyset query over the conversation activity — read-model change |
| Workflow actions | `workflow_state` read | commands: mark done/reopen, assign, escalate, note — **new commands + audit** |
| Moderation | provider contract + simulator | Meta adapter, request service, intent kinds, executor paths, capability validation — **backend program** |
| Private reply | contract `replyPrivately`, capability key | Meta adapter, `reply_private` intent and request, history marker, eligibility facts — **backend program (Phase 5)** |
| DM | — | **BLOCKED (D1)** |

---

## 7. Reusable pieces (do not rewrite)

- `ReplyComposer` and its protocol (review stage posts exactly the shown text; server-issued key per render;
  `useFormStatus` pending; closed outcomes).
- `publishReplyAction` and `requestPublicReplyCommand` (validated path; 7B-15A forbids changing it).
- `replyEligible`, `replyFormKey`, `replyOutcomeMessages`, `composerLabels`, `OUTBOUND_TONES`.
- `buildReplyModel` / `validationReplyModel` (server decides; the browser never sees an authorization id).
- `ThreadMember`, `OutboundReply`, `VersionList`, `Facts`, `ReplyUnavailable`, coverage blocks, primitives.
- Routes `/inbox` and `/inbox/[conversationId]` (deep links, `revalidatePath`, tests).

---

## 8. Regression risks

| Risk | Where | Mitigation |
|---|---|---|
| Breaking the validated public-reply path | `views.tsx` `Member`, `reply-composer.tsx`, `actions.ts` | Phase 1 moves markup only. The `ReplyComposer` props, hidden fields, action and `replyFormKey` stay byte-identical. Run `tests/unit/ui/reply-composer.test.ts`, `tests/unit/server/inbox-reply.test.ts` and `inbox-page.test.ts` unchanged |
| A second open composer, or a duplicated form key, causing a double request | inline expansion | One composer per server render (`?reply=` rule). The key is per render; the command answers `existing` on reuse (R6) |
| Validation composer shown outside its exact target | `validationTarget` lookup | Keep the lookup; add a test that the validation composer renders only under the authorized target in the new layout |
| Architecture guards | `tests/architecture/brand-guards.test.ts` (the composer is the ONLY client component; no bound handlers in server components) | Phase 1 adds **no** client component. Phases 2+ change the guard **explicitly** (drawer, auto-refresh, selector) with their own pinned rules |
| Client-side filtering misrepresenting coverage (S11) | filters | Server-side filters only |
| Leaking ids or capability decisions to the client | new props | The server passes translated labels and closed states only; never authorization ids, switch values or raw capability states |
| Layout change hides unavailable actions | action bar | A test asserts unavailable actions are rendered with a reason (never removed) |
| Mobile regression of the one-screen flow | `InboxPanes` `data-selected` | Keep the full-screen conversation route below 768 px; test the back link keeps the cursor |
| i18n | new strings | Catalog keys only; key-coverage test |

---

## 9. Incremental implementation plan

| Phase | Scope (frontend unless stated) | Explicitly NOT in scope |
|---|---|---|
| **1 — Comment presentation refactor** | Replace the two-pane layout with a wide list plus an **inline expanded selected conversation** on the existing `[conversationId]` route; context strip from existing fields; compact thread with "Show N more replies"; composer only under the member chosen by `?reply=` (default: the anchor when eligible); unavailable-actions bar with **only** `public_reply` live and the others visibly unavailable with a generic "not available in Wrenkind yet" (no new server model); preserve the mobile one-screen route | New client components, server models, filters, AI, drawer, private reply, any backend |
| **2 — Inline composer polish and context** | `Drawer` primitive and the `&panel=context` route state (full thread, versions, outbound history); `SegmentedControl` with Private visibly unavailable (static reason); outbound **auto-refresh** client component; `validation_expired` copy (small read-model addition) | Content preview data, private reply backend |
| **3 — States, filters, understanding** (server read models) | Server-side filters (platform, source, state, kind, presence, account); `ActionAvailability` map; an understanding read model over `classification.assessments` (primary label, response need, "Why it's here" when composable), sentiment only in disclosure (D2); views Open/Done (+ Needs review when data exists) | Priority scoring changes, AI calls, kill-switch changes |
| **3b — Content context** (backend) | Ingestion of caption/permalink/media type; schema; account display name in the model | Thumbnail proxy (its own decision) |
| **4 — DM visual experience** | **BLOCKED by D1.** Not schedulable until the PD/Model/IA/UX amendment | everything |
| **5 — Private reply from a comment** (backend + UI) | Meta `replyPrivately` adapter (read-only validation first), `reply_private` intent/request/executor path with the same gates, history marker (Model §36), capability validation gate, then the UI mode goes live per platform | DM threads, inbound messages |
| **L — Dispatch latency** (backend, §11) | Post-commit relay nudge for the reply command | executor changes |

Never combine in one gate: a visual redesign + executor/infra changes + new capabilities.

---

## 10. Tests required per phase

| Phase | Tests |
|---|---|
| 1 | Unchanged: `reply-composer`, `inbox-reply`, `inbox-page`, `inbox` unit tests; `inbox-read` DB suite; brand guards. New: (a) the selected conversation renders inline with the IA §8 block order; (b) exactly one composer per render; (c) the validation composer only under its authorized target; (d) unavailable actions are visible with a reason; (e) the mobile route keeps the back cursor; (f) no client directive outside the composer; (g) catalog key coverage |
| 2 | Drawer: dialog semantics, Esc/focus return, URL state. Auto-refresh: stops at terminal states and timeouts, never posts. Selector: radio-group keyboard behavior; private mode cannot submit. Updated brand-guard pins for each new client component |
| 3 | Filter parsing (strict, rejects unknown values), keyset pagination with filters, RLS/tenant isolation (T-01/T-11 for the new reads), introspection unchanged; understanding precedence (human > rule > AI, M-05), abstention → "uncertain"; sentiment absent from list markup (D2) |
| 3b | Ingestion contract tests (fixture → DTO), source-fact append-only versioning, coverage honesty |
| 5 | Provider contract tests for `replyPrivately`, simulator parity, T-04 Monitor-only, T-10 idempotency/unknown outcome (no auto-retry of private replies, CLAUDE.md §9), executor gate tests, history marker never an Interaction (S9), capability default UNKNOWN |
| L | Nudge best-effort (failure → sweep still delivers), dispatch-key idempotency (no double dispatch), web holds only the MAIN key |

---

## 11. Dispatch latency (observed 2026-11-13, read-only analysis)

| Event | Time (UTC) | Δ |
|---|---|---|
| Intent PENDING + outbox row (web) | 12:37:48.028 | 0 |
| MAIN `outbox.dispatch_sweep` at 12:38:15 | — | skipped the row: age 27 s < `dispatchSweepMinAgeSeconds` = 60 |
| MAIN sweep at 12:39:13.5 → dispatched | 12:39:13.533 | +85 s |
| `execute_intent` started / EXECUTING | 12:39:15 / 12:39:24.260 | +96 s |
| Provider reply created (Meta timestamp) | 12:39:34 | +106 s |
| CONFIRMED | 12:39:36.079 | +108 s |

- **Cause:**
  - the Inbox's web pipeline (`server/inbox/runtime.ts`) is composed **without** the post-commit outbox notifier
    (`server/jobs/outbox-notifier.ts`, `nudgeRelay` → `outbox.relay`);
  - 0 `outbox.relay` runs occurred;
  - delivery therefore waits for the 1-minute sweep, which only takes rows at least 60 s old;
  - **expected latency is 60–120 s plus execution time.**
- **Options:**
  1. **Wire the existing notifier** into the reply command's pipeline. It is best effort, the sweep stays the
     safety net, and dispatch-key idempotency prevents double dispatch. It needs the web to hold the **MAIN** Trigger
     key, ideally restricted to `outbox.relay` (open item in `outbox-notifier.ts`). Expected about 5–15 s.
  2. Lower `dispatchSweepMinAgeSeconds` (for example to 15 s). It is simpler, but it raises the overlap with in-flight
     relays (still idempotent) and does not remove the cron granularity.
  3. Direct trigger of `execute_intent` from the web: **rejected** (the web must never hold the INTEGRATION key; TA
     plane separation).
- **Backlog priority: P1** (after Phase 1). Safety is unaffected, but a "Sending…" that lasts up to 2 minutes without
  auto-refresh erodes trust and invites a manual duplicate reply on the platform, which reconciliation would then flag
  as ambiguous. Phase 2's auto-refresh mitigates the perception; option 1 fixes the cause.

---

## 12. Prioritized backlog

| P | Item | Type |
|---|---|---|
| P0 | **PO amendment decision on D1** (DMs) and D2 (sentiment placement) | governance |
| P1 | Phase 1 presentation refactor | frontend |
| P1 | Dispatch latency, option 1 (notifier) | backend (small) |
| P1 | Outbound auto-refresh plus `validation_expired` copy | frontend + tiny read model |
| P1 | Sign-in redirect keeps the return URL (14P2G lost it) | frontend/auth |
| P2 | Drawer and selector shell (private visibly unavailable) | frontend |
| P2 | Server filters plus `ActionAvailability` | read models |
| P2 | Content context ingestion (caption, permalink, display name) | backend |
| P2 | Understanding read model (labels, response need, why-here) | read model (Step 8) |
| P3 | Workflow commands (done/reopen, assign, note, escalate) | backend + UI |
| P3 | Private reply program (Phase 5) | backend + validation gates |
| P3 | Moderation program (hide/unhide first; delete/block later) | backend + validation gates |
| P4 | ES/PT catalogs, plural forms | i18n |
| — | DM program | **BLOCKED (D1)** |

---

## 13. Design before code

1. **D1/D2 decisions** (product owner, amendment phase).
2. **Visual design** (Claude Design/Figma), from this blueprint:
   - expanded-row anatomy;
   - action bar hierarchy and the "More" menu;
   - unavailable-action treatment;
   - state pills;
   - drawer;
   - segmented selector;
   - density, spacing and widths on the existing tokens (UI-1/UI-2 brand system).
3. **Copy deck:**
   - unavailable reasons per action and platform;
   - the private-reply limitation;
   - Checking/Failed guidance;
   - `validation_expired`.
4. **The understanding display spec:** which assessment dimensions map to the primary label, response need and the
   why-here template, under abstention and precedence rules.
5. **The content-context contract:** fields, retention, versioning, thumbnail policy.
6. **The private reply contract:** platform endpoints, permissions and windows (VALIDATE), and the marker format.

## 14. What can be implemented immediately

- **Phase 1**, as specified in §9. Frontend only, no new client component, no server model change, the validated
  reply path byte-identical.
- In parallel and read-only: the copy deck draft and the visual exploration.

## 15. Model recommendation per stage

| Stage | Recommended | Why |
|---|---|---|
| Visual exploration / design system mapping | **Fable 5.2** (or Claude Design) | Visual craft, layout and density iteration |
| Phase 1 presentation refactor | **Fable 5.2** for implementation plus an **Opus 5.5** focused review of the reply-path invariants | Mostly markup and CSS; the review protects the validated path |
| Phase 2 (drawer, selector, auto-refresh) | **Fable 5.2**, with an Opus review of the guard changes | New client components touch architecture guards |
| Phase 3 (filters, ActionAvailability, understanding) | **Opus 5.5** | Read models, RLS, precedence (M-05), honesty rules (S11/S19) |
| Phase 3b (content context ingestion) | **Opus 5.5** | Ingestion, source facts, provider fields (VALIDATE) |
| Phase 5 (private reply) and moderation | **Opus 5.5 High** | Executor, provider adapters, LIVE validation gates |
| Dispatch latency | **Opus 5.5** | Job plane, keys, idempotency |
| D1 amendment drafting | **Opus 5.5** with product owner | Cross-document consistency |

---

## 16. Security guarantees preserved (all phases)

- Server-side authorization through the action pipeline (membership, permission, mode) for every read and command;
  hiding only for role limits, never as authorization.
- Public / private / DM are distinct capabilities, intents and contracts; the success of one validates nothing for
  another.
- `validationAuthorizationId` never reaches the browser (mode flag only; server resolution through RLS).
- The executor's two gates, H1 credential binding, one provider call per intent, no automatic POST retry, and
  OUTCOME_UNKNOWN reconciliation (read-only, never a resend).
- Double-submit protection: a server-issued key per render, `useFormStatus` pending, and an `existing` answer on key
  reuse (R6).
- `provider_action` default-deny and the `*` emergency block; the catalog default UNKNOWN; Monitor-only enforced on
  the server.
- Workspace isolation (RLS + bound workspace); cross-workspace = NOT_FOUND.
- The web bundle has no executor, no KMS decrypt, and no INTEGRATION key (the MAIN key only, for the relay nudge, if
  option L1 is adopted).

---

## 17. Phase 1 reply drafts (Steps 7B-15F, 7B-15H) — contract and limits

Design record only; it does not amend any approved document. It records how Phase 1 meets UX §2 P3 ("Drafts survive
navigation and errors") **partially**, and what it deliberately does not do.

**Storage.** An unsent public reply is kept **only in the browser tab's memory** (a module-level map in
`ui/inbox/reply-drafts.ts`, imported only by the composer and the signed-out boundary). Never localStorage,
sessionStorage, IndexedDB, cookies, the URL, logs, analytics or the server. Server rendering never reads or writes it.

**Key.** An opaque per-person scope (SHA-256 of the verified user id under a purpose label, `server/inbox/draft-scope.ts`;
pseudonymous, not secret, never an authorization) + workspace + conversation + target comment. Without a verified
person there is no scope and no draft (never a shared fallback).

**Survives.** Moving the one composer between comments of the same conversation ("Reply to this comment" is an in-app
navigation, never prefetched), browser Back/Forward between those addresses, and an answer in which the server created
nothing (refused, blocked, signed out) — the submitted text returns at the write stage.

**Is discarded.** Publish pressed (removed before the request; nothing is kept for that comment while the request is in
flight — Edit is disabled while pending), an accepted or possibly-accepted answer (requested, existing, unavailable, a
transport failure), Cancel, emptying the text, sign-out or any signed-out surface (`/sign-in`, `/sign-up`, and `/` while signed out — Step 7B-15J — clear the whole
store — sign-out is an in-app navigation, so the tab's memory would otherwise survive it), a reload, closing the tab, and
any full-page navigation (another conversation, the list, another workspace). Before a full navigation with a kept
draft the browser shows its native, generic leave confirmation (where the browser supports it; it cannot name the
draft or say "Discard draft?").

**Restoring never publishes.** A kept draft only seeds the write stage of a composer the server chose to draw; the mode
(ordinary or validation), the target, the form key and Monitor-only all come from the server's render; publishing
still requires Review and the explicit Publish.

**Phase 1 limitation (explicit).** Drafts are not retained across a full-page navigation, a reload or a sign-out, and
the UX §3.1 "Discard draft?" prompt on workspace switching is approximated by the browser's generic confirmation.
Keeping drafts across those boundaries would mean persisting class B text (TA §38.11) in browser storage or on the
server — a separate security and product decision, not taken here.

**Enforcement.** `tests/architecture/inbox-composer-guards.test.ts` (syntax-tree rules: no storage/network/URL/global
escape in any client module, `window` only for `typeof` and the beforeunload listener, no dynamic import, the publish
action's single entry, Cancel's key, the in-flight Edit button, the signed-out boundary); behavior in
`tests/unit/ui/reply-drafts.test.ts`, `tests/unit/server/reply-draft-scope.test.ts` and the Inbox page tests.

**Unknown outcome (Step 7B-15J).** `unavailable` (the action's catch, a non-blocking pipeline error) and a failed
request mean the reply MAY already exist (e.g. the intent committed and the answer was lost). Two layers keep that from
becoming a second, independently publishable request:

1. *This tab (client):* the comment's key is marked uncertain; no draft is kept for it any more (until sign-out or a
   reload), so nothing typed after Edit can come back under a new form key. Retrying in the SAME composer reuses its form
   key, so the server answers `existing` (or refuses a changed text with `IDEMPOTENCY_KEY_REUSED`) — it cannot create a
   second reply. The outcome copy no longer says "Nothing was published".
2. *Every render (server read model):* a comment whose reply is `sending` or `checking` (PENDING, EXECUTING,
   OUTCOME_UNKNOWN — any initiator) gets no composer and no link that places one, with its one reason. This is what
   covers a reload, another tab, another session or a teammate once the earlier intent exists.

**Known gap (requires a separate backend gate).** Admission (`requestPublicReply`) recognizes a repeat only by its
idempotency key; it does not refuse a new key while another public-reply intent for the same target is in flight. So two
submissions racing before either commits (two tabs within the same moment), or any client that does not use this view,
can still create two intents for one comment. The validation path is protected by its one-time authorization; the
ordinary path is latent today (reply_public UNKNOWN, provider_action default-deny). Closing it needs a server-side rule
(e.g. refuse `REPLY_IN_FLIGHT` for a target with a PENDING/EXECUTING/OUTCOME_UNKNOWN public-reply intent, enforced in the
same transaction, plus a database backstop) — an admission-contract and schema change outside this gate.
