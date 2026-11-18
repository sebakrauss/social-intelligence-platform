# Comments UX-04 — decision register (development-prototype hypotheses)

Step COMMENTS UX-04 · 2026-11-17 · amended in UX-05-FIX and UX-05-FINALFIX (2026-11-18) after the independent audits
(UX-05 and UX-05-VERIFY: CONDITIONAL PASS) · status: **PROPOSED**. Nothing here is approved product behaviour, except where a row says the Product Owner
approved it.

The interactive prototype at `/dev/ui-reference/comments-redesign` (`next dev` only; synthetic data; local React
state) implements the UX-03.1 direction that the Product Owner reviewed. Several of its behaviours differ from rules in
the approved documents. They are implemented **only as prototype hypotheses** so they can be evaluated. The approved
documents are unchanged. Each row needs explicit Product Owner approval (and, where noted, a governance amendment)
before any production integration.

The rules live in `app/dev/ui-reference/comments-redesign/model.ts` (section "UX-04"). They are tested in
`tests/unit/ui/comments-redesign-workflow.test.ts` and `tests/unit/ui/comments-redesign-dom.test.ts`.

| # | Topic | Current approved rule | Prototype behaviour (hypothesis) | Conflict | Needs before production |
|---|---|---|---|---|---|
| H-1 | Done after a reply | IA §8 status table, "Automatic status changes": Auto-Done after a successful brand reply when nothing else needs handling; Auto-Done "Replied on platform" for a native reply (CONFIRMED 0C.1, core UX flows UX-04). | A reply never closes a conversation. A confirmed reply clears its attention reason; a nudge offers **Mark done · Replied publicly/privately** or **Keep open**. Auto-reopen is kept: a new audience reply reopens a Done conversation, recorded as Wrenkind's change. | Direct conflict with a CONFIRMED rule. | PO decision; IA §8 and UX amendment if adopted. |
| H-2 | Needs attention as a view, and its triggers | IA §8: the default Inbox view is **Priority** (needs Intelligence). Home has "Needs attention now". Thresholds depend on PD OQ-16 / OQ-25 (OPEN). | Default view **Needs attention**, a subset of Open with exactly one reason, in this order: reply not confirmed (Checking / Failed / Stopped), account needs reconnecting, the audience wrote again after the brand's latest reply, waiting beyond the response target. A fresh unanswered comment inside the target is Open, not attention. Labels, Urgent and AI never create attention. | New view, and a default that differs from the IA. The trigger set resolves part of OQ-16 / OQ-25 informally. | PO decision; OQ-16 / OQ-25 resolution; IA §8 amendment. |
| H-3 | Response target | None decided (OQ-16 / OQ-25 OPEN). | A **synthetic test value**: 4 h by default, switchable to 1 h or 8 h in the prototype bar. No business hours. Not a product SLA. | None (an open item stays open). | Product decision on targets, per workspace or plan. |
| H-4 | Urgent | IA: priority is computed ("Why it's here", never a score). Escalate exists. There is no manual urgency. | **Urgent** is a person's flag (who and when recorded). It is separate from **Escalate** (a hand-off, with destination and note). Done clears Urgent and closes an open escalation; the record of both is kept. Urgent orders first within Needs attention but never creates attention. No AI P1–P3 is shown. | New concept next to the future AI priority. | PO decision; IA amendment defining how a person's Urgent relates to future priority (proposal: the person wins). |
| H-5 | Selection that left the list | Not specified. | The selected conversation keeps its place while selected, even after an action removed it from the view or filter. It leaves when the selection moves (Previous / Next, a row, Back) and a short note says where it went, with **Show**. A view, filter, search or sort change recomputes the list; a selection that no longer fits is cleared and announced. | Replaces the UX4 M-4 behaviour ("removing the last matching label clears the selection at once"), as the UX-03.1 A2 requirement asks. | PO confirmation. |
| H-6 | Labels vs Signals | IA §21.1: the user-facing word "Labels" names the AI classification (Type, Topic, Risk, Reply needed). | **Labels** are the manual, workspace-defined tags. **Signals** names the future Intelligence classification (described in Settings › Intelligence only). | Vocabulary collision. | PO decision; IA §21.1 amendment. |
| H-7 | Hiding actions a platform never supports | IA §18 rule 3, and the IA v1.1 change log: platform limits are "visible but unavailable (never hidden)". | Instagram **Like** and **Block** are not drawn (never supported). An action the platform supports but not here (live video, story ad, someone else's post, a closed private-reply window, Monitor-only, a connection to repair) stays visible but unavailable, with one reason. "Open on" and "Copy link" are shown unavailable: the synthetic data has no links. | Direct conflict with a CONFIRMED rule for the never-supported case. | PO decision; IA §18 amendment if adopted. |
| H-8 | Who manages labels | `platform/permissions/catalog.ts` has no label permission. Labels are COMMENTS-2.1 §D.3 / §D.4 (prototype contract). | Proposed `labels.manage` (Owner, Admin, Manager) for create, rename, recolor and delete. Assigning an existing label is `workflow.internal` (Agent included). Creating is a separate step from assigning, says it is workspace-wide, and is never shown to a role without the permission. | New permission. | PO decision; permission catalogue change (a separate, authorized step). |
| H-9 | Label markers: shape and color | **APPROVED (UX-06, 2026-11-18): Manual de Marca v1.1 Amendment 2** (`design/brand/MANUAL-DE-MARCA-v1.1-AMENDMENT-2.md`). | Implemented in UX-06-IMPLEMENT. One compact solid tag everywhere a label appears. Gray (`label.gray` = Neutral 500) is the default; a workspace label may carry Teal, Plum, Magenta or Olive, drawn through the `--wk-label-*` theme tokens from a palette identifier (never a color value). The color belongs to the label: changing it, or **Reset to gray**, changes every appearance at once; it never changes lists, counts, filters or attention. Brown was rejected and is refused. Only label managers (the proposed `labels.manage`) choose colors. | None. | Done (approved). |
| H-10 | Intelligence placement | IA §8 lists Priority, Needs review and Hidden automatically among the views. | While Intelligence is not active, nothing about it appears in the Comments navigation. **Settings › Intelligence** says "Not active" and describes Signals, Needs review, Priority and protection as future capabilities. No AI output, classification or priority is shown anywhere. The 7B-17V "synthetic assessments" control was removed. | Views from the IA are absent until the capability exists. | PO confirmation. |
| H-11 | Private reply review | UX2 decision 16 (open): public reply has a review step, private reply did not. | Private reply: write → **Review private reply** → **Simulate sending** (one per comment, within 7 days). The record says further messages continue on the platform, never in Wrenkind. | Resolves open decision 16 in the prototype. | PO decision. |
| H-12 | Destructive retry | Not specified. | A failed Delete or Block offers **Try again…**, which opens the same confirmation again. It is never a one-click repeat. Replies are never retried automatically. | None. | PO confirmation. |
| H-13 | Done resolutions | IA §8: replied publicly, replied privately, replied on platform, no reply needed, moderated, reviewed (Monitor-only), escalation closed. | The same list without "escalation closed" (Done closes an open escalation and records it). "Reviewed" is offered in Monitor-only only. Since UX-05, "Replied publicly" / "Replied privately" are listed but unavailable, with the reason, until a reply of that kind is confirmed Sent (H-19). | Minor. | PO confirmation. |

## Operational assumptions made explicit in UX-05-FIX (audit finding M-3)

The independent audit found that several rules the prototype applies were not written down. They are recorded here as
hypotheses. Each separates the approved rule (if any), what the prototype does, and what needs the Product Owner.

| # | Topic | Existing approved production rule | Proposed development-prototype behaviour | Product Owner approval required |
|---|---|---|---|---|
| H-14 | Effect of hiding, deleting or removal on attention | None. Attention triggers depend on PD OQ-16 / OQ-25 (OPEN). Complaint protection always wins (S2, S3); individual human moderation stays available (CLAUDE.md §7). | Only audience comments still **present** on the platform count for "Waiting" and "New reply". Hiding the only unanswered comment (or a newer reply) therefore removes that reason, and the conversation leaves Needs attention (the row says "No longer in Needs attention", never "Reply sent"). Removed and deleted comments are also left out of search. Hiding or deleting **never** clears an unresolved reply (H-20). | Whether a person's Hide may take a conversation out of Needs attention. Risk to weigh: a legitimate complaint hidden by a person stops asking for an answer. |
| H-15 | Private replies as brand responses | S9: a private reply never creates a DM inbox, thread or conversation. Whether it "answers" a public comment is not decided. | A private reply **confirmed Sent** counts as the brand's answer, like a public one: it clears "Waiting" and "New reply", and makes "Replied privately" available as a resolution. A private reply that is Sending, Checking, Failed or Stopped counts as nothing. Nothing about later messages is shown (they continue on the platform). | Whether a private reply resolves a public comment's attention. |
| H-16 | Conversation-level vs comment-level attention | IA: a conversation has one status and one "Why it's here". Per-comment attention is not specified. | Attention is **per conversation**, one reason shown. "New reply" = any present audience comment newer than the brand's latest answer anywhere in the conversation; "Waiting" is measured from the latest present audience comment. Unresolved replies are tracked **per reply identity** (kind + the exact comment answered — corrected in UX-05-FINALFIX, R-1), so one comment's reply never resolves another comment's failure, even under the same Instagram top-level comment and from the same person. Known gap: in a thread with several people, answering one clears "New reply" for another who wrote earlier. | Whether attention should become per comment (or per author) in a thread. |
| H-17 | Ad-context response availability | Capability is never inferred; unknown = unavailable (PD C-07, OQ-18/19; CLAUDE.md §8). 7B-17V-META: moderation of ad comments is not documented explicitly; Wrenkind implements only the Instagram public reply, disabled. | On a post that is **paid**, an **ad that never ran as a Page post**, a **story ad** or reported as an **Ad**: public reply, private reply, Hide, Delete, Like and Block are unavailable with one reason ("Replying to comments on ads isn't validated in Wrenkind yet." / "Not available yet for comments on ads."); the post card says "Ad · replies and moderation not validated yet". Reading, labels and conversation management stay available. A post reported as **Organic and paid** (a boosted Page post) is treated as the Page's own post and keeps its simulated actions — an open question. | API validation per action and ad surface (OQ-18/19, TA-Q-22); PO decision on boosted posts. |
| H-18 | Permission behind Facebook Like | `platform/permissions/catalog.ts` has no Like permission; Like is not in Wrenkind's vocabulary. 7B-17V-META: Facebook Like needs a Page token with the content-creation task. | Like / Unlike (Facebook only; Instagram has none) follows the role's **public reply** permission (`reply.public`): Owner, Admin, Manager and Agent; never Analyst or a guest. | Whether Like is offered at all, and under which permission (catalogue change in a separate, authorized step). |
| H-19 | Done with unresolved delivery | IA §8 auto-Done (see H-1). TA §26 / R6: an ambiguous reply is never blindly retried; no optimistic UI (Sending → Sent / Failed / Checking). | **Done is refused** while any simulated operation on the conversation is **Sending or Checking** (whether it reached the platform isn't known); the Mark done panel says why and offers nothing, and the "Reply sent" nudge is not shown. It is re-decided at the moment a choice is pressed. After a **Failed** or **Stopped** reply, Done is allowed; "Replied publicly" / "Replied privately" need a reply of that kind **confirmed Sent**, otherwise they are listed as unavailable with the reason. "Replied on the platform" is the person's statement about something done outside Wrenkind: it is recorded as said and never marks any reply as delivered. A failure stays in the record and is "Needs attention" again if the conversation is reopened. | PO decision (together with H-1). |
| H-20 | Which outgoing replies keep a conversation in Needs attention | None at conversation level; R6 reconciliation decides an unknown outcome. | **Every** unresolved reply counts, not only the latest: each one Checking (until its own reconciliation answers Sent or Failed) and each Failed or Stopped reply that no later reply **with the same identity** (H-16) has replaced with a confirmed Sent. A new reply Sending never hides an earlier failure. One reply is named ("Reply not confirmed", "Reply failed", "Reply stopped"; the most uncertain first); several say "N replies not confirmed"; the oldest dates it. Precedence is unchanged: unresolved reply → connection → new reply → waiting. | PO confirmation. |

## R-1 (UX-05-VERIFY) — a confirmed technical defect, fixed in UX-05-FINALFIX

Not a product rule: a correction of H-20. An outgoing reply's identity was its kind + the comment the platform attaches
it to + the person answered. On Instagram every reply to a nested comment attaches to the top-level comment, so two
replies to two different comments by the **same person** under the same top level had the same identity, and a Sent
reply to one resolved a Failed reply to the other. The operation now keeps both: `commentId` (where the platform
receives it — unchanged, the top level on Instagram) and `targetId` (the exact comment a person answered). The identity
is the kind + `targetId`. On Facebook, and for every action addressed to the comment itself, the two are the same.

## Product Owner-recommended directions (UX-05-FINALFIX) — proposals awaiting formal production approval

Recorded as the PO's recommended direction; none is an approved production rule, and none changes a locked document.
Where the prototype does not follow a direction yet, that is said explicitly: aligning it is a separate, authorized
change, not part of this remediation.

| Direction | Relates to | What the prototype does today |
|---|---|---|
| Hiding a comment does not by itself mean an unresolved complaint has been addressed. | H-14 | **Differs.** Hiding the only unanswered comment removes "Waiting" / "New reply" (H-14). Not changed here. |
| Attention aggregates unresolved comment-level and operation-level reasons. | H-16, H-20 | **Partly.** Operation-level reasons are aggregated per exact comment (H-20, R-1). Comment-level reasons are still per conversation (H-16); one reason is shown. |
| A mixed organic / paid context gets conservative capability handling until Meta's documentation is validated. | H-17 | **Differs.** "Organic and paid" posts are treated as the Page's own post and keep their simulated actions. Not changed here. |
| A Failed or Stopped outgoing operation is never silently represented as resolved. | H-19, H-20 | **Follows.** It stays "Needs attention" until a confirmed Sent of the same reply; Done after it never claims a reply, and reopening shows it again. No "Reply sent" while a newer reply is Sending or unresolved. |
| Auto-Done is a disputed prior rule (IA §8, CONFIRMED); the current direction favors explicit human closure. | H-1 | **Follows the direction** (no automatic Done), as a hypothesis. The IA rule is unchanged until the PO amends it. |
| Labels use organizational colors, independent of priority and of Intelligence. | H-6, H-9 | **Follows** (gray only; colors wait for the brand amendment and tokens). |

## Label marker palette (H-9) — APPROVED (Manual de Marca v1.1 Amendment 2, 2026-11-18)

| Marker | Light | Dark | Status |
|---|---|---|---|
| Gray (default; `label.gray` = Neutral 500) | #7A7A7A | #7A7A7A | Approved |
| Teal | #0F7A7A | #3DB3B0 | Approved |
| Plum | #9A3FA8 | #CF8ADB | Approved |
| Magenta | #B53A6E | #E8799F | Approved |
| Olive | #5F6E1E | #A9B65C | Approved |
| Brown (UX-03) | #7E5A44 | #B8927A | **Rejected** — not selectable, refused by the model |

The UX-03 dark gray proposal (#8A8A8A, equal to Dark `text.tertiary`) was not adopted: gray is Neutral 500 in both
themes. Measured contrast, rules and enforcement: `design/brand/MANUAL-DE-MARCA-v1.1-AMENDMENT-2.md`. Implemented in
UX-06-IMPLEMENT through the `--wk-label-*` tokens (`ui/foundations/tokens.ts` / `tokens.css`), the prototype's
`.marker[data-marker]` rules, and the brand guards. Until UX-06 the colors were a proposal (UX-03 → UX-05-FINALFIX):
markers were drawn gray and the other colors were not selectable.

## Still out of scope (unchanged)

- No backend, schema, RLS, permission, infrastructure or Meta change. Every platform action is simulated in the tab.
- Workflow, attention, assignment, notes and label management have no backend. They exist in the prototype only.
- Only the Instagram public reply is built in Wrenkind, and it is turned off by default. Replies and moderation on ad
  comments (H-17) and private-reply permissions remain unvalidated.

## Validation items for the Product Owner (not assumed approved)

The PO approved the UX-03.1 desktop direction (1440 px). Approval is still needed for the tablet (834 px) and phone
(390 px) layouts and for Dark mode: one panel at a time with Back; on a phone, the conversation's management in a bottom
sheet and the filters in a full-screen sheet; the Details drawer full-screen below 1024 px.
