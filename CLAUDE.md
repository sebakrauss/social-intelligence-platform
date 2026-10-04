# CLAUDE.md — Implementation Constitution

Instructions for every Claude Code session in this repository. This file **summarizes and points to** the approved documents; it does not replace them. If this file and a source document disagree, the source document wins: **STOP and report the discrepancy**.

**Baseline:** this constitution was created in Phase 0F, after the approved architecture checkpoint `1140141`. At that checkpoint no application code existed. Future sessions **MUST** determine the current implementation state from the repository and the explicitly authorized task, not from this historical baseline.

Everything under `spikes/` is disposable validation evidence, **not** the implementation. Work only on explicitly authorized scope, in the order of §17.

---

## 1. Project mission

A premium, multi-tenant **Social Conversation Intelligence** platform for the conversations around a customer's **organic and paid** content on **Facebook, Instagram and TikTok**.

Core loop: **LISTEN → UNDERSTAND → PRIORITIZE → ACT → MEASURE → LEARN**.

Non-negotiable product stances (PD §1, §7):

- AI is **intelligent when understanding and conservative when acting**.
- **Moderate harmful content. Understand negative content.** Negativity is not moderatable content.
- **One premium product** for SMBs, agencies and structured teams. Agency, business and enterprise use never fork the product or the architecture; differences come from structure, roles, views and configuration.
- Commercial plans may vary by **limits** such as workspaces, volume, history, seats, automation, reporting or AI usage (PD C-08 / D-41). Limits never justify weaker safety, intelligence, UX quality or architectural shortcuts.
- The actual plans, limit values and pricing are **not decided** (PD OQ-14 remains OPEN). Don't invent them.
- The **workspace** is the primary operational, access and intelligence boundary.
- Platforms and organic/paid are **dimensions** (labels, filters, scopes), never separate sections or architectures.
- **Honest coverage**: never imply data or capability the product doesn't have.

---

## 2. Sources of truth and authority

| Document | Version | Controls |
|---|---|---|
| `docs/product-definition-v1.md` (PD) | 1.3, approved | Product intent and confirmed product behavior (decisions D-01…D-52) |
| `docs/information-architecture-v1.md` (IA) | 1.1, approved | Where concepts live; navigation; role visibility (IA §18) |
| `docs/core-ux-flows-v1.md` (UX) | 1.1, approved | User journeys, interaction behavior, unavailable states |
| `docs/intelligence-data-model-v1.md` (Model) | 1.1, approved | Conceptual meaning, provenance, relationships, invariants S1–S21 (Model §50) |
| `docs/technical-architecture-v1.md` (TA) | 1.1, approved | Implementation boundaries, stack, runtime patterns, security, operations |
| `docs/pre-implementation-validation-v1.md` | 1.0, accepted (0E.3) | Evidence for validated technical patterns (TA-Q-29, TA-Q-04, R1–R8). Evidence, not a decision document |

Rules:

- **MUST NOT** edit the approved documents, opportunistically or "to keep them in sync". Changes need an explicit product-owner phase.
- **MUST NOT** resolve open questions implicitly. Items tagged **OPEN / PROPOSED / VALIDATE / DEFER / DEFERRED** stay open. Never upgrade one to confirmed or locked without explicit product-owner authorization.
- **MUST NOT** infer platform capabilities (PD C-07, OQ-18). If a behavior isn't validated, it is unavailable.
- **Contradiction between documents → STOP** and report it, with exact references. Don't invent a reconciliation.
- Spike evidence under `spikes/*/evidence/` is preserved audit material: **never modify, regenerate or delete it**.

---

## 3. Current architecture baseline

Statuses come from TA §2 and §72. Don't turn VALIDATE items into LOCKED ones.

