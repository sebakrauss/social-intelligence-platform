# Focus 2.0 — Governance record before the DEV release (Steps 7B-17E, 7B-17F)

| Field | Value |
|---|---|
| Date | 2026-11-16 |
| Step | 7B-17E — Governance closure before DEV release · 7B-17F — Formal product-owner approval |
| Code baseline | `main` = `origin/main` = `f28f69f939dd35198b1aef44a7a065761d122c85` (CI run 43855726352, success) |
| Status | **Record of the formal approval of UX v1.2 and TA v1.3 and of a release-approach decision.** It authorizes nothing: no migration, deployment, capability change or publication. |

This file is not a source of truth. The governing documents are the ones under `docs/`; if this file and a governing
document disagree, the governing document wins.

## 1. Formal approval — status: APPROVED (2026-11-16, Step 7B-17F)

The product owner formally approved **Core UX Flows v1.2** and **Technical Architecture v1.3**.

| | |
|---|---|
| Approval date | 2026-11-16 |
| Source | Explicit product-owner approval, communicated through the technical lead in the Step 7B-17F mandate |
| Approved versions | Core UX Flows **v1.2** · Technical Architecture **v1.3** |
| Recorded in | The approval records of `docs/core-ux-flows-v1.md` and `docs/technical-architecture-v1.md` (the sources of truth), and `CLAUDE.md` §2 |

The product owner's statement, as relayed in that mandate:

> "Apruebo formalmente Core UX Flows v1.2 y Technical Architecture v1.3, con todas las condiciones indicadas. Prepara
> un único gate para registrar ambas aprobaciones y consolidar la documentación en un commit local, sin push,
> migraciones ni despliegue."

No signature, external document, approval identifier or time of day is recorded: none was provided.

**Scope and limits of the approval.** It covers the texts in §1.1 and §1.2 below, with every limit they state. It
approves document wording. It does **not** apply a migration, deploy anything, validate a platform capability, grant a
provider action or make ordinary public replies available; each of those keeps its own gate (§2, §3).

| Document | Product direction | Technical evidence | Formal approval of the wording |
|---|---|---|---|
| Core UX Flows v1.2 (UX-19, UX-20, §8.10) | Given by the product owner through the Step 7B-15V mandate, relayed by the technical lead | Built and independently reviewed (Steps 7B-15B to 7B-15U); committed `c39b215`; not deployed | **APPROVED** 2026-11-16 (Step 7B-17F) |
| Technical Architecture v1.3 (R4a) | Work authorized by the technical lead (Step 7B-14P1) | Migration 0031 validated locally and applied to DEV (Step 7B-14P2B); independent review Step 7B-14P1R | **APPROVED** 2026-11-16 (Step 7B-17F) |

**Historical context.** When this file was first written (Step 7B-17E, earlier on 2026-11-16) both approvals were
**pending**: no accessible record showed the product owner approving the final wording, so UX v1.1 and TA v1.2 were
still the latest formally approved versions, and the texts below were prepared "to be confirmed". Step 7B-17F
recorded the approval.

### 1.1 Approved text — Core UX Flows v1.2

> I approve Core UX Flows **v1.2** as written in `docs/core-ux-flows-v1.md`, with these exact limits:
>
> 1. **UX-19 — Focus.** In the Comments Inbox the selected conversation opens **inline, inside its own row**. There is
>    **no permanent side panel** or third column. Presentation only: no new action, permission or data. Triage
>    (Direction B) stays a future, optional density mode and is not implemented.
> 2. **UX-20 — Phase 1 reply drafts.** An unsent public-reply draft is kept **only in the browser tab's memory**. It is
>    lost on reload, on closing the tab, on leaving the conversation and on sign-out. This is a **temporary exception**
>    to P3 and §3.1 that **must be resolved before commercial readiness**; durable drafts need their own security
>    design and my approval.
> 3. **§8.10.C — public replies.** The backend gate that refuses a second public reply while an earlier one is in
>    flight (`REPLY_IN_FLIGHT`) is **necessary but not sufficient**. Ordinary public replies remain disabled until
>    capability validation, explicit provider-action authorization, unknown-outcome operational readiness and a
>    separate product-owner and security decision are all complete.
> 4. **Separations kept.** Private Messages are not part of this product surface (PD C-03, D-36; Model S9) and would
>    need a formal PD scope amendment and independent platform validation. Private reply is a distinct contract, shown
>    as unavailable. Classification, prioritization, suggested replies and recommended actions are future capabilities
>    and are not presented as available.
>
> This approval does not authorize any migration, deployment, capability change or publication.

