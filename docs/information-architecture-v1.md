# Information Architecture v1 — Social Conversation Intelligence Platform

| Field | Value |
|---|---|
| Document | Information Architecture v1 |
| Phase | 0B — Information Architecture |
| Version | 1.1 (Phase 0C.1 decision lock) |
| Date | 2026-10-03 |
| Status | **Approved.** v1.0 approved on 2026-10-03 (Phase 0B.1). v1.1 records the IA decisions locked in Phase 0C.1. |
| Source of truth | `docs/product-definition-v1.md` v1.3 (Phase 0A, 0A.1, 0B.2 and 0E.1 alignment; approved) |
| Scope | How the product is organized from the user's perspective. **Not** visual design, wireframes, components, data schema, technical architecture or implementation. |

### Approval record

| Date | Phase | Decision |
|---|---|---|
| 2026-10-03 | 0B | Information Architecture v1.0 drafted. |
| 2026-10-03 | 0B.1 | Product owner locked **IA-05** (client guest visibility) and **IA-11** (Monitor-only workspace ships in the MVP) and approved Information Architecture v1.0. Both decisions are propagated through the document. The other IA decisions in §23 remain open as recommendations; none blocks Phase 0C. |
| 2026-10-03 | 0B.2 | Cross-document alignment: the source of truth is now Product Definition v1.2, which records Monitor-only as confirmed product decision **D-49**. IA-11 is the IA expression of D-49. No IA behavior changed. Version 1.0 kept. |
| 2026-10-03 | 0C.1 | Product owner locked **IA-01, IA-02, IA-03, IA-04, IA-09, IA-10, IA-13, IA-15 and IA-16**, plus the related UX decisions on application entry, workspace creation mode, native-reply auto-Done, human bulk hide and the default escalation contact (recorded in `docs/core-ux-flows-v1.md` §28). Version bumped to **1.1**. Platform-capability limits are now consistently *visible but unavailable* (never hidden). IA-05 and IA-11 are unchanged. IA-06, IA-07, IA-08, IA-12 and IA-14 remain open. |
| 2026-10-03 | 0E.1 | Cross-document alignment: the source of truth is now Product Definition v1.3 (D-50 to D-52, confirmed during Technical Architecture). Metadata only: no IA behavior changed, no IA decision reopened, version 1.1 kept. Flow-level detail for D-51 and D-52 lives in `docs/core-ux-flows-v1.md` v1.1. |

---

## 0. How to read this document

### 0.1 Relationship to the Product Definition

This document organizes the product. It does not change it.

