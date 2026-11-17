# Comments experience redesign (Step 7B-17V)

Status: **PROPOSAL for the PO prototype review.** This proposal changes no approved document, no product route, no
data and no permission. It preserves UX-19 (inline Focus) and UX-20 (in-memory drafts), and ordinary public replies
stay default-deny. The wording in the Comments 2.1 contract (§B) is still PROPOSED. Competitive evidence is in
[COMPETITIVE-UX-ANALYSIS.md](./COMPETITIVE-UX-ANALYSIS.md).

## 1. Prototype

- **Route:** `/dev/ui-reference/comments-redesign`. It is served only under `next dev` and returns 404 in every other
  build (brand-guards proves this).
- **Files:** `app/dev/ui-reference/comments-redesign/`
  - `page.tsx`: the dev-only gate;
  - `prototype.tsx`: one client component;
  - `model.ts`: the rules, as pure functions;
  - `fixtures.ts`: synthetic data — 36 conversations, 4 accounts, a 15-entry thread, published replies, hidden and
    removed comments, unknown post, unknown source, an account with no verified name;
  - `prototype.module.css`: Wrenkind tokens only.
- **State:** all state is React state in the tab. Nothing is read, written, stored or sent. The reply composer is a
  preview marked "Preview — nothing is sent", and it has no Publish control.
- **Prototype controls** (a dashed band, not product UI):
  - Role: Owner, Admin, Manager, Agent, Analyst, Client guest;
  - Workspace: Standard or Monitor-only;
  - Read model: Today or Planned (whether account and member names are available);
  - Reply: as today (unavailable) or composer preview;
  - Reset.
- **To preview:** run `npm run dev` and open `http://localhost:3000/dev/ui-reference/comments-redesign`. Use
  `localhost`, not `127.0.0.1`, or hydration is blocked. Next 16 creates an untracked `AGENTS.md`; delete it afterwards.

## 2. Interaction model

There are five principles. Each problem the PO found (A–J) maps to one change.

