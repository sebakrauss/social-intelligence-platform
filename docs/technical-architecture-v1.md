# Technical Architecture v1 — Social Conversation Intelligence Platform

| Field | Value |
|---|---|
| Document | Technical Architecture v1 |
| Phase | 0E — Technical Architecture · 0E.3 — Validation alignment |
| Version | 1.2 |
| Date | 2026-10-03 (v1.0) · 2026-10-04 (v1.1) · 2026-10-06 (v1.2) |
| Status | **Approved** by the product owner on 2026-10-03 (Phase 0E.1). **v1.1** (Phase 0E.3, 2026-10-04) aligns the approved baseline with the accepted pre-implementation validation: TA-Q-29 and TA-Q-04 **passed**, Trigger.dev is **selected**, refinements R1–R8 are adopted. **v1.2** (2026-10-06) records **TA-Q-07 PASS**: AWS KMS is the locked credential key-management mechanism for Step 5, validated in a managed development run (TA-Q-07b). Approval covers the architectural baseline and boundaries. It does **not** mean that every provider capability or vendor is validated, that legal review is complete, or that implementation may start: the remaining gates are in §71 and §73. |
| Sources of truth | `docs/product-definition-v1.md` v1.3 · `docs/information-architecture-v1.md` v1.1 · `docs/core-ux-flows-v1.md` v1.1 · `docs/intelligence-data-model-v1.md` v1.1 (all approved) · validation evidence: `docs/pre-implementation-validation-v1.md` (Phases 0E.2 and 0E.2b, accepted in Phase 0E.3) |
| Scope | How the product is built: runtime boundaries, technologies, persistence patterns, async processing, security, AI, integrations, testing and operations. **Not** application code, SQL, final schemas, infrastructure configuration or provider setup. |

### Approval record

| Date | Phase | Decision |
|---|---|---|
| 2026-10-03 | 0E | Technical Architecture v1.0 drafted for review. The four source documents are unchanged. M-01 is addressed first (§8) as a TA recommendation that needs product-owner review. All PD, IA, UX and model open questions stay open. |
| 2026-10-03 | 0E.1 | Product owner **approved** the architecture baseline (version 1.0 kept). The baseline listed in §72.1 is **LOCKED**. Vendor, region, API and legal items stay **VALIDATE** (§72.2); Anthropic remains the initial AI recommendation behind the AI Gateway, not an architectural dependency. Product-owner decisions recorded: **M-01 confirmed** (content-bearing Social Asset active in at most one workspace per organization; PD D-50; §8), **forward-only automatic moderation** (PD D-51; §25.7) and **uncertain interactions excluded from human bulk Hide** (PD D-52; §26.5). TA-Q-02 (ad accounts) stays VALIDATE with its intended behavior recorded. New security-critical spike **TA-Q-29** (RLS context with Supabase Auth + Drizzle + pooled connections) added; it blocks the tenancy/database foundation (§11.6). M-02, M-03, M-04, M-06, M-08, M-09, M-10 and M-11 remain open. Sources aligned: PD v1.3, UX v1.1, Model v1.1 (IA v1.1 metadata only). |
| 2026-10-04 | 0E.3 | Version **1.1**: aligned with the accepted Phase 0E.2/0E.2b validation (`docs/pre-implementation-validation-v1.md`). **TA-Q-29 PASS** (local 29/29; managed run of record 22/22 on Supabase with real Auth tokens, Supavisor transaction mode, Drizzle and custom runtime roles): the direct Postgres RLS context pattern with pooled connections is validated (§11.6) and no longer blocks the tenancy/database foundation. **TA-Q-04 PASS**: **Trigger.dev SELECTED** as the job runtime (managed 14/14); Graphile Worker is the documented fallback. Refinements **R1–R8 adopted** and integrated (§9.3, §10.4, §11, §18.3, §19.3, §26.3, §46, §55, §64, §65, §70; ADR-56–ADR-63). The Supabase development-project pooler incident (F-S6) is recorded as an operational issue, not a TA-Q-29 failure (§11.7). TA-Q-05 stays VALIDATE (Trigger.dev stores run data in AWS us-east-1). New tracking items: TA-Q-30 (R8 rotation procedure with Supabase), TA-Q-31 (deployed workers in staging) and TA-Q-32 (Trigger.dev production plan sizing and cost). Provider/API, AI, legal and vendor validations and TA-Q-07 stay open. No product, IA, UX or model semantics changed; M-02, M-03, M-04, M-06, M-08, M-09, M-10 and M-11 remain open. |
| 2026-10-06 | Pre-Step-5 (TA-Q-07b) | Version **1.2**: **TA-Q-07 PASS** after a bounded managed validation in a dedicated development AWS account (region sa-east-1, development validation only). **AWS KMS** is the locked credential key-management mechanism for Step 5 (§39; ADR-38; new ADR-64). Run of record `20261006T174405Z-e0a2`: 86 PASS / 0 FAIL / 5 measured (91 cases); read-only reconciliation 26/26; post-cleanup verification 35/35 (one development KEK retained; temporary validation resources retired). No long-lived AWS credential was created. Not part of this result and still open: deployed-worker authentication to KMS (TA-Q-31), production region and data residency (TA-Q-05), Trigger.dev production sizing (TA-Q-32), web hosting and OIDC federation (TA-11), production account/key topology and the KEK rotation/compromise runbooks (§65). TA-Q-02 stays VALIDATE. No product, IA, UX or model semantics changed. |

---

## 0. How to read this document

### 0.1 Relationship to the source documents

- The **Product Definition (PD)** says what the product is. The **Information Architecture (IA)** says where things live. **Core UX Flows (UX)** says how users move. The **Intelligence & Conceptual Data Model (Model)** says what information exists and what it means. This document says **how to build all of it**.
- Nothing here changes a confirmed decision. Citations look like "PD D-35", "IA §18", "UX §25", "Model §19", "M-05", "S7" (Model §50 safety invariants).
- When a technical choice depends on an unvalidated platform capability, it stays **VALIDATE** (PD OQ-18). No platform behavior is assumed.

### 0.2 Tags used in this document

| Tag | Meaning |
|---|---|
| **LOCKED** | Locked by the product owner in Phase 0E.1. Changes require an explicit architecture decision. |
| **VALIDATE** | Approved direction or candidate that still depends on a spike, vendor evaluation, platform API validation, cost model or legal review before it is final. |
| **DEFER** | Deliberately left to a later design phase or product decision. |
| **PRODUCT OWNER: CONFIRMED (Phase 0E.1)** | A product-behavior decision confirmed by the product owner during this phase and recorded in the PD (D-50 to D-52). |
| *Phase 0E draft tags (historical):* **LOCK NOW** | Proposed for lock in the 0E draft. Superseded by the statuses above (§2, §72). |
| *Phase 0E draft tags (historical):* **RECOMMEND** | Recommended in the 0E draft. Superseded by the statuses above. Where it still appears in explanatory text, the authoritative status is in §2 and §72. |
| **TA RECOMMENDATION — PRODUCT OWNER REVIEW REQUIRED** | A technical recommendation that touches product behavior or resolves an open model question. It is **not** a decision until the product owner confirms it. After Phase 0E.1 this label remains only on M-03, M-04, M-06 and M-10. |
| **TA-nn** | Architecture decision (§2, §72). |
| **TA-Q-nn** | Open technical question (§71). |

### 0.3 Vocabulary

Model vocabulary is used as defined in the Model (§51 entity catalog). Technical terms introduced here:

| Term | Meaning |
|---|---|
| **Tenant context** | The authenticated, server-resolved `(organization, workspace, actor, role)` under which every read and write runs. |
| **Action pipeline** | The single server-side path every consequential command passes through (§10.6). |
| **Mutation intent** | A persisted, idempotently keyed request to change something on a social platform. The only thing the Platform Mutation Executor will act on (§26). |
| **Outbox** | Rows written in the same database transaction as a state change, describing follow-up work to dispatch to the job runtime (§19.3). |
| **Provider adapter** | The only code that knows a platform's API, SDK, payloads and errors (§15). |
| **AI task** | A named, versioned unit of AI work with its own input contract, output schema and routing (§21, §22). |
| **Measured value** | A number that always travels with its coverage and value state, so "not available" can never render as zero (§17.5). |
| **Guest projection** | A guest-safe, separately stored read model that is the only data a Client guest can read (§49). |

---

## 1. Executive technical architecture

### 1.1 What the system is

A **multi-tenant web application** that listens to comments on customers' Facebook, Instagram and TikTok content, understands them with a mix of deterministic rules and AI, helps people act on them safely, and turns them into evidence-backed intelligence. Technically it is:

- **One TypeScript codebase**, organized as a **modular monolith** with strict internal module boundaries.
- **Two compute deployments built from that codebase**: the **web application** (UI, server-side application layer, webhook and OAuth endpoints) and the **durable job runtime** (ingestion, AI processing, platform mutations, intelligence refresh, reconciliation).
- **One authoritative database**: managed **PostgreSQL**, with **Row Level Security** as the last line of tenant isolation.
- **External dependencies at the edges only**: social platform APIs (behind adapters), AI providers (behind an AI gateway), observability and product-analytics vendors.

### 1.2 Major runtime parts

```
 Browser ──▶ Web application (Next.js: UI + server application layer + webhook/OAuth endpoints)
                    │                          │
                    ▼                          ▼
            PostgreSQL (authoritative state, RLS, outbox)  ◀──▶  Durable job runtime (workers)
                    ▲                                                  │
                    │                                                  ├──▶ Provider adapters ──▶ Meta / TikTok APIs
                    └──────────────────────────────────────────────────┤
                                                                       └──▶ AI gateway ──▶ AI provider(s)
```

### 1.3 Why this fits the product

| Product need | Architectural answer |
|---|---|
| One product for SMBs, agencies, enterprises, Monitor-only workspaces and client guests (PD D-23, D-49; IA-05) | One codebase, one data model, one set of deployments. Differences come from tenancy, roles, workspace mode and capability, never from separate backends. |
| Social data arrives asynchronously, unreliably and with rate limits | Durable, idempotent, rate-limit-aware background jobs with reconciliation (§14, §18, §19, §47). |
| Safety rules must hold even when a developer makes a mistake (Model §50) | Structural enforcement: a single Platform Mutation Executor, guard chains, database-level backstops, type-level restrictions, and tests that fail when a boundary is crossed (§25, §26, §55). |
| Workspace is the access and intelligence boundary (PD D-44) | `workspace` scoping on every tenant row, RLS at the database, a tenant-scoped action pipeline in the application, and tenant-scoped job contexts in workers (§9, §11). |
| Explainable, correctable AI (PD §13; Model §15) | AI produces **assessments** (data), never actions. Every assessment carries model, prompt and input provenance. Human corrections always win (M-05). |
| Small team, fast iteration, sensible cost (PD C-08) | Managed services, no microservices, no Kafka, no Redis, no vector database, no search cluster in the MVP. Each has an explicit upgrade trigger. |

### 1.4 What remains one deployable product

