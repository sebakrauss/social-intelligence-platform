# Comments redesign — UX2: layout comparison and Product Owner decisions

Step 7B-17V-UX2 · 2026-11-17 · status: **PROPOSED** (local prototype only; nothing here is approved product behavior)

Prototype: `http://localhost:3000/dev/ui-reference/comments-redesign` (`next dev` only). Prototype bar → **Layout**:
*Expandable list* (17V, default) or *Two panels*. All data is synthetic; every Facebook/Instagram action is simulated in
the tab's memory.

## 1. What changed in UX2

| Area | Before (17V-UX) | Now (UX2) |
|---|---|---|
| Comment actions | Reply · Hide · Labels · More | **Reply · Hide/Unhide · More** (labels inside More) |
| Icons | Shield for Hide | Eye-off / eye, bin, "no" sign, thumb, envelope (prototype-drawn; not in the kit yet) |
| Menu copy | API explanations (e.g. Instagram has no Like/Block; author-ID caveat for blocking) | Removed from menus; kept in "What's real and what's simulated" |
| Unavailable reasons | Developer wording ("hasn't been validated") | Outcome wording ("Not available yet for comments on ads."), shown only when pressed or in More |
| Labels | Summary line "Labels on comments here" + chips + row chips | Chips on their comment only (quieter); row chips only while collapsed; sidebar filter unchanged |
| Time | Header time also shown while open | Header time = *latest activity*, only while collapsed; each comment/reply keeps its time; exact times on demand |
| Review notice | "Not automatically reviewed yet" in every conversation | Once, under the list title |
| Collapse | "Close conversation" | "Collapse" (sr: "nothing about it changes") |
| Post context | One text line | Compact preview: tile in the post's shape (no media), kind, source said plainly (Organic / Paid / Organic and paid / Source not reported), context (Managed in the Instagram app / Posted by @…) |
| Platform notice | Banner for live / story ad / others' posts | In the preview; banners only for Monitor-only and connection repair |

Cost to note: reaching labels is now one step more (assign an existing label: 3 steps; create and assign: 4 — measured
in `tests/unit/ui/comments-redesign-dom.test.ts`).

## 2. Layout comparison

Measured in headless Chrome at 1440 × 900 (sidebar open), synthetic data:

| | Expandable list | Two panels |
|---|---|---|
| Width of the open conversation | 1088 px | 728 px (list 360 px beside it) |
| Width used by a comment's text | 681 px (72ch cap) → ~400 px empty on the right | fills the panel |
| List visible while reading | No (rows above/below scroll away) | Yes — next items stay in view |
| Moving to the next conversation | Previous / Next, or scroll | Previous / Next, or one click in the list |
| Long threads | Page scroll; sticky header | Panel scroll; list keeps its place |
| Tablet (834 px) and phone (390 px) | Same model as desktop | One panel at a time: list, then conversation with "Back to list" |
| Mental model | One page, everything inline | Inbox-style (list → reading pane), as Front, Zendesk, Meta Business Suite |
| Risk | Wasted width on wide screens; context lost in long lists | Narrower list rows (account name hidden, excerpt 2 lines); two scroll areas |

**Recommendation for the PO:** two panels on ≥ 1024 px, one panel at a time below. The expandable list stays in the
prototype until the PO decides; nothing in the product changes.

## 3. Future Intelligence (not implemented)

Three concepts, three places — never merged:

- **Priority** (future assessment, e.g. "needs attention first"): a slot at the *start* of the row's first line and a
  sort option ("Priority first" next to "Newest activity first"). Never a label, never a color on a person's label.
- **Classification** (future AI meaning, e.g. Complaint, Question): round tags beside the author (already shown as
  synthetic examples behind "Scenario → Assessments"). Protected meanings (complaints, accusations, commercial
  objections) keep "never auto-hidden" and the caution on a person's Hide/Delete.
- **Manual labels**: square, a person's choice, on one comment; filter in the sidebar. Labels are not urgency.

The global line under the list title becomes the place to say whether automatic assessment is on.

## 4. Future workflows (not built; no schema, permission or backend)