| Area | Decision | Status |
|---|---|---|
| Language | TypeScript, strict, end to end | LOCKED |
| Shape | Modular monolith; **one repository, one package, two deployment targets** (web, jobs) | LOCKED |
| Web | Next.js (App Router) + React; server-side application services; no public API | LOCKED |
| Database | One authoritative managed PostgreSQL; Supabase as initial platform (Postgres, Auth, Storage) | LOCKED (region VALIDATE, TA-Q-05) |
| AuthN / AuthZ | Supabase Auth for authentication; **application-owned authorization** | LOCKED |
| Data access | Drizzle + version-controlled SQL migrations, through tenant-scoped transactions | LOCKED; RLS context pattern VALIDATED (§5) |
| Tenancy | Three layers: RLS + action pipeline + job tenant scope | LOCKED |
| Jobs | **Trigger.dev SELECTED** (TA-Q-04 PASS), behind a job port; **Graphile Worker = fallback**; Postgres transactional outbox | Outbox LOCKED; deployed workers VALIDATE (TA-Q-31) |
| Hosting | Web on Vercel | VALIDATE (recommended) |
| Integrations | Provider adapters (Meta, TikTok, simulator) behind a contract | LOCKED (pattern); provider specifics VALIDATE |
| AI | In-process **AI Gateway**; Anthropic is the initial recommendation, not a dependency | Gateway LOCKED; provider/models VALIDATE (TA-Q-06) |
| Realtime | Supabase Realtime private channels, invalidation signals with IDs only | VALIDATE (TA-Q-21) |
| Observability | Structured redacted logs + error tracking + correlation IDs | Pattern LOCKED; vendors VALIDATE (Sentry recommended; log store TA-Q-08) |
| Analytics | PostHog, identifiers only | VALIDATE (TA-Q-09) |
| Search | PostgreSQL full-text + trigram, current workspace only | LOCKED |
| Brand Context | Relational and structured; **no vector DB / RAG** in the MVP | LOCKED |
| Cache | **No Redis** in the MVP (explicit triggers in TA §35) | LOCKED |
| Not in MVP | Microservices, Kafka/RabbitMQ, Elasticsearch, Kubernetes, vector database | LOCKED |
| n8n | Not part of the product runtime; optional back-office only, no tenant data or credentials | LOCKED |
| MCP | Development tooling only; never customer-facing runtime | LOCKED |

---

## 4. Module and dependency boundaries

Follow TA §5–§7. Don't invent a different module architecture.

**Layout (TA §6.2):** `app/` · `ui/` · `server/` (pipeline, commands, queries, availability) · `domain/` (shared kernel) · `modules/*` · `mutations/` · `integrations/providers/{contract,meta,tiktok,simulator}` · `ai/{gateway,providers,tasks}` · `jobs/` · `platform/*` · `db/{schema,migrations,seeds}` · `prompts/` · `fixtures/` · `tests/`.

**Modules (TA §7.1):** tenancy, audit, connections, capability, coverage, ingestion, content, conversations, interactions, classification, topics, workflow, brand-context, saved-replies, moderation, automation, replies, aggregation, insights, recommendations, reports, alerts, attention, plus the top-level `mutations` executor. Each concept has **one owner module**. Don't duplicate it elsewhere.

**Layering (TA §7.2):** L0 tenancy·audit·flags → capability·coverage → connections · L1 content·conversations·interactions → ingestion · L2 classification·topics · L3 workflow·brand-context·saved-replies · L3½ mutations · L4 moderation·automation·replies · L5 aggregation · L6 insights·recommendations · L7 reports·alerts·attention. Depend only downward through public APIs. Same-layer modules communicate through domain events.

MUST:

- Keep `domain/` and `modules/*/domain` **pure**: no I/O, framework, database client, provider or AI SDK.
- Never read or write another module's tables. Go through the owner's public API or a published read model.
- Route cross-module work through explicit application/domain interfaces or domain events. The executor reports outcomes as events and never imports moderation, replies or automation.
- Keep **provider SDKs and types inside `integrations/providers/{platform}`**. Everything else uses contract DTOs and normalized errors.
- Keep **AI provider SDKs and types inside `ai/providers`**. Domain code depends on task contracts only.
- Send **every platform mutation through the Platform Mutation Executor** (§9). Only `mutations/` may obtain a provider mutation port.
- Bundle the **executor only into the job runtime**. The web deployment can create mutation intents but has no execution path.
- Keep `jobs/` thin: resolve tenant context, then call an application service. No business logic.
- Keep `app/` and `ui/` away from `platform/db`, `integrations/`, `ai/providers` and `mutations/`. The UI renders server view models and never decides permission, mode or capability.
- Keep `ai/` away from `mutations/`, `integrations/` and any repository that writes source facts or decisions.
- **Boundary lint is mandatory** and blocking in CI (TA §6.4).

---

## 5. Tenant isolation — NON-NEGOTIABLE

