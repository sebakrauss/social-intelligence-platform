# Intelligence & Conceptual Data Model v1 — Social Conversation Intelligence Platform

| Field | Value |
|---|---|
| Document | Intelligence & Conceptual Data Model v1 |
| Phase | 0D — Intelligence & Conceptual Data Model |
| Version | 1.0 |
| Date | 2026-10-03 |
| Status | **Approved** by the product owner on 2026-10-03 (Phase 0D.1) |
| Sources of truth | `docs/product-definition-v1.md` v1.2 · `docs/information-architecture-v1.md` v1.1 · `docs/core-ux-flows-v1.md` v1.0 (all approved) |
| Scope | The conceptual objects of the product, what they mean, how they relate, where each comes from, and what history, provenance and confidence they must keep. **Not** a database schema, data types, keys, storage, APIs, infrastructure or technology choices. |

### Approval record

| Date | Phase | Decision |
|---|---|---|
| 2026-10-03 | 0D | Intelligence & Conceptual Data Model v1.0 drafted. |
| 2026-10-03 | 0D.1 | Product owner approved the model (v1.0 kept) and confirmed **M-05** (interpretive precedence, interpretations only; source facts are never overridden; deterministic rules stay narrow), **M-07** (uncertain protection vetoes automation) and **M-12** (at most one active Tracked Action per Recommendation in the MVP). Public vs private Outbound Reply semantics were clarified (§36). M-01, M-02, M-03, M-04, M-06, M-08, M-09, M-10 and M-11 remain open. All PD, IA and UX open dependencies remain open. The source documents are unchanged. |

---

## 0. How to read this document

### 0.1 Relationship to the source documents

- The **Product Definition (PD)** says what the product is. The **Information Architecture (IA)** says where things live. **Core UX Flows (UX)** says how users move. This document says **what information exists, what it means and how it connects**, so that all of the above can be built faithfully.
- Nothing here changes a confirmed decision. Citations look like "PD D-35", "IA §7.4", "UX §8.3", "IA-04", "UX-06".
- Status tags are inherited: **(PD: CONFIRMED / PROPOSED / VALIDATE)**, **(IA: CONFIRMED)**, **(UX: CONFIRMED)**. Values the PD marks as proposed (e.g. exact taxonomy values, role set) appear here as **examples, not frozen lists**.
- **[MODEL-REC]** marks a conceptual modeling recommendation made in Phase 0D, part of the approved baseline.
- **(MODEL: CONFIRMED — M-nn)** marks a model decision the product owner locked in Phase 0D.1.
- **M-nn** marks a new open model question (§54).

### 0.2 Language used

- **Object**: a conceptual thing the product knows about (e.g. Conversation). It isn't a table or a type.
- **Assessment**: one interpretation produced by one origin (AI, rule, platform, human) at one point in time.
- **Accepted interpretation**: the interpretation the product currently acts on, selected from assessments.
- **Record / event**: something that happened, kept as history.
- **Scope**: the slice of a workspace something applies to (platform, source, content, topic, period…).
- "Relates to", "belongs to", "is evidence for" describe meaning, not technical references.

---

## 1. Executive model summary

### 1.1 Philosophy

The product turns **public conversations it does not own** into **understanding, decisions and learning it does own**. Facts and interpretations have to stay clearly separated throughout:

```
 WHAT THE PLATFORM SAID        WHAT WE MADE OF IT              WHAT PEOPLE DID ABOUT IT
 ────────────────────────      ─────────────────────────       ──────────────────────────
 source facts                  interpretations                 decisions & actions
 (comment text, author,        (labels, topics, priority,      (replies, moderation,
  timestamps, platform state)   aggregates, insights,           assignment, corrections,
                                drivers, recommendations)       accepted recommendations,
                                                                tracked actions)
        │                               │                                │
        └───────────── provenance + time connect all three ──────────────┘
```

**Five rules hold everything together:**

1. **Source facts are evidence.** They are preserved as received, never overwritten by interpretation.
2. **Every interpretation has an origin** (AI, rule, platform, human), a confidence and a time.
3. **Every intelligence claim points back to evidence**, and through it to source facts, as far as the viewer's role allows.
4. **Every consequential change is an attributable event**: who or what, when, why, from what to what.
5. **Missing or unsupported is never zero.** Coverage and capability are explicit.

### 1.2 Major domains (§2)

Tenancy & access · Connections, capability & coverage · Content & paid context · Conversations, interactions & authors · Understanding (classification, protection, topics) · Operations (workflow, priority, escalation, replies) · Responding context (Brand Context, Saved Replies, suggestions) · Moderation & automation · Intelligence (aggregates, observations, evidence, insights, drivers) · Action & learning (recommendations, tracked actions, follow-ups) · Outputs & attention (reports, alerts, cross-workspace signals). Cross-cutting: **provenance, audit, time**.

### 1.3 From conversation to learning

```
Platform comment ─▶ Interaction (source text + context)
                       │
                       ├─▶ Assessments per dimension (AI / rule / platform / human)
                       │      └─▶ Accepted interpretation ─▶ Protection evaluation
                       │                                        │
                       │                     ┌──────────────────┴─────────────┐
                       │                     ▼                                ▼
                       │            Automation decision               Priority (+ reasons)
                       │            (hide / review / none)            on the Conversation
                       │
                       └─▶ Topic assignments ─▶ Aggregates (scope × window × coverage)
                                                     │
                                                     ▼
                                Observation ─▶ Insight (+ evidence, driver hypotheses)
                                                     │
                                                     ▼
                                Recommendation ─▶ Tracked Action ─▶ Follow-up (descriptive)
                                                     │
                                                     ▼
                                               Report (period snapshot)
```

### 1.4 Why provenance is central

The product's value depends on trust. Users must be able to ask "why is this labeled a complaint?", "why is this hidden?", "why does this insight say delivery questions rose?", "did a person or the AI decide that?". Safety rules such as complaint protection, Monitor-only and "no AI auto-send" can only be verified if every decision carries its origin and inputs. Provenance is what makes the product explainable, correctable and auditable.

### 1.5 Why this is not a schema

This document fixes **meaning**, **relationships**, **origin**, **mutability** and **history requirements**. It deliberately leaves out storage shapes, keys, types, normalization, engines and technology. Technical Architecture decides how to realize these concepts, but it must preserve every invariant in §50 and every requirement in §55.

---

## 2. Conceptual domains

| # | Domain | Contains | Boundary |
|---|---|---|---|
| A | **Tenancy & access** | User, Organization, Workspace, Workspace Membership, Role, Brand, Market, Workspace Operating Mode | Who can see and do what, and in which workspace. No conversation data lives here. |
| B | **Connections, capability & coverage** | Social Platform, Social Asset, Connection, Connected Account, Capability Profile, Coverage Record | What external presences we're linked to, what we can do through them, and how much we can see. |
| C | **Content & paid context** | Content Item, Content Source Classification, Campaign, Ad Group, Ad (Paid Placement) | What conversations are *about* and how that content was distributed. Paid context supports content; it is never the primary object. |
| D | **Conversations, interactions & authors** | Conversation, Interaction, Source Text Version, Language Assessment, Translation, Author, Author Block State | The conversational source material, normalized. |
| E | **Understanding** | Classification Assessment (per dimension), Accepted Interpretation, Protection Evaluation, Topic, Topic Assignment | What each interaction means, with provenance and confidence. |
| F | **Operations** | Workflow State, Resolution, Assignment, Priority Assessment, Escalation, Internal Note | Getting conversations handled. Never mixed with moderation state. |
| G | **Responding context** | Brand Context (sections, items), Saved Reply (and language versions), Suggested Reply, Outbound Reply | What the product and people say back, and what they are allowed to rely on. |
| H | **Moderation & automation** | Moderation State, Moderation Event, Moderation Policy, Policy Preview, Automation Decision | Changing visibility on platforms, by people or opt-in policies, under safety vetoes. |
| I | **Intelligence** | Aggregate, Observation, Evidence (items and sets), Insight, Driver Hypothesis, Implication, Statistical State | Turning many interactions into trustworthy, explainable claims. |
| J | **Action & learning** | Recommendation, Tracked Action, Follow-up | Turning claims into business changes, then describing what happened afterwards. |
| K | **Outputs & attention** | Report, Alert, Workspace Attention Signal | Period snapshots, attention signals, minimal cross-workspace awareness. |
| X | **Cross-cutting** | Provenance, Audit Event, temporal markers | Applies to every domain above. |

**Simplification note:** Configuration isn't a separate domain. Each piece of configuration lives with what it configures: operating mode in Tenancy, policies in Moderation, Brand Context and Saved Replies in Responding context, default escalation contact in Operations. This mirrors the IA's "grouped by job, not by system" rule (IA §17.2).

---

## 3. Canonical conceptual hierarchy

```
User ─── member of (role per workspace) ───┐
                                           ▼
Organization ──────────────────────────────────────────────── Workspace Attention Signals
  │                                                            (one per workspace, minimal)
  └── Workspace  [operating mode: Standard | Monitor-only]
        │  labels: Brand(s) · Market            ← grouping/context dimensions, not levels
        │
        ├── Connection ──exposes──▶ Social Asset(s)  (external identity)
        │     └── Connected Account  (asset linked into this workspace)
        │           ├── Capability Profile  (per content type / capability)
        │           └── Coverage Records    (per source / time range / capability)
        │
        │           Content Item ◀──belongs to── Connected Account
        │             │  source: Organic · Paid · Mixed · Unknown  (content-level, C-05)
        │             │◀──placed by── Ad ◀── Ad Group ◀── Campaign   (paid context, partial)
        │             │                 (one Content Item ⇄ many Ads)
        │             │
        │             └── Conversation  (one top-level audience comment thread)
        │                   │  workflow: Open/Done · resolution · assignee · escalation
        │                   │  priority (+ reasons)
        │                   │  outbound replies: public → may become a brand Interaction;
        │                   │                    private → record + history marker only
        │                   │
        │                   └── Interaction (comment | reply)
        │                         │  source text versions · language · translations
        │                         │  author ──▶ Author (platform-scoped)
        │                         │  moderation state (visible/hidden/deleted/unknown)
        │                         ├── Classification Assessments  (per dimension, history)
        │                         │     └── Accepted Interpretation ─▶ Protection Evaluation
        │                         └── Topic Assignments ⇄ Topic   (many-to-many)
        │
        ├── Topics (workspace-scoped; system and customer topics)
        │
        ├── Aggregates (scope × window × coverage)
        │     └── Observations ─▶ Insights ⇄ Evidence ⇄ Interactions / Conversation sets
        │                           ├── Driver Hypotheses (0..many, with confidence)
        │                           └── Recommendations ─▶ Tracked Actions ─▶ Follow-ups
        │
        ├── Reports (Summary | Performance, per period; reference insights & evidence)
        ├── Alerts (attention signals for recipients)
        ├── Moderation Policies (+ previews, automation decisions)
        ├── Brand Context · Saved Replies · default escalation contact
        └── Audit Events (everything consequential)
```

**Important many-to-many relationships:** Interaction ⇄ Topic · Content Item ⇄ Ad · Insight ⇄ Evidence ⇄ Interaction · Insight ⇄ Recommendation (a recommendation may draw on several insights) · Report ⇄ Insight/Recommendation · Suggested Reply ⇄ Brand Context items.

---

## 4. Identity & tenancy model

| Concept | Definition | Notes |
|---|---|---|
| **User** | A person who signs in to the product. | Has personal settings (interface language, locale). Personal identity is not tied to any social platform. |
| **Organization** | The customer entity: owns workspaces, members, plan and billing. | Agencies and businesses use the same concept (PD D-23). |
| **Workspace** | The **primary operational, access and intelligence boundary** (PD D-44 / C-11). | Every conversation, interpretation, insight, recommendation, report, policy, Brand Context item and saved reply belongs to exactly one workspace. Intelligence is never computed across workspaces (§39). |
| **Workspace Membership** | The link between a User and a Workspace, carrying that user's **Role in that workspace**. | A user can have different roles in different workspaces (IA §3.2). Organization-level roles cover organization settings. |
| **Role** | A named bundle of permissions: Owner, Admin, Manager, Responder, Analyst/Viewer, Client guest (PD §11.3, PROPOSED set; IA §18). | Permission rules are confirmed per IA §18 / IA-09. The role set itself stays as proposed in the PD. |
| **Brand** | A grouping and context dimension for a workspace (and possibly for connected accounts within it, IA-07 open). | Not a containment level. Used for grouping, filtering and Brand Context applicability. |
| **Market** | An optional grouping dimension (country or region). | Not a core concept. No country-specific logic in the core model (PD §16). |
| **Workspace Operating Mode** | A workspace property: **Standard** or **Monitor-only** (PD D-49; IA-11). | A changeable state with history (who changed it, when). It vetoes every platform mutation and platform-changing automation while Monitor-only (§19). The creation-time choice is optional (UX-02). |
| **Default Escalation Contact** | An optional workspace setting naming an internal escalation owner (UX-12). | Never required for escalation. |