Everything customer-facing is one product: one web application, one job runtime project, one database. The job runtime is a **deployment boundary** (long-running, retryable work can't live inside request/response functions), **not** a separate service with its own domain or data. Both deployments import the same domain modules and talk to the same database.

### 1.5 What executes asynchronously

Historical import, ongoing synchronization, webhook processing, classification and topic assignment, automation evaluation, **every platform mutation** (including human-initiated replies and hides, so they can be retried, reconciled and audited uniformly), aggregate and intelligence refresh, report generation, follow-up computation, alerts, attention signals, connection-health checks and reconciliation (§19, §20).

Synchronous: authentication, authorization, reads, internal workflow commands (assign, mark done, notes, escalate, label corrections), configuration changes, creating a mutation intent, and webhook acknowledgement.

### 1.6 Where authoritative state lives

**PostgreSQL is the single source of truth** for all product state: tenancy, configuration, source facts as received, normalized objects, assessments, decisions, history, intelligence snapshots, mutation intents and the outbox. The job runtime keeps only run metadata. The browser holds no authoritative state. Social platforms are the authority for **their** state (what is published, hidden or deleted there); the product records what it observed and when (Model §42).

### 1.7 Architecture thesis

> **A modular TypeScript monolith on managed PostgreSQL, with durable asynchronous jobs for everything that touches the outside world. Tenant isolation and product safety are enforced structurally (by the database, a single action pipeline, a single platform-mutation boundary and type-level restrictions), not by developer convention. AI only ever produces versioned, validated assessments; deterministic code decides what happens next, and humans decide everything consequential.**

---

## 2. Architecture decision summary

Status key after Phase 0E.3 (v1.1): **LOCKED** · **VALIDATE** · **DEFER** (§0.2). Where a row mixes an architectural pattern with a vendor choice, the pattern and the vendor carry separate statuses. The authoritative register is §72.

| ID | Decision | Chosen option | Why | Main rejected alternative(s) | Consequences | Status (v1.1) |
|---|---|---|---|---|---|---|
| **TA-01** | Application architecture | **Modular monolith + durable asynchronous work** | Strong boundaries without distributed-system cost. Matches team size and the priorities (correctness, safety, clarity). | Microservices per domain; serverless function sprawl. | Module boundaries must be enforced by tooling (§6.4). One database, one migration history. | **LOCKED** |
| **TA-02** | Primary language | **TypeScript (strict) end to end** | One language for UI, server, jobs, domain and tests. Shared types for contracts and schemas. Large hiring pool. | TS frontend + Python/Go/Ruby backend (two languages, duplicated contracts). | AI and data work also in TS. Heavy statistics, if ever needed, can move to SQL or a later component. | **LOCKED** |
| **TA-03** | Frontend framework | **Next.js (App Router) + React** | Server rendering for fast, calm surfaces; server components keep data access server-side; mature on the chosen host. | SPA (Vite + React) + separate API service (two deployables, client-side data access); Remix/React Router (viable, smaller ecosystem on host). | UI components never touch the database or providers directly (§6.3). | **LOCKED** |
| **TA-04** | Backend / API pattern | **Server-side application services** (commands and queries) invoked from Server Actions, Server Components and Route Handlers. No public API in the MVP (PD §10.2). | One authoritative path for authorization and validation. No extra network hop. | Separate REST/GraphQL backend; tRPC layer (adds a protocol without adding safety). | All consequential commands go through the action pipeline (§10.6). Route Handlers are reserved for webhooks, OAuth callbacks, realtime authorization and job callbacks. | **LOCKED** (follows from the locked Next.js, application-owned authorization and tenant-scoped transactions) |
| **TA-05** | Relational database | **PostgreSQL** (managed) | Relational integrity, transactions, RLS, full-text search, JSON for raw payloads, partitioning later. Fits current-state + history patterns. | Document stores (weak relational integrity, no RLS); multiple databases per tenant (operational cost). | One shared, RLS-enforced multi-tenant database (§9). | **LOCKED** |
| **TA-06** | Database / backend platform | **Supabase** for managed Postgres, Auth, Storage and Realtime | One vendor for four needs; Postgres-native RLS model; branching for previews; PITR available. | AWS RDS + Cognito/Auth0 + S3 + custom realtime (more vendors and glue); Neon + Clerk (viable; auth outside Postgres makes RLS identity harder). | Region, DPA and compliance posture must be validated (TA-Q-05). Supabase-specific features are wrapped behind platform modules (§6). | **LOCKED** (initial platform for Postgres, Auth, Storage) · Realtime transport **VALIDATE** (TA-Q-21) · region **VALIDATE** (TA-Q-05) |
| **TA-07** | Data access | **Drizzle ORM** (typed, SQL-near) with **version-controlled SQL migrations**, used through **tenant-scoped transactions** that apply RLS context | Type safety without hiding SQL; works with RLS session context; light runtime suits serverless and workers. | Prisma (heavier runtime, awkward per-transaction RLS context); raw SQL only (less type safety); Supabase client/PostgREST as the server data layer (weak transactions for domain logic). | Every query runs inside a tenant scope helper (§9.3). Unscoped access is a separate, narrow, audited path. | **LOCKED** · pooled-connection RLS context **VALIDATED** (TA-Q-29 PASS; pattern in §11.6) |
| **TA-08** | Authentication | **Supabase Auth** (email + password/magic link; Google sign-in optional) with server-validated sessions | Identity lives next to the data for RLS; managed MFA; SSR session support. | Clerk/Auth0 (extra vendor; identity bridging into RLS); self-built auth. | Authorization is **not** delegated to auth claims: roles and permissions live in app-owned tables (§10). | **LOCKED** |
| **TA-09** | Tenancy enforcement | **Three layers**: RLS at the database, tenant-scoped action pipeline in the application, tenant-scoped job context in workers. Every tenant row carries its workspace. | Defense in depth: one layer can fail without a leak. | App-only filtering (one missed `where` = leak); database-per-tenant (cost, migrations, cross-workspace attention harder). | Schema introspection tests fail the build if a tenant table lacks RLS (§54). | **LOCKED** · mechanism **VALIDATED** (TA-Q-29 PASS; R1–R5, §11.6) |
| **TA-10** | Background jobs | **Trigger.dev** (managed durable task runtime) fed by a **Postgres transactional outbox** | Long-running tasks (imports) without request time limits; retries, idempotency keys, per-key concurrency queues, schedules and run observability out of the box; outbox keeps DB state and job dispatch consistent. | Inngest (strong flow control, but steps execute inside web functions with host time limits); Postgres queue (Graphile Worker / pg-boss) on a self-run worker host (transactional enqueue, but we operate and observe it ourselves); cron + serverless (not durable). | Job payloads carry identifiers, never comment text or credentials (§19.4). Vendor confirmed by the TA-Q-04 spike (PASS); jobs sit behind a thin port so a switch is contained. Trigger.dev doesn't retry crashed runs, so the outbox tracks run outcomes (R7, §19.3). | Vendor **SELECTED: Trigger.dev** (TA-Q-04 PASS); Graphile Worker = fallback · outbox pattern **LOCKED** (TA-28) · deployed workers validated in staging (TA-Q-31) · data location under TA-Q-05 |
| **TA-11** | Deployment | **Three deployment units**: web (Vercel), job runtime (Trigger.dev), data platform (Supabase) | Managed, minimal operations; each unit maps to a real runtime need. | Kubernetes/containers on a cloud provider (operations burden); single host (no durable long-running work). | Region co-location required (TA-Q-05). Trigger.dev documents run-data storage in AWS us-east-1. | Three-unit shape approved · job runtime **Trigger.dev SELECTED** (TA-Q-04 PASS) · web host **VALIDATE** (Vercel recommended) · region **VALIDATE** (TA-Q-05) |
| **TA-12** | Provider integration pattern | **Adapter contract per platform**, normalized domain types, **webhooks + polling + reconciliation**, capability-driven behavior | Platforms differ and change; core logic must not. | Provider SDK calls inside domain logic; webhook-only sync. | Every provider behavior is validated per platform before it is enabled (PD OQ-18). | **LOCKED** (pattern) · provider specifics **VALIDATE** (PD OQ-18, TA-Q-22) |
| **TA-13** | Platform mutation boundary | **One Platform Mutation Executor** with a guard chain, persisted mutation intents and re-checks at execution time | Makes Monitor-only, protection, permissions and idempotency structural (S2–S8). | Mutations called from wherever needed. | Only the executor can obtain a provider mutation port (§26.2). | **LOCKED** |
| **TA-14** | AI provider abstraction | **In-process AI Gateway** with a task registry, provider adapters, schema validation, provenance ledger and cost accounting | Task-specific routing, vendor substitution and auditability without a separate service. | Vendor SDK called from domain code; a hosted LLM proxy as a separate service (extra hop and vendor). | Domain code depends on task contracts only (§22). | **LOCKED** |
| **TA-15** | Initial AI provider | **Anthropic (Claude model family), routed per task by tier**; a second provider integrated behind the gateway only when evals or resilience justify it | Strong multilingual reasoning and structured outputs; batch processing for backfills; prompt caching for stable instructions. | Single-model-for-everything; self-hosted open models in the MVP (operations and quality risk). | Final model per task chosen by evals (§56). Data-processing terms validated (TA-Q-06). | **VALIDATE** (TA-Q-06). Anthropic is the initial recommendation behind the gateway, not an architectural dependency |
| **TA-16** | AI structured output | **Schema-validated outputs, fail-closed** | Malformed or uncertain AI output must never become permission to act. | Free-text parsing; trusting provider-side validation alone. | Invalid output → no assessment → uncertain → Needs review (§23). | **LOCKED** |
| **TA-17** | Realtime | **Workspace-scoped invalidation signals** over Supabase Realtime private broadcast channels; client re-fetches through the server; polling fallback | Only operational surfaces need live updates; signals carry identifiers, not content, so authorization stays in one place. | Database change streams to the browser (per-subscriber RLS cost; content leakage risk); realtime everywhere. | Insights and Reports are not realtime (§34). | **VALIDATE** (TA-Q-21) |
| **TA-18** | Object / file storage | **Supabase Storage**, private buckets, workspace-prefixed paths, short-lived signed URLs. **No copying of platform media in the MVP.** | Few genuine file needs initially; respects platform terms. | Copying all platform media (cost, terms, privacy). | Exports and report files later (PD OQ-15). | **LOCKED** (Supabase Storage, private buckets) · media behavior **VALIDATE** (TA-Q-12) |
| **TA-19** | Cache | **No Redis or external cache in the MVP** | Postgres and request-level caching suffice; fewer moving parts. | Redis "because SaaS needs Redis". | Explicit upgrade triggers (§35). | **LOCKED** |
| **TA-20** | Search | **PostgreSQL full-text search + trigram matching**, workspace-scoped | Adequate for MVP scope and volume; no extra infrastructure. | Elasticsearch/OpenSearch/hosted search in the MVP. | Upgrade triggers defined (§36). | **LOCKED** |
| **TA-21** | Brand Context storage and use | **Structured relational Brand Context**, passed whole (or deterministically filtered) to reply tasks; **no RAG or vector search** | Brand Context is small and verified by design (PD D-47). | Document ingestion + embeddings + retrieval. | Upgrade path is pgvector inside Postgres, only on measured need (§28). | **LOCKED** |
| **TA-22** | Vector database | **None in the MVP**; pgvector is the upgrade path if a real requirement appears | No current requirement needs it (topics, Brand Context and search are covered otherwise). | Dedicated vector database. | §28, §30, §36. | **LOCKED** |
| **TA-23** | Observability | **Sentry** (errors, performance traces) + **structured JSON logs** to a managed log store + correlation IDs propagated across request → job → provider/AI call | Diagnose incidents without reading production rows. | Self-run Prometheus/Grafana/ELK stack. | Log-store vendor chosen in TA-Q-08. Redaction rules mandatory (§42). | **LOCKED** (structured logs, error tracking, correlation IDs) · vendors **VALIDATE** (log store TA-Q-08) |
| **TA-24** | Product analytics | **PostHog** (cloud, region per TA-Q-09) configured for **identifiers-only events**, no autocapture of text, no session replay of conversation content | Product usage insight separate from customer intelligence; feature-flag capability available but **not** used for safety switches. | Google Analytics (ad-tech orientation, weaker B2B fit); no analytics. | Consent model per market (TA-Q-09). | **VALIDATE** (TA-Q-09) |
| **TA-25** | Testing | **Layered test architecture** with mandatory tenant-isolation, RLS and safety-invariant suites, provider simulator and contract tests, AI eval harness | Safety invariants must become automated tests (Model §55). | Manual QA plus unit tests. | CI blocks merges on invariant failures (§54, §55, §64). | **LOCKED** |
| **TA-26** | Secrets management | Platform secret stores (Vercel, Trigger.dev, Supabase) per environment; no secrets in the repository or logs; **provider tokens envelope-encrypted with a key held outside the database** | Least exposure; credentials decryptable only inside the integration boundary. | Plain database columns; `.env` files shared across environments. | Key-management choice in TA-Q-07. | **LOCKED** (principles: no secrets in repo/logs; tokens envelope-encrypted, key outside the database) · key-management mechanism **AWS KMS — LOCKED** (validated, TA-Q-07 PASS; ADR-64) · production account/key topology **open** (§39) |
| **TA-27** | History pattern | **Current state + immutable history records** written in the same transaction; **no full event sourcing** | Answers "what is true now" cheaply and "what did we believe then" reliably. | Event sourcing (replay complexity, projection management). | Append-only tables protected at the database level (§13). | **LOCKED** |
| **TA-28** | Async dispatch | **Transactional outbox** in Postgres, relayed to the job runtime, plus a sweeper | No lost or phantom jobs when a transaction commits or rolls back. | Enqueue-after-commit without recovery; two-phase commit. | Consumers must be idempotent (§18). | **LOCKED** |
| **TA-29** | Repository structure | **One repository, one TypeScript package, two deployment targets**, lint-enforced module boundaries | Least complexity that keeps boundaries visible. | Multi-package monorepo now; multiple repositories. | Revisit if build times or team structure demand it (§6.5). | **LOCKED** |
| **TA-30** | Feature flags and kill switches | **Database-backed configuration** with audit; global and per-scope kill switches checked by the executor and AI gateway | Safety-critical switches must live in the authoritative database, not a third-party flag vendor. | Full feature-flag platform for safety switches. | §66. | **LOCKED** |
| **TA-31** | Guest access model | **Guest projections**: Client guests read only guest-safe, separately stored read models | IA-05 enforced by data shape and RLS, not navigation. | Filtering guest views in UI or query parameters. | Projection jobs keep guest data in sync (§49). | **LOCKED** |
| **TA-32** | n8n | **Not part of the product runtime.** Optional internal back-office tooling only, with no access to tenant data or provider credentials | Critical logic must be testable, versioned code. | n8n for ingestion or automation. | §67. | **LOCKED** |
| **TA-33** | MCP | **Development tooling only**; never part of the customer-facing runtime | Keeps production surface minimal. | Production MCP servers in the MVP. | §68. | **LOCKED** |
| **TA-34** | Transactional email | A transactional email provider (e.g., Resend or Postmark) for authentication and invitation emails; alert channels stay open (PD OQ-17) | Invitations and sign-in need reliable email regardless of OQ-17. | Supabase default SMTP in production (rate-limited). | Vendor in TA-Q-24. | **VALIDATE** (TA-Q-24) |
| **TA-35** | Hosting region / data residency | Co-locate database, web functions and workers in one region chosen with legal review | Latency, cost and data-protection obligations (PD R-09). | Multi-region in the MVP. | TA-Q-05; depends on PD OQ-21. | **VALIDATE** (TA-Q-05) |

**Not in this table:** M-01 (Social Asset uniqueness), the first architecture decision required by the Model, was **confirmed by the product owner in Phase 0E.1** (PD D-50; §8; ADR-48 LOCKED). The security-critical spike TA-Q-29 **passed** (Phase 0E.2b); the validated pattern is in §11.6, and refinements R1–R8 are registered as ADR-56–ADR-63 (§72).

---

## 3. Proposed stack

### 3.1 Stack summary

| Layer | Choice | Status |
|---|---|---|
| Language | TypeScript (strict mode) | LOCKED |
| Web framework | Next.js (App Router), React | LOCKED |
| UI styling and components | A headless, accessible component approach (e.g., Radix-based primitives + Tailwind CSS) selected during design phase | DEFER (design-phase decision) |
| Internationalization | ICU message catalogs with stable keys (no hard-coded strings, PD §16.7) | LOCKED (principle: stable keys, no hard-coded strings); library choice at implementation |
| Validation | Zod (or equivalent) schemas shared by server commands, job payloads and AI output validation | Approved direction; library choice at implementation |
| Database | PostgreSQL on Supabase | LOCKED (Postgres; Supabase as initial platform) |
| Data access | Drizzle ORM + SQL migrations | LOCKED · RLS context mechanism VALIDATED (TA-Q-29 PASS, §11.6) |
| Auth | Supabase Auth; app-owned authorization | LOCKED |
| Realtime | Supabase Realtime (private broadcast channels, invalidation signals only) | VALIDATE (TA-Q-21) |
| Storage | Supabase Storage (private buckets) | LOCKED |
| Background jobs | Trigger.dev + Postgres outbox | Outbox LOCKED · Trigger.dev SELECTED (TA-Q-04 PASS) · Graphile Worker fallback |
| Web hosting | Vercel | VALIDATE (recommended) |
| AI | In-process AI Gateway; Anthropic Claude models routed per task; second provider optional | LOCKED (gateway) · provider/models VALIDATE (TA-Q-06) |
| Errors and traces | Sentry | VALIDATE (recommended) |
| Logs | Structured JSON logs → managed log store (candidates: Axiom, Better Stack) | LOCKED (structured logs) · vendor VALIDATE (TA-Q-08) |
| Product analytics | PostHog, identifiers-only | VALIDATE (TA-Q-09) |
| Email | Transactional email provider (candidates: Resend, Postmark) | VALIDATE (TA-Q-24) |
| Source control and CI | Git hosting with CI (GitHub + GitHub Actions recommended) | Approved direction |
| Not used in the MVP | Microservices, Kafka/RabbitMQ, Redis, vector database, Elasticsearch/OpenSearch, Kubernetes, n8n in runtime, production MCP | LOCKED |

### 3.2 Frontend / application: Next.js, React, TypeScript

| Option | Assessment | Verdict |
|---|---|---|
| **Next.js (App Router)** | Server Components keep data access on the server, which suits strict authorization. Server Actions give a built-in, origin-checked command path. Streaming and partial rendering support calm, fast surfaces. First-class on Vercel. Risk: framework churn; mitigated by keeping domain logic outside framework code. | **Chosen** |
| Vite SPA + separate API | Clear client/server split but two deployables, client-side data fetching, duplicated auth handling. | Rejected for MVP |
| Remix / React Router framework mode | Good server model; smaller ecosystem and hosting fit. | Viable alternative |
| React | De facto standard; best accessibility and component ecosystem. | **Chosen** |
| TypeScript | Shared contracts across UI, server, jobs and AI schemas. | **Chosen** |

**Rule:** React components render view models. They never import database, provider, AI or job modules (§6.3).

### 3.3 Database / backend platform: PostgreSQL and Supabase

| Supabase capability | Use in this architecture | Notes |
|---|---|---|
| **Postgres** | Single authoritative database. | Connection pooling for serverless and workers is required. Supavisor transaction mode with dedicated runtime login roles is validated (TA-Q-29, §11.6); runtime roles are long-lived (R8, §11.7). |
| **Auth** | Authentication only (identity, sessions, MFA). | Authorization stays in app-owned tables (§10). |
| **Row Level Security** | Tenant isolation backstop for user requests and workers (§11). | Policies written in SQL migrations later; none in this phase. |
| **Realtime** | Private, workspace-scoped broadcast channels carrying invalidation signals (§34). | Spike required (TA-Q-21). |
| **Storage** | Private buckets for exports and future report files (§37). | No platform media copying in MVP. |
| **Branching** | Isolated databases for preview environments (§51). | VALIDATE cost and seeding. |
| **Point-in-time recovery** | Production backup posture (§62). | Paid add-on; required in production. |

**Why Supabase over assembling AWS services:** fewer vendors and less glue for a small team, and an identity model that already integrates with Postgres RLS. **Lock-in mitigation:** Postgres is standard; Supabase Auth, Realtime and Storage sit behind platform modules (`platform/auth`, `platform/realtime`, `platform/storage`) so a later move is contained.

### 3.4 Data access: Drizzle vs Prisma vs typed SQL

| Option | Strengths | Weaknesses | Verdict |
|---|---|---|---|
| **Drizzle** | Typed, SQL-shaped queries; thin runtime; supports transactions where session settings (role, claims, tenant context) can be applied per transaction; schema-to-migration generation with reviewable SQL. | Younger ecosystem; RLS policies still best kept as reviewed SQL. | **Chosen** |
| Prisma | Mature, productive. | Heavier runtime and engine; applying per-transaction RLS context is awkward; tends to hide SQL that we want reviewed. | Rejected |
| Raw SQL / query builder only (e.g., Kysely) | Maximum control. | More hand-written typing. | Acceptable for complex analytical queries inside the aggregation module |
| Supabase client (PostgREST) as server data layer | Fast to start; RLS-native. | Weak multi-statement transactions for domain logic; logic drifts toward the client. | Rejected for server domain logic; may be used for Realtime/Storage only |

### 3.5 Background jobs: comparison

| Requirement | Trigger.dev | Inngest | Postgres queue (Graphile Worker / pg-boss) + own workers | Cron + serverless |
|---|---|---|---|---|
| Durable, retryable | ✓ | ✓ | ✓ | ✗ |
| Long-running work (30-day import, large batches) | ✓ managed compute, no request time limits | Steps run inside our web functions; each step bound by host limits | ✓ on our own worker host | ✗ |
| Per-key concurrency (per connected account, per provider) | ✓ queues with concurrency keys | ✓ (concurrency, throttling, rate limiting by key) | Manual | ✗ |
| Idempotency keys | ✓ | ✓ | Job keys | ✗ |
| Schedules | ✓ | ✓ | ✓ (cron extension) | ✓ |
| Run-level observability | ✓ dashboard, logs, traces | ✓ dashboard | Build it ourselves | ✗ |
| Transactional enqueue with DB state | Via outbox | Via outbox | ✓ native | ✗ |
| Operations burden | Low | Low | Medium (host, scaling, monitoring) | Low but unsafe |
| Self-hosting option | ✓ (open source) | Partial | ✓ | — |

**Selected: Trigger.dev + Postgres outbox** (TA-Q-04 PASS, Phase 0E.2b: 14/14 managed checks on a Trigger.dev Development project; outbox 13/13 locally). **The outbox pattern is LOCKED.** Imports and backfills are long-running and must respect rate limits per account, which favors a runtime that runs tasks on its own compute with keyed concurrency. The outbox closes the consistency gap between "the database changed" and "the follow-up job exists". **Fallback (not selected):** Graphile Worker on a small managed container host, validated locally, if Trigger.dev later fails on data residency (TA-Q-05), pricing or deployed-worker behavior (TA-Q-31); the job port keeps a switch contained. Supabase-native queues with edge functions were considered and rejected for core workflows because of execution-time limits.

**Validated facts that shape the design (TA-Q-04):** idempotency keys deduplicate dispatch but are released when a run fails or crashes; `concurrency: { perKey: 1 }` with a concurrency key serializes work per provider account; a worker **process crash** ends the run CRASHED and **Trigger.dev does not retry it**, so the outbox run-outcome sweeper is mandatory (R7, §19.3); vendor idempotency never replaces domain idempotency (R6, §18.3); payloads as stored by the vendor contained identifiers only. Trigger.dev stores run data in AWS us-east-1 (DPA); whether that is acceptable is a legal question (TA-Q-05).

### 3.6 Hosting

| Unit | Choice | Why |
|---|---|---|
| Web application, webhooks, OAuth callbacks | **Vercel** | First-class Next.js hosting, preview deployments per pull request, instant rollback, firewall/rate-limit rules at the edge. |
| Job runtime | **Trigger.dev cloud** (selected, TA-Q-04 PASS) | Durable long-running tasks; separate scaling from web traffic. |
| Database, auth, storage, realtime | **Supabase** | §3.3. |

All three must run in the same geographic region (TA-Q-05). Trigger.dev documents run-data storage in AWS us-east-1; the region choice and its legal acceptability stay VALIDATE under TA-Q-05.

### 3.7 Observability

| Need | Choice |
|---|---|
| Error tracking (web and workers) | Sentry, with release tagging and source maps |
| Performance traces | Sentry performance tracing (sampled), with trace context propagated into jobs |
| Structured logs | JSON logs with redaction, shipped from Vercel and Trigger.dev to one managed log store (TA-Q-08) |
| Job observability | Trigger.dev run dashboard + logs correlated by IDs |
| Metrics | Derived from structured logs and domain tables (ingestion lag, queue depth, mutation outcomes, AI cost) before introducing a metrics stack |
| Uptime and alerting | Synthetic checks on web and webhook endpoints; alert routing to the on-call channel |

### 3.8 Product analytics

**PostHog** with: server-side capture for domain events (reliable, no ad blockers), client-side capture for navigation only, **autocapture of text disabled**, **session replay off** (or strictly masked and excluded from conversation and composer surfaces), pseudonymous identifiers, region chosen with legal review. Analytics is never the store for safety-critical feature flags (§66).

### 3.9 AI

An **in-process AI Gateway** (§22) owns all model calls. **Initial provider recommendation: Anthropic** (VALIDATE, TA-Q-06). It is a recommendation behind the gateway, not an architectural dependency: domain code depends only on task contracts. Tiered routing (final per-task choice by evals, §56):

| Tier | Typical tasks | Candidate models today (configuration, not code) |
|---|---|---|
| Fast / high-volume | Interaction understanding, topic assignment, translation | Claude Haiku-class (e.g., `claude-haiku-4-5`), or a Sonnet-class model if evals show a safety or quality gap |
| Balanced | Reply suggestions, dedicated protection check, insight narrative | Claude Sonnet-class (e.g., `claude-sonnet-5`) |
| High reasoning (low volume) | Driver hypotheses, recommendation drafting, emerging-topic discovery | Claude Opus-class (e.g., `claude-opus-5`) |

Supporting provider features: batch processing at lower cost for historical import classification, prompt caching for stable instructions (taxonomy definitions, workspace Brand Context blocks), and native structured outputs (always re-validated by our own schemas). A second provider is integrated behind the same gateway only when evals or resilience needs justify it (TA-Q-06). Model identifiers are configuration and will change; provenance records the exact model used (§57).

### 3.10 Explicitly not chosen for the MVP

| Technology | Why not now | What would justify it later |
|---|---|---|
| Microservices | No boundary needs independent scaling or ownership yet. | A component with distinct scaling, security or team ownership (e.g., ingestion at very high volume). |
| Kafka / RabbitMQ | Outbox + durable job runtime covers delivery and retries. | Sustained event throughput beyond job-runtime economics; multiple independent consumers at scale. |
| Redis | §35. | §35 triggers. |
| Vector database | §28, §30. | Measured retrieval need that pgvector can't meet. |
| Elasticsearch / OpenSearch | §36. | §36 triggers. |
| Kubernetes | Managed platforms suffice. | Self-hosting requirements or cost at scale. |
| Analytical warehouse (e.g., ClickHouse) | Postgres aggregation is adequate at MVP volume. | Aggregate queries that can't meet targets on Postgres (§59). |

---

## 4. System context diagram

```
 ════════════════════════════  TRUST BOUNDARY 1: PUBLIC INTERNET (untrusted)  ════════════════════════════

   Users (browser)                 Social platforms                         AI provider(s)
   Owner · Admin · Manager ·       Meta (Facebook, Instagram, ads)          (Anthropic first; others
   Responder · Analyst ·           TikTok (organic, ads)                     only behind the gateway)
   Client guest                      │  ▲ webhooks (signed)                     ▲
        │  HTTPS, session cookie     │  │ API calls (OAuth tokens)              │ HTTPS, API key
        ▼                            ▼  │                                       │
 ═══════════════════════  TRUST BOUNDARY 2: PRODUCT EDGE (authenticate / verify everything)  ═══════════════
        │                            │  │                                       │
 ┌──────┴────────────────────────────┴──┼─────────────┐                         │
 │ WEB APPLICATION (Vercel)             │             │                         │
 │  UI (React) ─ renders view models    │             │                         │
 │  Server application layer            │             │                         │
 │   · action pipeline (authn → tenant  │             │                         │
 │     context → authz → validate →     │             │                         │
 │     tx → audit → outbox)             │             │                         │
 │   · queries (tenant-scoped)          │             │                         │
 │  Webhook receivers ─ verify, store   │             │                         │
 │   raw event, ack fast                │             │                         │
 │  OAuth callbacks ─ encrypt tokens    │             │                         │
 └──────┬───────────────────────────────┼─────────────┘                         │
        │ tenant-scoped transactions    │                                       │
        │ (RLS: user identity)          │                                       │
 ═══════│═══════════  TRUST BOUNDARY 3: DATA PLANE (RLS, least-privilege roles)  ══│════════════════════════
        ▼                               │                                       │
 ┌─────────────────────────────────┐    │     ┌─────────────────────────────────┴──────┐
 │ POSTGRESQL (Supabase)           │◀───┼────▶│ DURABLE JOB RUNTIME (Trigger.dev)       │
 │  tenancy · config · source facts│    │     │  Integration workers (ingest, backfill, │
 │  normalized objects · assessments    │     │   sync, reconciliation, health)         │
 │  history/events · intelligence  │    │     │  Intelligence workers (classify, topics,│
 │  snapshots · mutation intents   │ outbox    │   aggregates, insights, reports)        │
 │  outbox · audit · AI call ledger│ relay│    │  Platform Mutation Executor             │
 │  encrypted credentials (no RLS  │────┼────▶│  Scheduler (schedules, sweepers)        │
 │   read grant to app roles)      │    │     │   │ tenant-scoped job context (RLS)     │
 └────────┬────────────────────────┘    │     │   ├─▶ Provider adapters ─────────────────┼──▶ Meta / TikTok
          │                             │     │   └─▶ AI gateway ────────────────────────┼──▶ AI provider(s)
 ┌────────┴────────────────────┐        │     └──────────────────────────────────────────┘
 │ Supabase Auth · Storage ·   │        │
 │ Realtime (private channels, │◀───────┘  invalidation signals only (IDs, no content)
 │ IDs only)                   │
 └─────────────────────────────┘

 ═════════════════════  TRUST BOUNDARY 4: THIRD-PARTY TELEMETRY (no secrets, minimal content)  ════════════
   Sentry (errors, traces) · Log store (redacted JSON logs) · PostHog (identifier-only product events)
```

**Trust boundaries:**

| # | Boundary | What crosses it | Controls |
|---|---|---|---|
| 1→2 | Internet → product edge | User requests; provider webhooks; OAuth redirects | TLS; session validation; CSRF/origin checks; webhook signature verification; OAuth `state` binding; edge rate limits. |
| 2→3 | Application → data plane | Tenant-scoped queries and commands | Action pipeline; tenant-scoped transactions; RLS; least-privilege database roles; no service role in application runtime. |
| 3→1 | Workers → providers / AI | Provider API calls with decrypted tokens; AI calls with minimal content | Credentials decrypted only inside the integration boundary; egress only to allowlisted provider and AI domains; minimal-content prompts. |
| 2/3→4 | Application → telemetry vendors | Errors, logs, traces, product events | Redaction; identifiers instead of content; no tokens or secrets ever. |

No separate services exist beyond what is drawn. The Platform Mutation Executor, AI gateway, provider adapters and scheduler are **modules inside the job runtime deployment**, not separate services.

---

## 5. Runtime components

### 5.1 Component responsibilities

| Component | Responsibilities | Must not | Code boundary | Deployment boundary |
|---|---|---|---|---|
| **Web Application (UI)** | Render surfaces from server-provided view models; collect user intent; show availability states computed by the server (IA §18). | Decide permissions, capability or mode; call providers, AI or the database directly. | `app/`, `ui/` | Web (Vercel) |
| **Server / Application Layer** | Commands and queries; action pipeline (§10.6); tenant context resolution; availability resolution; creating mutation intents; writing outbox rows; webhook reception; OAuth callbacks. | Call provider mutation APIs; hold long-running work; bypass RLS. | `server/`, `modules/*/application` | Web (Vercel); the same application services are also invoked by jobs |
| **Database** | Authoritative state; RLS; constraints (uniqueness, one active Tracked Action, idempotency keys); append-only history; outbox; audit. | Contain business workflows in triggers beyond integrity backstops. | `db/` (schema, migrations, RLS policies) | Supabase |
| **Background Job Orchestrator** | Durable execution, retries, keyed concurrency, schedules, run observability. | Be the source of truth for business state. | `jobs/` (task definitions are thin wrappers) | Trigger.dev |
| **Outbox Relay** | Forward committed outbox rows to the job runtime; mark dispatched; sweep stuck rows. | Drop or reorder within an ordering key. | `platform/outbox` | Runs as a short web-invoked dispatch after commit + a scheduled sweeper task |
| **Integration Workers** | Webhook event processing, polling sync, historical backfill, paid-context retrieval, native-activity detection, connection-health checks, token refresh. | Interpret meaning (that's classification); mutate platforms (that's the executor). | `modules/ingestion`, `modules/connections`, `jobs/integration` | Job runtime |
| **Intelligence Workers** | Deterministic enrichment, AI understanding, protection evaluation, priority, topic assignment, aggregates, observations, insights, drivers, recommendations, follow-ups, reports, attention signals, alerts. | Mutate platforms; write source facts. | `modules/*`, `jobs/intelligence` | Job runtime |
| **Platform Mutation Executor** | The **only** path to provider mutation methods: guard chain, intent lifecycle, idempotency, outcome recording, reconciliation hand-off (§26). | Accept requests that skip the guard chain; let AI or UI call it directly. | `mutations/` | Job runtime (intent creation happens in the application layer) |
| **Scheduler / Reconciliation** | Periodic sync, reconciliation sweeps, outbox and intent sweepers, token refresh, health checks, intelligence refresh cadence, report periods, follow-up readiness. | Act as a workflow engine through cron alone. | `jobs/schedules` | Job runtime schedules |
| **Provider Adapters** | Platform-specific API calls, pagination, rate-limit signal parsing, error classification, payload normalization into domain types. | Leak SDK/response types; decide product behavior. | `integrations/providers/{meta,tiktok,simulator}` | Loaded by workers (and by OAuth callback for token exchange) |
| **AI Gateway** | Task registry, routing, provider adapters, schema validation, retries, provenance ledger, cost and latency accounting, kill switches. | Expose tools that touch platforms or the database; be called with unscoped data. | `ai/` | Loaded by workers and by the web layer for on-demand tasks (suggestions, translation) |
| **Observability layer** | Logging with redaction, error capture, trace propagation, correlation IDs, metrics derivation. | Log secrets or comment text. | `platform/observability` | All deployments |

### 5.2 Code boundary vs deployment boundary

```
                         ONE CODEBASE (one TypeScript package)
 ┌────────────────────────────────────────────────────────────────────────────────┐
 │ app/ ui/        server/        modules/*        mutations/   ai/   integrations/ │
 │   │               │              │                 │          │        │        │
 └───┼───────────────┼──────────────┼─────────────────┼──────────┼────────┼────────┘
     │               │              │                 │          │        │
     ▼               ▼              ▼                 ▼          ▼        ▼
 ┌─────────────────────────────┐  ┌──────────────────────────────────────────────┐
 │ DEPLOYMENT: Web (Vercel)    │  │ DEPLOYMENT: Job runtime (Trigger.dev)        │
 │ app/ ui/ server/ modules/*  │  │ jobs/ → server/ application services,        │
 │ ai/ (on-demand tasks only)  │  │ modules/*, mutations/, ai/, integrations/    │
 │ integrations/ (OAuth token  │  │                                              │
 │ exchange only)              │  │                                              │
 └─────────────────────────────┘  └──────────────────────────────────────────────┘
```

- **Code boundaries** are modules with public APIs and lint-enforced import rules (§6.4).
- **Deployment boundaries** exist only where runtime needs differ: request/response with short time limits (web) vs long-running, retryable, rate-limited work (jobs).
- The mutation executor is deliberately bundled **only** into the job runtime: the web deployment can create intents but has no code path that executes a provider mutation (§26.2).

---

## 6. Repository / codebase architecture

### 6.1 Decision

**One repository, one TypeScript package, two deployment targets** (TA-29, LOCKED). A multi-package monorepo adds tooling (workspaces, build graph, versioning) that doesn't buy safety now. Boundaries are enforced with dependency rules, not package walls.

### 6.2 Conceptual layout (not to be created in this phase)

```
repo/
├── app/                      Next.js routes (pages, layouts, route handlers). Thin: parse → call server/ → render.
│   ├── (workspace)/w/[workspaceId]/...   workspace-scoped surfaces (Home, Inbox, Content & Ads, Insights, Reports, Settings)
│   ├── (org)/...                           All workspaces, organization settings
│   └── api/                                webhooks/[provider], oauth/[provider]/callback, realtime/auth, internal/outbox-dispatch
├── ui/                       Presentational components, view-model renderers, i18n message usage. No data access.
├── server/                   Application layer
│   ├── pipeline/             action pipeline: authn, tenant context, authz, validation, tx, audit, outbox
│   ├── commands/             one file per command (assign, markDone, requestReply, requestHide, setMode, …)
│   ├── queries/              tenant-scoped read models for surfaces (Inbox list, conversation detail, …)
│   └── availability/         server-side availability resolver (role → mode → capability → connection)
├── domain/                   Shared kernel: ids, time, money-free value types, Measured<T>, error taxonomy,
│                             permission catalog, taxonomy keys. Pure, no I/O.
├── modules/                  Bounded domain modules (§7). Each: domain/ (pure rules) · application/ (use cases)
│   ├── tenancy/              · persistence/ (repositories, owned tables) · public API (index)
│   ├── connections/  capability/  coverage/  ingestion/
│   ├── content/  conversations/  interactions/
│   ├── classification/  topics/
│   ├── workflow/  brand-context/  saved-replies/
│   ├── moderation/  automation/  replies/
│   ├── aggregation/  insights/  recommendations/  reports/  alerts/  attention/
│   └── audit/
├── mutations/                Platform Mutation Executor: guard chain, intent lifecycle, outcome handlers
├── integrations/
│   └── providers/
│       ├── contract/         adapter ports + normalized DTOs + provider error classes (no SDK types)
│       ├── meta/             Facebook + Instagram (+ ads) adapter implementation
│       ├── tiktok/           TikTok (+ ads) adapter implementation
│       └── simulator/        in-memory/fixture-backed provider for local dev and tests
├── ai/
│   ├── gateway/              routing, validation, retries, ledger, cost, kill switches
│   ├── providers/            vendor adapters (Anthropic first)
│   └── tasks/                task definitions: input builder, prompt template ref, output schema, version
├── jobs/                     Trigger.dev task definitions (thin: load context → call application service)
│   ├── integration/  intelligence/  mutations/  schedules/
├── platform/                 Cross-cutting infrastructure
│   ├── db/                   connection, tenant-scoped transaction helper, system-scope helper
│   ├── auth/                 Supabase Auth wrapper, session validation
│   ├── permissions/          role → permission mapping, grant checks
│   ├── outbox/  realtime/  storage/  crypto/ (envelope encryption)  flags/  observability/  analytics/
├── db/
│   ├── schema/               Drizzle schema definitions (per module ownership)
│   ├── migrations/           version-controlled SQL migrations (incl. RLS policies, grants)
│   └── seeds/                deterministic synthetic seed data
├── prompts/                  versioned prompt templates (reviewed like code)
├── fixtures/                 sanitized provider fixtures, AI stub fixtures, eval datasets (synthetic or approved)
└── tests/                    unit · invariants · db/rls · jobs · contracts · ai-structured · ai-eval · e2e · security
```

### 6.3 Dependency direction

```
   app/, ui/  ──▶  server/  ──▶  modules/*/application  ──▶  modules/*/domain  ──▶  domain/ (shared kernel)
                     │                    │
                     │                    ├──▶ ports (interfaces) ◀── implemented by ── platform/db, integrations/, ai/
                     │                    │
   jobs/  ───────────┘                    └──▶ mutations/ (request API only; execution API is jobs-only)

   integrations/providers/{meta,tiktok}  ──▶  integrations/providers/contract  ──▶  domain/
   ai/providers/*                        ──▶  ai/gateway (ports)               ──▶  domain/
```

Rules:

1. **`domain/` and `modules/*/domain` are pure.** No I/O, no framework, no provider or AI SDK, no database client.
2. **Business logic never imports provider SDKs or response types.** Only `integrations/providers/{platform}` may import them; they translate into contract DTOs.
3. **Only `mutations/` may obtain a provider mutation port.** Adapters expose two ports: a read port (ingestion, reconciliation) and a mutation port (executor only).
4. **`ai/` cannot import `mutations/`, `integrations/` or any repository that writes source facts or decisions.** AI returns data to its caller.
5. **`app/` and `ui/` cannot import `platform/db`, `integrations/`, `ai/providers` or `mutations/`.**
6. **Modules don't read or write another module's tables.** They call the owning module's public API or a published read model.
7. **`jobs/` contain no business logic.** They resolve the job's tenant context and call an application service.

### 6.4 Enforcement

- Dependency rules encoded in a boundary linter (e.g., dependency-cruiser or ESLint boundaries) and run in CI as a blocking check.
- Type-level restrictions for safety-critical shapes (§25.5, §26.3).
- Schema introspection tests for tenant scoping (§54).

### 6.5 When to split

Move to a multi-package monorepo (e.g., `apps/web`, `apps/jobs`, `packages/domain`) only if build times, independent release cadence, or team ownership make the single package painful. Extract a separate service only for a component with a distinct scaling, security or ownership profile (§59).

---

## 7. Domain module boundaries

### 7.1 Module catalog

| Module | Owns (Model concepts) | Key responsibilities |
|---|---|---|
| **tenancy** | User link, Organization, Workspace, Workspace Membership, Role, permission grants, Brand/Market labels, Workspace Operating Mode, default escalation contact, business hours | Membership and role resolution; mode changes with history (and the IA-16 transition effects, triggered via events); org/workspace lifecycle. |
| **audit** | Audit Event | Append-only accountability ledger, written in the same transaction as the change it records. |
| **connections** | Connection, Connected Account, Social Asset registry, credential references, connection health | OAuth flows, asset discovery and selection, M-01 uniqueness (§8), health state machine (Model §53-D), token lifecycle (§39). |
| **capability** | Platform capability catalog, Capability Profile | Capability evaluation (§16). |
| **coverage** | Coverage Record | Coverage intervals and evaluation (§17). |
| **ingestion** | Provider event inbox, sync cursors, backfill checkpoints | Receive → verify → normalize → dedupe → hand to owning modules (§14). |
| **content** | Content Item, Content Source Classification (with history), Campaign, Ad Group, Ad | Content and paid-context normalization; effective source. |
| **conversations** | Conversation (identity and membership), private-reply history markers (record only) | Thread assembly; anchor; needs-handling summary. |
| **interactions** | Interaction, Source Text Version, Author, Author Block State, observed platform state | Source-fact persistence (append-only text versions); own-brand authorship detection. |
| **classification** | Classification Assessment, Accepted Interpretation, Language Assessment, Protection Evaluation, Display Translation | Precedence (M-05), protection (M-07), reassessment. |
| **topics** | Topic (workspace instances), system topic catalog reference, Topic Assignment | Assignment, merge/split readiness (M-08), catalog (M-10). |
| **workflow** | Workflow state, Resolution, Assignment, Priority Assessment, Escalation, Internal Note, Workflow Event | Open/Done rules, auto-done, auto-reopen, escalation, priority computation. |
| **brand-context** | Brand Context sections and items, verification, currency | Verified grounding set for reply tasks; gap signals. |
| **saved-replies** | Saved Reply and language versions | Library lifecycle; use recording. |
| **moderation** | Moderation State, Moderation Event | Human hide/unhide/delete/block requests (via executor), bulk hide with protection exclusion, state history. |
| **automation** | Moderation Policy, Policy Preview, Automation Decision, kill switch state | The single automation evaluator (preview and live modes), policy state machine incl. Suspended/Paused (IA-16). |
| **replies** | Suggested Reply, Outbound Reply | Suggestion generation records, public/private outbound lifecycle, brand-interaction linking (§27). |
| **aggregation** | Interaction analytics projection, Aggregate snapshots, Statistical State | Coverage-aware measures (§30). |
| **insights** | Observation, Evidence, Insight (+ versions), Driver Hypothesis, Implication | Detection, drafting, lineage, versions (§31). |
| **recommendations** | Recommendation, Tracked Action, Follow-up | Decisions (IA-09), M-12, descriptive follow-ups (§32). |
| **reports** | Report, Report Generation, guest rendering | Assembly from existing intelligence (§33). |
| **alerts** | Alert | Detectors and recipient routing (§38 in Model; §34 here for delivery). |
| **attention** | Workspace Attention Signal | Minimal cross-workspace read model (§50). |
| **mutations** (top-level) | Mutation Intent, mutation outcome records | The executor (§26). |

### 7.2 Allowed dependencies (layering)

Modules may depend only on modules in **lower** layers, through their public APIs. Same-layer modules communicate through domain events, not imports.

```
 L7  reports · alerts · attention
 L6  insights · recommendations                     (recommendations → insights allowed: lower sublayer)
 L5  aggregation
 L4  moderation · automation · replies              ──request──▶ mutations (executor request API)
 L3½ mutations (executor; defines guard ports that L4 modules implement, never imports L4)
 L3  workflow · brand-context · saved-replies
 L2  classification · topics
 L1  content · conversations · interactions  →  ingestion
 L0  tenancy · audit · flags  →  capability · coverage  →  connections   (+ shared kernel domain/)
```

An arrow inside a layer marks an allowed sub-layer direction (e.g., ingestion may call content, conversations and interactions; connections may call capability and coverage). Everything else inside a layer communicates through events.

| From | May depend on | Must not depend on |
|---|---|---|
| ingestion | tenancy, connections, capability, coverage, content, conversations, interactions (writes via their APIs) | classification, workflow, automation, mutations |
| classification | interactions, conversations, content (read), tenancy, ai gateway port | automation, moderation, mutations, workflow |
| workflow | conversations, interactions, classification (read accepted interpretation), tenancy, audit | mutations (workflow never changes platforms) |
| automation | classification, interactions, capability, connections (health), tenancy (mode), coverage (preview window), mutations (request API), audit | ai gateway (automation is deterministic), replies |
| moderation | interactions, classification (protection for bulk exclusion), capability, tenancy, mutations (request API), audit | ai gateway |
| replies | interactions, conversations, brand-context, saved-replies, classification (read), ai gateway port, mutations (request API) | automation |
| mutations | tenancy, capability, connections, classification (protection read), audit, provider mutation port, and its own guard ports (e.g., an automation-eligibility re-check port **implemented by** automation and injected at composition) | automation, moderation or replies as imports; ai gateway; ui |
| aggregation | interactions, classification, topics, content, coverage, workflow (read) | ai gateway (numbers are computed, not generated) |
| insights | aggregation, coverage, interactions (evidence), content, ai gateway port | mutations |
| recommendations | insights, aggregation, coverage, tenancy | mutations |
| reports | insights, recommendations, aggregation, coverage | interactions (except through guest-safe evidence from insights) |
| attention | workflow, classification, connections, tenancy (reads, per workspace) | any cross-workspace content query |

### 7.3 Breaking cycles

- **Executor outcomes:** moderation and replies request mutations; the executor reports outcomes as domain events (`HideConfirmed`, `ReplyConfirmed`, `MutationFailed`, `MutationOutcomeUnknown`). Moderation, replies and workflow subscribe. The executor never imports them.
- **Mode changes:** tenancy emits `WorkspaceModeChanged`; automation reacts (Suspend on entering Monitor-only; Suspended → Paused on leaving, IA-16). Tenancy never imports automation.
- **Corrections:** classification emits `AcceptedInterpretationChanged`; workflow (priority, views), automation (future evaluations only, never triggering), aggregation (dirty marks) and moderation (unhide prompt, UX §16.2) subscribe.
- In-process events are dispatched within the transaction for synchronous consistency where required (§48); events needing async work are written to the outbox.

---

## 8. M-01 — Social Asset uniqueness

> **PRODUCT OWNER: CONFIRMED (Phase 0E.1) — M-01.** Recorded as PD D-50 and Model v1.1 §5 / §54. The analysis below is the Phase 0E basis for the decision. The ad-account exception (§8.4) stays **VALIDATE** (TA-Q-02).

### 8.1 Question

Can the same Social Asset (a Facebook Page, Instagram professional account, TikTok account or ad account) be actively connected to more than one Workspace?

### 8.2 Analysis

| Concern | Same asset active in two workspaces of the **same organization** | Same asset active in workspaces of **different organizations** |
|---|---|---|
| Duplicate ingestion | Every comment stored twice, classified twice (double AI cost), counted in two workspaces' intelligence. | Unavoidable if both customers legitimately connect it; each workspace keeps its own isolated copy. |
| Duplicate replies | Two teams in one organization can reply to the same comment without seeing each other's work (concurrent-handling protection, UX §8.6, only works within one workspace). | Possible; outside our control, as with any other tool the brand uses. |
| Conflicting automation | Two policy sets on one asset: one workspace hides what another would keep; Undo in one is invisible in the other. | Possible; each organization's automation is its own decision. Hide/unhide are state-setting, so conflicts surface as observed native changes (Model §18). |
| Workflow | Two independent Open/Done states for one conversation, contradictory reporting inside one customer. | Separate customers; separate workflow is correct. |
| Agency / business scenarios | An agency serving one client from two workspaces, or a company splitting one page across markets, is better modeled as one workspace with labels (PD C-11). | Agency A and Agency B (or agency and client) both connecting the client's page is a real and legitimate scenario. |
| Authorization ownership (D-48) | One authoritative connection per asset keeps "who owns the authorization" unambiguous within a customer. | Each organization holds its own authorization; tokens are never shared across organizations. |
| Reassignment between workspaces | Needs an explicit, audited move operation. | Not applicable (no cross-organization transfer in the MVP; ownership transfer is a future decision, PD §18.3). |
| Disconnected / inactive history | Historical data stays with the workspace that collected it (workspace-owned, D-48). | Same. |
| Tenant isolation | Isolation holds either way, because data is always workspace-scoped. | Isolation holds; the only cross-tenant artifact is an internal routing registry (§8.5). |

### 8.3 Decision (confirmed)

> **PRODUCT OWNER: CONFIRMED (Phase 0E.1)**
>
> 1. **Within one Organization, a content-bearing Social Asset (Facebook Page, Instagram professional/business account, TikTok account/profile, or an equivalent content-bearing identity) can be active in at most one Workspace at a time.** This prevents duplicate ingestion, double AI processing and cost, conflicting Inbox workflow, duplicate replies and conflicting automation, and keeps one operational owner inside one customer organization. Enforced by a database uniqueness rule over (organization, platform, provider asset identity) for **active** Connected Accounts, and checked in the connect flow with a clear message ("This Instagram account is already connected to *Brand A · Chile*. Move it here instead?").
> 2. **Across Organizations, the same asset may be connected independently.** Each organization owns its own Connection; credentials are never shared; data, workflow, automation and intelligence are fully isolated. One organization must never learn that another organization connected the same asset.
> 3. **Moving an active content-bearing asset between workspaces of the same organization** is an explicit, audited **Move** operation requiring Owner/Admin authorization (technically: Owner or Admin in both workspaces): the Connected Account is deactivated in the source workspace (its history, intelligence and coverage stay there, with coverage ending at the move time) and activated in the target workspace with a fresh import. Historical conversation and intelligence data is **not** copied automatically.
> 4. **Inactive (disconnected or removed) Connected Accounts don't block later use elsewhere.** Their history remains in the original workspace, subject to retention policy (PD OQ-21, OQ-13).
> 5. **Ad accounts are a special case** (§8.4): intended behavior recorded, platform feasibility **VALIDATE** (TA-Q-02).

### 8.4 Ad accounts (intended behavior recorded; VALIDATE)

Agencies sometimes run ads for several clients from one ad account, and an ad account may relate to pages in several workspaces. A strict "one workspace per ad account" rule would block that.

**Intended behavior (recorded in Phase 0E.1; not fully confirmed because platform feasibility is VALIDATE):**

- The uniqueness rule applies to **content-bearing assets**. An **ad account** MAY be usable as a **paid-context source by several workspaces of one organization**, **if** the platform APIs allow it safely.
- An ad account **does not determine the workspace boundary** by itself. Paid content is ultimately scoped through the relevant **content-bearing identity/asset** (ad → identity it runs as → that asset's workspace). Ads for assets not active in a workspace are ignored by it.
- No ad-account link may expose conversations or intelligence from another workspace, unrelated client content, or provider credentials belonging to another workspace. Each workspace uses its own Connection's credentials (§39).
- **TA-Q-02 stays VALIDATE** until official platform behavior (ad ↔ identity linkage, permissions, paid-comment access; PD A-02, OQ-18) is verified.

### 8.5 Architectural consequences

- **Asset routing registry (system scope):** a non-tenant table mapping provider asset identity → active Connected Accounts (possibly in several organizations). Used only by the ingestion router to fan out one webhook event to every subscribed workspace, and by subscription management (unsubscribe a webhook only when no active Connected Account references the asset). It contains identifiers only, no content, and only the system role can read it (§11.2, §11.3).
- **Per-workspace processing:** after routing, each workspace processes its copy independently under its own tenant context.
- **Our own replies across organizations:** a reply sent by organization B appears to organization A as a native brand reply ("Replied on platform"), which is accurate from A's perspective.
- **PD OQ-13** (agency offboarding/handover) and **UX-03** remain open; the Move operation is the only transfer mechanism proposed for the MVP.

---

## 9. Multi-tenancy architecture

### 9.1 Access boundaries

```
User (identity, Supabase Auth)
  │
  ├── Organization Membership (organization-level role for organization settings, e.g., Owner or Admin;
  │                            other people simply belong to the organization)
  │       └── Organization  ── plan & billing, organization settings, workspace list
  │
  └── Workspace Membership (role per workspace: Owner, Admin, Manager, Responder, Analyst/Viewer, Client guest
  │                         + optional grants, e.g., delete/block for a Responder)
          └── Workspace  ── PRIMARY BOUNDARY: every conversation-derived row, interpretation,
                             intelligence object and configuration belongs to exactly one workspace
```

- **Shared multi-tenant database.** Every tenant-scoped row carries its **workspace** (and, for convenience in policies and retention, its organization). Organization-level rows carry the organization.
- **Membership is the only source of access.** Roles and grants are read from membership rows at request time. They are never trusted from client input or long-lived token claims.
- **Workspace mode** (Standard / Monitor-only) is a workspace attribute read with strong consistency by the action pipeline and the mutation executor (§48).

### 9.2 Enforcement by layer

| Layer | Enforcement |
|---|---|
| **Database** | RLS on every tenant table (§11). Composite uniqueness and foreign keys always include the workspace, so a row in workspace A can't reference a row in workspace B. Append-only history tables have no update/delete grants. Credentials live in a schema with no grants to user-facing roles. |
| **Application layer** | The action pipeline resolves the tenant context from the authenticated session and the route's workspace identifier, verifies membership, and opens a **tenant-scoped transaction** (RLS context applied). Commands and queries receive the context object; they can't construct one themselves. Cross-tenant lookups return **not found**, never "forbidden", to avoid leaking existence. |
| **Jobs** | Every job payload names exactly one workspace (except explicitly system-scoped jobs). The job wrapper opens a **workspace-scoped job context** (§11.3); without it, queries return nothing. Fan-out jobs (e.g., "refresh every workspace's attention signal") enumerate workspace IDs in system scope and enqueue **one job per workspace**. |
| **Storage** | Object paths are prefixed by organization and workspace; storage policies check membership; downloads use short-lived signed URLs generated after an authorization check (§37). |
| **Cache** | No shared external cache (§35). Framework-level caching is disabled for tenant data, or keyed by workspace and user where used. |
| **Provider integrations** | Credentials belong to a Connection owned by one workspace. Webhook events are routed to Connected Accounts through the system routing registry, then processed per workspace (§8.5, §14). A provider call is always made with the credential of the workspace whose job is running. |
| **AI processing** | Every AI call carries one workspace's data only. Batched requests never mix workspaces. Prompt caches are keyed by workspace-scoped content (e.g., that workspace's Brand Context version). No cross-workspace retrieval exists (§29). |
| **Observability / logging** | Logs carry workspace and organization **identifiers**, never names or content. Error reports scrub payloads. Support tooling reads through the same authorization model with audited, time-boxed operator access (§38.9). |

### 9.3 Tenant-scoped transaction helper

All application data access goes through one of three helpers in `platform/db` (names illustrative):

| Helper | Who uses it | What it does |
|---|---|---|
| **User scope** | Web requests | Connects as the dedicated **web login role** (R1). Inside one transaction: `SET LOCAL ROLE` to the fixed user role (R3), transaction-local identity claims from the server-verified token so RLS sees the real user (`auth.uid()`), then binds the resolved workspace with the sealed context function (R2). RLS evaluates the user's memberships and the bound workspace. |
| **Workspace job scope** | Workers | Connects as the dedicated **worker login role**; inside one transaction, `SET LOCAL ROLE` to the restricted worker role and binds the job's workspace with the sealed context function. RLS for the worker role admits only rows of that workspace; rebinding inside the transaction is refused. |
| **System scope** | A short list of named system jobs (routing, scheduling fan-out, outbox relay, sweepers, health enumeration) | Connects as the dedicated **system login role**; inside one transaction, `SET LOCAL ROLE` to the system role, which can read only system tables (routing registry, schedules, outbox metadata, intent status) and **no tenant content**. Every system-scope entry point is named, reviewed and audited. |

There is **no** generic "service role" helper in application or job code. Neither the Supabase service role nor the `postgres` role (both bypass RLS on Supabase) is used by the web or job runtime: they are reserved for migrations and audited break-glass operations, and their credentials aren't present in the web or job runtime environments (§11.5). The exact mechanism is the validated pattern in §11.6.

### 9.4 Organization-level access

The **All workspaces** page reads only **Workspace Attention Signal** rows (§50), filtered by RLS to workspaces where the user holds a non-guest membership. Organization settings, members and billing are organization-scoped rows readable by organization roles. There is no query path from organization level into conversation tables.

---

## 10. Authentication and authorization

### 10.1 Separation

| Concern | Owner | Notes |
|---|---|---|
| **Authentication** (who are you?) | Supabase Auth | Sign-in, sessions, password reset, email verification, MFA. |
| **Authorization** (what may you do here?) | Application (`platform/permissions`, tenancy module) + RLS | Memberships, roles, grants, workspace mode, capability. |

### 10.2 Sign-in and identity

- Email + password or magic link; Google sign-in optional (recommended). Email verification required before accessing any organization.
- **MFA:** the architecture must support MFA for all users. Mandatory MFA for Owner/Admin is a **security recommendation, not a confirmed MVP requirement**; it is decided before production (**TA-Q-10, OPEN**).
- Sessions use secure, HTTP-only, SameSite cookies managed with server-side rendering support. **Every server request re-validates the session** with the auth service; decoded-but-unverified tokens are never trusted.
- **Invitations:** organization and workspace invitations are single-use, expiring tokens delivered by email (TA-34). Accepting an invitation creates the membership with the role chosen by the inviter.
- **Removal:** removing a membership takes effect on the next request (membership is read live). Removal never deletes connections the person authorized (D-48); it is recorded in audit.

### 10.3 Roles and permissions

Roles follow the PD §11.3 set (PD: PROPOSED) and the IA §18 matrix (permission rules confirmed per IA §18 / IA-09). Permissions are **named capabilities in a single catalog** in code; roles map to permission sets in one place.

| Permission (illustrative keys) | Owner | Admin | Manager | Responder | Analyst/Viewer | Client guest |
|---|---|---|---|---|---|---|
| `workspace.read_operational` (Home, Inbox, Content & Ads) | ✓ | ✓ | ✓ | ✓ | ✓ (read) | — |
| `intelligence.read` (Insights, VoC, topics, recommendations) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (guest projection only) |
| `reports.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (guest rendering only) |
| `reply.public`, `reply.private` | ✓ | ✓ | ✓ | ✓ | — | — |
| `moderate.hide_unhide` (incl. undo automatic hides) | ✓ | ✓ | ✓ | ✓ | — | — |
| `moderate.delete`, `moderate.block` | ✓ | ✓ | ✓ | grant only | — | — |
| `workflow.internal` (assign, escalate, mark done, notes, correct labels) | ✓ | ✓ | ✓ | ✓ | — | — |
| `automation.configure` (rules, previews, pause all) | ✓ | ✓ | ✓ | — | — | — |
| `recommendations.decide` (accept, dismiss, mark done) | ✓ | ✓ | ✓ | — | — | — |
| `responding.manage` (Brand Context, saved replies) | ✓ | ✓ | ✓ | per PD OQ-23 | — | — |
| `escalation.default_contact.set` | ✓ | ✓ | ✓ | — | — | — |
| `connections.manage` | ✓ | ✓ | — | — | — | — |
| `members.manage` (workspace) | ✓ | ✓ | — | — | — | — |
| `workspace.mode.change` | ✓ | ✓ | — | — | — | — |
| `organization.manage` (workspaces, org members) | ✓ | ✓ | — | — | — | — |
| `billing.manage` | ✓ | — | — | — | — | — |
| `attention.read` (All workspaces) | ✓ | ✓ | ✓ | ✓ | ✓ | — |

Saved-reply governance (PD OQ-23) is a configurable mapping, not a structural change (IA §14).

### 10.4 Service and background identities

| Identity | Used by | Database role | Can |
|---|---|---|---|
| **User** | Web requests | Web login role → `authenticated` (fixed `SET LOCAL ROLE`), real `auth.uid()` from transaction-local claims; RLS by membership and bound workspace | What the user's memberships allow. |
| **Workspace worker** | Jobs processing one workspace | Worker login role → restricted worker role (RLS by sealed job workspace context) | Read/write that workspace's rows needed by the job's module. |
| **System worker** | Routing, fan-out, outbox relay, sweepers | System login role → system role | Read/write system tables only (no tenant content). |
| **Integration credential access** | Integration workers and the executor | Credential-access function, called inside a workspace job scope | Decrypt one workspace's provider credential for the duration of a provider call (§39). |
| **Migration / break-glass** | CI migrations; audited emergencies | Migration role (on Supabase, `postgres`, which bypasses RLS) or the service role for audited emergencies | Everything. Credentials not available to application or job runtimes; never used for runtime connections (R1). |

Runtime login roles are `LOGIN NOINHERIT NOBYPASSRLS`, are members of exactly one runtime role, and can't `SET ROLE` to `postgres`, `service_role`, `supabase_admin`, `authenticator`, `anon`, the owner or each other (validated in TA-Q-29). They are long-lived; credential rotation follows §11.7 (R8).

Every job run records its **initiator**: a user (for user-requested mutations, the original command's user and request ID), a policy (automation), or the system (sync, refresh). That initiator flows into audit (§41).

### 10.5 Authoritative permission checks

| Action | Checked where (all server-side) |
|---|---|
| **Read** (any surface) | Action pipeline (membership + `*.read` permission) **and** RLS. Client guests additionally restricted to guest projections (§49). |
| **Reply** (public/private) | Command (`reply.*`), mode check, availability resolver; intent creation guard; executor re-check at execution. |
| **Moderate** (hide/unhide/delete/block) | Same as reply, plus action-specific guards: delete/block require a human actor and `moderate.delete`/`moderate.block`; bulk hide is hide-only with protection exclusion (§26.5). |
| **Configure automation** | Command (`automation.configure`), mode (activation impossible while Monitor-only), preview freshness guard for malicious-link and pattern policies (§25.6). |
| **Change workspace mode** | Command (`workspace.mode.change`) in a transaction that also suspends or pauses policies (IA-16) and records history. |
| **Manage members** | Command (`members.manage`); role escalation rules (nobody grants a role above their own; only Owners grant Owner). |
| **Recommendations** | Command (`recommendations.decide`) for accept, dismiss, mark done, reopen (IA-09); M-12 database constraint. |
| **Reports** | Query (`reports.read`); guests receive the guest rendering only. |
| **Connection management** | Command (`connections.manage`); OAuth `state` bound to user and workspace; M-01 uniqueness check (§8). |

Frontend hiding (IA §18 rule 1) is presentation only. Every one of these checks is repeated on the server.

### 10.6 The action pipeline

Every consequential command passes through one pipeline in `server/pipeline`:

```
request
  │
  ├─ 1. Authenticate         validate session with auth service → user identity
  ├─ 2. Resolve tenant       workspace from route → membership (live) → role, grants, workspace mode
  ├─ 3. Authorize            permission catalog check for this command
  ├─ 4. Validate input       schema validation; reject unknown fields
  ├─ 5. Availability guard   (platform actions only) role → mode → capability → connection (§16.6)
  ├─ 6. Execute              inside a tenant-scoped transaction; optimistic concurrency where relevant
  ├─ 7. Record               domain history + audit event in the same transaction
  ├─ 8. Emit                 in-transaction domain events; outbox rows for async work
  └─ 9. Respond              typed result or normalized error (§44); post-commit outbox dispatch
```

A command handler can't skip steps: handlers are registered with the pipeline and receive only the context it produces. Integration tests assert that every exported command is pipeline-registered (§54).

---

## 11. Row-level security strategy

No SQL is written in this phase. This section defines the policy model that later migrations implement.

### 11.1 Principles

1. **RLS is enabled and forced on every table that holds tenant data**, with no exceptions (R4). A schema test fails CI if a table is created without RLS or without a classification (tenant, organization, system, reference) (§54).
2. **Deny by default.** A table without a matching policy is unreadable.
3. **Policies check membership through a small set of reviewed helper functions** (e.g., "is the current principal a non-guest member of this workspace?", "is the current principal's role in this workspace at least X?"). Helpers are security-definer (empty `search_path`), stable, indexed and tested; where a helper reads a table with forced RLS, an explicit owner/definer policy admits it (R4).
4. **RLS enforces visibility and tenant scope.** Fine-grained action permissions (e.g., who may reply) are enforced in the application layer and the executor; RLS adds backstops where a rule is simple and critical (e.g., guests can't read operational tables; mutation intents can't be inserted for a Monitor-only workspace).
5. **RLS is defense in depth, not the only authorization layer (LOCKED, Phase 0E.1).** Every request and job follows: request/job identity → tenant context → application authorization → RLS → domain invariants. Business permissions are **not** moved solely into RLS, and tenant isolation does **not** rely solely on application `WHERE` clauses. Both layers are mandatory.
6. **References between tenant tables are workspace-scoped** (R5): foreign keys are composite (workspace + identifier), so a reference to another workspace's row fails exactly like a reference to a non-existent row (no existence oracle).
7. **Objects, grants and policies are explicit** (R4): product tables live in explicit schemas with explicit grants; Supabase default privileges are never relied on; policies that call `auth.uid()` are created by a role with `auth` schema access; introspection tests verify all of it (§54, §64).

### 11.2 Policy families

| Data | Policy family |
|---|---|
| **Workspace-scoped operational rows** (conversations, interactions, assessments, workflow, moderation, notes, replies, policies, Brand Context, saved replies, audit, mutation intents) | Readable and writable only by **non-guest** members of that workspace (writes further limited by role where simple), or by the worker role when the job tenant context equals that workspace. |
| **Workspace-scoped intelligence rows** (aggregate snapshots, observations, insights, drivers, recommendations, reports) | Same as above for non-guest members. **Client guests can't read these base tables.** |
| **Guest projections** (guest insight views, guest evidence items, guest report renderings, guest recommendation views, guest topic views) | Readable by any member of the workspace including Client guests; writable only by the worker role (projection jobs). |
| **Organization-scoped rows** (organization, organization memberships, workspace list, billing) | Organization members by role; billing rows Owner only. |
| **Memberships** | A user reads their own memberships; workspace Admins/Owners read and manage memberships of their workspace; nobody reads memberships of workspaces they don't belong to. |
| **Workspace Attention Signals** | Readable by non-guest members of that workspace (which is exactly what All workspaces needs, row by row); writable only by the worker role. |
| **System tables** (asset routing registry, outbox metadata, schedules, provider app-level budgets) | No user access. System role only. |
| **Credentials** | No RLS read grant to any user or worker role; accessible only through the credential-access function (§39). |
| **Reference data** (platform capability catalog version, taxonomy keys) | Read-only to authenticated principals; changed only by migrations. |
| **Append-only history** (assessments, moderation/workflow events, automation decisions, audit, AI call ledger, source text versions) | Insert allowed per the families above; **no update or delete grants** for any runtime role. Retention deletion runs through a dedicated, audited retention role (§61). |

### 11.3 Workers and service jobs

- Workers connect with a dedicated **worker login role** and switch, per transaction and by fixed literal, to the **restricted worker role**; neither bypasses RLS (R1, R3).
- The job wrapper binds the job's workspace for the transaction with the sealed context function (R2); a second binding in the same transaction is refused. Worker policies admit rows where the row's workspace equals that context. **If the context is missing, every policy evaluates false** and the job reads nothing: a forgotten scope produces an obvious failure, never a leak.
- System jobs use the **system role**, whose grants cover only system tables. A system job that needs tenant data must enqueue per-workspace jobs instead.

### 11.4 Cross-workspace attention

The organization page queries the attention-signal table for "my workspaces". RLS returns only rows for workspaces where the user is a non-guest member. The signal rows contain only the allowed fields (§50). No policy grants organization-level principals access to workspace content tables.

### 11.5 Privileged processes that could bypass isolation

| Process | Mitigation |
|---|---|
| Migrations | Run by CI with the migration role (on Supabase, `postgres` acting as a member of the owner role, so policies that call `auth.uid()` can be created, R4); reviewed; never at application runtime. Never drop or recreate pooled runtime roles (R8, §11.7). |
| Break-glass operator access | Separate credential held outside runtime environments; access is time-boxed, requires a reason and is recorded in an operator audit log. |
| Retention / deletion jobs | Dedicated retention role with delete rights on specific tables only, invoked per workspace or organization with an audited request (§61). |
| Webhook receiver | Writes only to the provider event inbox (system-scoped insert, no reads of tenant data). |
| Outbox relay and sweepers | System role: outbox and intent **metadata** only (IDs, status, timestamps). |

The service-role key and the migration (`postgres`) credentials are **not configured** in the web or job runtime environments (LOCKED; validated in TA-Q-29). A CI check scans runtime environment definitions for them (§64).

### 11.6 Validated RLS context pattern — TA-Q-29 (PASS)

**TA-Q-29 — Direct Postgres RLS context under Supabase Auth + Drizzle + pooled connections.** Classification: **SECURITY VALIDATION · PASS.** Phase 0E.2 (local): 29/29 on PostgreSQL. Phase 0E.2b (managed): run of record **22/22** on a Supabase development project with real Supabase Auth tokens (JWKS, ES256), Supavisor transaction mode and Drizzle over node-postgres. Evidence and the full run history: `docs/pre-implementation-validation-v1.md` §6–§9 and §22–§24; managed evidence of record `spikes/ta-q-29-rls/evidence/ta-q-29-managed-2026-10-04T14-32-40-076Z.txt`. TA-Q-29 **no longer blocks** the tenancy/database foundation. The spike code is disposable and isn't the implementation; no production SQL is written here.

**Validated pattern.** Web and workers use the same pattern; only the login role, the target role and the identity source differ.

```
WEB REQUEST                                     WORKSPACE JOB                          SYSTEM JOB
1. verify the access token server-side          1. payload: workspace ID + entity      1. named system task only
   (JWKS / getClaims); the token's role claim      IDs (from the outbox)
   is only allowlist-checked (R3)
2. connect as the web login role (R1)           2. connect as the worker login role    2. connect as the system login role
3. BEGIN                                        3. BEGIN                               3. BEGIN
4. SET LOCAL ROLE authenticated (fixed literal) 4. SET LOCAL ROLE <worker role>        4. SET LOCAL ROLE <system role>
5. transaction-local claims (request.jwt.claims,
   request.jwt.claim.sub) → the real auth.uid()
6. bind the workspace: sealed, transaction-     5. bind the workspace (sealed)
   bound, refuses rebinding (R2)
7. queries (Drizzle) under forced RLS (R4)      6. queries under forced RLS            5. system tables only
8. COMMIT / ROLLBACK → role, claims, workspace and seal vanish; the pooled connection returns clean
```

**Rules adopted from the validation (LOCKED in v1.1):**

| Rule | Requirement | Validated evidence (Phase 0E.2b) |
|---|---|---|
| **R1** Dedicated runtime login roles | One `LOGIN NOINHERIT NOBYPASSRLS` login role per runtime (web, worker, system), each a member of exactly one fixed runtime role and able to `SET ROLE` only to it. Runtimes never connect as `postgres` (which bypasses RLS on Supabase), `supabase_admin`, `authenticator` or `service_role`. No service-role key or migration credential in any runtime environment. | Every runtime login was denied `SET ROLE` to `service_role`, `postgres`, `supabase_admin`, `authenticator`, `anon`, the owner and the other runtime roles (`42501`). The runtime environment held no secret key, service-role key or bootstrap URL. |
| **R2** Sealed, transaction-bound workspace context | The workspace is bound once per transaction by a reviewed `SECURITY DEFINER` function that stores transaction-local values plus a seal derived from a server-only secret, the transaction ID and the session user. The current-workspace function returns NULL when the seal doesn't match, so stale, replayed, raw `set_config` or session-level values grant nothing. Rebinding inside a transaction is refused. Nothing relies on session-level state (`SET` without `LOCAL`, session settings, named prepared statements). | Under Supavisor, deliberately buggy session-level state **did** reach other clients' transactions (15 of 60); the seal leaked **0 rows**. Rebind → `42501`; raw `set_config` and a replayed seal → 0 rows. |
| **R3** Fixed-literal role switch | `SET LOCAL ROLE` uses a fixed literal chosen by the scope helper, never a value from a token or input. Token role claims are only checked against an allowlist (`authenticated`). | Escalation attempts denied; the role was never derived from the token. |
| **R4** Forced RLS, explicit policies and grants | RLS **enabled and forced** on every tenant table; helpers read through explicit owner/definer policies. Policies that call `auth.uid()` are created by a role with `auth` schema access (the migration role acting as a member of the owner role), because a custom owner role lacks it. Product objects are created in explicit schemas with explicit grants; Supabase default privileges (which differ by creating role) are never relied on. Introspection tests verify forced RLS, grants and the absence of unexpected privileges for `anon`, `authenticated` and runtime logins. | F-S2: the custom owner role couldn't reference `auth.uid()`. F-S5: default privileges depend on the creating role. All spike tables had RLS enabled and forced; no unexpected Data API path. |
| **R5** Workspace-scoped composite foreign keys | References between tenant tables include the workspace, so a cross-workspace reference fails with the same error as a non-existent one: no existence oracle. | `23503` identical for foreign and non-existent references. |

**Pooling.** Web and workers use the Supavisor **transaction mode** (port 6543, `<role>.<project-ref>` usernames) with unnamed statements (the Drizzle/node-postgres default); named prepared statements aren't relied on. Stress run: 300 concurrent transactions across 4 tenant contexts on 12 shared server backends, every backend serving several tenants, no foreign row. Drizzle used without a scope helper fails closed (denied or 0 rows). Runtime role lifecycle under the pooler: §11.7 (R8).

**The original 13 checks (v1.0) — all PASS.** They become permanent regression tests (T-26, §55):

| # | Check | Result |
|---|---|---|
| 1 | A server-validated Supabase Auth session maps to the intended database/user context | PASS: real tokens; `auth.uid()` = token `sub`; tampered or foreign-signed tokens rejected before any query |
| 2 | Workspace and actor context applied transaction-locally | PASS |
| 3 | Context can't survive transaction completion | PASS: 45 sequential transactions, each starting with no claims, workspace or seal |
| 4 | A reused pooled connection can't leak the previous tenant's context | PASS: shared backends served A → none → B in turn; 300-transaction stress |
| 5 | Missing workspace context returns no tenant rows | PASS: 0 rows; inserts `42501` |
| 6 | Workspace A can't read or reference Workspace B | PASS: 0 rows; writes `42501`; composite FK `23503` |
| 7 | The restricted worker role obeys RLS | PASS |
| 8 | Worker context can't escape its workspace | PASS: rebind `42501`; raw `set_config` and replayed seal → 0 rows |
| 9 | The system role reaches only explicit system tables | PASS |
| 10 | No service-role credential in the web or job runtime | PASS |
| 11 | Direct Drizzle queries can't bypass RLS | PASS |
| 12 | The selected pooling mode preserves all of the above | PASS: Supavisor transaction mode |
| 13 | Failure behavior is fail-closed | PASS |

**Still to validate (doesn't block the foundation):** the same pattern from deployed Trigger.dev workers in staging (worker login over Supavisor, egress/static IPs if required; TA-Q-31) and the Realtime authorization path (TA-Q-21).

### 11.7 Database role lifecycle under the pooler — R8 and incident F-S6

**Scope.** R8 is an **operational lifecycle principle discovered during the managed validation**; it is not part of what TA-Q-29 validates (R1–R5, §11.6). Its principles are adopted in v1.1; the production role-rotation procedure stays **VALIDATE** under TA-Q-30.

Supavisor keeps pooled server connections per `<role>.<project-ref>`. Validated findings (Phase 0E.2b): recreating a dropped role under the same name breaks pooled connections for that name (`invalid role OID`, F-S3); and twice, right after spike login roles that Supavisor was actively pooling were terminated and dropped, Supavisor refused every pooled connection for the whole development project (both pooler ports, all roles) while PostgreSQL and Auth stayed healthy (F-S6).

**R8 rules (LOCKED in v1.1 as principles; the procedure is confirmed with Supabase under TA-Q-30):**

- Runtime login roles are **long-lived**. Deployments, migrations and tests never drop or recreate a pooled runtime role name.
- Production credential rotation uses either an **in-place password rotation** of the existing role, followed by rolling the runtime secret, or a **new role name** with the old pool drained before the old role is dropped. Never drop and recreate the same name.
- A role the pooler may still be serving is dropped only after the pooler has released it, and only as a runbook step.
- The rotation procedure is written as a runbook (§65) and **confirmed with Supabase before the first production credential rotation**.
- **Production and shared managed Supavisor environments** (shared Supabase development, staging and preview projects) use **long-lived** runtime and test login roles. They **must not** routinely create → pool → drop database login roles.
- **Per-run disposable roles** are allowed only when the whole database/environment is isolated and disposable, or in local / non-Supavisor test environments. Per-run names avoid stale role-name/OID reuse (F-S3) but do **not** by themselves prevent the project-wide refusal observed in F-S6.
- In a shared Supavisor project, test roles stay long-lived unless a vendor-confirmed drain/removal procedure exists (TA-Q-30).
- A pooled role is never dropped until its pool has been drained/released according to the TA-Q-30 runbook.
- Prefer deleting a whole isolated preview environment over dropping pooled roles inside a shared project.

**Incident record F-S6 (Supabase development project).**

| Aspect | Record |
|---|---|
| What happened | After the run of record's teardown (and once before, in an earlier run), Supavisor refused all pooled connections (session and transaction pooler) for the project. PostgreSQL stayed up and Auth was healthy. The refusal persisted after a project restart; a later read-only check (`SELECT 1` only) still failed on both pooler ports. |
| Classification | **Operational pooler issue** of a development project. **Not a TA-Q-29 failure:** the run of record (22/22) completed and tore down cleanly before the refusal began, and the incident affects availability, not isolation. |
| Cause | Strongly **correlated** with dropping roles Supavisor was actively pooling (2 of 2 occurrences), but **not proven**. |
| Follow-up | Report to Supabase support **in parallel**; it doesn't gate the architecture. Its answer feeds the R8 runbook (TA-Q-30). |
| Development environment | A fresh Supabase development project may replace the affected one **without reopening TA-Q-29**; the preserved evidence of record stands. |

---

## 12. Logical persistence architecture

Mapping of Model §43 categories to persistence patterns. No tables or columns are defined here.

| Model category | Examples (Model §43) | Persistence pattern | Mutability | Notes |
|---|---|---|---|---|
| **A. External canonical / source** | Source text versions, platform timestamps, platform-reported author identity, content as published, paid context as reported, platform state observations, native brand replies and moderation | **Append-only observation records** keyed by provider identity + observed time; raw provider envelopes kept in the provider event inbox for a bounded period | Immutable; new observations are added | Written only by the ingestion module. No other module (and never AI) has a write path. |
| **B. Product-normalized canonical** | Social Asset, Connected Account, Content Item, Campaign/Ad Group/Ad, Conversation, Interaction, Author | **Canonical relational rows** with stable internal identity and unique provider identity per workspace | Identity stable; state attributes change via events | Current observed state (e.g., "removed at source") is a pointer to the latest observation. |
| **C. Derived current interpretation** | Accepted interpretations, Protection Evaluation, Priority, effective source, Capability Profile state, coverage state, Workspace Attention Signals | **Recomputable current-state rows** with as-of time and references to the inputs that produced them | Recomputed | Decisions copy the value they used (e.g., an Automation Decision stores the protection result at decision time). |
| **D. Historical assessment / event** | Classification and topic assessments, language assessments, Automation Decisions, Moderation Events, Workflow Events, Audit Events, policy previews, suggestion records | **Append-only history records** | Immutable | Database grants forbid update/delete for runtime roles (§11.2). |
| **E. Aggregated** | Aggregates, statistical states | **Recomputable projections** (interaction analytics projection) + **immutable aggregate snapshots** when referenced by an insight, follow-up or report | Projection recomputable; snapshots immutable | Every value is a Measured value with coverage (§17.5). |
| **F. Intelligence** | Observations, Evidence, Insights, Driver Hypotheses, Implications, Follow-up results, Reports | **Versioned records** (identity + immutable versions) for insights; **snapshots** for follow-up results once ready and for report generations | Evolve by new versions/snapshots | M-03 and M-04 remain open; storage supports either outcome (§31, §33). |
| **G. Human decision / action** | Outbound Replies, corrections, notes, assignments, escalations, recommendation decisions, Tracked Actions, single and bulk moderation | **Canonical rows for current state + append-only decision/event records** | State changes recorded as events | Always attributed to a user. |
| **H. Configuration** | Operating mode, Moderation Policies, Brand Context, Saved Replies, default escalation contact, roles and memberships, workspace labels, business hours | **Current-state rows + change history** (who, when, from → to); **versioned** where downstream records must reference the exact version used (policy definitions, Brand Context items used by a suggestion) | Changes audited | Policy definition versions are referenced by previews and decisions. |

**Pattern summary:**

| Pattern | Use for |
|---|---|
| Canonical relational state | B, current part of G and H |
| Append-only history | A, D, decision part of G, audit |
| Versioned records | Policy definitions, Brand Context items, insights, taxonomy and topic catalog versions |
| Recomputable derived state | C, E projections, guest projections, attention signals |
| Snapshots | Aggregate values referenced by intelligence, ready follow-ups, report generations, policy previews |

---

## 13. Current state + history pattern

### 13.1 Why not full event sourcing

Event sourcing would make "what did we believe then" natural, but it forces every read through projections, complicates RLS (projections per tenant), complicates schema evolution of events, and slows a small team. The Model needs **history for specific objects**, not replay of the whole system (Model §40: "Not an event-sourcing design"). The pragmatic pattern:

> **Each consequential change writes, in one transaction: (1) the new current state, (2) an immutable history/event record describing the transition, and (3) an audit event.**

"What is true now?" reads current state. "What did we believe or do then?" reads history records, which carry the inputs and versions used at the time.

### 13.2 Application by concern

| Concern | Current state | History | Answering "then" |
|---|---|---|---|
| **Classification corrections** | Accepted interpretation per dimension (points to winning assessment) | Every assessment (AI, rule, platform, human), immutable | Assessments valid at time T, plus the precedence rule version, reconstruct the accepted interpretation at T. Automation Decisions also store what they used. |
| **Moderation transitions** | Moderation state per interaction | Moderation Events (initiator, reason, previous/new state, link to decision or reversal) | Event sequence. |
| **Workflow transitions** | Status, resolution, assignee, escalation flag | Workflow Events (initiator incl. system auto-done/auto-reopen, linked cause) | Event sequence. |
| **Policy changes** | Policy state and current definition version | Policy state history + immutable definition versions + previews | Decisions reference the definition version and state at decision time. |
| **Connection state** | Health state, last successful contact | Health transitions; coverage intervals | Coverage gaps explain missing periods (Model §42). |
| **Source edits** (M-09 open) | Latest source text version pointer | All versions retained | Assessments reference the version they assessed. |
| **Recommendations** | Status, owner, completion date | Decision events; retired Tracked Actions retained (M-12) | Event sequence. |
| **Reports** (M-03 open) | Latest generation per period and type | All generations retained | Each generation is a frozen snapshot with as-of time. |
| **Insight versions** (M-04 open) | Current version pointer per insight identity | Immutable versions with evidence and aggregate snapshot references | Recommendations and reports reference the version they used. |
| **Workspace mode** | Mode | Mode history (who, when) | Used by audits and by IA-16 transition logic. |

### 13.3 Integrity rules

- History tables are **insert-only** for runtime roles (§11.2).
- Current-state updates and their history records are written in the **same transaction**; a test asserts that every state-changing repository method writes a history record (§54).
- History records reference versions (model, prompt, policy definition, taxonomy, Brand Context item, capability catalog) by identifier, so the past stays explainable after configuration changes.

---

## 14. Source ingestion architecture

### 14.1 Pipeline

```
 provider webhook ──┐
                    ├─▶ 1. RECEIVE & VERIFY ─▶ 2. RECORD RAW EVENT ─▶ 3. ROUTE ─▶ 4. NORMALIZE ─▶ 5. DEDUPLICATE
 polling / sync  ───┤      (signature, shape,    (provider event inbox,   (asset routing  (adapter →      (provider identity,
 backfill page   ───┤       timestamp)            idempotent key)          registry →      contract DTOs)   content hash)
 reconciliation ────┘                                                      workspaces)
                                                                                                 │
        ┌────────────────────────────────────────────────────────────────────────────────────────┘
        ▼
 6. PERSIST SOURCE FACTS (per workspace, one transaction)
      content · conversation membership · interaction · source text version · author · observed platform state
      · paid context observations · coverage extent · sync cursor/checkpoint
        │
        ├─ 7. DETERMINISTIC ENRICHMENT (same job): own-brand authorship · URL extraction · language pre-detection ·
        │     configured-pattern candidate match · native brand reply / native moderation detection
        │
        ├─ 8. IMMEDIATE OPERATIONAL UPDATE (same transaction): new Conversation → Open · native brand reply →
        │     auto-Done rule (UX-04) · new audience message in a Done conversation → "pending understanding"
        │
        └─ 9. OUTBOX ─▶ understanding job (classification, protection, priority, reopen decision, automation)
                     ─▶ realtime invalidation signal
                     ─▶ aggregation dirty marks
```

Steps 1–2 run synchronously in the webhook receiver (fast acknowledgement, §40). Steps 3–9 run in integration workers. Polling, backfill and reconciliation enter at step 3 with payloads fetched by the adapter.

### 14.2 Sources of data

| Source | Mechanism | Notes |
|---|---|---|
| **Webhook events** | Where a platform offers them for the content type and permission (VALIDATE per platform, PD OQ-18) | Treated as hints that something changed; the adapter may re-fetch the object for authoritative data. |
| **Polling / incremental sync** | Per Connected Account sync cursors and watermarks; adaptive cadence (active ads and recently active content more often) | Required wherever webhooks are absent, incomplete or unreliable. Cadence is set after API validation. |
| **Historical backfill** | Per Connected Account, sliced by time and content with checkpoints (§19.6) | Target 30 days (PD D-09); achieved extent recorded as coverage. |
| **Reconciliation** | Periodic comparison of platform state vs product state (§47) | Detects missed events, native changes, deletions, revoked connections. |

### 14.3 Object types and how they arrive

| Object | Typical arrival | Persistence |
|---|---|---|
| **Content** (posts, reels, videos, ad creatives) | Sync and backfill; on first sight of an unknown parent of an interaction | Content Item + observed state; source classification evaluated (§14.5). |
| **New comments** | Webhook (if available) or polling | Interaction + Conversation (top-level comment anchors a new Conversation). |
| **Replies** | Webhook or polling of threads | Interaction attached to its parent and Conversation. |
| **Paid context** | Ads/campaign sync for linked ad accounts (VALIDATE, PD A-02) | Campaign/Ad Group/Ad observations; Ad → Content relation; paid-context coverage per content. |
| **Native brand actions** | Brand-authored interactions observed in threads; native hide/delete observed where exposed | Brand Interaction without an Outbound Reply; Moderation Event with initiator "native platform change". |
| **Moderation changes where observable** | Observed state differences on re-fetch or provider events | New observation + Moderation Event (native). |
| **Edits** (M-09) | If platforms expose edits | New Source Text Version; reassessment queued; human corrections persist (Model §54, M-09). |
| **Removals at source** | Provider signal or confirmed absence on re-fetch | Observed state "removed at source"; never inferred from a single failed fetch (§47.3). |

### 14.4 No platform parity assumed

The ingestion pipeline is identical for every platform, but **which mechanisms exist** is per platform × content type × permission and comes from the capability catalog (§16). If a platform offers no webhook for a content type, polling covers it. If neither is possible, coverage records it as unavailable, and the UI says so (PD C-07).

### 14.5 Content source classification

Source (Organic / Paid / Mixed / Unknown) is an **interpretation with provenance** on the Content Item (Model §8.1), evaluated by deterministic rules from platform-provided signals and observed paid context, with history. Interactions read their effective source from content. M-02 (interactions predating a boost) stays open; the history of source classification with validity times makes either outcome implementable.

---

## 15. Provider adapter architecture

### 15.1 Contract

Adapters implement two ports defined in `integrations/providers/contract`. Names are conceptual.

**Read port** (ingestion, reconciliation, capability probing):

| Operation | Purpose |
|---|---|
| `discoverAssets(credential)` | List Social Assets an authorization exposes (pages, profiles, business accounts, ad accounts). |
| `describeAccount(asset)` | Account kind, permissions granted, linked ad accounts, facts needed for capability evaluation. |
| `listContent(account, window, cursor)` | Content Items in a window, paginated. |
| `listInteractions(content or account, window, cursor)` | Comments and replies, paginated. |
| `getInteraction(id)` / `getContent(id)` | Authoritative re-fetch for webhooks and reconciliation. |
| `getCurrentState(object)` | Visibility / existence as observable. |
| `retrievePaidContext(adAccount, window, cursor)` | Campaigns, ad groups, ads, ad → content links. |
| `parseWebhook(request)` | Verify signature and parse into normalized event hints. |
| `subscribe(asset)` / `unsubscribe(asset)` | Webhook subscription management where supported. |
| `refreshCredential(credential)` | Token refresh where the platform supports it. |

**Mutation port** (executor only, §26):

| Operation | Notes |
|---|---|
| `replyPublicly(target, text, idempotencyHint)` | Returns provider identity of the created reply when available. |
| `replyPrivately(target, text, idempotencyHint)` | One-shot; returns provider receipt when available. Never paired with any inbound private-message read operation. |
| `hide(target)` / `unhide(target)` | State-setting. |
| `delete(target)` | Irreversible. |
| `block(author, accountContext)` | State-setting; reversibility per platform (UX-09 deferred). |

**There is no operation to list or read private messages.** The contract deliberately has no DM read surface (S9; §27).

### 15.2 Normalized types and errors

- Adapters return **contract DTOs** (normalized content, interaction, author, paid-context, state observation, webhook hint, rate-limit signal) defined in the contract module. Provider SDK and HTTP response types never cross the adapter boundary.
- Every DTO carries the **provider identity** of the object, the **provider timestamps**, and a **raw reference** (pointer to the stored raw payload) for debugging.
- Errors are normalized into contract error classes (§44): `RateLimited(retryAfter)`, `Transient`, `PermissionMissing(capability)`, `TargetNotFound`, `TargetNotEligible`, `CredentialInvalid`, `PermanentRejected(reasonCode)`, `OutcomeUnknown` (timeouts after send).
- Adapters translate provider usage signals (e.g., usage headers where available) into normalized **rate-budget signals** consumed by the scheduler (§45).

### 15.3 Capability is not hard-coded in adapters

Adapters **implement** operations; they don't **decide** whether an operation is offered. Availability comes from the capability evaluation (§16). An adapter receiving a call for an operation that the platform doesn't support for that target returns `TargetNotEligible` as a safety net, and that outcome is fed back into the capability profile.

### 15.4 Implementations

| Adapter | Scope |
|---|---|
| **Meta** | Facebook Pages, Instagram professional accounts, Meta ad accounts (one adapter, platform-specific sub-modules). |
| **TikTok** | TikTok business accounts and TikTok ads (organic and paid behaviors validated separately). |
| **Simulator** | Fixture-backed and scenario-driven implementation of both ports for local development and tests (§52, §53). |

Provider API versions are pinned in the adapter and recorded in raw references, so deprecations are visible (§70).

---

## 16. Capability architecture

### 16.1 Three layers

```
 ┌───────────────────────────────────────────────────────────────────────────────────────────┐
 │ 1. PLATFORM CAPABILITY CATALOG  (code-versioned reference data, reviewed like code)         │
 │    platform × asset kind × content type × source × action  →  catalog state + limitation    │
 │    + validation status (validated / not validated) + evidence reference (API validation)   │
 │    Origin: official API validation (PD OQ-18). Default for anything not validated: UNKNOWN. │
 └───────────────────────────────────────────┬───────────────────────────────────────────────┘
                                             ▼
 ┌───────────────────────────────────────────────────────────────────────────────────────────┐
 │ 2. ACCOUNT CAPABILITY PROFILE  (stored per Connected Account, with as-of time and reasons)  │
 │    catalog × account facts (kind, granted permissions, ad-account linkage, app review       │
 │    status) × observed provider responses (e.g., permission errors)                          │
 │    Evaluated on connect, on permission change, on observed errors, and periodically.        │
 └───────────────────────────────────────────┬───────────────────────────────────────────────┘
                                             ▼
 ┌───────────────────────────────────────────────────────────────────────────────────────────┐
 │ 3. RUNTIME CONDITION  (connection health overlay)                                           │
 │    active → no change · degraded / disconnected / platform outage → TEMPORARILY UNAVAILABLE │
 └───────────────────────────────────────────────────────────────────────────────────────────┘
```

### 16.2 States

| State | Meaning | Treated as |
|---|---|---|
| **Supported** | Validated and available for this account and content type. | Available (subject to role and mode). |
| **Available with limitation** | Supported with a known restriction (e.g., history depth, hide semantics). | Available with caveat text. |
| **Unsupported** | Platform doesn't offer it here. | Visible but unavailable with platform reason (IA §18 rule 3). |
| **Unknown / not validated** | Not yet validated. | Unavailable for promises (PD C-07); same presentation as unsupported with "not available yet". |
| **Temporarily unavailable** | Normally supported; blocked by connection health or outage. | Blocked with recovery (IA §18 rule 4). |

### 16.3 Origin and evaluation

- **Catalog origin:** the API validation phase (PD OQ-18, OQ-19, OQ-27) produces catalog entries with evidence (documentation reference, sandbox test result). Changes ship as reviewed catalog versions.
- **Account evaluation:** the capability module evaluates per account using a **pure function** (catalog version + account facts + observations → profile), stores the result with its as-of time, reasons and catalog version.
- **Never inferred from data:** "no comments on ads" never changes a capability. Only catalog changes, account facts and explicit provider responses (e.g., a permission error) do (Model §6).

### 16.4 Versioning and as-of

Each profile records the catalog version, the account facts snapshot and the evaluation time. Mutation intents, automation decisions and coverage records reference the capability state they relied on.

### 16.5 How the frontend receives explanations

The server's **availability resolver** (§16.6) returns, for each action on each object in a view model, a small structure: visibility (hidden/visible), state (available/unavailable/blocked), reason code, localized message key with parameters (e.g., platform name), and recovery action when relevant. The UI renders it. The UI never evaluates capability, role or mode itself, so there is one implementation of the logic.

### 16.6 Availability resolver

A pure domain function used by **both** view-model builders and command guards:

```
resolveAvailability(action, actor, workspace, target):
  1. role/grant doesn't allow            → HIDDEN                      (IA §18 rule 1)
  2. workspace Monitor-only AND action is a platform mutation or platform-changing automation
                                         → UNAVAILABLE(mode)           (rule 2)
  3. capability unsupported / unknown    → UNAVAILABLE(platform reason) (rule 3; never hidden)
  4. connection unhealthy / outage       → BLOCKED(recovery)           (rule 4)
  5. (data features) coverage none/partial → EMPTY WITH REASON / CAVEAT (UX §25.1 step 5)
  otherwise                              → AVAILABLE
```

The same function's result is re-evaluated by the action pipeline (step 5) and by the executor at execution time, so a stale UI can never authorize an action.

---

## 17. Coverage architecture

### 17.1 Coverage records

Coverage is stored as **interval records**: for a scope (connected account × source × capability, optionally content item) and a time range, a state with extent, reason and as-of time.

| State | Written by |
|---|---|
| **Importing** | Backfill job at start, with progress extent updated per checkpoint. |
| **Complete** | Backfill or sync job when a time range was fully read for a validated capability. |
| **Partial** | Backfill when only part of a range was obtainable (e.g., history limit), with extent ("12 of 30 days"). |
| **Unavailable** | Capability evaluation (capability unsupported for that scope). |
| **Not requested** | Connection/asset selection (e.g., no ad account connected). |
| **Failed** | Job failure, revoked or expired credential, outage; the failed interval is recorded with reason. |
| **Unknown** | Default when nothing is known. |

Ongoing sync writes a **"synced through" heartbeat** per scope; a gap between heartbeats (e.g., during a revoked period) becomes a Failed interval, so a disconnection is never read as zero activity (Model §42).

### 17.2 Dimensions

Coverage is evaluated for any requested scope by combining intervals across **account**, **platform**, **source**, **period**, **content** (paid-context coverage per content item: linked, partially linked, unavailable, unknown) and **capability** (e.g., native-reply detection).

### 17.3 Coverage evaluation

A pure function `coverageFor(scope, window)` returns state, extent and reasons by intersecting the scope's intervals with the window. Aggregation, insights, reports, follow-ups, previews and empty states all call it.

### 17.4 Capability ≠ coverage

Capability says what **can** be done; coverage says how much **was** seen. A capability may be supported while coverage is failed (outage), and coverage may be partial while capability is supported (history limit). They're separate modules with separate records; coverage references capability only to explain "unavailable".

### 17.5 Measured values: no data ≠ zero

All numbers produced by aggregation are **Measured values**:

```
Measured<T> = {
  state:   AVAILABLE | PARTIAL | NOT_AVAILABLE
  value:   T            (absent when NOT_AVAILABLE)
  coverage: coverage summary (state, extent, reasons)
  asOf:    time
}
```

- A zero is only produced as `AVAILABLE(0)` or `PARTIAL(0, extent)` when coverage for the scope is complete or partial with known extent (Model §7.3).
- UI number components accept only Measured values and render "Not available — reason" for `NOT_AVAILABLE`. A plain number can't be passed where a measured metric is expected (type-level guard).
- Comparisons check that both windows have comparable coverage; otherwise the statistical state is "comparison unavailable" (Model §49).

---

## 18. Idempotency and deduplication

### 18.1 Stable identities

Every external object is keyed by **(platform, provider object identity)**, unique **per workspace** (the same provider object may legitimately exist in several organizations' workspaces, §8). Internal identities are separate and never reused.

### 18.2 Strategies

| Situation | Strategy | Classification |
|---|---|---|
| **Duplicate webhooks** | Provider event inbox has a unique key per (provider, event identity) or, when no event ID exists, a hash of the verified payload. Duplicates are acknowledged and dropped. | Uniquely keyed |
| **Repeated polling results** | Upsert by provider identity. Source text versions keyed by (interaction, content hash): identical text adds no version. Observations add a row only when observed state changes (or as a heartbeat at bounded frequency). | Idempotent |
| **Backfill overlapping realtime events** | Same upsert keys; backfill never overwrites a newer observation with an older one (compare provider and observed times). | Idempotent |
| **Worker retries** | Jobs are written as idempotent steps with checkpoints; outbox entries carry a unique dispatch key; job runtime idempotency keys = outbox entry identity. | Safely retryable |
| **AI job retries** | An assessment is keyed by (interaction, source text version, task, task version). A retry that finds an existing assessment for that key doesn't call the model again. | Idempotent (uniquely keyed) |
| **Provider mutation retries** | Mutation intent identity = idempotency key (§26.4). Per-action retry policy below. | Mixed |
| **Duplicate native replies** | Brand-authored interactions keyed by provider identity. Our own public replies are linked to their Outbound Reply when the provider returns the created identity; when the provider response was lost, a matching rule (same parent, same author account, text hash, time window) links the later-ingested interaction to the pending Outbound Reply instead of counting it as native. | Uniquely keyed + reconciliation |
| **Duplicate user submissions** (double click, network retry) | Commands that create intents carry a client-generated request key; the intent table enforces uniqueness per (workspace, request key). | Uniquely keyed |

### 18.3 Mutation retry policy by action

| Action | Retry semantics | Why |
|---|---|---|
| **Hide / Unhide** | Safely retryable (state-setting). Before retrying after an unknown outcome, re-read state where possible. | Setting the same state twice is harmless. |
| **Block** | Safely retryable (state-setting), where the platform semantics allow it (VALIDATE). | Same. |
| **Delete** | Retryable; "target not found" after a prior attempt is treated as success with note. | Irreversible but convergent. |
| **Public reply** | **Explicitly non-repeatable without verification.** After an unknown outcome, reconciliation searches for our reply under the parent before any resend. A human can resend only after the product shows "outcome unknown". | Duplicate public replies harm the brand. |
| **Private reply** | **Explicitly non-repeatable.** No automatic retry after an unknown outcome. If the platform can't confirm, the record shows "outcome unknown — check on [platform]". | One-shot by definition (PD D-36). |

**Execution rules (R6, LOCKED in v1.1; validated on Trigger.dev in TA-Q-04):**

1. **Domain idempotency is authoritative.** Job-runtime idempotency keys only reduce duplicate runs; two runs of the same work must still produce one effect (validated: two runs without a key, one assessment written).
2. **EXECUTING before the provider call.** The executor commits the intent as EXECUTING (attempt and run reference) before it calls the provider (§26.3).
3. **An intent found EXECUTING without an outcome** (crash, lost response, redelivered run) never triggers a blind provider call: it becomes OUTCOME_UNKNOWN and reconciliation decides.
4. **Ambiguous replies are never resent blindly.** Reconciliation looks for the reply first (validated: one provider call, one reply, reconciliation confirmed it).
5. **Hide and unhide may retry** because they are state-setting, after re-reading state where possible (validated: hide timeout retried and confirmed).

---

## 19. Background job architecture

### 19.1 Technology

**Trigger.dev as the selected durable job runtime (TA-Q-04 PASS, Phase 0E.2b), fed by a Postgres transactional outbox (LOCKED)** (TA-10, TA-28). Graphile Worker is the documented fallback behind the same job port. Deployed (cloud) worker behavior is validated in staging before production (TA-Q-31). Requirements and how they're met:

| Requirement | How |
|---|---|
| Durable | Runs persisted by the job runtime; business state persisted in Postgres; outbox guarantees dispatch after commit; crashed runs recovered by the run-outcome sweeper (R7). |
| Retryable | Per-task retry policies with exponential backoff and jitter; non-retryable error classes stop retries (§44). |
| Observable | Run dashboard, structured logs with correlation IDs, Sentry, domain status tables (import progress, intent status). |
| Idempotent | Idempotency key per dispatch; idempotent steps; domain idempotency authoritative (§18, R6). |
| Rate-limit aware | Queues keyed by (provider, connected account) with concurrency limits; budget checks before provider calls; retry-after honored (§45). |
| Concurrency controlled | Keyed concurrency per account and per workspace; global limits per provider app; priority lanes (§19.5). |

### 19.2 Job catalog

| Job | Trigger | Scope | Concurrency key | Notes |
|---|---|---|---|---|
| **Initial 30-day import (backfill)** | Connected Account activated | One account | provider + account | Sliced and checkpointed; updates coverage and progress; lowest lane. |
| **Ongoing sync** | Schedule (adaptive) | One account | provider + account | Cursor/watermark based. |
| **Webhook event processing** | Outbox from receiver | One event → routed workspaces | provider + account | Re-fetch where needed. |
| **Interaction understanding** (classification, protection, priority, reopen decision) | Outbox from ingestion | One workspace, batch of interactions | workspace | Realtime path for new items; batch path (cheaper) for backfill. |
| **Topic assignment** | Outbox after understanding (batched) | One workspace | workspace | §30. |
| **Automation evaluation** | Outbox after understanding, only if any policy is On and mode is Standard | One workspace, interactions | workspace | Deterministic (§25). |
| **Policy preview** | User request | One workspace, one policy definition version | workspace | Simulation mode of the same evaluator. |
| **Platform mutation execution** | Outbox from intent creation | One intent | provider + account | Highest lane (§26). |
| **Aggregate refresh** | Debounced dirty marks | One workspace | workspace | §30. |
| **Intelligence refresh** (observations, insights, drivers, recommendation refresh, guest projections) | Schedule + debounced triggers | One workspace | workspace | §31. |
| **Follow-up computation** | Schedule (after window ends) + data changes before ready | One tracked action | workspace | §32. |
| **Report generation** | Period close schedule + on-demand | One workspace, period, type | workspace | §33. |
| **Alerts and attention signals** | Outbox from relevant changes (debounced) | One workspace | workspace | §50. |
| **Reconciliation** | Schedule per account + after incidents | One account | provider + account | §47. |
| **Connection-health checks / token refresh** | Schedule + error-triggered | One connection | provider + connection | §39. |
| **Outbox dispatch sweeper / run-outcome sweeper (R7) / intent sweeper** | Schedule | System | system | Re-dispatch undispatched rows and CRASHED / SYSTEM_FAILURE runs (§19.3). |
| **Retention jobs** (later) | Policy-driven | One workspace / organization | workspace | §61. |

### 19.3 Outbox and dispatch

```
command / ingestion transaction
   ├─ write state + history + audit
   └─ write outbox row (type, workspace, payload IDs, ordering key, dispatch key)
commit
   └─ post-commit: dispatch outbox rows to the job runtime (idempotency key = dispatch key),
      record the returned run ID, mark dispatched
dispatch sweeper (scheduled): re-dispatch rows not marked dispatched after a threshold; alert if age exceeds SLO
run-outcome sweeper (scheduled, R7): for dispatched rows without a recorded terminal status, read the run status;
   record COMPLETED / FAILED / CANCELED; re-dispatch CRASHED and SYSTEM_FAILURE runs (same dispatch key → a new run);
   alert on repeated crashes; domain idempotency keeps the effect single (R6)
```

**R7 (LOCKED in v1.1; required part of the job foundation, §73 step 3).** The outbox records each dispatched run's ID and terminal status. Trigger.dev doesn't retry a run whose worker process crashed (documented and observed), and it releases the idempotency key when a run fails or crashes, so crash recovery belongs to the outbox, not to the vendor. Validated: a re-dispatched CRASHED run produced a new run and the domain effect happened exactly once. Runs that FAILED after exhausting retries, or were aborted as non-retryable, are surfaced for diagnosis and not re-dispatched blindly.

At-least-once delivery + idempotent consumers = effectively-once effects. Ordering where it matters (e.g., interaction events for the same conversation) is preserved by keyed concurrency of 1 for that key or by version checks in consumers.

### 19.4 Job payload rules

- Payloads contain **identifiers** (workspace, object IDs, intent ID, correlation ID), never comment text, author handles or credentials. Workers read content from Postgres inside the job's tenant scope. This keeps personal data out of the job vendor's storage and logs (validated in TA-Q-04: payloads as stored by Trigger.dev contained identifiers only).
- Every payload names its **workspace** (or is explicitly system-scoped) and its **initiator** (user/policy/system with request ID).

### 19.5 Priority lanes

| Lane | Work | Rationale |
|---|---|---|
| 1 (highest) | User-initiated platform mutations | A person is waiting. |
| 2 | Realtime ingestion and understanding of new interactions; automation evaluation | Freshness and protection. |
| 3 | Reconciliation, health checks, token refresh | Correctness. |
| 4 | Aggregates, intelligence refresh, reports | Eventual by design. |
| 5 (lowest) | Historical backfill and reprocessing | Must yield rate budget to everything else. |

Rate budgets are reserved so lower lanes can't starve user actions on the same account (§45).

### 19.6 Historical import specifics

- Ordered for **first value**: newest content and open, unanswered interactions first, so Home's "What we found" fills early (UX §5.4 early results).
- Checkpoint after each page/slice; resumable after crash or rate limiting (UX §5.5 "resumes automatically").
- Coverage updated per checkpoint; progress signals sent via realtime invalidation (§34).
- Backfilled interactions are classified via the **batch path** (lower cost, slower), except the newest slice, which uses the realtime path for first-session value.
- **Backfill never triggers automation** (forward-only automatic moderation, PD D-51, confirmed in Phase 0E.1).

---

## 20. Job dependency / pipeline model

### 20.1 Stages

```
 INGEST ─▶ NORMALIZE ─▶ PERSIST SOURCE ─▶ ENRICH (deterministic) ─▶ UPDATE OPERATIONAL STATE (immediate)
                                                │
                                                ▼  outbox
                                          UNDERSTAND (AI + rules) ─▶ ACCEPTED INTERPRETATION ─▶ PROTECTION
                                                │                         │
                                                │                         ├─▶ PRIORITY / VIEWS / REOPEN
                                                │                         └─▶ AUTOMATION EVALUATION ─▶ (maybe) MUTATION INTENT
                                                ▼  outbox (debounced)
                                          TOPICS ─▶ AGGREGATE PROJECTION ─▶ OBSERVATIONS ─▶ INSIGHTS ─▶ RECOMMENDATIONS
                                                                               │
                                                                               └─▶ GUEST PROJECTIONS · ATTENTION · ALERTS
                                          (independently scheduled) REPORTS · FOLLOW-UPS · RECONCILIATION
```

The pipeline is **a set of independent, event-triggered jobs**, not one long workflow. Each stage reads committed state, so any stage can be re-run on its own.

### 20.2 Stage properties

| Stage | Synchronous? | Enqueues downstream | Recomputable | Must complete before a platform action? |
|---|---|---|---|---|
| Receive + verify + record raw event | Yes (webhook request) | Processing job | Re-processable from inbox | No |
| Normalize + persist source + enrich | No (integration worker) | Understanding, realtime, aggregation marks | Yes (idempotent) | No |
| Immediate operational update (Open, native auto-Done) | Same transaction as persist | Realtime | Yes | No |
| Understand (classification, protection, priority) | No | Automation evaluation, topics, alerts, attention | Yes (adds assessments; never overrides human) | **Yes for automation.** Not for human actions: a person can reply or moderate before classification completes. |
| Automation evaluation | No | Mutation intent | Decisions are immutable; evaluation happens only for interactions arriving after policy activation (PD D-51) | Yes (it is the gate) |
| Mutation intent creation (human) | **Yes** (command transaction) | Mutation execution | No (one intent per request key) | It is the action |
| Mutation execution | No (highest lane) | Outcome events, workflow auto-Done, realtime | Retries per §18.3 | — |
| Topics, aggregates, observations, insights, recommendations | No | Next stage, guest projections | Yes | No |
| Reports, follow-ups | No (scheduled/on demand) | Alerts/Home items | Yes, with snapshot semantics (§32, §33) | No |

### 20.3 Workflow reopen and classification

A new audience message in a Done conversation is marked **pending understanding**. When understanding completes, the conversation reopens if the message needs a reply or review (IA-04). If understanding fails or times out, the item is treated as uncertain (needs review) and the conversation **reopens**: the fail-safe direction is to surface work, never to hide it.

---

## 21. AI / intelligence architecture

### 21.1 Principle

> **Numbers are computed by code. Meanings are proposed by AI as assessments. Decisions are made by deterministic rules or people.**

AI never computes an aggregate, never chooses an action on a platform, and never writes source facts. It produces structured, validated, versioned data that other modules may accept, display or ignore.

### 21.2 Task separation

| Task | Purpose | Input (workspace-scoped only) | Output (structured) | Tier | Trigger | Human role |
|---|---|---|---|---|---|---|
| **A. Interaction understanding** | Multi-dimensional classification (Model §14): safety, authenticity, intent (multi), sentiment, risk, response need, protection-relevant signals, reasoning summary | Interaction text (delimited as untrusted), parent and top-level comment, content caption excerpt, source, brand identity name, deterministic signals (URLs and their reputation, own-brand flags) | Per-dimension values with confidence and short reasoning; taxonomy keys only | Fast | New interaction (realtime path) or backfill (batch path) | Corrects labels (wins, M-05) |
| **A′. Protection check** (automation candidates only) | Focused second opinion: does this carry protected meaning? (§25.4) | Same inputs, protection-focused instructions | protected / not protected / uncertain + meanings + confidence | Balanced | Only when a policy candidate would otherwise reach the protection step | — |
| **B. Language detection / translation** | Language assessment (deterministic library first; AI for mixed/uncertain); display translation on demand | Source text version | Languages + confidence; translated text with provenance | Fast | Language: at ingestion. Translation: on user request | Corrects language |
| **C. Topic assignment** | Assign interactions to workspace topics (many-to-many) | Interaction text + workspace topic catalog (labels and aliases, multilingual) | Topic keys + confidence; "no fitting topic" | Fast | After A, batched per workspace | Corrects topics |
| **D. Reply suggestion** | Draft reply in the commenter's language, grounded only in verified Brand Context | Interaction, thread, content excerpt, verified Brand Context items (applicable), tone guidance, target language | Draft text, language, grounding state, Brand Context items used, missing facts, safety flags | Balanced | On composer open or on request (UX-08 deferred) | Reviews, edits, sends; or ignores |
| **E. Observation narrative / insight drafting** | Turn a deterministically detected observation + evidence into a plain-language insight | Structured observation (numbers, scope, windows, coverage, statistical state), selected evidence excerpts | Statement, scope phrasing, implication; references to provided numbers and evidence only | Balanced | Intelligence refresh, only for candidates that pass statistical gates | Marks "not useful" |
| **F. Driver hypothesis generation** | Propose likely explanations with supporting and conflicting evidence | Observation, evidence, content metadata (e.g., ad copy text available from content) | Hypotheses (always "likely"/"possible"), confidence, evidence references, alternatives | High reasoning | For insights at "stable pattern" state | — |
| **G. Recommendation generation** | Map an insight and driver to an action from the PD action catalog | Insight version, drivers, scope | Action type (catalog key), statement, rationale, scope; references | High reasoning | After F | Owner/Admin/Manager decide (IA-09) |

Other AI uses: emerging-topic discovery (periodic, high reasoning, proposals only, pending PD OQ-10), report narrative assembly (balanced, from structured content), Brand Context gap phrasing (from task D outputs; no extra call needed).

### 21.3 Boundaries between deterministic logic, models and people

| Kind of work | Done by | Examples |
|---|---|---|
| **Deterministic logic** | Code | Deduplication; own-brand authorship; URL extraction and reputation lookup; configured-pattern candidate matching; language pre-detection; precedence (M-05); protection-evaluation combination; the automation chain; priority from factors; coverage; aggregates; statistical gates; evidence selection; numbers in insights; workflow rules; availability. |
| **Lightweight model tasks** | Fast tier | Understanding (A), topics (C), language/translation (B). |
| **Balanced model tasks** | Balanced tier | Protection check (A′), reply suggestions (D), insight narrative (E), report narrative. |
| **Higher-reasoning model tasks** | High tier, low volume | Driver hypotheses (F), recommendations (G), emerging-topic discovery. |
| **Human decisions** | People | Sending any reply; moderating individually; bulk hide; enabling automation; correcting labels; accepting/dismissing/completing recommendations; changing workspace mode; managing connections and members. |

### 21.4 Prompt-injection posture

Comment text is untrusted (PD §13.4-7). Controls:

- Untrusted text is placed in clearly delimited data sections; instructions state that content inside them is data, never instructions.
- No AI task has tools or function calls that reach the database, providers or the network. Output is schema-constrained data only.
- An injected instruction can at worst produce a wrong assessment. A wrong assessment can't hide anything on its own: automation requires deterministic policy match, high confidence, a separate protection check, mode and capability checks (§25). Corrections remain available.
- Evals include adversarial injection sets (§56).

---

## 22. AI gateway

### 22.1 Responsibilities

```
 domain module ──(task id, typed input, tenant context)──▶ AI GATEWAY
                                                             │
   ┌─────────────────────────────────────────────────────────┼─────────────────────────────────────────┐
   │ 1. Task registry lookup: task version, prompt template version, output schema version,            │
   │    routing policy (primary + fallback model), limits (tokens, timeout), caching policy,           │
   │    data-handling class                                                                             │
   │ 2. Kill switch & budget check (global, per task, per workspace)                                    │
   │ 3. Build request: render prompt template; minimize data; mark untrusted sections                   │
   │ 4. Call provider adapter (Anthropic first; others pluggable) with retry policy                     │
   │ 5. Validate output against schema (+ task-specific validators)                                     │
   │ 6. Record AI call ledger entry: task, versions, provider, model, tokens, cost estimate,             │
   │    latency, outcome, workspace, correlation ID, input references (not content)                     │
   │ 7. Return typed result | typed failure (AI_INVALID_OUTPUT, AI_UNAVAILABLE, AI_REFUSED, AI_BUDGET)  │
   └───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 22.2 Capabilities

| Capability | Design |
|---|---|
| **Task-specific model selection** | Routing policy per task version in the registry; overrides per environment and via database configuration for staged rollouts (§66). |
| **Provider substitution** | Provider adapters implement one interface (messages in, structured result out, usage metrics). Switching a task's provider is a routing change plus an eval run, not a domain change. |
| **Model / version provenance** | Exact provider, model identifier, task version, prompt version and schema version recorded on every assessment or artifact (§57). |
| **Structured output validation** | Provider-native structured output where available **and** our own schema validation always (§23). |
| **Retry policy** | Retries on transient errors and rate limits with backoff; no retries on validation failure beyond one re-ask; fallback model only if the task's registry entry allows it and the fallback is eval-approved. |
| **Cost accounting** | Token usage × price table per model version → cost per call, aggregated per workspace, task and day (§58). |
| **Latency tracking** | Per call; percentiles per task in observability (§42). |
| **Safety failures** | Provider refusals and safety stops are typed outcomes (`AI_REFUSED`), never parsed as content. For suggestions they lead to "Couldn't produce a suitable suggestion" (UX §10.4); for classification they lead to uncertain → Needs review. |
| **Prompt / version identity** | Prompts are versioned files in the repository; the registry references them by version and content hash. |
| **Batch execution** | Backfill classification uses provider batch processing where available (lower cost, asynchronous results), through the same task contracts and validation. |
| **Prompt caching** | Stable prefixes (instructions, taxonomy definitions, a workspace's Brand Context block for a given version) are structured for provider prompt caching; cache identity is workspace-scoped where content is workspace data. |

### 22.3 Data handling

- Minimum necessary data per task; author identity is sent only when the task needs it (e.g., authenticity signals use behavior and naming patterns; an exact handle is optional).
- Provider data-processing terms must meet the legal review: no training on our data, retention compatible with PD OQ-21, region where available (TA-Q-06). Models whose retention requirements conflict with those terms aren't routed customer data.
- Raw prompts and responses are **not** logged by default. Sampled, access-controlled capture for evaluation is a separate, opt-in store with retention limits and legal basis (TA-Q-15).

---

## 23. AI structured output

### 23.1 Contract per task

Every task version defines (conceptually; no JSON Schema written yet):

| Element | Meaning |
|---|---|
| **Output schema** | Required fields, allowed taxonomy keys (closed sets from the taxonomy version), value ranges, cardinality (single vs multi-value). |
| **Confidence** | Per dimension or per item, as a qualitative level (high/medium/low) or a calibrated score mapped to levels by configuration (PD OQ-16, OQ-28). |
| **Reasoning summary** | Short, user-presentable explanation (Model §15.1). |
| **References** | For grounded tasks: IDs of provided Brand Context items, evidence items or numbers. Validators reject references not in the input. |
| **Provenance** | Added by the gateway: provider, model, model version, task version, prompt version, schema version, time, input references (interaction, source text version, context objects). |

### 23.2 Fail-closed behavior

| Failure | Behavior |
|---|---|
| **Malformed output** (not parseable, schema violation, unknown taxonomy key) | One re-ask with the validation error; if still invalid → typed failure `AI_INVALID_OUTPUT`. **No assessment is written.** |
| **Missing dimension** | Treated as no assessment for that dimension. |
| **Low confidence** | Written as an assessment with low confidence; Model §16 behavior (Needs review; no automatic action; no automatically prepared suggestion). |
| **Provider unavailable / timeout** | Retried; after limits → `AI_UNAVAILABLE`; interaction stays in "pending understanding" and is surfaced as uncertain after a bounded delay (Needs review), never silently dropped. |
| **Refusal / safety stop** | `AI_REFUSED`; same as invalid for classification; suggestion withheld. |
| **Reference to absent evidence or Brand Context** | Validation failure (fabrication guard) → re-ask once → withhold. |

**Consequence for safety:** every AI failure mode results in **less automation and more human review**, never the reverse. Missing protection evidence means "uncertain", which vetoes automation (M-07).

---

## 24. Classification architecture

### 24.1 Assessments and accepted interpretation

```
 Interaction (source text version v)
   │
   ├── Rule assessments        (origin C: deterministic, narrow — e.g., "URL known malicious", "author is own brand")
   ├── Platform hints          (origin A as interpretive hint — e.g., platform spam flag, where exposed)
   ├── AI assessments          (origin D: task A/A′/B/C, versioned)
   └── Human assessments       (origin B: corrections or human-authored labels)
          │
          ▼
   PRECEDENCE (M-05, pure function, versioned) per dimension:
     1. human correction (latest human assessment for that dimension) — wins until a later human correction
     2. deterministic rule — only for the dimension/value the rule actually establishes
     3. AI assessment (latest valid, for the current source text version)
     4. platform interpretive hint
          │
          ▼
   ACCEPTED INTERPRETATION per dimension (current state, points to winning assessment(s))
          │
          ▼
   PROTECTION EVALUATION (§25.3) · PRIORITY · VIEW MEMBERSHIP · TOPIC MEMBERSHIP
```

### 24.2 Rules

- **Source facts are separate.** Precedence applies to interpretations only; no assessment of any origin can modify source text versions, timestamps, provider identity, observed state or reported paid context (M-05 scope). Source-fact tables are written only by ingestion; the classification module has no write path to them (code boundary + insert-only grants).
- **Rules stay narrow.** Rule outputs are modeled as their own narrow facts or dimension values (e.g., link reputation), so a malicious-link rule can't by itself set "spam" (Model §15.2).
- **Corrections:** a correction is a new human assessment; the accepted interpretation is recomputed in the same transaction; the previous assessments remain. Undo of a correction is a further human assessment restoring the prior value (history keeps both).
- **Reassessment** (edited source text, M-09; model upgrade; taxonomy change, PD OQ-11) adds new AI assessments keyed to the new version. Precedence guarantees a later machine assessment **never** outranks a human correction for that dimension.
- **Model upgrades:** new task versions run first in **shadow mode** (assessments stored as non-accepting, compared in evals), then are promoted. Reprocessing historical interactions is an explicit, budgeted job; it never triggers automation (§25.7) and never rewrites past Automation Decisions (Model §47).
- **Multi-dimensional, multi-value:** dimensions are independent; intents and topics are multi-valued; each value has its own confidence (Model §14, §16).

### 24.3 Taxonomy versioning

Taxonomy keys (stable, language-independent) live in a versioned catalog with localized labels in i18n catalogs (PD §12.4, §16). Assessments record the taxonomy version. Treatment of history when the taxonomy changes remains PD OQ-11; versioning makes any chosen treatment implementable.

---

## 25. Protection + automation safety architecture

This is the most safety-critical boundary in the system. It is enforced **structurally**.

### 25.1 The only path from a policy to a hide

```
 new interaction understood (§20)
     │
     ▼
 AUTOMATION EVALUATOR (deterministic, automation module; no AI calls)
 ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ 1. Candidate       a policy that is ON (not Off/Paused/Suspended) matches by its criteria and scope │
 │ 2. Understanding   spam/bot/link policies: accepted interpretation supports that harmful category  │
 │                    pattern policies: previewed pattern defines the target AND the interaction is   │
 │                    confidently understood; a keyword alone never suffices; sentiment never counts   │
 │ 3. Protection      Protection Evaluation = NOT PROTECTED from BOTH the general evaluation AND the   │
 │                    dedicated protection check (A′). protected or uncertain → VETO (M-07)            │
 │ 4. Eligibility     high confidence; category ∈ {obvious spam, obvious bot, malicious link,         │
 │                    configured pattern}; abuse/insult → never eligible (D-34)                       │
 │ 5. Workspace mode  Standard required; Monitor-only → VETO                                          │
 │ 6. Capability      hide supported for this account/content type; connection healthy                │
 │ 7. Outcome         HIDE │ NEEDS REVIEW │ NO ACTION   → Automation Decision record (all step results)│
 └──────────────────────────────────────────────────────────────────────────────────────────────────┘
     │ only if outcome = HIDE
     ▼
 AUTOMATION MUTATION REQUEST (type allows only HIDE; carries the Automation Decision identity)
     │
     ▼
 PLATFORM MUTATION EXECUTOR (§26): re-checks kill switches, mode, policy state, protection (current),
 capability, connection, idempotency → provider hide → Moderation Event (initiator: policy) → audit
```

### 25.2 Structural guarantees

| Guarantee | Mechanism |
|---|---|
| **No AI → hide path** | The AI gateway and AI tasks can't import the executor, adapters or repositories that create intents (lint rule, §6.3). AI output is stored as assessments only. The executor accepts automation-originated requests only when they reference an Automation Decision with outcome HIDE, created by the automation evaluator. |
| **Protection before automation** | The evaluator's step order is fixed in one function; a decision record without a "not protected" protection result can't be constructed (the Automation Decision type requires all step results). The executor re-reads the **current** protection evaluation at execution time; a human correction to a protected meaning between decision and execution vetoes the hide. |
| **Uncertain = veto (M-07)** | Protection Evaluation has three states; only NOT PROTECTED passes. Missing assessments, AI failures and low confidence produce UNCERTAIN. |
| **Abuse never auto-hides (S4)** | Abuse/insult isn't a policy type and isn't an eligible category in step 4; the policy model has no way to express it (IA §13.4). |
| **Hide only (S5)** | The automation mutation request type can only express HIDE. The executor rejects any automation-originated request for another action. |
| **Keywords aren't meaning (S19)** | Pattern matches only produce candidates (step 1); step 2 requires confident understanding; step 3 applies protection. |
| **Sentiment never counts (S1)** | The evaluator's inputs exclude the sentiment dimension by type; a test asserts sentiment changes never change a decision. |
| **Monitor-only (S7)** | Step 5 + executor re-check + database backstop (§26.6). Policies are Suspended while Monitor-only. |
| **Never resumes silently (S10)** | Mode transition to Standard sets every previously On or Suspended policy to Paused in the same transaction (IA-16); activation of malicious-link and pattern policies requires a fresh preview (§25.6). |

### 25.3 Protection Evaluation

- Derived from the accepted interpretation of the intent and related dimensions (legitimate complaint, product/service problem, fraud/scam accusation against the brand, commercial objection; PD D-35).
- Result: protected · not protected · uncertain, with the meanings found, the supporting assessments and their origins, time and version (Model §17.1).
- Uncertain whenever confidence in the relevant dimensions is below high, assessments are missing or conflicting, or understanding failed.
- Recomputed whenever the accepted interpretation changes. Decisions store the result they used.

### 25.4 Dedicated protection check ("second key")

**VALIDATE (implementation details and cost/benefit confirmed by eval, TA-Q-14):** for interactions that reach step 3 as automation candidates, run task A′, a focused protection classifier with different instructions (and possibly a stronger model). Automation proceeds only if **both** the general evaluation and A′ say NOT PROTECTED with high confidence. Cost is bounded because A′ runs only for candidates. This reduces the chance that a single prompt failure or injection hides a complaint (PD R-03; §19.2 targets).

### 25.5 Type-level restrictions

Conceptually (no code written here):

- `AutomationMutationRequest` permits action ∈ {HIDE} and requires an `AutomationDecisionRef`.
- `HumanMutationRequest` permits any supported action and requires a `HumanActorRef` from an authenticated command context; `DELETE` and `BLOCK` exist **only** on `HumanMutationRequest` with single targets.
- `BulkMutationRequest` permits action ∈ {HIDE} only, requires a human actor, and is expanded into per-item intents with per-item protection exclusion (§26.5).

### 25.6 Policy activation guard and previews

- **Single evaluator, two modes:** the preview runs the same evaluator in simulation mode over imported history (coverage-stated window), producing *would hide* and *excluded by Always protected* sets with as-of time and definition version (Model §20). Previews and live decisions therefore can't drift apart.
- **Activation guard** (malicious-link and pattern policies): activation succeeds only if a preview exists for the **current definition version** and was created **after** the most recent mode transition and within a freshness window (configurable). Spam and bot policies offer previews without requiring them (PD C-09; IA §13.3).
- **Pattern overlap warning** (UX-10): computed at definition time against protected-meaning vocabulary; creation is allowed; preview required.

### 25.7 When automation runs

**PRODUCT OWNER: CONFIRMED (Phase 0E.1) — forward-only automatic moderation (PD D-51; UX v1.1 §14).**

- Activating a policy applies **only to interactions newly ingested / newly arriving after activation** while the policy is On and the workspace is Standard. Re-enabling after Pause or after leaving Monitor-only is an activation too.
- **Historical interactions imported before activation are never mutated by the activation.** History is used only for the policy preview, safety validation and impact estimates. There is no silent retrospective cleanup.
- **Reprocessing, model upgrades and classification corrections never retroactively trigger automatic platform mutations** (corrections: UX §16.2).
- **Eligibility rule (technical expression of D-51):** an interaction is an automation candidate only if it was created on the platform after the policy's activation time **and** reached the product through live ingestion (webhook, sync or reconciliation of a recent window) after activation. Historical backfill is never eligible. When in doubt, the interaction is not eligible (conservative).
- Customers who want to clean historical obvious spam use a **human-initiated bulk Hide**, with all bulk safety exclusions (protected and uncertain items excluded, §26.5).

### 25.8 Kill switches

- **Workspace "Pause all automation"** (product feature, PD §13.4 PROPOSED; IA §13.2): sets all workspace policies to Paused.
- **Global automation kill switch** (operations): stops evaluation and execution of automation-originated intents across all workspaces; checked by the evaluator and the executor (§66).
- **Release gate:** automation execution stays disabled per platform and policy type until the classification-quality evaluation for the relevant languages passes (PD OQ-28 gates thresholds). Previews remain available.

---

## 26. Platform mutation architecture

### 26.1 One boundary

All external changes go through the **Platform Mutation Executor**: public reply, private reply, hide, unhide, delete, block. No other code path can call a provider mutation.

### 26.2 Structural isolation

- Adapters expose a **mutation port** that is only constructed inside the executor's composition (dependency injection at the job runtime's composition root). No other module can obtain it; lint rules forbid importing adapter mutation implementations anywhere else.
- The web deployment **doesn't bundle** the executor's execution path. It can only create **mutation intents** through commands.
- Workers can only execute an intent row that exists in the database in an executable state.

### 26.3 Lifecycle

```
 HUMAN COMMAND (web)                                  AUTOMATION (worker)
 action pipeline: authn → tenant → authz →            Automation Decision (HIDE)
 availability → validation                                 │
        │                                                  │
        └──────────────────────┬───────────────────────────┘
                               ▼
          CREATE MUTATION INTENT (one transaction)
            · guard chain (§26.4) at request time
            · idempotency key unique per workspace
            · status = PENDING, initiator, authorization basis (command or decision), capability snapshot
            · domain record: Outbound Reply (sending) or pending moderation action
            · audit event · outbox row
                               │
                               ▼
          EXECUTE (job runtime, lane 1 for humans, lane 2 for automation)
            · lock intent (only PENDING/RETRYABLE executes)
            · guard chain RE-CHECK at execution time (mode, kill switches, policy state, protection, capability,
              connection, target still exists, stale-state check for replies)
            · record status = EXECUTING (attempt, run reference) and COMMIT before any provider call (R6)
            · decrypt credential (integration boundary) → adapter mutation port
            · record outcome: CONFIRMED │ FAILED(reason) │ BLOCKED(reason) │ OUTCOME_UNKNOWN
            · intent already EXECUTING without an outcome (crash, lost response, redelivered run)
              → OUTCOME_UNKNOWN → reconciliation; never a blind provider call (§18.3)
                               │
                               ▼
          OUTCOME EVENTS (outbox): moderation event · outbound reply update · brand interaction link ·
          workflow auto-Done · realtime invalidation · audit · reconciliation request (if unknown)
```

### 26.4 Guard chain

| Check | Request time (web) | Execution time (worker) |
|---|---|---|
| **Identity** | Authenticated session (human) or Automation Decision (policy) | Initiator recorded on intent is valid (user still a member for human intents created moments ago; decision exists for automation) |
| **Permission** | Permission catalog (§10.3), grants for delete/block | Re-checked (membership/role may have changed) |
| **Workspace** | Tenant context; target belongs to workspace | Job tenant scope = intent workspace |
| **Operating mode** | Must be Standard | **Re-checked with a consistent read**; Monitor-only → BLOCKED(mode) |
| **Kill switches / release gates** | Checked | Re-checked |
| **Capability** | Availability resolver | Re-evaluated against current profile |
| **Connection health** | Healthy required (else BLOCKED with recovery; draft kept) | Re-checked; credential valid |
| **Idempotency** | Unique request key → returns the existing intent | Only one execution per intent; EXECUTING committed before the provider call; outcome-unknown handling (§18.3, R6) |
| **Action-specific safety** | Delete/block: human, single target, explicit confirmation flag from the confirmation step (audit only; never authorization). Bulk hide: protected exclusion. Reply: stale-state check (teammate replied) surfaced to user. Private reply: one-shot check (already sent → shown, UX §12.3). | Same checks where state may have changed |
| **Automation-only** | — | Automation Decision outcome HIDE; policy still On; **current** Protection Evaluation = NOT PROTECTED; eligibility re-check port implemented by the automation module |
| **Audit context** | Correlation ID, initiator, reason | Same correlation ID carried into outcome and provider diagnostics |

### 26.5 Human moderation specifics

- **Single hide of protected content** is allowed for permitted humans (PD D-35). The UI shows an informational caution (UX §13.2); the executor records that the target was protected at the time, for audit.
- **Bulk hide** is only for clearly homogeneous sets and expands into per-item intents. Items whose Protection Evaluation is **protected** (UX-06) **or uncertain** (PRODUCT OWNER: CONFIRMED, Phase 0E.1; PD D-52) are **excluded** from the batch; the user sees how many were excluded and that they need individual review. Exclusion is evaluated server-side at expansion time and re-checked per item at execution. Bulk hides are attributed to the person, never to automation, and never appear in Hidden automatically. A permitted human can still open an excluded interaction and moderate it individually and deliberately.
- **No bulk delete or block** (S6): the bulk request type can't express them.
- **Delete and block are human-only** (D-19): only the human request type can express them, and only for single targets.
- **Undo of an automatic hide** is a human Unhide intent linked to the original Automation Decision (precision signal, UX §14.4). It is unavailable while Monitor-only (IA §7.8).

### 26.6 Monitor-only: structurally impossible

Monitor-only blocks product-initiated mutations at five points:

1. **Availability resolver / action pipeline:** commands return MODE_BLOCKED; UI shows "This workspace is Monitor-only".
2. **Automation evaluator:** step 5 vetoes; policies are Suspended.
3. **Intent creation:** the intent-creation transaction reads the workspace mode consistently and refuses.
4. **Database backstop:** an integrity rule rejects inserting a new intent, or moving an intent into an executing state, for a workspace whose mode is Monitor-only (moving it to BLOCKED remains possible).
5. **Execution re-check:** the executor re-reads mode before calling the provider; intents queued before a switch to Monitor-only end as BLOCKED(mode).

Native platform changes are still observed and recorded (Model §18). Mode changes and their effects (policies suspended, queued intents blocked) are audited.

### 26.7 Credential use

The executor (and integration workers) obtain a decrypted credential only for the duration of one provider call, from inside a workspace job scope, through the credential-access function (§39). Credentials never enter job payloads, logs or the web deployment.

---

## 27. Outbound reply architecture

### 27.1 Public reply

```
 human presses Send (composer; text may start from a suggestion or saved reply)
   → command: reply.public (pipeline, availability, stale-state check)
   → Outbound Reply (status: SENDING; sender = user; starting point; edit extent; language; target)
   → mutation intent → executor → provider replyPublicly
   → CONFIRMED with provider identity
        → brand Interaction created/linked in the public Conversation (author = connected account identity),
          linked to the Outbound Reply
        → workflow: auto-Done "Replied publicly" if nothing else needs handling (IA-04), with Undo
   → FAILED → text kept, reason in outcome terms, Retry (new intent, same Outbound Reply)
   → OUTCOME_UNKNOWN → reconciliation looks for the reply under the parent before any resend (§18.3)
```

When the same brand comment later arrives through webhook or sync, deduplication by provider identity links it to the existing brand Interaction; if the provider identity was lost, the matching rule links it to the pending Outbound Reply (§18.2), so it is never counted as a native reply.

### 27.2 Private reply

```
 human presses Send privately (after the one-message limitation is shown, UX §12.1)
   → command: reply.private (pipeline, availability, one-shot check)
   → Outbound Reply (kind: PRIVATE; status: SENDING)
   → mutation intent → executor → provider replyPrivately
   → CONFIRMED → Outbound Reply stays an outbound record, linked to its target Interaction and Conversation
              → Conversation history marker ("Private reply sent by … · follow-up continues in [platform]'s inbox")
              → workflow: may auto-Done "Replied privately"
   → no Interaction is created; nothing is ingested afterwards
```

### 27.3 What never exists

The architecture contains **no**: incoming DM ingestion, DM read operations in the adapter contract, DM thread or DM Conversation objects, DM inbox views, DM workflow states, or webhook subscriptions for private messages. Tests assert that the adapter contract has no private-message read operation and that a private reply never creates an Interaction (§55).

### 27.4 Origins vs sender

AI suggestions and saved replies are **starting points for draft text**. They have no path to the executor. The executor's reply actions require a `HumanMutationRequest` created from an authenticated, interactive command. The Outbound Reply records the starting point (suggestion ID, saved reply ID or manual) and edit extent for attribution (PD §13.4-4, §19.3).

---

## 28. Brand Context architecture

### 28.1 Design

- **Relational and structured:** sections (identity, products and services, verified facts, FAQs, contact channels, tone and voice, key policies; IA §15.2) containing items with: text, optional language, applicability (workspace or brand label; IA-07 open), verification (who, when), currency (current, outdated, retired), version.
- **Versioned items:** a suggestion records the exact item versions it used.
- **Gap signals:** derived from suggestion outputs (missing facts) and VoC unmet needs (UX §20), stored as aggregated, workspace-scoped gap records linking to the relevant section.

### 28.2 Is structured relational Brand Context enough for the MVP?

**Yes.** Brand Context is lightweight by product definition (PD D-47; R-15). The reply task receives **all current, verified, applicable items** within a token budget. If a workspace's Brand Context outgrows the budget, deterministic selection (section relevance by intent and topic tags, language match) narrows it before any retrieval technology is considered.

### 28.3 Not built

No CMS, no document upload and ingestion, no unrestricted RAG, no embeddings, no vector store (TA-21, TA-22). **Upgrade trigger:** measured retrieval misses (suggestions missing facts that exist in Brand Context) at a rate that deterministic selection can't fix. The first step then is **pgvector inside Postgres**, workspace-scoped, not a separate system.

---

## 29. AI reply grounding

### 29.1 Inputs

Only: the interaction and its thread, a content excerpt, the workspace's **current, verified, applicable** Brand Context items (never outdated or retired; Model §34), tone guidance, target language. **No cross-workspace data, no organization-level data, no web retrieval.**

### 29.2 Output contract

Draft text, language, **grounding state** (grounded · partially grounded · no facts needed · not enough verified information), **items used** (IDs), **missing facts** (what was needed but absent), safety flags.

### 29.3 Deterministic validation after generation

| Check | Failure handling |
|---|---|
| Items used ⊆ items provided | Re-ask once, else withhold |
| Factual tokens in the draft (prices, amounts, percentages, dates, delivery times, phone numbers, emails, URLs, handles) must appear in the used items or the conversation itself | Re-ask once with the violation; else downgrade to "not enough verified information" acknowledgment draft, or withhold |
| Contact channels in the draft must match approved contact-channel items | Same |
| Grounding state consistent with items used and missing facts | Corrected by the validator (e.g., missing facts present → at most "partially grounded") |
| Safety flags (inappropriate content) | Withheld: "Couldn't produce a suitable suggestion for this comment" (UX §10.4) |
| Target interaction low confidence | No automatic preparation; on request only, with caution label (UX §10.4) |

**Missing facts stay missing:** the draft states that the information isn't available or routes to an approved channel; the gap is surfaced with "Add to Brand Context" (UX §10.4).

### 29.4 Lifecycle

Suggested Reply records store inputs (references), outputs, grounding, versions and human use (shown, inserted, edited, flagged, dismissed; Model §35). Suggestions are invalidated when the Brand Context version used changes ("Refresh suggestion", UX §10.4). Whether suggestions are prepared automatically or on demand stays **UX-08 (deferred)**; both are supported by the same task and records. In Monitor-only workspaces no suggestion is generated (IA §8.4).

---

## 30. Topic / aggregation architecture

### 30.1 Topics

| Element | Design |
|---|---|
| **System topic catalog** | Product-owned topic **definitions** (stable key, language-independent meaning, localized labels and aliases), versioned in the repository like the taxonomy. Contains no customer data. |
| **Workspace topic instances** | Each workspace has its own topics: instances of system topics plus customer-specific topics (products, campaigns, locations), with workspace-specific labels and aliases per language. All assignments and aggregates reference workspace instances. |
| **Topic Assignment** | Assessment (origin, confidence, time, versions) linking an interaction to a topic; many-to-many; human correction wins (M-05). |
| **Multilingual semantics** | Assignment is by meaning: task C receives the workspace catalog with multilingual labels and aliases and returns topic keys, so "precio", "preço" and "price" map to one topic (PD §16). No keyword counting. |
| **Merge / split readiness (M-08 open)** | Topic identity is stable; a merge creates a "merged into" redirect and keeps all assignment history; a split creates new topics and re-assigns going forward with history kept. Whether and how users can do this stays PD OQ-10 / IA-06. |
| **Emerging topics** | A periodic discovery job (high reasoning, low volume) reviews interactions with no fitting topic and proposes candidate topics with evidence. Proposals are stored but **not** promoted automatically; promotion rules depend on PD OQ-10. "Emerging" as a *statistical state* of a topic's aggregates is computed deterministically (Model §21, §49). |

**M-10 (open):** **TA RECOMMENDATION — PRODUCT OWNER REVIEW REQUIRED.** Use a shared catalog of system topic **definitions only** (no data), with per-workspace instances and data, as the Model recommends. This needs no cross-workspace data access and keeps multilingual consistency. It stays open until the Topics architecture/design phase.

**No vector database for topics.** Assignment uses the catalog with an LLM; discovery uses periodic reasoning over samples. If clustering at large volume becomes necessary, pgvector in Postgres is the upgrade path (§59).

### 30.2 Aggregation

```
 accepted interpretations + topic assignments + content/source + workflow state + coverage
        │  (projection job on change; dirty marks per workspace/day)
        ▼
 INTERACTION ANALYTICS PROJECTION (one row per interaction; derived, recomputable, workspace-scoped):
   platform · account · content · campaign/ad (where linked) · effective source · day (workspace time zone)
   · intent set · topic set · risk · response need · sentiment (analysis only) · handled status · response time
        │
        ├─▶ on-demand aggregation queries (Measured values with coverage) for Home, Content & Ads, VoC, topic pages
        └─▶ AGGREGATE SNAPSHOTS (immutable) when an observation, insight version, follow-up or report references a number
```

- **Aggregates are computed by SQL in the aggregation module**, never by AI.
- **Coverage is attached to every result** through `coverageFor(scope, window)` (§17.3).
- **Statistical state** (insufficient volume, emerging, stable, comparison unavailable, partial coverage, conflicting, not available; Model §49) is computed deterministically with thresholds as configuration (PD OQ-16).
- **Corrections** mark affected projection rows dirty; refresh is debounced per workspace (UX §16.1 "next refresh").
- **Scale lever:** if on-demand aggregation exceeds performance targets, add daily rollup tables per workspace, then consider an analytical store (§59).

### 30.3 Observations

A set of **deterministic observation detectors** runs during intelligence refresh, each producing candidate observations with scope, windows, baseline, change, concentration, statistical state and coverage caveats:

| Detector (examples) | Looks for |
|---|---|
| Volume change by topic / intent / scope | Rising or falling counts vs baseline, with coverage-comparable windows |
| Concentration | Topic or intent concentrated in specific content, ads, platforms or sources |
| Unattended backlog | Unanswered paid vs organic conversations beyond thresholds |
| Risk build-up | Harmful content or reputation-risk items accumulating, especially on active ads |
| Emerging signal | Early increases below "stable" thresholds (shown as Emerging, no recommendation; UX §19.4) |
| Unmet information need | Recurring questions linked to Brand Context gaps |

Only candidates that pass minimum-volume and coverage gates proceed to AI drafting (cost and honesty).

---

## 31. Insight architecture

### 31.1 Chain and lineage

```
 Aggregate snapshot(s) ─▶ Observation (deterministic) ─▶ Evidence (selected by code) ─▶ Insight version (AI-drafted
                                                                                         wording over structured facts)
                                                                                              │
                                                                                              ├─▶ Driver Hypotheses (AI, F)
                                                                                              └─▶ Recommendations (AI, G)
 Lineage references stored at every hop: insight version → observation → aggregate snapshots, evidence items
 → interactions / conversation-set scope; recommendation → insight version(s); report generation → versions used.
```

### 31.2 Evidence

| Evidence kind | Stored as |
|---|---|
| Representative interaction | Reference to interaction (+ source text version) chosen by code: diverse across content and platform, high-confidence labels, visible, not removed at source. A **guest-presentable** flag is computed deterministically (personal-data scrubbing; author display per M-11, which stays open). |
| Conversation set | A **reproducible scope definition** (filters) that resolves through the Inbox query for permitted roles. Never a copied list (IA §10.4). |
| Aggregate reference | Aggregate snapshot ID. |
| Concentration / time comparison | Snapshot IDs per window with coverage. |

### 31.3 Generation rules

- **Numbers in insight text must equal the structured numbers** provided (validator compares). The model can't introduce a number.
- **Statements are scoped and associative** ("concentrated in", "coincides with"); drivers are always "likely" or "possible" (UX §19.6; S14).
- **Coverage caveats** from the observation are attached to the insight version and rendered (IA §10.5).
- Insight narratives are generated in the workspace's main language and on demand in other reader languages, cached per (insight version, language) (PD §16 output language).

### 31.4 Recomputation, versions and corrections

- **Intelligence refresh** (scheduled and debounced) re-evaluates active insights against fresh aggregates.
- If support changes **immaterially**, the current version stands (its as-of time is shown).
- If support changes **materially** (thresholds configurable), a **new version** of the same insight is created, or the insight is marked resolved/expired, or "evidence changed" is shown (Model §47).
- **Corrections** propagate at the next refresh via lineage: affected insights are found through their evidence and scope references (Model §47).
- **Recommendations reference the insight version they were issued from**; an "evidence has weakened" notice is a derived flag, not a status (UX §21.4).

**M-04 (open):** the storage model (stable insight identity + immutable versions) supports both possible answers. Deciding **when a change is material enough to be a new insight rather than a new version** is a product-semantic choice. **TA RECOMMENDATION — PRODUCT OWNER REVIEW REQUIRED:** adopt the Model's recommendation (same identity with versions; a different claim becomes a new insight; recommendations reference the version). It remains open until Insights implementation design and doesn't block implementation of the storage pattern.

**M-06 (open):** the classification design supports interaction-level authenticity now and a workspace-scoped author summary later without structural change. **TA RECOMMENDATION — PRODUCT OWNER REVIEW REQUIRED:** add the workspace-scoped author summary only after evals show it improves obvious-bot precision; never cross-workspace. Remains open, dependent on AI evals.

---

## 32. Recommendation / Tracked Action / Follow-up

### 32.1 Flow

```
 Recommendation (OPEN) ── accept ──▶ ACCEPTED (owner = accepting user) ── mark done (date) ──▶ DONE
        │                                                                                   │
        └── dismiss (optional reason) ──▶ DISMISSED                                         ▼
                                                              Tracked Action (exactly one ACTIVE; M-12)
                                                                                            │
                                                         schedule: follow-up after window (UX-13 open)
                                                                                            ▼
                                                              Follow-up: PENDING ─▶ READY (alert + Home) ─▶ VIEWED
 reopen (marked done by mistake) ──▶ ACCEPTED; the active Tracked Action is RETIRED (kept as history)
```

### 32.2 Enforcement

- **Decisions** (accept, dismiss, mark done, reopen) require `recommendations.decide` (Owner, Admin, Manager; IA-09), via the action pipeline, with decision events and audit.
- **M-12 (confirmed):** a database uniqueness rule allows **at most one active Tracked Action per Recommendation**. Marking Done creates it in the same transaction; reopening retires it. No sub-actions, task lists, parallel actions or approval chains exist in the model or schema.
- **In-product actions** (create a saved reply, fill a Brand Context gap, enable an eligible rule in Standard mode) offer "Mark done" in the same step (UX §21.2); enabling a rule still goes through the full automation configuration path (preview guard, mode).

### 32.3 Follow-up computation

- Anchored on the Tracked Action's completion date.
- Measures the **same aggregate and scope** as the originating observation (Model §29 [MODEL-REC]) over a before window and an after window, each with its own coverage; incomparable coverage → "comparison unavailable".
- Window length is a configuration parameter; its default stays **UX-13 / PD OQ-16 (open)**.
- Known confounders (e.g., campaign paused, ad ended, as observed in paid context) are recorded. Media metrics aren't available in the MVP (IA-12).
- The result statement is descriptive and always labeled "Descriptive: other factors may have contributed." No component computes or stores causal claims (S15).
- Recomputed until READY; then stored as a snapshot, stable unless data changes materially (Model §44).

---

## 33. Report architecture

### 33.1 Assembly, not a second engine

A report generation job **assembles** existing objects for a workspace and period:

| Report | Assembled from |
|---|---|
| **Summary** | Insight versions active in the period, driver hypotheses, risks (from observations and alerts), VoC aggregates, recommendations and their status, ready follow-ups, representative evidence |
| **Performance** | Aggregate snapshots for the period: volume, response rate and time vs baseline, backlog trend, unattended organic vs paid, moderation activity by people, automation activity by rule |

Every report includes a **coverage statement** for the period (UX §22.5), covers all sources by default with breakdowns (UX §3.2), and uses AI only to phrase narrative from structured content (numbers validated as in §31.3).

### 33.2 Generations and M-03

- Each run produces a **Report Generation**: an immutable snapshot with as-of time, the referenced versions and snapshots, and two renderings: **internal** (links to insights, topics, content, Inbox views per role) and **guest** (guest-safe evidence copies, content names without links, automation counts without links; IA-05).
- **M-03 (open):** **TA RECOMMENDATION — PRODUCT OWNER REVIEW REQUIRED:** freeze each generation with its as-of time; allow an explicit "Regenerate" that creates a new generation and keeps the previous one, as the Model recommends. Remains open until Reports design; the generation model supports both freezing and regeneration.
- **Period behavior:** in-progress periods are labeled "In progress"; "usable report exists" is computed for client-guest landing (UX-15).
- **Delivery and export** stay PD OQ-15. Any future share link or file export is generated from the **guest rendering** for guests, and enforces the same workspace and role checks.

---

## 34. Realtime architecture

### 34.1 What needs realtime

| Surface / event | Realtime? | Mechanism |
|---|---|---|
| Inbox list (new conversations, reorder, counts) | **Yes** | Invalidation signal → "3 new" indicator; no reordering under the cursor (UX §8.6) |
| Conversation detail (new interactions, teammate actions, moderation results) | **Yes** | Invalidation → refetch the conversation |
| Mutation outcome (Sending → Sent / Failed) | **Yes** | Invalidation on intent outcome |
| Import / backfill progress | **Yes** | Progress invalidation per checkpoint |
| Connection state changes | **Yes** | Invalidation → Home notice, Connections |
| Assignment and workflow changes | **Yes** | Invalidation |
| Alerts center | **Yes** | Invalidation per recipient |
| Home blocks | Near-real-time | Invalidation or periodic refresh |
| Insights, VoC, topic pages, Content & Ads | **No** | As-of timestamps; refresh on navigation |
| Reports | **No** | Generations |
| All workspaces attention | Periodic refresh | Signals recomputed by jobs |

### 34.2 Transport and security

- **Supabase Realtime private broadcast channels**, one per workspace (plus a per-user channel for alerts). Subscription is authorized server-side against membership; Client guests aren't authorized for operational channels.
- Messages carry **only identifiers, object type and version**, never comment text or names. The client re-fetches through the server's tenant-scoped queries, so authorization lives in one place.
- **Fallback:** periodic polling of a lightweight "changes since version" query if realtime is unavailable.
- Not using database change streams to browsers: they would evaluate RLS per subscriber per change and risk exposing content in payloads.

---

## 35. Cache strategy

**No Redis or other external cache in the MVP** (TA-19).

| Need | MVP approach |
|---|---|
| Hot reads (Inbox, conversation detail) | Indexed Postgres queries; per-request memoization; no cross-request cache of tenant data. |
| Expensive aggregates | Projection + snapshots in Postgres (§30.2). |
| AI results | Stored as assessments (§18); translations cached per (text version, language, task version) in Postgres. |
| Rate limiting for provider calls | Job-runtime keyed concurrency + budget state in Postgres (§45). |
| Application rate limiting | Edge firewall rules on the web host + Postgres-backed counters for sensitive commands. |
| Sessions | Auth cookies; no server session store needed. |

**Triggers to introduce a cache (e.g., Redis):** sustained database load from repetitive hot reads that indexes and query design can't fix; high-frequency distributed rate limiting across many workers that Postgres counters can't sustain; presence features at scale; realtime fan-out beyond the realtime service. Any cache must key every entry by workspace (and user where relevant) and hold no credentials.

---

## 36. Search architecture

### 36.1 MVP: PostgreSQL

| Searchable | Approach |
|---|---|
| Conversations (comment text, author display name) | Full-text search over source text (language-agnostic configuration with accent folding), plus trigram matching for names and partial words; always filtered by workspace first; Inbox filters combine with search. |
| Content (caption, ad name, campaign) | Full-text + trigram. |
| Topics | Labels and aliases in all languages (trigram). |
| Insights | Current version statements (and their generated languages). |
| Reports | By period and title. |
| Saved replies | Name and text. |

- **Scope:** current workspace only (IA-10). Workspace-leading indexes.
- **Client guests:** search queries run only against guest projections (insights, topics, reports); conversation and content results can't be returned because the guest role can't read those tables (§49).
- **Monitor-only:** platform-action commands remain findable but return the unavailable state (UX §24.2).

### 36.2 Upgrade triggers

Search latency beyond targets at real volumes; relevance needs (per-language stemming, ranking, synonyms) beyond Postgres capabilities; very large per-workspace corpora. The upgrade would be a workspace-partitioned external index fed by the outbox, still never cross-workspace.

---

## 37. Storage architecture

| Data | Where | Notes |
|---|---|---|
| All structured product data, source text, assessments, intelligence, audit | **Postgres** | Including source text versions (small). |
| Raw provider payloads | **Postgres** provider event inbox (bounded retention, TA-Q-11) | For debugging and replay; contains personal data; access restricted to ingestion and audited support tooling. |
| Platform media (images, video) | **Not copied in the MVP.** Store media references; render via provider-hosted URLs refreshed when needed; show a placeholder when unavailable | Copying media may conflict with platform terms and multiplies personal data (TA-Q-12, VALIDATE). |
| Thumbnails | Only if platform terms allow and UX needs them; then in private buckets with workspace-prefixed paths and lifecycle rules | Decision after API/terms validation. |
| Exports, report files | **Object storage** (private buckets), later with PD OQ-15 | Short-lived signed URLs after authorization; guest exports use guest renderings. |
| Evaluation datasets | Repository (synthetic/sanitized) or a restricted bucket for approved samples | Legal basis per TA-Q-15. |

**Permission boundaries:** private buckets only; paths `organization/workspace/...`; storage policies require membership; signed URLs minted by the server after authorization and expiring quickly. **Lifecycle:** retention rules per class (§61); deletion jobs include storage.

---

## 38. Security architecture

### 38.1 Least privilege

- Database roles: anonymous (nothing), authenticated users (RLS), restricted worker (RLS with sealed job workspace context), system (system tables only), retention (specific deletes, audited), migration role and service role (migrations and break-glass only; not in runtime) (§11). Runtimes connect only through dedicated `LOGIN NOINHERIT NOBYPASSRLS` login roles, each able to switch only to its fixed runtime role (R1, §11.6).
- Vendor credentials scoped per environment and minimal (e.g., job-runtime keys can trigger tasks but not administer projects).
- Provider app permissions requested only for validated, needed capabilities (PD OQ-27).

### 38.2 Tenant isolation

RLS + action pipeline + job scopes (§9, §11). Cross-tenant lookups return not found.

### 38.3 Provider OAuth token handling

§39.

### 38.4 Encryption

- In transit: TLS everywhere, including database connections.
- At rest: managed encryption for database, backups and storage.
- Application-level envelope encryption for provider credentials (§39), with keys outside the database.

### 38.5 Secret storage

Environment-scoped secret stores of the hosting vendors; no secrets in the repository, fixtures, logs, job payloads, analytics or error reports. Secret scanning in CI (§64). Rotation procedures documented for each secret class.

### 38.6 Webhook signature verification

§40.

### 38.7 Web application security

| Threat | Control |
|---|---|
| **CSRF** | SameSite cookies; Server Actions' origin checks; Route Handlers that mutate with cookie auth verify origin and a CSRF token; OAuth `state` parameter bound to user, workspace and expiry. |
| **XSS** | Comment text, author names, captions and AI output rendered **as text** only (framework escaping; no raw HTML rendering of external content); strict Content Security Policy; links inside comments rendered inert (not auto-linked), with a separate "Open on [platform]" action; malicious-link labels shown as warnings. |
| **SSRF** | The server never fetches URLs found in comments. Link reputation uses a lookup service with the URL string (TA-Q-13). Media fetches, if any, only from allowlisted provider CDN domains. Egress from workers limited to provider, AI and vendor domains where the platform allows egress rules. |
| **Injection** | Parameterized queries via the data layer; input schemas; AI prompt-injection posture (§21.4). |
| **Clickjacking** | Frame-ancestors restrictions. |

### 38.8 Rate limiting and abuse protection

- Edge rate limits on authentication, invitation, webhook and command endpoints.
- Per-user and per-workspace limits on expensive commands (suggestion generation, previews, report regeneration) to bound AI cost abuse.
- Sign-up abuse controls (email verification, invitation limits); provider webhook endpoints reject unverified traffic cheaply.

### 38.9 Operator (support) access

- Support diagnostics rely first on metadata: job runs, intent statuses, provider diagnostics, AI ledger, audit (§42).
- Any operator access to tenant content requires a time-boxed, reason-stated grant, is logged in an operator audit log, and ideally follows customer consent (TA-Q-27). No standing operator access to content.

### 38.10 Audit logs, service identities, environment isolation

Audit: §41. Service identities: §10.4. Environments: §51. **No secrets in logs** is enforced by redaction (§42) and tests that scan log output in CI for credential patterns.

### 38.11 Data classification

| Class | Examples | Rules |
|---|---|---|
| **S — Secrets** | Provider tokens, API keys, signing secrets | Encrypted; never logged, sent to AI, analytics or job payloads. |
| **P — Audience personal content** | Comment text, author handles and names | Tenant-scoped; minimized in AI calls; never in logs, analytics or job payloads; retention per PD OQ-21. |
| **B — Customer business data** | Brand Context, notes, saved replies, escalation notes | Tenant-scoped; never in analytics; AI only for the tasks that need it. |
| **M — Operational metadata** | IDs, counts, statuses, timings | Allowed in logs and metrics. |
| **A — Product analytics** | Pseudonymous event data | Identifiers only (§43). |

---

## 39. Platform token / credential architecture

| Aspect | Design |
|---|---|
| **Encrypted storage** | Credentials stored as ciphertext in a credentials store (separate schema) with **envelope encryption**: a per-record data key (AES-256-GCM, applied in the integration boundary) wrapped by a customer-managed symmetric key-encryption key in **AWS KMS**, outside the database (TA-Q-07 PASS; ADR-64). Every wrap and unwrap carries a mandatory, non-secret encryption context that binds `workspace_id` and `credential_id` (no organization ID, no provider or customer-sensitive values). No user or worker role can select credential rows; the database never holds plaintext. The managed development validation retained one development KEK; the production account/key topology is an explicit production design decision that remains open. |
| **Access boundary** | Decryption happens only inside the integration boundary (integration workers and the executor) through one credential-access function, inside a workspace job scope, for the duration of a provider call. The web deployment encrypts on OAuth callback but never decrypts. Credentials never appear in browser state, job payloads, logs or AI calls. The separation is enforced by the KMS key policy, not only by code: the web principal can only generate data keys (seal); the integration principal (workers and executor) can decrypt; re-wrapping is a controlled `ReEncrypt` path that never exposes data keys and is granted to no runtime principal by default; no runtime principal can administer the key. Decrypted credentials are never cached across calls or jobs. Local development and CI use a deterministic local keyring behind the same crypto port, which must never be usable in a deployed environment. |
| **Refresh lifecycle** | Scheduled refresh before expiry where platforms support it (VALIDATE per platform); refresh failures move the Connection to degraded/disconnected, start a coverage gap and raise an alert. |
| **Revocation** | Detected via provider errors, health checks or deauthorization callbacks where offered; Connection → disconnected; queued intents → BLOCKED with recovery; imported data stays (IA §20). User-initiated removal deletes stored credentials and unsubscribes webhooks when no other active Connected Account needs them (§8.5). |
| **Connection health** | State machine (connecting · active · degraded · disconnected · failed · removed; Model §53-D), driven by health checks and observed errors; feeds capability (temporarily unavailable) and coverage. |
| **Authorizing-user provenance** | Connection records who authorized and when; re-authorization by another permitted person replaces the credential while preserving the Connection identity, recorded in history (D-48). |
| **User departure** | Membership removal doesn't touch the Connection. Whether the provider authorization survives the person losing platform permissions is **PD OQ-26 (VALIDATE)**; health checks detect invalidation and prompt re-authorization. Business-level (non-personal) credentials offered by platforms are preferred where validated. |
| **Secret rotation** | Master key rotation re-wraps data keys without exposing plaintext (KMS automatic key-material rotation; KEK migration through a reviewed `ReEncrypt` path; a provider-token refresh or re-authorization always writes a fresh envelope; production runbooks remain open, §65); provider app secrets rotate per environment with webhook verification supporting a dual-secret window. |

---

## 40. Webhook security

```
 provider → HTTPS POST /api/webhooks/{provider}
   1. Identify provider by route; reject unknown routes
   2. Verify signature over the raw body with the environment's app secret (scheme per provider, VALIDATE;
      e.g., HMAC-based signatures) — constant-time comparison; invalid → 401, nothing stored, security metric
   3. Validate timestamp where the provider supplies one (reject outside tolerance → replay protection)
   4. Validate envelope shape (schema); reject malformed
   5. Compute dedup key (provider event identity, or hash of verified payload)
   6. Insert into provider event inbox (raw payload, verified flag, received time) — duplicate key → no-op
   7. Write outbox row → respond 2xx immediately (target well under provider timeouts)
   8. Async: route via asset registry → per-workspace processing (§14)
```

- **Fail closed:** unverifiable events are never processed. Subscription verification handshakes (where providers require them) are answered only with the environment's configured verify token.
- **Payload preservation:** raw verified payloads are kept in the inbox for a bounded period for replay and debugging (TA-Q-11).
- **Isolation:** the receiver doesn't read tenant data; it only writes to the inbox and outbox (system-scoped insert).
- **Separate apps per environment:** each environment has its own provider app, secrets and webhook URLs, so staging events can never reach production (§51).

---

## 41. Audit architecture

### 41.1 Design

- **Audit Events** are append-only rows written **in the same transaction** as the change they record (Model §40). Runtime roles can't update or delete them.
- Each event: workspace (and organization), action type, object reference, **initiator** (human user · automation policy · system rule such as auto-done/auto-reopen · native platform action (detected) · AI-assisted human action), time (and source time for platform-originated changes), reason (classification + policy, user choice, platform signal), previous/new state summary (minimal, no secrets, minimal personal content), reversibility and link to the reversing event, correlation ID.
- **Domain history records** (assessments, moderation events, workflow events, automation decisions, decision events) remain the authoritative history for domain reasoning; audit events reference them. Audit is the cross-cutting accountability ledger, not a duplicate store of content.

### 41.2 Coverage of consequential actions

| Action | Audited with |
|---|---|
| Replies (public and private) | Outbound Reply, starting point (suggestion/saved/manual), edit extent, outcome; private reply also leaves a Conversation history marker |
| Moderation (single, bulk, automatic, native) | Moderation Event; bulk exclusions counted; protected-at-time flag for single hides |
| Automation decisions | Automation Decision (all steps, veto reason) |
| Undo | Reversal event linked to the original (precision signal) |
| Workflow state (manual and automatic) | Workflow Event with initiator |
| Assignment, escalation | Events with actor and target |
| Classification / topic corrections | Human assessments |
| Policy changes (state, scope, pattern, preview), kill switch | Policy history, preview identity |
| Workspace mode changes | Mode history + effects (policies suspended/paused, intents blocked) |
| Connection changes (added, revoked, reconnected, removed, moved) | Connection history |
| Recommendation decisions | Decision events; Tracked Action creation/retirement |
| Brand Context and saved reply changes | Item versions |
| Memberships and permission changes | Membership history |
| Operator access and retention deletions | Operator audit log; retention audit |

**Never in audit:** credentials, tokens, secrets, full raw payloads.

---

## 42. Observability

### 42.1 Signals

| Signal | Design |
|---|---|
| **Structured application logs** | JSON lines with level, message, module, command/query name, correlation ID, request ID, workspace and organization IDs, actor type (never names), duration, outcome code. Redaction middleware strips class S and P data (§38.11). |
| **Worker / job logs** | Same format plus job type, job run ID, attempt number, idempotency/dispatch key, lane, queue key. |
| **Error tracking** | Sentry for web and workers, with release, environment, correlation ID; payload scrubbing enabled; no request bodies containing comment text. |
| **Metrics** | Derived from logs and domain tables initially (§42.2). |
| **Traces** | Sampled traces for web requests and jobs; trace context propagated through outbox rows into jobs and into provider and AI calls (as spans with sanitized attributes). |
| **Correlation / request IDs** | Generated at the edge (or taken from the webhook event identity), stored on intents, outbox rows, AI ledger entries, audit events and provider diagnostics. One ID follows a user action from click to provider confirmation. |
| **Workspace-safe context** | IDs only; human-readable names resolved in support tooling under authorization. |
| **Provider request diagnostics** | Per call: provider, endpoint category, API version, status, latency, provider request ID, rate-budget signals, normalized error class. Never tokens or raw bodies in logs (raw bodies live only in the inbox for inbound events). |
| **AI task diagnostics** | AI call ledger (§22.1): task/prompt/schema versions, model, tokens, cost, latency, outcome, validation failures. |
| **Cost metrics** | AI cost per workspace/task/day; provider call volume per app and account; job compute usage. |

### 42.2 Key operational metrics and alerts

| Metric | Why |
|---|---|
| Ingestion lag (provider time → persisted) per platform | Freshness; detects missed webhooks |
| Outbox age (oldest undispatched) | Lost dispatch |
| Queue depth and job failure rate per job type | Throughput and errors |
| Understanding latency (persisted → classified) | Inbox quality and automation timing |
| Mutation outcomes (confirmed / failed / unknown / blocked) per platform and action | Provider health; safety |
| Auto-hide volume and Undo rate per policy type | Precision (PD §19.2) |
| Webhook verification failures | Attack or misconfiguration |
| Connection health transitions; token refresh failures | Coverage gaps |
| AI validation failure and refusal rates per task version | Model/prompt regressions |
| AI cost vs budget | Unit economics (PD A-09) |
| RLS-empty-result anomalies in jobs (job read nothing when it should have) | Missing tenant scope bugs |

Alert routing to an on-call channel for SLO breaches (§60). Runbooks per alert.

### 42.3 Diagnosability without database spelunking

Support and engineering tooling (internal, authorized) answers common questions from these signals: "why wasn't this comment imported?" (inbox → routing → job run → coverage), "why was this hidden?" (Automation Decision + mutation intent + provider diagnostics), "why did this reply fail?" (intent outcome + provider error class), "why is this insight saying X?" (lineage). The **product UI** already answers many of these for customers (Why it's here, Hidden automatically, activity history).

---

## 43. Product analytics

### 43.1 Separation

| | **Product usage analytics** | **Customer social intelligence** |
|---|---|---|
| Purpose | How customers use our product | What the customer's audience says |
| Store | PostHog (vendor) | Our Postgres, per workspace |
| Content | Event names, pseudonymous IDs, counts, enums | Comments, labels, insights |
| Access | Product team | Customer roles per RLS |
| Never contains | Comment text, author identities, Brand Context, notes, reply text | — |

### 43.2 Event categories (examples)

| Category | Events (illustrative) | Properties (identifiers and enums only) |
|---|---|---|
| Onboarding | organization created, workspace created (mode chosen), onboarding completed | org/workspace IDs, chosen mode |
| Connections | account connected, connection failed, connection revoked | platform, asset kind, failure class |
| Inbox | Inbox opened, view used, conversation opened, bulk action used | view key, counts |
| Replies | reply sent (public/private), starting point, suggestion accepted / edited / dismissed / flagged | platform, starting point enum, edit-extent bucket, grounding state |
| Moderation | hide/unhide/delete/block (human), auto-hide undone | platform, action, initiator type |
| Automation | policy enabled/paused/resumed, preview run, pause all | policy type, scope enum |
| Intelligence | insight opened, insight marked not useful, recommendation accepted / dismissed / done, follow-up viewed | action type enum |
| Reports | report opened, report regenerated | type, period length |
| Workspace | mode changed, member invited, role changed | mode, role |

Server-side capture for domain events (reliable); client-side capture for navigation only. Consent handling per market (TA-Q-09).

---

## 44. Error model

### 44.1 Normalized taxonomy

| Error code | Meaning | Retryable? | UX mapping (UX §25, §26) |
|---|---|---|---|
| `PERMISSION_DENIED` | Role/grant doesn't allow | No | Control hidden; deep link → access page ("You don't have access to this. Ask a workspace admin.") |
| `NOT_FOUND` | Object doesn't exist **or** isn't visible in this tenant | No | "This item isn't available" (never reveals cross-tenant existence) |
| `MODE_BLOCKED` | Workspace is Monitor-only | No | Visible but unavailable: "This workspace is Monitor-only." (+ change-mode link for Owner/Admin) |
| `CAPABILITY_UNSUPPORTED` / `CAPABILITY_UNKNOWN` | Platform doesn't offer it / not validated | No | Visible but unavailable with platform reason; "Open on [platform]" where useful |
| `CONNECTION_PROBLEM` | Credential invalid, connection degraded/disconnected | After recovery | Blocked with recovery (Reconnect / Notify an admin); drafts kept |
| `PROVIDER_RATE_LIMITED` | Provider throttling | Yes (after retry-after) | "Sending…" persists, then "Delayed by [platform]; we'll retry" |
| `PROVIDER_TRANSIENT` | Timeouts, 5xx, outage | Yes | "[Platform] isn't responding. We'll retry." Drafts kept |
| `PROVIDER_PERMANENT` | Rejected (e.g., target removed, not eligible) | No | Outcome language: "This comment is no longer on [platform]"; capability profile updated where relevant |
| `OUTCOME_UNKNOWN` | Mutation may have succeeded | Verify first | "We couldn't confirm this was sent. Checking…" then confirmed/failed after reconciliation; private reply: "check on [platform]" |
| `INVALID_INPUT` | Schema/validation failure | No | Inline field messages |
| `CONFLICT` | Optimistic concurrency failure or idempotent duplicate (returns the original result) | No | "Updated by [name] just now" / no-op success for duplicates |
| `STALE_STATE` | Conversation changed since the user loaded it (e.g., teammate replied) | User decides | "[Name] replied 1 minute ago." Send, edit or discard (UX §10.4) |
| `PROTECTION_VETO` | Automation veto (recorded, not user-facing) or bulk-hide exclusion | No | Bulk: "3 comments excluded: complaints and objections can't be hidden in bulk" / "2 comments excluded: they need individual review" (uncertain, PD D-52) |
| `AI_INVALID_OUTPUT` | Schema validation failed after re-ask | Limited | Classification: Needs review; suggestion: "Couldn't produce a suitable suggestion" |
| `AI_UNAVAILABLE` / `AI_REFUSED` / `AI_BUDGET_EXCEEDED` | Provider down, refusal, budget cap | Yes / No / No | Same as above; budget: "Suggestions are temporarily unavailable" (plan limits per PD OQ-14) |
| `JOB_FAILED` | Job exhausted retries | Manual/automatic re-drive | Surface the domain consequence: import "Failed — retry", report "Couldn't generate — retry", coverage Failed |

### 44.2 Rules

- **Precedence matches IA §18:** when several apply, the resolver returns the most fundamental (permission → mode → capability → connection).
- Errors carry a **reason code + localized message key + parameters**, never implementation vocabulary (IA §2.6).
- Internal error details go to logs and Sentry with the correlation ID; the user sees outcome language.

---

## 45. Provider rate limits / backoff

| Mechanism | Design |
|---|---|
| **Platform-specific limits** | Not assumed until API validation (PD OQ-18). Each adapter exposes normalized budget signals (remaining, reset, retry-after) parsed from provider responses where available. |
| **Budgets** | Budget state per (provider app), (provider, connected account) and, where relevant, per endpoint category, stored in Postgres and consulted before calls. App-level budgets are shared across all customers, so they are the first scale pressure point (§59). |
| **Retry-after** | Honored exactly; jobs reschedule rather than sleep. |
| **Exponential backoff + jitter** | For transient errors and throttling without retry-after; capped. |
| **Per-provider / per-account concurrency** | Job-runtime queues keyed by (provider, account) with low concurrency; global concurrency per provider app. |
| **Priority lanes** | User mutations > realtime ingestion > reconciliation > intelligence > backfill (§19.5); a reserved share of each account's budget is kept for lane 1. |
| **Reconciliation after failure** | After throttling windows or outages, a reconciliation pass checks for missed objects (§47). |
| **Circuit breakers** | Repeated provider failures for an account or platform open a breaker: jobs pause, coverage is marked, users see the outage state (UX §26), probes retry. |

---

## 46. Failure and recovery model

| Failure | Recovery principle |
|---|---|
| **Webhook missed** | Polling and reconciliation fetch what webhooks missed; ingestion lag metrics alert on gaps; coverage stays truthful. |
| **Duplicate webhook** | Inbox dedup key and idempotent upserts (§18). |
| **Historical import partially fails** | Checkpoints resume; failed slices recorded as Failed coverage with reason; import completes with what's available; retry offered; UI states partial coverage (UX §5.4). |
| **AI classification fails** | Retries; then interaction becomes uncertain → Needs review; protection = uncertain → automation veto; a re-drive job retries later. Nothing is hidden or dropped. |
| **AI output invalid** | Fail closed (§23.2): no assessment; same as above. |
| **Provider mutation times out after possibly succeeding** | Intent → OUTCOME_UNKNOWN; reconciliation verifies platform state; hide/unhide/delete/block converge safely; replies are never blindly resent; private reply shows "check on [platform]" if unverifiable (§18.3). |
| **Connection revoked mid-job** | Job stops at next provider call with CONNECTION_PROBLEM; checkpoint kept; Connection → disconnected; coverage gap starts; queued intents → BLOCKED with recovery; resumes after re-authorization. |
| **Worker crashes** | Trigger.dev does **not** retry a run whose worker process crashed; the run-outcome sweeper re-dispatches CRASHED / SYSTEM_FAILURE runs with the same dispatch key (R7, §19.3) and the new run resumes from the last checkpoint; idempotent steps; intents are committed EXECUTING before the provider call, so a crash between provider call and outcome write becomes OUTCOME_UNKNOWN → reconciliation (R6). |
| **Report generation fails** | Retry; previous generation stays available; UI shows "Couldn't generate — retry"; no partial report is published. |
| **Aggregate becomes stale** | As-of times are always displayed; dirty-mark sweeper re-triggers refresh; staleness metric alerts beyond threshold. |
| **Database temporarily unavailable** | Web returns a calm error; webhooks return non-2xx so providers retry (where they do) and reconciliation covers the rest; jobs retry with backoff; outbox guarantees no lost follow-ups once the database is back. |
| **Connection pooler refuses connections** | Web returns a calm error; jobs retry with backoff; outbox rows accumulate and drain when the pooler returns; pooler health is monitored separately from database health; never "fixed" by dropping or recreating runtime roles (R8, §11.7); vendor escalation. |
| **Job runtime unavailable** | Outbox rows accumulate; sweeper dispatches when available; user commands still create intents (shown as "Sending…" until executed); alert on outbox age. |
| **AI provider outage** | Gateway fallback (if an eval-approved fallback exists) or degrade: items wait or go to Needs review; suggestions unavailable; automation naturally pauses (no NOT PROTECTED results). |
| **Bad deployment** | Instant rollback of web; job runtime version rollback; migrations are expand-only during the release (§65). |

---

## 47. Reconciliation architecture

### 47.1 Purpose

Detect drift between **platform state** and **product state** where official APIs allow reading it (PD OQ-18). Webhooks are hints; reconciliation is the safety net.

### 47.2 What is reconciled

| Drift | Detection | Product effect |
|---|---|---|
| Missing interaction | Re-list recent windows per account/content; compare provider identities | Ingest missing items (normal pipeline; automation only if they meet the forward-only eligibility rule, §25.7) |
| Native reply | Brand-authored replies not linked to an Outbound Reply | Brand Interaction; auto-Done "Replied on platform" when it follows the latest audience message (UX-04) |
| Native hide/delete | Observed state differs from product state | Native Moderation Event; never reverted automatically |
| Changed content state | Content removed/restricted | Content observed state; conversations remain as history (Model §45) |
| Revoked connection | Health checks, permission errors | Connection disconnected; coverage gap; alerts |
| Unknown mutation outcomes | Look up our reply under the parent / read visibility state | Intent → CONFIRMED or FAILED |
| Paid-context changes | Ads ended/paused, new ad → content links | Paid-context observations; confounders for follow-ups |

### 47.3 Rules

- **Absence isn't deletion until confirmed:** an object missing from one listing is re-fetched directly; "removed at source" requires an explicit provider signal or a confirmed absence on direct fetch with a healthy connection.
- Reconciliation runs in lane 3, within rate budgets, per account; cadence is decided after API validation (no schedule fixed here).
- Every reconciliation correction is recorded as an observation/event with initiator "native platform change (detected)" or "system (reconciliation)".

---

## 48. Data consistency model

### 48.1 Strong consistency (single transaction, consistent reads)

| Area | Why |
|---|---|
| Authorization: membership, role, grants | Access must reflect removals immediately. |
| Workspace mode | Monitor-only must block every mutation from the moment it's set (§26.6). |
| Automation veto inputs at execution (policy state, current protection) | Safety. |
| Mutation intent creation and idempotency | No duplicate replies or hides. |
| Workflow state transitions (with optimistic concurrency) | Avoid lost updates between teammates. |
| Recommendation decisions and the one-active-Tracked-Action rule (M-12) | Constraint integrity. |
| Policy state transitions (IA-16 on mode change) | Never resume silently. |
| Accepted interpretation recompute on human correction | Immediate operational effect (Model §47). |
| Audit + history with the change | Accountability. |

### 48.2 Eventual consistency (asynchronous, with as-of times)

| Area | Typical delay (recommendation, §60) |
|---|---|
| Classification of new interactions | Seconds to a couple of minutes |
| Topic assignment | Minutes |
| Aggregates and VoC counts | Minutes (debounced) |
| Observations, insights, drivers, recommendations | Scheduled refresh (e.g., hourly) + debounced triggers |
| Guest projections | After intelligence refresh |
| Reports | Per generation |
| Attention signals, alerts | Seconds to minutes |
| Search (if indexes are synchronous columns, immediate) | Immediate to minutes |
| Product analytics | Minutes |

### 48.3 UI implications

- Surfaces that aren't live show **as-of** times (Model §48).
- After a correction: the conversation updates immediately; intelligence shows "Insights will reflect this correction shortly" (UX §16.1).
- New interactions may appear **before** classification completes: they are shown without labels (presentation decided in design) and are never treated as harmless; Needs review absorbs items whose understanding fails.
- Platform actions show **Sending… → Sent/Failed** from intent outcomes; internal actions are immediate with Undo.
- Optimistic UI is allowed only for internal, reversible actions; never for platform mutations.

---

## 49. Client guest security

### 49.1 Allowed and denied

| Guests may read | Guests may not reach (by URL, API, search, realtime or export) |
|---|---|
| Insights (current guest view), Voice of Customer aggregates, topic pages (examples only), Recommendations (read-only, status, follow-ups), Reports (guest rendering) | Inbox, conversations, interactions beyond guest-safe excerpts, full conversation history, conversation-set resolution, Content & Ads, content links, internal actions, internal notes, escalations, operational history, audit, Home, alerts, organization views, attention signals |

### 49.2 Enforcement below the frontend

1. **Data shape — guest projections:** projection jobs write guest-safe read models: insight guest views (statement, scope phrasing, change, drivers, recommendation status), **guest evidence items** (excerpt text with personal-data scrubbing, language, platform, content **name** only, date, author display per M-11 default minimization), VoC and topic aggregates, report guest renderings. They contain **no internal identifiers** of interactions, conversations or content that could be used to request operational data.
2. **RLS:** the guest role (a membership role) has read access **only** to guest projection tables of granted workspaces. Every operational and base intelligence table denies guests (§11.2).
3. **Action pipeline:** every operational query and command requires a non-guest permission (§10.3); guests get PERMISSION_DENIED → access page (UX §4.2).
4. **Search:** guest search queries only guest projections (§36).
5. **Realtime:** guests aren't authorized on operational channels (§34).
6. **Exports/share links (future, PD OQ-15):** generated only from guest renderings for guests.
7. **Tests:** the security matrix includes direct-URL and direct-API attempts by guests on every operational route and table (§55).

---

## 50. Cross-workspace attention

### 50.1 Read model

One **Workspace Attention Signal** row per workspace, computed **inside** the workspace by a workspace-scoped job:

| Field | Meaning |
|---|---|
| needs attention | Overall indicator |
| urgent interactions | Count |
| reputation risk | Flag + short reason code |
| growing backlog | Trend indicator |
| connection issue | Flag |
| Monitor-only | Mode indicator |
| as-of | Computation time |

Criteria are configuration pending **PD OQ-25**.

### 50.2 Isolation

- The All workspaces page and switcher indicators query **only** this table. RLS returns rows for workspaces where the user is a non-guest member (IA-05: guests see none).
- No organization-level query touches conversations, interactions, topics or intelligence tables. No aggregation across workspaces exists in code: the attention module has no query that spans workspaces except "read my signal rows".
- Clicking a signal **enters** the workspace (IA §16.3); everything further runs under that workspace's tenant context.
- Recomputation: debounced triggers from workflow, classification and connection changes, plus a periodic sweep (fan-out = one job per workspace).

---

## 51. Environment strategy

| Environment | Purpose | Database | Provider credentials and webhooks | AI keys | Jobs | Storage |
|---|---|---|---|---|---|---|
| **Local** | Daily development | Local Postgres stack (Supabase CLI in containers), seeded with synthetic data | **Simulator** by default; optional personal sandbox apps | **Stub** by default; optional dev key with tiny budget | Local job runtime dev mode | Local storage emulation |
| **Preview** (per pull request) | Review UI and flows | Isolated preview database (Supabase branching or shared dev project with per-branch schema; TA-Q-25), synthetic seeds | **Simulator only**; no real provider webhooks | Stub or low-budget dev key | Preview environment of the job runtime | Preview bucket |
| **Staging** | Pre-production validation, real provider sandbox testing, eval runs | Separate project; synthetic + sandbox data only | **Dedicated provider apps** (test/sandbox apps and test pages/accounts), staging webhook URLs and secrets | Staging key with budget cap | Staging environment | Staging buckets |
| **Production** | Customers | Production project with PITR | Production provider apps (after app review, PD OQ-27), production secrets | Production keys with budget alerts | Production environment | Production buckets |

**Isolation rules:** no production data in any other environment; no shared secrets; separate provider apps per environment so webhooks can't cross; separate job-runtime environments and AI keys; environment name on every log, trace and analytics event. Staging is justified because provider integrations need a real-but-safe target and app review needs a stable test environment.

---

## 52. Local development strategy

| Need | Approach |
|---|---|
| Local application | Next.js dev server; job runtime dev mode executing tasks locally against the local database. |
| Local / test database | Local Postgres stack with the same migrations, RLS policies and roles as production; reset-and-seed command. |
| Fixtures | Sanitized provider fixtures and scenario files in the repository (§53). |
| Provider simulators | The **simulator adapter** implements both ports: serves content, comments and replies from scenarios; accepts mutations and changes simulated state; can inject failures (rate limits, timeouts with ambiguous outcome, revoked credentials, deletions at source, edits, native replies, webhook duplicates and out-of-order delivery). |
| Fake webhook payloads | A local tool that signs fixture payloads with the local test secret and posts them to the webhook endpoint, including invalid-signature and replay cases. |
| AI stubs / mocks | Gateway "stub provider" returning deterministic structured outputs keyed by input hash and fixture files; a "record/replay" mode stores real responses from staging runs for regression tests (with synthetic inputs). |
| Deterministic test data | Seed generator producing multilingual synthetic comments (es variants, pt-BR, en, code-switching), covering every taxonomy branch and safety edge case (complaint with insult, "estafa" as accusation vs as scam content, obvious spam with link, bot patterns). No real personal data. |

Most of the product — tenancy, Inbox, workflow, moderation and automation logic, executor guards, intelligence pipelines — can be built and tested without touching real Meta or TikTok APIs.

---

## 53. Provider sandbox / fixture strategy

| Element | Design |
|---|---|
| **Raw fixture capture** | Only from provider sandbox/test accounts in staging, via a capture tool. Raw captures stay in a restricted location, never committed. |
| **Sanitized fixtures in the repository** | Captures are scrubbed (names, handles, IDs replaced; text replaced with synthetic text preserving structure, emojis, languages, edge cases) and committed with the provider API version recorded. |
| **Contract tests** | For each adapter: fixture in → normalized DTO out (golden files); error fixtures → normalized error classes; pagination and cursor handling; webhook parsing and signature verification. |
| **Simulator parity tests** | The same contract tests run against the simulator, so it behaves like the real adapters' normalized output. |
| **Live contract checks** | Scheduled, non-blocking checks in staging against sandbox accounts detect provider drift and deprecations; failures alert and update fixtures through review. |
| **Legal/contractual** | Fixture use respects platform terms; only sandbox-derived, sanitized data is stored long-term (PD OQ-21, OQ-27). |

---

## 54. Test architecture

| Layer | What it covers | Runs |
|---|---|---|
| **Unit** | Pure functions: precedence (M-05), protection combination, automation evaluator steps, availability resolver, coverage math, Measured values, statistical gates, workflow rules, priority factors, grounding validators. | Every commit |
| **Domain invariant** | Property-style tests over generated inputs for Model §50 invariants (e.g., no input combination makes the evaluator return HIDE for protected or uncertain; sentiment never changes a decision). | Every commit |
| **Database integration** | Repositories against a real Postgres with migrations; history written with every state change; uniqueness (M-01 rule, M-12, idempotency keys); append-only grants. | Every PR |
| **RLS / tenant isolation** | For every table: user in workspace A can't read/write workspace B; guests can read only guest projections; worker role without tenant context reads nothing; system role can't read tenant content. **Schema introspection:** every table is classified and has RLS enabled. | Every PR |
| **Job** | Job wrappers set tenant scope; idempotent re-runs; checkpoint resume; outbox dispatch and sweeper; priority and concurrency keys. | Every PR |
| **Provider adapter contract** | Fixture → DTO, errors, pagination, webhook verification (§53); simulator parity. | Every PR; live checks scheduled in staging |
| **AI structured-output** | Each task's schema and validators: malformed outputs rejected, unknown keys rejected, references validated, fail-closed paths produce no assessment. Uses stubs. | Every PR |
| **AI eval** | Quality and safety metrics on evaluation datasets (§56). | On prompt/model/task changes (gated) and nightly |
| **Integration** | End-to-end flows inside the backend with simulator + stub AI: ingest → understand → automation → executor → outcome; reply flows; mode switches; corrections. | Every PR |
| **End-to-end** | Browser tests for critical journeys (onboarding with simulator, triage, reply, hide/undo, automation preview/enable, Monitor-only, guest journey). | PR (smoke subset) and pre-release (full) |
| **Security regression** | The matrix in §55, plus CSRF, XSS rendering of hostile comment text, SSRF (no URL fetching), secret-in-log scans, webhook signature/replay cases. | Every PR |

Additional structural checks: dependency-boundary lint (§6.4); "every exported command is registered with the action pipeline"; "every state-changing repository method writes history"; "no service-role key or migration credential in runtime environment definitions"; "every tenant table has RLS enabled and forced, with explicit grants" (R4).

---

## 55. Critical security / safety test matrix

| # | Test | Asserts | Layer |
|---|---|---|---|
| T-01 | **Workspace A cannot read Workspace B** | Queries, commands, search, realtime subscription and storage access across workspaces return not found/nothing, for every role. | RLS, integration, e2e |
| T-02 | **Client guest cannot access Inbox by URL/API** | Direct routes, server actions, queries and table reads for conversations, interactions, notes, Content & Ads, audit, Home, alerts → denied; search returns only guest projections. | RLS, security, e2e |
| T-03 | **Responder cannot perform Manager-only actions** | Automation configuration, recommendation decisions, default escalation contact, delete/block without grant → PERMISSION_DENIED; Analyst cannot perform any action. | Integration |
| T-04 | **Monitor-only cannot trigger platform mutation** | Human commands → MODE_BLOCKED; intent insert rejected by database backstop; queued intents → BLOCKED at execution; automation evaluator vetoes; policies Suspended. | Unit, DB, integration |
| T-05 | **Uncertain protection cannot auto-hide** | Missing/low-confidence/failed assessments → protection uncertain → decision NEEDS REVIEW; executor rejects. | Unit, invariant, integration |
| T-06 | **Protected complaint cannot auto-hide** | Complaint, product problem, fraud accusation against the brand, commercial objection → veto, including when combined with abuse or a matched keyword ("estafa"). | Invariant, integration, AI eval |
| T-07 | **Abuse cannot auto-hide** | No policy type can target abuse; evaluator excludes it at step 4. | Unit, invariant |
| T-08 | **AI cannot send** | No code path from AI tasks to the executor (boundary lint); executor rejects reply requests lacking a human interactive command; suggestions never create Outbound Replies. | Lint, integration |
| T-09 | **Duplicate webhook doesn't duplicate interaction** | Same event delivered N times (and out of order, and overlapping backfill) → one interaction, one text version. | Integration |
| T-10 | **Duplicate mutation request doesn't double reply/hide** | Same request key twice → one intent; worker retry after crash → one provider call or verified OUTCOME_UNKNOWN; public reply never resent without verification. | Integration (simulator fault injection) |
| T-11 | **Service job cannot accidentally query all workspaces** | Worker role without tenant context reads nothing; system role reading tenant tables → denied; fan-out produces per-workspace jobs. | RLS, job |
| T-12 | **Private reply cannot create incoming DM data** | Adapter contract has no private-message read operation; a private reply creates an Outbound Reply + history marker and **no** Interaction; no DM tables, views or subscriptions exist (schema check). | Contract, integration, schema |
| T-13 | **Source facts cannot be replaced by AI interpretation** | Source text versions are insert-only; classification module has no write path to source tables; a human correction or reassessment leaves source facts unchanged. | DB, lint, integration |
| T-14 | **Human corrections survive reprocessing** | Reassessment with a new model version never changes an accepted interpretation set by a human. | Unit, integration |
| T-15 | **Automation never resumes silently** | Monitor-only → Standard sets all policies Paused; link/pattern policies can't activate without a fresh preview after the transition. | Integration |
| T-16 | **No bulk delete/block; delete/block human-only** | Bulk request type can't express them; automation request type can't express them; executor rejects otherwise. | Unit, integration |
| T-17 | **Bulk hide excludes protected and uncertain items** | Protected and uncertain items excluded and counted, with the individual-review explanation; excluded items remain individually moderatable by permitted humans; bulk hides attributed to the person, absent from Hidden automatically. | Integration |
| T-18 | **No data ≠ zero** | Aggregates over failed/unavailable/unknown coverage return NOT_AVAILABLE; UI number components refuse plain numbers. | Unit, e2e |
| T-19 | **Cross-workspace stays attention-only** | Organization-level queries read only attention signals; guests get none. | RLS, integration |
| T-20 | **One active Tracked Action** | Concurrent "mark done" requests → one active Tracked Action; reopen retires it. | DB |
| T-21 | **Credentials never leak** | Credentials unreadable by user/worker roles; absent from logs, job payloads, analytics, AI calls, browser responses. | DB, security |
| T-22 | **Webhook verification fails closed** | Bad signature, stale timestamp, replay → rejected and not processed. | Security |
| T-23 | **Sentiment never drives moderation** | Changing only sentiment never changes priority-to-hide recommendation or automation decision. | Invariant |
| T-25 | **Automation is forward-only** | Enabling, resuming or re-enabling a policy never hides interactions created or imported before activation; backfill, reprocessing, model upgrades and corrections never create automation intents. | Integration, invariant |
| T-26 | **Pooled-connection tenant context is safe (TA-Q-29)** | The 13 checks in §11.6 **and the TA-Q-29 adversarial cases** are permanent regression tests: A → B → no-context sequences on reused pooled backends; concurrent multi-tenant stress; missing, foreign, forged, replayed and rebound context; leftover session-level state neutralized by the seal (R2); role escalation from every runtime login and the token role-claim allowlist (R1, R3); forced RLS, grants and default-privilege introspection (R4); composite-FK existence oracle (R5); no service-role or migration credential in runtime environments. | RLS, security |
| T-27 | **Crashed runs and unknown outcomes recover safely (R6, R7)** | A crashed run is re-dispatched by the run-outcome sweeper and its domain effect happens exactly once; an intent found EXECUTING without an outcome never calls the provider blindly; ambiguous replies are reconciled, never resent. | Job, integration (fault injection) |
| T-24 | **Insight numbers match aggregates** | Narrative numbers equal structured values; drivers labeled as hypotheses; follow-ups labeled descriptive. | Unit, AI structured-output |

Every invariant in Model §50 maps to at least one test (Appendix A).

---

## 56. AI evaluation architecture

### 56.1 Datasets

- **Per language and region:** Spanish variants (e.g., Chile, Mexico, Argentina, Colombia), Brazilian Portuguese, English, and code-switched text (PD §16; OQ-28).
- **Sources:** synthetic data authored to cover the taxonomy and edge cases; sandbox-derived samples; customer-derived samples **only** with an approved legal basis (TA-Q-15).
- **Labeling:** multi-dimension labels with double annotation for safety-critical dimensions; disagreements adjudicated.
- **Adversarial sets:** prompt injection in comments, sarcasm, slang, "estafa/golpe/scam/fraud" used as accusation vs as scam content, abusive complaints, spam with positive sentiment, look-alike brand impersonation.

### 56.2 Metrics

| Area | Metric (examples) | Emphasis |
|---|---|---|
| Classification by dimension | Precision/recall/F1 per value, per language | Per-language reporting; no single global score |
| **Protected complaint recall** | Share of protected interactions evaluated as protected or uncertain | **Primary safety metric.** Must approach 100% for automation to be allowed |
| **Spam / malicious link precision** | Share of auto-hide candidates that are truly harmful | Target per PD §19.2 (PROPOSED ≥ 99%), set in OQ-28 work |
| Bot detection | Precision of "obvious bot" | Precision over recall |
| Risk detection | Recall of high/critical risk | Recall emphasis (surfacing) |
| Language quality | Detection accuracy incl. mixed; suggestion language correctness and register | Per region |
| **Reply groundedness** | Share of factual claims supported by provided Brand Context or the conversation | Must be ~100%; validator catches the rest |
| **Hallucination** | Fabricated prices, policies, contacts, promises | Zero tolerance in shipped suggestions |
| Topic consistency | Agreement with gold topics; stability across languages | |
| Insight support | Numbers match aggregates; claims supported by evidence; drivers phrased as hypotheses | LLM-assisted grading + human review |

### 56.3 Process

- **Offline gates:** a prompt, schema or model change can't reach production unless its eval run meets the task's gates (thresholds set later, PD OQ-16/OQ-28; none chosen here).
- **Shadow runs:** new task versions run alongside production on live traffic without being accepted, then compared.
- **Automation release gate:** auto-hide stays disabled per platform and policy type until the safety metrics pass for the relevant languages (§25.8). Safety metrics are weighted over coverage metrics.
- **Production feedback:** corrections, Undo of automatic hides, suggestion edits/flags, "not useful" insights feed monitoring dashboards and (with legal basis) future eval sets.

---

## 57. Model / prompt versioning

Every AI-produced record (assessment, suggestion, insight version, driver, recommendation draft, report narrative) stores:

| Field | Purpose |
|---|---|
| Provider | Substitution analysis |
| Model identifier and model version/snapshot as reported | Regression analysis, audits |
| Task identifier + task version | Contract identity |
| Prompt template version + content hash | Exact instructions used |
| Output schema version | Validation context |
| Taxonomy / topic catalog version | Meaning of keys |
| Time | Temporal truth |
| Input references | Interaction + source text version, context objects (Brand Context item versions, evidence IDs, aggregate snapshots) |
| AI call ledger reference | Cost, latency, outcome |

This enables audits ("why was this labeled a complaint?"), regression analysis between versions, targeted reprocessing (only records from version X), cost comparisons and correction analysis per version.

---

## 58. AI cost control

| Mechanism | Design |
|---|---|
| **Deterministic first** | Own-brand detection, dedupe, URL reputation, pattern candidates and language pre-detection run before any model; brand-authored interactions don't need full understanding. |
| **Task routing by tier** | Fast tier for high-volume understanding and topics; balanced for suggestions and protection checks; high reasoning only for low-volume intelligence (§21.2). |
| **No repeated classification** | Assessments are keyed by (interaction, text version, task version); retries and re-deliveries reuse them (§18). |
| **Reuse accepted assessments** | Intelligence works from accepted interpretations; it never re-classifies. |
| **Cache only where semantically safe** | Translations per text version and language; prompt-prefix caching for stable instructions and workspace Brand Context blocks. **No** reuse of one interaction's interpretation for another, even with identical text (context differs). |
| **Batch processing** | Historical import and reprocessing use provider batch APIs where available (lower cost, asynchronous). |
| **Gated intelligence** | Observations must pass statistical gates before any drafting call; below minimum volume there is no LLM call. |
| **Targeted second opinions** | The protection check (A′) runs only on automation candidates. |
| **On-demand features** | Translation on request; suggestion preparation mode decided by cost modeling (UX-08). |
| **Budgets and telemetry** | Per-workspace and per-task cost tracking; soft alerts and hard caps tied to plan limits (PD OQ-14, C-08); global spend alerts. |

Quality is not lowered to fit the entry price (PD C-08): if unit economics don't fit, plan limits change (comment volume, history depth, AI usage), not the safety design or model quality for safety-critical tasks.

---

## 59. Scale model

| Stage | Rough shape | Architecture behavior | First pressure points |
|---|---|---|---|
| **A. Early MVP** | Tens of workspaces; up to tens of thousands of interactions per day overall | Everything as described; single database; default job concurrency | Provider validation gaps; AI cost per interaction; correctness bugs |
| **B. Hundreds of workspaces** | Hundreds of thousands of interactions per day | Tune indexes; partition large append-only tables (assessments, audit, observations, AI ledger, event inbox) by time; separate job queues per lane; read-heavy queries on a read replica where the platform allows | **Provider app-level rate limits** (shared across customers); AI spend; aggregate query latency |
| **C. Thousands of workspaces** | Millions of interactions per day | Daily rollups or an analytical store for aggregates; dedicated worker pools per lane; more aggressive batching; realtime channel tuning; possibly a cache for hot reads/rate limiting (§35 triggers) | Database write throughput; job throughput; realtime connections; backfill load at onboarding peaks |
| **D. Larger scale** | Far beyond C | Consider extracting ingestion as its own service, sharding by organization, a dedicated search index, an event bus — only when measured | — |

Nothing for stage D is built now. Each stage's changes are triggered by measured metrics (§42), not anticipation.

---

## 60. Performance targets

**Recommendations for engineering, not product promises.**

| Area | Initial target (recommendation) |
|---|---|
| Page interaction latency (server time for typical surfaces) | p95 under ~300–500 ms; first contentful render fast enough to feel instant on Inbox and Home |
| Inbox list read | p95 under ~500 ms for typical workspaces (thousands of open conversations), with keyset pagination |
| Conversation detail | p95 under ~400 ms |
| Sending replies | Command acknowledged ("Sending…") in under ~300 ms; provider confirmation typically within seconds, subject to platform latency |
| Acknowledging provider webhooks | Under ~500 ms p95 (well within provider timeouts; exact limits VALIDATE) |
| Import progress responsiveness | Progress updates at least every few seconds while importing (per checkpoint) |
| Job pickup | Lane 1 (user mutations): under ~5–10 s; lane 2 (realtime ingestion/understanding): under ~30–60 s; lower lanes: best effort |
| Classification freshness | New interactions understood within ~1–2 minutes p95 (realtime path); backfill classified within hours depending on volume |
| Aggregates | Fresh within ~15 minutes of changes |
| Insights | Refreshed at least daily, more often when debounced triggers fire |

---

## 61. Data retention readiness

PD OQ-21 remains open; no retention periods are decided here. The architecture makes later policies implementable:

| Capability | Design |
|---|---|
| **Retention windows** | Every row carries workspace, organization, source/observed/created times and its data class (§38.11), so time-based retention can run per class and scope. Large append-only tables are time-partitioned (stage B) for efficient expiry. |
| **Source-data deletion** | Deleting source text and author identity can leave **tombstones** (identity + "removed per retention" + time) so lineage stays explainable and aggregates stay countable without content. |
| **Account disconnect cleanup** | Per Connected Account scope deletion (PD OQ-13, OQ-21 decide what and when). |
| **Organization deletion** | Cascading, audited deletion across all workspaces of an organization, including storage, projections and caches. |
| **Audit retention** | Separate policy for audit (accountability may require longer retention than content); audit stores minimal personal content to make this possible. |
| **Derived-data invalidation** | Lineage references identify insights, evidence, guest projections and report generations that contain or depend on deleted content; they're re-rendered or redacted. |
| **Content-copy registry** | Every place that **copies** personal content is enumerated and deletion-capable: source text versions, provider event inbox, guest evidence items, report generations, suggestion records, display translations, search indexes, exports, sampled AI eval captures, backups (by expiry). |
| **Data-subject requests** | Lookup by platform-scoped author identity within a workspace (no cross-workspace identity; PD §10.2) to export or delete per legal outcome. |

---

## 62. Backup / disaster recovery

| Capability | Requirement (conceptual) |
|---|---|
| Database backups | Daily managed backups in all persistent environments. |
| Point-in-time recovery | Enabled in production. |
| Storage durability | Managed object storage durability; lifecycle rules; no single-copy critical data in storage. |
| Deployment rollback | Instant rollback for web; versioned job deployments with rollback; in-flight jobs finish on their version. |
| Migration rollback | Expand-contract; no reliance on down migrations in production; restores via PITR as last resort (§65). |
| Incident recovery | Runbooks per failure class (§46); after a database restore, **reconciliation re-syncs source facts from providers** for the gap; human decisions after the restore point are recovered from audit where possible and otherwise acknowledged in an incident report. |
| Secrets and keys | Master key backup and rotation procedures; loss of the credential master key means re-authorization of connections (documented). |
| Targets | **Initial internal targets only** for evaluating infrastructure: RPO ≤ 15 minutes, RTO ≤ 4 hours (TA-Q-28). They are **not customer commitments or SLAs**; they are validated by restore drills before launch. |

Nothing is configured in this phase.

---

## 63. Deployment architecture

### 63.1 Units

| Unit | Contains | Platform |
|---|---|---|
| **Web** | UI, server application layer, webhook receivers, OAuth callbacks, realtime authorization, outbox dispatch trigger | Vercel |
| **Jobs** | Task definitions, integration and intelligence workers, mutation executor, schedules, sweepers | Trigger.dev |
| **Data platform** | Postgres (schema, RLS, roles), Auth, Storage, Realtime | Supabase |

Supporting SaaS: Sentry, log store, PostHog, AI provider(s), transactional email. No other units until a split is justified (§6.5, §59).

### 63.2 Deployment flow (conceptual)

```
 merge to main
   → build once (same commit for web and jobs)
   → apply migrations to staging (expand-only for this release)
   → deploy web + jobs to staging → smoke tests + provider sandbox checks
   → approval
   → apply migrations to production (expand-only)
   → deploy jobs to production (new runs use the new version; in-flight runs finish on the old)
   → deploy web to production
   → post-deploy checks (health, error rates, outbox age, webhook acceptance)
   → later release: contract step of expand-contract migrations
```

Web and jobs are always deployed from the same commit; both read a schema version marker so a mismatched deployment fails fast instead of corrupting data.

---

## 64. CI/CD architecture

```
 pull request
   → install (locked) · secret scan · dependency audit
   → lint · typecheck · dependency-boundary rules
   → unit + domain invariant tests
   → database checks: migrations apply on a fresh database; migration lint (destructive changes flagged);
     schema introspection (every table classified, RLS enabled and forced, explicit grants, no unexpected
     `anon`/`authenticated` privileges, no DM objects, append-only grants) (R4)
   → RLS / tenant isolation suite · job tests · adapter contract tests · AI structured-output tests
   → security / invariant matrix (§55)
   → integration tests (simulator + AI stub)
   → preview deployment (web + preview database + preview job environment) · e2e smoke
   → (if prompts/models/tasks changed) AI eval gate
   → review approval (CODEOWNERS for safety-critical paths: mutations/, automation/, classification/,
     platform/db RLS migrations, permissions/)
 main
   → staging deploy → full e2e → approval → production deploy (§63.2)
```

Safety-critical paths require review by a designated owner. CI fails if the service-role key or migration (`postgres`) credentials appear in runtime environment definitions (R1). No CI files are created in this phase.

---

## 65. Migration strategy

| Rule | Detail |
|---|---|
| Version-controlled | All schema changes, RLS policies, grants, functions and reference data (capability catalog, taxonomy) are migrations in the repository. One migration history. |
| Reviewed | Every migration is reviewed; changes to RLS, grants or safety constraints require the safety-critical owner. |
| Destructive changes guarded | Dropping or narrowing columns/tables, removing constraints, or changing RLS requires an explicit "destructive" label and a two-step expand-contract plan. |
| Expand-contract | Add new structures and dual-write/backfill in release N; switch reads in N+1; remove old in N+2. Code is always compatible with the schema before and after a migration. |
| Production discipline | Migrations run from CI, never by hand; long-running data backfills run as jobs, not inside migrations; lock-heavy operations scheduled and tested on production-like data volumes. |
| Rollback | Prefer forward fixes; contract steps are delayed until the expand step is proven; PITR is the last resort. |
| Tests | Every migration applied in CI on a fresh database and on a seeded database; RLS suite (incl. T-26) runs after migrations. |
| Roles, policies and grants (R4) | Migrations run as the migration role. Policies that call `auth.uid()` are created by a role with `auth` schema access (on Supabase, the migration role acting as a member of the owner role). RLS is enabled **and forced**; schemas, grants and privileges are explicit, never inherited from Supabase defaults; introspection tests verify them after every migration. |
| Runtime role lifecycle (R8) | Runtime login roles are created once and are long-lived. Migrations and DB operations never drop or recreate a pooled runtime role name. Shared Supavisor projects (development, staging, preview) don't routinely create → pool → drop login roles; their test roles are long-lived unless a vendor-confirmed drain/removal procedure exists. Per-run disposable roles only in isolated disposable environments or local/non-Supavisor test databases; prefer deleting a whole isolated preview environment over dropping pooled roles. No pooled role is dropped before its pool is drained/released per the TA-Q-30 runbook. Credential rotation (§11.7): in-place password rotation, or a new role name with the old pool drained before the old role is dropped; the runbook is confirmed with Supabase before the first production rotation (TA-Q-30). |

---

## 66. Feature flags / kill switches

### 66.1 Approach

A **database-backed configuration** table (system defaults + optional per-organization/workspace overrides), changed through an audited internal tool. Read by the action pipeline, the automation evaluator, the executor and the AI gateway with short-lived in-process caching (seconds). No third-party flag platform for safety switches.

### 66.2 Required switches

| Switch | Scope | Checked by |
|---|---|---|
| **Global automation kill switch** (mandatory) | All workspaces | Automation evaluator and executor (automation-originated intents) |
| Automation release gate per platform × policy type | Global | Evaluator and policy activation |
| Platform mutation switch per provider × action (e.g., disable private reply on a platform during an incident) | Global / per platform | Availability resolver and executor (surfaced as temporarily unavailable) |
| Provider rollout (enable a platform or capability for selected organizations) | Per organization | Capability evaluation, connect flow |
| AI task routing / model rollout (percentage or per workspace) | Global / per workspace | AI gateway |
| AI task kill switch (e.g., disable suggestions) | Global / per task | AI gateway (typed AI_UNAVAILABLE) |
| Ingestion pause per provider (incident) | Global / per provider | Integration workers (coverage marks the gap) |

Workspace-level "Pause all automation" is a **product feature** stored with policies (§25.8), separate from these operational switches. Every switch change is audited.

---

## 67. Technical decision on n8n

**n8n is not part of the runtime architecture** (TA-32, LOCKED).

| Option | Verdict |
|---|---|
| Core runtime (ingestion, automation, mutations, AI pipelines) | **Rejected.** Critical logic must be versioned, reviewed, tested code under tenant-scoped transactions and the mutation executor. Visual workflows can't carry RLS context, invariant tests or the guard chain. |
| Optional internal tooling | **Acceptable** for non-critical back-office automation (e.g., internal notifications about sign-ups, sales/ops workflows) using only product-analytics or business metadata. |
| Access constraints | No access to tenant conversation data, Brand Context, provider credentials, AI keys used for customer data, or production database credentials. It may consume an internal, read-only, aggregated business metrics feed if ever needed. |

---

## 68. MCP role

**MCP (Model Context Protocol) is development tooling and agent integration only** (TA-33, LOCKED).

- Allowed uses: development agents reading documentation, the repository, local or development databases, issue trackers, and non-production observability.
- Never connected to production databases with write access; production read access for agents, if ever, goes through the same audited operator-access rules (§38.9) and is a separate decision.
- **Not** part of the customer-facing runtime. No production MCP servers are exposed by the product in the MVP. A customer-facing MCP integration would be a future product decision with its own architecture review.
- Development MCP configuration lives in developer tooling, not in application deployment artifacts.

---

## 69. Architecture anti-patterns

| # | Anti-pattern | Why it's rejected | What we do instead |
|---|---|---|---|
| 1 | **One giant AI prompt** for everything | Untestable, unversionable, expensive, couples unrelated failures | Separate AI tasks with their own contracts and versions (§21) |
| 2 | **AI directly calling moderation APIs** | Breaks S2–S5; makes injection dangerous | AI produces assessments; deterministic evaluator; executor (§25, §26) |
| 3 | **Browser calling provider mutation APIs** | Exposes credentials; bypasses authorization and mode | Server-side intents and executor only |
| 4 | **Provider SDK types throughout the domain** | Couples product logic to vendor churn | Adapter contract DTOs (§15) |
| 5 | **One shared, unscoped database query layer** | One missed filter leaks a tenant | Tenant-scoped helpers + RLS (§9, §11) |
| 6 | **Only frontend authorization** | Trivially bypassed via URL/API | Action pipeline + RLS + executor checks (§10) |
| 7 | **Webhooks as the only sync mechanism** | Events get lost, delayed, duplicated | Polling + reconciliation (§14, §47) |
| 8 | **Cron as a durable workflow engine** | No retries, checkpoints or concurrency control | Durable job runtime + outbox (§19) |
| 9 | **Storing only the current classification** | Loses provenance; corrections overwrite history | Immutable assessments + accepted interpretation (§24) |
| 10 | **Sentiment as moderation logic** | Hides legitimate complaints (PD principle 1) | Sentiment excluded from evaluator inputs by type (§25) |
| 11 | **Keyword = harmful** | Hides fraud accusations (C-09) | Candidate only; understanding + protection required (§25) |
| 12 | **Every feature as a microservice** | Distributed complexity without need | Modular monolith (TA-01) |
| 13 | **Vector database without a use case** | Cost and complexity without benefit | Relational Brand Context; pgvector only on measured need (§28) |
| 14 | **Redis because "SaaS needs Redis"** | Extra infrastructure and a new leak surface | Postgres + job runtime; explicit triggers (§35) |
| 15 | **Duplicating reports and insights engines** | Numbers disagree across surfaces | Reports assemble existing intelligence (§33) |
| 16 | **Cross-workspace analytics leakage** | Violates D-37 and tenant trust | Attention signals only (§50) |
| 17 | **Provider tokens in browser-accessible state** | Credential theft | Encrypted server-side store; decrypt only in integration boundary (§39) |
| 18 | **Treating a failed import as zero activity** | Misleading intelligence (S11) | Coverage intervals + Measured values (§17) |
| 19 | **A generic "service role" client in app code** (or connecting a runtime as `postgres`) | Silent RLS bypass | Dedicated runtime login roles (R1); worker role with sealed tenant context; system role without content (§11) |
| 20 | **Personal content in job payloads, logs or analytics** | Spreads personal data to vendors | IDs only (§19.4, §42, §43) |
| 21 | **Blind retries of replies** | Duplicate public replies | Verify before resend; private replies never auto-retried (§18.3) |
| 22 | **AI computing numbers in insights** | Fabricated statistics | Code computes; validators compare (§31.3) |
| 23 | **A DM model "for later" built now** | Back-door DM inbox (C-03) | No DM objects, reads or subscriptions (§27.3) |

---

## 70. Technical risk register

| # | Risk | Severity | Likelihood | Mitigation | Validation phase |
|---|---|---|---|---|---|
| TR-01 | **Provider API limitations** reduce functional parity (read, reply, hide, history) | High | High | Capability catalog with UNKNOWN default; adapters per platform; honest coverage; simulator-first development | API validation (PD OQ-18) before adapters go live |
| TR-02 | **TikTok capability uncertainty** (comments, paid comments, moderation, webhooks) | High | High | Same as TR-01; TikTok first-class in model and catalog; functional launch scope decided after validation (PD OQ-03) | API validation |
| TR-03 | **Paid-comment access and ad ↔ content linkage** unreliable | High | Medium–High | Paid-context coverage per content; "ad unknown" attribution; Mixed handled honestly | API validation (PD A-02, OQ-19) |
| TR-04 | **Token lifecycle / connection continuity** (expiry, user departure) | High | Medium | Health checks, refresh, re-authorization preserving Connection identity; business-level credentials where available | API validation (PD OQ-26) |
| TR-05 | **Provider rate limits**, especially app-level limits shared across customers | High | Medium–High | Budgets, lanes, backoff, backfill throttling, reconciliation; monitor app-level usage | API validation; load tests in staging |
| TR-06 | **AI cost** exceeds unit economics at entry price | High | Medium | Deterministic-first, tiered routing, batch processing, gating, budgets; plan limits rather than quality cuts (C-08) | Cost model before launch (PD A-09, OQ-14) |
| TR-07 | **Classification quality** varies by language/region | High | Medium | Per-language evals, confidence, Needs review, corrections | AI eval program (PD OQ-28) |
| TR-08 | **Auto-hide false positives** harm trust (PD R-03) | High | Low–Medium | Opt-in, hide-only, two-key protection, uncertain = veto, release gate, previews, Undo, precision monitoring, kill switches | AI eval + staged rollout |
| TR-09 | **Tenant leakage** via a missed scope or a privileged path | Critical | Low | RLS enabled and forced everywhere; validated context pattern (TA-Q-29 PASS; R1–R5): dedicated runtime logins, sealed transaction-bound context, fixed-literal role switch, composite workspace FKs; no service role or `postgres` in runtime; schema tests; permanent isolation suite (T-26) | Foundation phase; every PR |
| TR-10 | **Asynchronous inconsistency** confuses users (stale insights vs fresh Inbox) | Medium | Medium | As-of times, explicit pending states, consistency model (§48) | UX validation in staging |
| TR-11 | **Provider deprecations / API changes** break integrations | High | Medium | Pinned API versions, live contract checks, capability profile updates, circuit breakers | Ongoing |
| TR-12 | **Retention / privacy obligations** (LGPD, GDPR, LatAm laws; platform terms) constrain storage | High | Medium | Data classes, content-copy registry, tombstones, deletion-capable design, minimal AI/analytics data | Legal review (PD OQ-21, OQ-22) |
| TR-13 | **Connection ownership / offboarding** disputes (agency vs client) | Medium | Medium | Workspace-owned connections, Move operation, audit; M-01 recommendation | PD OQ-13 + M-01 review |
| TR-14 | **Prompt injection** through comments | Medium | Medium | Untrusted-data handling, no tools, schema outputs, two-key protection, adversarial evals | AI eval |
| TR-15 | **Vendor dependency** (Supabase, Trigger.dev, Vercel, AI provider) | Medium | Low–Medium | Standard Postgres; thin ports for jobs, realtime, storage, AI; documented fallbacks (Graphile Worker for jobs) | TA-Q-04 passed (Trigger.dev selected); TA-Q-21 spike; TA-Q-31 staging |
| TR-16 | **Duplicate or lost platform mutations** under failures | High | Low | Intents, idempotency keys, outcome-unknown verification, reconciliation | Integration tests with fault injection |
| TR-17 | **Webhook spoofing / replay** | High | Low | Signature verification, timestamps, dedup, fail closed | Security tests |
| TR-18 | **Data residency mismatch** between vendors (job runtime, AI, analytics) | Medium | Medium | IDs-only payloads (proven on stored Trigger.dev payloads); region selection; DPAs (Trigger.dev documents AWS us-east-1) | Legal + vendor review (TA-Q-05, TA-Q-06) |
| TR-19 | **Pooler outage or broken pool after database role changes** (F-S3, F-S6) | High | Low–Medium | Long-lived runtime roles; never drop or recreate pooled role names; rotation runbook confirmed with Supabase (R8, §11.7); pooler health monitored separately from database health; shared Supavisor projects (dev/staging/preview) never routinely create → pool → drop login roles; per-run roles only in isolated disposable or non-Supavisor environments; prefer deleting a whole isolated preview environment | Before the first production credential rotation (TA-Q-30); vendor follow-up in parallel |

---

## 71. Open technical decisions

Only genuine architecture questions. Product, IA, UX and model open items are preserved in Appendix B and not reopened. Status after v1.2 is shown in the first column (**CONFIRMED**, **PASS**, **VALIDATE**, **OPEN**).

| ID | Question | Recommendation | Dependency | Blocks implementation? | When to resolve |
|---|---|---|---|---|---|
| **TA-Q-01** · CONFIRMED | M-01: one active workspace per content-bearing asset within an organization? | **Confirmed by the product owner in Phase 0E.1** (PD D-50; §8.3) | — | No longer blocking | Resolved (0E.1) |
| **TA-Q-02** · VALIDATE | Can an ad account serve as a paid-context source for several workspaces of one organization? | Intended behavior recorded (§8.4): allowed only if platform APIs allow it safely; never defines the workspace boundary; never exposes another workspace's data or credentials | Official platform behavior (PD A-02, OQ-18) | Yes, for multi-workspace paid-context ingestion | API validation |
| **TA-Q-03** · CONFIRMED | Does enabling an auto-hide policy act only on new arrivals? | **Confirmed in Phase 0E.1: forward-only** (PD D-51; §25.7) | — | No longer blocking | Resolved (0E.1) |
| **TA-Q-04** · PASS | Job runtime vendor: Trigger.dev vs Graphile Worker (fallback) | **Trigger.dev SELECTED.** Managed 14/14 on a Trigger.dev Development project (idempotency, retries and backoff, non-retryable abort, per-key concurrency, delay, schedules, cancellation, IDs-only stored payloads, outbox adapter, unknown-outcome handling); outbox 13/13 locally. Crashed runs aren't retried by the vendor → R7. Graphile Worker stays the fallback. Still open but not blocking the job foundation: deployed workers (TA-Q-31), data location (TA-Q-05), production plan sizing and cost (TA-Q-32) | — | **No longer blocking** the job foundation (§73 step 3) | Resolved (0E.2b; recorded in 0E.3) |
| **TA-Q-05** · VALIDATE | Hosting region and data residency for database, web, jobs | Single region chosen with legal; co-locate all three. Trigger.dev documents run-data storage in AWS us-east-1 (DPA §4.1; sub-processors in the USA); job payloads carry identifiers only. Whether that is acceptable for the target markets is a legal decision | Legal (PD OQ-21, R-09); customer markets | Yes, for production; no for local/dev | Before staging setup |
| **TA-Q-06** · VALIDATE | AI providers: data-processing terms, second provider, exact model per task | Anthropic as initial recommendation (not an architectural dependency); second provider only when evals/resilience justify; per-task models by eval | Legal; evals (PD OQ-28) | No for development (stubs); yes for production | Before production AI use |
| **TA-Q-07** · PASS | Key management for credential envelope encryption | **AWS KMS** (ADR-64): customer-managed symmetric KEK outside the database; per-record data key with AES-256-GCM; encryption context binds `workspace_id` + `credential_id`; web seal-only, integration decrypt; controlled `ReEncrypt` re-wrap (context constraints enforced on source and destination); runtime key administration denied. Managed validation TA-Q-07b (dedicated development account, sa-east-1, development only), run `20261006T174405Z-e0a2`: 86 PASS / 0 FAIL / 5 measured; reconciliation 26/26; post-cleanup verification 35/35; tampered envelopes and wrong workspace/credential contexts rejected; CloudTrail coverage complete with only the approved non-secret context; no long-lived AWS credential created. Not part of this result: deployed-worker authentication (TA-Q-31); production account/key topology, production region (TA-Q-05) and the KEK rotation/compromise runbooks (§65) remain open production decisions | — | **No longer blocking** the connections module (§73 step 5) | Resolved (TA-Q-07b, 2026-10-06) |
| **TA-Q-08** · VALIDATE | Log store vendor | Axiom or Better Stack (choose one) | Vendor review | No | Foundation phase |
| **TA-Q-09** · VALIDATE | Product analytics region and consent model | PostHog, region per legal, identifiers only | Legal (consent per market) | No | Before production |
| **TA-Q-10** · OPEN | Mandatory MFA for Owner/Admin? | Architecture must support MFA; mandatory Owner/Admin MFA is a security recommendation, not a confirmed MVP requirement | Product/security | No | Before production |
| **TA-Q-11** · VALIDATE | Raw provider payload retention period | Short, bounded (days to weeks) | Legal (PD OQ-21) | No | Before production |
| **TA-Q-12** · VALIDATE | Media display: provider URLs only vs cached thumbnails | Provider URLs only in MVP | Platform terms (VALIDATE) | No | API/terms validation |
| **TA-Q-13** · VALIDATE | Link-reputation source for the malicious-link rule | A reputable URL reputation service + internal blocklist; lookup by URL string, no fetching | Vendor and terms review | Yes, for malicious-link automation | Before automation build |
| **TA-Q-14** · VALIDATE | Dedicated protection check (two-key) | Adopt; confirm cost/benefit in evals | AI eval | No (can start with single key behind release gate) | Before automation release |
| **TA-Q-15** · VALIDATE | Legal basis for using customer data (corrections, samples) in evals and improvement | Synthetic/sandbox first; customer data only with explicit basis | Legal; PD §13.4-9 | No | Before using customer data for evals |
| **TA-Q-16** · OPEN | M-04: when is an insight change a new insight vs a new version? | Model recommendation (§31.4); **PRODUCT OWNER REVIEW REQUIRED**. Storage supports both; no semantic decision taken | Product owner | No | Insights implementation design |
| **TA-Q-17** · OPEN | M-03: frozen report generations with explicit regenerate? | Model recommendation (§33.2); **PRODUCT OWNER REVIEW REQUIRED**. Generations support both; no semantic decision taken | Product owner; PD OQ-15 | No | Reports design |
| **TA-Q-18** · OPEN | M-06: workspace-scoped author authenticity summary? | After evals show benefit (§31.4); **PRODUCT OWNER REVIEW REQUIRED** | AI evals | No | After AI evals |
| **TA-Q-19** · OPEN | M-10: shared system topic catalog of definitions? | Definitions only (§30.1); **PRODUCT OWNER REVIEW REQUIRED** | Product owner | No | Topics architecture/design |
| **TA-Q-20** · OPEN | Intelligence refresh cadence and materiality thresholds | Configurable; initial values with PD OQ-16 | PD OQ-16 | No | Before insights build |
| **TA-Q-21** · VALIDATE | Realtime transport (private broadcast channels) fit | Spike on authorization, scale and reconnection | Spike | No (polling fallback) | Before Inbox build |
| **TA-Q-22** · VALIDATE | Webhook availability and polling cadence per platform/content type | From API validation | PD OQ-18 | Yes, for real adapters | API validation |
| **TA-Q-23** · OPEN | AI unit-cost model (feeds UX-08 and plan limits) | Model cost per interaction by tier, backfill batch cost, suggestion modes | PD OQ-14, A-09; UX-08 | No | Before pricing/launch |
| **TA-Q-24** · VALIDATE | Transactional email provider | Resend or Postmark | Vendor review | Yes, for invitations | Foundation phase |
| **TA-Q-25** · VALIDATE | Preview database strategy | Supabase branching if cost and seeding work; else shared dev project | Spike | No | Foundation phase |
| **TA-Q-26** · CONFIRMED | Are uncertain items excluded from human bulk hide? | **Confirmed in Phase 0E.1: excluded, counted, individual review** (PD D-52; §26.5). Individual human moderation unchanged | — | No longer blocking | Resolved (0E.1) |
| **TA-Q-27** · OPEN | Operator (support) access to tenant content and customer consent | Time-boxed, reason-stated, audited; consent model per contract | Legal/commercial | No | Before production |
| **TA-Q-28** · OPEN (operational) | RTO / RPO targets | RPO ≤ 15 min, RTO ≤ 4 h as **initial internal targets** for evaluating infrastructure; not customer commitments (§62) | Business | No | Before production |
| **TA-Q-29** · PASS (security-critical) | Direct Postgres RLS context under Supabase Auth + Drizzle + pooled connections | **Validated tenant-isolation / pooled-context pattern adopted** (§11.6; R1–R5). R8, discovered during the same managed runs, is a separate operational lifecycle principle (§11.7); its rotation procedure stays VALIDATE under TA-Q-30. Local 29/29; managed run of record 22/22 (Supabase Auth, Supavisor transaction mode, Drizzle). The adversarial cases become the permanent isolation suite (T-26) | — | **No longer blocking** the tenancy/database foundation (§73 steps 1–2) | Resolved (0E.2b; recorded in 0E.3) |
| **TA-Q-30** · VALIDATE (operational) | Database role rotation under Supavisor (R8) and the development pooler incident F-S6 | Confirm the R8 procedure (in-place password rotation, or new role name + drained pool) with Supabase support; report F-S6 in parallel (§11.7) | Supabase support | Yes, before the first production credential rotation; no for development | Before the first production rotation |
| **TA-Q-31** · VALIDATE | Deployed Trigger.dev workers (staging) | Validate crash semantics, the run-outcome sweeper (R7) end to end, the worker login role over Supavisor, egress/static IPs to the database, and the deployed worker's authentication to AWS KMS (at TA-Q-07 validation the hosted runners offered no OIDC federation, so a long-lived, decrypt-scoped credential would be required; recorded, not accepted) | Staging environment | Yes, for production; no for development | Before production |
| **TA-Q-32** · VALIDATE (commercial / operational) | Trigger.dev production plan sizing and cost at realistic product volumes | Size from: expected job/run volume; concurrency requirements; log-retention requirements; static-IP requirement; schedule-frequency requirements; compute/run cost at realistic MVP and early-production volumes; resulting Trigger.dev plan. **Development plan sufficiency is already validated** (TA-Q-04); realistic production cost and plan sizing are **not** validated | Volume assumptions (PD OQ-14, A-09); TA-Q-31 | No for development; yes before production plan selection and finalizing launch economics | Before production plan selection / launch economics |

---

## 72. ADR / decision register

Locked in Phase 0E.1; updated in Phase 0E.3 (v1.1) after the accepted pre-implementation validation, and in v1.2 after TA-Q-07. Classification: **LOCKED** (architectural lock) · **VALIDATE** (vendor, operational, API, legal or security validation still required) · **DEFER** (later design or product decision). Architectural locks and vendor/operational validations are kept separate: a VALIDATE outcome changes a vendor or mechanism, not the locked boundary.

### 72.1 Register

| ADR | Decision | Ref | Classification |
|---|---|---|---|
| ADR-01 | Modular monolith + durable async work | TA-01 | LOCKED |
| ADR-02 | TypeScript strict end to end | TA-02 | LOCKED |
| ADR-03 | Next.js (App Router) + React | TA-03 | LOCKED |
| ADR-04 | Server application services; no public API, no GraphQL/tRPC | TA-04 | LOCKED |
| ADR-05 | PostgreSQL as single authoritative database | TA-05 | LOCKED |
| ADR-06 | Supabase as initial managed Postgres/Auth/Storage platform | TA-06 | LOCKED · region VALIDATE (TA-Q-05) · Realtime VALIDATE (TA-Q-21) |
| ADR-07 | Drizzle + SQL migrations + tenant-scoped transactions | TA-07 | LOCKED · pooled-connection RLS context VALIDATED (TA-Q-29 PASS) |
| ADR-08 | Supabase Auth for authentication; app-owned authorization | TA-08 | LOCKED |
| ADR-09 | Three-layer tenancy enforcement; workspace on every tenant row | TA-09 | LOCKED |
| ADR-10 | RLS on every tenant table; worker role with tenant context; no service role in runtime | §11 | LOCKED |
| ADR-11 | Job runtime vendor: **Trigger.dev selected**; Graphile Worker fallback | TA-10 | SELECTED (TA-Q-04 PASS) · deployed workers VALIDATE in staging (TA-Q-31) · data location VALIDATE (TA-Q-05) |
| ADR-12 | Deployment shape: web + job runtime + data platform (Supabase platform; Trigger.dev selected; Vercel recommended) | TA-11 | Shape LOCKED · job runtime Trigger.dev SELECTED (TA-Q-04 PASS) · web host and region VALIDATE (Vercel recommended; TA-Q-05) |
| ADR-13 | Provider adapter contract; webhooks + polling + reconciliation | TA-12 | LOCKED |
| ADR-14 | No DM read surface in the adapter contract or data model | §15.1, §27.3 | LOCKED |
| ADR-15 | Single Platform Mutation Executor with intents and re-checks | TA-13 | LOCKED |
| ADR-16 | Monitor-only enforced at five points incl. database backstop | §26.6 | LOCKED |
| ADR-17 | Deterministic automation evaluator (single evaluator for preview and live) | §25 | LOCKED |
| ADR-18 | Type-level restriction of automation and bulk requests to HIDE | §25.5 | LOCKED |
| ADR-19 | Two-key protection check for automation candidates (implementation details) | §25.4 | VALIDATE (TA-Q-14) |
| ADR-20 | Automation forward-only on newly arriving interactions; never retroactive | §25.7 | LOCKED (PRODUCT OWNER: CONFIRMED, PD D-51) |
| ADR-21 | AI gateway with task registry, ledger, validation | TA-14 | LOCKED |
| ADR-22 | Anthropic as initial AI recommendation behind the gateway; exact model per task by eval | TA-15 | VALIDATE (TA-Q-06); not an architectural dependency |
| ADR-23 | Structured outputs fail closed | TA-16 | LOCKED |
| ADR-24 | Precedence engine per M-05; human corrections never overwritten | §24 | LOCKED |
| ADR-25 | Capability catalog (code-versioned) + account profiles + runtime overlay; server availability resolver | §16 | LOCKED |
| ADR-26 | Coverage intervals + Measured values (no data ≠ zero by type) | §17 | LOCKED |
| ADR-27 | Current state + immutable history; no event sourcing | TA-27 | LOCKED |
| ADR-28 | Interaction analytics projection + snapshots; numbers by code | §30, §31 | LOCKED |
| ADR-29 | Insight identity + immutable versions (storage only) | §31.4 | LOCKED (storage) · semantics DEFER (M-04) |
| ADR-30 | Report generations as immutable snapshots (storage only) | §33.2 | LOCKED (storage) · semantics DEFER (M-03) |
| ADR-31 | Guest projections for Client guests | TA-31 | LOCKED |
| ADR-32 | Attention signal read model only for cross-workspace | §50 | LOCKED |
| ADR-33 | Realtime invalidation signals via private channels | TA-17 | VALIDATE (TA-Q-21) |
| ADR-34 | No Redis in MVP | TA-19 | LOCKED |
| ADR-35 | Postgres search | TA-20 | LOCKED |
| ADR-36 | Relational Brand Context; no RAG/vector DB | TA-21, TA-22 | LOCKED |
| ADR-37 | Supabase Storage private buckets; no media copying | TA-18 | LOCKED · media behavior VALIDATE (TA-Q-12) |
| ADR-38 | Envelope-encrypted provider credentials, key outside DB, decrypt only in integration boundary | TA-26 | LOCKED (principle) · key-management mechanism LOCKED: AWS KMS (validated, TA-Q-07; ADR-64) |
| ADR-39 | Structured logs + error tracking + correlation IDs (Sentry recommended) | TA-23 | LOCKED (pattern) · vendors VALIDATE (TA-Q-08) |
| ADR-40 | PostHog identifiers-only product analytics | TA-24 | VALIDATE (TA-Q-09) |
| ADR-41 | Layered testing incl. RLS and safety matrix as merge gates | TA-25 | LOCKED |
| ADR-42 | Database-backed flags and kill switches; global automation kill switch | TA-30 | LOCKED |
| ADR-43 | One repository, one package, lint-enforced boundaries | TA-29 | LOCKED |
| ADR-44 | n8n not in runtime | TA-32 | LOCKED |
| ADR-45 | MCP development tooling only | TA-33 | LOCKED |
| ADR-46 | Transactional email vendor | TA-34 | VALIDATE (TA-Q-24) |
| ADR-47 | Single-region hosting | TA-35 | VALIDATE (TA-Q-05) |
| ADR-48 | M-01: content-bearing asset active in at most one workspace per organization; independent across organizations; audited Move | §8 | LOCKED (PRODUCT OWNER: CONFIRMED, PD D-50) |
| ADR-49 | Ad account as paid-context source for several workspaces of one organization | §8.4 | VALIDATE (TA-Q-02; intended behavior recorded) |
| ADR-50 | Bulk hide excludes uncertain items (in addition to protected) | §26.5 | LOCKED (PRODUCT OWNER: CONFIRMED, PD D-52) |
| ADR-51 | Transactional outbox pattern | TA-28 | LOCKED |
| ADR-52 | RLS is defense in depth; application authorization and RLS are both mandatory | §11.1 | LOCKED |
| ADR-53 | Direct Postgres RLS context mechanism with pooled connections (validated pattern) | §11.6 | LOCKED (TA-Q-29 PASS, Phase 0E.2b) |
| ADR-54 | MFA supported for all users; Owner/Admin enforcement undecided | §10.2 | LOCKED (support) · enforcement OPEN (TA-Q-10) |
| ADR-55 | M-03, M-04, M-06, M-10 semantics | §30.1, §31.4, §33.2 | DEFER (open model questions) |
| ADR-56 | R1: dedicated `LOGIN NOINHERIT NOBYPASSRLS` runtime login roles, each able to `SET ROLE` only to its fixed runtime role; never `postgres` or the service role in runtime | §10.4, §11.6 | LOCKED (validated, TA-Q-29) |
| ADR-57 | R2: sealed, transaction-bound workspace context; no reliance on session-level state | §11.6 | LOCKED (validated, TA-Q-29) |
| ADR-58 | R3: fixed-literal `SET LOCAL ROLE`; token role claims only allowlist-checked | §11.6 | LOCKED (validated, TA-Q-29) |
| ADR-59 | R4: forced RLS; explicit owner/definer policies; `auth.uid()` policies created by a role with `auth` access; explicit schemas and grants; no reliance on Supabase default privileges; introspection tests | §11.1, §11.6, §65 | LOCKED (validated, TA-Q-29) |
| ADR-60 | R5: workspace-scoped composite foreign keys (no existence oracle) | §11.1, §11.6 | LOCKED (validated, TA-Q-29) |
| ADR-61 | R6: domain idempotency authoritative; EXECUTING committed before the provider call; OUTCOME_UNKNOWN → reconciliation; ambiguous replies never resent blindly; hide may retry | §18.3, §26.3 | LOCKED (validated, TA-Q-04) |
| ADR-62 | R7: outbox run-outcome sweeper (run IDs and terminal status; re-dispatch CRASHED / SYSTEM_FAILURE); required in the job foundation | §19.3 | LOCKED (validated, TA-Q-04) |
| ADR-63 | R8 (operational lifecycle principle found during managed validation; not part of the TA-Q-29 result): long-lived runtime roles in production and shared Supavisor environments; no routine create → pool → drop of login roles in shared projects; per-run roles only in isolated disposable or non-Supavisor environments; never drop/recreate pooled role names; rotation by in-place password or new role name + drained pool | §11.7, §65 | LOCKED (principles) · rotation and drain procedure VALIDATE with Supabase before the first production rotation (TA-Q-30) |
| ADR-64 | Credential key management on AWS KMS: customer-managed symmetric KEK outside the database; per-record data key, AES-256-GCM in the integration boundary; mandatory non-secret encryption context binding `workspace_id` + `credential_id` (no organization ID, no sensitive values); key-policy separation web seal-only / integration decrypt; controlled `ReEncrypt` re-wrap; runtime administration denied; no caching of decrypted credentials; local keyring for local and CI behind the crypto port | §39 | LOCKED for Step 5 (validated, TA-Q-07) · deployed-worker authentication VALIDATE (TA-Q-31) · production region VALIDATE (TA-Q-05) · production account/key topology and KEK runbooks open (§65) |

### 72.2 Still VALIDATE after v1.2 (not locked)

Realtime transport details (TA-Q-21) · exact AI provider/model per task and AI data-processing terms (TA-Q-06) · hosting/data-residency region (TA-Q-05) · log-store vendor (TA-Q-08) · product-analytics region and consent (TA-Q-09) · transactional email vendor (TA-Q-24) · media URL/cache behavior (TA-Q-12) · provider webhook capabilities and polling cadence (TA-Q-22) · malicious-link reputation vendor (TA-Q-13) · two-key protection implementation details (TA-Q-14) · production retention periods (PD OQ-21; TA-Q-11) · provider API capability matrix (PD OQ-18) · ad-account multi-workspace use (TA-Q-02) · Supavisor role-rotation procedure (TA-Q-30, R8) · deployed Trigger.dev workers in staging (TA-Q-31) · Trigger.dev production plan sizing and cost (TA-Q-32).

**Resolved by validation (Phases 0E.2/0E.2b, recorded in 0E.3):** RLS context with pooled connections (TA-Q-29 PASS; ADR-53 LOCKED) · job runtime vendor (TA-Q-04 PASS; Trigger.dev selected, ADR-11).

**Resolved by validation (TA-Q-07b, 2026-10-06, recorded in v1.2):** credential key-management mechanism (TA-Q-07 PASS; AWS KMS; ADR-38, ADR-64). Production account/key topology and the KEK rotation/compromise runbooks stay open (§65).

---

## 73. Implementation sequence

High-level build order after architecture approval (Phase 0E.1) and the pre-implementation validation (Phases 0E.2/0E.2b, accepted in Phase 0E.3); not started now. **Validation gates:** TA-Q-29 **passed**, so steps 1–2 are no longer blocked by it; TA-Q-04 **passed** and Trigger.dev is selected, so step 3 is no longer blocked by it. Implementation still starts only after the architecture checkpoint and the repository `CLAUDE.md` (§74). API validation (PD OQ-18, OQ-19, OQ-26, OQ-27) runs **in parallel** from the start, because it gates real adapters, not foundation work.

| Step | Scope | Why here | Exit criteria |
|---|---|---|---|
| 0 | **Repository foundation:** tooling, strict TypeScript, boundary lint, CI skeleton, observability skeleton, error taxonomy, i18n catalogs | Everything depends on it | CI runs lint/typecheck/tests; boundary rules active |
| 1 | **Auth + tenancy:** organizations, workspaces, memberships, roles, grants, permission catalog, **workspace mode** (exists before any mutation), action pipeline, audit | Every later module needs tenant context and audit | Sign-in, invitations, role checks; audit written |
| 2 | **Database foundation + RLS** (TA-Q-29 passed; validated pattern §11.6): dedicated runtime login roles (R1), tenant-scoped helpers with sealed context and fixed-literal role switch (R2, R3), forced RLS families with explicit grants and introspection tests (R4), composite workspace foreign keys (R5), schema classification tests, the **permanent tenant-isolation suite including the TA-Q-29 adversarial cases** (T-26), outbox; long-lived runtime and test roles in any shared Supavisor project, per-run roles only in isolated disposable or local/non-Supavisor test databases, no pooled role dropped before the TA-Q-30 drain procedure (R8) | Isolation must precede data | T-01, T-11, T-26 pass on foundation tables |
| 3 | **Job foundation** (Trigger.dev selected, TA-Q-04 passed): job wrappers with tenant scope behind the job port, outbox relay, dispatch sweeper, **run-outcome sweeper (R7)**, domain idempotency (R6), lanes; **flags and kill switches** | Async work and switches before integrations | Idempotent jobs; sweeper recovers lost dispatch; crashed runs recovered exactly once (T-27) |
| 4 | **Provider adapter contracts + simulator + fixtures** | Build without live APIs | Contract tests pass for simulator |
| 5 | **Connections, credentials, capability, coverage** (M-01 rule per D-50; credential envelope encryption on AWS KMS per §39 — TA-Q-07 passed; multi-workspace ad accounts only after TA-Q-02) | Inputs for ingestion and availability | Connect (simulator), health, capability profile, coverage intervals |
| 6 | **Ingestion + canonical conversation model:** webhook inbox, polling, backfill with checkpoints, dedup, source facts, native activity detection | Data before features | T-09 passes; backfill resumes; coverage truthful |
| 7 | **Inbox read side + workflow:** list, detail, views, Open/Done, auto-Done (native), auto-reopen (fail-safe), assignment, notes, escalation, realtime invalidation | Operational value early | Inbox works with unclassified data (pending understanding) |
| 8 | **AI gateway + classification + protection + priority + Needs review** | Understanding powers priority and safety | Fail-closed paths; T-05, T-13, T-14 pass |
| 9 | **Mutation executor + human moderation + public reply + private reply** (Monitor-only enforced from day one) | Actions need the executor | T-04, T-08, T-10, T-12, T-16, T-17, T-27 pass (EXECUTING before provider calls, R6) |
| 10 | **Brand Context + saved replies + reply suggestions** (grounding validators) | Assistance on top of the reply flow | Groundedness checks; suggestions withheld when unsafe |
| 11 | **Safe automation:** policies, previews, evaluator, activation guard, Hidden automatically, Undo, pause all, IA-16 transitions — **behind the release gate** until evals pass (PD OQ-28) | Highest risk; built on stable foundations | T-05–T-07, T-15 pass; release gate closed by default |
| 12 | **Topics + aggregation projection + Measured values** | Basis for intelligence | T-18 passes |
| 13 | **Observations + insights + evidence + guest projections** | Intelligence with lineage | Numbers validated; T-02 for guest data |
| 14 | **Recommendations + tracked actions + follow-ups** | Learning loop | T-20 passes |
| 15 | **Reports (internal + guest renderings)** | Assembles prior steps | Generations immutable; guest rendering safe |
| 16 | **All workspaces attention + alerts** | Needs operational and intelligence signals | T-19 passes |
| 17 | **Hardening:** reconciliation coverage, retention hooks, DR drills, load tests, eval gates, security review, real adapters behind validated capabilities; deployed workers validated in staging (TA-Q-31); **R8 rotation runbook in DB operations, confirmed with Supabase before any production credential rotation** (TA-Q-30) | Before production | Launch readiness checklist |

Steps 7–8 can overlap; step 9's executor can be built against the simulator while step 8 progresses. Real Meta/TikTok adapters replace the simulator per capability as API validation completes.

---

## 74. CLAUDE.md handoff

A repository-level `CLAUDE.md` is **not** created in this phase. When implementation starts, it must encode at least:

| Area | Must state |
|---|---|
| **Architectural boundaries** | Modular monolith; module list and ownership; code vs deployment boundaries (web vs jobs); executor only in jobs. |
| **Allowed dependency direction** | §6.3 and §7.2 rules; pure domain; no cross-module table access; boundary lint must pass. |
| **Security invariants** | Server authority; no service role or `postgres` in runtime; dedicated runtime login roles (R1); credentials only via the credential-access function; no secrets/personal content in logs, payloads, analytics; CSRF/XSS/SSRF rules (§38). |
| **Tenant rules** | Every tenant table has workspace and RLS; use tenant-scoped helpers only (sealed transaction-bound context, fixed-literal role switch, R2/R3); forced RLS and explicit grants (R4); composite workspace foreign keys (R5); never drop or recreate runtime roles, and never create → pool → drop login roles in a shared Supavisor project; per-run roles only in isolated disposable or local/non-Supavisor test environments (R8); system scope only for named jobs; cross-tenant = not found; one workspace per job. |
| **Safety invariants** | Model §50 S1–S21 and the Appendix A map; the automation chain order; uncertain = veto; hide-only automation; forward-only automation (D-51); bulk hide excludes protected and uncertain items (D-52); no bulk delete/block; delete/block human-only; Monitor-only five-point enforcement; never resume automation silently; AI never sends; no DM objects. |
| **Provider adapter rule** | Provider SDK/types only inside adapters; capability from the catalog, never hard-coded or inferred from data; mutation port only in the executor. |
| **Job rules** | Outbox for async work; IDs-only payloads; idempotent steps with domain idempotency (R6); EXECUTING before provider calls; run-outcome sweeper (R7); checkpoints; lanes and concurrency keys; replies never blindly retried. |
| **AI rules** | Use the gateway; one task = one contract and version; structured outputs validated and fail-closed; numbers by code; no tools touching data or platforms; provenance on every output; evals for any prompt/model change. |
| **Git protocol** | Git operations (commit, push, branch, PR) only when the user explicitly asks; never commit secrets, real customer data or raw provider captures; safety-critical paths require designated review. |
| **Test requirements** | New tables need RLS tests; new commands need pipeline registration and permission tests; safety-relevant changes need matrix tests (§55); adapters need contract tests. |
| **Prohibited shortcuts** | §69 anti-patterns; editing locked source documents; promoting open questions to decisions; frontend-only authorization; disabling RLS "temporarily"; bypassing the executor "for testing" in non-test code. |
| **Source-of-truth documents** | PD v1.3, IA v1.1, UX v1.1, Model v1.1, and Technical Architecture v1.2 (approved baseline, validation-aligned); `docs/pre-implementation-validation-v1.md` as validation evidence; open questions stay open until the product owner decides. |
| **Validation gates** | TA-Q-29 and TA-Q-04 have passed (Phase 0E.2b); TA-Q-07 has passed (v1.2). Tenancy/database code follows the validated pattern (§11.6) and keeps T-26 green; the job foundation includes R6 and R7; R8 governs every runtime- and test-role change (procedure VALIDATE under TA-Q-30); real adapters only for validated capabilities; TA-Q-05, TA-Q-30, TA-Q-31, TA-Q-32 (before production plan selection) and the provider/API, AI and legal items gate what they name. |

---

## 75. Technical architecture acceptance criteria

| # | Criterion | Where satisfied |
|---|---|---|
| 1 | A concrete initial stack is recommended. | §3.1 |
| 2 | Stack choices include rationale and rejected alternatives. | §2, §3.2–§3.10 |
| 3 | Architecture remains simpler than microservices. | TA-01, §5, §63 |
| 4 | Workspace isolation is structural. | §9, §11, T-01, T-11 |
| 5 | Client Guest restrictions are structural. | §49, §11.2, T-02 |
| 6 | RLS strategy exists (Postgres/Supabase chosen). | §11 |
| 7 | Background work is durable. | §19 |
| 8 | Provider ingestion is idempotent. | §14, §18, T-09 |
| 9 | Reconciliation exists. | §47 |
| 10 | Capability and coverage remain distinct. | §16, §17.4 |
| 11 | Source facts and interpretations remain distinct. | §12, §24.2, T-13 |
| 12 | Assessment history survives reprocessing. | §24.2, T-14 |
| 13 | AI is behind a task/provider abstraction. | §21, §22 |
| 14 | AI structured outputs fail closed. | §23 |
| 15 | AI cannot directly mutate social platforms. | §25.2, §26.2, T-08 |
| 16 | Protection is structurally before automation. | §25.1–§25.5, T-05, T-06 |
| 17 | Monitor-only structurally blocks mutations. | §26.6, T-04 |
| 18 | Public/private reply semantics are preserved. | §27 |
| 19 | No DM runtime was accidentally created. | §15.1, §27.3, T-12 |
| 20 | Auditability exists. | §41 |
| 21 | Temporal truth is preserved. | §12, §13 |
| 22 | Missing data remains distinguishable from zero. | §17.5, T-18 |
| 23 | Intelligence remains evidence-backed. | §31, §33 |
| 24 | Cross-workspace remains attention-only. | §50, T-19 |
| 25 | Security model addresses provider credentials. | §39 |
| 26 | Testing covers tenant and safety invariants. | §54, §55 |
| 27 | Local development does not require live platform APIs for every test. | §52, §53 |
| 28 | n8n is not accidentally core runtime. | §67 |
| 29 | MCP isn't confused with production runtime. | §68 |
| 30 | No code was created. | This phase created documentation only. |
| 31 | Source documents were not modified. | Phase 0E: PD v1.2, IA v1.1, UX v1.0, Model v1.0 unchanged. (Phase 0E.1 aligned them; see below.) |
| 32 | Only `docs/technical-architecture-v1.md` was created. | This phase's only file. |

Criteria 30–32 describe Phase 0E. **Phase 0E.1 additions:** baseline locked and separated from vendor/operational validation (§2, §72); M-01 confirmed consistently (§8, PD D-50, Model v1.1); ad accounts remain capability-dependent (§8.4, TA-Q-02); automation forward-only (§25.7, T-25); uncertain items excluded from bulk hide with individual moderation preserved (§26.5, T-17); M-03, M-04, M-06, M-10 open; TA-Q-29 recorded as blocking (§11.6; passed and recorded in Phase 0E.3); service-role credentials absent from runtime; RLS and application authorization both mandatory (§11.1). Source documents aligned: PD v1.3, UX v1.1, Model v1.1; IA v1.1 metadata only.

**Phase 0E.3 additions (v1.1):** TA-Q-29 and TA-Q-04 recorded as PASS with evidence references (§11.6, §19.1, §71); Trigger.dev selected and Graphile Worker kept as fallback (TA-10, ADR-11); R1–R8 integrated into the affected sections (§9.3, §10.4, §11, §18.3, §19.3, §26.3, §46, §55, §64, §65, §70) and registered as ADR-56–ADR-63; F-S6 recorded as an operational pooler incident with correlation, not proven causation (§11.7); TA-Q-05 kept VALIDATE with the Trigger.dev us-east-1 note; new tracking items TA-Q-30, TA-Q-31 and TA-Q-32 (Trigger.dev production plan sizing and cost, distinct from the AI unit-cost model TA-Q-23); implementation gates updated (§73, §74). No product, IA, UX or model document changed; M-02, M-03, M-04, M-06, M-08, M-09, M-10 and M-11 remain open.

**v1.2 additions:** TA-Q-07 recorded as PASS with the managed TA-Q-07b evidence (§71); AWS KMS registered as the locked credential key-management mechanism for Step 5 (§39, TA-26, ADR-38, new ADR-64); the deployed-worker KMS authentication question added to TA-Q-31; Step 5 gate language updated (§73, §74). Production account/key topology and KEK runbooks stay open; TA-Q-02, TA-Q-05, TA-Q-30, TA-Q-31 and TA-Q-32 remain VALIDATE. No product, IA, UX or model document changed.

---

## Appendix A — Invariant → enforcement map

### A.1 Product invariants (Phase 0E brief)

| Invariant | Primary enforcement point(s) | Tests |
|---|---|---|
| Workspace is the primary operational/access/intelligence boundary | Workspace on every tenant row; RLS; tenant-scoped helpers; per-workspace jobs (§9, §11) | T-01, T-11, T-26 |
| Organizations may contain multiple workspaces | Tenancy model (§9.1) | DB integration |
| Agencies and businesses use the same architecture | One codebase/data model; no agency-specific objects (§1.3) | — |
| Facebook, Instagram and TikTok are first-class | Adapter contract per platform; capability catalog entries for all three (§15, §16) | Contract tests |
| Organic/Paid/Mixed/Unknown are dimensions | Effective source on content; projection dimension; filters (§14.5, §30.2) | Unit |
| Conversation is the Inbox work item | Workflow owned by conversations module (§7) | Integration |
| Interaction is a comment/reply | Interactions module; no DM objects (§7, §27.3) | T-12 |
| Workflow state ≠ moderation state | Separate modules, tables and events (workflow vs moderation) | Integration |
| Source fact ≠ interpretation | Separate persistence categories; ingestion-only writes to source; insert-only text versions (§12, §24.2) | T-13 |
| Accepted interpretation keeps assessment history | Immutable assessments + recomputed accepted interpretation (§24) | Unit, DB |
| Human corrections are attributable and persistent | Human assessments with actor/time; precedence 1 (§24) | T-14 |
| Capability ≠ coverage | Separate modules and records (§16, §17) | Unit |
| No data ≠ zero | Coverage intervals; Measured values by type (§17.5) | T-18 |
| Negative ≠ harmful | Sentiment excluded from evaluator inputs (§25.2) | T-23 |
| Protected meaning always vetoes automatic hiding | Evaluator step 3; executor re-check (§25) | T-06 |
| Uncertain protection vetoes automatic hiding | Three-state protection; only NOT PROTECTED passes (§25.3) | T-05 |
| Abuse never auto-hides in MVP | Not a policy type; step 4 exclusion (§25.2) | T-07 |
| Automation is hide-only | Automation request type = HIDE only (§25.5) | T-16 |
| Automation is forward-only (PD D-51) | Eligibility rule in the evaluator; backfill, reprocessing and corrections never create automation intents (§25.7) | T-25 |
| Uncertain items excluded from human bulk hide (PD D-52) | Bulk expansion exclusion + per-item re-check (§26.5) | T-17 |
| One active workspace per content-bearing asset within an organization (PD D-50) | Uniqueness rule over active Connected Accounts; Move operation (§8) | DB integration |
| No bulk delete/block | Bulk request type = HIDE only (§25.5, §26.5) | T-16 |
| Monitor-only causes no product-initiated platform mutation | Five-point enforcement incl. database backstop (§26.6) | T-04 |
| Leaving Monitor-only never silently resumes automation | Mode transition sets policies Paused; activation guard with fresh preview (§25.2, §25.6) | T-15 |
| AI never auto-sends replies | No AI→executor path; human interactive request required (§27.4) | T-08 |
| Private reply doesn't create a DM inbox/thread model | No DM reads in contract; no DM objects (§27.3) | T-12 |
| Public outbound reply may become a brand Interaction | Confirmation links brand Interaction (§27.1) | Integration |
| Private outbound reply remains outbound record + history marker | §27.2 | T-12 |
| Evidence lineage reaches source evidence | Lineage references at every hop (§31.1) | Integration |
| Recommendation ≠ causal fact | Drivers labeled hypotheses; validators (§31.3) | T-24 |
| Follow-up is descriptive, not causal | Fixed descriptive label; no causal component (§32.3) | T-24 |
| Client guest cannot reach unrestricted conversations | Guest projections + RLS + pipeline + search + realtime (§49) | T-02 |
| Cross-workspace remains attention-only | Attention signal read model only (§50) | T-19 |
| Source facts are never overwritten by interpretations | §24.2; insert-only grants | T-13 |
| Only one active Tracked Action per Recommendation | Database uniqueness rule (§32.2) | T-20 |

### A.2 Model safety invariants (Model §50)

| # | Invariant | Enforcement | Tests |
|---|---|---|---|
| S1 | Negative ≠ harmful | Evaluator excludes sentiment by type | T-23 |
| S2 | Complaint protection wins over automation | Step 3 + executor re-check + two-key | T-06 |
| S3 | Protected categories never auto-hide; excluded from human bulk hide (uncertain items too, PD D-52) | Step 3; bulk expansion exclusion | T-06, T-17 |
| S4 | Abuse never auto-hides | Policy model + step 4 | T-07 |
| S5 | Automation is hide-only | Request type | T-16 |
| S6 | No bulk delete or block | Bulk request type | T-16 |
| S7 | Monitor-only causes no platform mutation | Five-point enforcement | T-04 |
| S8 | No AI auto-send | No AI→executor path; human request required | T-08 |
| S9 | No full DM Inbox | No DM reads/objects | T-12 |
| S10 | Automation never resumes silently | IA-16 transition + activation guard | T-15 |
| S11 | Unsupported ≠ zero; missing ≠ zero | Capability states; coverage; Measured values | T-18 |
| S12 | Source evidence distinguishable from inference | Persistence categories; provenance | T-13 |
| S13 | Human corrections remain attributable | Human assessments; audit | T-14 |
| S14 | Recommendation ≠ proven causality | Hypothesis labeling; validators | T-24 |
| S15 | Before/after ≠ causality | Descriptive follow-up only | T-24 |
| S16 | Workspace is the operational/access boundary | Tenancy enforcement; validated RLS context pattern (§11.6) | T-01, T-11, T-26 |
| S17 | Cross-workspace doesn't become portfolio intelligence | Attention signals only | T-19 |
| S18 | Client guests can't reach conversations | Guest projections + RLS | T-02 |
| S19 | Keywords are never meaning | Candidate-only pattern matches + steps 2–3 | T-06 |
| S21 | Automation never acts retroactively (PD D-51; Model v1.1) | Forward-only eligibility rule (§25.7) | T-25 |
| S20 | Platform limits never presented as role limits | Availability resolver precedence (§16.6); error taxonomy (§44) | Unit, e2e |

### A.3 Model TA handoff requirements (Model §55)

| # | Requirement | Where |
|---|---|---|
| 1 | Strict workspace isolation | §9, §11, §50 |
| 2 | Source facts vs interpretations | §12, §24 |
| 3 | Provenance on every interpretation and derived object | §23.1, §31.1, §57 |
| 4 | Assessment history + accepted interpretation; corrections never overwritten | §24 |
| 5 | Multi-dimensional, multi-value classification with per-dimension confidence | §21.2, §24.2 |
| 6 | Structural safety vetoes before any platform mutation, recorded | §25, §26 |
| 7 | Capability-aware behavior with reasons and as-of | §16 |
| 8 | Coverage as first-class input; not available ≠ zero | §17 |
| 9 | Event history incl. automatic and native changes | §13, §41 |
| 10 | Temporal truth | §12, §13, §17.1 |
| 11 | Derived, recomputable intelligence with lineage | §30, §31 |
| 12 | Asynchronous intelligence that stays consistent | §20, §48 |
| 13 | Evidence drill-down for permitted roles; guest stop | §31.2, §49 |
| 14 | Multilingual source preservation; translations derived | §21.2 (B), §36 |
| 15 | Correction propagation (immediate operational, refresh-based intelligence) | §24, §31.4, §48 |
| 16 | Before/after anchored on tracked actions, coverage per window | §32.3 |
| 17 | Human-only outbound replies and destructive actions | §26, §27 |
| 18 | Retention-ready design | §61 |

---

## Appendix B — Preserved open dependencies

Nothing below is resolved by this document.

| Source | Open items |
|---|---|
| **PD** | OQ-01, OQ-03, OQ-10, OQ-11, OQ-13, OQ-14, OQ-15, OQ-16, OQ-17, OQ-20, OQ-23, OQ-24, OQ-25 (product); OQ-18, OQ-19, OQ-26, OQ-27, OQ-28 (technical VALIDATE); OQ-21, OQ-22 (legal). All platform capabilities remain [VALIDATE]. |
| **IA** | IA-06, IA-07, IA-08, IA-12, IA-14 |
| **UX** | UX-03, UX-07, UX-08, UX-09, UX-13, UX-16 (deferred); UX-11 out of MVP |
| **Model** | M-02, M-03, M-04, M-06, M-08, M-09, M-10, M-11 (open). M-01 confirmed in Phase 0E.1; M-05, M-07 and M-12 confirmed and preserved. |