The direct Postgres RLS context pattern with pooled connections is **validated** (TA-Q-29 PASS: local 29/29, managed 22/22; TA §11.6). **TA-Q-29 validates R1–R5.** Implement exactly this shape:

```
connect as the runtime's dedicated login role (R1)
BEGIN
  SET LOCAL ROLE <fixed literal for this scope>                (R3)
  [web] transaction-local claims from the server-verified token → real auth.uid()
  bind the workspace once: sealed, transaction-bound, rebind refused   (R2)
  queries under forced RLS                                     (R4)
COMMIT / ROLLBACK → role, claims, workspace and seal vanish; the pooled connection returns clean
```

Spike names such as `bind_context` are illustrative. Production names are decided during implementation.

**R1: dedicated runtime login roles**

- One `LOGIN NOINHERIT NOBYPASSRLS` login role per runtime (web, worker, system), each a member of exactly one runtime role and able to `SET ROLE` only to it.
- Runtimes **never** connect as `postgres`, `supabase_admin`, `authenticator` or `service_role`, and never hold the Supabase service-role key or migration credentials.

**R2: sealed, transaction-bound context**

- Bind the workspace **once per transaction** through a reviewed `SECURITY DEFINER` function. It stores transaction-local values plus a seal derived from a server-only secret, the transaction ID and the session user. The secret lives in secret stores only.
- **Never** rely on session-level state: no `SET` without `LOCAL`, no session settings, no named prepared statements.
- Missing, stale, forged, replayed or rebound context **fails closed**: 0 rows, writes denied.

**R3: fixed-literal role switch**

- The `SET LOCAL ROLE` target is a **fixed literal** chosen by the scope helper.
- Token role claims may only be **allowlist-checked**. **Never** interpolate a claim or input into role selection.

**R4: forced RLS, explicit grants and policies**

- RLS **enabled and forced** on every tenant table; deny by default.
- `SECURITY DEFINER` helpers use an empty `search_path`. Where they read forced-RLS tables, explicit owner/definer policies admit them.
- Policies that call `auth.uid()` are created by a role with `auth` schema access (the migration role acting as a member of the owner role).
- Explicit schemas, ownership and grants. **Never** rely on Supabase default privileges.
- **Schema/grant introspection tests are mandatory.**

**R5: workspace-scoped references**

- Tenant-sensitive foreign keys are **composite and include the workspace**. A cross-workspace reference fails exactly like a non-existent one: no existence oracle.

**Always:**

- Every tenant table carries the workspace (e.g. `workspace_id`) and has RLS.
- All data access goes through the scope helpers in `platform/db`: **user scope**, **workspace job scope**, or **system scope**. There is no generic "service role" helper.
- Every workspace-scoped transaction, web or job, binds **exactly one workspace**. Every job payload names exactly one workspace, unless the job is explicitly system-scoped.
- Organization-level surfaces (All workspaces, organization settings) read only organization rows and attention-signal rows, never tenant content across workspaces.
- **System scope** is only for named, reviewed, audited system jobs (routing, fan-out, outbox relay, sweepers, health). It covers system tables only. To touch tenant data, enqueue one job per workspace.
- Cross-tenant access returns **NOT_FOUND**, never "forbidden".
- RLS **and** application authorization are both mandatory (TA §11.1). Neither replaces the other.
- Use the Supavisor **transaction mode** with unnamed statements.
- Migrations run only from CI as the migration role, never at application runtime.
- **T-26** (the TA-Q-29 checks and adversarial cases) is a permanent regression suite and **MUST stay green**.

---

## 6. Database role lifecycle — R8

**R8 is separate from the TA-Q-29 isolation result.** It is an operational lifecycle principle discovered during managed validation (TA §11.7). The principles are adopted. **The production rotation procedure is VALIDATE (TA-Q-30) and is not vendor-confirmed.**

- Runtime login roles are **long-lived** in production and in any shared managed Supavisor environment.
- **Never** routinely create → pool → drop LOGIN roles in a shared Supavisor project (dev, staging or preview).
- **Never** drop and recreate an actively pooled role name.
- Shared dev/staging/preview projects use long-lived test and runtime roles, unless a vendor-confirmed drain/removal procedure exists.
- Per-run disposable roles are acceptable **only** in isolated disposable environments or local/non-Supavisor databases.
- Never remove a pooled role until its pool is drained according to the future TA-Q-30 runbook.
- Prefer deleting a whole isolated preview environment over removing pooled roles inside a shared project.
- Credential rotation: in-place password rotation, or a new role name with a drained pool. Confirm the procedure with Supabase **before the first production rotation**.

