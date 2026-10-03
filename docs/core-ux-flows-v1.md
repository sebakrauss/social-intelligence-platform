# Core UX Flows v1 — Social Conversation Intelligence Platform

| Field | Value |
|---|---|
| Document | Core UX Flows v1 |
| Phase | 0C — Core UX Flows |
| Version | 1.0 |
| Date | 2026-10-03 |
| Status | **Approved** by the product owner on 2026-10-03 (Phase 0C.1) |
| Sources of truth | `docs/product-definition-v1.md` v1.2 (approved) · `docs/information-architecture-v1.md` v1.1 (approved) |
| Scope | How users move through the product: intent, decision points, system responses, branches, unavailable states and successful outcomes. **Not** visual design, wireframes, components, data schema, technical architecture or implementation. |

### Approval record

| Date | Phase | Decision |
|---|---|---|
| 2026-10-03 | 0C | Core UX Flows v1.0 drafted. |
| 2026-10-03 | 0C.1 | Product owner approved Core UX Flows v1.0 and locked IA-01, IA-02, IA-03, IA-04, IA-09, IA-10, IA-13, IA-15, IA-16 and UX-01, UX-02, UX-04, UX-05, UX-06, UX-10, UX-12, UX-15. UX-14 is not adopted. UX-03, UX-07, UX-08, UX-09, UX-13 and UX-16 are deferred, and UX-11 is out of the MVP (§28). The capability-availability rules were aligned with the IA: platform limits are visible but unavailable, never hidden (§25). The IA moved to v1.1 in the same phase. The Product Definition is unchanged. Version 1.0 kept. |

---

## 0. How to read this document

### 0.1 Relationship to the source documents

- The **Product Definition (PD)** defines what the product is. The **Information Architecture (IA)** defines where things live. This document defines **how users move** through them.
- Nothing here changes a PD or IA decision. When a flow depends on a source decision, it cites it (e.g. "PD D-49", "IA §7.8", "IA-11").
- Status tags are inherited, never upgraded: **(PD: CONFIRMED)**, **(PD: PROPOSED)**, **(PD: VALIDATE)**, **(IA: CONFIRMED)**.
- **(UX: CONFIRMED — UX-nn)** and **(IA: CONFIRMED — IA-nn)** mark decisions the product owner locked in Phase 0C.1.
- **[UX-REC]** marks a flow-level design choice that is part of the approved v1.0 baseline. It can be refined during wireframing without a formal decision, as long as no confirmed decision changes.
- **DEFERRED** items are open, with a named dependency (§28).
- Flows never assume a platform capability is available. Where an action depends on Facebook, Instagram or TikTok, the flow includes its unavailable branch (PD: VALIDATE — OQ-18).

### 0.2 Flow format

Major flows use this structure: **Primary persona · Goal · Entry point · Preconditions · Primary path · Success state · Important branches · Unavailable / error states · Role differences · Monitor-only behavior · Platform-capability behavior · Open UX questions**. Sections that don't apply are omitted. Trivial transitions are not documented. **Manager+** means Manager, Admin and Owner (PD §11.3 role set, PROPOSED).

### 0.3 Flow index

| ID | Flow | Section |
|---|---|---|
| F-01 | Product entry | §4 |
| F-02 | New-customer onboarding | §5 |
| F-03 | First value / first session | §6 |
| F-04 | Home → action | §7 |
| F-05 | Inbox triage | §8 |
| F-06 | Conversation handling | §9 |
| F-07 | AI-assisted public reply | §10 |
| F-08 | Saved replies | §11 |
| F-09 | Private reply | §12 |
| F-10 | Human moderation (hide, unhide, delete, block) | §13 |
| F-11 | Safe automation configuration | §14 |
| F-12 | Monitor-only workspace | §15 |
| F-13 | Classification correction | §16 |
| F-14 | Escalation | §17 |
| F-15 | Content & Ads investigation | §18 |
| F-16 | Insight exploration | §19 |
| F-17 | Voice of Customer | §20 |
| F-18 | Recommendation and follow-up | §21 |
| F-19 | Reports (incl. Client Guest journey) | §22 |
| F-20 | Cross-workspace attention | §23 |
| F-21 | Search and commands | §24 |
| F-22 | Capability-unavailable pattern | §25 |
| F-23 | Empty and recovery states | §26 |

---

## 1. Executive UX flow summary

### 1.1 Experience philosophy

The product does the heavy work of listening and understanding in the background. It brings the user in only when a **decision** is needed. Every flow begins with an answer ("4 people asked about price on your active ads"), offers one obvious next step, and ends in a visible outcome ("Replied · 3 of 4 handled"). Depth is always available, but it never comes first.

Three commitments shape every flow:

1. **Understand broadly, act carefully** (PD principle 2). The AI labels, explains, prioritizes and suggests. Humans send, moderate and decide. Automation only hides clearly harmful content, only when the customer has opted in, and only in Standard workspaces.
2. **Every claim leads to evidence, and every piece of evidence leads to an action** (PD principle 3). Aggregates link to examples, examples link to conversations (for roles that can see them), and conversations link to actions.
3. **Honest limits, never dead ends** (PD principle 10; IA §18). When something can't be done, the user learns why and what they can do instead.

### 1.2 How the five destinations cooperate

```
                ┌──────────────┐   "what needs me?"
                │     Home     │──────────────┐
                └──────┬───────┘              │
     attention items   │   what changed       │ suggested next steps
                       ▼                      ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ Content & Ads│◀─▶│    Inbox     │◀─▶│   Insights   │
│ which content│   │ act on       │   │ why, and what│
│ drives what  │──▶│ conversations│◀──│ to do (VoC,  │
└──────┬───────┘   └──────────────┘   │ recommend.)  │
       │                              └──────┬───────┘
       └──────────────┬───────────────────────┘
                      ▼
               ┌──────────────┐
               │   Reports    │  "what happened this period, to share"
               └──────────────┘
```

- **Home** routes. It never becomes the place where work is done.
- **Inbox** is where conversations are acted on. It is also the single full list behind every piece of evidence (IA §10.4).
- **Content & Ads** and **Insights** explain. Both send users to the Inbox to act, or to Recommendations to change the business.
- **Reports** look back over a period. They assemble existing intelligence and never compute it again (IA §12.2).

### 1.3 The core loop as a journey (required output A)

| Loop stage | What the user experiences | Where | Flow |
|---|---|---|---|
| **Listen** | Connects accounts once. History arrives with honest coverage. New comments keep arriving with no effort. | Settings › Connections → Home | F-02 |
| **Understand** | Sees labels and "Why it's here" on every conversation, plus patterns in Insights and Content & Ads. | Inbox, Insights, Content & Ads | F-05, F-15, F-16, F-17 |
| **Prioritize** | Gets a calm "Needs attention now" answer and an Inbox ordered by importance, with reasons. | Home, Inbox › Priority | F-04, F-05 |
| **Act** | Replies with a grounded suggestion or saved reply, moderates harmful content, assigns, escalates, or relies on opt-in auto-hide for obvious spam. | Conversation detail; Settings › Moderation | F-06 to F-11, F-14 |
| **Measure** | Sees performance and period summaries. | Reports | F-19 |
| **Learn** | Accepts a recommendation, does the work, marks it done, sees a descriptive before/after. | Insights › Recommendations | F-18 |

### 1.4 Why it feels simple despite its depth

- **Five destinations, one question each** (IA §5). Users always know where they are.
- **Stable scope.** The workspace, source scope (All/Organic/Paid) and analysis period follow the user, so they rarely re-filter (§3).
- **Context travels with the user.** Following an attention item or a piece of evidence opens the destination already scoped, with a visible way back.
- **One primary action at a time.** Each decision point has one recommended next step. Alternatives are one level down.
- **No configuration is needed to get value.** Brand Context, Saved Replies and automation all improve the experience, but none is required on day one.
- **Same flows for everyone.** Agencies, SMBs, Monitor-only workspaces and client guests use the same flows, adapted by role, mode and capability rather than by separate products.

---

## 2. UX flow principles

| # | Principle | What it means in flows |
|---|---|---|
| P1 | **Answer first, controls second** | Every surface opens with a plain-language statement. Filters and options appear after the answer. |
| P2 | **Explain why** | Priority, labels, insights, recommendations, automatic hides and unavailable actions all carry a one-line reason, with detail on demand. |
| P3 | **Preserve user context** | Drilling down never loses the origin. Context arrives as visible, removable filters with a path back. Drafts survive navigation and errors. |
| P4 | **One primary action at a time** | Each step offers one recommended action. Secondary actions are present but quieter. Destructive actions are separated. |
| P5 | **Reversible where possible** | Hide, assignment, status, labels and automatic hides can be undone. Irreversible actions (delete, and block where the platform makes it irreversible) need an explicit confirmation that states the consequence. |
| P6 | **Safe defaults** | Automation is off by default. Protected categories can never be auto-hidden (PD D-35). Monitor-only disables every platform mutation (PD D-49). Suggestions are never sent automatically (PD D-45). |
| P7 | **Capability honesty** | Users never meet a silent failure. Unavailable actions say why, in outcome language (IA §18; PD C-07). |
| P8 | **Graceful degradation** | Partial data still produces partial value: counts and examples when trends aren't reliable, and other platforms when one fails. |
| P9 | **No dead ends** | Every empty, error or unavailable state names the next possible step, even if that step is "nothing needed". |
| P10 | **Consistent role behavior** | Role limits hide controls. Workspace mode and platform limits explain them (IA §18 rules). |
| P11 | **Calm empty states** | "Nothing urgent" is a success state, not an empty screen. |
| P12 | **Negative is not harmful** | Flows never nudge users to hide content because it's negative. Hide is promoted only for harmful labels (PD principle 1). |
| P13 | **Minimal modality** | Confirmations are used only for irreversible or mode-changing actions. Everything else is inline, with undo. No wizards beyond first-run onboarding. |

---

## 3. Global flow model

### 3.1 Scope persistence

| Scope | Persists across | Local to | Behavior when changed |
|---|---|---|---|
| **Organization** | Everything | — | Rarely changes. Only users in more than one organization see an organization choice (an edge case). |
| **Workspace** | All five destinations and Settings › Workspace | — | Switching workspaces keeps the source scope and analysis period, and resets local filters, open items and drafts. Unsent drafts trigger a "Discard draft?" prompt. |
| **Brand / Market** | — | All workspaces (grouping and filter); inside a multi-brand workspace, a local filter on Inbox, Content & Ads and Insights (IA-07) | Not a global scope. Brand and Market are labels (PD C-11). |
| **Source scope** (All · Organic · Paid) | Home, Inbox, Content & Ads, Insights, within a session and across workspace switches | Not applied to Reports (§3.2) | Changing it updates the current destination immediately. Mixed and Unknown are under All and available as filters (IA §4.1). |
| **Analysis period** (default: last 30 days) | Content & Ads and Insights | Home uses "now vs baseline". Inbox uses waiting time and an optional date filter. Reports use their own report period. | Persists between Content & Ads and Insights. |
| **Platform filter** | — | Each destination's filters (and saved views) | Platforms are filters, never modes (IA §4.2). |
| **Other filters** (type, topic, risk, assignee…) | — | The destination where they're set | Saved views capture them (Inbox). |

### 3.2 Reports and the source scope [UX-REC]

Reports **ignore the global source scope by default** and always cover all sources, with organic/paid/mixed breakdowns inside. A report is meant to be shared, and a report silently limited to "Paid" because of a leftover scope would mislead its readers. Users can still choose a source focus explicitly inside a report, and the report then states it in its title.

### 3.3 Carried context

When a user follows a link from an aggregate or attention item into another destination:

1. The destination opens **already scoped** (e.g. Inbox filtered to "Purchase questions · Paid · waiting > 4h").
2. The applied scope is shown as a **named context** ("From Home: unanswered purchase questions"). The user can remove it in one step.
3. A **return path** to the origin is always available.
4. When the scoped set is completed, a completion state offers **"Back to [origin]"** and **"Continue in [destination default view]"** (§7).

---

## 4. Product entry flow (F-01)

**Primary persona:** every user · **Goal:** land somewhere useful immediately · **Entry point:** sign-in, or opening the product · **Preconditions:** user belongs to at least one workspace (otherwise → onboarding, §5)

### 4.1 Default landing by situation

| Situation | Default landing | What the user sees first |
|---|---|---|
| **A. One-workspace SMB** | **Home** of their workspace | Needs attention now, or "Nothing urgent". No switcher list and no organization concepts (IA §16.5). |
| **B. Multi-workspace agency or team** | **All workspaces** (UX: CONFIRMED — UX-01) | Which workspace needs attention, sorted by attention (PD J-G1). One step into any workspace's Home. |
| **C. Client guest** | **Reports › Summary** of their workspace (IA-05; UX-01). If more than one workspace is granted: the last used. | The latest period summary. If no usable report exists yet: **Insights**, with a calm explanation (UX: CONFIRMED — UX-15; §22.5). |
| **D. Workspace with a connection issue** | As in A or B. All workspaces flags the connection problem; on the workspace's Home, the **blocking notice** comes first (IA §6 block 0) | Which account stopped, since when, what's missing, and who can fix it. Data already imported stays usable. |
| **E. Monitor-only workspace** | As in A or B. All workspaces shows the "Monitor-only" label; the workspace's Home is unchanged | The persistent Monitor-only indicator. On the first visit after the mode changed, a one-time inline explanation (not a modal) of what's unavailable and why (§15). |