### 1.2 Approved text — Technical Architecture v1.3

> I approve Technical Architecture **v1.3** as written in `docs/technical-architecture-v1.md`, with these exact limits:
>
> 1. **R4a.** An empty PostgreSQL `search_path` alone is **not** a sufficient security guarantee. `SECURITY DEFINER`
>    functions, and functions that run under a privileged identity, pin `search_path = pg_catalog, pg_temp` and
>    schema-qualify every reference outside `pg_catalog`.
> 2. **Supersession.** The statement "SECURITY DEFINER helpers with `search_path = ''`" in
>    `docs/pre-implementation-validation-v1.md` (§9) is **superseded by R4a**. It stays in that document as historical
>    evidence, unchanged, with a dated supersession note (§30).
> 3. **Nothing else changes.** R1–R8, TA-Q-29 PASS and every open item (VALIDATE / OPEN) are unchanged. The
>    privileged execution through temporary objects was reproduced on a disposable local database only.
>
> This approval does not authorize any migration, deployment, capability change or publication.

Step 7B-17F recorded this approval (date, phase, decision) in each document's approval record and updated their
Version and Status fields and `CLAUDE.md` §2.

## 2. Release approach — direct DEV review (decision, not authorization)

Step 7B-17D found the Vercel Preview environment has no configuration, so a protected Preview could not be created.
As relayed by the technical lead in the Step 7B-17E mandate, the product owner agreed to review Focus 2.0 on the
**existing Wrenkind DEV environment** instead of configuring a new Preview; the Step 7B-17F mandate confirms it. The
agreed approach:

1. Use the existing Wrenkind DEV environment (database `social-intelligence-dev-v2`; the Vercel project's "Production"
   target is the DEV web).
2. **Migrate DEV before deploying the application code**: 0032, then 0033 (DEV ledger at 0031 as of Step 7B-17A).
3. Deploy the application code in a controlled DEV deployment; the **authenticated Focus review happens immediately
   after** it, by the product owner with their own account.
4. **Keep the existing Vercel deployment as the rollback reference** (`dpl_xHHMMYih…`, commit `ff5269c`). Migrations
   0032 and 0033 are expand-only (one index, one trigger): they remove nothing the earlier web code reads, and against
   that code they can only refuse a write, never allow one.
5. **Ordinary `reply_public` stays default-deny**: no capability validation, provider-action grant or activation is
   part of this release.
6. **Migrations and deployment each need their own separate authorization.** This record grants neither.

## 3. Items tracked separately (not resolved here)

| Item | Status |
|---|---|
| Vercel `automation-bypass` secret found in Step 7B-17D (created 2026-11-13) | Open — separate security action; revoking it changes project settings and needs its own gate |
| npm audit exception GHSA-g3hv-75wg-m249 (`design/security/AUDIT-EXCEPTIONS.md`) | Expires 2026-11-30; tracked separately |
| DEV migrations 0032 → 0033 | Not applied; needs authorization |
| Controlled DEV deployment of `f28f69f` (web, and jobs if released as a pair) | Not done; needs authorization |
| Ordinary `reply_public` activation | Separate future gate |
| Durable reply drafts (UX-20) | Must be resolved before commercial readiness |