---

## 7. Product safety invariants — NON-NEGOTIABLE

Source: Model §50 (S1–S21), TA §25–§27, TA Appendix A. **If a request conflicts with any of these: STOP and name the invariant.**

- **Source facts are never overwritten** by interpretations (S12; M-05 scope). Source facts are written only by ingestion. Source text versions are append-only.
- **Interpretive precedence (M-05):** human correction > deterministic rule (only the narrow fact it establishes) > AI > platform hint. Human corrections stay attributable and are never overwritten by later machine output (S13). History is never erased.
- **Negative ≠ harmful (S1):** sentiment never feeds automation or moderation decisions.
- **Complaint protection always wins (S2, S3):** legitimate complaints, product/service problems, fraud/scam accusations against the brand and commercial objections are **never auto-hidden**. This is not configurable. Scam *content* and scam *accusations* are separate meanings (PD D-39).
- **Uncertain protection vetoes automation (M-07).** Missing assessments, AI failures and low confidence produce "uncertain".
- **Abuse/insults are never auto-hidden in the MVP (S4).** They are not an eligible policy type and are always sent to review.
- **Keywords are never meaning (S19).** A pattern match is only a candidate.
- **Automation is hide-only (S5).** No auto-delete, no auto-block. Only four policy types exist: obvious spam, obvious bots, malicious links, configured patterns. All are opt-in and off by default.
- **Automation order is fixed (TA §25.1):** candidate → understanding → protection → eligibility (high confidence) → workspace mode → capability → outcome HIDE | NEEDS REVIEW | NO ACTION, recorded as an Automation Decision.
- **Automation is forward-only (S21; PD D-51).** Each initial Enable, Resume after Pause, and explicit re-enable after Monitor-only creates a **fresh cutover**. **No catch-up auto-hide.** Backfill, reprocessing, model upgrades and corrections never trigger automatic mutations.
- **Preview is required** before activating malicious-link and pattern policies, and again after a mode transition.
- **Monitor-only performs no platform mutation (S7)**, enforced structurally at five points: availability resolver/pipeline, automation evaluator, intent creation, database backstop, executor re-check (TA §26.6). It is never enforced only in the UI.
- **Leaving Monitor-only returns every policy to Paused (IA-16).** Automation **never resumes silently (S10)**.
- **No AI auto-send (S8).** Every reply (public or private) is sent by a human pressing Send. Suggestions and saved replies are only starting points.
- **Delete and block are individual human actions** (PD D-19). **No bulk delete or block (S6).**
- **Human bulk Hide** is for clearly homogeneous sets only. It **excludes protected and uncertain items** (UX-06, UX-18; PD D-52), shows the counts, and is attributed to the person, never to automation.
- **Individual human moderation stays available**, including on protected content (with an informational caution).
- **Private reply never creates a DM inbox, thread or conversation model (S9).** No incoming DM objects, reads or subscriptions exist anywhere.
- **Capability unavailable stays visible-but-unavailable with its reason, never fabricated** (S20; §8).
- **No data ≠ zero (S11).** Recommendations and before/after follow-ups never claim causality (S14, S15).

---

## 8. Platform capability and coverage rules

- Facebook, Instagram and TikTok are first-class **conceptually**. Functional parity is **never** assumed (PD C-07).
- Organic / Paid / Mixed / Unknown is a content-level dimension (PD D-38). Mixed is never forced into organic or paid.
- Capability comes from the **versioned capability catalog plus the account profile plus connection health** (TA §16). Its default is **UNKNOWN** (treated as unavailable). It is **never inferred** from data, such as a payload field or comment volume.
- Enable a real adapter capability **only after its API validation** (PD OQ-18, OQ-19, OQ-26, OQ-27; TA-Q-02, TA-Q-22). Until then, use the simulator.
- **Availability precedence (IA §18, TA §16.6)**, decided by one server-side resolver used by both view models and command guards:
  1. role doesn't allow → **hidden**;
  2. Monitor-only → **visible but unavailable** ("This workspace is Monitor-only");
  3. platform unsupported or unknown → **visible but unavailable** with the platform reason;
  4. unhealthy connection → **blocked with recovery**.

  Show one reason only, in outcome language.