**No personal start-page preference in the MVP** (UX: CONFIRMED — UX-01). After entry, users navigate normally. Home remains the entry point whenever a user enters a workspace (IA v1.1 §4.4).

### 4.2 Branches

- **Workspace was removed or access revoked since the last visit:** land on the next available workspace (or All workspaces) with a brief notice: "You no longer have access to Client D."
- **Deep link to a surface the role can't access** (e.g. a guest opening an Inbox link): an access page saying "You don't have access to this. Ask a workspace admin." with a path to the user's default landing. This is the one place permissions are explained rather than hidden (§25).
- **No workspace at all** (invited to an organization without workspace access): a calm page "You haven't been added to a workspace yet" naming who can add them.

---

## 5. New-customer onboarding flow (F-02)

### 5.1 Journey (required output B)

```
Sign up
  │
  ▼
Create organization  ──or──  Join via invitation (skips to their workspace)
  │
  ▼
Create first workspace (name; optional Brand / Market labels; optional mode)
  │
  ▼
Connect social accounts ◀──────────── add more later anytime
  │  (Facebook · Instagram · TikTok · related ad accounts)
  ▼
Coverage check per account (what we can see, what's limited)
  │
  ▼
Historical import starts (target: 30 days) ──▶ meanwhile: Brand Context essentials (optional)
  │
  ▼
Import complete → coverage summary → "What we found" on Home → first useful action
```

**Primary persona:** P1 owner-operator; also P3 agency admin setting up a client · **Goal:** reach the first useful result fast · **Entry point:** sign-up · **Preconditions:** none

### 5.2 Primary path

1. **Sign up and create an organization.** Ask only for what's essential: name, and the person's interface language (default from browser).
2. **Create the first workspace.** One field: the workspace name (e.g. "Café Aurora" or "Client — Café Aurora"). **Brand** and **Market** labels are optional and collapsed ("Add brand or market labels — useful if you manage several"). Skipping is the default path. An optional, lightweight question, **"How will you use this workspace?"**, offers **Standard** (default) or **Monitor-only**, with one line explaining each. Owner and Admin can change it later (UX: CONFIRMED — UX-02). This is not a configuration wizard.
3. **Connect accounts.** The user picks Facebook, Instagram and/or TikTok and authorizes. A short reassurance states that **the connection belongs to this workspace, not to you personally** (PD D-48). Ad accounts are offered where relevant, with "Add ad accounts to see comments on your ads".
4. **Coverage check.** For each connected account, the product states in outcome language what it can see and do:
   - "Comments on posts: yes"
   - "Comments on ads: yes / not available for this account"
   - "History: up to 30 days / limited"
   - "Reply and hide from here: yes / limited"

   All of this is based on validated capabilities only (PD C-07, VALIDATE).
5. **Import starts.** Home shows the **importing history** state: progress per account, what will appear, and an estimate if available (IA §20). The user isn't blocked.
6. **Brand Context essentials (optional, during the wait).** A short prompt: "While we import, tell us the basics so suggested replies can give real answers instead of 'we sent you a DM'." Three light sections are offered: identity, contact channels, a few key facts. It can be skipped, and the minimum is open (PD OQ-24).
7. **Import completes.** Home shows the **coverage summary** (e.g. "Instagram: 30 days · Facebook: 30 days · TikTok: 12 days · ad comments: Facebook and Instagram"), then **"What we found"** (§6).
8. **First useful action.** The user follows the top item (often unanswered purchase questions or a risk).

### 5.3 Success state

Within the first session the user has: at least one account connected, a clear picture of coverage, and an answer to "what needs my attention?". Ideally they've handled or saved at least one item (PD §19.1, PROPOSED target).

### 5.4 Important branches