| # | PO problem | Today (live Comments 2.1) | Proposed |
|---|---|---|---|
| A | Actions not directly accessible | Reply is a link under the comment; Reply privately and Hide sit in a conversation-level "More actions" disclosure at the end | Each comment has **three** quiet text actions in its own header: **Reply · Labels · More**. They are always visible (never hover-only) and named for that comment ("Actions for caro.mendez's comment"). |
| B | Focus has excessive metadata | Kind word on every entry ("· Comment", "· Reply"), "Observed details", per-entry disclosures | An entry shows author, time, edited marker and text. Hierarchy comes from one level of indentation plus "Replying to X" only when the place in the thread can't say it. |
| C | "Exact times" repeated under every comment | One disclosure per entry | The **visible time is the trigger**. Activating it (or More → "Details and exact times") opens one small record: written, edited, read by Wrenkind. For a published reply it shows published as, requested by, requested at, published at. One record at a time. `<time datetime>` and the screen-reader exact reading are kept. |
| D | Published replies say "Your account" | `inbox.outbound.author` = "Your account" | The author is the **connected account's verified name** (for example "@lumen.coffee · Your Instagram account"), with **Sent** and its time. The Wrenkind member is a separate fact, in Details only. Without a verified name: "Your Instagram account", never an invented name (§4). |
| E | Clicking the expanded header doesn't collapse | Opening is a navigation and closing is a separate "Close" | **The whole row header is one button** (`aria-expanded`, `aria-controls`, chevron) that opens and closes Focus. While open it is **sticky**, so closing is one click away in any thread. Escape closes and returns focus to the header. Previous / Next sit beside it. |
| F | Safety and capability notices come before the comment | "Not automatically reviewed…" and "Replying from Wrenkind isn't available yet." precede the thread | **The thread comes first.** The reply reason appears **at Reply**, under the comment ("Replying from Wrenkind isn't available yet." / "This workspace is Monitor-only."). The review status is said once, **after** the thread. Provider actions in More are listed but unavailable, with one reason. Nothing claims an AI review. |
| G | "About this conversation" over-weights unknowns | Side block with chips: platform, kind, source (including "Unknown"), state; "Post details aren't available yet." | **One context line** with only known facts (kind, caption, an "Ad" / "Organic and paid" tag only when reported), or "Post not read yet". Everything else goes in a closed **Conversation details** list at the end. An unknown source reads "Not reported by the platform" there and is never inferred. |
| H | Navigation duplicates module labels | Rail "Comments" · sidebar heading "Comments" · "All comments" · page title "Comments" | The rail names the module once. The sidebar lists **views** (All comments, the Labels group). The page title is the **current view** ("All comments" or the label's name). |
| I | Coverage banner takes attention | Wide "What has been read" bar | **One quiet line** beside the title ("Read through 17 NOV 11:52 · 1 account partly read"), with the per-account record on demand. A warning glyph appears only when an account is partial. Coverage truth (S11) is unchanged and still visible. |
| J | No comment-level label action | — | **Labels** on each comment opens a small editor under it: find or create, checkboxes, and **"Create "X" and add it"**. Several labels per comment. A chip can be removed in one step. The sidebar Labels group filters by label. Role-aware (§3). |

The open conversation, top to bottom:

1. the sticky header (also the close control), with Previous / Next;
2. one context line;
3. the thread;
4. the review line;
5. Conversation details;
6. "Close conversation".

There is no extra panel, no tab, no nested menu, and no permanent third column.

## 3. Manual labels in the prototype (aligned with contract §D)

- **Scope:** comment-level. A conversation is listed under a label when at least one of its comments carries it
  (§D.2). Labels never act (UX-21).
- **Names:** 1–40 characters after trimming, unique ignoring case, at most 50 per workspace, flat (§D.3). Errors are
  shown inline with `role="alert"`.
- **Keyboard:** Enter applies the exact name, otherwise the only match (NapoleonCat type-ahead, NC-2), otherwise
  creates the label (if the role may create). Escape closes the editor and returns focus to Labels without closing
  Focus.
- **Chips:**
  - Neutral, square-cornered and never colored like an assessment.
  - Up to 3 per comment and 2 per row, then "+N".
  - In a row they are phrasing content inside the header, read as "Labels: …".
  - On phones, removal happens in the editor; the 44 px rule makes chip ✕ targets impractical.
- **Roles (§D.4):**

  | Role | What it can do |
  |---|---|
  | Owner / Admin / Manager | Create (in the comment editor and "New label" in the sidebar), assign, remove |
  | Agent | Assign and remove existing labels; sees "Owners, admins and managers create labels." |
  | Analyst | Sees chips and filters; no Labels or Reply action |
  | Client guest | Denied; nothing from Comments is drawn |

- **Filter:** one label at a time, shown as the page title and a removable "Label: X" chip. Previous / Next stay inside
  the filtered list. Below 1024 px the sidebar becomes a "View" select.

## 4. Identities: read-model investigation (6.4)

| Identity | Where it lives | In today's Comments read model? |
|---|---|---|
| Original commenter | `interactions.authors.label` (role `user`) | Yes (`authorLabel`) |
| Connected account (the public author of the brand's replies) | `connections.discovered_assets.display_name`, provider-reported at discovery and reached from `connected_accounts` by its composite FK (workspace, connection, provider_asset_id, platform, asset_class). RLS `member_read` admits OWNER, ADMIN, MANAGER, RESPONDER and ANALYST_VIEWER; guests are denied. | **No.** `InboxAccountRow` carries id, platform and status only. Adding the name is a read-model change with **no migration**. |
| Brand messages written directly on the platform | `interactions.authors` with role `account_identity` (its provider `label`) | Its role only ("Your account"). The label is not drawn. |
| Wrenkind member who requested a reply | `mutations.mutation_intents.initiator_user_id` | **No**, and there is **no member display-name source** (tenancy stores no names; auth holds emails). Today the prototype shows "A member of this workspace". |

Rule kept in the prototype: the public author is always the connected account. The member appears only in Details as
"Requested in Wrenkind by". The commenter is never shown as the author of a reply. A brand message written directly
on the platform says "directly on Instagram (not from Wrenkind)" in Details.

## 5. Before and after

The "before" screenshots use the production view components with synthetic data (`/dev/ui-reference/inbox`). That
page has no app shell, so the before and after shells differ. Compare the content area. Screenshots are in
`~/Downloads/wrenkind-7b17v-shots/` (local only):

| Screenshot | What it shows |
|---|---|
| `before-1-desktop-conversation(-full).png` | Today's open conversation: notices first, "About this conversation", "Exact times" on every entry, "Your account". |
| `before-2-desktop-list.png` | Today's list with the coverage bar. |
| `after-1-desktop-list.png` | Proposed list: one coverage line, label chips, "You replied". |
| `after-2-desktop-labels-editor.png` | Label editor after keyboard type-ahead and create-and-assign. |
| `after-3-desktop-sent-reply-and-labels.png` | Published reply under the verified Page name, with Sent. |
| `after-4-desktop-filter.png` | Label filter ("Refund request", 5). |
| `after-5-desktop-long-thread-more.png` | 15-entry thread with the sticky header and the More menu (provider actions unavailable). |
| `after-6-desktop-composer-preview.png` | Composer preview (cannot publish). |
| `after-7-desktop-light-open.png` | Light theme. |
| `after-8-tablet-open.png` | Tablet, 900 px. |
| `after-9-phone-list.png`, `after-10-phone-open.png` | Phone, 390 px: content, then actions. |

## 6. Interaction matrix (measured locally, not user-tested)

**How the numbers were measured:**

- The pointer column comes from `tests/unit/ui/comments-redesign-dom.test.ts`, where one click, one typed text or one
  key counts as one step.
- The keyboard column comes from real headless Chrome through CDP, with focus starting on the conversation's row
  header unless noted. Every Tab and key press is counted, and typing a text counts as 1.
- These are not results from people. Human usability is unvalidated until PO review.

| Task | Today (live, from code) | Prototype: pointer | Prototype: keyboard |
|---|---|---|---|
| Open a conversation | 1 (a navigation) | 1 | 1 (Enter) |
| Close it | 1, on a separate "Close" (the header doesn't close it) | 1 (same header; sticky) | 1 (Enter on the header, or Escape inside) |
| Understand a comment and its replies | 1, but notices come before the thread | 1 (thread first) | 1 |
| Identify the publishing account | Not possible ("Your account") | 1 (verified name on the reply) | 1 |
| Assign an existing label | Not available | 2 (Labels, checkbox) or 3 (Labels, type, Enter) | 7 (4 Tab, Enter, type, Enter) |
| Create a label and apply it to the comment | Not available | 3 (Labels, type, Enter) | 7 from the header; 2 with the editor open |
| Find exact times | 1 per entry (repeated disclosure) | 1 (the visible time) | 3 (2 Tab, Enter) |
| Next conversation | 1 | 1 | 2 (Tab, Enter) |
| Filter by a label | Not available | 1 (sidebar) | 10 from page load (9 Tab, Enter) |

**Also observed in Chrome:**

- 0 console errors, 0 unnamed buttons in the accessibility tree.
- Phone (390 px): no horizontal overflow and no target under 44 px in an open conversation.
- The sticky header stays visible in the long thread.
- Local times read in the browser's zone ("17 NOV 2026 · 11:00 GMT-3").

## 7. Productivity (6.8): proposed, not implemented

| Capability | Classification | Note |
|---|---|---|
| Search (current workspace, PostgreSQL full-text) | **Essential, next Comments release** | The architecture is already LOCKED (CLAUDE.md §3). Searches comment text and author; one box above the list. |
| Filters: platform, account, organic/paid/mixed | **Essential, next release** | Dimensions, not sections (PD D-38). One filter row, with the label filter after manual labels. |
| Keyboard: j/k move, Enter/Escape open/close, `?` cheat sheet | **Essential, next release** | Shortcuts are inert while typing. The cheat sheet is visible, never a hidden mode (SB-3, SP-2). |
| Sort: newest activity / waiting longest | Important after manual labels | "Waiting longest" needs a defined "unanswered" rule, which is a product definition. |
| Done / reviewed state, attributed, auto-reopen on new inbound | **Future, needs PO approval** | `workflowState` exists, but its UX and attribution are undecided (AP-1, SB-3, NC-1). |
| Assignment (to a person) | Future, needs PO approval | A new domain workflow. Auto-assign-on-action is rejected (surprising, NC-1). |
| Saved replies | Future (roadmap Step 10) | Starting points only. No auto-send (S8). |
| Multi-select / bulk | Future, needs PO approval | Labels v1 has no bulk (§D.3). Bulk Hide only on homogeneous sets, with exact counts (UX-06, UX-18; NC-4). |

## 8. Implementation plan (each phase its own gate)

1. **Comments UX refinement (no new domain concept, no migration).**
   - Row-header disclosure with chevron and sticky open header.
   - Content-first order: reply reason at Reply, review line after the thread.
   - Time → details record, replacing "Exact times".
   - One-line context plus Conversation details, replacing "About this conversation".
   - One-line coverage.
   - Sidebar and title de-duplication.
   - Reply · More per comment.
   - Connected-account display name in the read model (join `discovered_assets`, no migration).
   - Catalog copy; tests for layout, accessibility and identity.
   - UX wording amendment (a UX-22 extension) for the PO.
   - UX-19 and UX-20 tests unchanged.
2. **Manual labels.** Contract §D as written (migration 0034, `labels.manage`, commands, sidebar group), with this
   prototype's interaction: comment editor, type-ahead + Enter, create-and-assign, chips, role gating. No bulk, no
   automation.
3. **Organizational workflow (PO approval first).** Search, filters, keyboard and sort per §7. Then Done/review and
   assignment, if approved.
4. **Intelligence integration.** Classification by dimension names (Type · Topic · Risk · Reply needed) in its own
   component with "Why it's here", never label chips. Monitor-only and all S-invariants unchanged.

## 9. Acceptance criteria (for phases 1–2)

1. **Disclosure.**
   - The whole row header is a single `<button>` inside a heading, with `aria-expanded` and `aria-controls` and no
     interactive descendants.
   - It opens and closes in one action.
   - It stays visible while the conversation is open.
   - Escape closes it and returns focus to the header.
   - Previous / Next move focus to the next header and keep the filter.
2. **Content first.** Nothing but the one-line context and Previous / Next comes before the first comment. The review
   status appears once per open conversation, after the thread.
3. **Actions.**
   - Every answerable comment shows Reply · Labels · More at its own header, named for that comment.
   - Each visible target is at least 44 px on phones.
   - No more than three visible actions per comment.
4. **Provider truth.**
   - Unavailable provider actions are listed with exactly one reason, and the reason follows IA §18 precedence.
   - Nothing publishes in a context where publishing is not available.
   - Ordinary `reply_public` stays default-deny.
5. **Times.**
   - No per-comment "Exact times" disclosure remains.
   - The visible time opens the exact record.
   - Every `<time>` keeps its ISO `datetime`.
   - Readings are local with JavaScript (D-55).
6. **Identity.**
   - A published reply shows the connected account's verified name when it is in the read model, otherwise "Your
     {platform} account".
   - Sent and its time are visible.
   - The member who requested the reply appears only in Details, and only if a name source is approved.
   - A commenter is never shown as a reply's author.
7. **Context.**
   - Unknown post or source never appears as a header chip, and is never inferred.
   - "Not reported by the platform" appears in Conversation details only.
8. **Coverage.**
   - Coverage is one line, with a warning glyph only when an account is partial.
   - The per-account record is one step away.
   - S11 is unchanged.
9. **Labels** (§D plus this prototype).
   - Create from a comment assigns the label to that comment.
   - Duplicate, too-long and limit cases are refused with their reason.
   - Several labels per comment; chips as in §3.
   - The filter keeps Previous / Next.
   - Roles follow §D.4, and controls are absent without permission.
10. **Drafts (UX-20).** A draft survives closing and reopening the conversation and assigning a label in it.
11. **Measured steps.** The step counts in §6 hold in automated tests: open/close 1, account 1, assign ≤ 3,
    create-and-apply ≤ 3, exact time 1, filter 1.

## 10. Open PO decisions (only those that change what gets built)

1. **Member names on published replies.** Wrenkind has no member display-name source, so "Requested in Wrenkind by
   …" can only say "a member of this workspace". Choose one:
   - keep it anonymous for now; or
   - approve a member display-name field (new personal data in tenancy, privacy review).
2. **Time as the details trigger.** The prototype opens Wrenkind's exact record from the time. Statusbrew uses the time
   as a link to the platform (SB-2). Choose one:
   - keep time → details and add "View on Instagram" to Details once permalinks are read; or
   - make the time the permalink and put details only under More.
3. **Approval of the phase-1 wording.** Moving the review line after the thread, the reply reason to Reply, and
   coverage to one line changes UX-22's presentation, but not its meaning. This needs the PO's explicit acceptance as
   a UX wording amendment, alongside the still-PROPOSED §B documents.