- **Coverage ≠ capability** (TA §17.4). Every number is a **Measured value** with coverage. A zero is only shown when coverage is complete, or partial with a known extent. Otherwise show "Not available — reason".
- Any M-01 asset rule (PD D-50) is enforced in the database and connect flow. Multi-workspace ad accounts wait for TA-Q-02.

---

## 9. Platform Mutation Executor

- Public reply, private reply, hide, unhide, delete and block go **only** through the executor (TA §26).
- **Provider adapters implement the mutation port** and contain the platform-specific API/SDK calls (TA §15). They don't decide product behavior: availability comes from capability evaluation.
- **Only the Platform Mutation Executor may obtain and invoke that mutation port** (TA §6.3 rule 3, §26.1–§26.2). No controller, UI, AI task, ordinary domain service or other non-executor code path may invoke provider mutation methods.
- Provider SDK and response types stay inside the adapters.
- The executor is bundled only into the job runtime. The web deployment may create intents but cannot execute provider mutations.
- Commands **create mutation intents** (idempotency key unique per workspace) through the action pipeline. The executor runs in the job runtime and executes only persisted intents in an executable state.
- At execution the executor **reloads authoritative state and re-runs the guard chain**: identity, permission, workspace, **mode (consistent read)**, kill switches and release gates, capability, connection health, idempotency, action-specific safety. For automation it also checks that the decision is HIDE, the policy is still On, and the **current** protection result is NOT PROTECTED.
- Request types restrict actions at the type level (TA §25.5):
  - `AutomationMutationRequest`: HIDE only, with a decision reference.
  - `BulkMutationRequest`: HIDE only, human, expanded into per-item intents with exclusions.
  - DELETE and BLOCK exist only on a single-target `HumanMutationRequest`.
- **Every consequential internal state transition writes its domain history and audit event in the same database transaction as the state change it records** (TA §13, §41). External provider calls are **outside** any database transaction. Their resulting state or outcome is persisted afterwards, with the corresponding history and audit record.
- Mutation sequence:
  1. One transaction: intent PENDING + history/audit + outbox row.
  2. One committed transaction: intent marked EXECUTING (R6).
  3. Provider call, outside any transaction.
  4. One transaction: outcome (CONFIRMED / FAILED / BLOCKED / OUTCOME_UNKNOWN) + history/audit + outbox outcome events.
  5. If the outcome is ambiguous: OUTCOME_UNKNOWN → reconciliation.

**R6 (validated, TA-Q-04):**

- **Domain idempotency is authoritative.** Vendor idempotency keys only reduce duplicate runs.
- Commit the intent as **EXECUTING** (attempt and run reference) **before** the provider call.
- If an intent is found EXECUTING without an outcome (crash, lost response, redelivered run), or the provider result is unknown, mark it **OUTCOME_UNKNOWN** and **reconcile** before any resend. Never make a blind provider call.
- Ambiguous public or private replies are **never** blindly retried. Private replies are never auto-retried after an unknown outcome.
- State-setting operations (hide/unhide) follow their explicit safe retry policy (TA §18.3).
- No optimistic UI for platform mutations. Show Sending… → Sent / Failed / Checking.

---

## 10. Background jobs and outbox

Trigger.dev is **selected**. Keep it behind the job port so the fallback stays possible.

- Use the **transactional outbox** for all async work. Write the outbox row in the same transaction as the state change, then dispatch after commit (dispatch key = idempotency key).
- **Payloads contain identifiers only** (workspace, object IDs, correlation ID, initiator), never comment text, personal data or credentials. Task logs never include content.
- Jobs **reload authoritative state from PostgreSQL** inside the job's tenant scope.
- **Domain idempotency is mandatory** even though the vendor has idempotency keys.
- Long imports and backfills run in **checkpointed slices** and are resumable. **Backfill never triggers automation.**
- Use **lanes and provider-account concurrency budgets** (TA §19.5, §45): user mutations > realtime ingestion > reconciliation > intelligence > backfill. Honor `retry-after`.
- Scheduling and retries **never override domain safety**.

**R7 (validated, required in the job foundation):**