**Agencies and businesses** use identical concepts. An agency's client is a workspace, and a company's brand or market is a workspace (PD C-11). There is no agency-specific object.

---

## 5. Social connection model

Three things must stay separate:

| Layer | Concept | Meaning |
|---|---|---|
| **A. External identity** | **Social Asset** | A presence that exists on a platform independently of us: a Facebook Page, an Instagram professional account, a TikTok account, an ad account. It has a platform identity and a display name *as reported by the platform*. |
| **B. Our authorization** | **Connection** | The authorization a person granted, on behalf of a workspace, that lets the product access one or more Social Assets. It has an authorizing user and time, a health state, and an owning workspace (PD D-48). |
| **C. What's in use** | **Connected Account** | A Social Asset that the workspace has brought in through a Connection. Content, conversations, capabilities and coverage hang from it. |

| Concept | Key conceptual properties |
|---|---|
| **Social Platform** | Facebook, Instagram, TikTok (PD D-04). Extensible to others without new concepts (PD §20.1). |
| **Social Asset** | Platform, asset kind (page/profile/business account/ad account; exact kinds VALIDATE), platform-reported identity and name. Can be related to other assets (e.g. an ad account associated with a page) when the platform exposes it. |
| **Connection** | Owning workspace · authorizing user (provenance) · authorization time · **health**: connecting · active · degraded (some capabilities failing) · revoked/disconnected · failed · removed by user · last successful contact time. **No credentials or tokens are modeled here.** |
| **Connected Account** | Owning workspace · the Social Asset · the Connection(s) it came through · when it was added · its Capability Profile · its Coverage Records. |
| **Ad-account relationship** | An ad-account Social Asset linked to content-bearing assets where the platform exposes it. This enables paid context and paid-comment access (VALIDATE, PD A-02). |

**Ownership:** connections and connected accounts belong to the **workspace** (PD D-48). The authorizing user is kept as provenance ("connected by Ana on Oct 3"), never as the owner. Whether an authorization stays valid after that person leaves is VALIDATE (PD OQ-26).

**Same asset in several workspaces:** not settled by the sources. See **M-01**.

---

## 6. Platform capability model

A **Capability Profile** answers: *for this connected account (and content type), can the product do X right now, and if not, why?*

### 6.1 Dimensions

Capability is evaluated per **platform × connected account × content type × capability**, adjusted by **connection health**.

Example capabilities (illustrative; actual availability is VALIDATE, PD OQ-18):

| Capability | Example |
|---|---|
| Import organic comments | read comments/replies on posts |
| Import paid comments | read comments on ads |
| History depth | how far back the import can reach |
| Reply publicly | publish a brand reply |
| Reply privately | one-shot private reply (PD D-36) |
| Hide / Unhide | change visibility |
| Delete | remove a comment |
| Block | block an author |
| Paid context retrieval | link content to campaign / ad group / ad |
| Detect native brand replies | see replies the brand made outside the product |

### 6.2 Capability states

| State | Meaning | UX consequence (UX §25) |
|---|---|---|
| **Supported** | Officially available for this account and content type. | Available (subject to role and mode). |
| **Available with limitation** | Supported with a known restriction (e.g. reduced history depth, a semantic difference such as who still sees a hidden comment). | Available with a stated caveat. |
| **Unsupported** | The platform doesn't offer it for this account or content type. | Visible but unavailable, with the reason and "Open on [platform]". Never hidden (IA v1.1 §18). |
| **Unknown / not validated** | Not yet validated. Treated as unavailable for promises (PD C-07). | Visible but unavailable ("not available yet"). |
| **Temporarily unavailable** | Normally supported, but blocked by connection health or a platform outage. | Blocked with a recovery action. |

Each capability state carries **why** (reason in outcome language) and **as of when** (last verified). Capability is never inferred from data volume: no comments on ads doesn't mean ads are unsupported, and vice versa (§7).

---

## 7. Coverage model

**Coverage Record** is a first-class concept that answers: *how much of the relevant reality can we see for this scope, and how do we know?*

### 7.1 Coverage applies to

- a connected account / platform
- a source (organic, paid)
- a historical time range (e.g. the 30-day import target, PD D-09)
- a content item (e.g. comments on this ad)
- a capability (e.g. native-reply detection)

### 7.2 Coverage states

| State | Meaning |
|---|---|
| **Complete (for known capability)** | Everything the validated capability allows was obtained for this scope. |
| **Partial** | Only part was obtained (e.g. "12 of 30 days"). The extent is stated. |
| **Unavailable** | The capability doesn't exist for this scope (links to the Capability Profile). |
| **Not requested** | The customer didn't connect it (e.g. no ad account connected). |
| **Importing** | In progress; early results are labeled as such (UX §5.4). |
| **Failed** | Attempted and failed; reason stated; may be retried. |
| **Unknown** | Can't be determined. |

Every coverage record has: scope, state, extent where meaningful, reason, as-of time.

### 7.3 How coverage flows into everything else

| Consumer | Effect |
|---|---|
| **Aggregates** | Every aggregate carries the coverage of its scope. Values computed on partial coverage are marked partial. Values on unavailable or unknown coverage are **not available**, never zero. |
| **Observations / Insights** | Coverage caveats are attached ("TikTok history covers 12 of 30 days") (IA §10.5). An insight may be withheld if coverage makes it misleading. |
| **Trends / comparisons** | A comparison is only valid if both windows have comparable coverage. Otherwise its statistical state is **comparison unavailable** (§49). |
| **Recommendations** | Inherit their insight's coverage caveats. |
| **Reports** | State coverage for the period at the top (UX §22.5). |
| **Empty states** | Distinguish "nothing happened" (complete coverage, zero items) from "we can't see" (unavailable, not requested, failed, unknown) (IA §20; UX §26). |

**Critical rule: NO DATA ≠ ZERO.** A count of zero is only shown when coverage for that scope is complete or partial-with-known-extent and nothing was found. Otherwise the value is "not available", with a reason.

---

## 8. Content model

**Content Item**: the object conversations happen around.

| Aspect | Model |
|---|---|
| **Kinds** | Post, reel, video, carousel, story (if supported), ad-only creative, other supported content (illustrative; exact kinds VALIDATE). |
| **Belongs to** | One Connected Account (on one Social Platform), in one Workspace. |
| **Source facts** | Platform identity, author account, publish time, caption/text (original language), media reference, platform-reported state (available / removed / restricted). |
| **Source classification** | **Organic · Paid · Mixed · Unknown**, determined primarily at the **content level** (PD D-38 / C-05). |
| **Paid context** | 0..many Ads placing this content (§9). |
| **Contains** | Conversations (one per top-level audience comment thread). |

### 8.1 Content source classification

- It is an **interpretation with provenance**:
  - platform-provided (the platform says it's an ad);
  - inferred from paid context (an ad references this content, which makes it Paid or Mixed);
  - defaulted (Unknown).
- It **changes over time**. Organic content later boosted becomes Mixed. History is kept so the product knows what was true when (§42).
- **Inheritance:** interactions and conversations take their **effective source** from their content "where appropriate". How interactions that predate a boost are treated is **M-02**.
- **Mixed** is never forced into organic or paid. Breakdowns report Mixed separately (UX §19.4).

### 8.2 One content, many placements

A single Content Item can be used by several Ads (PD §8.4, PROPOSED). Conversations and interactions belong to the **content**, so they're never duplicated per ad. Paid placements are related *to* the content. Aggregates "by ad" attribute through this relationship and state when attribution is ambiguous (§9).

---

## 9. Paid context model

| Concept | Meaning |
|---|---|
| **Campaign** | A platform campaign, normalized to one product concept across platforms. |
| **Ad Group** | The normalized middle level (platform names vary: ad set, ad group). |
| **Ad (Paid Placement)** | A paid placement that **distributes** a Content Item. It belongs to an Ad Group and an ad account. |
| **Creative relationship** | Ad → Content Item. Many Ads may point to one Content Item. |

Principles:

- **Content identity ≠ distribution.** The content is *what people commented on*. The ad is *how it reached them*. Conversations attach to content, and paid context explains reach.
- **Attribution can be partial.** For each content item, the model records **paid-context coverage**: linked, partially linked, unavailable, or unknown (VALIDATE, PD A-02). When unavailable, the UX shows "Ad details aren't available" (IA §8).
- **Comment-to-ad attribution:** when several ads share one content item, the platform may not say which ad produced a comment. The model must allow "attributed to the content, ad unknown" rather than guessing.
- **Supporting context only:** campaigns, ad groups and ads are **read-only context**. No budgets, bids, edits or media metrics in the MVP (PD §10.2; IA-12 open).

---

## 10. Conversation model

**Conversation**: the **Inbox work item** (IA-01): one top-level audience comment and every reply beneath it, including brand replies made in the product or natively. It belongs to one Content Item.

| Aspect | Model |
|---|---|
| **Anchor** | The top-level audience Interaction that starts it. |
| **Members** | All public Interactions in the thread (audience and brand). |
| **Private reply markers** | History markers for private replies sent from this conversation (§36). They are never Interactions. |
| **Workflow state** | **Open** or **Done** (IA-04). |
| **Resolution** | Recorded when Done, where applicable: replied publicly · replied privately · replied on platform · no reply needed · moderated · reviewed (Monitor-only) · escalation closed (UX §8.3). |
| **Assignee** | A workspace member, or none. |
| **Escalation** | 0..1 open Escalation at a time, with history of past escalations (§32). |
| **Priority** | A derived Priority Assessment with reasons (§30). |
| **Notes** | Internal notes (human-authored, workspace-internal). |
| **Effective source** | Inherited from the content (§8.1). |
| **Needs-handling summary** | Which member interactions still need a reply or review (derived). |

### 10.1 Lifecycle

```
   new top-level audience comment
              │
              ▼
           ┌──────┐   reply sent & nothing else needs handling (auto, reversible)
           │ OPEN │──────────────────────────────────────────────┐
           └──┬───┘   native brand reply after latest audience   │
              │       message & nothing else (auto, reversible)  │
              │       user marks Done (+ resolution)             ▼
              │                                              ┌──────┐
              │◀──── new audience message needing handling ──│ DONE │
              │      (auto-reopen) · user reopens · Undo     └──────┘
```

**No Waiting or Snoozed** (UX-05). Every automatic transition is an attributable event (initiator: "system (auto-done)" / "system (auto-reopen)"), visible and reversible where appropriate (IA-04).

### 10.2 Separation of states

Conversation workflow state ≠ moderation state of its interactions ≠ escalation state ≠ priority ≠ recommendation state. A Done conversation can contain a hidden comment. An Open conversation can be escalated. Hiding a comment never changes workflow state by itself. Only a resolving action or rule does (UX §13.2).

---

## 11. Interaction model

**Interaction**: one unit of communication. In the MVP it is a **Comment** (top-level) or a **Reply** (PD D-07). The concept is extensible to direct messages, mentions and reviews later without restructuring (PD §8.2). No DM object exists in the MVP.

| Must preserve | Notes |
|---|---|
| **Original text** (source text versions) | Canonical evidence, as provided (§13). |
| **Original language** | A Language Assessment, possibly uncertain or mixed. |
| **Author** | A platform-scoped Author (§12). |
| **Parent** | The Interaction it replies to (for replies). |
| **Conversation and content** | The Conversation it belongs to, which belongs to a Content Item and Connected Account. |
| **Platform timestamps** | When created on the platform, as reported. Edits too, where known. |
| **Source platform state** | Available / hidden at source / removed at source / unknown, as last observed. |
| **Moderation state** | Product's view of visibility, with history (§18). |
| **Kind of authorship** | Audience · own brand account (a public reply sent via the product, or made natively) · other / unknown. Private replies are never Interactions (§36). |
| **Assessments** | Classification assessments per dimension and topic assignments (§14–§16, §21). |

**Units of work:**

| Interaction is the unit of… | Conversation is the unit of… |
|---|---|
| classification and its correction | workflow (Open/Done, resolution) |
| moderation (hide/unhide/delete) | assignment |
| protection evaluation and automation decisions | escalation |
| evidence examples | priority |
| topic membership | "Why it's here" |

---

## 12. Author model

**Author**: the platform-scoped account that wrote an interaction.

| Aspect | Model |
|---|---|
| **Identity scope** | **Platform-scoped and workspace-scoped.** The same person on Instagram and TikTok is two Authors. There is no cross-platform or cross-workspace identity resolution in the MVP (PD §10.2). |
| **Kinds** | Audience member · the brand's own account (a Connected Account's identity) · other brand / page · unknown. |
| **Authenticity** | Assessed per interaction (signal). Optionally summarized per author within the workspace (e.g. "likely bot") (**M-06**). |
| **History** | "Earlier comments by this author in this workspace" is derived from interactions with reliable attribution only (IA §8). |
| **Block state** | Author Block State is per Author **per connected account / platform context**, not per conversation. It changes through human block/unblock events (unblock deferred, UX-09). |

