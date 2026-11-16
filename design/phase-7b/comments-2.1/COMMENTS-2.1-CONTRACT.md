# Comments 2.1 — Product contract, proposed amendments and implementation contract (Step 7B-17R)

| Field | Value |
|---|---|
| Date | 2026-11-16 |
| Step | 7B-17R — Comments 2.1: product contract and first (visual) implementation slice |
| Code baseline | `main` = `origin/main` = `6ae42213890c0b792703a1093ddb6ea65a1573cd` (CI run 43934459243, success); DEV web `dpl_FrdFaGAeQWnN4zTJ8RteGsZSKG88`; DEV database 33 migrations (latest 0033) |
| Starting point | The Step 7B-17Q proposal (Inbox 2.1), superseded where the product owner decided otherwise — above all the name: the module is **Comments**, not "Inbox" |
| Status | Three separate statuses, never conflated: **A** product direction — APPROVED by the product owner (2026-11-16); **B** amended wording of the governing documents — PROPOSED, pending formal approval; **C** implementation evidence — the visual slice, built locally in this step |

This file is not a source of truth. The governing documents are the ones under `docs/` and they are **unchanged** by
this step: their approved versions (PD 1.3, IA 1.1, UX 1.2, Model 1.1, TA 1.3) and `CLAUDE.md` §2 still hold. If this
file and a governing document disagree, the governing document wins until the amendments in §B are formally approved.

---

## A. Approved product direction — status: APPROVED (2026-11-16)

Source: an explicit product-owner decision communicated through the technical lead in the Step 7B-17R mandate. No
signature, external document, approval identifier or time of day is recorded: none was provided. The approval covers
the product direction below and authorizes recording it and implementing the first visual slice locally. It does **not**
approve amended document wording (§B), and it authorizes no migration, deployment, publication or external change.

| # | Decision |
|---|---|
| 1 | Rename the user-facing Inbox module to **Comments / Comentarios**. |
| 2 | Introduce **manual labels** assigned to individual comments. |
| 3 | Allow **multiple** manual labels per comment. |
| 4 | Filter **conversations** by the labels assigned to their comments. |
| 5 | **One** active label filter at a time in v1. |
| 6 | **No** prepopulated labels. |
| 7 | Show dates and times in the **browser's local time zone**. |
| 8 | **Differentiated permissions** for Owner, Admin, Manager, Agent and Analyst (§D.4). |
| 9 | Keep manual organizational labels **separate from AI classification**. |
| 10 | **Simplify** repetitive technical text in Focus. |
| 11 | **Preserve** the existing Focus inline experience (UX-19). |

### A.1 Terminology

| Concept | English | Spanish | Notes |
|---|---|---|---|
| The module (today's Inbox) | Comments | Comentarios | User-facing only. Routes (`/workspaces/[workspaceId]/inbox`), message keys (`inbox.*`, `shell.nav.inbox`), modules and database objects keep their technical names. |
| Its default section | All comments | Todos los comentarios | |
| The organization group | Labels | Etiquetas | Not built yet (§D); no empty or inactive group is shown before it works. |
| Label management | Manage labels | Administrar etiquetas | |
| The inline conversation presentation | Focus | Focus | Internal name (UX-19). |
| Private messaging | Messages | Mensajes | A possible **future** module. Not approved, not implemented: no navigation item, placeholder or DM surface exists (S9; PD C-03/D-36). |
| Internal term for a label | `manual_label` | — | Distinct from AI classification labels, sentiment, topics, moderation decisions, Brand/Market workspace labels and human corrections of AI classifications. |

The English names are in the development reference catalog (`platform/i18n/catalogs/development-reference.ts`). The
Spanish names are recorded here for the Spanish catalog; that catalog does not exist yet, and shipping it is the
open interface-language decision **PD OQ-20** (§E).

---

## B. Proposed amendments to the governing documents — status: PROPOSED (pending formal approval)

Nothing below has been written into `docs/`. Each block is the exact wording proposed for the next version of its
document; on approval, the version number, date, status and approval record of that document are updated following
its existing conventions (the v1.2/v1.3 records are the model). Until then the approved versions hold.

### B.1 Product Definition (proposed v1.4)

New decision row after D-52:

> | D-53 | **Manual labels are organizational metadata (Comments 2.1).** A workspace may define its own **manual labels**
> (name; optional color from the design-token palette) and people with the right permission assign them to
> individual comments. A comment may carry several. Manual labels are written only by people, carry no meaning the
> product relies on and never feed classification, priority, risk, protection, moderation, automation, AI tasks or
> provider actions: a label such as "Possible hate speech" is text a person typed, not an assessment. They never move,
> duplicate or delete a comment; deleting a label removes its assignments only. No labels are preloaded. Automatic
> labelling is a separate future capability that needs its own product decision. | 7B-17R | §13, §14 |

Note under §16 (languages): *"The module that holds the public comments is named **Comments** (Spanish:
**Comentarios**). 'Messages' is reserved for a possible future private-messaging module, which is not part of the
product (C-03, D-36)."*