- Persist each dispatched **run ID and terminal status**.
- A **run-outcome sweeper** detects CRASHED / SYSTEM_FAILURE (or equivalent lost) runs. Trigger.dev does not retry crashed runs.
- Safe re-dispatch relies on domain idempotency, so recovery produces **exactly one domain effect**.
- Runs that failed after exhausting retries, or were aborted as non-retryable, are surfaced for diagnosis, not blindly re-dispatched.
- A dispatch sweeper also covers rows that were never dispatched.

Still open: **TA-Q-31** (deployed workers in staging), **TA-Q-32** (production plan sizing and cost) and **TA-Q-05** (Trigger.dev stores run data in AWS us-east-1; legal acceptability is open).

---

## 11. AI rules

- AI is called **only through the AI Gateway** (TA §22). There are no direct provider SDK calls elsewhere.
- **One task = one named, versioned contract**: input builder, prompt template version, output schema, routing. Prompts are versioned files reviewed like code.
- **Structured output schemas, always re-validated by our code. Fail closed:** invalid output means no assessment. Every AI failure leads to **less automation and more human review**.
- **Provenance on every AI output:** provider, model, task, prompt, schema and taxonomy versions, inputs, time, ledger reference (TA §57).
- **Model or prompt changes require evals** (offline gates and shadow runs). Automation stays behind a **release gate** per platform × policy type until safety evals pass (PD OQ-28).
- AI **never overwrites human corrections** and **never writes source facts**.
- **Numbers are computed by code.** AI never computes authoritative aggregates. Validators reject narrative numbers that differ from the structured values.
- AI has **no tools** that touch the database, platforms or the network. It **cannot trigger platform mutations**. **No AI output is itself authorization.**
- Treat comment text as untrusted: place it in delimited data sections and include injection cases in the adversarial evals.
- Reply suggestions are grounded **only** in current, verified, applicable Brand Context and the conversation. Missing facts are flagged, never invented. Deterministic grounding validators run after generation.
- Brand Context stays relational and lightweight. No vector DB or RAG by default; pgvector only on a measured trigger (TA §28.3).
- **Anthropic is an initial recommendation, not an architectural dependency.** Exact models and providers remain subject to **TA-Q-06** and evals.

---

## 12. Guest and cross-workspace boundaries

- **Client guest** is read-only (IA-05). They see only Insights (including VoC, topic pages and read-only recommendations) and Reports, with **representative guest-safe evidence**.
- Guests read only **guest projections**. RLS denies them every operational and base intelligence table. They can't reach the Inbox, conversations, full histories, conversation-set resolution, Content & Ads, Home, alerts, settings or attention signals by URL, API, search, realtime or export (TA §49).
- Cross-workspace in the MVP is **attention-only**: Workspace Attention Signals plus switching (PD D-37).
- **No portfolio intelligence**: no cross-workspace inbox, aggregates, topics, VoC, reports or search.
- **Never** aggregate tenant content across workspaces, even for convenience. Clicking a signal enters one workspace.

---

## 13. Logging, privacy and secrets

- **Never** log, print or echo secrets, provider access tokens, API keys, database passwords or connection strings, including during diagnostic work.
- **Never** log raw personal or comment content unless an explicitly approved secure path requires it. Logs, metrics and traces carry **identifiers** (data classes in TA §38.11). Raw AI prompts and responses are not logged by default.
- Job payloads stay **IDs-only**. Product analytics use identifiers and allowed enums only. No comment text, author identities, Brand Context, notes or reply text.
- Provider credentials are envelope-encrypted, with the key outside the database (key mechanism **VALIDATE**, TA-Q-07). They are decrypted only inside the integration boundary, through the single credential-access function, within a workspace job scope, for one provider call. Never in the web deployment, the browser, payloads, logs or AI calls (TA §39).
- Web security (TA §38.7):
  - **Server authority**: never rely on frontend-only authorization.
  - **CSRF**: SameSite cookies, origin checks, OAuth `state` bound to user and workspace.
  - **XSS**: comment text, names and AI output are rendered as text only (no raw HTML); links in comments are inert; strict CSP.
  - **SSRF**: the server never fetches URLs found in comments.
  - **Injection**: parameterized queries only.
  - **Webhooks**: signatures verified, failing closed (TA §40).