| Branch | Behavior |
|---|---|
| **User skips optional steps** (labels, Brand Context, ad accounts, teammates) | Nothing blocks. Skipped items reappear later as contextual prompts at the moment they matter (e.g. a Brand Context gap during a reply). No nagging checklist on Home. |
| **Only one platform connected** | Full experience for that platform. Home and Connections show "Add Instagram or TikTok to see those conversations too" once, calmly, not as a warning. |
| **One platform fails to connect** | The other connections proceed. The failed one shows the reason in outcome terms and a retry. Import runs for what succeeded. |
| **Partial historical coverage** | Import completes with what's available. The coverage summary states exactly what's partial ("TikTok: 12 of 30 days"). Affected insights carry a coverage note (IA §10.5). |
| **No paid-data capability** (no ad account access, or not supported for that platform) | Organic works fully. Paid areas explain: "Comments on ads aren't available for this account" plus the recovery if one exists (connect the ad account, or ask someone with access). Paid is never shown as empty "zero" data. |
| **Import still running when the user arrives on Home** | The importing state remains. Partial results may appear early, labeled "Early results — import still running". The Inbox is available for comments already imported. |
| **Zero historical comments** | Success with an honest message: "No comments in the last 30 days on these accounts. New comments will appear here as they arrive." Next steps: set up Brand Context and invite teammates. No fake insights. |
| **Insufficient permissions on the platform** (the person can't grant access to a page or ad account) | Explain in outcome language: "Your account can't give access to [Page]. Someone with admin access to it on [platform] needs to connect it." Offer **Invite a teammate** to the workspace. Who normally authorizes in agency setups is open (PD OQ-13). |
| **Connection revoked** (during or after onboarding) | The account shows "Disconnected since [time]". Data already imported stays. New comments stop. Reconnect is offered to roles that can manage Connections; others can notify an admin (IA §20). |
| **Joined via invitation** | Skip organization and workspace creation. Land on the workspace's default (§4), with a one-line welcome naming their role. |
| **Agency setting up many clients** | After the first workspace: "Add another workspace" from All workspaces or Settings › Organization › Workspaces. Each workspace follows steps 2–7 independently. |

### 5.5 Unavailable / error states

- **Authorization cancelled by the user:** back to the connect step, no error tone.
- **Platform temporarily unavailable during connection:** "Instagram isn't responding right now. Try again in a few minutes." Other connections are unaffected.
- **Import interrupted:** resumes automatically when possible. Coverage reflects what was imported, with a timestamp.

### 5.6 Role differences

Only roles that can manage Connections (Owner, Admin; IA §18) can connect accounts. Other invited roles skip connection steps. If the workspace has no connections, they see "No accounts connected yet. [Admin name] can connect them."

### 5.7 Platform-capability behavior

Every capability statement in the coverage check comes from validated platform behavior. Unvalidated capabilities are not promised. They appear as "not available" with a plain reason, never silently omitted (PD C-07; §25).

### 5.8 Open UX questions

UX-03 (DEFERRED: agency client authorization handoff, resolved with PD OQ-13 and technical validation). UX-02 is confirmed (step 2).

---

## 6. First-value / first-session flow (F-03)

**Primary persona:** P1, P3 · **Goal:** understand quickly what matters in the imported history · **Entry point:** Home after the import completes · **Preconditions:** at least one account imported

### 6.1 Primary path

Home shows a one-time **"What we found"** summary for the imported period, in this order. Each item has one link:

1. **Needs attention now:** open conversations needing a reply, especially unanswered purchase intent on active ads → Inbox, filtered.
2. **Risks:** reputation-risk conversations, fraud accusations against the brand, harmful content building up on ads → the conversations or the insight.
3. **What people ask most:** top recurring questions and unmet information needs → Insights › Voice of Customer.
4. **Emerging issues:** topics changing notably within the imported window, only where minimum volume is met → Insight.
5. **Content creating friction:** the posts or ads with the highest friction share → Content & Ads profile.
6. **A first recommendation**, only when evidence supports it → Insight detail.
7. **Protection opportunity**, if obvious spam or bots were found: "142 obvious spam comments on your ads in 30 days. Preview an auto-hide rule." → Settings › Moderation preview (§14). Not shown in Monitor-only workspaces, where the item instead reads "Detected for review" with no rule offer (§15).

After the first session, "What we found" collapses into the regular Home blocks (IA §6).

### 6.2 Success state

The user can answer, in their own words: what needs attention, what people ask, and whether anything is risky. They've taken at least one action or opened at least one insight.

### 6.3 Low-volume behavior

When volume is below the minimum for reliable patterns (PD §14.4, PROPOSED; thresholds open, OQ-16):

- Show **counts and representative examples** instead of trends and percentages: "12 comments in 30 days. 5 were questions. Here's what people asked."
- State plainly: "Not enough conversation yet to spot reliable trends. We'll highlight patterns as more comments arrive."
- Still surface individual items that need attention (unanswered questions, risks). Low volume never hides work.
- Recommendations appear only when evidence supports them. **No recommendation is better than a weak one.**

### 6.4 Branches

- **Import partial:** "What we found" names its coverage ("Based on Facebook and Instagram; TikTok history limited to 12 days").
- **Zero comments:** see §5.4. "What we found" is replaced by setup guidance.
- **Monitor-only workspace:** identical intelligence. The protection item becomes "Harmful content detected: review and escalate" (no rule offer).

---

## 7. Home → action flow (F-04)

**Primary persona:** P1; everyone on entering a workspace · **Goal:** move from "what needs me" to done, without hunting · **Entry point:** Home · **Preconditions:** workspace with data

### 7.1 Pattern

```
Home block item  ──▶  destination opened with carried context (§3.3)
                        │
                        ▼
                   act on item(s)
                        │
                        ▼
      scoped set completed ──▶ completion state: "All 4 handled"
                        │            ├── Back to Home (item now resolved)
                        │            └── Continue in [destination default]
                        ▼
      user leaves early ──▶ Home reflects progress ("2 of 4 still waiting")
```

Home items are **routes, not cards to manage**. Home never holds actions that belong elsewhere (no replying from Home).

### 7.2 Item routing

| Home item | Destination | Primary action there | Done when |
|---|---|---|---|
| **Unanswered purchase question(s)** | Inbox, filtered to those conversations | Reply (F-07) | Replied or marked "no reply needed" |
| **Reputation risk** | The conversations (if few) or the risk insight (if a pattern) | Reply, escalate (F-14), or moderate harmful items (F-10) | Each conversation handled or escalated |
| **Connection problem** (blocking notice) | Settings › Workspace › Connections, on the affected account | Reconnect (role permitting) or notify an admin | Connection healthy, or admin notified |
| **Unusual topic change** (What changed) | Insight detail | Inspect evidence, then accept or dismiss the recommendation (F-16, F-18) | Insight reviewed; recommendation decided |
| **Recommendation** (Suggested next steps) | Recommendation within the insight | Accept / dismiss / mark done (F-18) | Decision recorded |
| **Automatic hides to review** (Operational health) | Inbox › Hidden automatically | Review; undo false positives (F-11) | Reviewed |
| **Follow-up result ready** | Recommendation › follow-up | Read the descriptive before/after | Viewed |

### 7.3 Branches

- **Item resolved elsewhere** (a teammate handled it): when the user follows it, the destination says "Already handled by [name]" and offers the next item.
- **Item no longer valid** (e.g. a risk subsided): Home removes it at the next update. There are no stale alerts.
- **Monitor-only:** the purchase-question item routes to the same Inbox scope. The primary action there becomes **Assign / Escalate** (§15).
- **Read-only roles (Analyst/Viewer):** items route to the same places in read-only form (IA: CONFIRMED — IA-15).

---

## 8. Inbox triage flow (F-05)

### 8.1 Journey (required output C)

```
Open Inbox (default view: Priority, or the user's saved view)
  │   answer first: "18 open · 5 need a reply soon · 2 risks"
  ▼
Scan list: one primary label + "Why it's here" per conversation
  │
  ▼
Select conversation ──▶ detail (F-06): context, thread, labels, reasons
  │
  ├── Act ......... reply · moderate · mark done
  ├── Defer ....... assign to someone · escalate · leave open
  └── Skip ........ next conversation
  ▼
Advance to next work item (auto-advance after resolving actions)
  │
  ▼
View clear ──▶ inbox-zero state: "Nothing waiting in Priority" + next options
```

**Primary persona:** P2 community manager; also P1, P3 CM, P4 responders · **Goal:** clear what needs handling, most important first · **Entry point:** Inbox (navigation, Home item, or evidence link) · **Preconditions:** connected workspace

### 8.2 Views, filters and saved views

| Name | Kind | Contents | Notes |
|---|---|---|---|
| **Priority** | System view (default) | All **Open** conversations, ordered by priority, then waiting time | IA §7.2 |
| **Needs reply** | **Quick filter** on Priority (one click) [UX-REC] | Open conversations whose response need is "reply needed" or "reply recommended" | Not a separate system view. This keeps the IA's view list intact (IA §7.3). |
| **Needs review** | System view | Low-confidence items, abuse/insults flagged for review (PD D-34), items whose labels conflict, keyword-rule matches withheld by Always protected | Human judgment queue |
| **Assigned to me** | System view (team workspaces only) | Open conversations assigned to the current user | IA §7.3 |
| **Escalated** | System view | Open conversations with the Escalated flag | §17 |
| **Hidden automatically** | System view | Every automatic hide, its rule, its reason, Undo | History only in Monitor-only (IA §7.8) |
| **Done** | System view | Conversations with status Done, with their resolutions | Searchable history |
| **Saved views** | User-created (personal or shared) | Any filter combination, e.g. "Paid · Unassigned", "TikTok · Questions" | IA §7.3 |

### 8.3 Workflow status model (IA: CONFIRMED — IA-04)

Keep the model as small as the PD allows:

| Element | Values | Rules |
|---|---|---|
| **Status** | **Open** · **Done** | Every conversation is either waiting for someone or not. |
| **Resolution** (recorded when Done) | Replied publicly · Replied privately · Replied on platform (brand replied natively) · No reply needed · Moderated · Reviewed (Monitor-only) · Escalation closed | Set automatically when it can be inferred; otherwise the user picks one when marking done. |
| **Escalated** | Flag on an Open conversation | Doesn't change status. It is cleared when the escalation is closed or the conversation is Done (§17). |
| **Assignee** | Member or none | Independent of status. |

Behaviors:

- **Auto-done after reply** (IA-04): when the user sends a public or private reply and no other unhandled comment remains in the conversation, it becomes **Done** ("Replied publicly"), with a brief **Undo**. If unhandled comments remain, it stays Open.
- **Auto-done when the brand replied natively** (UX: CONFIRMED — UX-04): the native reply is imported into the conversation. If it came after the latest audience message and nothing else needs handling, the conversation moves to Done with "Replied on platform". This is visible and reversible.
- **Auto-reopen** (IA-04): a new audience comment that needs a reply or review **reopens** a Done conversation, and "Why it's here" says "New reply after you marked this done".
- **No Snoozed or Waiting statuses in the MVP** (UX: CONFIRMED — UX-05). No controls, statuses or views for them. Deferral is expressed by assignment, escalation or leaving the item Open. Revisit only after early-user evidence.
- **Every automatic status change** (auto-done, auto-reopen) is visible in the activity history and reversible where appropriate (IA-04).

### 8.4 Primary path

1. **Open Inbox.** The view header answers first: counts by urgency for the current scope.
2. **Scan.** Each list item shows platform, Organic/Paid/Mixed, author, excerpt, one primary label, "Why it's here", content reference, waiting time and assignee (IA §7.5-A).
3. **Select a conversation.** The detail opens beside the list, so list position is kept (§9).
4. **Understand why.** The full "Why it's here" factors are visible: what, where, how long, uncertainty, protection notices (IA §7.6).
5. **Decide:**
   - **Act:** reply (F-07), moderate a harmful comment (F-10), or mark done with a resolution.
   - **Defer:** assign (to self or a teammate), escalate (F-14), add a note, or leave it Open.
   - **Skip:** move to the next conversation without changes.
6. **Advance.** After a resolving action (reply sent, marked done, moderated and nothing left), the next conversation in the current view opens automatically [UX-REC]. After non-resolving actions (assign, note, label correction), the user stays on the conversation.
7. **Clear.** When the view is empty, the **inbox-zero** state appears (§26).

### 8.5 Success state

The chosen view is clear, or everything left in it is deliberately assigned or escalated.

### 8.6 Important branches

- **Arrived with carried context** (from Home, an insight, VoC, content): the context name is shown and removable. Completing the scoped set shows the completion state (§7.1).
- **Bulk actions** (PD: PROPOSED §9.2-B): for clearly homogeneous selections only, such as assign, mark done with a resolution, or hide confirmed spam. **Bulk hide is a human-initiated action, not automation** (UX: CONFIRMED — UX-06):
  - Protected categories (legitimate complaints, product/service problems, fraud/scam accusations against the brand, commercial objections) are **excluded from the selection being hidden**. The user sees how many were excluded and why ("3 comments excluded: complaints and objections can't be hidden in bulk").
  - The hidden comments are attributed to the person ("Hidden by Ana"). They never appear in Hidden automatically and are never called automatic hides.
  - Deliberate, individual human moderation of a protected comment remains possible (§13).
  - Bulk delete and bulk block are not in the MVP.
- **Concurrent handling:** if a teammate is viewing or has just acted on the same conversation, show "[Name] replied 1 minute ago" before the user sends, to avoid double replies.
- **New items arrive while triaging:** they're added without reordering the list under the user's cursor. A quiet "3 new" indicator offers a refresh.

### 8.7 Unavailable / error states

- **Connection unhealthy for some accounts:** conversations from those accounts are marked "Account disconnected". Platform actions on them are blocked with a recovery action (§25). Internal actions still work.
- **No results for filters:** "No conversations match these filters" plus the active filters and "Clear filters" (§26).

### 8.8 Role differences

- **Responder:** full triage. Delete and block appear only if granted (IA §18).
- **Analyst/Viewer:** sees views and conversations read-only. No action controls (hidden).
- **Manager+:** additionally sees team-oriented views ("Assigned to others", via filters).
- **Client guest:** no Inbox (IA-05).

### 8.9 Monitor-only behavior

The same views, ordering and reasons. The persistent Inbox notice explains the mode. Primary actions become **Assign · Escalate · Add note · Mark done (Reviewed)**. Platform actions are visible but unavailable. Hidden automatically shows history only (IA §7.8).

---

## 9. Conversation handling flow (F-06)

### 9.1 Journey (required output D)

```
Conversation opened
  │
  ├─ 1. Context:   content/ad preview · Organic/Paid/Mixed/Unknown · paid context
  ├─ 2. Why:       "Purchase question on an active ad · waiting 6h"
  ├─ 3. Thread:    comments + your replies + private-reply records + moderation states
  ├─ 4. Labels:    type · topic · risk · reply needed   (more on demand)
  ├─ 5. Author:    earlier comments in this workspace · authenticity signal
  ├─ 6. Workflow:  status · assignee · escalation · notes
  └─ 7. History:   previous actions (on demand)
  │
  ▼
Decide (one recommended action, based on labels):
  reply-needed question/complaint ──▶ Reply (F-07)       [primary]
  harmful (spam, malicious link…) ──▶ Hide (F-10)        [primary]
  risk / problem beyond the team  ──▶ Escalate (F-14)    [primary]
  nothing needed                  ──▶ Mark done ("No reply needed")
  │
  ▼
Act ──▶ system confirms in place ──▶ status/resolution updated ──▶ next conversation
```

**Primary persona:** P2, P1 · **Goal:** handle one conversation correctly and move on · **Entry point:** Inbox conversation (or a deep link from an alert or evidence) · **Preconditions:** role can view conversations

### 9.2 Recommended primary action [UX-REC]

The detail highlights **one recommended action** derived from the labels. It is a suggestion; the user can take any other action.

| Situation (labels) | Recommended action | Never recommended |
|---|---|---|
| Question, purchase intent, complaint, product problem, objection, fraud accusation against the brand | **Reply** | Hide or delete (negative is not harmful, PD principle 1) |
| Obvious spam, malicious link, scam content, obvious bot | **Hide** | — |
| Threat, severe risk, impersonation | **Escalate** (and moderate if appropriate) | — |
| Abuse/insult with no legitimate signal | **Review**: reply calmly, hide, or no action; no default push | Auto-hide (PD D-34) |
| Praise, advocacy, neutral | **Mark done** (optionally reply) | — |
| Low confidence | **Review labels** (F-13) | Any automated action |

### 9.3 Action hierarchy

| Tier | Actions | Behavior after action |
|---|---|---|
| **Primary** | Reply publicly · Mark done · Assign | Reply/Mark done resolve the conversation and auto-advance. Assign stays. |
| **Secondary** | Reply privately (where supported) · Escalate · Add note · Mark "no reply needed" · Hide / Unhide · Correct labels · Open content | Inline confirmation with Undo where reversible. The user stays unless the conversation is resolved. |
| **Destructive** | Delete comment · Block author | Separated. Explicit confirmation that states the consequence. Role-gated (IA §8.1). |

### 9.4 Destructive-action confirmation logic

A confirmation is required only for **Delete** and **Block** (and for Hide in bulk). It states:

1. **What will happen, on which platform:** "This permanently deletes this comment on Instagram."
2. **Reversibility:** "This can't be undone."
3. **A caution when the comment is legitimate negative content** [UX-REC]: "This looks like a complaint. Deleting complaints can damage trust. Consider replying instead." This informs; it never blocks, because human moderation of protected content remains possible (PD D-35).
4. **Confirm button named by the action** ("Delete comment"), never "OK".

### 9.5 After the action

- The thread updates in place (e.g. "Hidden by Ana · Undo"). The activity history records who, what, when and why (PD §9.2-J).
- If the conversation is resolved, it moves to Done with its resolution, and the next one opens.
- If an action fails (platform error), the state reverts. A clear message offers retry, and drafts are kept.

### 9.6 Important branches

- **Multiple unhandled comments in one thread:** the detail marks which comments still need handling. Replying to one doesn't resolve the others.
- **Conversation changed while open** (new comment, teammate action): an inline update notice appears without losing the draft.
- **Author has other open conversations:** shown in author context ("2 other open conversations from this author"), with a link that filters the Inbox to that author.

### 9.7 Monitor-only behavior

The composer is replaced by the explanation. Platform actions are visible but unavailable. The recommended action becomes **Escalate** or **Assign** for items that need a response, and **Mark done (Reviewed)** otherwise (IA §8.4).

### 9.8 Platform-capability behavior

Each platform action checks capability for this platform, account and content type. Unsupported actions show the platform reason (e.g. "TikTok doesn't allow hiding this comment through official tools") and, where useful, **Open on platform** (§25).

---

## 10. AI-assisted public reply flow (F-07)

### 10.1 Journey (required output E)

```
Conversation (reply needed)
  │
  ▼
User chooses Reply ──▶ composer opens with a suggested reply ready (not inserted)
  │                       ├── Grounding: "Based on: Shipping policy · Contact channels"
  │                       ├── Gaps:      "No price info in Brand Context  [Add it]"
  │                       └── Language:  written in the commenter's language (+ translation)
  ▼
User picks a starting point:
  [Use suggestion]  ·  [Saved reply]  ·  write manually
  │
  ▼
User reviews / edits (the text is always theirs to change)
  │
  ▼
User presses Send  ◀── the only way anything is published (PD D-45)
  │
  ▼
Sending… ──▶ Sent ✓ (appears in thread as your reply) ──▶ conversation Done if nothing else open
  │                                                      ──▶ next conversation
  └─ Failed ──▶ text kept · reason · Retry
```

**Primary persona:** P1, P2 · **Goal:** a correct, specific reply in the commenter's language, faster than writing from scratch · **Entry point:** conversation detail → Reply · **Preconditions:** Standard workspace; role can reply; platform supports public reply for this content

### 10.2 Primary path

1. **User chooses Reply.** For conversations with reply needed/recommended, a suggestion is **prepared** when the composer opens. It is shown beside the composer, **never inserted automatically**. Whether suggestions are prepared automatically or only on request is DEFERRED (UX-08). Under the on-request variant, this step becomes one **Suggest a reply** action; nothing else in the flow changes.
2. **Grounding status is shown with the suggestion** [UX-REC]:
   - **Grounded:** "Based on: [Brand Context items]."
   - **Partially grounded:** "Missing: [fact]. The suggestion doesn't include it." Includes **Add to Brand Context**.
   - **No facts needed:** for acknowledgments or thanks.
   - **Not enough verified information:** the suggestion is limited to acknowledging and pointing to an approved contact channel, and says so.
3. **User chooses a starting point:** **Use suggestion** (inserts it for editing), **Saved reply** (F-08), or writes manually.
4. **User edits.** The suggestion is a draft, nothing more.
5. **User presses Send.** No extra confirmation for public replies: the explicit Send is the human decision [UX-REC].
6. **System response:** sending state → sent. The reply appears in the thread as the brand's reply, with author and time. The activity history records "Replied (from suggestion, edited)" for attribution (PD §13.4-4, PROPOSED).
7. **Workflow update:** if no other unhandled comment remains, status → Done ("Replied publicly") with Undo of the status change, and the next conversation opens (§8.3).

### 10.3 Success state

A reply is published on the platform, written or approved by a person, with no invented facts. The conversation is resolved or clearly still open for the remaining comments.

### 10.4 Branches

| Branch | Behavior |
|---|---|
| **Verified Brand Context available** | Grounded suggestion with sources named. |
| **Brand Context incomplete** | A partially grounded suggestion. The gap is named, and **Add to Brand Context** opens the right section with the question pre-filled as context. After saving, the user can **Refresh suggestion**. |
| **No relevant verified fact** (e.g. the price is asked but unknown) | The suggestion never invents it (PD D-47). It acknowledges and routes to an approved channel, or offers to ask the team, and states "We don't have a verified price to share." |
| **AI confidence low** (the comment's meaning is unclear) | No suggestion is prepared automatically. The composer says "This comment is hard to interpret. Write a reply or request a suggestion anyway." A suggestion requested anyway carries a caution label. |
| **Inappropriate or unsafe suggestion** | Suggestions that fail safety checks are not shown: "Couldn't produce a suitable suggestion for this comment." The user can **Flag suggestion** on any shown suggestion (feedback, PD §13.4-9, PROPOSED), which removes it from view. |
| **Language mismatch** | The suggestion is in the commenter's language. If the user writes in another language, a non-blocking note appears: "The comment is in Portuguese; your reply is in Spanish." Translation on demand. |
| **Mixed-language comment** | The suggestion follows the dominant language. The user can switch the suggestion language. |
| **User chooses a saved reply** | F-08. The suggestion stays available beside it; the two are never blended silently (IA §14). |
| **User writes manually** | The suggestion stays dismissed for this conversation. No nagging. |
| **Teammate replied meanwhile** | Before sending: "[Name] replied 1 minute ago." The user can still send, edit or discard. |
| **Send fails** | Text preserved. Reason given in outcome terms (connection, platform rejection, content no longer available). Retry offered. |
| **Comment deleted on the platform before sending** | "This comment is no longer on [platform]." The draft is kept for copying. The conversation can be marked done. |

### 10.5 Unavailable states

| Condition | Behavior |
|---|---|
| **Role can't reply** (Analyst/Viewer) | Composer hidden. |
| **Monitor-only workspace** | Composer replaced: "This workspace is Monitor-only. Replies are made outside the product." No suggestion is generated (IA §8.4). |
| **Platform doesn't support public reply for this content** | Reply stays **discoverable but unavailable**, with the platform reason in outcome language and **Open on [platform]** (§25). Never hidden for a platform reason. |
| **Connection unhealthy** | Composer usable for drafting. Send is blocked with "Reconnect [account] to send", plus a recovery action for permitted roles. The draft survives reconnection [UX-REC]. |

### 10.6 Open UX questions

UX-07 (DEFERRED: editing or deleting a sent reply, after platform API validation), UX-08 (DEFERRED: automatic vs on-demand suggestion preparation, after AI cost modeling; the flow supports either without structural redesign).

---

## 11. Saved Reply flow (F-08)

**Primary persona:** P2, P1 · **Goal:** answer repetitive questions quickly and consistently · **Entry point:** reply composer; Settings › Workspace › Responding › Saved replies; a "create a saved reply" recommendation · **Preconditions:** Standard workspace for use in conversations; library access per governance (PD OQ-23)

### 11.1 Primary path — insert while replying

1. In the composer, the user opens **Saved replies** (also keyboard-searchable).
2. Replies **in the commenter's language** are listed first. Search covers name and text.
3. The user picks one. Its text is **inserted into the composer**, never sent.
4. The user edits as needed (e.g. a name or detail) and presses **Send** (F-07, steps 5–7).

**Success state:** a consistent, edited reply sent in seconds.

### 11.2 Other paths

| Path | Behavior |
|---|---|
| **Save a newly written reply** | After writing a reply, **Save as saved reply** asks for a name and confirms the language (pre-filled from the text). It's saved to the workspace library, or submitted for a manager to add, depending on governance (PD OQ-23). Sending and saving are independent. |
| **Create from a recommendation** | A "create a saved reply" recommendation (PD §14.5) opens the library's create form with the recurring question as context and, where available, a grounded draft based on Brand Context. For roles that can decide on recommendations (Owner, Admin, Manager — IA-09), saving offers to mark the recommendation **done** with today's date (F-18) [UX-REC]. |
| **Edit / retire in the library** | Edit changes future uses only; past replies are untouched. **Retire** stops a reply from being offered while keeping it in history. Retired replies can be restored. |
| **Missing language variant** | The picker shows the reply in other languages, labeled ("Only in Spanish"). Selecting it inserts the text with a note: "This saved reply is in Spanish; the comment is in Portuguese." Translation can be requested as a draft for the user to review [UX-REC]. It is never automatic. Conceptual language versions follow IA §14. |
| **Retired reply referenced** (e.g. from an old link) | "This saved reply was retired on [date]." Similar active replies are suggested. |
| **Insufficient permissions / governance unknown** | The library is always readable by roles that can reply. If governance restricts editing (PD OQ-23), edit controls are hidden and **Suggest a change** is offered instead [UX-REC]. The flow works under both "any responder" and "managers only" without structural change (IA §14). |

### 11.3 Boundaries

A saved reply **inserts text only**. Inserting one never changes status, assignment or labels, never triggers other actions, and never sends (PD D-46). There are no variables, conditions or chained steps.

### 11.4 Monitor-only behavior

Not offered in conversations (no composer). The library stays readable and editable for roles allowed to manage it (IA §14).

---

## 12. Private reply flow (F-09)

**Primary persona:** P2 · **Goal:** move a conversation to private one time (e.g. order details) without the product becoming a DM inbox · **Entry point:** conversation detail → **Reply privately** (secondary action) · **Preconditions:** Standard workspace; role can reply; platform supports private reply for this content (PD: VALIDATE)

### 12.1 Primary path

1. The user chooses **Reply privately**.
2. **Before composing**, the limitation is stated plainly: "This sends one private message. If they answer, the conversation continues in [Platform]'s own inbox, not here." (PD D-36; IA §8.3)
3. The user writes the message. A suggestion and saved replies are available as in F-07/F-08, with the same grounding rules.
4. The user presses **Send privately**.
5. **System response:** sent. The thread shows a record: "Private reply sent by [name] · [time] · Future private replies continue in [Platform]'s inbox." The activity history records it.
6. **Workflow update:** the conversation can be marked Done with resolution "Replied privately". If nothing else is open, this happens automatically with Undo (§8.3).

### 12.2 Success state

One private message is sent and recorded, and the user clearly understands that any follow-up happens in the platform's inbox.

### 12.3 Branches

- **User sends a public reply too:** allowed. Both are recorded.
- **Private reply already sent in this conversation:** the action shows "A private reply was already sent on [date]. Further private messages continue in [Platform]'s inbox." Whether a second one-shot reply to a *different* comment is allowed depends on platform rules (VALIDATE).
- **The audience member answers privately:** the product shows nothing of it. No incoming DM, no DM list, no DM status (PD D-36). The record in the thread already states where follow-up continues.

### 12.4 Unavailable states

| Condition | Behavior |
|---|---|
| Platform or content type doesn't support private reply | **Discoverable but unavailable**: the action stays findable (it may sit in a secondary place), with the platform reason in outcome language and **Open on [platform]** where useful. Never hidden for a platform reason (IA §8.3, §18). |
| Monitor-only | Visible but unavailable: "This workspace is Monitor-only." |
| Role can't reply | Hidden. |
| Connection unhealthy | Blocked with a recovery action. The draft is kept. |

---

## 13. Human moderation flow (F-10)

### 13.1 Moderation principles in flows

- Moderation is promoted only for **harmful** labels (spam, malicious link, scam content, impersonation, harassment, threat, obvious bot). For **negative but legitimate** content (complaints, product problems, objections, fraud accusations against the brand), the recommended action is **Reply** or **Escalate**, never Hide (P12).
- Every moderation action is available to permitted humans on any comment, including protected categories (PD D-35: human moderation remains possible). The flow only adds information, never friction, for harmful content.

### 13.2 Hide (reversible)

**Primary persona:** P2 · **Goal:** remove harmful content from public view, reversibly · **Entry point:** conversation → Hide (secondary, or primary when the label is harmful)

1. The user chooses **Hide** on a comment.
2. **If the comment is legitimate negative content:** an inline (non-modal) caution appears: "This looks like a complaint. Hidden complaints often resurface elsewhere. Consider replying." The user can **Hide anyway** or **Reply instead** [UX-REC].
3. **System response:** the comment is hidden on the platform. The thread shows "Hidden by [name] · Undo". The activity history records it.
4. Hide semantics differ by platform (e.g. whether the author still sees it). A one-time, per-platform note explains it where known (PD A-04, VALIDATE).
5. **Workflow:** if this was the only unhandled comment, the conversation can be marked Done ("Moderated"), automatically with Undo.

**Success:** harmful content is out of public view, reversibly.

### 13.3 Unhide (reversal)

1. From the comment ("Hidden by…") or from Inbox › Hidden automatically, the user chooses **Unhide** or **Undo**.
2. The comment is visible again on the platform. History records it.
3. If the comment needs a reply, the conversation **reopens** (§8.3).

### 13.4 Delete (destructive)

1. The user chooses **Delete comment** (destructive tier; role-gated).
2. **Confirmation** (§9.4): what happens on which platform, that it can't be undone, a caution for legitimate negative content, and an action-named confirm button.
3. The comment is deleted on the platform. The product keeps a record in the activity history (retention rules open, PD OQ-21).
4. The conversation updates, and is resolved if nothing remains.

### 13.5 Block (destructive)

1. The user chooses **Block author** (destructive tier; role-gated).
2. **Confirmation** states the platform-specific effect in outcome terms ("They will no longer be able to comment on your Facebook Page", per validated semantics, VALIDATE) and whether it can be reversed on that platform.
3. The author is blocked on the platform. Author context shows "Blocked on [platform] by [name]".
4. **Unblock** from the product is DEFERRED (UX-09) and decided per platform capability. Until then, the author context says how to unblock on the platform.

### 13.6 Distinctions

| Case | Behavior |
|---|---|
| **Reversible** (hide, unhide) | Inline, with Undo. No confirmation dialog. |
| **Destructive** (delete, block) | Explicit confirmation stating the consequence. |
| **Platform capability unavailable** | Visible but unavailable, with the platform reason and Open on platform where useful. |
| **Role permission unavailable** | Hidden (e.g. a Responder without delete/block). |
| **Monitor-only** | Visible but unavailable: "This workspace is Monitor-only." |
| **Legitimate negative content** | Allowed, with an informational caution. Never recommended. |
| **Harmful content** | Hide is the recommended action. Delete and block are available for permitted roles. |

---

## 14. Safe automation configuration flow (F-11)

### 14.1 Journey (required output F: moderation + automation safety)

```
Entry: Settings › Workspace › Moderation   (or a first-run / Home / Insights suggestion)
  │
  ▼
See the boundary first:  "Always protected" (read-only)
  │   complaints · product/service problems · fraud accusations against you ·
  │   commercial objections  → never hidden automatically, not configurable
  ▼
Choose an eligible rule:  Obvious spam · Obvious bots · Malicious links · Keyword & pattern rule
  │
  ▼
Set scope:  all content / paid only / organic only · accounts/platforms (where hide is supported)
  │
  ▼
Preview against history (required for links & patterns; offered for spam & bots)
  │   "Would have hidden 142 comments in the last 30 days"  [see them]
  │   "Excluded by Always protected: 9"                       [see them]
  ▼
Review exclusions and samples → adjust or continue
  │
  ▼
Enable  (confirmation summarizes: what it hides · scope · "hides only, never deletes or blocks")
  │
  ▼
Monitor:  Inbox › Hidden automatically (each hide + rule + reason + Undo) · Home health · Reports
  │
  ├── Undo a false positive  → comment visible again → returns to queue if it needs attention
  ├── Pause one rule / Pause all automation (kill switch)
  └── Edit scope → new preview required for links & patterns
```

**Primary persona:** Manager, P1 owner · **Goal:** stop obvious harmful noise without ever hiding legitimate criticism · **Entry point:** Settings › Workspace › Moderation; first-run suggestion; Home Operational health; an Insights recommendation · **Preconditions:** Standard workspace; role can manage Moderation; platform supports hide for at least one account (VALIDATE)

### 14.2 Primary path

1. **Open Moderation.** The page leads with automation status and the **Always protected** explanation (IA §13.2).
2. **Choose a rule.** Only the four eligible types exist (PD D-12, D-42). Abuse and insults are shown as "Always sent to review", with no auto-hide option (PD D-34).
3. **Set the scope.**
4. **Preview.** The preview shows the matches it would have hidden in the imported history, as a browsable sample, and **separately** the comments excluded by Always protected.
5. **Review.** The user scans samples. If something legitimate appears, they narrow the scope or the pattern.
6. **Enable.** A short confirmation summarizes the rule. The rule becomes **On**.
7. **Monitor.** New automatic hides appear in Inbox › Hidden automatically with the rule and reason. Home shows "Auto-hide on · 37 hidden this week · Review".

**Success state:** obvious harmful noise is hidden automatically, every hide is visible and undoable, and no protected comment is hidden.

### 14.3 Keyword and pattern rules

1. The user enters one or more terms or patterns.
2. If a term overlaps protected meaning ("scam", "fraud", "estafa", "golpe"…), a **warning** explains: "Comments using this word to complain or accuse you of fraud will not be hidden. They'll go to Needs review instead." Creation is allowed, and the preview is required before activation (UX: CONFIRMED — UX-10).
3. The preview **must** be completed before enabling (PD D-42). It shows hidden matches and protected exclusions side by side.
4. At run time, **complaint protection always wins**: any match carrying a protected signal goes to **Needs review**, never auto-hidden (PD D-35, D-42; UX-10).

### 14.4 Undo an automatic hide

1. In Inbox › Hidden automatically (or the comment's thread), the user chooses **Undo**.
2. The comment is unhidden on the platform. History records "Hidden by rule [name] · Undone by [user]".
3. **False-positive signal:** Undo counts against the rule's precision on its activity summary (PD §19.2 target, PROPOSED) [UX-REC].
4. If the comment needs attention, its conversation returns to the Priority queue.

### 14.5 Pause

- **Pause one rule:** state → Paused. It stays configured.
- **Pause all automation** (kill switch, PD: PROPOSED §13.4): one action from Settings › Moderation or the Hidden automatically header. All rules become Paused, and Home shows "Automation paused by [name]".
- **Resume:** explicit, per rule or for all.

### 14.6 Unavailable states

| Condition | Behavior |
|---|---|
| Role can't manage Moderation | Settings › Moderation hidden. Results in Hidden automatically are still visible to Inbox users, and Undo follows hide permission (IA §18). |
| Platform doesn't support hide for some accounts | Those accounts show "Hiding isn't available for this account" in the scope selection. Rules apply only where supported. |
| Monitor-only | Rules **Suspended** and can't be enabled. Reading rules and previews is allowed (§15). |
| No imported history yet | "Preview needs some history. Come back once the import has finished." Malicious-link and pattern rules can't be enabled until a preview is possible [UX-REC]. |

### 14.7 Safety invariants (must hold in every branch)

1. Protected categories never appear as auto-hide options and are never auto-hidden by any rule or keyword match (PD D-35, D-42). They are also excluded from **human** bulk hide (UX-06), which is a person's action, not automation.
2. Abuse and insults are never auto-hidden in the MVP (PD D-34).
3. Rules only hide. They never delete or block (PD D-42, D-19).
4. Every automatic hide is visible, attributed and undoable from one place (IA §13).
5. Nothing automatic happens in a Monitor-only workspace (PD D-49).
6. Automation never resumes silently (§15.5).

---

## 15. Monitor-only flow (F-12)

### 15.1 Journey (required output H)

```
Enter Monitor-only workspace
  │   persistent indicator: "Monitor-only"
  │   first visit after the change: one-time inline explanation
  ▼
Home (all blocks; automation shows "Unavailable — Monitor-only")
  │
  ├──▶ Inbox: same views and reasons · notice explains the mode
  │      conversation: context, thread, labels, why  ✓
  │      Reply / Reply privately / Hide / Unhide / Delete / Block → visible, unavailable,
  │         "This workspace is Monitor-only"  (Owner/Admin: "Change mode in Settings")
  │      Assign ✓  Note ✓  Escalate ✓  Correct labels ✓  Mark done (Reviewed) ✓
  │
  ├──▶ Content & Ads ✓   Insights ✓ (VoC, recommendations)   Reports ✓
  ├──▶ Alerts ✓ (risks, spikes, harmful build-up)  ·  All workspaces indicators ✓
  └──▶ Settings › Moderation: rules shown "Suspended"; previews readable; nothing can be enabled
```

**Primary persona:** P3 agency (paid media without CM scope); any team without platform-action scope · **Goal:** protection, intelligence and internal workflow with zero platform changes · **Entry point:** any destination in a Monitor-only workspace · **Preconditions:** workspace operating mode = Monitor-only (PD D-49; IA-11)

### 15.2 Primary path (daily use)

1. **Enter the workspace.** The indicator names the mode. The one-time explanation reads: "This workspace is Monitor-only. You'll see everything and can assign, escalate and take notes. Replying, moderating and automation happen outside the product."
2. **Home** answers as usual. Needs attention is framed for review and escalation (IA §6).
3. **Inbox review.** The same priority order and reasons apply. In each conversation:
   - **Understand:** content, thread, labels, why.
   - **Act internally:** assign, add a note, escalate, correct labels, mark done with "Reviewed".
   - **Platform actions:** visible but unavailable, with the mode explanation.
4. **Investigate:** Content & Ads and Insights work fully. Recommendations can be accepted and followed up.
5. **Report:** Reports › Summary and Performance work as usual. Performance shows response metrics from replies made natively on the platforms (IA §4.3).
6. **Alerts** arrive as usual.

**Success state:** the team noticed, understood and routed every important conversation, and nothing in the product changed anything on Facebook, Instagram or TikTok.

### 15.3 Switching Standard → Monitor-only

**Who:** Owner or Admin (IA §4.3) · **Where:** Settings › Workspace › General › Operating mode

1. The user chooses **Monitor-only**.
2. A **confirmation** (this is a mode change, so it warrants one) states:
   - "Replying, private replies, hiding, unhiding, deleting and blocking will be unavailable in this workspace."
   - "**N active auto-hide rules** will be suspended immediately."
   - "**M comments are currently hidden by rules** on the platforms. They will stay hidden, and you won't be able to unhide them from here while Monitor-only is on." Offers **Review them first** (opens Inbox › Hidden automatically) [UX-REC].
   - "Nothing already done on the platforms is reverted."
3. The user confirms. The mode changes, the change is recorded (who, when), and members see the indicator and the one-time explanation on their next visit.
4. **Open conversations, assignments, notes and escalations are unchanged.**
5. Unsent drafts in this workspace are kept as drafts but can't be sent. A notice explains why [UX-REC].

### 15.4 Switching Monitor-only → Standard

1. Owner or Admin chooses **Standard**.
2. The confirmation states:
   - "Platform actions will be available again for roles that have them."
   - "**N auto-hide rules will return Paused.** Review and turn them on yourself. Nothing will start hiding automatically."
3. After confirming, the user lands on **Settings › Moderation** with the paused rules listed and **Review & resume** per rule. Resuming a malicious-link or pattern rule requires a fresh preview (PD D-42; IA: CONFIRMED — IA-16).
4. Members see a one-time notice: "This workspace is back to Standard. You can reply and moderate again."

### 15.5 IA-16 decision (IA: CONFIRMED — Phase 0C.1)

**Decision:** when a workspace leaves Monitor-only, every auto-hide rule that was active before the switch returns in the **Paused** state. Each must be **explicitly re-enabled** by a role that can manage Moderation. Malicious-link and pattern rules need a fresh preview, because the history and the platform state changed while monitoring.

**Rationale:**
- Automation must never resume silently (IA-16, product-owner safety preference).
- Time has passed. Spam patterns, accounts and the team's intent may have changed.
- Re-enabling costs one deliberate action per rule, while a silent resumption could hide content nobody expected.

Recorded in IA v1.1 (§4.3, §13.6, §23) and in §28.

### 15.6 Monitor-only branches

- **A user tries a platform action through bulk selection:** bulk platform actions are unavailable with the same explanation. Bulk internal actions remain.
- **Someone asks "why can't I reply?":** the explanation names the mode and, for non-admins, who can change it ("Ask an Owner or Admin").
- **Responders in a Monitor-only workspace:** their primary work becomes review, assignment and escalation. No separate role is needed.

---

## 16. Classification correction flow (F-13)

**Primary persona:** P2, P4 · **Goal:** fix a wrong label so priority, views and insights reflect reality · **Entry point:** conversation → Labels → **Not right?**; Needs review queue · **Preconditions:** role can correct labels (internal action; allowed in Monitor-only)

### 16.1 Primary path

1. The user sees the labels with a short explanation on demand ("Labeled *purchase question* because the comment asks how to buy").
2. The user chooses **Not right?** and corrects one or more dimensions (type, topic, risk, reply needed, sentiment, authenticity), each from the existing taxonomy (PD §12).
3. **Confirmation in place:** "Label updated to *Complaint* · Undo". The correction is attributed and audited (PD §12.4).
4. **Immediate effects on this conversation:**
   - **Priority and "Why it's here"** are recomputed.
   - **View membership** updates (e.g. it leaves Needs review, or enters Needs reply).
   - **Recommended action** updates (e.g. from Hide to Reply).
5. **Later effects:** aggregates (topics, VoC, insights, content profiles) include the correction **at their next refresh**. The UI says "Insights will reflect this correction shortly" rather than claiming an instant update [UX-REC].

### 16.2 Automation-related effects [UX-REC]

| Situation | Behavior |
|---|---|
| A comment **hidden by a rule** is corrected to a **protected** category (e.g. complaint) | Prompt immediately: "This comment is now labeled a complaint, which is always protected. Unhide it?" with **Unhide** as the primary option. Not automatic, because unhiding is a platform action a person takes. In Monitor-only the prompt explains it can't be unhidden from here. |
| A visible comment is corrected **to** a harmful label (e.g. spam) while a matching rule is On | **No automatic hide.** Corrections never trigger automation. The recommended action becomes **Hide** for the human to take. |
| A correction to "low confidence" items in Needs review | The item leaves Needs review. Priority is recalculated. |

### 16.3 Branches

- **User unsure:** they can leave the item in Needs review and add a note.
- **Correction scope:** only this comment. "Apply to similar" is out of the MVP (UX-11).
- **Read-only roles:** labels and explanations are visible. Correction is hidden.

---

## 17. Escalation flow (F-14)

**Primary persona:** P2, P3 · **Goal:** get a risk or problem to the person or team who can resolve it, with context · **Entry point:** conversation → Escalate; a Home risk; an insight with a risk pattern · **Preconditions:** role can escalate (internal action; allowed in Monitor-only)

### 17.1 Primary path

1. The user chooses **Escalate**.
2. **Reason** (one tap): Product or service issue · Customer service · Legal or reputation risk · Needs client or owner decision · Other.
3. **Recipient / owner:** a workspace member (escalation owner). Defaults to the workspace's optional **default escalation contact** if one is set (UX: CONFIRMED — UX-12; set by Owner, Admin or Manager in Settings › Workspace › General). If none is set, escalation works exactly the same and the user picks a recipient or leaves it unassigned.
4. **Note:** optional context. The conversation (content, thread, labels) is attached automatically as evidence.
5. **System response:** the conversation gets the **Escalated** flag and appears in the Escalated view. The owner receives an in-app alert. The history records who escalated to whom, when and why.
6. **Follow-up:** the owner adds notes or decisions. Then either:
   - someone replies or moderates (Standard) and the conversation becomes Done; or
   - the owner chooses **Close escalation** with an outcome note, and the conversation returns to normal triage or is marked Done.

### 17.2 Success state

The right person knows, has the evidence, and the outcome is recorded. The conversation never sits escalated with no owner.

### 17.3 Agency vs business

| Context | Typical recipient | How it reaches them |
|---|---|---|
| **Agency → client** | The agency's internal account owner (a workspace member) | In-app. **Reaching the client themselves** is outside the product in the MVP: client guests can't see conversations (IA-05), and external delivery channels are open (PD OQ-17). The flow offers **Copy escalation summary** (text with the comment, context and note) as a **temporary UX fallback**, not a committed integration (UX-16, DEFERRED). |
| **Business → customer service / product / legal / operations** | A workspace member in that function | In-app. Non-member recipients (PD persona P6) depend on PD OQ-17. **Copy escalation summary** is the temporary fallback (UX-16, DEFERRED). |

There is no CRM, ticketing or helpdesk integration (PD §10).

### 17.4 Branches

- **Escalation without a recipient:** allowed. It lands in the Escalated view for the team. Home shows "N escalations without an owner" to Managers.
- **Escalated conversation gets new comments:** they appear in the thread. The owner is alerted when the new comment raises risk.
- **Monitor-only:** escalation is the main action for items that need a response. The resolution after closing is "Escalation closed" or "Reviewed".

---

## 18. Content & Ads investigation flow (F-15)

**Primary persona:** P3 paid-media team, P2 social lead, P5 brand manager · **Goal:** answer "Which content is creating what kind of conversation?" · **Entry point:** Content & Ads; a Home friction item; the content header of a conversation · **Preconditions:** connected workspace; role isn't Client guest

### 18.1 Primary path

1. **Open Content & Ads.** The answer comes first: "3 ads are generating most of this month's friction."
2. **Narrow:** use the source scope (e.g. Paid) or the **Ads & boosted** view. Optionally group by campaign (where available, VALIDATE). Sort defaults to **needs attention**.
3. **Select content.** The content profile shows:
   - the header (preview, platform, account, Organic/Paid/Mixed/Unknown, paid context and all ads using it);
   - the conversation profile (volume, type mix, useful vs friction);
   - VoC for this content;
   - top topics;
   - risks, unattended conversations and moderation summary;
   - related insights.
4. **Identify** friction (complaints, objections, confusion) or opportunity (questions, purchase intent, praise).
5. **Inspect examples** in place (representative comments, original language with translation).
6. **Choose a path:**
   - **To act on conversations:** **See conversations** opens the Inbox filtered to this content (F-05).
   - **To change the business:** open the **related insight**, then its recommendation (F-16, F-18).

### 18.2 Success state

The user can name which content drives which conversation, and has either acted on its conversations or recorded a recommendation.

### 18.3 Branches

- **Mixed content:** labeled Mixed everywhere, with an explanation that organic and paid reach can't be separated for its comments (PD D-38).
- **Paid context unavailable:** "Ad details aren't available for this item." Grouping by campaign is offered only where the linkage exists (VALIDATE).
- **Same creative in several ads:** conversations are shown once on the shared content, with all ads listed (PD §8.4, PROPOSED).
- **Low volume on this content:** counts and examples only, no mix percentages.
- **The user wants to edit the ad:** not possible. The recommendation describes the change to make on the ad platform (PD §10.2).

### 18.4 Monitor-only behavior

Identical. "See conversations" leads to the Monitor-only Inbox (§15).

---

## 19. Insight exploration flow (F-16)

### 19.1 Journey (required output G, part 1)

```
Insight (claim) ──▶ Evidence (counts · window · examples) ──▶ Scope (where)
      │                                                          │
      ▼                                                          ▼
Change vs baseline ──▶ Likely driver (hypothesis + confidence) ──▶ Recommendation
      │
      └─▶ Underlying examples ──▶ (roles with Inbox) See all in Inbox, status All
```

**Primary persona:** P3 strategist, P2 lead, P4 analyst, P5 executive · **Goal:** understand what's happening, why, and whether to act · **Entry point:** Insights; Home "What changed"; content profile; topic page · **Preconditions:** enough data for at least one insight

### 19.2 Primary path

1. **Read the claim**, in plain language: "Delivery questions rose sharply and are concentrated in Product X ads."
2. **Check the evidence:** absolute counts with percentages, comparison window, scope (platforms, source, content, period), and representative examples.
3. **Read the change:** against the baseline period or comparable content.
4. **Read the likely driver:** labeled as a hypothesis with confidence. "Likely driver: these ads don't mention delivery time (medium confidence)."
5. **Inspect the underlying examples.** For roles with Inbox access, **See all N conversations** opens the Inbox scoped exactly, with status All (IA §10.4).
6. **Act:** open the recommendation (F-18).

### 19.3 Success state

The user trusts or rejects the insight based on visible evidence, and knows the next step.

### 19.4 Branches

| Branch | Behavior |
|---|---|
| **Insufficient evidence** | No insight is generated (PD §14.4). Topic pages show counts and examples: "Not enough conversation to call this a trend." |
| **Emerging but uncertain pattern** | Shown as **Emerging** with low confidence and the small counts visible: "Early signal: 6 comments this week vs 1 last week." No recommendation until evidence strengthens [UX-REC]. |
| **Multiple possible drivers** | Listed as alternatives with confidence each ("Possible drivers: missing delivery time on ads (medium); a carrier delay reported in comments (low)"). The recommendation addresses the strongest, or none if no driver is strong enough. |
| **Mixed organic/paid source** | The scope states "Includes Mixed content (organic and paid reach can't be separated)". Organic/paid breakdowns exclude Mixed rather than guessing. |
| **Platform coverage gap** | A coverage note on the insight ("TikTok history covers 12 of 30 days; the change may be understated for TikTok") (IA §10.5). |
| **User disagrees** | **Not useful** feedback on the insight (PD §19.4 metric). It is hidden from the default list and kept in history. |

### 19.5 Client guest behavior

Guests see the claim, evidence summary, scope, change, likely driver, representative quoted examples and the recommendation (read-only). They never see "See all" or Inbox links. Content references are names without links (IA-05).

### 19.6 No causal overclaiming

The flow's language is associative: "concentrated in", "coincides with", "likely driver". It never says "caused by" (PD §14.4; C-10).

---

## 20. Voice of Customer flow (F-17)

**Primary persona:** P3, P5, P1 · **Goal:** understand what customers ask, object to, complain about, praise, suggest and want to buy · **Entry point:** Insights › Voice of Customer; Home Opportunities; the VoC section of a content profile or topic page · **Preconditions:** data in period

### 20.1 Primary path

1. **Open the VoC lens.** The answer comes first: "Most common: delivery questions (58) · Top objection: price (31) · 12 people ready to buy are waiting."
2. **Pick a group:** Questions & unmet needs · Objections · Complaints & problems · Praise & advocacy · Customer suggestions · Purchase intent (IA §11.2).
3. **Pick a topic** within the group (ranked, with change vs the previous period).
4. **Read examples:** representative comments, original language and translation.
5. **See related content:** where this topic concentrates. This links to content profiles (F-15).
6. **Act:**
   - **Unanswered items** (e.g. purchase intent waiting) → Inbox, filtered (F-05).
   - **Unmet information need** → the matching recommendation, a **Brand Context gap** ("Add starting price"), or **create a saved reply** (F-08).
   - **Pattern worth changing** → the related insight's recommendation (F-18).

### 20.2 Success state

The user can say what customers want, and has routed at least one need to an action (reply, Brand Context, saved reply or recommendation).

### 20.3 Avoiding duplication

- VoC never lists conversations itself beyond representative examples. Full lists live in the Inbox (IA §10.4).
- VoC doesn't produce its own insights. It links to Insights for interpreted patterns.
- The same lens appears inside content profiles and topic pages with a narrower scope (IA §11.1).

### 20.4 Branches

- **Low volume:** counts and examples only.
- **Client guest:** groups, topics, counts and representative examples. No Inbox links and no content links (IA-05).
- **Monitor-only:** identical. Unanswered items route to review and escalation.

---

## 21. Recommendation flow (F-18)

### 21.1 Journey (required output G, part 2)

```
Recommendation appears (on an insight; on Home "Suggested next steps")
  │
  ▼
Inspect evidence (the insight behind it)
  │
  ├── Dismiss (optional reason) ──▶ kept in Dismissed; insight stays visible
  │
  └── Accept ──▶ owner (default: the person accepting)
        │
        ▼
      Act:
        outside the product (ad copy, creative, landing page, FAQ, pricing, CS process…)
        or inside it (create saved reply · update Brand Context · enable an eligible rule)
        │
        ▼
      Mark done ──▶ completion date (defaults to today, editable)
        │
        ▼
      Follow-up period runs ──▶ Follow-up ready (alert + Home "Suggested next steps")
        │
        ▼
      Descriptive before/after for the same topic & scope  (never causal)
```

**Primary persona:** P3, P1, P2 lead, P5 · **Goal:** turn evidence into a business change and see what happened afterwards · **Entry point:** insight detail; Home Suggested next steps; Insights › Recommendations · **Preconditions:** a recommendation exists; role can decide on it (Owner, Admin, Manager — IA-09)

### 21.2 Primary path

1. **Recommendation appears** with its action type (PD §14.5) and a one-line rationale.
2. **Inspect evidence.** It always links to its insight (claim, evidence, likely driver).
3. **Accept** (status → Accepted, owner set) or **Dismiss** (status → Dismissed, optional reason: not relevant · disagree with evidence · already done · not feasible).
4. **Act.**
   - **Outside the product:** the recommendation states what to change and where (e.g. "Add delivery time to the copy of ads B and D"). The product doesn't perform it (PD §14.5).
   - **Inside the product:** for "create a saved reply" (F-08), filling a Brand Context gap, or turning on an eligible auto-hide rule (F-11, Standard only). Completing the in-product action offers **Mark done** in the same step.
5. **Mark done** with the action or completion date (defaults to today, editable) (PD D-43).
6. **Follow-up period:** the product compares an equal-length window after the completion date with the window before it (default length is open, UX-13; PD OQ-16).
7. **Follow-up ready:** an alert and a Home item.
8. **Read the follow-up:** a descriptive before/after (e.g. "Price questions on these ads: 31% → 12% of comments"), with counts, known confounders ("spend changed", "campaign paused") and the explicit label **"Descriptive: other factors may have contributed"** (PD D-43).

### 21.3 Success state

Every recommendation ends Accepted→Done with a follow-up, or Dismissed with a reason. Done items show what happened afterwards, without causal claims.

### 21.4 Branches

| Branch | Behavior |
|---|---|
| **User disagrees** | Dismiss with "Disagree with evidence". The insight's feedback is recorded as well. No re-prompting for the same recommendation unless evidence changes materially [UX-REC]. |
| **Evidence weak** | Weak evidence doesn't produce a recommendation (§19.4). If evidence weakens after it was issued, an **"Evidence has weakened"** notice appears on the open recommendation. The user can dismiss it with "No longer relevant" [UX-REC]. No new status is introduced. |
| **Action can't be performed in the product** | The normal case for most actions. The recommendation describes the outside action. Marking done is the user's statement that it happened. |
| **Recommendation becomes obsolete** (topic gone, content ended) | "This may no longer apply: the ads ended on [date]." Suggested next step: Dismiss ("No longer relevant") or Mark done if the action was taken. |
| **Done but follow-up has too little data** | "Not enough conversation after [date] to compare yet." The follow-up updates later or stays inconclusive. |
| **Marked done by mistake** | Reopen to Accepted; the completion date is cleared. |

### 21.5 Role differences

- **Owner, Admin, Manager:** accept, dismiss, mark done (IA: CONFIRMED — IA-09).
- **Responder:** view only. No responder-specific recommendation state, signal, notification or approval workflow (UX-14 not adopted).
- **Analyst/Viewer, Client guest:** read-only, including status and follow-ups.

### 21.6 Monitor-only behavior

Identical, except in-product actions that mutate platforms (enabling auto-hide rules) are unavailable. Saved reply and Brand Context actions remain.

---

## 22. Reports flow (F-19)

**Primary persona:** P5 executive / agency client; P3 account manager; P2/P4 leads · **Goal:** understand and share what happened in a period · **Entry point:** Reports (navigation); a guest's default landing; a shared report (delivery open) · **Preconditions:** at least some data in the period

### 22.1 Primary path

1. **Open Reports.** The default is **Summary** for the most recent complete period (e.g. last month). Periods are selectable (week, month, custom).
2. **Choose** Summary or Performance.
3. **Read the narrative.**
   - **Summary:** what changed, likely drivers, risks, key VoC themes, recommendations and their status, follow-up results.
   - **Performance:** volume, response rate and time vs baseline, backlog trend, unattended organic vs paid, moderation activity, automation activity.

   Both always cover all sources, with breakdowns (§3.2).
4. **Inspect evidence where the role allows:** items link to their insight, topic or content profile. Operational numbers link to the matching Inbox views for roles with Inbox access.
5. **Share / export:** a placeholder. The mechanism is open (PD OQ-15). Whatever is chosen preserves workspace boundaries and the client guest evidence limits (IA §12.3).

### 22.2 Success state

The reader can state what changed, why it likely changed, what the risks are and what's being done, in under a few minutes, with evidence one step away.

### 22.3 Role variants

| Role | Behavior |
|---|---|
| **Executive / Analyst (read)** | Full narrative. Evidence links to insights, topics and content. Inbox links for roles with Inbox access. |
| **Operational manager** | Focus on Performance. Numbers link to Inbox views (e.g. "unattended paid" opens the matching filter). |
| **Client guest** | Summary and Performance, read-only. Evidence stops at **representative quoted examples** and insight/topic pages. Content appears as names without links. Automation counts have no links. **No path reaches the Inbox or full conversation history** (IA-05). |

### 22.4 Client Guest journey (required output I)

```
Sign in (or open a shared report — delivery open)
  │
  ▼
Reports › Summary (latest period)   ◀── default landing (IA-05)
  │   what changed · likely drivers · risks · VoC themes · recommendations + follow-ups
  ▼
Open an item ──▶ Insight (read-only): claim · evidence · scope · driver · representative examples
  │                 ✗ no "See all" · ✗ no Inbox · ✗ no content links · ✗ no actions
  ▼
Explore Insights ──▶ Voice of Customer (read-only) ──▶ topic page (examples only)
  │
  ▼
Recommendations (read-only): status · owner · follow-up results
  │
  ▼
Back to Reports › Performance (read-only, no links into Inbox)

Search (if used): insights · topics · reports only.  No Home, Inbox, Content & Ads,
Settings (beyond Personal), alerts or organization views.
```

### 22.5 Branches

- **Period with insufficient data:** the report still renders, with a coverage statement and "Not enough data for trends in this period", plus available counts. No invented narrative.
- **Partial coverage in the period:** stated at the top ("TikTok was disconnected from Oct 3–6").
- **No complete period yet** (new workspace): Reports shows the current partial period, labeled "In progress". If no usable report exists yet, client guests land on **Insights** with a calm explanation: "Reports will be available once there's enough data for a reporting period." A specific date is shown only if the product genuinely knows it. Home, Inbox and Content & Ads stay unavailable (UX: CONFIRMED — UX-15).

---

## 23. Cross-workspace attention flow (F-20)

### 23.1 Journey (required output J)

```
Sign in (multi-workspace) ──▶ All workspaces (default landing, UX-01 CONFIRMED)
  │   sorted by attention: urgent · reputation risk · growing backlog · connection problem
  │   group/filter by brand or market · "Monitor-only" labels
  ▼
Pick the workspace that needs attention
  │
  ├──▶ enter its Home (default)
  └──▶ enter its Inbox, filtered to urgent
  ▼
Investigate inside the workspace (F-04, F-05, F-15, F-16)
  │
  ▼
Switch to the next workspace from the switcher (indicators visible) — source scope & period carried
```

**Primary persona:** P3 agency, P4 multi-brand/market team · **Goal:** know which workspace needs attention first, and go there · **Entry point:** All workspaces; the workspace switcher · **Preconditions:** access to more than one workspace; not a client guest

### 23.2 Primary path

1. **Open All workspaces.** The answer comes first: "2 workspaces need attention."
2. Each row shows the four signals (PD D-37) plus connection health and a Monitor-only label. Sorted by attention.
3. Optionally group or filter by brand or market (PD D-44).
4. **Enter** a workspace: Home, or Inbox filtered to urgent.
5. **Investigate** inside the workspace boundary.
6. **Switch** to the next workspace through the switcher, which keeps showing indicators.

### 23.3 Success state

The user has visited every workspace that needed attention, in order of importance.

### 23.4 Signals

| Signal | Shown as | Leads to |
|---|---|---|
| Urgent interactions | count | Inbox, filtered to urgent |
| Reputation risk | flag with short reason | Home › Risks |
| Growing backlog | trend indicator | Inbox › Priority |
| Connection problem | flag | Settings › Connections (role permitting) or Home notice |

Exact criteria are open (PD OQ-25).

### 23.5 Boundaries (must not appear)

There is no cross-workspace Inbox, no aggregated topics or VoC, no portfolio charts or analytics, and no cross-client reports (PD D-37; IA §16.3). Every signal **enters** a workspace.

### 23.6 Branches

- **Nothing needs attention:** "All workspaces are calm." The list is sorted by name.
- **Client guest:** no All workspaces and no indicators. A guest with several granted workspaces switches without signals (IA §16.6).
- **Monitor-only workspaces:** the same signals. Urgent items still count, because noticing and escalating is the job there.

---

## 24. Search / command flow (F-21)

**Primary persona:** P2 power user; everyone · **Goal:** jump anywhere or find anything in the current workspace quickly · **Entry point:** global search / command menu (keyboard-first) · **Preconditions:** inside a workspace

### 24.1 Expectations

| Users search for… | Result opens… | Roles |
|---|---|---|
| A conversation (author, words in a comment) | Conversation detail in the Inbox | Roles with Inbox access |
| Content (post or ad text, ad name, campaign) | Content profile | Not client guests |
| A topic | Topic page | All, including guests |
| An insight | Insight detail | All, including guests |
| A report (by period) | Report | All, including guests |
| A saved reply (by name or text) | The library entry; inside the composer it inserts | Roles that can reply / manage |
| A destination or command ("Inbox", "Assigned to me", "Pause all automation", "Switch workspace…") | Navigation or command | Commands appear only if the role can perform them |

### 24.2 Scope

- **Current workspace only** in the MVP (IA: CONFIRMED — IA-10). "Switch workspace…" is a navigation command, not a cross-workspace search.
- **Client guest:** insights, topics and reports only. Conversation and content results never appear (IA-05).
- **Monitor-only:** commands for platform actions stay findable but are marked unavailable with "This workspace is Monitor-only" (§25). Internal commands work normally.

### 24.3 Branches

- **No results:** "Nothing found in [workspace] for '…'." Offers search tips, plus "Search in Inbox with filters" for roles with Inbox access.
- **Result in a disconnected account:** opens normally, marked "Account disconnected".

---

## 25. Capability-unavailable flow (F-22)

### 25.1 Universal decision tree (required output K)

```
User is about to see or use an action / data feature
│
├─ 1. Does the user's ROLE allow it?
│     ├─ No ──▶ HIDDEN
│     │         (exception: arriving by deep link or shared link → access page:
│     │          "You don't have access to this. Ask a workspace admin." + path home)
│     └─ Yes
│         │
├─ 2. Is the WORKSPACE Monitor-only, and is this a platform mutation or platform-changing automation?
│     ├─ Yes ──▶ VISIBLE BUT UNAVAILABLE
│     │          "This workspace is Monitor-only."
│     │          Owner/Admin: link to change the mode · others: "Ask an Owner or Admin"
│     └─ No
│         │
├─ 3. Does the PLATFORM support it for this account / content type?
│     ├─ No ──▶ VISIBLE BUT UNAVAILABLE (discoverable; may sit in a secondary place)
│     │         "TikTok doesn't allow hiding this comment through official tools."
│     │         + "Open on TikTok" where useful
│     │         never hidden: a platform limit is never presented as a role limit
│     └─ Yes
│         │
├─ 4. Is the CONNECTION healthy?
│     ├─ No ──▶ BLOCKED WITH RECOVERY
│     │         "Instagram connection needs attention since 14:02."
│     │         Admin/Owner: Reconnect · others: Notify an admin
│     │         drafts and selections preserved; the action can be retried after recovery
│     └─ Yes
│         │
├─ 5. (data features) Is COVERAGE sufficient?
│     ├─ None ──▶ VISIBLE, EMPTY WITH REASON  ("Comments on ads aren't available for this account")
│     ├─ Partial ──▶ AVAILABLE WITH CAVEAT    ("Based on 12 of 30 days for TikTok")
│     └─ Full
│         │
└─────────▶ AVAILABLE
```

The order follows the approved precedence (IA v1.1 §18): **1. role limit → hidden · 2. Monitor-only → visible but unavailable, explained · 3. platform capability limit → visible but unavailable, explained · 4. temporary connection problem → blocked with a recovery action**. Capability (permanent) is evaluated before connection (temporary), so users aren't told to reconnect for something the platform can never do.

### 25.2 Presentation rules

- **One reason only**, the first that applies. Never stack reasons.
- **Outcome language**, never implementation terms (no "API", "scope", "token").
- **Hidden vs visible:**
  - Hidden: **role limits only**.
  - Visible but unavailable: workspace mode, and platform capability limits. For platform limits, the capability stays discoverable with its reason. Visual prominence is decided in visual design: the action may live in a secondary place, but it is never removed.
  - Blocked with recovery: temporary connection conditions.
- **Recovery actions are role-aware.** Users who can't fix something are told who can.

### 25.3 Examples

| Situation | Result |
|---|---|
| Analyst opens a conversation | Reply, Hide, Delete, Block are hidden. Labels are visible. |
| Responder without delete permission | Delete hidden. Hide visible. |
| Manager in a Monitor-only workspace | Reply, Hide, Delete, Block visible but unavailable: "This workspace is Monitor-only. Ask an Owner or Admin." |
| Admin in a Monitor-only workspace | The same, plus "Change mode in Settings". |
| Manager, Standard workspace, TikTok comment where hide isn't supported | Hide visible but unavailable with the TikTok reason. Reply available if supported. |
| Responder, Instagram connection revoked | Reply drafted, Send blocked: "Reconnect Instagram to send. [Notify an admin]". Draft kept. |
| Any role, Facebook account without ad access | Paid sections: "Comments on ads aren't available for this account." The admin sees "Connect the ad account". |

---

## 26. Empty and recovery flows (F-23)

Every state answers: **what happened · is action required · what can I do next**.

| State | What happened | Action required? | Next steps |
|---|---|---|---|
| **No conversations** (connected, nothing in scope/period) | "No comments in this period for these accounts." The connection is confirmed healthy. | No | Widen the period, change the source scope, view connection health |
| **Inbox zero** | "Nothing waiting in Priority." Time of the last update. Optionally, "You handled 23 today." | No | Check Needs review / Hidden automatically if they have items; go to Insights |
| **No results for filters** | "No conversations match these filters." Active filters listed. | No | Clear one filter, clear all |
| **No insight due to low volume** | "Not enough conversation yet to spot reliable patterns." Counts and examples shown. | No | Widen the period; check back later |
| **Import pending** | "Importing your last 30 days." Progress per account; early results labeled. | No | Set up Brand Context; invite teammates; Inbox for already-imported items |
| **Partial import** | "We could import 12 of 30 days for TikTok." Effect on insights noted. | No | Link to Connections for details |
| **Failed connection** | "We couldn't connect Instagram." Reason in outcome terms. | Yes, for roles that can manage Connections | Retry; notify an admin |
| **Revoked authorization** | "Instagram was disconnected on [date]. New comments aren't arriving, and replies and moderation are paused for it." Imported data remains. | Yes | Reconnect (Owner/Admin); notify an admin (others) |
| **Platform outage** (platform not responding) | "Instagram isn't responding. New comments may be delayed, and actions may fail." Last successful update shown. | No (temporary) | Wait. Drafts kept. Actions can be retried. Other platforms are unaffected. |
| **AI uncertainty** | "We're not sure what this comment means." The item is in Needs review. No automatic action. | Optional | Review and correct labels (F-13) |
| **Reporting period with insufficient data** | "Not enough data in this period for trends." Counts and coverage shown. | No | Choose a longer period; the next report will include more |
| **Monitor-only workspace** | "This workspace is Monitor-only." What's unavailable and why. | No | Owner/Admin: change the mode; others: none needed |
| **Paused automation** | "Auto-hide is paused (by [name], [time])." | Optional | Resume (Manager+) |
| **Restricted evidence (client guest)** | "These examples represent the pattern. Full conversation lists aren't part of this access." | No | None |

---

## 27. Role-specific flow differences

The same flows serve every role. Roles change which steps appear (IA §18).

| Flow | Owner | Admin | Manager | Responder | Analyst / Viewer | Client guest |
|---|---|---|---|---|---|---|
| F-01 Entry (one workspace / several) | Home / All workspaces | Home / All workspaces | Home / All workspaces | Home / All workspaces | Home / All workspaces | Reports › Summary (else Insights) |
| F-02 Onboarding: connect accounts | ✓ | ✓ | — (sees who can) | — | — | — |
| F-04 Home → action | ✓ | ✓ | ✓ | ✓ | Read-only routing | — (no Home) |
| F-05/F-06 Triage & handling | ✓ | ✓ | ✓ | ✓ (delete/block if granted) | Read-only | — |
| F-07/F-08/F-09 Replies | ✓ | ✓ | ✓ | ✓ | — | — |
| F-08 Saved reply library management | ✓ | ✓ | ✓ | Per PD OQ-23 (else "Suggest a change") | — | — |
| F-10 Hide/unhide | ✓ | ✓ | ✓ | ✓ | — | — |
| F-10 Delete/block | ✓ | ✓ | ✓ | If granted | — | — |
| F-11 Automation configuration | ✓ | ✓ | ✓ | — (can Undo hides) | — | — |
| F-12 Change operating mode | ✓ | ✓ | — | — | — | — |
| F-13 Correct labels | ✓ | ✓ | ✓ | ✓ | — | — |
| F-14 Escalate | ✓ | ✓ | ✓ | ✓ | — | — |
| F-15 Content & Ads | ✓ | ✓ | ✓ | ✓ | Read | — |
| F-16/F-17 Insights & VoC | ✓ | ✓ | ✓ | ✓ | Read | Read; examples only |
| F-18 Decide on recommendations | ✓ | ✓ | ✓ | View only | Read | Read |
| F-19 Reports | ✓ | ✓ | ✓ | ✓ | ✓ | Read; examples only |
| F-20 All workspaces | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| F-21 Search | Full | Full | Full | Full | Full (read) | Insights, topics, reports |

In a **Monitor-only** workspace, every ✓ on a platform-mutating step becomes *visible but unavailable* (§25). All other cells are unchanged.

---

## 28. Flow-level decision register

Status key: **CONFIRMED** (locked by the product owner) · **OPEN** (IA decision still open in IA v1.1 §23) · **DEFERRED** (open, with a named dependency) · **OUT OF MVP** · **NOT ADOPTED**.

### 28.1 IA decisions

| ID | Decision | Status | Where reflected |
|---|---|---|---|
| **IA-01** | The conversation is the Inbox work item. Workflow state belongs to it; labels and moderation state may exist per comment or reply. One top-level comment thread is one conversation. | **CONFIRMED** (0C.1) | §8, §9; IA §7.1 |
| **IA-02** | Reports stays top-level in the MVP, narrowly scoped to retrospective, shareable reporting, with no duplication of Insights. Delivery format stays open (PD OQ-15). | **CONFIRMED** (0C.1) | §22; IA §5.2 |
| **IA-03** | "Content & Ads" is the canonical v1 label. It may still be tested in future research. | **CONFIRMED** (0C.1) | §18; IA §5.2 |
| **IA-04** | Open / Done, with a resolution where applicable. Escalated is a flag on Open conversations. No Waiting or Snoozed. Auto-done after a successful brand reply and after a detected native brand reply; auto-reopen on new audience messages needing attention. Every automatic change is visible and reversible where appropriate. | **CONFIRMED** (0C.1) | §8.3; IA §7.4 |
| **IA-05** | Client guest visibility. | CONFIRMED (0B.1), unchanged | §22.4 |
| **IA-09** | Owner, Admin and Manager accept, dismiss and mark recommendations done. Responders view only, with no dedicated workflow. Analyst/Viewer and client guests are read-only. | **CONFIRMED** (0C.1) | §21.5, §27; IA §18 |
| **IA-10** | Search is scoped to the current workspace. Switching workspaces is a navigation command. | **CONFIRMED** (0C.1) | §24; IA §4.1 |
| **IA-11** | Monitor-only workspace. | CONFIRMED (0B.1), unchanged | §15 |
| **IA-13** | "Workspace" is the canonical term and can't be renamed. Individual workspaces can be named freely. | **CONFIRMED** (0C.1) | IA §21 |
| **IA-15** | Analyst/Viewer sees all Home blocks, read-only. | **CONFIRMED** (0C.1) | §7.3; IA §6 |
| **IA-16** | Leaving Monitor-only: every auto-hide rule returns Paused and is re-enabled explicitly, with a fresh preview for malicious-link and pattern rules. | **CONFIRMED** (0C.1) | §15.4–§15.5; IA §4.3, §13.6 |
| **IA-06** | Topic management location (depends on PD OQ-10) | **OPEN** | Flows compatible with the IA recommendation |
| **IA-07** | Brand labels on connected accounts in multi-brand workspaces (with PD OQ-24) | **OPEN** | Affects only the multi-brand branch (§3.1) |
| **IA-08** | Organization-level shared libraries | **OPEN** | Flows assume workspace-only libraries |
| **IA-12** | Media metrics on content profiles (after PD OQ-18) | **OPEN** | Flows show conversation metrics only |
| **IA-14** | Alerts scope and channels (with PD OQ-17) | **OPEN** | Flows use the in-app alerts center |

### 28.2 UX decisions

| ID | Decision / question | Status | Notes / dependency |
|---|---|---|---|
| **UX-01** | Entry: one workspace → Home. Several workspaces → All workspaces. Client guest → Reports › Summary, else Insights. No personal start-page preference. | **CONFIRMED** (0C.1) | §4.1; IA v1.1 §4.4 |
| **UX-02** | Optional "How will you use this workspace?" at creation: Standard (default) or Monitor-only. Changeable later by Owner/Admin. | **CONFIRMED** (0C.1) | §5.2 step 2 |
| **UX-03** | Agency account authorization handoff | **DEFERRED** | With PD OQ-13 and technical validation |
| **UX-04** | Native brand reply imported; auto-Done "Replied on platform" when it came after the latest audience message and nothing else needs handling. Visible and reversible. A later audience message needing handling reopens it. | **CONFIRMED** (0C.1) | §8.3 |
| **UX-05** | Waiting / Snooze | **CONFIRMED: not in MVP** | No controls, statuses or views. Revisit after early-user evidence. |
| **UX-06** | Human bulk hide only for homogeneous sets. Protected categories excluded, with count and reason. Individual human moderation of protected content stays possible. No bulk delete or block. Bulk hide is a human action, never called automatic. | **CONFIRMED** (0C.1) | §8.6, §14.7 |
| **UX-07** | Editing or deleting sent replies from the product | **DEFERRED** | After platform API validation (PD OQ-18) |
| **UX-08** | Automatic vs on-demand suggestion preparation | **DEFERRED** | Technical/commercial architecture, after AI cost modeling. The flow supports either (§10.2). |
| **UX-09** | Unblock from the product | **DEFERRED** | Per platform capability |
| **UX-10** | Patterns overlapping protected meaning may be created, with a warning before activation and the required preview. At runtime complaint protection always wins: protected matches go to Needs review, never auto-hidden. | **CONFIRMED** (0C.1) | §14.3 |
| **UX-11** | "Apply this correction to similar comments" | **OUT OF MVP** | §16.3 |
| **UX-12** | Optional default internal escalation contact per workspace. Never blocks escalation. No external CRM or ticket integration. | **CONFIRMED** (0C.1) | §17.1; IA §17.1 |
| **UX-13** | Default before/after comparison window | **DEFERRED** | With PD OQ-16 |
| **UX-14** | Responder "Suggest acceptance" | **NOT ADOPTED** | Superseded by IA-09: Responders view only |
| **UX-15** | Client guest without a usable report → Insights, with a calm explanation. No fabricated date. No Home, Inbox or Content & Ads. | **CONFIRMED** (0C.1) | §22.5 |
| **UX-16** | Delivering escalations to non-members | **DEFERRED** | With PD OQ-17. "Copy escalation summary" is a temporary UX fallback, not a committed integration. |

### 28.3 Product questions referenced (unchanged, still open in the PD)

PD OQ-13 (agency authorization/offboarding), OQ-15 (report delivery), OQ-16 (baselines and thresholds), OQ-17 (alert and escalation channels), OQ-18 (API capability matrix), OQ-21 (retention, incl. deleted comments), OQ-23 (saved reply governance), OQ-24 (Brand Context minimums), OQ-25 (attention criteria). The flows work under any outcome of these and reserve the relevant steps. All platform-dependent behavior remains **[VALIDATE]**.

---

## 29. Core UX acceptance criteria

Before moving to wireframes and visual design, all of the following must be true:

1. **End-to-end coverage:** every critical MVP job has a complete flow from entry to success state (Appendix A shows no gaps).
2. **No dead ends:** every empty, error and unavailable state names what happened, whether action is needed and the next step (§26).
3. **Capability limitations have behavior:** each platform-dependent action has a defined unavailable branch in outcome language (§25).
4. **Permissions have behavior:** role limits hide controls. Deep links to inaccessible surfaces show an access page (§25.1).
5. **Monitor-only has behavior:** every flow with a platform mutation defines its Monitor-only branch. No flow lets a Monitor-only workspace change anything on a platform, manually or automatically (§15).
6. **Client guest has behavior:** guests reach only Reports and Insights (with VoC and read-only recommendations), with representative examples, and no path reaches the Inbox, conversation history or Content & Ads (§22.4).
7. **AI uncertainty has behavior:** low-confidence items route to Needs review. No automatic action and no automatically prepared suggestion for uncertain items (§10.4, §16).
8. **AI never sends:** every reply path ends with a human pressing Send (§10).
9. **AI never fabricates:** missing Brand Context is named, never filled in. A gap → Brand Context path exists (§10.4).
10. **Negative ≠ harmful is protected:** no flow recommends hiding legitimate negative content. Protected categories can't be auto-hidden by rules or keyword matches, and are excluded from human bulk hide. Deliberate single-item human moderation remains possible with an informational caution (§8.6, §13, §14.7).
11. **Private reply never creates a DM Inbox:** the private-reply flow ends in a record and a handoff message, and no incoming private message is shown anywhere (§12).
12. **Recommendations have evidence and follow-up:** every recommendation links to its insight, ends Accepted→Done with a descriptive before/after or Dismissed with a reason, and never claims causality (§21).
13. **No cross-workspace scope creep:** cross-workspace behavior is limited to attention signals and switching (§23).
14. **Reports don't duplicate Insights:** reports assemble and link. They never recompute (§22).
15. **Automation never resumes silently:** leaving Monitor-only returns every rule Paused, with explicit re-enable and a fresh preview for link and pattern rules (IA: CONFIRMED — IA-16). Pause and resume are always explicit (§14–§15).
16. **No accidental technical architecture:** this document contains no stack, schema, API or implementation design.
17. **Source documents:** PD v1.2 unchanged. IA aligned to v1.1 in Phase 0C.1.
18. **Entry and workflow locks hold:** multi-workspace users enter through All workspaces; there is no personal start-page preference, no Waiting/Snooze, and no responder recommendation workflow.
19. **Availability rules consistent with the IA:** role limits hide; Monitor-only and platform limits are visible but unavailable with an explanation; connection problems offer recovery (§25).

---

## Appendix A — MVP capability → primary flow → entry point → success state (required output L)

| MVP capability (source) | Primary flow | Entry point | Success state |
|---|---|---|---|
| Connect Facebook, Instagram, TikTok (PD D-04, D-48) | F-02 | Onboarding; Settings › Connections | Accounts connected; coverage stated |
| 30-day history import + coverage (PD D-09, D-40) | F-02, F-03 | Onboarding | Import complete; coverage summary shown |
| First-session value (PD principle 7) | F-03 | Home after import | User knows what needs attention, what people ask, what's risky |
| Organic / Paid / Mixed / Unknown (PD D-38) | §3, F-05, F-15 | Source scope; labels | User scopes and reads source correctly everywhere |
| Unified prioritized Inbox (PD §9.2-B) | F-05 | Inbox | View cleared or deliberately deferred |
| Multi-dimensional classification + explanation (PD D-22) | F-06, F-13 | Conversation labels | User understands, and corrects where wrong |
| Public reply with AI suggestion (PD D-45, D-47) | F-07 | Conversation → Reply | Grounded reply sent by a human; conversation updated |
| Saved replies (PD D-46) | F-08 | Composer; library; recommendation | Consistent reply sent; library maintained |
| Brand Context (PD D-47) | F-02 (essentials), F-07 (gap → add), F-17 | Onboarding; suggestion gap; VoC unmet need | Fact added; suggestions grounded |
| Private reply, one-shot (PD D-36) | F-09 | Conversation → Reply privately | One message sent, recorded, handoff stated |
| Hide / unhide (PD §9.2-D) | F-10 | Conversation | Harmful content hidden, reversibly |
| Delete / block, human-only (PD D-19) | F-10 | Conversation (destructive tier) | Action confirmed with consequences; recorded |
| Opt-in auto-hide: spam, bots, links, patterns (PD D-12, D-42) | F-11 | Settings › Moderation | Rule on after preview; protected exclusions visible |
| Complaint-protection guard (PD D-35) | F-11, F-10, F-05 (bulk) | Moderation; previews; Why it's here | No protected comment auto-hidden; protected comments excluded from human bulk hide |
| Abuse flagged for review (PD D-34) | F-05 (Needs review), F-06 | Inbox › Needs review | Human decided |
| Scam content vs accusation (PD D-39) | F-06 (recommended action), F-10 | Conversation | Content moderated; accusation answered or escalated |
| Automation review, undo, pause (PD §9.2-F, PROPOSED) | F-11 | Inbox › Hidden automatically; Moderation | False positives undone; automation paused or resumed explicitly |
| Assign, status, notes (PD §9.2-D, PROPOSED) | F-05, F-06 | Inbox; conversation | Work owned and tracked |
| Escalation (PD UC-07) | F-14 | Conversation; Home risk | Owner informed with evidence; outcome recorded |
| Audit trail (PD §9.2-J) | F-06, F-10, F-11, F-13 | Conversation history | Every action attributed |
| Content & Ads profiles (PD UC-10) | F-15 | Content & Ads | User names which content drives which conversation |
| Insights with evidence and drivers (PD §9.2-G) | F-16 | Insights; Home | Insight trusted or rejected on evidence |
| Voice of Customer lens (PD UC-09) | F-17 | Insights › VoC | Need routed to an action |
| Recommendations + lightweight follow-up (PD D-43) | F-18 | Insight; Home | Accepted→Done with descriptive before/after, or Dismissed with reason |
| Reports: Summary, Performance (PD D-27) | F-19 | Reports | Period understood; share placeholder available |
| Multi-workspace, switching, attention overview (PD D-37, D-44) | F-20 | All workspaces; switcher | Workspaces needing attention visited in order |
| Monitor-only workspace (PD D-49) | F-12 | Mode setting; any destination | Full visibility and workflow; zero platform mutations |
| Client guest access (PD §11.3; IA-05) | F-19 (§22.4) | Reports › Summary | Period understood from reports and insights only |
| Capability-aware behavior (PD D-40) | F-22 | Any platform-dependent action | Reason shown; recovery or alternative offered |
| Alerts (PD §9.2-M, PROPOSED) | F-04, F-14, F-18 | Shell › Alerts | Alert routes to the relevant item |
| Search & commands (IA §4.1) | F-21 | Shell | Item or destination reached in one step |
| Multilingual handling (PD D-24) | F-07, F-08, F-16, F-17 | Composer; examples | Replies in the commenter's language; originals preserved with translation |

**Capabilities without a complete flow: none.**

## Appendix B — Invariants checklist (for design and review)

| Invariant | Source | Where enforced in flows |
|---|---|---|
| AI never sends; humans press Send | PD D-45 | §10.2, §11.1, §12.1 |
| No fabricated facts | PD D-47 | §10.4 |
| Protected categories never auto-hidden | PD D-35 | §14.3, §14.7, §8.6, §16.2 |
| Abuse never auto-hidden in the MVP | PD D-34 | §14.2, §9.2 |
| Rules hide only | PD D-42 | §14.7 |
| Delete/block human-only, confirmed | PD D-19 | §13.4, §13.5 |
| No DM inbox | PD D-36 | §12.3 |
| Monitor-only: zero platform mutations | PD D-49 | §15, §25 |
| Automation never resumes silently | IA-16 (CONFIRMED) | §15.4–§15.5, §14.5 |
| Client guest: no Inbox, no full history | IA-05; IA §10.4 | §19.5, §22.4, §24.2 |
| Cross-workspace = attention + switching only | PD D-37 | §23.5 |
| Descriptive, never causal | PD D-43 | §19.6, §21.2 |
| Capability honesty, role/mode/platform/connection precedence | PD C-07; IA v1.1 §18 | §25 |
| Bulk hide is human, excludes protected categories | UX-06 | §8.6, §14.7 |