- **Status** (Open / Done / Snoozed): a control in the conversation header (two panels: the panel title row; list:
  the open row's header). "Collapse" never changes it.
- **Assignment**: an avatar slot at the end of the row's first line; "Assign…" in the conversation header, not in a
  comment's More (it belongs to the conversation).
- **Filtering**: the sidebar grows sections (Status, Assigned to me, Platform, Labels); below 1024 px the existing view
  select becomes a filter sheet. One active label filter at a time stays the 2.1 rule until decided otherwise.

## 5. Decisions for the Product Owner

1. Layout: two panels (≥ 1024 px) vs the expandable list.
2. Labels inside More (one extra step) vs a fourth visible action.
3. Row label chips while collapsed: keep (scanning, filtering) or remove (only on comments and in the sidebar).
4. "Latest activity" time in the collapsed header only, as proposed.
5. Source preview: tile shape without media now; whether to retrieve and show real thumbnails later (a data and
   privacy decision, not a UI one).
6. Platform contexts (live, story ad, others' posts) said in the preview instead of a banner.
7. Prototype glyphs (eye, bin, "no" sign, thumb, envelope) to be added to the icon kit.
8. Instagram: Like/Block not drawn (one reason in the capability reference) vs IA §18 "visible but unavailable".
9. Where status and assignment live (§4) before any workflow is designed.
10. Open from 17V-UX: Like permission (none exists; prototype follows `reply.public`), Responder delete/block grants,
    moderation on ad comments, private-reply permissions and what Wrenkind shows after one is sent.

## 6. UX3 — Light and Dark (2026-11-17)

- **Mechanism (unchanged product architecture):** the semantic tokens of `ui/foundations/tokens.css` (Manual de Marca
  v1.1), light by default, dark by system preference, and the existing `data-theme` override on `<html>`
  (`ui/foundations/theme.ts`). The prototype adds no palette and no theme provider: its **Theme** control (System /
  Light / Dark) sets that attribute only while the prototype is open, restores whatever was there before, and persists
  nothing. System stays the default, so the first render matches the server (no hydration mismatch, no flash).
- **Prototype review default:** two panels (the expandable list stays one control away). The product default is
  unchanged.
- **Contrast:** every text pair the prototype draws meets 4.5:1 and focus/selection graphics 3:1 in both themes
  (`tests/unit/ui/comments-redesign-model.test.ts`). Unavailable-but-pressable actions use the tertiary text with a
  lock (≥ 4.6:1), not the disabled grey.

Decisions for the PO / brand owner:

11. **Default theme for new users.** Today's policy (theme.ts): follow the system; no persisted override. Options:
    (a) keep System; (b) Light by default with a persisted manual choice; (c) Light by default, System only on request.
    Recommendation: **(b)** — Light as the reference look, a person's choice stored per user (needs a storage decision:
    profile setting vs cookie). Not changed in this gate.
12. **Electric Blue accents.** Brand v1.1 reserves blue for where a person decides, links and keyboard focus (enforced
    by `tests/architecture/brand-guards.test.ts`); primary buttons are black/white and selection is weight plus a
    primary-color bar. The prototype keeps that rule (blue only on focus and the "Details" link). More blue (selected
    row, primary buttons) would be a brand-manual change, not a theme change.
13. **Input boundaries.** `border.strong` on the canvas is 1.40:1 (light) and 1.82:1 (dark), under WCAG 1.4.11's 3:1
    for component boundaries; the product's Field primitive uses the same token. A design-system fix (e.g. inputs on
    `text.tertiary`) should be decided once for the product, not patched in the prototype.
14. **Elevation.** The manual draws depth as a surface step plus a 1px divider, never a shadow; menus and dialogs
    follow it. "Subtle elevation" with shadows would be a manual change.

## 7. UX4 — independent audit remediation (2026-11-17)

Fixed in the prototype (regression tests in `tests/unit/ui/comments-redesign-{model,dom}.test.ts`, block "UX4"):
H-1 every simulated operation is revalidated when it starts (`opAvailability`: the same resolver plus the action's
direction), and stale confirmations, composers, "Try again" and the labels editor are redrawn from the current state;
H-2 the two-panel conversation is keyed per conversation; M-1 Previous/Next keep focus in the panel; M-2 focus lands on
an existing control after Details, chip removal, confirming and settling; M-3 Enter acts only on an exact label name;
M-4 a conversation that leaves the filtered list is deselected with an announcement; M-5 disabled buttons take the
Button primitive's disabled look in both themes. Also: no false "label added" announcements, no autoFocus on the
simulated answers, Escape keeps the two-panel selection, and "Reset data" says what it resets.

Decisions for the PO (not implemented):

15. **Draft after a failed reply.** The product contract (`ui/inbox/reply-drafts.ts`) clears the draft once a request is
    accepted and restores it only when nothing was created (refused, blocked, signed out); an executor outcome after
    acceptance (Failed, Stopped) does not bring it back. The prototype follows that: the failed reply stays visible with
    its text, and the composer keeps a draft only while a start is refused. Restoring text after a Failed outcome would be
    a new rule.
16. **Public vs private confirmation.** Public reply: write → review → publish. Private reply: write → send, though it is
    the one-shot action (one per comment, 7 days). Aligning them (a review step for private replies) is recommended but is
    a messaging-flow decision.

Design-system and production-readiness issues (outside this prototype; not worked around here):

- **Input-border contrast:** `border.strong` is under 3:1 on the canvas in both themes (WCAG 1.4.11); shared with the
  Field primitive. Fix once in the tokens/primitives.
- **Theme override:** the prototype reaches `<html>` through an element's `ownerDocument` (the client-module guard bans
  `document`). A product theme switch needs an approved theme module (and guard allowance), and a persisted preference
  would conflict with the prototype's restore-on-leave behaviour; decide before shipping any switch.
- **Component duplication:** the prototype re-implements composer, chips, menus and panels next to `ui/inbox`; moving
  the approved pieces into shared primitives is a production task, not a prototype one.
- **Tablet touch targets:** below 1024 px and above 639 px, toolbar and menu targets are 32–36 px (44 px only on phones).
- **Start-time guard coverage:** the UI redraws stale panels from the current state, so the DOM tests prove the
  render-time guard; the start-time guard (`opAvailability` inside `start()`) is proven by the model tests and stays as
  defence in depth.