- **Never commit** `.env.local` or any `.env*` file other than value-free `.env.example`, and never commit credentials, customer data, raw provider captures or production data. Credentials never appear in this file.
- Never read secret values back into conversation output. Don't ask the user to paste credentials.
- Use synthetic or sandbox data for development and tests. **No live customer data** without explicit authorization.
- Don't touch managed services (Supabase, Trigger.dev, Meta, TikTok, AI providers) or any production resource without explicit authorization.

---

## 14. Testing requirements

Tests are part of the change, not cleanup after it. CI gates are blocking (TA §54, §55, §64).

| Change | Required tests |
|---|---|
| New tenant table | RLS + tenant-isolation tests (T-01, T-11); schema classification |
| Schema, grant, policy or role change | Introspection tests (RLS forced, explicit grants, no unexpected `anon`/`authenticated`/runtime privileges, append-only grants) |
| New command | Action-pipeline registration + permission tests |
| Safety-relevant change | The matching invariant and matrix tests (TA §55, Appendix A); every Model §50 invariant maps to at least one test |
| Provider adapter | Contract tests (fixture → DTO, errors, pagination, webhook verification) + simulator parity |
| Platform mutation | Idempotency and unknown-outcome tests (T-10; EXECUTING before call) |
| Job change | Failure, retry and recovery tests; tenant scope; outbox dispatch and sweepers (T-27 for lost/crashed runs) |
| AI contract change | Structured-output and validator tests + eval gate |
| Any mutation path | Monitor-only coverage (T-04) |

**T-26** (the permanent TA-Q-29 adversarial suite) and **T-27** (lost/crashed job recovery, exactly one effect) **MUST stay green.** Don't disable, skip or weaken tests, RLS or guards in committed code.

---

## 15. Git protocol

- **Do not** commit, push, branch, merge, amend, rebase or open PRs unless the user **explicitly authorizes** that operation.
- Inspect `git status` before and after substantial work. Report the diff scope honestly.
- **Never force-push** unless separately and explicitly authorized. Never rewrite approved history casually.
- Never commit secrets, `.env.local`, customer data, raw provider captures, `node_modules/` or `.data/`.
- Checkpoint commits happen only after review and authorization.
- Safety-critical paths (`mutations/`, `automation/`, `classification/`, RLS migrations, `permissions/`) require designated review.

---

## 16. Working protocol for Claude Code

Before changing code:

1. Identify the requested phase, task or step (§17).
2. Read the relevant source-of-truth sections, not only this file.
3. Inspect the existing code before designing replacements.
4. List the constraints and gates that apply (tenancy, safety invariants, R-rules, open items).
5. Implement the **smallest coherent slice**.
6. Run the required checks and tests (§14).
7. Review the diff for scope, secrets and boundaries.
8. Report what changed, what was verified, and what remains or is blocked.

MUST NOT:

- Implement later roadmap steps opportunistically.
- Resolve unrelated open decisions.
- Add libraries merely for convenience, or introduce infrastructure not in the architecture.
- Bypass the architecture for a quick demo, or weaken safety because a provider is difficult.
- Commit any of the TA §69 anti-patterns (e.g. one giant prompt, AI calling moderation APIs, provider SDK types in the domain, an unscoped query layer, frontend-only authorization, cron as a workflow engine, sentiment or keywords as moderation logic, blind reply retries, AI computing numbers, a DM model "for later").
- Disable tests, RLS or guards "temporarily" in committed code, or bypass the executor "for testing" in non-test code.
- Duplicate a concept that already has an owner module.
- Import spike code from `spikes/` into application code. Spikes are disposable references.
- Use live customer data without explicit authorization.

If blocked: **STOP** and report the exact blocker and the safest next action.

---

## 17. Implementation sequence

Follow TA §73 in order. Don't jump ahead because a later feature is visually attractive.