- Every product capability referenced here comes from the Product Definition (PD). Section references like "PD §9.2-E" or decision IDs like "D-46" point there.
- When this document relies on a PD item, it keeps that item's status: **(PD: CONFIRMED)**, **(PD: PROPOSED)**, **(PD: VALIDATE)**. An IA choice never upgrades a PD [PROPOSED] item to confirmed, and never treats a [VALIDATE] capability as available.
- The architectural choices made here are **IA recommendations** for product-owner approval. Choices that can't be settled from the PD are listed in §23.
- Decisions the product owner locked are tagged **(IA: CONFIRMED — IA-nn)**: IA-05 and IA-11 in Phase 0B.1; IA-01, IA-02, IA-03, IA-04, IA-09, IA-10, IA-13, IA-15 and IA-16 in Phase 0C.1.
- Flow-level behavior (how users move through these surfaces) is defined in `docs/core-ux-flows-v1.md`.
- **PD alignment:** IA-11 is the IA expression of confirmed Product Definition decision **D-49** (Monitor-only Workspace, PD §11.4, v1.2). The PD holds the product intent; this document defines how it appears to users. IA-05 is consistent with PD §11.3 (client guest: read-only access to a workspace's reports and insights).

### 0.2 What "information architecture" covers here

- What exists in the product, and at which level (organization, workspace, object).
- Where each capability lives and how users get there.
- What each surface must communicate, and in which priority order.
- What is visible by default versus disclosed progressively.
- What users are called, and what things are called.

Layout, visual hierarchy, components, interaction details and copywriting belong to later phases (Core UX Flows, then design).

---

## 1. Executive IA summary

**The organizing principle:** the product is organized around **user intent along the core loop**, inside a **workspace**.

```
LISTEN → UNDERSTAND → PRIORITIZE → ACT → MEASURE → LEARN
   │          │            │         │       │        │
   └─ happens automatically; users see it through five intent-based destinations:

   Home          "What needs me, and what changed?"            (Prioritize)
   Inbox         "What do I need to handle?"                   (Act)
   Content & Ads "Which content is creating what conversation?" (Understand, where)
   Insights      "What are people saying, why, and what should we do?" (Understand, Learn)
   Reports       "What happened over this period, to share?"   (Measure)
```

Five destinations, all scoped to the current workspace, are the entire primary navigation. Everything else is either:

- **Contextual**: it appears where the user needs it. Moderation actions sit on the conversation. Saved Replies and AI suggestions sit in the reply composer. Voice of Customer is a lens inside Insights, Content pages and Topic pages.
- **Configuration**: set up once and maintained occasionally (Connections, Brand Context, Saved Replies library, Moderation rules, Members). This lives in **Settings**, with direct links from the moments that need it.
- **Shell-level**: present everywhere (workspace switcher with the cross-workspace attention overview, search and command menu, alerts, account menu).

**The workspace is the world the user works in** (PD: CONFIRMED — C-11). Users who can access only one workspace never see cross-workspace concepts. Users with several workspaces (agencies, multi-brand or multi-market companies) get a switcher with attention indicators and a minimal **All workspaces** overview (PD: CONFIRMED — C-04). It is not portfolio intelligence.

**Platforms and organic/paid are dimensions, not destinations.** Facebook, Instagram and TikTok, and organic, paid, mixed and unknown, appear as labels, filters and scopes on every surface. They are never separate sections. This keeps all three platforms first-class (PD: CONFIRMED — D-04, D-06) and organic and paid equal (PD: CONFIRMED — principle 4) without multiplying navigation.

**AI is not a destination.** AI shows up as understanding (labels, priority reasons, insights), as assistance (suggested replies, recommendations) and as opt-in protection (auto-hide). It always appears where the work happens.

**Workspaces have an operating mode** (PD: CONFIRMED — D-49; IA: CONFIRMED — IA-11). In **Standard** mode the team can act on the platforms. In **Monitor-only** mode the workspace keeps all visibility, intelligence and internal workflow, but nothing in the product changes anything on Facebook, Instagram or TikTok: no replies, no hiding, no deleting, no blocking, no automation. It is the same product, the same navigation and the same Inbox. Only platform actions become unavailable, with a clear explanation (§4.3).

**Client guests get a deliberately small view** (IA: CONFIRMED — IA-05): Insights and Reports, read-only, with representative examples as evidence.

---

## 2. Information architecture principles

### 2.1 What earns top-level navigation

A concept becomes a primary destination only if **all** of these are true:

1. It answers a **distinct, recurring user question** that no other destination answers.
2. Users **start a session or a task** there, rather than only passing through.
3. It is **meaningful to at least two personas**, or is the main daily surface for one.
4. It holds **its own kind of object** or view (conversations, content, insights, period reports), not a filtered copy of another destination.
5. It would be **harder to find or understand** if nested.

Capabilities that only modify, assist or configure another destination are not top-level.

### 2.2 What stays contextual

- **Actions stay with their objects.** Reply, hide, delete, block, assign and escalate live on the conversation. "Mark recommendation done" lives on the recommendation.
- **Assistance stays where the work happens.** AI suggestions and Saved Replies live in the reply composer. Brand Context gaps are flagged inside the suggestion.
- **Lenses stay with their scope.** Voice of Customer, topic mix and risk appear inside Home, Content pages, Topic pages and Insights. One lens, many scopes, no duplicated destination.
- **Explanations stay next to the claim.** "Why it's here", "why this insight", "why this action isn't available" are shown beside the thing they explain.

### 2.3 What belongs in Settings

Something belongs in Settings when it is **set up once and maintained occasionally**, changes how the workspace or organization behaves, or is administered by a subset of roles. Every Settings area with a daily impact must also have **contextual entry points** where its effects are visible. Example: moderation rules are configured in Settings, their results are reviewed in the Inbox, and their status is summarized on Home.

### 2.4 Organization level vs workspace level

| Belongs to the **organization** | Belongs to the **workspace** |
|---|---|
| Things that span workspaces or are about the customer as a company: list of workspaces, organization members, default roles, plan and billing, the cross-workspace attention overview. | Everything operational: connections, conversations, content, insights, reports, Brand Context, Saved Replies, moderation rules, workspace members, workspace time zone and business hours, and the workspace operating mode (Standard or Monitor-only). |

The rule: **if it touches conversations or their meaning, it is workspace-level** (PD: CONFIRMED — C-11, D-48).

### 2.5 Progressive disclosure

Three depth layers apply on every surface:

| Layer | Who it serves | What it contains |
|---|---|---|
| **1. Default** | P1 owner-operator, everyone on arrival | The answer, the reason, the next step. One primary label per item. |
| **2. On demand** | P2 CM, P3 agency, P4 structured team | Filters, secondary dimensions, assignment, saved views, bulk actions, campaign hierarchy. |
| **3. Expert / audit** | P4, managers, admins | Full classification dimensions with confidence, correction, full activity history, per-platform capability details, rule activity. |

Team features appear only when relevant. For example, assignment and "Assigned to me" appear when the workspace has more than one member who can respond. Cross-workspace concepts appear only when the user has access to more than one workspace, and never for client guests (IA-05).

### 2.6 Cognitive-load principles

1. **One question per surface.** Each destination states its question (§5) and everything on it serves that question.
2. **Answer first, data second.** Lead with a plain-language statement ("12 conversations need a reply; 3 are purchase questions on active ads"), then the supporting numbers.
3. **Reasons over scores.** Show *why* something matters, not a numeric score.
4. **One primary label per item** in lists. Further dimensions are disclosed on demand.
5. **Calm when nothing is wrong.** Say "Nothing urgent" explicitly instead of showing empty widgets.
6. **Stable scope.** The workspace and the source scope (All / Organic / Paid) stay put as the user moves between destinations, so they always know what they are looking at.
7. **Same name, same thing.** One term per concept across the product (§21).
8. **No implementation vocabulary.** No "ingestion", "classifier", "token", "webhook", "API" in user-facing labels.
9. **Honest limits without noise.** Platform limitations are explained once, where they matter, not repeated as global banners.

---

## 3. Product hierarchy

### 3.1 Conceptual hierarchy (required output A)

This shows containment and context as users experience it. It is not a data model.

```
User ──(member of, with a role per workspace)──▶ Organization
                                                  │
Organization ─────────────────────────────────────┤  plan & billing, members, defaults
  │                                               │
  ├── All workspaces (attention overview) ◀───────┘  only if user has >1 workspace
  │
  └── Workspace  ◀── primary operational & access boundary (C-11)
        │   labels: Brand(s) · Market (grouping/context dimensions, not levels)
        │   operating mode: Standard | Monitor-only (IA-11)
        │
        ├── Connected accounts (owned by the workspace — D-48)
        │     Facebook · Instagram · TikTok · related ad accounts
        │     each with: connection health · coverage · what's available (capabilities)
        │       │
        │       └── Content  (post · reel · video · ad …)
        │             source: Organic · Paid · Mixed (boosted) · Unknown   (C-05)
        │             paid context: Campaign › Ad group › Ad  (where available, VALIDATE)
        │               │
        │               └── Conversation  (a top-level comment + its replies,
        │                     │             including your replies)
        │                     │   workflow: status · assignee · priority + reason
        │                     │
        │                     └── Comment / Reply  (Interaction)
        │                           author (audience member · your account · likely bot)
        │                           labels: type · topic(s) · risk · response need …
        │                           moderation state: visible · hidden · deleted
        │
        ├── Topics ─────────── group comments by subject across all content
        │
        ├── Insights ───────── observations about patterns (across topics, content, time)
        │     └── Recommendations ── suggested business actions
        │           └── Done (with date) ──▶ Follow-up (descriptive before/after)
        │
        ├── Reports ────────── period snapshots (executive summary, performance)
        │
        └── Workspace setup
              Brand Context · Saved replies · Moderation rules · Members · Connections
```

### 3.2 Concept relationships that matter to users

| Concept | Lives in | Is understood through | Notes |
|---|---|---|---|
| **User** | Organization | Their role per workspace | A person can have different roles in different workspaces. |
| **Organization** | Top level | Rarely seen by single-workspace users | Billing, members, the list of workspaces. |
| **Workspace** | Organization | The current context, always visible in the shell | The boundary for access, data and configuration. Has an operating mode: Standard or Monitor-only (§4.3). |
| **Brand** | Label on a workspace (and possibly on connected accounts inside it; see §23 IA-07) | Grouping and filtering in the All workspaces overview; Brand Context sections | Not a navigation level (C-11). |
| **Market** | Optional label on a workspace | Grouping and filtering in the All workspaces overview | Not a navigation level; not a core concept (PD §16). |
| **Connected account** | Workspace | Connections settings; account labels on content and conversations | Belongs to the workspace, not the person who connected it (D-48). |
| **Content** | Connected account | Content & Ads; the context header of every conversation | Source and paid context are properties of content (C-05). |
| **Conversation** | Content | Inbox | The unit of work (see §7.1). |
| **Comment / Reply (Interaction)** | Conversation | Inside a conversation; as evidence examples | The unit of classification and moderation. |
| **Topic** | Workspace (spans content) | Insights, Content pages, Voice of Customer | A subject ("Delivery", "Price", "Product X"). |
| **Insight** | Workspace (scoped to topics, content, source, time) | Insights; highlights on Home | Always links to evidence. |
| **Recommendation** | Insight | Insights › Recommendations; Home "Suggested next steps" | Status: open, accepted, dismissed, done (C-10). |
| **Follow-up** (Tracked action) | Recommendation marked done | The recommendation itself | Descriptive, never causal (C-10). |

---

## 4. Global product shell

The shell is what surrounds every screen. It answers: **Where am I? What can I go to? Does anything need me elsewhere?**

### 4.1 Shell elements

| Element | Scope | Purpose | Visibility |
|---|---|---|---|
| **Workspace switcher** | Organization | Shows the current workspace (name, brand/market labels). Lists the user's workspaces with **attention indicators** and links to **All workspaces**. | Always shows the current workspace. The switching list and attention indicators appear only for users with access to more than one workspace. Client guests see no attention indicators; a guest granted more than one workspace can switch between them (IA-05). Monitor-only workspaces carry a "Monitor-only" label. |
| **Primary navigation** | Workspace | Home · Inbox · Content & Ads · Insights · Reports | Always. Items a role cannot use are hidden, never shown disabled (§18). Client guests see only Insights and Reports (IA-05). The workspace mode never changes navigation (IA-11). |
| **Source scope** | Workspace, persistent | All · Organic · Paid (with Mixed and Unknown included under All and selectable as filters) | Shown on Inbox, Content & Ads, Insights and Home. It persists while the user moves between them. |
| **Search and command menu** | Current workspace | Jump to a destination; find conversations, content, topics, authors, saved replies; run commands ("Assign to me", "Open Settings › Moderation"). Keyboard-first. | Always. Workspace-scoped in the MVP (IA: CONFIRMED — IA-10); switching workspaces is a navigation command, not a search. For client guests, search covers only insights, topics and reports, never conversations (IA-05). |
| **Alerts** | User, across their workspaces | High-severity alerts (severe risk, unusual spikes, harmful content building up on active ads), assignments and escalations to me, connection failures. Each alert names its workspace. | Always, except for client guests (IA-05). Channels beyond in-app are open (PD OQ-17). |
| **Settings entry** | Workspace and organization | One entry point to Settings (§17), showing only the areas the role can manage. | Always, except for client guests, who only have the Personal area in the account menu (IA-05). |
| **Account menu** | User | Profile, interface language and locale, personal notification preferences, help, sign out. | Always. |
| **Workspace mode indicator** | Workspace | A persistent, calm indicator that the workspace is Monitor-only, linking to a plain explanation and, for Owners and Admins, to the setting. | Only in Monitor-only workspaces (IA-11). |

### 4.2 What is deliberately not global

- **Platform switchers** (a "Facebook / Instagram / TikTok" mode). Platform is a filter and a label (§1).
- **Organic vs paid sections.** Source is a scope, not a product split.
- **An "AI" area**, a "Moderation" area or an "Automation" area (§5.3).
- **Cross-workspace data** beyond attention indicators and alerts: no global analytics, no global inbox in the MVP (C-04).
- **Connection status banners** on every screen. A connection problem appears on Home, in Connections, and where it blocks an action. A global notice is used only when the whole workspace has stopped receiving data.

### 4.3 Workspace operating mode (PD: CONFIRMED — D-49; IA: CONFIRMED — IA-11)

Every workspace runs in one of two modes. The mode is a property of the workspace. It is not a separate product, navigation tree or Inbox.

| | **Standard** (default) | **Monitor-only** |
|---|---|---|
| Who it's for | Teams that manage conversations and moderate on the platforms. | Agencies or teams that need protection, intelligence and visibility while community management or direct platform action is outside their scope. |
| Platform actions: public reply, private reply, hide, unhide, delete, block | Available, subject to role and platform capability. | **Unavailable.** Visible where they normally appear, with an explanation. |
| Automation that changes the platform (all auto-hide rules) | Available, opt-in. | **Unavailable.** Rules are suspended and can't be activated. |
| View conversations, labels and priority reasons; correct labels | ✓ | ✓ |
| Assign, internal status, notes, escalate | ✓ | ✓ |
| Review risks; paid and organic conversation | ✓ | ✓ |
| Content & Ads, Insights, Voice of Customer, Recommendations, Reports | ✓ | ✓ |
| Alerts; cross-workspace attention indicators | ✓ | ✓ |

**Rules for Monitor-only:**

- **Communicated, not hidden.** A persistent indicator names the mode. Platform actions stay visible where they'd normally appear, marked unavailable with "This workspace is Monitor-only". Owners and Admins also see where to change the mode.
- **Who can change it:** Owner and Admin, in Settings › Workspace › General (§17). Every change records who made it and when. When a workspace is created, an optional, lightweight choice "How will you use this workspace?" offers **Standard** (default) or **Monitor-only** (Phase 0C.1, UX-02).
- **Switching to Monitor-only:** active auto-hide rules are suspended immediately. Past automatic hides stay visible as history, but can't be undone from the product while the mode is on.
- **Switching back to Standard (IA: CONFIRMED — IA-16):** every auto-hide rule returns **Paused**. Nothing resumes automatically. A permitted person re-enables each rule explicitly, and malicious-link and configured-pattern rules require a fresh preview before re-enabling.
- **No composer.** Suggested replies and saved replies aren't offered in conversations, because nothing can be sent. Brand Context and the saved replies library stay editable in Settings, ready for a return to Standard.
- **Native replies still count.** Replies the brand makes directly on the platform are still imported, so reply-needed status, response time and backlog stay meaningful.
- **No new structure.** Same navigation, same Inbox views, same Settings. No Monitor-only-specific surfaces beyond the indicator and the explanations.

### 4.4 Application entry (Phase 0C.1, UX-01)

| User | Lands on |
|---|---|
| Access to one workspace | **Home** of that workspace |
| Access to several workspaces (not a client guest) | **All workspaces** |
| Client guest | **Reports › Summary** in their workspace. If no usable report exists yet: **Insights**, with a calm explanation that reporting becomes available once there is enough period data (IA-05) |

**Home is the entry point when entering a workspace.** All workspaces is the application entry point for ordinary users with several workspaces. There is no personal start-page preference in the MVP. After entry, users navigate normally. Client guests never see All workspaces or attention indicators.

---

## 5. Recommended top-level navigation

### 5.1 Top-level navigation map (required output B)

```
[Workspace switcher ▾]  ── All workspaces (only if >1 workspace)
│
├── Home            What needs me, and what changed?
├── Inbox           What do I need to handle?
├── Content & Ads   Which content is creating what conversation?
├── Insights        What are people saying, why, and what should we do?
│     ├── Insights            (default view)
│     ├── Voice of Customer   (lens)
│     └── Recommendations     (incl. follow-up)
└── Reports         What happened over a period, ready to share?
      ├── Summary             (executive summary)
      └── Performance         (operations over the period)

Shell (always): Search & commands · Alerts · Settings · Account
```

**Five destinations.** That is the smallest set where each answers a distinct question (§2.1).

### 5.2 Top-level destinations

#### Home

| Aspect | Definition |
|---|---|
| Primary question | "What needs my attention now, and what changed since I last looked?" |
| Primary personas | P1 owner-operator (main surface), P3 agency, P5 executive; everyone on entering a workspace (§4.4) |
| Main content | Attention summary, risks, what changed, opportunities, suggested next steps, operational health, coverage notices (§6) |
| Actions started here | Jump into prioritized Inbox views; open an insight; accept, dismiss or open a recommendation; fix a connection; review automatic hides |
| Why top-level | It is the entry point of each workspace and of the loop, and the main surface for users who don't work an inbox all day. Without it, P1 has to interpret the Inbox and Insights separately. |

#### Inbox

| Aspect | Definition |
|---|---|
| Primary question | "What do I need to handle, in what order, and why?" |
| Primary personas | P2 community manager (main surface), P1, P3 agency CM, P4 responders |
| Main content | Conversations across all platforms and sources, prioritized with reasons; views; filters; conversation detail with reply, moderation and workflow (§7, §8) |
| Actions started here | Reply publicly (with AI suggestion or Saved Reply), reply privately where supported, hide/unhide, delete, block, assign, escalate, mark done, add note, correct labels, undo automatic hides. Platform actions are unavailable in Monitor-only workspaces (§4.3). |
| Why top-level | It is the daily operational surface and holds its own object (conversations as work items). It is the canonical home of moderation actions and their results. |

#### Content & Ads

| Aspect | Definition |
|---|---|
| Primary question | "Which content is creating what kind of conversation?" |
| Primary personas | P3 agency paid-media team, P2 social lead, P5 brand manager, P1 |
| Main content | Posts, reels, videos and ads with their conversation profiles; campaign grouping where available (§9) |
| Actions started here | Open a content profile; jump to its conversations in the Inbox; open related insights; compare organic and paid content |
| Why top-level | It holds its own object (content) and answers a question the PD treats as central: which campaign, ad or post is driving conversation (PD §14.6), with paid as a first-class concern. Nesting it under Insights would hide the main paid-media entry point agencies need. The label **Content & Ads** is canonical for v1 (IA: CONFIRMED — IA-03). |

#### Insights

| Aspect | Definition |
|---|---|
| Primary question | "What are people saying, why, and what should we do about it?" |
| Primary personas | P3 agency strategist, P2 social lead, P4 analyst, P5 executive, P1 (through Home highlights), client guests (read-only — IA-05) |
| Main content | Insights (observation → evidence → driver → recommendation), Voice of Customer lens, topic pages, recommendations with follow-up (§10, §11) |
| Actions started here | Examine evidence; accept, dismiss or mark a recommendation done (with date); open follow-up; create a saved reply from a "create a saved reply" recommendation; drill into conversations |
| Why top-level | It holds the intelligence objects (insights, topics, recommendations) and is where the UNDERSTAND → LEARN half of the loop happens. |

#### Reports

| Aspect | Definition |
|---|---|
| Primary question | "What happened over this period, and what should we tell stakeholders?" |
| Primary personas | P5 executive and agency client (main surface), P3 account manager, P2/P4 leads accountable for performance |
| Main content | Period-bound snapshots: **Summary** (what changed, why, risks, recommendations, follow-ups) and **Performance** (volume, response time, backlog, unattended organic vs paid, moderation and automation activity over the period) (§12) |
| Actions started here | Choose a period; open the underlying insight or view; share or export (format open — PD OQ-15) |
| Why top-level | It serves a distinct need: a stable, retrospective, shareable account of a period, mostly for people who don't operate the product. It is the natural landing place for client guests and executives. It doesn't recompute intelligence; it assembles it (§12.2). Top-level status confirmed (IA: CONFIRMED — IA-02). Delivery format remains open (PD OQ-15). |

### 5.3 Candidates that are not top-level, and where they live

| Candidate | Decision | Where it lives instead | Why |
|---|---|---|---|
| **Pulse / Overview** | Renamed to **Home** | Top-level as Home | Same concept. "Home" is clearer than "Pulse" for an SMB user. |
| **Voice of Customer** | Not top-level | A **lens** inside Insights, also embedded on Home, Content profiles and Topic pages (§11) | It is a way of reading the same conversations, not a different object. A separate destination would duplicate Insights and Content. |
| **Policies / Automation** | Not top-level | **Settings › Workspace › Moderation** for configuration. Results in **Inbox › Hidden automatically**. Status on **Home** (§13) | Configured rarely. Its effects are reviewed in the Inbox. A top-level "Automation" would invite a rules-engine mindset the PD rules out. |
| **Moderation** | Not top-level | **Actions** in the conversation (Inbox). **Rules** in Settings › Moderation. **Activity** in Inbox views and Reports › Performance | Moderation is something you do to conversations, so it lives with them. It is not hidden in Settings, because Settings only holds the rules. |
| **Saved Replies** | Not top-level | **In the reply composer** (use, save). **Library** in Settings › Workspace › Responding › Saved replies (§14) | It is assistance for replying. Its natural moment is the composer. |
| **Brand Context** | Not top-level | **Settings › Workspace › Responding › Brand Context**, with contextual prompts from suggested replies and onboarding (§15) | Set up once and maintained occasionally. Its effect is visible in suggestions. |
| **AI** | Never a destination | Embedded: labels and reasons (Inbox), suggestions (composer), insights and recommendations (Insights), auto-hide (rules) | A disconnected "AI" area separates intelligence from the work (§22). |
| **Topics** | Not top-level | Topic pages reachable from Insights, VoC, Content profiles and search | Topics are an organizing dimension of intelligence, reached through it. |
| **Campaigns** | Not top-level | A grouping and filter inside Content & Ads, where available (PD: VALIDATE) | Campaigns organize paid content; they are not a separate product area. |
| **Authors / People** | Not a destination | Author context inside the conversation detail only | A people directory would drift toward a CRM, which is a non-goal (PD §10.1). |
| **Connections** | Not top-level | Settings › Workspace › Connections, with health and coverage surfaced on Home | Configuration. |
| **All workspaces** | Not in workspace navigation | Organization level, reached from the workspace switcher | Exists only for multi-workspace users (§16). |
| **Settings** | Shell entry, not a primary destination | Shell | Configuration, role-dependent. |

### 5.4 Workspace-level sitemap (required output C)

```
Workspace
├── Home
│   ├── Needs attention now
│   ├── Risks
│   ├── What changed
│   ├── Opportunities
│   ├── Suggested next steps
│   ├── Operational health (incl. automation status)
│   └── Coverage & connection notices
│
├── Inbox
│   ├── Views: Priority (default) · Assigned to me* · Needs review · Escalated
│   │          · Hidden automatically · Done · [Saved views]
│   ├── Filters (primary + more)
│   └── Conversation
│       ├── Content context (+ paid context)
│       ├── Thread (comments, replies, your replies, private-reply records)
│       ├── Why it's here · labels · author context
│       ├── Composer: reply · suggested reply · saved replies · Brand Context use
│       ├── Workflow: status · assignee · escalate · note
│       ├── Moderation: hide/unhide · delete · block
│       └── Activity history
│
├── Content & Ads
│   ├── Views: All content · Ads & boosted · Organic
│   ├── Grouping: by campaign (where available) · by account · by platform
│   └── Content profile
│       ├── Content & source / paid context
│       ├── Conversation profile (volume, mix, useful vs friction)
│       ├── Voice of Customer for this content
│       ├── Risks & unattended
│       ├── Related insights
│       └── → Conversations in Inbox (pre-filtered)
│
├── Insights
│   ├── Insights (default): active insights, ranked
│   │   └── Insight: observation · evidence · scope · change · likely driver
│   │                · recommendation(s) · → examples / conversations
│   ├── Voice of Customer: Questions & unmet needs · Objections · Complaints & problems
│   │                      · Praise & advocacy · Customer suggestions · Purchase intent
│   ├── Recommendations: Open · Accepted · Done (follow-up) · Dismissed
│   └── Topic page (reached from anywhere): trend · VoC for topic · content · insights
│
├── Reports
│   ├── Summary (period)
│   └── Performance (period)
│
└── Settings › Workspace   (see §17)

* shown when the workspace has more than one member who can respond

Client guests (IA-05) see only: Insights (Insights, Voice of Customer,
Recommendations read-only, topic pages) and Reports (Summary, Performance).

Monitor-only workspaces (IA-11) use this same sitemap. Only platform actions
and auto-hide rules become unavailable.
```

---

## 6. Workspace Home (Pulse) architecture

Home answers, calmly and in this priority order, what a user needs to know on entering a workspace. Each block states its answer in plain language first, then offers a way in. Blocks with nothing to report collapse to a one-line all-clear statement. They never show empty charts.

| Priority | Block | Question answered | Information shown | Leads to |
|---|---|---|---|---|
| 0 | **Blocking notices** (only when present) | "Is something stopping the product from working?" | Revoked or failed connection, import still running, no connections. | Settings › Connections; import status |
| 1 | **Needs attention now** | "What needs me right now?" | Count of open conversations needing a response or review, broken down by the top reasons (e.g. purchase questions on active ads, complaints waiting more than X hours, items needing review). Calls out paid items explicitly. | Inbox, Priority view (or the matching filter) |
| 2 | **Risks** | "Is anything dangerous happening?" | Reputation-risk conversations, fraud accusations against the brand, threats, emerging incidents, harmful content building up on active ads. | The conversations or the insight behind the risk |
| 3 | **What changed** | "What's different since last time or last period?" | The 1–3 most significant insights (e.g. "Delivery questions up sharply, concentrated in Product X ads"), with absolute counts. Minimum-volume rules apply (PD §14.4). | Insight detail |
| 4 | **Opportunities** | "What could I gain?" | Unanswered purchase intent, recurring unmet information needs, notable praise or advocacy. | Inbox filter; VoC lens |
| 5 | **Suggested next steps** | "What should I consider doing?" | Open recommendations (top few), and follow-ups that have new before/after results. | Insights › Recommendations |
| 6 | **Operational health** | "Is our handling healthy?" | Backlog trend, unattended paid vs organic, response time vs baseline, automation status (on or paused, hides this period, with a link to review). | Reports › Performance; Inbox › Hidden automatically; Settings › Moderation |
| 7 | **Coverage** | "Is the picture complete?" | Non-blocking coverage notes: partial history for an account, capabilities unavailable on a platform, AI uncertainty share if unusually high. | Settings › Connections |

**Rules:**
- Home is always scoped to one workspace and follows the source scope (All / Organic / Paid).
- Home never duplicates full lists. It summarizes, then links.
- Analyst/Viewer roles see every block, read-only (IA: CONFIRMED — IA-15). Operational actions stay unavailable according to permissions. Client guests have no Home in the MVP; they land on Reports › Summary (IA: CONFIRMED — IA-05). See §18.
- In Monitor-only workspaces Home keeps every block. Needs attention still shows what needs a response, framed for review and escalation, because replies happen outside the product. Operational health shows automation as "Unavailable — this workspace is Monitor-only" (IA-11).
- Exact thresholds ("waiting more than X hours", "significant") depend on PD OQ-16 and OQ-25.

---

## 7. Unified Inbox information architecture

### 7.1 Unit of work

**The Inbox lists conversations.** A conversation is a top-level comment plus its replies, including the brand's own replies, whether made in the product or natively on the platform (PD §8.2).

- **Workflow state** (status, assignee, escalation, notes) belongs to the **conversation**.
- **Labels and moderation state** belong to each **comment or reply** inside it.
- A conversation's **priority** is driven by its most important unhandled comment, and its "why it's here" reason names that comment.
- A busy post or ad generates many conversations (one per top-level comment). Users can **group by content** to see them per post or ad.

This mirrors how users think ("this person's comment and the replies to it") while keeping per-comment moderation precise. One top-level comment thread is one conversation (IA: CONFIRMED — IA-01).

### 7.2 Default ordering

Default view **Priority** lists open conversations by priority, then by waiting time. Priority combines (PD §2, §9.2-B, PD: PROPOSED detail):

- **What it is:** type and risk (e.g. threat, fraud accusation, purchase question, complaint).
- **Response need:** required, recommended or none.
- **Where it is:** paid or active ad, high-visibility content.
- **How long it has waited**, against workspace business hours where configured.
- **Uncertainty:** low-confidence items needing human review.

Users can switch ordering to newest, oldest waiting, or by content.

### 7.3 Inbox hierarchy (required output E)

```
Inbox (current workspace · source scope: All | Organic | Paid)
│
├── System views
│   ├── Priority ............ all open conversations, prioritized (default)
│   ├── Assigned to me ...... (team workspaces only)
│   ├── Needs review ........ ambiguous / low-confidence, abuse & insults flagged
│   │                         for review (C-01), items protected from auto-hide
│   ├── Escalated ........... escalated conversations
│   ├── Hidden automatically  hides done by auto-hide rules, with undo (C-09);
│   │                         history only in Monitor-only workspaces (IA-11)
│   └── Done ................ handled conversations (replied, no reply needed,
│                             moderated), searchable history
│
├── Saved views ............. user-created (personal, or shared in workspace)
│
├── Filters
│   ├── Quick filter: Needs reply (reply needed or recommended) — not a separate view
│   ├── Primary (always visible): Platform · Organic/Paid · Status · Assignee
│   └── More filters: Account · Content · Campaign (where available) · Type
│        · Topic · Risk · Response need · Sentiment · Language · Moderation state
│        · Waiting time / age · Date range · Author
│
├── Grouping (optional): none · by content · by campaign · by platform
│
└── Conversation (detail — §8)
```

### 7.4 Workflow concepts

| Concept | Values (user-facing) | Notes |
|---|---|---|
| **Status** | Open · Done (IA: CONFIRMED — IA-04) | "Done" records a resolution where applicable: replied publicly, replied privately, replied on platform, no reply needed, moderated, reviewed (Monitor-only), escalation closed. **No Waiting or Snoozed status in the MVP.** |
| **Automatic status changes** | Auto-Done · Auto-reopen | Auto-Done after a successful brand reply when nothing else needs handling. Auto-Done ("Replied on platform") when a native brand reply is detected after the latest audience message and nothing else needs handling. Auto-reopen when a new audience comment or reply needs attention. Every automatic change is visible in the activity history and reversible where appropriate. |
| **Escalated** | Flag on an Open conversation | Not a third status. Visible in the Escalated view. Delivery to recipients who aren't members (P6) depends on PD OQ-17. |
| **Assignee** | A workspace member or nobody | Hidden in single-responder workspaces. |
| **Priority** | Shown as a reason, not a score | "Why it's here" (§7.6). |
| **Moderation state** | Visible · Hidden (by a person / by a rule) · Deleted · Author blocked | Per comment. Deleted comments stay in the activity history as a record. |
| **Response need** | Reply needed · Reply recommended · No reply needed | From classification. Users can override it. |

### 7.5 What appears where

**A. In the list item (default layer)**

- Platform (name or recognizable mark with a text label available) and **Organic / Paid / Mixed** label.
- Author display name.
- Excerpt of the key comment, in its original language.
- **One primary label** (e.g. "Purchase question", "Complaint", "Fraud accusation", "Spam").
- **Why it's here**: a short reason (e.g. "Purchase question on an active ad · waiting 6h").
- Content reference (which post or ad, briefly).
- Waiting time.
- Assignee (team workspaces only).
- Number of unhandled comments in the conversation, if more than one.
- Non-visible moderation state, if any ("Hidden").
- Language tag only when it differs from the workspace's main language.

Not in the list: sentiment, confidence, full label set, campaign hierarchy, history.

**B. In the conversation detail (on selection)**

- Content context and paid context (§8).
- The full thread, with your replies distinguished and private-reply records.
- Labels for the key comment: type, topic(s), risk, response need.
- **Why it's here**, in full: the factors behind its priority.
- Author context within this workspace.
- Workflow, composer and actions.

**C. Progressively disclosed (on demand)**

- All classification dimensions, including sentiment, authenticity and confidence.
- Label correction (human override, audited).
- Translation of comments and of suggested replies.
- Which Brand Context items a suggestion used.
- Complete activity history.
- Per-platform capability explanations.

### 7.6 Understanding why something is prioritized

Every prioritized conversation carries a **"Why it's here"** statement built from user-meaningful factors, never a raw score:

- *What:* "Purchase question", "Fraud accusation against your brand", "Possible threat".
- *Where:* "on an active ad", "on your most-commented post this week".
- *How long:* "waiting 6h (business hours)".
- *Uncertainty:* "Needs a human look: the AI isn't sure what this is".
- *Protection notices:* "Contains a complaint, so it is never hidden automatically" (C-01/C-02 made visible).

The short form appears in the list. The full factor list appears in the detail.

### 7.7 Platforms and sources in the Inbox

- All three platforms appear in one list. There are no per-platform inboxes (PD: CONFIRMED — unified inbox).
- Organic, paid, mixed and unknown are labels and filters. **Paid** is one click away through the persistent source scope, which serves P3's protection need.
- If a platform doesn't support an action for a given content type, the action appears **disabled with a one-line reason** (e.g. "TikTok doesn't allow hiding this comment through official tools") (PD: CONFIRMED — C-07; specifics VALIDATE).

### 7.8 Inbox in Monitor-only workspaces (IA: CONFIRMED — IA-11)

The Inbox keeps the same structure, views, filters, ordering and "Why it's here" reasons. What changes:

- A persistent Inbox-level notice: "This workspace is Monitor-only. You can review, assign, escalate and add notes. Replying and moderating happen outside the product."
- Platform actions in conversations are visible but unavailable (§8.4). Bulk platform actions (e.g. bulk hide) are unavailable. Bulk internal actions (assign, escalate, mark done) remain.
- **Hidden automatically** shows past automatic hides as history only. No new entries appear, and Undo is unavailable while the mode is on.
- **Done** resolutions are internal outcomes (e.g. reviewed, no reply needed, escalation closed), per the confirmed status model (IA-04, §7.4).
- Replies the brand makes natively on the platform still appear in threads and still update reply-needed status.

### 7.9 Client guests and the Inbox (IA: CONFIRMED — IA-05)

Client guests have no access to the Inbox: no views, no conversation lists, no conversation detail or history. Conversation evidence reaches them only as representative quoted examples inside Insights and Reports (§10.4).

---

## 8. Conversation / interaction detail architecture

The conversation detail is where understanding turns into action. Its information hierarchy, from top to bottom in importance (not layout):

| Order | Block | Content |
|---|---|---|
| 1 | **Content context** | What this conversation is attached to: content preview, platform, account, content type, **Organic / Paid / Mixed / Unknown** label. Link to the Content profile. |
| 2 | **Paid context** (when available) | Campaign › ad group › ad, and every ad using the same content (PD: PROPOSED §8.4). When unavailable: "Ad details aren't available for this item." (VALIDATE) |
| 3 | **Why it's here** | Priority reason in full (§7.6). |
| 4 | **Thread** | The top-level comment and all replies in order. Your account's replies are marked as yours, including those made natively on the platform. Private-reply records appear inline ("Private reply sent by Ana · Oct 3 · any answer arrives in Instagram's inbox"). Moderation state is shown on each comment. |
| 5 | **Labels** | Primary type, topic(s), risk, response need. More on demand (§7.5-C). Correctable. |
| 6 | **Author context** | Earlier comments by this author **in this workspace**, and authenticity signals (e.g. "likely bot"). No cross-workspace profile (PD §10.2, PROPOSED). |
| 7 | **Composer** | Public reply with suggested reply, Saved Replies and Brand Context use (§8.2). |
| 8 | **Workflow** | Status, assignee, escalate, internal note. |
| 9 | **Activity history** | Who or what did what and when: replies, hides (by a person or by which rule), undo, label corrections, assignments, escalations (PD §9.2-J). |

### 8.1 Actions

| Tier | Actions | Treatment |
|---|---|---|
| **Primary** | Reply publicly (with suggestion or saved reply) · Mark done · Assign | Always visible to roles that can respond. |
| **Secondary** | Reply privately (where supported) · Escalate · Add note · Mark "no reply needed" · Hide / Unhide · Correct labels · Open content | Visible but less prominent. Hide is reversible, so it is not destructive. |
| **Destructive** | Delete comment · Block author | Separated from other actions, need explicit confirmation stating the consequence, shown only to roles granted them (PD §11.3, PROPOSED), always human (PD: CONFIRMED — D-19). |

In Monitor-only workspaces every platform action in these tiers (public reply, private reply, hide, unhide, delete, block) is unavailable. Internal actions remain: mark done, assign, escalate, add note, mark "no reply needed", correct labels, open content (§8.4).

### 8.2 Reply composer

- **Suggested reply** (PD: CONFIRMED — D-45, D-47):
  - Offered inside the composer, clearly labeled as a suggestion. It is never sent without a human pressing send.
  - It is written in the commenter's language, with a translation available to the user when the languages differ.
  - It shows **what it's based on** (e.g. "Based on: Shipping policy · Contact channels") and **what's missing** (e.g. "No price information in Brand Context"), with a direct link to add it to Brand Context.
- **Saved replies** (PD: CONFIRMED — D-46):
  - A searchable picker inside the composer, keyboard-accessible.
  - Replies in the commenter's language are offered first.
  - A reply typed in the composer can be saved as a new saved reply ("Save as saved reply"), subject to governance (PD OQ-23).
- **Flow:** human reviews or edits → human sends. There are no approval steps (PD: CONFIRMED — C-12).

### 8.3 Private reply (one-shot)

- **Available** only where the platform officially supports it (PD: VALIDATE). Otherwise it stays **discoverable but unavailable**, with the reason in outcome language and "Open on [platform]" where useful. It is never hidden because of a platform limit. Hiding is reserved for role limits (§18).
- **Before sending**, the user sees the limitation in plain language: "This sends one private message. If they answer, the conversation continues in [Platform]'s own inbox, not here."
- **After sending**, the record appears in the thread and the activity history, and the conversation can be marked done with resolution "Replied privately".
- **There is no private thread view, no DM list, no DM status.** The product never shows incoming private messages (PD: CONFIRMED — C-03).

### 8.4 Conversation detail in Monitor-only workspaces (IA: CONFIRMED — IA-11)

| Block or action | Behavior in Monitor-only |
|---|---|
| Content context, paid context, why it's here, thread, labels, author context, activity history | Unchanged |
| Composer (public reply, suggested reply, saved replies) | Replaced by a short explanation: "This workspace is Monitor-only. Replies are made outside the product." No suggestion is generated. |
| Reply privately · Hide · Unhide · Delete · Block author | Visible but unavailable, with "This workspace is Monitor-only". Owners and Admins also see where to change the mode. |
| Mark done · Assign · Escalate · Add note · Mark "no reply needed" · Correct labels · Open content | Available, per role |

**When an action is unavailable for several reasons**, the user sees one reason, the most fundamental:

1. The role can't perform it, so it is hidden (§18).
2. The workspace is Monitor-only, so it shows "This workspace is Monitor-only".
3. The platform doesn't support it, so it stays discoverable but unavailable, with the platform reason (e.g. "TikTok doesn't allow…").
4. The connection has a temporary problem, so it is blocked with a recovery action (§18).

---

## 9. Content & Ads architecture

### 9.1 Purpose

Help users answer **"Which content is creating what kind of conversation?"** and move between content and the conversations it generated. It is **not** an ad-management tool: no budgets, bids, edits, publishing or media optimization (PD §10).

### 9.2 Structure

```
Content & Ads (current workspace · source scope)
│
├── Views
│   ├── All content (default) ...... posts, reels, videos, ads with conversation activity
│   ├── Ads & boosted .............. paid and mixed content
│   └── Organic .................... organic content
│
├── Grouping (optional)
│   ├── by campaign › ad group › ad  (paid; where available — VALIDATE)
│   ├── by account
│   └── by platform
│
├── Sort: needs attention (default) · most conversation · most friction
│         · most questions · most purchase intent · newest
│
└── Content profile
    ├── Header: preview · platform · account · type · Organic/Paid/Mixed/Unknown
    │           · dates · paid context and all ads using this content
    ├── Conversation profile for the period:
    │     volume over time · type mix (questions, complaints, objections,
    │     purchase intent, praise, customer suggestions) · useful vs friction
    ├── Voice of Customer for this content (same lens as §11)
    ├── Top topics
    ├── Risks · unattended conversations · moderation summary
    ├── Related insights and recommendations
    └── → "See conversations" (opens Inbox filtered to this content)
```

### 9.3 Key definitions (user-facing)

- **Useful conversation:** questions, purchase intent, praise, advocacy and customer suggestions. Signals that the content engages and informs.
- **Friction:** complaints, objections, confusion and repeated unmet information needs. Signals that the content creates doubt or resistance.
- **Needs attention** (default sort): open conversations, risk, and unattended paid comments on this content.

How exactly these mixes are computed belongs to later phases. The IA requires that each is explainable and linked to its examples.

### 9.4 Boundaries

- "Content performance" means **conversation performance** (volume, mix, friction, risk), not media metrics. Whether any media metrics are shown is §23 IA-12.
- Campaign grouping exists only where platforms provide the linkage. Otherwise content shows "Ad details unavailable" (PD: VALIDATE, C-07).
- Mixed (boosted) content is shown as **Mixed** everywhere. It is never forced into organic or paid (PD: CONFIRMED — C-05).

---

## 10. Intelligence / Insights architecture

### 10.1 The chain

```
Comment ── classified ──▶ labels (type, topic, risk, …)
   │
   ▼ aggregated by
Topic ── measured over time ──▶ Trend
   │
   ▼ significant patterns become
Insight:  Observation → Evidence → Likely driver
   │
   ▼ suggests
Recommendation  (open · accepted · dismissed · done + date)
   │
   ▼ when done
Follow-up: descriptive before/after for the same topic and scope
           (never causal — C-10)
```

### 10.2 Distinctions users must be able to make

| Concept | What it is | Where users see it | Example |
|---|---|---|---|
| **Labels** (interaction classification) | What one comment is | On a comment in the Inbox | "Price objection · Topic: Price" |
| **Topic** | A subject grouping many comments | Topic pages, VoC, content profiles | "Delivery" |
| **Trend** | How a measure changes over time for a topic, type or scope | Topic pages, insight evidence | "Delivery questions: 21 → 58 vs previous 30 days" |
| **Insight** | A significant, evidence-backed observation worth attention, with scope and a likely driver | Insights; Home "What changed" | "Delivery questions rose sharply and are concentrated in Product X ads, which don't mention delivery time." |
| **Recommendation** | A suggested business action tied to an insight | Insight detail; Insights › Recommendations; Home | "Add delivery time to Product X ad copy." |
| **Follow-up** (Tracked action) | A recommendation marked done with a date, plus the before/after view | The recommendation | "Since Oct 12: delivery questions on those ads fell from 31% to 12% of comments (descriptive, not causal)." |

### 10.3 Insights destination structure

- **Insights (default view):** active insights ranked by significance and recency, filterable by source scope, platform, topic and content. Each insight shows its observation, evidence summary (counts, comparison window), scope and the status of its recommendation.
- **Insight detail** follows the PD anatomy (PD §14.3, PROPOSED): observation, evidence, scope, change, likely driver (labeled as a hypothesis, with confidence), recommendation(s), owner and status, follow-up.
- **Voice of Customer:** the lens described in §11.
- **Recommendations:** every recommendation in the workspace by status: Open · Accepted · Done (with follow-up) · Dismissed. Done items carry their action or completion date (PD: CONFIRMED — C-10).
- **Topic page** (object page reached from anywhere): the topic's trend, its VoC breakdown, the content where it concentrates, related insights and representative examples.

### 10.4 Drilling back to evidence

Every aggregate is one step from its evidence, and two steps from the full list:

1. **Aggregate → examples:** every insight, topic, VoC item and content-profile number shows representative example comments in place, in their original language with translation available.
2. **Examples → full list:** "See all N conversations" opens the **Inbox** with the exact scope applied (topic, type, content, source, period) and **status set to All**, so it includes handled conversations.

The Inbox is the single canonical list of conversations. Intelligence surfaces never build parallel lists.

**Client guests stop at step 1** (IA: CONFIRMED — IA-05):
- They see the representative quoted examples that support an insight, a VoC item, a topic or a report.
- They never get "See all", the Inbox, or a conversation's full history.
- Content appears as a name without a link, because Content & Ads isn't part of guest access.
- The examples shown to guests are a limited set chosen to support the claim, not a browsable list.

### 10.5 Honesty in the architecture

- Insights display absolute counts with every percentage, and the comparison window (PD §14.4, PROPOSED).
- Below minimum volume, no trend or insight is generated. Topic pages show counts and examples only.
- Drivers are always labeled "likely driver" and follow-ups always "descriptive" (PD: CONFIRMED — C-10).
- Coverage gaps that affect an insight are noted on the insight ("TikTok history covers 12 of 30 days").

---

## 11. Voice of Customer architecture

### 11.1 Recommendation: a lens, not a destination

**Voice of Customer is a view inside Insights**, and the same lens is embedded on Home (opportunities), Content profiles and Topic pages. It is **not** its own top-level destination.

Justification:
- VoC reads the **same conversations and topics** as Insights. A separate destination would duplicate topic pages, trends and evidence lists, which is exactly the duplication §22 forbids.
- Users reach VoC questions from different starting points: "what do people ask?" (workspace), "what do people ask **about this ad**?" (content), "what do people say **about delivery**?" (topic). One reusable lens serves all three without new navigation.
- VoC still deserves a **named, first-class view** because it is a core value dimension (PD §5.3) and a key executive question set (PD §14.6). It must not be buried as a filter.

### 11.2 Structure of the lens

```
Voice of Customer   (scope: workspace | content | topic · source scope · period
│                    · filters: platform · account · campaign where available — UC-09)
│
├── Questions & unmet needs ... recurring questions; information people keep
│                               asking for (e.g. starting price, delivery areas)
├── Objections ................ price objections, other commercial objections
├── Complaints & problems ..... legitimate complaints, product/service problems,
│                               fraud accusations against the brand
├── Praise & advocacy ......... praise, people defending/recommending the brand
├── Customer suggestions ...... ideas and requests from customers
└── Purchase intent ........... people showing intent to buy (linked to unanswered ones)

Each group: ranked topics · change vs previous period · examples · → Inbox (filtered;
            not available to client guests — IA-05)
```

### 11.3 Rules

- VoC groups are built from intent labels (PD §12.2). **Sentiment is never the organizing axis** (§22).
- Complaints and fraud accusations appear here as **signals to understand**, consistent with "negativity is not moderatable content" (PD principle 1).
- Unmet information needs link to the relevant fix: a recommendation, a Brand Context gap, or a saved reply.

---

## 12. Reporting architecture

### 12.1 Four kinds of looking, one home each

| Kind | Question | Time frame | Home |
|---|---|---|---|
| **Live operational view** | "What do I handle now?" | Now | Inbox (and Home "Needs attention") |
| **Live state summary** | "What needs me and what changed?" | Now vs recent baseline | Home |
| **Analytics / intelligence** | "What's going on, why, and what should we do?" | Any period, exploratory | Insights and Content & Ads |
| **Reports** | "What happened over this period, to share?" | Fixed period, retrospective | Reports |

### 12.2 What "Reports" means

A report is a **period-bound, shareable snapshot assembled from existing intelligence and operational data**. It is not a separate analytics engine and doesn't introduce new metrics or views.

- **Summary** (executive summary): for the chosen period, it covers what changed, why (likely drivers), risks, key VoC themes, recommendations and their status, and follow-up results. Every item links to its source insight, topic or content profile. For client guests, links go to insights and topics only (IA-05).
- **Performance:** for the chosen period, it covers conversation volume, response rate and response time against baseline, backlog trend, **unattended organic vs paid**, moderation activity (by people) and automation activity (by rule, with counts linking to the Inbox's Hidden automatically view; client guests see the counts without links, IA-05).

The PD's proposed report set (PD §14.7, PROPOSED) maps to the IA like this, without duplication:

| PD proposed report | IA home |
|---|---|
| Pulse / Overview | Home |
| Operations | Reports › Performance |
| Voice of Customer | Insights › Voice of Customer (live), summarized in Reports › Summary |
| Content & Ads | Content & Ads (live), highlights in Reports › Summary |
| Topic detail | Topic pages |
| Executive summary | Reports › Summary |

### 12.3 Delivery (left open)

How reports reach people (in-app only, scheduled digest, shareable link, export) is **open (PD OQ-15)**. The IA reserves a **"Share / export"** action on each report and a **"Schedule"** affordance as placeholders. It commits to neither. Whatever is chosen must preserve workspace boundaries and role visibility (§18), including the client guest evidence limits (IA-05).

### 12.4 What Reports must not become

- No cross-workspace or cross-client aggregated reports in the MVP (PD: CONFIRMED — C-04).
- No custom report builder or dashboard designer (anti-pattern, §22).
- No copies of live intelligence views under another name.

---

## 13. Policies / moderation / automation architecture

### 13.1 One system, four touchpoints

| Aspect | Home | Why there |
|---|---|---|
| **Doing** moderation | Conversation actions in the Inbox (§8.1) | Moderation is an action on a conversation. |
| **Reviewing** automation | Inbox › **Hidden automatically** view: every automatic hide, the rule that did it, its reason, and **Undo** | One canonical list of automated actions, next to the human work. |
| **Configuring** automation | Settings › Workspace › **Moderation** | Set up once; rarely changed; restricted to roles that can manage it. |
| **Monitoring** | Home "Operational health" (status, hides this period); Reports › Performance (activity over time) | Summaries only, linking back to the canonical list. |

### 13.2 Settings › Moderation structure

```
Moderation   (current workspace)
│
├── Automation status ............ On / Paused / Suspended (Monitor-only, IA-11)
│                                  · [Pause all automation]  ← kill switch
│                                  (PD: PROPOSED §13.4)
│
├── Always protected ............. (read-only explanation, not a toggle)
│     Comments with a complaint, a product or service problem, a fraud accusation
│     against your brand, or a commercial objection are never hidden automatically —
│     even if they contain insults or match a keyword. You can still moderate them
│     yourself. (C-01, C-02, C-09)
│
├── Auto-hide rules .............. each: Off by default · scope · preview · activity
│   ├── Obvious spam               (D-12)
│   ├── Obvious bots               (D-12)
│   ├── Malicious links            (C-09)
│   └── Keyword & pattern rules    (C-09)  — list of customer-defined patterns
│
├── Abuse & insults .............. Always sent to review (never auto-hidden — C-01).
│                                  Review handling options (e.g. priority, alerts)
│                                  — PD: PROPOSED interpretation
│
└── Activity ..................... per-rule counts → Inbox › Hidden automatically
```

### 13.3 Rule anatomy (information each rule shows)

1. **What it hides**, in plain language ("Comments that are obvious spam").
2. **What it never does:** "Hides only. Never deletes, never blocks." (PD: CONFIRMED — C-09, D-19)
3. **Scope:** all content, or paid only, or organic only, and which accounts or platforms. Platforms where hiding isn't available are shown as unavailable with a reason (VALIDATE).
4. **Preview against history** (required before activation for malicious-link and pattern rules, PD: CONFIRMED — C-09; offered for spam and bot rules, PD: PROPOSED): "In the last 30 days this would have hidden N comments. See them." The preview also lists comments **excluded by Always protected**, so the guard is visible.
5. **State:** Off / On / Paused / Suspended (the workspace is Monitor-only), with who changed it and when.
6. **Activity:** hides this period, linking to the canonical list.

### 13.4 Safety boundaries made obvious

- **Abuse, complaints, product problems, fraud accusations and objections never appear as auto-hide options.** There is no toggle to misconfigure (PD: CONFIRMED — C-01, C-02).
- Keyword rules show a warning when a pattern overlaps protected meaning (e.g. "scam", "fraud", "estafa", "golpe"). Creation is allowed, and the preview is required before activation. At runtime complaint protection always wins: matches with complaint or accusation signals go to Needs review, never hidden (PD: CONFIRMED — C-09; Phase 0C.1, UX-10).
- **Human bulk hide** (a person's action, not automation) is offered only for clearly homogeneous sets. Protected categories (legitimate complaints, product/service problems, fraud/scam accusations against the brand, commercial objections) are **excluded**, and the user sees how many were excluded and why. Individual, deliberate human moderation of a protected comment remains possible. Bulk delete and bulk block are not in the MVP (Phase 0C.1, UX-06). Bulk hides are attributed to the person and never appear as automatic hides.
- **Pause all automation** is one action, reachable from Settings › Moderation and from the header of Inbox › Hidden automatically.
- This is **not** a rules engine: no custom conditions, chains, schedules, or actions other than hide (PD §10, §13).

### 13.5 Entry points

- First run: after import, the product may suggest enabling a rule based on what it found ("142 obvious spam comments on your ads in the last 30 days"), with the preview.
- Home "Operational health" shows automation status.
- Insights may recommend a rule when spam builds up on specific content.

### 13.6 Moderation in Monitor-only workspaces (IA: CONFIRMED — IA-11)

- **All automation that changes the platform is off.** Auto-hide rules for obvious spam, obvious bots, malicious links and keyword/pattern rules are suspended and can't be activated. Settings › Moderation shows each one as "Suspended — this workspace is Monitor-only". Pause all automation has nothing to pause and says so.
- **Detection continues.** Spam, bots, malicious links, scam content, abuse and risks are still labeled, prioritized and alerted on. The workspace still protects through visibility and escalation.
- Rules can still be read, and their preview against history viewed, so the team can see and cite what automation *would* do. They can't be switched on.
- **Always protected** still applies and is still explained.
- When the workspace returns to Standard, every rule comes back **Paused** and must be re-enabled explicitly, with a fresh preview for malicious-link and pattern rules (IA: CONFIRMED — IA-16; §4.3).

---

## 14. Saved Replies architecture

| Aspect | Architecture |
|---|---|
| **Where it is used** | In the **reply composer** (§8.2): searchable picker, keyboard-first, commenter-language replies offered first. The user inserts, edits, then sends. |
| **Where the library lives** | **Settings › Workspace › Responding › Saved replies**: list, search, create, edit, retire. Also reachable from the composer ("Manage saved replies") and from a "create a saved reply" recommendation in Insights (PD §14.5). |
| **Creating** | From the library, or by saving a reply written in the composer ("Save as saved reply"). |
| **Editing / retiring** | In the library. Retired replies stop being offered but stay in history. Who can create, edit and retire is **open (PD OQ-23)**. The IA supports both "any responder" and "managers only" without structural change. |
| **Language** | Each saved reply has a language. Conceptually, a saved reply can have **language versions** grouped under one name ("Delivery times": ES · PT-BR · EN), so the picker offers the right version. Whether variants are needed at launch is open (PD OQ-23). |
| **Scope** | Per workspace (C-11). There is no organization-wide library in the MVP (§23 IA-08). |
| **Difference from suggested replies** | Saved replies are **fixed, human-approved text** chosen by a person. Suggested replies are **generated for this specific comment** from Brand Context. Both end in human review → human send. In the composer they are presented as two distinct sources and never blended silently. |
| **Not a macro system** | A saved reply inserts text. Nothing more: no status changes, assignments, tags, conditions, chained steps or automatic sending (PD: CONFIRMED — D-46). |
| **Monitor-only workspaces** | Not offered in conversations, because there is no composer (§8.4). The library stays editable (IA-11). |

---

## 15. Brand Context architecture

### 15.1 Mental model

Brand Context is **"what the AI is allowed to say about us."** It is the verified information that suggested replies may use. It is not a help center, a wiki, a document repository or a knowledge-base product (PD: CONFIRMED — D-47; non-goal R-15).

### 15.2 Location and structure

**Settings › Workspace › Responding › Brand Context**, organized as short, structured sections:

```
Brand Context   (current workspace; brand-specific sections if the workspace
│                holds several brands — open: PD OQ-24)
├── Brand identity ......... name, short description
├── Products & services .... what you sell, key variants
├── Verified facts ......... prices, delivery areas and times, hours, guarantees
├── FAQs ................... common questions with approved answers
├── Contact channels ....... approved phone, WhatsApp, email, web, store addresses
├── Tone & voice ........... how replies should sound; words to use/avoid
└── Key policies ........... returns, refunds, warranties, operational information
```

Each section shows **when it was last updated and by whom**, so users can judge whether the context is still current.

### 15.3 How users meet Brand Context in context

- **Onboarding:** a short prompt to fill the essentials (identity, contact channels, a few facts), explained as "so suggested replies can give real answers instead of 'we sent you a DM'". The minimum required is open (PD OQ-24).
- **In the composer:** every suggestion shows what it was based on and what was missing, with a link to add the missing fact (§8.2).
- **From Insights:** recurring unmet information needs ("people keep asking the starting price") can point to a Brand Context gap as well as to a recommendation.

### 15.4 Boundaries

- Suggestions use only Brand Context and the conversation itself. Missing information is flagged, never invented (PD: CONFIRMED — D-47).
- How the information is stored, searched or used by the AI is not an IA concern and is left to technical phases.
- In Monitor-only workspaces no suggestions are generated. Brand Context stays editable for a return to Standard (IA-11).

---

## 16. Cross-workspace / agency architecture

### 16.1 Minimal MVP experience (PD: CONFIRMED — C-04)

Two elements only:

1. **Workspace switcher with attention indicators** (shell). Each workspace in the list shows whether it needs attention, so switching is informed. For users with several workspaces, All workspaces is also the application entry point (§4.4).
2. **All workspaces** (organization level). A single list of the user's workspaces answering four questions:
   - Which workspace or client **needs attention**?
   - Which has **urgent interactions**?
   - Which has **reputation risk**?
   - Which has a **growing backlog**?

The exact criteria behind each signal are open (PD OQ-25).

### 16.2 Organization / cross-workspace sitemap (required output D)

```
Organization
├── All workspaces (attention overview)        — only for users with >1 workspace
│     per workspace: name · brand/market labels · needs attention
│                    · urgent conversations · reputation risk · backlog trend
│                    · connection health · "Monitor-only" label where applicable
│     sort: needs attention (default) · name
│     group/filter: brand · market  (C-11)
│     → enter workspace Home  |  → enter workspace Inbox (urgent filter)
│
├── Alerts (shell) — across the user's workspaces, each labeled with its workspace
│
└── Settings › Organization  (see §17)
      General · Workspaces · Members & roles · Plan & billing
```

### 16.3 What it must not become

- No aggregated topics, VoC, insights, trends or reports across workspaces.
- No cross-workspace inbox: work happens inside a workspace.
- No cross-workspace search in the MVP (IA: CONFIRMED — IA-10).
- Clicking any signal **enters the workspace**. Investigation always happens inside the workspace boundary.

### 16.4 Same mechanism for companies

A multi-brand or multi-market company sees the same All workspaces page, with workspaces such as "Brand A · Chile", "Brand A · Mexico", "Brand B · Chile". Brand and Market labels allow grouping and filtering (e.g. all Brand A workspaces, or all Chile workspaces) without a fixed hierarchy (PD: CONFIRMED — C-11). There is no agency-specific vocabulary in the structure. Agencies simply name workspaces after clients.

### 16.5 Single-workspace users

An SMB with one workspace never sees the switcher list, All workspaces, or organization concepts beyond Settings › Organization (billing, members). The product feels like a single-brand tool.

### 16.6 Monitor-only workspaces and client guests

- **Monitor-only workspaces** (IA-11) appear in the switcher and in All workspaces with the same four attention signals and a "Monitor-only" label. Their urgent items still count, because the team's job there is to notice and escalate. The overview doesn't change structurally.
- **Client guests** (IA-05) don't see All workspaces or attention indicators. A guest granted more than one workspace can switch between them, and sees only Insights and Reports in each.

---

## 17. Settings architecture

### 17.1 Settings hierarchy (required output F)

```
Settings
│
├── Workspace  (the current workspace)
│   │
│   ├── General ............... name · brand & market labels · time zone
│   │                           · business hours · main language
│   │                           · operating mode: Standard / Monitor-only
│   │                             (Owner and Admin only — IA-11)
│   │                           · default escalation contact (optional; Owner,
│   │                             Admin, Manager — Phase 0C.1, UX-12)
│   ├── Connections ........... connected accounts (Facebook, Instagram, TikTok,
│   │                           ad accounts) · health · coverage · what's available
│   │                           per account · reconnect · who connected it and when
│   │                           (workspace-owned — D-48)
│   │
│   ├── Responding
│   │   ├── Brand Context ..... (§15)
│   │   └── Saved replies ..... (§14)
│   │
│   ├── Moderation ............ automation status & pause · Always protected
│   │                           · auto-hide rules · abuse & insults review
│   │                           · activity (§13)
│   │
│   ├── Members & access ...... who can access this workspace, and their role
│   │                           · client guests (if any)
│   │
│   └── Alerts ................ which workspace alerts exist and who receives them
│                               (channels open — PD OQ-17)
│
├── Organization
│   ├── General ............... organization name · default interface language/locale
│   ├── Workspaces ............ create · rename · archive · brand/market labels
│   ├── Members & roles ....... organization members · invitations · default roles
│   └── Plan & billing ........ plan · usage vs plan limits (conceptual — PD OQ-14)
│
└── Personal  (account menu)
    ├── Profile
    ├── Language & region ..... interface language · date/number formats
    └── My notifications ...... what I'm notified about, personally
```

### 17.2 Organizing rules

- **Workspace before organization:** daily-relevant configuration is closest to the user.
- **Grouped by job, not by system:** "Responding" groups what shapes replies (Brand Context, Saved replies). "Moderation" groups everything about hiding. Connections stand alone because they are about data coverage.
- **Each area shows only to roles that can manage it** (§18). A responder sees Personal, and optionally the Saved replies library, depending on governance (PD OQ-23). Client guests have only Personal, through the account menu (IA-05).
- **Operating mode lives in Workspace › General** because it changes how the whole workspace behaves. Only Owner and Admin can change it, and every change is recorded (IA-11). In Monitor-only workspaces, Settings › Moderation remains readable with rules shown as suspended.
- **No "Advanced" junk drawer.** If something has no clear home, that is an IA defect to fix, not a reason for a miscellaneous page.
- **Topic management** (rename, merge, ignore; PD OQ-10) is expected to live **on topic pages in Insights**, where topics are seen, not in Settings (§23 IA-06).

### 17.3 Capability-aware connections

Settings › Connections is the canonical place for honest coverage (PD: CONFIRMED — C-07):
- Per connected account: what is imported (organic, paid, history depth achieved vs the 30-day target) and which actions are available (reply, private reply, hide, delete, block), shown as available, unavailable (with reason) or limited.
- The wording describes outcomes ("Hiding comments isn't available for this account"), never implementation ("API scope missing").

---

## 18. Role-based visibility

The architecture is identical for all roles. Roles change **what is visible and which actions appear** (PD §11.3, PROPOSED role set).

Four rules decide whether an action appears. They apply in this order:

1. **Role doesn't allow it → hidden.** Permissions are about who the person is. Showing actions they can never use only adds noise.
2. **Workspace is Monitor-only → visible but unavailable, explained** ("This workspace is Monitor-only"). Owners and Admins also see how to change it. The mode is a workspace decision that users need to understand (IA: CONFIRMED — IA-11).
3. **Platform doesn't support it (for this account or content type) → visible but unavailable, explained** in outcome terms, with "Open on [platform]" where useful (capability honesty; PD: CONFIRMED — C-07). A platform limit is never shown by hiding the action. The action may sit in a secondary place, but the capability and its reason stay discoverable.
4. **Temporary connection problem → blocked with a recovery action** (reconnect for roles that manage Connections, "notify an admin" for others). Drafts and selections are preserved.

The rules stay distinct: a permission never shows up as a platform limitation, a platform limitation never shows up as a permission problem, and the workspace mode is always named as the mode. Read-only roles see the same objects without action controls.

| Surface / capability | Owner | Admin | Manager | Responder | Analyst / Viewer | Client guest |
|---|---|---|---|---|---|---|
| Home | ✓ | ✓ | ✓ | ✓ | ✓ (read) | — |
| Inbox: view | ✓ | ✓ | ✓ | ✓ | ✓ (read) | — |
| Platform actions: reply publicly, reply privately, hide/unhide | ✓ | ✓ | ✓ | ✓ | — | — |
| Internal actions: assign, escalate, mark done, notes, correct labels | ✓ | ✓ | ✓ | ✓ | — | — |
| Delete, block | ✓ | ✓ | ✓ | If granted | — | — |
| Undo automatic hides | ✓ | ✓ | ✓ | ✓ | — | — |
| Content & Ads | ✓ | ✓ | ✓ | ✓ | ✓ (read) | — |
| Insights: view (incl. VoC, topics) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (read; representative examples only) |
| Recommendations: view | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (read) |
| Recommendations: accept, dismiss, mark done (IA-09) | ✓ | ✓ | ✓ | — (view only) | — | — |
| Reports | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (read) |
| Settings › Moderation | ✓ | ✓ | ✓ | — | — | — |
| Settings › Brand Context, Saved replies (manage) | ✓ | ✓ | ✓ | Per PD OQ-23 | — | — |
| Settings › Connections | ✓ | ✓ | — | — | — | — |
| Settings › Members & access (workspace) | ✓ | ✓ | — | — | — | — |
| Settings › Organization (workspaces, members) | ✓ | ✓ | — | — | — | — |
| Plan & billing | ✓ | — | — | — | — | — |
| All workspaces and attention indicators (if >1 workspace) | ✓ | ✓ | ✓ | ✓ | ✓ | — (may switch between granted workspaces) |
| Search | ✓ | ✓ | ✓ | ✓ | ✓ | Insights, topics and reports only |
| Alerts | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Change workspace operating mode | ✓ | ✓ | — | — | — | — |
| Default escalation contact | ✓ | ✓ | ✓ | — | — | — |

**Monitor-only applies on top of roles** (IA: CONFIRMED — IA-11). In a Monitor-only workspace, the platform-action rows (platform actions; delete, block; undo automatic hides) become *visible but unavailable* for every role that would otherwise have them. All other rows are unchanged. Roles without those permissions still don't see them at all (rule 1).

**Client guest** (IA: CONFIRMED — IA-05) is a constrained read-only role for agency clients:
- **Navigation:** only Insights (including Voice of Customer, topic pages and read-only Recommendations) and Reports.
- **Evidence:** representative quoted examples only (§10.4).
- **Not available:** Home, Inbox, Content & Ads, full conversation lists or histories, any action, Settings beyond the Personal area, alerts, or organization-level views.
- Letting an agency grant guests more read-only access is a possible future option, not part of the MVP.

---

## 19. Key navigation flows

Conceptual journeys. These show the path through the architecture, not screens.

### A. SMB owner: understand → handle → learn

1. Opens the product and lands on **Home** for their only workspace (no switcher shown).
2. **Needs attention now** says: "9 conversations need a reply. 4 are purchase questions on your active ads."
3. Follows the link into **Inbox › Priority**, already filtered to those four.
4. Opens one. **Why it's here** reads "Purchase question on an active ad · waiting 5h". The **suggested reply** answers with the price from Brand Context, and they send it after a small edit.
5. On another, the suggestion flags "No delivery-time information in Brand Context". They add it in two steps from the link, then reply.
6. Back on Home, **What changed** shows: "Delivery questions are rising on Product X ads." They open the **insight**, read the likely driver, and **accept** the recommendation "Add delivery time to the ad copy".

### B. Community manager: queue → handle → clear

1. Opens **Inbox**; the default **Priority** view, or their saved view "Paid · Unassigned".
2. Works top-down. For each conversation, the detail shows content, paid context, thread and labels.
3. Replies with suggestions or **saved replies**. Hides an abusive reply. **Escalates** a fraud accusation to customer service. Marks items **done**.
4. Checks **Needs review** (ambiguous items, abuse flagged for review, protected items).
5. Reviews **Hidden automatically**, undoing one false positive.
6. The queue is clear: the **inbox-zero** state confirms nothing is waiting and shows when the next update is expected.

### C. Agency paid-media team: portfolio → client → paid comments → recommendation

1. Opens **All workspaces**. "Client B" is flagged with **reputation risk** and a **growing backlog**.
2. Enters Client B's **Home**. **Risks** shows fraud accusations building up under two ads.
3. Switches source scope to **Paid**. Goes to **Content & Ads › Ads & boosted**, sorted by needs attention.
4. Opens the ad's **content profile**: friction is high and complaints concentrate on "delivery". Paid context shows the campaign and the two ads sharing the creative.
5. Clicks **See conversations**, which opens the Inbox filtered to that ad, and reviews examples. Notices delivery complaints, not scams by third parties.
6. In **Insights**, the related insight carries a recommendation ("Investigate delivery issue for Product Y; pause creative messaging that promises 24h delivery"). They **accept** it and it appears in **Reports › Summary** for the client meeting.

### D. Marketing strategist: insight → evidence → driver → action → follow-up

1. Opens **Insights**. Selects "Price questions concentrate in creatives without a visible price".
2. Reviews the **evidence**: counts, comparison window, scope (paid, Instagram and TikTok), and examples in original languages.
3. Opens **See all**, which shows the Inbox scoped to the evidence with status All, to sanity-check the pattern.
4. Reads the **likely driver** and accepts the recommendation "Add starting price to creatives B and D".
5. After the change, marks it **done** with the date.
6. Two weeks later, **Recommendations › Done** shows the **follow-up**: a descriptive before/after for price questions on those creatives, with caveats about known confounders.

### E. Executive or agency client: what changed, why, risk, next steps

1. Opens the product, or a shared report (delivery open, PD OQ-15), and lands on **Reports › Summary** for the last period.
2. Reads: what changed, likely drivers, risks, top VoC themes, recommendations and their status, follow-up results.
3. Opens one item to see its **insight** and representative examples (read-only), then returns. As a client guest, they have no path to the Inbox or Content & Ads (IA-05).
4. Does not need to touch the Inbox or Settings.

### F. New customer: connect → import → coverage → first insight

1. After sign-up, the user creates (or is placed in) their first **workspace**. Home shows the **no connections** state with one clear step: connect accounts.
2. **Settings › Connections**: connects Facebook, Instagram and/or TikTok, plus ad accounts where applicable. Each connection belongs to the workspace (D-48).
3. Home shows **importing history**: progress per account, what's coming, an estimate if available, and what they can do meanwhile (fill in Brand Context essentials).
4. When the import finishes, Home shows a **coverage summary** (e.g. "Instagram: 30 days · Facebook: 30 days · TikTok: 12 days available · ad comments: available for Facebook and Instagram") with honest reasons for gaps.
5. Home shows the first-session **"What we found"**: top topics, top questions, complaints, risks, opportunities, unattended paid conversations, and possibly a suggested auto-hide rule with preview.
6. The user follows the first useful insight or the unattended purchase questions. The loop has begun.

### G. Agency in a Monitor-only workspace: notice → investigate → escalate

1. The agency runs paid media for Client C but not community management, so Client C's workspace is **Monitor-only**. The switcher and All workspaces show the "Monitor-only" label.
2. **All workspaces** flags Client C with **urgent interactions**: obvious spam with malicious links building up under a new ad.
3. In Client C's **Inbox**, the notice explains the mode. In each conversation, **Reply privately**, **Hide**, **Delete** and **Block author** are visible but unavailable, with "This workspace is Monitor-only". The reply area explains that replies happen outside the product.
4. The agency **assigns** the conversations to its account manager, adds a **note**, and **escalates** them so the client's own team can act on the platform. How escalations reach the client depends on PD OQ-17.
5. **Content & Ads** shows the ad's friction and risk. **Insights** carries a recommendation, which appears in **Reports › Summary** for the client.
6. Settings › Moderation shows the matching auto-hide rule as "Suspended — this workspace is Monitor-only". Its preview shows what it would have hidden, which the agency can cite to the client.

---

## 20. Empty, loading and partial-coverage states

Information requirements only. Each state must say **what is happening, why, what it means for the user, and what to do next**.

| State | What must be communicated | Next step offered |
|---|---|---|
| **No connections** | The workspace has no connected accounts, so nothing can be shown yet. What connecting enables. That connections belong to the workspace. | Connect an account |
| **Importing history** | Import in progress per account. What will appear when it completes. An estimate where possible. Partial results may appear early and are labeled as such. | Fill in Brand Context essentials; invite teammates |
| **No interactions** (connected, nothing yet) | Accounts are connected and working, but no comments exist in scope or period. Distinguish "nothing happened" from "something is broken". | Widen the period; check source scope; view connection health |
| **Inbox zero** | Nothing needs handling in this view. When the last update arrived. Optionally, what was handled today. | Check Needs review / Hidden automatically if they have items; go to Insights |
| **No data for filter** | No results for the current filters, and which filters are active. | Clear or relax filters |
| **Platform capability unavailable** | This action or data isn't available for this platform, account or content type, in outcome terms. Not an error. Whether a workaround exists (e.g. "reply in TikTok directly"). | Open on the platform, where relevant |
| **Partial historical coverage** | Which accounts or sources have less than the target history, how much is available, and how this affects trends and insights. Noted on affected insights. | None required; link to Connections |
| **AI uncertainty** | The product isn't confident about this comment's meaning. It has been routed to Needs review instead of being acted on. | Review and label |
| **Failed or revoked connection** | Which account stopped, since when, what is missing as a result (new comments, actions), and who in the workspace can fix it. Data already imported remains. | Reconnect (roles that can manage Connections); notify an admin (others) |
| **Paused automation** | Auto-hide rules are paused, by whom and since when; comments are not being hidden automatically. | Resume (roles that can manage Moderation) |
| **Below minimum volume** | Not enough conversation to identify trends reliably for this scope. Counts and examples are still shown. | Widen the period or scope |
| **Monitor-only workspace** | The workspace is Monitor-only. What that means: no replies, moderation or automation from the product; everything else works. Who can change it. | Owners and Admins: change the mode. Others: none needed |
| **Restricted evidence (client guest)** | The examples shown are representative and support the insight or report. Full conversation lists aren't part of this access. | None |

---

## 21. Naming and terminology

### 21.1 Canonical user-facing vocabulary

| Internal / model term (PD) | User-facing label | Notes and risks |
|---|---|---|
| Organization | **Organization** | Rarely seen. Mostly in Settings and billing. |
| Workspace | **Workspace** | Agencies name workspaces after clients. Customers can't rename the concept (to Client, Account, Brand…). They name individual workspaces as they like (IA: CONFIRMED — IA-13). |
| Brand | **Brand** | A label, not a level. Avoid implying hierarchy ("under Brand"). |
| Market | **Market** | Optional label. Only shown when used. |
| Connected Account / Social Asset | **Connected account**; area: **Connections** | Never "asset", "integration", "token" or "app". |
| Content | **Post**, **Reel**, **Video**, **Ad** (by type); destination **Content & Ads** | "Content" alone is abstract. Name the type wherever possible. |
| Source | **Organic · Paid · Mixed · Unknown**; filter label **"Organic or paid"** | **Never show the word "Source"**: it is ambiguous (source of data? platform?). Mixed is explained as "boosted or used in ads and also organic". |
| Paid context | **Campaign › Ad group › Ad** | Platform names differ (ad set vs ad group). Use one product term and explain once. |
| Interaction | **Comment**, **Reply** | **Never show "interaction"** in the UI. |
| Conversation | **Conversation** | The Inbox's work item. |
| Actor | **Author**; the brand's own messages: **"Your reply"** / account name | Avoid "actor" and "user" (reserved for product users). |
| Classification | **Labels**: **Type**, **Topic**, **Risk**, **Reply needed** | Avoid "classification", "intent", "category" in default UI. |
| Priority reason | **Why it's here** | Short, factual. |
| Insight | **Insight** | Familiar. Always paired with evidence. |
| Recommendation | **Recommendation** | Distinct from "Suggested reply" and "Customer suggestions". |
| Tracked Action | Not shown. Users **mark a recommendation Done** and see its **Follow-up** | Avoid a second "action" concept. |
| AI reply suggestion | **Suggested reply** | Never just "suggestion". |
| Audience "suggestion" category | **Customer suggestions** | Disambiguates from suggested replies and recommendations. |
| Policy | **Auto-hide rule** | "Policy" sounds legal or enterprise. |
| Complaint-protection guard | **Always protected** | User-facing description in §13.2. |
| Kill switch | **Pause all automation** | |
| Moderation actions | **Hide**, **Unhide**, **Delete**, **Block author** | Verbs, not icons alone. |
| Private reply | **Reply privately** | Always with the one-message limitation. |
| Brand Context | **Brand Context** | Keep the name; explain as "what suggested replies can rely on". |
| Saved Reply | **Saved reply** | Avoid "macro", "template", "canned response". |
| Pulse | **Home** | |
| Cross-workspace attention overview | **All workspaces** | |
| Coverage | **Coverage** | "What we can see for this account." |
| Capability | Not shown as a term | Express as outcomes ("Hiding isn't available for TikTok comments here"). |
| Escalation | **Escalate** | |
| Workflow status | **Open**, **Done** (+ resolution) | Minimal (§7.4). |
| Workspace operating mode | **Standard** · **Monitor-only** | Always spelled the same. The explanation is always "This workspace is Monitor-only". Avoid "read-only workspace": internal workflow still works. |
| Client Guest role | **Client guest** | A role name, shown in Members & access. |

### 21.2 Terms to keep consistent across languages

The UI ships multilingual (PD §16). Each canonical term above needs one fixed translation per interface language (ES, PT-BR, EN as proposed in PD OQ-20). Taxonomy labels use stable keys with localized names (PD §16, PROPOSED). Avoid literal translations that collide. For example, Spanish "Sugerencia" must not serve for both "Suggested reply" and "Customer suggestion". The terminology glossary per language is a Core UX / content-design deliverable.

---

## 22. IA anti-patterns: things not to do

1. **Giant sidebar.** Exposing every capability (VoC, Topics, Campaigns, Automation, Saved Replies, Brand Context, Connections…) as equal navigation items. Keep five destinations.
2. **Duplicated analytics surfaces.** Separate "Analytics", "Dashboards", "VoC" and "Reports" areas recomputing the same numbers. One home per kind of looking (§12.1).
3. **Moderation hidden in Settings only.** Rules may live in Settings, but moderation actions and automated results must live in the Inbox.
4. **AI as a disconnected destination.** No "AI Assistant", "AI Insights" or "Copilot" area. AI is embedded where work happens.
5. **Organic and paid as separate products or sections.** Source is a scope and a label, never a product split.
6. **Per-platform sections or inboxes.** "Facebook inbox", "TikTok inbox". Platforms are filters.
7. **A separate agency product or edition.** Agencies use the same workspaces. Only the cross-workspace overview is added, plus the general-purpose Monitor-only workspace mode (§4.3), which any customer can use.
8. **Excessive enterprise configuration.** Approval chains, custom workflow builders, rule engines, custom report or dashboard builders, custom roles, field editors. Out of the MVP (PD: CONFIRMED — C-12; PD §10).
9. **Exposing platform or API implementation details.** Scopes, tokens, webhooks, rate limits, sync jobs. Speak in outcomes.
10. **Sentiment as the primary organizing mechanism.** Positive/negative tabs or sentiment-first dashboards. Organize by what people need and what it means (type, topic, risk) (PD §12.1).
11. **Silent automation.** Auto-hides that can't be seen, explained or undone from one place.
12. **A people/CRM directory.** Author context stays inside conversations (PD §10.1).
13. **A DM inbox through the back door.** No list of private messages, no threads after a private reply (PD: CONFIRMED — C-03).
14. **Portfolio intelligence through the back door.** No aggregated cross-workspace charts, topics or reports in the All workspaces page (PD: CONFIRMED — C-04).
15. **Parallel evidence lists.** Intelligence surfaces link to the Inbox for full lists rather than building their own conversation tables.
16. **Disabled-but-visible actions for permission reasons.** They clutter the UI and confuse users. Permissions hide; the workspace mode and platform limits explain.
17. **Monitor-only as a separate product, inbox or navigation tree.** It is a workspace mode: the same surfaces, with platform actions unavailable and explained.
18. **Silently removing platform actions in Monitor-only.** Users must see that the actions exist and why they're unavailable.
19. **Guest access through the back door.** Shared reports, search or evidence links that expose the Inbox, full conversation lists or Content & Ads to client guests.

---

## 23. Open IA decisions

Only issues that the Product Definition doesn't settle. Locked product decisions are not reopened. **IA-05 and IA-11 were resolved in Phase 0B.1. IA-01, IA-02, IA-03, IA-04, IA-09, IA-10, IA-13, IA-15 and IA-16 were resolved in Phase 0C.1.** IA-06, IA-07, IA-08, IA-12 and IA-14 remain open as recommendations and don't block wireframing.

| ID | Question | Why it matters | Recommendation | Resolve in |
|---|---|---|---|---|
| IA-01 | Is the Inbox work item the **conversation** (thread) or the individual **comment**? | Determines status, assignment, counts and "done" semantics. | **RESOLVED (Phase 0C.1).** The conversation is the work item. Workflow state belongs to it; labels and moderation state may exist per comment or reply. One top-level comment thread is one conversation. | Resolved |
| IA-02 | Is **Reports** a top-level destination, or a view inside Insights? | Navigation size vs a clear executive landing place. | **RESOLVED (Phase 0C.1).** Reports stays top-level in the MVP, narrowly scoped to retrospective, shareable reporting, with no duplication of Insights. Delivery format stays open (PD OQ-15). | Resolved |
| IA-03 | Navigation label: **"Content & Ads"** or **"Content"**? | Paid visibility vs label brevity. | **RESOLVED (Phase 0C.1).** "Content & Ads" is the canonical v1 label. It may still be tested in future UX/content research. | Resolved |
| IA-04 | Final **workflow status** set | Simplicity vs team needs. | **RESOLVED (Phase 0C.1).** Open / Done, with a resolution where applicable. Escalated is a flag on Open conversations. No Waiting or Snoozed. Auto-Done after a successful brand reply or a detected native brand reply, auto-reopen on new audience messages needing attention. Every automatic change is visible and reversible where appropriate (§7.4). | Resolved |
| IA-05 | **Client guest** visibility | Agency client transparency vs privacy and noise. Affects evidence drill-down. | **RESOLVED (Phase 0B.1).** Guests access Insights (including Voice of Customer and read-only Recommendations) and Reports, with representative quoted examples only. No Home, Inbox, Content & Ads, conversation lists or histories, actions, Settings or organization-level views. Extra read-only grants are a future option. | Resolved |
| IA-06 | Where does **topic management** (rename, merge, ignore) live? Depends on PD OQ-10. | Topic hygiene drives insight quality. | On topic pages in Insights (contextual), not in Settings. | After PD OQ-10 |
| IA-07 | Are **Brand labels** applied only to workspaces, or also to connected accounts inside a multi-brand workspace? Related to PD OQ-24. | Multi-brand workspaces need brand-specific Brand Context and filtering. | Allow brand labels on connected accounts in multi-brand workspaces. Content inherits the brand for filtering and Brand Context selection. | Data-architecture phase (with PD OQ-24) |
| IA-08 | Saved replies and Brand Context: workspace-only, or also organization-level shared libraries? | Multi-workspace companies may want shared answers. | Workspace-only in the MVP (consistent with C-11). Shared libraries are a future option. | Later phase |
| IA-09 | Can **Responders** accept, dismiss or mark recommendations done? | Ownership of business actions vs operational roles. | **RESOLVED (Phase 0C.1).** Owner, Admin and Manager accept, dismiss and mark done. Responders view only. No responder-specific recommendation state, signal or workflow. Analyst/Viewer and client guests are read-only. | Resolved |
| IA-10 | **Search scope**: current workspace only, or across workspaces? | Cross-workspace search edges toward portfolio features. | **RESOLVED (Phase 0C.1).** Current workspace only. Switching workspaces is a navigation command. | Resolved |
| IA-11 | **Monitor-only workspace** in the MVP? | Agency protection use case without CM scope. | **RESOLVED (Phase 0B.1); aligned with PD D-49 (Phase 0B.2).** Ships in the MVP as a workspace operating mode (§4.3). All platform actions and platform-changing automation are unavailable and explained. Internal workflow and intelligence are unchanged. Owner and Admin change it. No new product, Inbox or navigation. | Resolved |
| IA-12 | Do content profiles show any **media metrics** (spend, reach)? | Helps relate conversation to distribution; risks ad-management drift and depends on APIs. | No media metrics in the MVP. Conversation metrics only. Revisit after API validation. | After API validation (PD OQ-18) |
| IA-13 | Can organizations rename "Workspace" (e.g. to "Client")? | Agency familiarity vs consistency and support burden. | **RESOLVED (Phase 0C.1).** No. "Workspace" is the canonical term. Individual workspaces can be named after clients or brands. | Resolved |
| IA-14 | **Alerts** surface scope and channels. Depends on PD OQ-17. | Protection value depends on timely alerts. | In-app alerts center (shell) in the MVP. Channels decided with PD OQ-17. | With PD OQ-17 |
| IA-15 | Which **Home** blocks does the Analyst/Viewer role see? | Avoid showing operational items they can't act on. | **RESOLVED (Phase 0C.1).** All Home blocks, read-only. Operational actions remain unavailable per permissions. (Client guests have no Home — IA-05.) | Resolved |
| IA-16 | When a workspace leaves Monitor-only, do auto-hide rules come back **paused** or in their previous state? | Automation must never resume silently (IA-11). | **RESOLVED (Phase 0C.1).** Every rule returns **Paused**. Nothing resumes automatically. Each rule is re-enabled explicitly by a permitted person. Malicious-link and configured-pattern rules require a fresh preview first. | Resolved |

Product-level open questions that affect the IA but aren't IA decisions (PD OQ-14, OQ-15, OQ-16, OQ-17, OQ-23, OQ-24, OQ-25) stay with the Product Definition. This document reserves places for their outcomes without resolving them.

---

## 24. IA acceptance criteria

Before moving to Core UX Flows (Phase 0C), all of the following must be true:

1. **Navigation size:** primary navigation has at most five workspace-level destinations, each with one stated user question (§5).
2. **Every confirmed MVP capability has exactly one canonical home** and documented contextual entry points (Appendix B shows no gaps).
3. **No out-of-MVP capability has a home:** no DM inbox, no cross-workspace intelligence or reporting, no approval chains, no rules engine, no macro system, no people directory, no ad management.
4. **Workspace boundary:** every operational and intelligence surface is workspace-scoped. Cross-workspace elements are limited to the switcher, the All workspaces attention overview and alerts.
5. **Platforms and source:** Facebook, Instagram and TikTok, and Organic / Paid / Mixed / Unknown, appear as labels and filters on Home, Inbox, Content & Ads and Insights, with no per-platform or per-source sections.
6. **Safety visible:** the Always protected boundary is visible in Moderation settings, in rule previews and in conversation reasons. No configuration exists that could auto-hide protected categories or abuse.
7. **Automation reviewable:** every automatic hide is visible, explained and undoable from one canonical place (Inbox › Hidden automatically), and pausing is one action. In Monitor-only workspaces past hides stay visible as history, and undo is unavailable while the mode is on (IA-11).
8. **Private reply bounded:** private reply is a one-shot action with its limitation stated before and after sending, and no DM view exists.
9. **No duplication:** Insights, Voice of Customer and Reports each have a distinct question, and VoC is a lens, not a separate destination.
10. **Evidence reachable:** every aggregate (insight, topic, VoC item, content metric) reaches representative examples in one step and, for roles with Inbox access, the full conversation list in two. Client guests stop at representative examples (IA-05).
11. **Capability honesty:** every action or data type that depends on platform capability has a defined unavailable state in outcome language.
12. **Progressive disclosure defined:** list, detail and on-demand layers are specified for the Inbox and conversation detail.
13. **Role adaptation defined:** the visibility matrix covers all six PD roles, with the four visibility rules (role hides; workspace mode and platform limits explain; connection problems offer recovery).
14. **States defined:** information requirements exist for every empty, loading and partial state in §20.
15. **Vocabulary fixed:** canonical user-facing terms are defined and internal terms ("interaction", "source", "policy", "classification", "tracked action") are kept out of default UI.
16. **Open IA decisions** in §23 have recommendations and owners. IA-05 and IA-11 are resolved (Phase 0B.1). IA-01, IA-02, IA-03, IA-04, IA-09, IA-10, IA-13, IA-15 and IA-16 are resolved (Phase 0C.1). The remaining open decisions don't block wireframing.
17. **No technical architecture:** the document contains no stack, schema, API design or implementation choices.
18. **Client guest bounded:** guests reach only Insights and Reports, with representative examples, and no surface, search result, shared report or link exposes the Inbox, conversation histories or Content & Ads to them (IA-05).
19. **Monitor-only complete:** in a Monitor-only workspace no product action or automation changes anything on a platform. Internal workflow and intelligence work unchanged, the mode is visibly communicated, and no new navigation or Inbox exists for it (IA-11).

---

## Appendix A — Capability → location → persona → rationale (required output G)

| Product capability | User-facing location (canonical) | Contextual entry points | Primary persona | Why it lives there |
|---|---|---|---|---|
| What needs attention now | Home › Needs attention now | Switcher indicators | P1, all | Entry point of the loop |
| Unified prioritized conversation list | Inbox › Priority | Home links | P2, P1 | Daily operational surface |
| Priority explanation | Inbox list + conversation (Why it's here) | Home summaries | P1, P2 | Explanations sit next to claims |
| Multi-dimensional labels | Conversation › Labels (detail; more on demand) | Filters; VoC; Topics | P2, P4 | Labels belong to comments |
| Label correction | Conversation › Labels (on demand) | — | P2, P4 | Correct where seen |
| Public reply | Conversation › Composer | — | P1, P2 | Action on object |
| Suggested reply (AI) | Conversation › Composer | — | P1, P2 | Assistance where work happens |
| Saved replies (use) | Conversation › Composer | Search | P2, P1 | Assistance where work happens |
| Saved replies (library) | Settings › Workspace › Responding › Saved replies | Composer "Manage"; Insights recommendation | P2 lead, Manager | Maintained occasionally |
| Brand Context | Settings › Workspace › Responding › Brand Context | Suggestion gaps; onboarding; unmet-needs insights | P1, Manager | Set up once, maintained occasionally |
| Private reply (one-shot) | Conversation › Secondary actions | — | P2 | Action on object; bounded |
| Hide / unhide | Conversation › Secondary actions | Bulk actions in Inbox | P2 | Action on object; reversible |
| Delete / block | Conversation › Destructive actions | — | Manager, granted responders | Human-only, separated |
| Assign / status / escalate / note | Conversation › Workflow | Inbox bulk actions; Assigned to me / Escalated views | P2, P4 | Workflow belongs to the conversation |
| Needs review queue | Inbox › Needs review | Home | P2 | Human review of uncertain and abuse items |
| Auto-hide rules | Settings › Workspace › Moderation | Home health; first-run suggestion; Insights | Manager, P1 | Configured rarely |
| Always protected (guard) | Settings › Moderation (explanation) | Rule previews; Why it's here; keyword warnings | All | Safety must be visible where it acts |
| Policy preview | Settings › Moderation › rule | First-run suggestion | Manager, P1 | Before activation |
| Automation activity and undo | Inbox › Hidden automatically | Moderation › Activity; Home; Reports › Performance | P2, Manager | One canonical reviewable list |
| Kill switch | Settings › Moderation (Pause all) | Inbox › Hidden automatically header | Manager | Fast, findable |
| Audit / activity history | Conversation › Activity history | Rule state history | P4, Manager | History of the object |
| Content conversation profile | Content & Ads › Content profile | Conversation content header; insights | P3, P2 | Content is its own object |
| Campaign grouping | Content & Ads › Group by campaign | Paid context in conversation | P3 | Organizes paid content |
| Insights | Insights › Insights | Home What changed; content profiles; topic pages | P3, P2, P5 | Intelligence objects |
| Voice of Customer | Insights › Voice of Customer | Home opportunities; content profile; topic page | P3, P5, P1 | A lens over shared data |
| Topics and trends | Topic page (Insights) | VoC; content profiles; search | P3, P4 | Organizing dimension of intelligence |
| Recommendations | Insights › Recommendations | Insight detail; Home Suggested next steps | P3, P1, P5 | Next to their evidence |
| Action follow-up | Recommendation (Done) | Reports › Summary; Home | P3, P5 | Belongs to the recommendation |
| Executive summary | Reports › Summary | Shared link/export (open) | P5, P3 | Period snapshot for stakeholders |
| Operational performance | Reports › Performance | Home Operational health | P2 lead, P4 | Period view of operations |
| Alerts | Shell › Alerts | Home Risks | All | Must reach users anywhere |
| Workspace switching | Shell › Workspace switcher | — | P3, P4 | Global context |
| Cross-workspace attention | Organization › All workspaces | Switcher indicators | P3, P4 | Spans workspaces; minimal |
| Connections, coverage, capabilities | Settings › Workspace › Connections | Home blocking and coverage notices; disabled-action reasons | Admin, P1 | Data coverage configuration |
| Members and roles | Settings › Workspace › Members & access; Settings › Organization › Members & roles | — | Admin, Owner | Administration |
| Brand / Market labels | Settings › Workspace › General; Organization › Workspaces | All workspaces grouping | Admin | Grouping dimensions |
| Language and locale | Account › Language & region; Workspace › General | Translation on demand in conversations | All | Personal vs workspace preferences |
| Plan and billing | Settings › Organization › Plan & billing | — | Owner | Organization concern |
| Search and commands | Shell | — | P2, all | Speed and keyboard-first |
| Workspace operating mode (Standard / Monitor-only) | Settings › Workspace › General | Shell mode indicator; switcher and All workspaces labels; unavailable-action explanations; Moderation shows rules as suspended | Owner, Admin; P3 agency | Changes how the whole workspace behaves (IA-11) |
| Client guest access | Role in Members & access; guest sees Insights + Reports | Shared reports (delivery open, PD OQ-15) | P5 agency client | Constrained read-only role (IA-05) |
| Application entry | Home (one workspace) · All workspaces (several) · Reports › Summary or Insights (client guest) | — | All | Defined in §4.4 (UX-01) |
| Default escalation contact | Settings › Workspace › General | Escalate action pre-selects it | Manager, Admin | Optional; never blocks escalation (UX-12) |

---

## Appendix B — Confirmed MVP capability coverage (required output H)

Every confirmed MVP capability from the Product Definition, and its home. A blank home would be a defect.

| Confirmed MVP capability (PD reference) | Canonical home | Status in IA |
|---|---|---|
| Facebook, Instagram, TikTok as first-class (D-04, D-06) | Labels and filters on all surfaces; Settings › Connections | Covered |
| Organic, paid, mixed, unknown (D-38 / C-05; principle 4) | Persistent source scope; labels; Content & Ads views | Covered |
| Comments and replies (D-07) | Inbox conversations; thread | Covered |
| 30-day initial history target (D-09, D-40) | Onboarding import state; coverage in Connections and Home | Covered (achievability VALIDATE) |
| First-session value / no empty dashboard (principle 7) | Home "What we found" after import | Covered |
| Unified inbox (§9.2-B) | Inbox | Covered |
| Multi-dimensional classification (D-22) | Labels on comments; filters; VoC; topics | Covered |
| Human moderation: hide, unhide, delete, block (§9.2-D) | Conversation actions | Covered (availability VALIDATE) |
| Delete and block human-only (D-19) | Destructive tier, human-only | Covered |
| Public reply (§9.2-D) | Composer | Covered |
| Private reply, one-shot, human-triggered (D-36 / C-03) | Conversation secondary action with limitation | Covered (availability VALIDATE) |
| AI suggested replies, human review/edit → send (D-18, D-45) | Composer | Covered |
| Saved Replies (D-46) | Composer (use); Settings › Responding (library) | Covered |
| Brand Context (D-47) | Settings › Responding; suggestion basis and gaps | Covered |
| Opt-in auto-hide: obvious spam, obvious bots (D-12) | Settings › Moderation | Covered |
| Malicious links and configured patterns, opt-in, hide-only, preview (D-42 / C-09) | Settings › Moderation; rule preview | Covered |
| Abuse flagged for review, never auto-hidden (D-34 / C-01) | Inbox › Needs review; Moderation "Abuse & insults" | Covered |
| Complaint-protection guard (D-35 / C-02) | Always protected (Moderation); previews; Why it's here | Covered |
| Scam content vs accusation separated (D-39 / C-06) | Distinct labels; VoC Complaints vs spam/harmful | Covered |
| Automation reversible, logged, attributed (§9.2-F, PROPOSED) | Inbox › Hidden automatically; activity history | Covered |
| Auditability (§9.2-J) | Conversation activity history; rule state history | Covered |
| Assign, status, escalate, notes (§9.2-D, PROPOSED) | Conversation workflow; Inbox views | Covered |
| Response time / backlog / SLA visibility (§5.2 J-O4) | Reports › Performance; Home health | Covered |
| Intelligence: topics, questions, complaints, objections, praise, suggestions, purchase intent, emerging patterns (§9.2-G) | Insights; VoC lens; topic pages | Covered |
| Insight summaries with evidence (§9.2-G, §14.3) | Insight detail | Covered |
| Recommendations (D-11) | Insights › Recommendations; insight detail; Home | Covered |
| Lightweight action follow-up: accept / dismiss / done + dates; descriptive before/after (D-43 / C-10) | Recommendation; Recommendations › Done | Covered |
| Reporting beyond operational metrics (D-27) | Insights + Reports › Summary + Performance | Covered |
| Content & Ads conversation profiles (UC-10) | Content & Ads | Covered |
| Paid context / campaign attribution where possible (§8.4) | Conversation paid context; Content & Ads grouping | Covered (VALIDATE) |
| Multi-workspace model, workspace as boundary (D-44 / C-11) | Workspace-scoped shell and navigation | Covered |
| Brand and Market as grouping dimensions (D-44) | Labels; All workspaces grouping | Covered |
| Workspace-owned connections (D-48) | Settings › Workspace › Connections | Covered |
| Fast switching + minimal attention overview (D-37 / C-04) | Switcher; Organization › All workspaces | Covered |
| Roles and permissions (§9.2-K, PROPOSED roles) | §18 visibility model; Members & access | Covered |
| Capability-aware, honest coverage (D-40 / C-07) | Connections; disabled-with-reason actions; coverage notices | Covered |
| Multilingual readiness (D-24) | Personal language; workspace language; per-comment language; translations; language-tagged saved replies | Covered |
| Alerts for high-severity situations (§9.2-M, PROPOSED) | Shell › Alerts; Home Risks | Covered (channels open) |
| Monitor-only workspace mode (PD: CONFIRMED — D-49; IA-11) | Settings › Workspace › General; behavior across surfaces per §4.3, §7.8, §8.4, §13.6 | Covered |
| Client guest read-only access (PD §11.3; IA-05) | Insights + Reports with representative examples | Covered |

**Capabilities without a home: none.**

**Confirmed out-of-MVP items checked as absent:** DM inbox management · autonomous AI agent · autonomous delete or block · auto-hide of abuse or protected categories · CRM · publishing or calendar · web-wide listening · influencer management · content creation · cross-workspace aggregated intelligence or reporting · multi-step approval chains · macro system on saved replies · causal attribution · extra client-guest grants · a separate Monitor-only product, Inbox or navigation.