**Not a CRM:** no person profiles, contact details, real-world identity inference, enrichment or cross-workspace tracking (PD §10.1; IA §5.3).

---

## 13. Source text, translation and language model

| Concept | Rule |
|---|---|
| **Source Text Version** | The text exactly as the platform provided it. If the platform reports an edit, a new version is added and earlier versions are kept. The original version is never overwritten (**M-09**). |
| **Language Assessment** | Detected language(s) with confidence. May be *mixed* (code-switching) or *uncertain*. Has provenance (AI or human correction). |
| **Display Translation** | A derived rendering of a source text into the reader's language, on demand. It is never evidence on its own, never replaces the original, and carries its own provenance (machine-translated, as of when). |
| **Reply language** | Outbound replies record the language they were written in. Suggested replies record their target language (the commenter's language by default) (UX §10). |
| **Cross-language understanding** | Classifications and topics are language-independent (stable meanings with localized labels, PD §16). Evidence always shows the **original** text first, with translation available (IA §10.4). |

Translation vendor and method are out of scope.

---

## 14. Classification model

**Classification** is a set of **dimensions**, each holding its own assessments and accepted interpretation (PD D-22). It is never a single label or score.

| Dimension | Purpose | Example values (PD §12, illustrative where PD is PROPOSED) | Multi-value? | Human correction? | Confidence matters? |
|---|---|---|---|---|---|
| **A. Safety / moderation** | Is this harmful content that may warrant moderation? | none · obvious spam · malicious link · scam/fraud content (third-party) · impersonation · abuse/insult · harassment · threat | Yes (e.g. spam + malicious link) | Yes | **Critical**: drives automation eligibility |
| **B. Authenticity** | Is the author likely real? | likely human · bot-like · obvious bot · unknown | No (one per interaction) | Yes | Critical for "obvious bot" automation |
| **C. Intent** | What is the person trying to do? | purchase question · product question · service question · complaint · product/service problem · fraud accusation against the brand · price objection · other commercial objection · praise · advocacy · suggestion · neutral conversation | **Yes** (e.g. purchase question + price objection) | Yes | Yes |
| **D. Sentiment** | Emotional polarity | positive · neutral · negative · mixed | No | Yes | Moderate. **Never** drives moderation (PD principle 1) |
| **E. Topic membership** | What is it about? | Topics (§21) | **Yes** | Yes | Yes |
| **F. Risk / severity** | How harmful if ignored? | low · medium · high · critical (incl. reputation risk) | No (a level) with reasons | Yes | Yes |
| **G. Response need** | Does it need a reply or action? | no response needed · response recommended · response required · escalation required | No | Yes (user override, IA §7.4) | Yes |
| **H. Language** | What language(s)? | es · pt-BR · en · mixed · unknown … | Yes (mixed) | Yes | Yes |

Rules:

- **Dimensions are independent.** A complaint can be negative, high-risk and response-required at once, while having *no* safety label. Spam can be "positive" in sentiment (PD §12.1).
- **Scam/fraud content and fraud accusation are separate meanings in separate dimensions** (Safety vs Intent) and must never collapse into one label (PD D-39).
- **"Ambiguous / needs review"** is a confidence state (§16), not a category of its own.
- **Final value lists are not frozen.** The PD taxonomy is a starting set (PD D-21). The model requires stable, language-independent meanings with localized labels (PD §12.4).

---

## 15. Classification provenance

### 15.1 Assessments

Every dimension of an interaction can have several **Classification Assessments**. Each one records:

- **Origin:** AI-generated · deterministic product rule (e.g. link-reputation check) · platform-provided signal · human-authored · human correction.
- **Value(s)** and **confidence** (§16).
- **Reasoning summary** (a short explanation for the UI: "asks how to buy").
- **Inputs considered:** which source text version, which context (thread, content, Brand Context where relevant).
- **Method identity:** which model, rule set or policy version produced it, conceptually, so results can be traced and compared over time.
- **Time.**

### 15.2 Accepted interpretation

For each dimension, the product acts on one **Accepted Interpretation**, selected from the assessments by a precedence rule.

**Interpretive precedence (MODEL: CONFIRMED — M-05):**
1. **Human correction / human-authored interpretation**: always wins, until a later human correction.
2. **Deterministic product rule**, **only for the narrow fact or meaning the rule actually establishes**.
3. **AI / model assessment.**
4. **Platform-provided interpretive hint.**

**Scope of the precedence: interpretations only.** It never allows a human, rule or AI assessment to overwrite **canonical external source facts**: original platform text, source timestamps, platform object identity, observed platform state, paid context as reported by the platform, or any other external canonical fact. Source facts and interpretations stay in separate domains (§1.1, §43). A wrong source fact is handled by a new platform observation, never by an interpretation.

**Deterministic rules stay narrow.** A validated malicious-link check establishes "this URL is known malicious". It does **not** by itself establish "this whole comment is spam". That meaning needs its own supporting assessment (e.g. an AI spam assessment). A rule's precedence applies only to the dimension and value it actually determines.

### 15.3 History is never erased

A correction creates a new human assessment and changes the accepted interpretation. The previous AI assessment, its reasoning and the correction itself all remain, attributed and timed (PD §12.4; UX §16). The model distinguishes:

- **Current accepted interpretation**: what the product acts on now.
- **Assessment history**: everything ever asserted about this interaction, by whom, when and why.

A re-assessment (e.g. a newer model, an edited source text) adds an assessment. It never silently replaces a human correction.

---

## 16. Confidence model

There is no single universal confidence score. Confidence is **per object and per dimension**:

| Object | Confidence about… |
|---|---|
| Classification dimension | the label(s) on one interaction |
| Language assessment | the detected language |
| Topic assignment | membership of the interaction in a topic |
| Protection evaluation | whether protected meaning is present |
| Observation / Insight | the strength of the pattern (§49) |
| Driver hypothesis | the plausibility of the explanation |
| Recommendation | inherited from its insight and driver |

**Qualitative states** used across the product (numeric thresholds are later decisions, PD OQ-16, OQ-28):

| State | Meaning | Typical behavior |
|---|---|---|
| **High** | Reliable for operational use. | Eligible for automation (where otherwise allowed). |
| **Medium / usable with caveat** | Useful but not certain. | Shown with a caveat. Never eligible for automation. |
| **Low / needs review** | Uncertain. | Routed to Needs review (UX §8.2). No automatic action. No automatically prepared suggestion (UX §10.4). |
| **Insufficient evidence** | Not enough information to judge. | Not shown as a claim. Counts and examples only (§49). |

---

## 17. Complaint-protection model

This is a structural safety mechanism (PD D-34, D-35, D-42; IA §13.4; UX §14.7).

### 17.1 Protected meanings

A **Protection Evaluation** is derived for each interaction from its accepted interpretation. It answers: *does this interaction carry protected meaning?*

Protected meanings (PD D-35):
- legitimate complaint
- product/service problem
- fraud/scam accusation **against the brand**
- commercial objection (price or other)

The Protection Evaluation records:
- **result**: protected · not protected · **uncertain**
- **which** protected meanings are present
- **evidence**: which assessments and origins support it
- **time** and **provenance**

### 17.2 Decision path

```
Classification assessments ─▶ Accepted interpretation (per dimension)
                                        │
                                        ▼
                              Protection Evaluation
                     (protected / not protected / uncertain)
                                        │
                                        ▼
                              Automation eligibility (§19)
       protected  → VETO (never auto-hidden; route to Needs review where a rule matched)
       uncertain  → VETO (fail-safe: Needs review)   (MODEL: CONFIRMED — M-07)
       not protected → may continue to the next checks
```

### 17.3 Rules

- **Keywords are never meaning.** A configured pattern matching "scam", "fraud", "estafa" or "golpe" produces a **candidate match**, not a moderation decision. If the interaction is a fraud accusation against the brand, protection vetoes automation (PD D-42; UX-10).
- **Abuse doesn't remove protection.** "You idiots stole my money" is abusive *and* a complaint. Protection wins (PD D-34).
- **Fail-safe (MODEL: CONFIRMED — M-07):** if the product can't determine with adequate confidence whether an interaction carries protected meaning, the result is **Uncertain**. For automation, Uncertain is a **safety veto**: no auto-hide, and the interaction goes to Needs review where relevant. Silence, missing evidence or classification uncertainty never count as permission to automate. This applies only to automation safety. It doesn't prevent a permitted human from moderating the interaction individually.
- **Human moderation is not vetoed.** People can still hide or delete a protected comment deliberately and individually (PD D-35), with an informational caution (UX §13.2). Protection only governs **automation** and **human bulk hide** (UX-06).

---

## 18. Moderation state model

**Moderation State** belongs to each **Interaction** (per-comment), separate from conversation workflow.

| State | Meaning |
|---|---|
| **Visible** | Publicly visible as far as we know. |
| **Hidden** | Hidden on the platform (semantics vary by platform, VALIDATE, PD A-04). |
| **Deleted** | Removed from the platform. Our record remains per retention policy (PD OQ-21). |
| **Removed at source / unavailable** | No longer available on the platform for reasons outside the product (author deleted it, platform removed it). |
| **Unknown** | Current platform state can't be determined (e.g. the connection is unhealthy). |

Every transition is a **Moderation Event** with:
- **initiator**:
  - a human (single or bulk; bulk hides are always human, UX-06)
  - an automation policy (auto-hide)
  - a native platform change (detected)
  - unknown
- reason (e.g. classification + policy, or a human's choice), time, previous and new state, and reversibility.

Semantics:
- **Hide ↔ Unhide** are reversible where supported. Undoing an automatic hide is an Unhide event attributed to the human, linked to the original automation decision (a false-positive signal, UX §14.4).
- **Delete** is irreversible on the platform.
- **Block** applies to the **Author** in a platform/account context (§12), not to the interaction or conversation.
- **Capability-dependent:** each moderation action exists only where the Capability Profile supports it. Otherwise it is "unavailable with reason" (UX §25).
- **Monitor-only** produces no product-initiated moderation events. Native platform changes are still observed and recorded.

---

## 19. Automation eligibility model

A **conceptual safety decision**, not implementation logic. Each time an opt-in policy considers an interaction, the product records an **Automation Decision** with its full chain:

```
1. Candidate        a Moderation Policy's criteria match the interaction
   rule match       (obvious spam · obvious bot · malicious link · configured pattern)
        │
        ▼
2. Understanding    spam / bot / link policies: accepted interpretation supports that harmful
                    category (safety / authenticity dimensions)
                    configured patterns: the customer-defined, previewed pattern defines the
                    target, AND the interaction must be confidently understood (not ambiguous)
                    — a keyword match alone never suffices; sentiment never counts
        │
        ▼
3. Protection       Protection Evaluation: protected or uncertain → VETO → Needs review (M-07)
   guard
        │
        ▼
4. Confidence /     high confidence required; abuse/insult → never eligible (review only, D-34);
   eligibility      category must be one of the four eligible types (D-12, D-42)
        │
        ▼
5. Workspace mode   Monitor-only → VETO (policy is Suspended; no platform mutation)
        │
        ▼
6. Platform         Hide supported & connection healthy? no → no action (reason recorded);
   capability       temporarily unavailable → no action, retry/recovery per policy
        │
        ▼
7. Outcome          HIDE (hide-only; never delete or block)  │  NEEDS REVIEW  │  NO ACTION
```

The Automation Decision keeps: policy, interaction, each step's result, the veto reason if any, outcome, time, and resulting Moderation Event (if hidden). This is what powers:
- "Excluded by Always protected" in previews (IA §13.3)
- "Why was this hidden?" in Hidden automatically
- precision tracking when users Undo (UX §14.4)
- audit

**Never eligible:** protected meanings, abuse/insults (MVP), anything with medium or low confidence, any workspace in Monitor-only, sentiment-based or keyword-only matches.

**Bulk hide is not automation:** human bulk hide produces human Moderation Events. It applies the protection exclusion (protected interactions are excluded and counted, UX-06) but produces no Automation Decisions.

---

## 20. Moderation Policy model

**Moderation Policy**: a customer-enabled, workspace-scoped, opt-in rule for automatic **hide only** (PD D-12, D-42). It is not a rules engine (IA §13.4).

| Aspect | Model |
|---|---|
| **Policy type** | Obvious spam · Obvious bots · Malicious links · Configured pattern (the only four; abuse is "Always sent to review", not a policy type) |
| **Scope** | All content / paid only / organic only; accounts or platforms (where hide is supported) |
| **Pattern definition** | For configured-pattern policies: the customer's terms or patterns, plus a **protected-overlap warning** state (UX-10) |
| **State** | **Off** (default) · **On** · **Paused** (a user's choice) · **Suspended** (a workspace condition: Monitor-only) |
| **Preview** | A **Policy Preview**: matches over imported history, split into *would hide* and *excluded by Always protected*, as of a time, over a coverage-stated window. **Required before activation** for malicious-link and pattern policies (PD D-42). Offered for spam and bots. |
| **Activity** | Its Automation Decisions and resulting hides; undo counts. |
| **Change history** | Who changed state or scope, when, why (audit). |
| **Kill switch** | "Pause all automation" sets every policy in the workspace to Paused (PD §13.4, PROPOSED). |

**Paused vs Suspended:** Paused reflects a person's choice. Suspended reflects a workspace condition and can't be lifted per policy.

**IA-16 (confirmed):** when a workspace goes Monitor-only → Standard, every policy that was On before suspension returns **Paused**. Nothing resumes automatically. Each policy needs an explicit re-enable by a permitted person, and malicious-link and pattern policies require a **fresh preview** first.

---

## 21. Topic model

**Topic**: a subject of conversation (e.g. Price, Delivery, Product X, Returns). It is distinct from:

| Topic is not… | Because |
|---|---|
| Intent | "Delivery" can be asked about, complained about or praised. |
| Sentiment | Topics are neutral subjects. |
| Content | A topic spans many posts and ads. |
| Insight | A topic is a grouping. An insight is a claim about a pattern. |

| Aspect | Model |
|---|---|
| **Scope** | **Workspace-scoped.** [MODEL-REC] System topic *definitions* (product-owned, language-independent meanings with localized labels) may be shared as a catalog, but each workspace has its own topic instances and data (**M-10**). |
| **Kinds** | System topics · customer-specific topics (products, campaigns, locations) (PD §12.4) |
| **Labels / aliases** | One conceptual topic, many labels and aliases across languages ("precio", "preço", "price") (PD §16) |
| **Topic Assignment** | An assessment linking an interaction to a topic, with origin, confidence, time. **Many-to-many.** Human correction allowed. |
| **Derived states** | **Emerging** and **recurring** are *statistical states of a topic's aggregates* within a scope and window (§49), not fixed properties of the topic. |
| **Management** | Rename, merge, ignore: open (PD OQ-10; IA-06). The model must allow topic identity to be merged or split later while keeping assignment history. |

---

## 22. Aggregation model

**Aggregate**: a computed quantity over interactions, conversations or actions, for a **scope**, a **time window** and a **coverage context**.

Examples:
- volume of comments and conversations
- share or mix (intent mix, source mix, platform mix)
- unanswered or unattended conversations (organic vs paid)
- complaint and objection mix
- purchase-intent count
- topic frequency
- moderation outcomes (human vs automatic)
- response time and rate
- backlog trend
- useful-vs-friction mix per content item (IA §9.3)

Every aggregate carries:
- **scope**: workspace + filters (platform, source, account, content, campaign, topic, intent, language…)
- **time window**
- **coverage context** (§7)
- **statistical state** (§49)
- **as-of time** and **method identity**

**Aggregate ≠ Insight.** "58 delivery questions" is an aggregate. "Delivery questions rose sharply and concentrate in Product X ads" is an observation, which may become an insight once evidence, scope, change and confidence are attached.

---

## 23. Observation model

**Observation**: a **candidate intelligence fact** derived from aggregates and evidence. It is a statement about the world that can be checked.

| Observation contains | Example |
|---|---|
| **Statement** | "Delivery questions increased in paid conversations." |
| **Scope** | Paid · Instagram and TikTok · Product X ads |
| **Time window** | Last 30 days |
| **Baseline / comparison** | vs the previous 30 days (21 → 58) |
| **Supporting evidence** | Aggregates + representative interactions (§24) |
| **Strength / confidence** | Statistical state + qualitative confidence |
| **Coverage caveats** | "TikTok history covers 12 of 30 days" |

Observations are **facts about patterns**, never explanations. Not every observation becomes an insight. Many stay internal or appear only as aggregates.

---

## 24. Evidence model

**Evidence** is the bridge from intelligence back to source truth (IA §10.4).

| Evidence item kind | Points to |
|---|---|
| **Representative interaction** | One interaction (original text first), chosen to illustrate a claim |
| **Conversation set** | A **reproducible scope definition** that resolves to the canonical Inbox list (topic × type × content × source × period, status All). Never a copied list. |
| **Aggregate reference** | The aggregate(s) behind a number |
| **Concentration** | Distribution across content, ads, platforms or sources ("3 ads account for 70%") |
| **Time comparison** | Baseline window vs current window, each with coverage |

Rules:
- **Every claim has evidence**: insights, driver hypotheses, recommendations, follow-ups and report items.
- **Path back to source:** evidence → interactions → source text and context, **as the viewer's role allows**.
- **Client guests** (IA-05): see **representative quoted examples** only. Conversation sets are not resolvable for them, there's no full history, and content appears as names without links. The model needs a conceptual **"presentable to guests"** quality for representative examples. How author identity is shown to guests is **M-11**.
- **No parallel lists:** evidence never stores its own copy of the conversation list. It stores a scope that resolves through the Inbox for roles with access.
- **Evidence ages:** if evidence interactions are later corrected, deleted at source or hidden, the evidence item reflects that state (§47).

---

## 25. Insight model

**Insight**: a significant, evidence-backed, scoped claim worth a user's attention. It follows the approved anatomy (PD §14.3; IA §10):

```
observation ─▶ evidence ─▶ scope ─▶ change ─▶ likely driver hypothesis(es) ─▶ possible implication
```

| Insight is NOT | |
|---|---|
| a metric | that's an aggregate |
| a topic | that's a grouping |
| a single comment | that's evidence |
| a generic AI summary | it must be checkable against evidence |

| Aspect | Model |
|---|---|
| **Observation** | The checkable fact it is built on. |
| **Evidence** | Evidence items (§24). |
| **Scope** | Workspace (always) + source, platform, content, topic, period. |
| **Change** | Relative to a baseline or comparable content. |
| **Driver hypotheses** | 0..many, each with confidence (§26). |
| **Implication** | What it may mean for the business (plain language). |
| **Confidence & statistical state** | §16, §49. **Confidence is not certainty.** |
| **Coverage caveats** | Attached and shown (IA §10.5). |
| **Recommendations** | 0..many (§27). |
| **User feedback** | "Not useful" (UX §19.4), kept with the insight. |
| **Lifecycle** | Generated → shown → updated as evidence changes → resolved, expired, or dismissed as not useful (§53-E). |

Insights are **workspace-scoped**. There are no cross-workspace insights in the MVP (PD D-37).

---

## 26. Driver hypothesis model

**Driver Hypothesis**: a proposed explanation for an observation. It is **never a fact**.

| Fact (observation) | Hypothesis |
|---|---|
| "Delivery questions rose 21 → 58 in Product X ads." | "Questions rose likely because these ads don't mention delivery time." |

| Aspect | Model |
|---|---|
| **Statement** | Always phrased as likely or possible ("likely driver"). |
| **Supporting evidence** | e.g. the share of questions on ads without delivery info vs with. |
| **Conflicting evidence** | Material evidence against it, when it exists. |
| **Confidence** | Qualitative (§16). |
| **Alternatives** | Other material hypotheses, each with confidence (UX §19.4). |
| **Origin** | AI-generated, or human-added (future). Provenance kept. |

The model never upgrades a hypothesis into a fact based on correlation. Follow-ups never "confirm" a hypothesis causally (§29).

---

## 27. Recommendation model

**Recommendation**: a proposed business action grounded in one or more insights.

| Aspect | Model |
|---|---|
| **Statement** | What to change, and where ("Add delivery time to the copy of ads B and D"). |
| **Why** | A one-line rationale referencing the insight and driver. |
| **Originating insight(s)** | 1..many. |
| **Evidence** | Inherited from insights. Plus any recommendation-specific evidence. |
| **Scope** | The scope it applies to. |
| **Action type** | From the PD catalog (modify ad copy, update FAQ, create saved reply…, PD §14.5). |
| **Status** | **Open · Accepted · Dismissed · Done** (PD D-43). |
| **Decision attribution** | Who accepted, dismissed or marked done, and when. **Only Owner, Admin and Manager decide** (IA-09). Responders view only. No approval chain, no responder signal. |
| **Owner** | Defaults to the person who accepted it. |
| **Dismissal reason** | Optional (not relevant · disagree with evidence · already done · not feasible · no longer relevant). |
| **Completion date** | Set when Done (editable). |
| **Tracked Action** | **At most one active Tracked Action** in the MVP (MODEL: CONFIRMED — M-12), created when the recommendation is marked Done (§28). |
| **Evidence-health notice** | "Evidence has weakened" / "may no longer apply" as a derived notice, **not a new status** (UX §21.4). |
| **Confidence** | Inherited (§16). No causal claim. |

---

## 28. Tracked Action model

**Tracked Action**: what the customer says they actually did in response to a recommendation. It is the bridge to follow-up.

| Aspect | Model |
|---|---|
| **Description** | What was done ("Updated ad copy for B and D to include delivery time"). Defaults from the recommendation, editable. |
| **Originating recommendation** | Exactly one. A recommendation has **at most one active Tracked Action** in the MVP (MODEL: CONFIRMED — M-12). |
| **Action / completion date** | The date the change took effect. It anchors the follow-up. |
| **Scope** | The scope of the change (content, topic, source). |
| **Actor / owner** | Who recorded it. |
| **Where it happened** | Outside the product (ad platform, website, operations) or inside (saved reply created, Brand Context updated, eligible policy enabled). |
| **Link to in-product artifact** | When inside the product (e.g. the saved reply created). |

**MVP behavior (MODEL: CONFIRMED — M-12):**
- Marking a recommendation **Done** *creates* its single active Tracked Action. The user doesn't manage tracked actions separately (UX §21).
- If the recommendation suggested several possible actions, the user records **the action they actually chose**.
- If a Done recommendation is reopened (marked done by mistake), its Tracked Action is retired and kept as history. Marking it Done again creates the new active one. There is never more than one active at a time.
- **Not introduced:** sub-actions, task lists, project-management workflows, multiple parallel tracked actions, or approval chains. Richer action tracking may come later if real usage requires it.

The concept stays distinct so that follow-ups attach to *what was done and when*, not merely to a status change.

---

## 29. Follow-up model

**Follow-up**: a **descriptive** before/after measurement anchored on a tracked action (PD D-43).

| Aspect | Model |
|---|---|
| **Anchor** | The Tracked Action and its completion date. |
| **Measured quantity** | [MODEL-REC] The same aggregate and scope as the originating insight's observation (e.g. share of price questions on ads B and D). |
| **Before window / after window** | References to two comparison windows around the anchor. **Default length is deferred** (UX-13; PD OQ-16). |
| **Coverage per window** | Required. Incomparable coverage → "comparison unavailable". |
| **Known confounders** | Recorded when known (spend changed, campaign paused, seasonality) (PD §14.4). |
| **Statistical state** | §49. "Not enough conversation after [date] to compare yet." |
| **Result statement** | Descriptive only, always labeled "Descriptive: other factors may have contributed." |
| **Readiness** | Pending → ready (alert + Home item) → viewed. |

**No causality.** A follow-up never confirms or refutes a driver hypothesis as cause.

---

## 30. Priority model

**Priority Assessment**: an operational interpretation of how urgently a **Conversation** needs attention. It is derived and explainable.

| Aspect | Model |
|---|---|
| **Level / order** | An ordinal concept (e.g. urgent · high · normal · low, illustrative) used to order the Inbox. |
| **Reasons ("Why it's here")** | The contributing factors in user language (IA §7.6). The short form names the dominant reason. |
| **Factors (inputs)** | response need · risk / reputation risk · purchase intent · harmful content · active paid context · waiting time (business hours) · escalation · uncertainty (needs review) · protection notices · reopen ("New reply after you marked this done") |
| **Driven by** | The most important **unhandled** interaction in the conversation (IA §7.1). |
| **Recomputation** | Whenever an input changes (new interaction, correction, time passing, reply sent). |
| **No fixed formula** | The weighting is a later decision. The model only requires that every priority can be explained by its factors. **No opaque scores** are shown to users. |

---

## 31. Operational workflow model

| Concept | Belongs to | Values / behavior |
|---|---|---|
| **Workflow state** | Conversation | Open · Done (IA-04) |
| **Resolution** | Conversation (when Done) | §10 list |
| **Assignee** | Conversation | Member or none |
| **Escalation** | Conversation | §32 |
| **Priority** | Conversation | §30 |
| **Internal note** | Conversation | Human-authored, timestamped |
| **Moderation state** | Interaction | §18 |
| **Recommendation state** | Recommendation | §27 |

Confirmed automatic behaviors (IA-04; UX-04), each recorded as an attributable **Workflow Event**:

| Trigger | Effect | Initiator recorded as |
|---|---|---|
| Successful brand reply sent from the product, nothing else needs handling | Open → Done ("Replied publicly/privately") | system (auto-done), linked to the Outbound Reply |
| Native brand reply detected after the latest audience message, nothing else needs handling | Open → Done ("Replied on platform") | system (auto-done), linked to the imported brand Interaction |
| New audience message needing reply or review | Done → Open | system (auto-reopen), linked to the new Interaction |
| User Undo of an automatic change | revert | the user |

Monitor-only: workflow behaves identically. Resolutions are internal ("Reviewed", "Escalation closed"). Native brand replies still auto-Done.

---

## 32. Escalation model

| Aspect | Model |
|---|---|
| **Escalation** | A record attached to a Conversation that raises it to an owner. A conversation has at most one **open** escalation, plus history. |
| **Target owner** | A workspace member, defaulting to the optional workspace **Default Escalation Contact** (UX-12). May be unassigned (lands in the Escalated view). |
| **Reason** | Product/service issue · customer service · legal or reputation risk · needs client or owner decision · other (UX §17). |
| **Note / context** | Human-authored, plus automatically attached evidence (the conversation). |
| **State** | Open → Closed (with an outcome note), or closed implicitly when the conversation becomes Done. |
| **Agency / business use** | Same concept. The recipient is an internal member in both cases. |
| **External delivery** | **Open** (PD OQ-17; UX-16). "Copy escalation summary" is a temporary UX fallback producing a text artifact, not an integration. No CRM, email or chat integration is modeled. |

---

## 33. Saved Reply model

| Aspect | Model |
|---|---|
| **Saved Reply** | A **human-authored, approved, reusable text** in one workspace (PD D-46). |
| **Language** | Each saved reply has a language. Optional **language versions** are grouped under one name (IA §14). Whether versions are needed at launch is open (PD OQ-23). |
| **State** | Active · Retired (kept in history, restorable). |
| **Brand relevance** | Optional applicability to a brand within a multi-brand workspace (IA-07 open). |
| **Provenance** | Created by, edited by, when, and optionally the originating recommendation. |
| **Use** | Recorded when an Outbound Reply starts from it (§36). |

Saved Reply **is not**: automation, a macro, a template workflow (no variables, conditions or side effects), or a source of truth for the AI. Saved replies are not Brand Context. Governance (who can create and edit) remains open (PD OQ-23).

---

## 34. Brand Context model

**Brand Context**: lightweight, **verified** information that AI reply suggestions may rely on (PD D-47).

| Aspect | Model |
|---|---|
| **Sections** | Brand identity · products & services · verified facts · FAQs · approved contact channels · tone & voice · key policies (IA §15.2). |
| **Item** | A unit of verified information within a section (e.g. "Free shipping over USD 50", "Returns accepted within 30 days"). |
| **Verification** | Who verified or entered it, and when. Only verified items can ground suggestions. |
| **Language** | Where the wording is language-specific (FAQ answers, tone examples). Facts can be language-independent. |
| **Applicability** | Whole workspace, or a specific brand in a multi-brand workspace (PD OQ-24; IA-07). |
| **Currency** | Current · outdated (flagged) · retired. Retired or outdated items never ground suggestions. |
| **Gap signals** | Derived from suggestions that couldn't find a fact and from unmet information needs in VoC (UX §20). They point to missing Brand Context. |

Brand Context **is not**: unrestricted document knowledge, a CMS, a full knowledge base, or a retrieval architecture. Minimum requirements remain open (PD OQ-24).

---

## 35. AI suggestion model

**Suggested Reply**: a generated draft for one interaction. It is **never sent automatically** (PD D-45).

| Must preserve | Notes |
|---|---|
| **Target** | The interaction and its conversation. |
| **Target language** | Commenter's language by default. |
| **Text generated** | The draft. |
| **Grounding state** | Grounded · partially grounded · no facts needed · not enough verified information (UX §10.2). |
| **Brand Context used** | The items it relied on. |
| **Missing Brand Context** | The facts it needed but didn't find (gap signals, §34). |
| **Safety outcome** | Passed, or withheld (not shown) (UX §10.4). |
| **Generation provenance** | Method identity, time, inputs (interaction, thread, content context, Brand Context). |
| **Human use** | Shown · used (inserted) · edited · flagged · dismissed. |
| **Link to final reply** | The Outbound Reply it started, if any. |

**Generated suggestion ≠ final reply.** The sent text is the human's Outbound Reply. Whether suggestions are prepared automatically or on demand is deferred (UX-08). The model supports both, because preparation time is just another attribute of the suggestion's provenance.

---

## 36. Human reply model

**Outbound Reply**: a reply a **human** sends from the product.

| Must preserve | Notes |
|---|---|
| **Sender** | The human user (always). |
| **Kind** | Public · private (one-shot, PD D-36) |
| **Text sent** and **language** | The exact final text. |
| **Starting point** | Written manually · started from a suggested reply · started from a saved reply (or several, if the user switched) |
| **Adaptation** | Whether and how much the human edited the starting text (conceptual "edited / not edited", plus edit extent as a quality signal, PD §19.3). |
| **Target** | The interaction replied to and its conversation. |
| **Send outcome** | Sending · sent (confirmed) · failed (reason) · target no longer available. |
| **Resulting brand interaction (public only)** | A **public** Outbound Reply, once the platform confirms it, may appear in the public thread as a brand Interaction linked to this Outbound Reply. A **private** Outbound Reply never does. |
| **History marker (private only)** | A **private** Outbound Reply creates an activity/history marker in its Conversation. |

**Public vs private semantics:**

| | Public Outbound Reply | Private Outbound Reply |
|---|---|---|
| After success | **May become a brand Interaction** in the public Conversation thread once the platform confirms it. This represents the public social reply. | **Remains an Outbound Reply record**, linked to its target Interaction and Conversation. |
| In the Conversation | Appears as a reply in the thread | An **activity/history marker** ("Private reply sent by [name] · [time] · follow-up continues in [platform]'s inbox") |
| Audit | Audit Event | Audit Event |
| Never creates | — | A public Conversation Interaction · an incoming private Interaction · a DM Conversation · a private thread · a DM Inbox · DM workflow state |

If the audience member answers privately, the product doesn't model or ingest that private thread in the MVP. Follow-up stays in the platform's native inbox (PD D-36). Native brand replies (made outside the product) are public brand Interactions without an Outbound Reply.

---

## 37. Report model

**Report**: a **period snapshot / narrative assembled from existing intelligence and operational aggregates** (IA §12.2). It is not a second intelligence engine.

| Aspect | Model |
|---|---|
| **Type** | Summary · Performance (IA-02). |
| **Workspace** | Exactly one. No cross-workspace reports (PD D-37). |
| **Report period** | The period it covers. Complete, or "in progress". |
| **Source focus** | All sources by default. An explicit focus is stated in the title (UX §3.2). |
| **Coverage statement** | For the period (§7). |
| **Content** | References to the insights, recommendations, follow-ups, aggregates and representative evidence for the period. Narrative text is assembled from them. |
| **Generation time / as-of** | When it was assembled. How it behaves when underlying data changes is **M-03**. |
| **Audience safety** | Client-guest rendering uses only guest-presentable evidence. No conversation sets, content links or Inbox links (IA-05). |
| **Delivery / export** | Open (PD OQ-15). Any future share or export must carry the same restrictions. |
| **Usable-report availability** | Whether a usable report exists yet for the workspace (a complete period with enough data). When none exists, client guests land on Insights with a calm explanation, and a date is shown only if it is genuinely known (UX-15). |

---

## 38. Alert model

**Alert**: an **attention signal for a recipient**. It is not an insight.

| Aspect | Model |
|---|---|
| **Trigger reason** | Severe risk · unusual spike · harmful content building up on active ads · connection failure · escalation assigned to me · assignment to me · follow-up ready |
| **Severity** | Qualitative (e.g. critical · high · info) |
| **Workspace** | The originating workspace (always named) |
| **Recipient** | A user (role-appropriate; never client guests in the MVP, IA-05) |
| **Related object** | The conversation, insight, connection, escalation or recommendation it points to |
| **State** | New · read · acknowledged · resolved/expired (the underlying condition cleared) |

Channels beyond in-app remain open (PD OQ-17; IA-14).

---

## 39. Cross-workspace attention model

The **All workspaces** overview (PD D-37; IA §16) needs only a minimal **Workspace Attention Signal** per workspace, derived inside each workspace:

| Allowed signal | Meaning |
|---|---|
| Needs attention | Overall indicator |
| Urgent interactions | Count |
| Reputation risk | Flag with a short reason |
| Growing backlog | Trend indicator |
| Connection issue | Flag |
| Monitor-only | Mode indicator |

The organization level reads only these signals for workspaces the user can access. Client guests see none (IA-05). Exact criteria are open (PD OQ-25).

**Not modeled (out of the MVP):** aggregated cross-client topics or VoC · a global conversation corpus · portfolio insights or aggregates · a cross-workspace Inbox · portfolio reports · cross-workspace search (IA-10).

---

## 40. Audit / activity model

**Audit Event**: an immutable record of a consequential change.

| Captures | |
|---|---|
| **What changed** | The kind of change |
| **Object affected** | Conversation, interaction, policy, connection, recommendation… |
| **Initiator** | Human user · automation policy · system rule (auto-done / auto-reopen) · native platform action (detected) · AI-assisted human action (e.g. a reply started from a suggestion) |
| **When** | Time of the change (and source time where it comes from the platform) |
| **Why / reason** | Classification + policy, user choice, platform signal |
| **Previous / new state** | Where useful |
| **Reversibility / reversal** | Whether it can be undone, and a link to the reversing event |

Must be audited: replies (public and private; a private reply also leaves a history marker in its Conversation) · moderation (single, bulk, automatic, native) · workflow status changes (manual and automatic) · assignment · escalation · label and topic corrections · policy changes (state, scope, pattern, preview) · kill switch · operating-mode changes · connection changes (added, revoked, reconnected, removed) · recommendation decisions · Brand Context and saved reply changes · membership and role changes.

Not an event-sourcing design: the requirement is only that these facts are kept and retrievable.

---

## 41. Provenance model

### 41.1 Origin types

| Origin | Examples |
|---|---|
| **A. Platform source** | Comment text, author identity, timestamps, platform state, paid context as reported |
| **B. User** | Corrections, replies, notes, decisions, Brand Context, saved replies, policy settings |
| **C. Product rule** | Deterministic checks (malicious-link detection), auto-done/reopen rules, coverage determinations |
| **D. AI / model** | Classification, topic assignment, language detection, suggestions, observation/insight drafting, driver hypotheses |
| **E. Derived aggregate** | Counts, mixes, trends, statistical states |
| **F. Imported / native brand activity** | Brand replies and moderation done natively on the platform |

### 41.2 How provenance flows

```
Interaction (A)
  └─▶ Classification assessments (D, C, A, B) ──▶ accepted interpretation (rule: §15.2)
        └─▶ Aggregates (E: method + inputs + coverage)
              └─▶ Observation (E/D: which aggregates, which evidence)
                    └─▶ Insight (D: observation + evidence + driver hypotheses)
                          └─▶ Recommendation (D: insight + rationale; decision by B)
                                └─▶ Tracked Action (B) ─▶ Follow-up (E)
                                      └─▶ Report (E/D: references, generation time)
```

At every hop the downstream object knows **which upstream objects it depends on**, so:
- any claim can be traced to evidence and, as far as role permits, to source text;
- corrections upstream can mark downstream objects as affected (§47);
- the UI can always answer "why do you think this?".

---

## 42. Temporal model

| Temporal marker | Applies to |
|---|---|
| **Source time** (as reported by the platform) | Interactions, content, edits, native moderation |
| **Observed time** (when we learned it) | Imports, platform state checks, native reply detection |
| **Created / changed time** | Every product-created object and assessment |
| **Validity (current vs superseded)** | Assessments, accepted interpretations, content source classification, capability states, coverage records, policy states, operating mode |
| **Action / completion date** | Tracked actions, recommendation Done |
| **Comparison periods** | Baselines, follow-up windows, report periods |
| **As-of time** | Aggregates, insights, previews, reports |

**Why history matters:** the product must be able to answer "what did we believe then, and why did we act?".
- **A label is corrected later.** The auto-hide made earlier must remain explainable by the interpretation at that time.
- **A comment is hidden, then unhidden.** Both events are kept, with initiators.
- **A recommendation is accepted, then done.** The follow-up anchors on the completion date.
- **A connection is revoked.** Coverage for the gap period is stated, so the gap isn't read as zero activity.
- **A policy is paused.** Hides before and after are explainable.
- **Content source changes after paid context appears.** Organic → Mixed; earlier aggregates were computed on the earlier classification and say so.

The model distinguishes **when something happened** (source and action time) from **when the product knew it** (observed and created time). The technical temporal design is out of scope.

---

## 43. Derived vs canonical data

| Category | Meaning | Objects |
|---|---|---|
| **A. External canonical / source** | As provided by platforms | Source text versions · platform timestamps · platform-reported author identity · content as published · paid context as reported · platform state observations · native brand replies and moderation |
| **B. Product normalized canonical** | Our stable representation of source objects | Social Asset · Connected Account · Content Item · Campaign / Ad Group / Ad · Conversation · Interaction · Author |
| **C. Derived current interpretation** | What the product currently acts on, recomputable from D | Accepted interpretations · Protection Evaluation · Priority · effective source · Capability Profile state · coverage state · Workspace Attention Signals |
| **D. Historical assessment / event** | Immutable records of what was asserted or happened | Classification and topic assessments · language assessments · Automation Decisions · Moderation Events · Workflow Events · Audit Events · policy previews · suggestion records |
| **E. Aggregated** | Computed quantities over scope × window × coverage | Aggregates · statistical states |
| **F. Intelligence** | Claims and explanations | Observations · Evidence · Insights · Driver Hypotheses · Implications · Follow-up results · Reports |
| **G. Human decision / action** | Acts and authored content by people | Outbound Replies · corrections · notes · assignments · escalations · recommendation decisions · Tracked Actions · bulk/single moderation |
| **H. Configuration** | Customer-set behavior | Operating mode · Moderation Policies · Brand Context · Saved Replies · default escalation contact · roles and memberships · workspace labels (brand, market) · business hours |

---

## 44. Mutability model

| Object | Mutability | History requirement |
|---|---|---|
| Source text version | **Immutable**. New platform versions are added. | All versions kept (per retention) |
| Platform-reported facts (timestamps, author identity) | Immutable as observed. New observations are added. | Observation history |
| Interaction / Conversation / Content (normalized) | Stable identity; state attributes change | Changes via events |
| Classification assessment | **Immutable** once made | — (it *is* history) |
| Accepted interpretation | Changes (corrections, new assessments) | Assessment history preserved |
| Protection evaluation, priority, effective source | Recomputed | Keep the value used at decision time where a decision was made (e.g. in Automation Decisions) |
| Moderation state | Changes | Moderation Events |
| Workflow state, assignee, escalation | Changes | Workflow / Audit Events |
| Aggregates | **Recomputable** | As-of time; earlier values kept where referenced by insights, reports or follow-ups |
| Observations / Insights | **Evolve** (recompute, update, expire) | Versions or snapshots where referenced (M-04) |
| Driver hypotheses | Evolve with the insight | Kept with insight versions |
| Recommendation status | Stateful human decision | Decision events |
| Tracked action, follow-up result | Tracked action editable by its owner; follow-up recomputed until "ready", then stable unless data changes materially | Audit / versions |
| Report | Snapshot per generation (M-03) | Generation time |
| Configuration (policies, Brand Context, saved replies, mode) | Changes | Change history (audit) |
| Audit event | **Immutable** | — |

---

## 45. Deletion / disappearance concepts

Retention and legal policy remain open (PD OQ-21). The model must distinguish **the source no longer has it** from **our historical record of it**.

| Situation | Conceptual handling |
|---|---|
| **Comment deleted natively** (by author or platform) | Interaction source state → removed at source (observed time). Our record persists per retention. Shown as "no longer on [platform]". Evidence using it is marked accordingly. |
| **Comment deleted through the product** | Moderation Event "deleted by [user]". Our record persists per retention (IA §7.4). |
| **Content disappears** | Content source state → unavailable. Conversations remain as history. New interactions stop. |
| **Account disconnected / revoked** | Connection health changes. Coverage for the affected scope becomes failed or unavailable from that time. Data already imported remains (IA §20). |
| **Platform stops exposing something** | Capability state changes (unsupported or unknown). Coverage reflects it. No silent zeros. |
| **Connection removed by the customer** | What happens to imported data and derived intelligence is a retention decision (PD OQ-21; OQ-13). |

Deletion of *our* records is a retention-policy action, distinct from platform-side disappearance, and must be audited when it happens.

---

## 46. Intelligence lineage examples

### Example A — Purchase intent and a delivery question

> Audience comment on an Instagram ad: **"¿Cuánto cuesta y hacen envíos a regiones?"**

```
SOURCE (A)      Interaction: comment, text v1 (es), author @usuario (platform-scoped),
                Content: Ad creative "Product X" (source: Paid, provenance: paid context),
                Ads: 2 ads share this content (comment's ad unknown)
                         │
UNDERSTANDING   Language: es (high)
(D)             Intent: purchase question + product/service question (multi-value, high)
                Safety: none · Authenticity: likely human · Sentiment: neutral
                Topics: Price, Delivery (two assignments)
                Risk: low · Response need: response required
                Protection: not protected (no complaint/objection)
                         │
OPERATIONS      Conversation (new, Open) · Priority: high
(C)             "Why it's here": "Purchase question on an active ad · waiting 2h"
                Suggested reply: grounded on Brand Context "Shipping: all regions, 3–5 days";
                gap: "No verified price" → states it; human edits & sends (Outbound Reply)
                → Conversation Done ("Replied publicly", auto, reversible)
                         │
AGGREGATE (E)   Delivery-topic questions on Product X ads, Paid, last 30d: 58 (prev 21),
                coverage complete for Instagram; TikTok partial (12/30 days)
                         │
OBSERVATION     "Delivery questions rose (21 → 58) and concentrate in Product X ads."
INSIGHT (F)     + evidence (examples incl. this comment, conversation set scope)
                + driver hypothesis (medium): "ads don't mention delivery time"
                + coverage caveat (TikTok partial)
                         │
RECOMMENDATION  "Add delivery time and starting price to Product X ad copy" (Open)
                → Manager accepts → marks Done (completion date) → Tracked Action
                → Follow-up: same aggregate before/after → descriptive result
```

### Example B — Fraud accusation (protected)

> **"ESTAFA. Pagué hace dos semanas y no llegó."**

```
SOURCE (A)      Interaction: comment, text v1 (es), Content: organic post (Organic)
                         │
UNDERSTANDING   Sentiment: negative (high)
(D)             Intent: fraud accusation against the brand + complaint + product/service
                problem (delivery) (multi-value, high)
                Safety: none   ← negativity is not harm (PD principle 1)
                Risk: high (reputation risk) · Response need: escalation required
                Topics: Delivery, Payment
                         │
PROTECTION      Protected: YES (fraud accusation, complaint, product/service problem)
                         │
AUTOMATION      Workspace has a configured-pattern policy with "estafa":
DECISION        1 candidate match ✓ ("estafa") → 2 understood: fraud accusation, complaint
                → 3 protection guard: PROTECTED → VETO → outcome: NEEDS REVIEW (UX-10)
                Recorded: Automation Decision (veto reason: protected meaning)
                Comment stays Visible. NEVER automatically hidden.
                         │
OPERATIONS      Conversation Open · Priority: urgent ("Fraud accusation against your brand ·
                reputation risk") · recommended action: Reply / Escalate (never Hide)
                Human escalates → Escalation (reason: customer service; owner: default
                escalation contact) → replies publicly with an approved message
                (Brand Context: contact channel) → Done ("Replied publicly")
                         │
INTELLIGENCE    Contributes to Complaints & problems (VoC) and Risks;
                may support an insight "Delivery complaints rising" with evidence.
```

A human *may* still deliberately hide this comment individually, with an informational caution (PD D-35; UX §13.2). It would be excluded from any human bulk hide (UX-06).

### Example C — Obvious spam with a malicious link

> **"🔥 Gana un iPhone gratis aquí 👉 bit.ly/xxxx"** under a TikTok ad

```
SOURCE (A)      Interaction: reply, text v1 (es), author newly seen, Content: Paid
                         │
UNDERSTANDING   Safety: obvious spam + malicious link + scam/fraud content (third-party)
(D)             (rule: link known-malicious, high; AI: spam, high)
                Authenticity: bot-like (medium) · Sentiment: positive (irrelevant to harm)
                Intent: none legitimate · Protection: NOT protected
                         │
AUTOMATION      Policy "Malicious links" (On, scope: paid; previewed on Oct 1)
DECISION        1 match ✓ → 2 harmful ✓ → 3 protection: not protected ✓
                → 4 high confidence ✓, eligible type ✓ → 5 workspace: Standard ✓
                → 6 capability: hide supported for this account? 
                     if yes → HIDE (hide-only)  │  if no → NO ACTION ("hide unavailable"), Needs review
                         │
MODERATION      Moderation Event: Visible → Hidden, initiator: policy "Malicious links",
                reason: malicious link (rule) + spam (AI); shown in Inbox › Hidden automatically
AUDIT           Audit Event recorded (reversible)
                         │
UNDO (optional) Manager reviews → Undo → Moderation Event Hidden → Visible (initiator: user,
                reverses policy event) → counted against the policy's precision
                         │
WORKFLOW        If nothing else needs handling: Conversation Done ("Moderated", auto, reversible)
MONITOR-ONLY    Same understanding; step 5 → VETO (policy Suspended) → Needs review/escalate
```

---

## 47. Correction propagation

When a human corrects a classification or topic:

| Downstream object | Effect | Timing |
|---|---|---|
| **Accepted interpretation** | Replaced by the human assessment. History kept. | Immediate |
| **Protection evaluation** | Recomputed. If the interaction was hidden by a policy and is now protected, the UX prompts **Unhide** (UX §16.2). Never automatic. | Immediate |
| **Priority / "Why it's here"** | Recomputed | Immediate |
| **Inbox view membership** (Needs review, Needs reply…) | Updated | Immediate |
| **Recommended action** | Updated (e.g. Hide → Reply) | Immediate |
| **Automation eligibility** | Future evaluations use the corrected interpretation. **Corrections never trigger automation** (UX §16.2). | Immediate (for future decisions) |
| **Topic aggregates, VoC, content profiles** | Include the correction | Next refresh (UX §16.1) |
| **Insight evidence / observations** | Re-validated at next refresh. If the support changes materially, the insight updates or shows "evidence changed" (M-04) | Next refresh |
| **Recommendation evidence** | Inherits the insight's update. May show "Evidence has weakened" (UX §21.4) | Next refresh |
| **Past Automation Decisions** | **Not rewritten.** They remain explainable by the interpretation at the time | Never |
| **Generated reports** | Snapshot behavior is **M-03** | — |

**Current interpretation vs historical snapshot:** operational surfaces always show current interpretation. Decisions and snapshots (automation decisions, follow-up results once ready, generated reports) keep what was true when they were made, and say so.

---

## 48. Intelligence refresh semantics

| Layer | Time semantics | Examples |
|---|---|---|
| **Operational state** | Near-current: changes as events arrive | Inbox, conversation detail, workflow, moderation state, priority, alerts |
| **Aggregates** | Periodically recomputed, with an as-of time | Topic counts, mixes, Content & Ads profiles, VoC counts, Home "What changed" inputs |
| **Intelligence snapshots** | Generated, then updated, with versions/as-of | Observations, insights, driver hypotheses, recommendations' evidence |
| **Retrospective outputs** | Fixed period, generated at a time | Reports, ready follow-ups |

The Inbox, Insights and Reports **intentionally** answer different temporal questions: *now*, *recently, with interpretation*, and *over a past period*. Each surface must show its as-of time when it isn't live, so users aren't confused when a just-corrected label isn't yet reflected in an insight. Schedules and infrastructure are out of scope.

---

## 49. Statistical honesty model

Every aggregate, observation, insight, comparison and follow-up carries a **Statistical State**:

| State | Meaning | Communication |
|---|---|---|
| **Insufficient volume** | Too few items to describe a pattern | "We see 3 examples, but not enough evidence to call this a trend." Counts and examples only. |
| **Emerging signal** | Early, low-confidence change | "Early signal: 6 this week vs 1 last week." No recommendation yet (UX §19.4). |
| **Stable pattern** | Sustained and adequately supported | Eligible for insights and recommendations. |
| **Comparison unavailable** | Baseline missing or not comparable (coverage, period) | No percentage change shown. |
| **Partial coverage** | Valid on what we see, but incomplete | Caveat attached. |
| **Conflicting evidence** | Signals point different ways | Shown as uncertain. Alternatives listed. |
| **Not available** | Unsupported, not requested, failed or unknown coverage | "Not available", never zero. |

Formulas and thresholds are later decisions (PD OQ-16). Every percentage is shown with absolute counts (PD §14.4).

---

## 50. Safety invariants

Later architecture **must** preserve these. Each maps to a structural mechanism in this model.

| # | Invariant | Mechanism |
|---|---|---|
| S1 | Negative ≠ harmful | Sentiment and Safety are separate dimensions. Sentiment never feeds automation eligibility (§14, §19). |
| S2 | Complaint protection always wins over automation | Protection Evaluation vetoes at step 3. Uncertain counts as vetoed (§17, §19). |
| S3 | Protected categories never auto-hide | Same veto; also excluded from human bulk hide (§17, §19). |
| S4 | Abuse never auto-hides in the MVP | Abuse isn't an eligible policy type; step 4 excludes it (§19, §20). |
| S5 | Automation is hide-only | Policies can only produce Hide events (§20). |
| S6 | No bulk delete or block | No bulk delete/block Moderation Events exist. Bulk is hide-only and human (§18). |
| S7 | Monitor-only causes no platform mutation | Operating mode vetoes every product-initiated platform action and automation (§4, §19). |
| S8 | No AI auto-send | Outbound Replies always have a human sender. Suggestions never produce replies (§35, §36). |
| S9 | No full DM Inbox | No incoming DM object. A private reply is one outbound record plus a history marker. It never becomes a Conversation Interaction (§36). |
| S10 | Automation never resumes silently | Leaving Monitor-only returns policies Paused (IA-16) (§20). |
| S11 | Unsupported ≠ zero; missing ≠ zero | Capability states and Coverage Records; "not available" value state (§6, §7, §49). |
| S12 | Source evidence is distinguishable from inference | Source text versions vs assessments vs derived objects, with origin types (§13, §15, §41). |
| S13 | Human corrections remain attributable | Human assessments with actor and time. History never erased (§15). |
| S14 | Recommendation ≠ proven causality | Driver hypotheses are never facts. Recommendation language inherits that (§26, §27). |
| S15 | Before/after ≠ causality | Follow-ups are descriptive only (§29). |
| S16 | Workspace is the operational/access boundary | Every conversation-derived object belongs to exactly one workspace (§4). |
| S17 | Cross-workspace doesn't become portfolio intelligence | Only Workspace Attention Signals cross the boundary (§39). |
| S18 | Client guests can't reach conversations | Evidence for guests is representative and guest-presentable only. Conversation sets don't resolve for guests (§24, §37). |
| S19 | Keywords are never meaning | Pattern matches are only candidates. Hiding also requires confident understanding (not protected, not ambiguous) plus every veto (§17, §19). |
| S20 | Platform limits are never presented as role limits | Capability states are separate from roles and mode (§6; IA §18). |

---

## 51. Conceptual entity catalog

| Name | Definition | Domain | Origin | Mutable? | Key relationships | Main surfaces | Notes / open |
|---|---|---|---|---|---|---|---|
| User | A person using the product | A | User | Yes (profile) | Memberships | Account menu | — |
| Organization | Customer entity | A | User | Yes | Workspaces, members, plan | Settings › Organization | — |
| Workspace | Operational, access and intelligence boundary | A | User | Yes (config) | Everything conversational | Shell, all destinations | Operating mode, labels |
| Workspace Membership | User ⇄ Workspace with a role | A | User | Yes | User, Workspace, Role | Members & access | — |
| Role | Permission bundle | A | Product (PD proposed set) | Rarely | Memberships | — | Role set PD: PROPOSED |
| Brand / Market | Grouping dimensions | A | User | Yes | Workspaces (accounts: IA-07) | All workspaces, filters | IA-07 open |
| Workspace Operating Mode | Standard / Monitor-only | A | User (Owner/Admin) | Yes, audited | Policies, actions | Shell indicator, Settings | D-49 |
| Social Platform | Facebook / Instagram / TikTok | B | Product | Rarely | Assets, capabilities | Labels, filters | — |
| Social Asset | External presence on a platform | B | Platform | Observed | Connections, Connected Accounts | Connections | M-01 |
| Connection | Workspace's authorization to assets | B | User + platform | Health changes | Workspace, assets, authorizing user | Connections, Home notices | Tokens out of scope |
| Connected Account | Asset brought into a workspace | B | User | Yes | Content, capability, coverage | Connections, labels | — |
| Capability Profile | What can be done, per account and content type | B | Product rule + platform | Yes (verified over time) | Connected Account | Disabled-with-reason actions | Actual values VALIDATE |
| Coverage Record | How much we can see for a scope | B | Product rule | Yes | Accounts, sources, ranges | Coverage notices, caveats | NO DATA ≠ ZERO |
| Content Item | Post, video, ad creative… | C | Platform (normalized) | Source state changes | Account, Conversations, Ads | Content & Ads | — |
| Content Source Classification | Organic / Paid / Mixed / Unknown | C | Platform / rule | Yes, with history | Content, Interactions (effective source) | Labels, filters | M-02 |
| Campaign / Ad Group / Ad | Paid distribution context | C | Platform | Observed | Content (⇄ many) | Paid context, grouping | Attribution partial |
| Conversation | Thread = Inbox work item | D/F | Product (normalized) | Workflow changes | Content, Interactions, escalation | Inbox | IA-01 |
| Interaction | Comment / reply | D | Platform (normalized) | State changes; text versions added | Conversation, Author, assessments | Conversation detail, evidence | — |
| Source Text Version | Text as received | D | Platform | Immutable | Interaction | Thread (original) | M-09 (edits) |
| Language Assessment | Detected language(s) | D/E | AI / human | Assessments immutable | Interaction | Language tag, filters | — |
| Display Translation | Derived rendering | D | AI | Regenerable | Source text | Translation on demand | Never evidence |
| Author | Platform-scoped account | D | Platform | Observed | Interactions, block state | Author context | No CRM; M-06 |
| Author Block State | Blocked in a platform/account context | H | User / native | Yes, audited | Author, account | Author context | Unblock: UX-09 |
| Classification Assessment | One interpretation of one dimension | E | AI / rule / platform / human | Immutable | Interaction | Labels (detail) | M-05 |
| Accepted Interpretation | Current interpretation per dimension | E | Derived | Yes | Assessments | Labels, priority, filters | — |
| Protection Evaluation | Protected meaning present? | E | Derived | Recomputed | Accepted interpretations | Why it's here, previews | Fail-safe |
| Topic | Subject of conversation | E | Product / user | Yes | Assignments, aggregates | Topic pages, VoC | OQ-10; M-10 |
| Topic Assignment | Interaction ⇄ Topic | E | AI / human | Assessments immutable | Interaction, Topic | Labels, VoC | — |
| Priority Assessment | Conversation urgency + reasons | F | Derived | Recomputed | Conversation | Inbox order, Why it's here | No formula yet |
| Workflow Event | Status change record | F | User / system | Immutable | Conversation | Activity history | — |
| Escalation | Raised to an owner | F | User | Open → closed | Conversation, owner | Escalated view | OQ-17, UX-16 |
| Internal Note | Workspace-internal note | F | User | Editable by author [MODEL-REC] | Conversation | Conversation | — |
| Brand Context Item | Verified fact / FAQ / channel… | G | User | Yes (current/retired) | Suggestions | Settings › Responding | OQ-24 |
| Saved Reply | Approved reusable text | G | User | Yes (active/retired) | Outbound Replies | Composer, library | OQ-23 |
| Suggested Reply | Generated draft | G | AI | Immutable record + usage | Interaction, Brand Context | Composer | UX-08 |
| Outbound Reply | Human-sent reply (public or private) | G | User | Send outcome changes | Target Interaction & Conversation, suggestion/saved reply; public → may become a brand Interaction; private → history marker only | Thread, history | Private never becomes an Interaction |
| Moderation State | Per-interaction visibility | H | Derived from events | Yes | Interaction | Thread, Hidden automatically | — |
| Moderation Event | Visibility change record | H | User / policy / native | Immutable | Interaction, policy | Activity history | — |
| Moderation Policy | Opt-in auto-hide rule | H | User | Yes, audited | Decisions, previews | Settings › Moderation | IA-16 |
| Policy Preview | Historical simulation | H | Derived | Snapshot | Policy | Settings › Moderation | — |
| Automation Decision | Per-interaction eligibility chain | H | Product rule | Immutable | Policy, Interaction, events | Hidden automatically, previews | — |
| Aggregate | Quantity over scope × window × coverage | I | Derived | Recomputable | Interactions, Observations | Home, Content & Ads, VoC, Reports | — |
| Observation | Candidate pattern fact | I | Derived / AI | Evolves | Aggregates, Evidence, Insights | (inside insights) | — |
| Evidence | Link from claim to source | I | Derived | Evolves | Insights, Recommendations, Reports | Examples, "See all" | M-11 |
| Insight | Scoped, evidenced claim worth attention | I | AI + derived | Evolves | Observation, Evidence, Drivers, Recs | Insights, Home | M-04 |
| Driver Hypothesis | Possible explanation | I | AI | Evolves | Insight, Evidence | Insight detail | Never fact |
| Recommendation | Proposed business action | J | AI + derived; decision by user | Status changes | Insights, Tracked Action | Insights › Recommendations, Home | IA-09 |
| Tracked Action | What the customer did | J | User | Editable by owner; retired if the recommendation is reopened | Recommendation (at most one active, M-12), Follow-up | Recommendation | No sub-actions or task lists |
| Follow-up | Descriptive before/after | J | Derived | Until ready; then stable | Tracked Action, Aggregates | Recommendation, Reports | UX-13 |
| Report | Period snapshot | K | Derived | Per generation | Insights, Recs, Aggregates, Evidence | Reports | M-03; OQ-15 |
| Alert | Attention signal for a recipient | K | Product rule | State changes | Related object, recipient | Shell › Alerts | OQ-17 |
| Workspace Attention Signal | Minimal cross-workspace indicator | K | Derived | Recomputed | Workspace | All workspaces, switcher | OQ-25 |
| Audit Event | Consequential change record | X | All origins | Immutable | Any object | Activity history | — |
| Provenance | Origin + inputs + method + time | X | — | Immutable with its object | Every derived object | "Why?" explanations | — |

---

## 52. Relationship matrix

| Subject | Relationship | Object |
|---|---|---|
| Organization | contains | Workspaces |
| User | is a member of (with a role) | Workspace |
| Workspace | is labeled with | Brand(s), Market |
| Workspace | runs in | Operating mode (Standard / Monitor-only) |
| Workspace | owns | Connections, Connected Accounts |
| Connection | was authorized by | User (provenance, not ownership) |
| Connection | exposes | Social Assets |
| Connected Account | is | a Social Asset brought into the workspace |
| Connected Account | has | Capability Profile, Coverage Records |
| Connected Account | publishes | Content Items |
| Ad | distributes | Content Item (many ads ⇄ one content) |
| Ad | belongs to | Ad Group → Campaign |
| Content Item | is classified as | Organic / Paid / Mixed / Unknown (with history) |
| Content Item | contains | Conversations |
| Conversation | contains | Interactions |
| Conversation | is assigned to | Member |
| Conversation | may be raised by | Escalation |
| Conversation | is ordered by | Priority (with reasons) |
| Interaction | replies to | Interaction (parent) |
| Interaction | is written by | Author |
| Interaction | has | Source Text Versions, Language Assessment |
| Interaction | has | Classification Assessments (per dimension) → Accepted Interpretation |
| Interaction | is evaluated for | Protection |
| Interaction | contributes to | Topic(s) |
| Interaction | has | Moderation State (via Moderation Events) |
| Moderation Policy | produces | Automation Decisions → (maybe) Moderation Events |
| Protection Evaluation | can veto | Automation Decision |
| Operating mode | can veto | Platform actions and automation |
| Aggregate | summarizes | Interactions / Conversations / actions over a scope × window |
| Observation | is derived from | Aggregates + Evidence |
| Insight | is built on | Observation |
| Insight | is supported by | Evidence |
| Evidence | points back to | Interactions / conversation scope / aggregates |
| Insight | may be explained by | Driver Hypotheses |
| Recommendation | originates from | Insight(s) |
| Tracked Action | responds to | Recommendation (at most one active per recommendation, M-12) |
| Follow-up | measures after | Tracked Action (same scope as the insight) |
| Suggested Reply | is grounded in | Brand Context items |
| Outbound Reply | may start from | Suggested Reply or Saved Reply |
| Public Outbound Reply | may become, when confirmed by the platform | a brand Interaction in the public thread |
| Private Outbound Reply | is recorded as | an outbound record linked to the target Interaction, plus a history marker in the Conversation (never an Interaction) |
| Report | assembles | Insights, Recommendations, Follow-ups, Aggregates, Evidence for a period |
| Alert | points to | a related object, for a recipient |
| Workspace Attention Signal | summarizes | one Workspace for All workspaces |
| Audit Event | records changes to | any object |

---

## 53. Lifecycle summary

### A. Conversation

```
[new top-level comment] ─▶ OPEN ──(reply sent / native brand reply / marked done)──▶ DONE
                            ▲                                                         │
                            └────(new audience message needing handling / Undo)───────┘
   escalation (open/closed), assignee and priority change independently while OPEN
```

### B. Recommendation

```
OPEN ──accept──▶ ACCEPTED ──mark done (date)──▶ DONE ──▶ Tracked Action ─▶ Follow-up
  │                  │                            │
  └──dismiss──▶ DISMISSED ◀──dismiss──┘           └──reopen (mistake)──▶ ACCEPTED
  (derived notices: "evidence has weakened" · "may no longer apply" — not statuses)
  DONE creates the single active Tracked Action (M-12); reopening retires it (kept as history)
```

### C. Moderation Policy

```
OFF ──preview (required for links/patterns)──▶ ON ──pause──▶ PAUSED ──resume──▶ ON
 ▲                                            │                 ▲
 └────────────────turn off────────────────────┘                 │
 workspace → Monitor-only:  ON / PAUSED ──▶ SUSPENDED
 workspace → Standard:      SUSPENDED ──▶ PAUSED  (IA-16; explicit re-enable; fresh preview
                                                   for link/pattern policies)
 kill switch: all ON ──▶ PAUSED
```

### D. Connection

```
CONNECTING ──▶ ACTIVE ◀──reconnect── DEGRADED
     │           │  │                   ▲
     ▼           │  └──partial failure──┘
   FAILED        ├──revoked / expired──▶ DISCONNECTED ──reconnect──▶ ACTIVE
                 └──removed by user────▶ REMOVED (data handling per OQ-21 / OQ-13)
```

### E. Insight

```
(candidate observation) ─▶ GENERATED ─▶ SHOWN ─▶ UPDATED (evidence changed) ─▶ SHOWN
                                          │
                                          ├──▶ RESOLVED / EXPIRED (pattern ended)
                                          └──▶ MARKED NOT USEFUL (hidden from default list)
```

---

## 54. Open conceptual-model decisions

| ID | Question | Why it matters | Recommendation / decision | Blocks TA? | Status / resolve when |
|---|---|---|---|---|---|
| **M-01** | Can the same Social Asset be connected to more than one workspace (within one organization, or across organizations)? | Duplicate replies, double automation, conflicting workflow, isolation. | MVP: one active workspace per Social Asset within an Organization. Across organizations, accept that it can't be prevented, but keep data fully isolated per workspace. **Recommendation only, not confirmed.** | NO, but it is the **first decision of Technical Architecture** | **OPEN.** Resolve at the **beginning of Technical Architecture**, before finalizing connection ownership and uniqueness behavior (with PD OQ-13) |
| **M-02** | Effective source of interactions that predate a boost (organic comments on content later boosted). | Organic vs paid mixes, unattended-paid metrics. | Use time-aware source where the platform provides boost timing; otherwise the content's current classification, marked "Mixed". | NO | **OPEN.** After API validation (PD OQ-19) |
| **M-03** | Are generated reports frozen snapshots, or regenerated when underlying data (corrections, late imports) changes? | Shared reports must be stable; corrections must not be hidden. | Freeze each generated report with an as-of time. Allow an explicit "regenerate", which keeps the previous generation. | NO | **OPEN.** With PD OQ-15 |
| **M-04** | When an insight's evidence changes materially, is it the same insight updated or a new one? | Recommendation continuity, follow-up anchoring, history. | Same insight identity with versions. A different claim becomes a new insight. Recommendations reference the version they were issued from. | NO | **OPEN.** Technical Architecture |
| **M-05** | Accepted-interpretation precedence among human, rule, AI and platform signals. | Determines what automation and priority act on. | Human > deterministic rule (narrow facts only) > AI > platform interpretive hint. Interpretations only; source facts are never overridden (§15.2). | — | **CONFIRMED** (Phase 0D.1) |
| **M-06** | Is authenticity ("likely bot") an author-level assessment within a workspace, or interaction-only? | Repeat bots, obvious-bot policy accuracy. | Both: interaction-level signal plus workspace-scoped author summary. Never cross-workspace. | NO | **OPEN.** Technical Architecture / AI design |
| **M-07** | Should Protection evaluation treat "uncertain" as protected for automation (fail-safe)? | Safety of auto-hide. | Uncertain is a safety veto for automation: no auto-hide, Needs review where relevant. Individual human moderation stays possible (§17). | — | **CONFIRMED** (Phase 0D.1) |
| **M-08** | Should topic identity support merge and split with assignment history (ahead of PD OQ-10)? | Avoids rework when topic management is decided. | Yes, conceptually supported now. UX decided with OQ-10. | NO | **OPEN.** With PD OQ-10 |
| **M-09** | How are platform-side comment edits handled? | Evidence integrity, re-classification. | Keep all source versions. A new version triggers re-assessment. Human corrections persist unless a person revisits them. | NO | **OPEN.** After API validation (whether edits are exposed) |
| **M-10** | Shared system-topic catalog across workspaces vs fully workspace-local topics. | Multilingual consistency vs isolation. | A shared catalog of *definitions* only (no data). Per-workspace instances and data. | NO | **OPEN.** Technical Architecture |
| **M-11** | How are authors shown in guest-presentable evidence (names, handles, or anonymized)? | Privacy / data minimization (PD R-09) vs evidence credibility. | Show text excerpts. Minimize author identity for client guests by default. Decide with the legal review. | NO | **OPEN.** With PD OQ-21 / legal review |
| **M-12** | One Tracked Action per recommendation (MVP) vs several? | Follow-up anchoring. | At most one **active** Tracked Action per Recommendation in the MVP: the action the customer actually chose. No sub-actions, task lists, parallel actions or approvals (§28). | — | **CONFIRMED** (Phase 0D.1) |

**Preserved dependencies (unchanged, still open in their source documents):**
- PD OQ-10 (topic management) · OQ-13 (agency authorization/offboarding) · OQ-15 (report delivery) · OQ-16 (baselines/thresholds) · OQ-17 (alert/escalation channels) · OQ-18 (capability matrix) · OQ-19 (source reliability) · OQ-21 (retention/deletion) · OQ-23 (saved reply governance) · OQ-24 (Brand Context minimums) · OQ-25 (attention criteria) · OQ-26 (connection continuity) · OQ-28 (AI quality per language)
- UX-03 · UX-07 · UX-08 · UX-09 · UX-13 · UX-16 (deferred)
- IA-06, IA-07, IA-08, IA-12, IA-14 (open)

---

## 55. Technical-architecture handoff requirements

The next phase must be able to support all of the following. It chooses *how*.

1. **Strict workspace isolation** of all conversation-derived data, interpretations, intelligence and configuration. Only Workspace Attention Signals cross the boundary, and only for permitted users.
2. **Separation of source facts from interpretations**, with source text versions preserved as received.
3. **Provenance on every interpretation and derived object**: origin, inputs, method identity, time.
4. **Assessment history** with a current accepted interpretation per dimension, and attributable human corrections that are never overwritten by later machine output.
5. **Multi-dimensional, multi-value classification** with per-dimension confidence.
6. **Structural safety vetoes**: protection, Monitor-only and platform capability, evaluated before any platform mutation, with each decision recorded.
7. **Capability-aware behavior** per platform × account × content type × connection state, with reasons and as-of times.
8. **Coverage as a first-class input** to every aggregate, insight, comparison and report, plus a value state that distinguishes "not available" from zero.
9. **Event history** for workflow, moderation, policies, operating mode, connections, recommendations and memberships (audit), including automatic and native changes.
10. **Temporal truth**: source vs observed vs created times, validity of interpretations over time, comparison windows, as-of markers.
11. **Derived, recomputable intelligence** (aggregates, observations, insights) with lineage back to evidence and source, without losing earlier states that decisions or snapshots referenced.
12. **Asynchronous intelligence that stays consistent**: operational state is near-current, intelligence carries as-of times, and surfaces never contradict each other silently.
13. **Evidence drill-down** that resolves through the canonical conversation list for permitted roles, and stops at guest-presentable examples for client guests.
14. **Multilingual source preservation**, with translations as separate, regenerable derived representations.
15. **Correction propagation** with immediate operational effect and refresh-based intelligence effect.
16. **Before/after comparisons** anchored on tracked actions, with coverage per window, and no causal machinery implied.
17. **Human-only outbound replies and destructive actions**, with full attribution of AI-assisted origins.
18. **Retention-ready design** that can apply future retention and deletion policy (PD OQ-21) without breaking lineage semantics.

---

## 56. Acceptance criteria

1. Every critical MVP concept has a precise definition (§4–§41, §51).
2. Conversation and Interaction are clearly distinct (§10, §11).
3. Workflow status and moderation state are clearly distinct (§10.2, §18, §31).
4. Source facts and AI interpretations are clearly distinct (§1.1, §13, §15, §43).
5. Classification is multi-dimensional (§14).
6. Classification history and correction are representable (§15, §47).
7. Topic, Aggregate, Observation, Insight and Recommendation are distinct (§21–§27).
8. Evidence is first-class (§24).
9. Driver hypotheses are not represented as facts (§26).
10. Recommendations don't imply causality (§27).
11. Tracked Actions and Follow-ups are distinct (§28, §29).
12. Before/after remains descriptive (§29).
13. Complaint protection can structurally veto automation (§17, §19).
14. Monitor-only can structurally veto platform mutations (§4, §19).
15. Platform capability and coverage limitations are representable (§6, §7).
16. Missing data isn't represented as zero (§7, §49).
17. Multilingual source text is preserved (§13).
18. Client guest evidence restrictions remain possible (§24, §37).
19. Cross-workspace scope remains minimal (§39).
20. Every consequential change can be audited (§40).
21. Original platform evidence stays distinguishable from derived data (§41, §43).
22. No database, schema or technology design was introduced.
23. Source documents were not modified.
24. Only `docs/intelligence-data-model-v1.md` was created.
25. Interpretive precedence never overrides source facts, and deterministic rules stay narrow (M-05, §15.2).
26. Uncertain protection vetoes automation without blocking individual human moderation (M-07, §17).
27. At most one active Tracked Action per Recommendation, with no task or project model (M-12, §28).
28. Private replies never become Conversation Interactions. They leave an auditable history marker (§36).