| Step | Scope | Gate / key exit |
|---|---|---|
| 0 | Repository foundation: tooling, strict TS, boundary lint, CI skeleton, observability skeleton, error taxonomy, i18n catalogs | CI + boundary rules active |
| 1 | Auth + tenancy: orgs, workspaces, memberships, roles, permission catalog, **workspace mode**, action pipeline, audit | — |
| 2 | Database foundation + RLS (R1–R5, R8 lifecycle), scope helpers, outbox | T-01, T-11, **T-26** |
| 3 | Job foundation: tenant-scoped wrappers, outbox relay, dispatch and **run-outcome sweepers (R7)**, R6, lanes, flags and kill switches | **T-27** |
| 4 | Provider adapter contracts + simulator + fixtures | Contract tests on simulator |
| 5 | Connections, credentials, capability, coverage | Needs **TA-Q-07**; multi-workspace ad accounts only after **TA-Q-02** |
| 6 | Ingestion + canonical conversation model | T-09; coverage truthful |
| 7 | Inbox read side + workflow | — |
| 8 | AI gateway + understanding + protection + priority + Needs review | T-05, T-13, T-14 |
| 9 | Mutation executor + human platform actions (Monitor-only from day one) | T-04, T-08, T-10, T-12, T-16, T-17, T-27 |
| 10 | Brand Context, Saved Replies, reply suggestions | Grounding validators |
| 11 | Safe automation, **behind the release gate** | T-05–T-07, T-15 (TA §73); forward-only covered by T-25 |
| 12 | Topics + aggregation + Measured values | T-18 |
| 13 | Insights + evidence + guest projections | T-02 for guest data |
| 14 | Recommendations + tracked actions + follow-ups | T-20 |
| 15 | Reports (internal + guest renderings) | — |
| 16 | Cross-workspace attention + alerts | T-19 |
| 17 | Hardening | **TA-Q-31**, **TA-Q-30** before any production credential rotation |

Parallel work is allowed only where TA §73 allows it:

- API validation runs in parallel from the start.
- Steps 7–8 may overlap.
- The step-9 executor may be built against the simulator while step 8 progresses.
- Real adapters replace the simulator per capability only after validation.

---

## 18. Current validation status

Verified against TA §71 (v1.1).

**PASSED / SELECTED:** TA-Q-29 PASS (R1–R5) · TA-Q-04 PASS · Trigger.dev selected · Graphile Worker fallback · R1–R8 adopted as architecture refinements (R8 procedure still VALIDATE under TA-Q-30).

**Confirmed (no longer open):** TA-Q-01 (M-01 / PD D-50) · TA-Q-03 (forward-only, PD D-51) · TA-Q-26 (uncertain excluded from bulk hide, PD D-52).

**Still VALIDATE:** TA-Q-02 · 05 · 06 · 07 · 08 · 09 · 11 · 12 · 13 · 14 · 15 · 21 · 22 · 24 · 25 · 30 · 31 · 32.

**Still OPEN:** TA-Q-10 · 16 (M-04) · 17 (M-03) · 18 (M-06) · 19 (M-10) · 20 · 23 (AI unit-cost model) · 27 · 28.

**Model questions open:** M-02, M-03, M-04, M-06, M-08, M-09, M-10, M-11. Confirmed: M-01, M-05, M-07, M-12.

**Other open items preserved:**

- PD: OQ-01, 03, 10, 11, 13–17, 20, 23–25 (product); OQ-18, 19, 26, 27, 28 (VALIDATE); OQ-21, 22 (legal). All platform capabilities remain VALIDATE.
- IA: IA-06, IA-07, IA-08, IA-12, IA-14.
- UX (deferred): UX-03, UX-07, UX-08, UX-09, UX-13, UX-16. UX-11 is out of the MVP.

---

## 19. Supabase F-S6 operational note

- The Supabase **development** project used for validation had a project-wide pooler refusal (F-S6). This was an **operational** issue. It **does not invalidate TA-Q-29 PASS**.
- The cause (dropping actively pooled roles) is **strongly correlated but not proven**.
- A fresh development project may replace that disposable one without reopening TA-Q-29.
- **Never reproduce the dangerous role lifecycle just to test it again.** Vendor follow-up feeds TA-Q-30.

---

## 20. Definition of done (any implementation slice)

A task is not done until, where applicable:

- [ ] source-of-truth behavior is preserved, and no open item was silently resolved;
- [ ] module, dependency and deployment boundaries are preserved, and boundary lint passes;
- [ ] tests pass, including tenancy (T-26) and safety invariants;
- [ ] no unvalidated platform capability is assumed;
- [ ] migrations are safe (expand-contract, forced RLS, explicit grants, introspection passing, R8 respected);
- [ ] logs, payloads and analytics contain no prohibited data;
- [ ] the diff contains only the intended scope;
- [ ] no secrets are tracked;
- [ ] status and remaining blockers are reported honestly.