### B.2 Information Architecture (proposed v1.2)

§7.3, Inbox hierarchy — the destination is named **Comments**; under it, after the system views:

> ```
> ├── Labels (Comments 2.1) .. workspace manual labels, user-created; one filter at a time;
> │                            "New label" and "Manage labels" for roles that manage labels
> ```

§4 (navigation): *"The Inbox destination is presented as **Comments** (Spanish: Comentarios); its default section is
**All comments**. No 'Messages' destination exists."*

§18 (role visibility), new row: *"View manual labels and filter by them: every role that reads the operational surface.
Assign or remove: roles with `workflow.internal`. Create, rename, delete: Owner, Admin, Manager (`labels.manage`).
Client guest: none."*

Glossary note: *"**Manual label** — organizational metadata a person puts on a comment (Comments 2.1). Not a
classification label (§7.5), not a topic, not a Brand/Market label."*

### B.3 Core UX Flows (proposed v1.3)

New §8.11 and two rows in §28.2:

> | **UX-21** | **Manual labels (Comments 2.1).** Labels are created per workspace and assigned to individual comments
> from Focus; a comment may carry several. A label in the Comments sidebar filters the list to the conversations
> that contain at least one comment with it — one label at a time; the filter is visible, survives pagination and
> Previous / Next / Close, and is cleared by switching workspaces. A deleted or inaccessible label falls back to all
> comments without revealing whether it ever existed. Labels never act: no hide, delete, priority change, publication
> or AI action follows from a label. | **APPROVED direction (7B-17R); wording PROPOSED** | §8.11 |
> | **UX-22** | **Quieter Focus (Comments 2.1).** Times read in the browser's local time zone (UTC when the page runs
> without JavaScript, said once); the automated-review status is one line per open conversation ("Not automatically
> reviewed yet: safety and priority haven't been assessed."); Wrenkind's own "not available yet" for replying is one
> sentence per conversation, while a limitation of the workspace (Monitor-only), account, connection or platform keeps
> its label and its own words; an unknown organic/paid source is stated in the conversation's details, not as a chip on
> every row; the thread's heading is for assistive technology only. UX-19 and UX-20 are unchanged. | **APPROVED
> direction (7B-17R); wording PROPOSED** | §8.10, §8.11 |

§8.10.A note: *"The quoted Phase 1 sentence 'No automated review has run…' is presented, from Comments 2.1, as the
shorter UX-22 line; its meaning is unchanged."*

### B.4 Intelligence Data Model (proposed v1.2)

New object in §31 (operational workflow model) and in the object index:

> | Manual Label | Workspace-defined organizational label | H (configuration) | User | Yes (rename, color, delete) | Manual Label Assignment | Comments sidebar, Focus | — |
> | Manual Label Assignment | Manual Label ⇄ Interaction (comment) | Workflow (human) | User | Add / remove | Interaction, Conversation | Filters, Focus | — |

Rule: *"A Manual Label Assignment is human workflow metadata. It is **not** a Classification Assessment, an Accepted
Interpretation, a Topic Assignment or a human correction (outside the M-05 precedence chain), and no interpretation,
priority, protection or automation decision reads it. Assignments and definition changes are audited (§40)."*

### B.5 Technical Architecture (proposed v1.4)

- §7.1: the **workflow** module (L3) owns manual labels and their assignments.
- §10.3 matrix: new permission **`labels.manage`** (create, rename, delete manual labels) — Owner ✓, Admin ✓,
  Manager ✓, Agent —, Analyst —, Client guest —. Assigning and removing stays under `workflow.internal`
  ("correct labels" in today's row is read as classification corrections; manual-label assignment is added to it).
- §38.11 data classes: `workflow.manual_labels` (configuration, class H: name and color are customer text — never
  logged) and `workflow.manual_label_assignments` (workflow; identifiers only).
- §26 / Appendix A: manual labels are outside every mutation, automation and AI path (guard-enforced, §D.8).

---

## C. Implementation evidence — the visual slice (this step, local)

Built and tested locally in Step 7B-17R; reviewed by no one yet; not pushed, not deployed.

| Area | Change |
|---|---|
| Naming | Navigation rail "Comments"; sidebar "Comments" › "All comments"; page heading "Comments"; way back "All comments"; access and unavailable messages say "Comments". No Messages item. Routes and keys unchanged. |
| Automated-review line | One line per open conversation: "Not automatically reviewed yet: safety and priority haven't been assessed." |
| Thread heading | "Comments and replies" is screen-reader-only (still labels the thread). |
| Times | Every time is read in the browser's zone (`ui/time/local-time.tsx`): short "13 NOV 22:30", exact "13 NOV 2026 · 22:30 GMT-3". The server HTML keeps the UTC reading (no-JavaScript fallback, hydration-safe); `<time dateTime>` keeps the ISO instant; "Times in UTC" is said once, inside `<noscript>`. Screen-reader-only disclosure names that embed a time (`inbox.thread.entry_label`) and the validation-reply notice keep the explicit UTC reading. |
| Reply availability | Wrenkind's own "not available yet": one sentence, "Replying from Wrenkind isn't generally available yet." ("generally": an exceptional validation reply may already be shown as Sent). Monitor-only, paused, connection and inactive-account reasons keep the "Reply not available" label and their words. |
| Unknown source | No "Organic or paid: not known" chip on list rows; still stated in the conversation's details. |
| Context note | "Post details aren't available yet." |

---

## D. Manual labels — implementation contract (next gate)

Nothing in this section is built. Migration 0034 is not authored.

### D.1 Ownership and meaning

- Owner module: **workflow** (TA §7.1, L3). It does not exist in code yet; it is created under `modules/workflow`.
- A manual label never automatically hides, deletes, changes moderation state, priority or risk, triggers a
  publication or an AI action, or authorizes a provider operation.

### D.2 Granularity

- Assignment: one comment interaction (`interactions.interactions`), any number of labels per comment.
- Filter: a conversation is listed under a label when **at least one** of its comments carries it.
- Assigning never moves or duplicates a comment; deleting a label deletes its assignments only.

### D.3 Constraints (initial; revisable by a later product decision)

| Rule | Value |
|---|---|
| Preloaded labels | None |
| Active filters | One at a time |
| Name | 1–40 characters after trimming; unique per workspace, case-insensitive |
| Labels per workspace | At most 50 |
| Color | Optional; one of a fixed set of design-token names — never free CSS or hex |
| Structure | Flat: no nesting, no folders |
| Automation | None: no automatic or AI labelling, no rules |
| Bulk | No bulk labelling in v1 |

### D.4 Permissions (mapped to the existing model)

| Role (internal) | View and filter | Assign / remove | Create / rename / delete |
|---|---|---|---|
| Owner (`OWNER`) | `workspace.read_operational` ✓ | `workflow.internal` ✓ | `labels.manage` ✓ (new) |
| Admin (`ADMIN`) | ✓ | ✓ | ✓ (new) |
| Manager (`MANAGER`) | ✓ | ✓ | ✓ (new) |
| Agent (`RESPONDER`) | ✓ | ✓ | — |
| Analyst (`ANALYST_VIEWER`) | ✓ | — | — |
| Client guest (`CLIENT_GUEST`) | — (no projection; RLS denies) | — | — |

Minimum amendment: one new permission key `labels.manage` in `domain/access/permission-keys.ts` and in the
Owner/Admin/Manager common set of `platform/permissions/catalog.ts` (TA §10.3, §B.5). Nothing is removed from any role.
Monitor-only allows every label operation (internal workflow, no provider effect).

### D.5 Database contract (migration 0034, to be authored later)

- Schema `workflow`; two tables, each with `workspace_id`, forced RLS, deny by default, explicit grants to the web
  runtime role only, no `anon`/`authenticated`/worker/system privileges, no Supabase default privileges.
- `workflow.manual_labels`: id, workspace_id, name, name key (normalized for case-insensitive uniqueness), color
  token (nullable, checked against the fixed set), created_by, created_at, updated_at. Unique (workspace_id, name key).
  The 50-per-workspace limit is enforced in the command inside the same transaction (count under a row lock on the
  workspace's label set).
- `workflow.manual_label_assignments`: workspace_id, label_id, interaction_id, conversation_id, assigned_by,
  assigned_at. Primary key (workspace_id, label_id, interaction_id). Composite foreign keys including workspace_id to
  the label (on delete cascade), to the interaction and to the conversation (R5: a cross-workspace reference fails
  exactly like a missing one). An integrity rule (trigger or check through a reviewed function) that the interaction
  belongs to that conversation; any such function follows R4a (`SET search_path = pg_catalog, pg_temp`,
  schema-qualified names).
- Indexes: (workspace_id, label_id, conversation_id) for the filter and the counts; (workspace_id, interaction_id) for
  a thread's labels.
- Introspection, T-01/T-11 isolation tests and the R4a guard extended to the new objects; T-26 stays green.

### D.6 Commands and reads (action pipeline)

| Name | Permission | Effect |
|---|---|---|
| `workflow.manual_label.create` | `labels.manage` | New label; duplicate name, empty, too long, bad color, 50 reached → refused with a closed reason |
| `workflow.manual_label.rename` | `labels.manage` | Name and/or color |
| `workflow.manual_label.delete` | `labels.manage` | Label and its assignments; comments untouched |
| `workflow.manual_label.assign` | `workflow.internal` | Idempotent; the comment must belong to the workspace |
| `workflow.manual_label.unassign` | `workflow.internal` | Idempotent |
| `inbox.labels.list` (read) | `workspace.read_operational` | Labels with their conversation counts (one grouped query; "99+" above 99) |
| `inbox.conversations.list` (read, extended) | `workspace.read_operational` | Optional `labelId`: existence filter, same activity ordering and cursor |
| `inbox.conversation.view` (read, extended) | `workspace.read_operational` | Each comment's labels |

Every write runs through the pipeline (identity, live membership, permission, one workspace per transaction) and
writes its audit event in the same transaction (identifiers only — never a label name or comment text). Server
actions return closed states; nothing optimistic.

### D.7 Interface

- Sidebar: Comments › All comments · Labels (collapsible native `<details>`) › each label with its count · New label ·
  Manage labels (the last two only with `labels.manage`). In-app links (AppLink), never prefetched.
- Filter: `?label=<uuid>` on the Comments route; pagination, Previous / Next and Close keep it; switching workspace
  drops it; an unknown or foreign label shows all comments with a neutral notice ("This label isn't available.").
- Focus: on each comment, its labels (up to 3 chips, then "+N") and, with `workflow.internal`, a "Labels" control
  (native form, checkboxes, server action, focus returned to the control). List rows: up to 2 chips, then "+N".
- Small screens: a "Labels" menu above the list with the same entries and the active filter as a removable chip.
- Accessibility: named navigation landmark, real lists, `aria-current` on the selected label, labelled checkboxes,
  44 px targets, color never the only signal.
- Visual separation: manual labels are neutral chips with their name; future AI assessments get their own component
  and "Why it's here", never these chips.

### D.8 Tests and acceptance

- Isolation (T-01, T-11), introspection, R4a guard; T-26 green.
- Permissions per role (§D.4), guest denied by URL; controls absent without permission and the server refuses anyway.
- Domain rules (§D.3), idempotent assign/unassign, delete keeps comments.
- Filter: stable pagination; Previous / Next / Close keep the label; deleted / foreign label in the URL.
- Architecture guard: `classification`, `moderation`, `automation`, `mutations`, `ai`, `jobs` and `integrations` never
  import or query the label tables or commands.
- Monitor-only: label operations work; provider actions stay blocked.
- UX-19 inline Focus and UX-20 drafts: a draft survives assigning a label in the same conversation.
- Performance: no extra query on a conversation-to-conversation move beyond the thread's labels; sidebar counts are
  read by the layout, which client navigation does not re-render (Step 7B-17K/17P).

---

## E. Decisions still open for the product owner

1. **Spanish interface (PD OQ-20).** The Spanish names are recorded (§A.1), but the product has one development
   reference catalog (English) and no locale selection. Shipping "Comentarios" needs the interface-language decision
   and a complete Spanish catalog.
2. **Formal approval of the amended wording** in §B (PD 1.4, IA 1.2, UX 1.3, Model 1.2, TA 1.4), before or together
   with the manual-label gate.
3. **"generally" in the reply line.** Implemented as "Replying from Wrenkind isn't generally available yet." (instead of
   the suggested "isn't available yet") so it does not contradict an exceptional validation reply already shown as
   Sent. Confirm or replace.
