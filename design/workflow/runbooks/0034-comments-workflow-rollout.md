# Runbook: migration 0034 and the Comments Workflow rollout (DEV)

DEV only. **NOT executed.** Every step is a separate, explicitly authorized Product Owner gate.

> **DEPLOYMENT IS BLOCKED** until a supported, executable worker recovery path has been verified and approved
> (§Rollback). `TRIGGER-ROLLBACK-REHEARSAL-01` showed that promoting an older version is refused;
> `TRIGGER-RECOVERY-REHEARSAL-02` proved forward recovery on one isolated project; `RECOVERY-TOOLING-01` built the guarded
> three-plane tool (`npm run trigger:recover`). `RECOVERY-REHEARSAL-03B` ran it on three isolated projects and found that
> it could not recover anything: it redeployed under the known-good SHA, which the provider never rebuilds (X-3 BLOCKED).
> `RECOVERY-TOOLING-02` corrected it (a unique recovery id per attempt). **`RECOVERY-REHEARSAL-03C`** ran the corrected
> tool end to end on the three isolated synthetic projects, with an interruption and its continuation: **PASS**, accepted.
> It found one safety defect (G1: a plan said every prerequisite was met while an interrupted build was still running at
> the provider), corrected in `RECOVERY-TOOLING-03` (unit-tested only). The block stayed until
> **X-3 is approved by the Product Owner** (§Recovery status).
>
> **Status (RUNBOOK-CLOSE-01, 2026-11-23):** X-3 is **APPROVED for DEV recovery readiness only** (§Product Owner
> decisions). That approval lifts the recovery-path block for DEV. It authorizes **no** release step: every mutating step
> from W3 onward still needs its own, explicit Product Owner authorization. Production is unaffected.

Sources:
- WORKFLOW-WF-2C, whose transition window was simulated end to end on disposable local clusters (`tests/db/local/workflow-transition-window.test.ts`);
- DEV-PREFLIGHT-01 and DEV-PREFLIGHT-02 (read-only release reviews);
- RELEASE-TOOLING-01 (reconcile-before-web order, development reconciliation target, bounded migration lock wait, clean release worktree);
- RECOVERY-TOOLING-01 (worker forward recovery with `npm run trigger:recover`, §Rollback);
- RECOVERY-REHEARSAL-03B and RECOVERY-TOOLING-02 (the recovery id, the INTEGRATION → INTELLIGENCE → MAIN order, continuation under the same id);
- RECOVERY-REHEARSAL-03C and RECOVERY-TOOLING-03 (what the isolated rehearsal observed, and the block on remote deployments in progress);
- DB-METADATA-01, BACKUP-VERIFY-01, RECOVERY-READINESS-01 and DEV-RELEASE-PREP-01 (read-only DEV database, backup and recovery readiness; the managed T-26 write scope; a live recovery PLAN ONLY);
- RUNBOOK-ALIGN-01 (the five corrections of DEV-RELEASE-PREP-01 §2 and the release window sequence W1–W13);
- RUNBOOK-CLOSE-01 (this revision: the Product Owner's DEV-only decisions G2, G3, C-1 and X-3; step 1 is read-only and never runs T-26; the release commit rule).

"Abort" means: stop, keep the current state, report. Nothing is undone automatically.

## Product Owner decisions (RUNBOOK-CLOSE-01, 2026-11-23) — DEV only

These are risk acceptances and one readiness approval, recorded for **DEV only**. They never apply to production.

| Item | Decision | Scope and conditions |
|---|---|---|
| **G2** (legacy worker fingerprint) | **ACCEPTED — DEV ONLY** | `ff5269c` has no recorded historical contentHash. A worker recovery to it may be verified by source, versions and task inventory, with the explicit outcome `RECOVERED_FINGERPRINT_UNVERIFIED` (§Legacy v2 release evidence). |
| **G3** (web relay pin) | **ACCEPTED — DEV ONLY** | `TRIGGER_EXTERNAL_DEPLOYMENT_ID` and `TRIGGER_SECRET_KEY` are absent by configuration. The effective runtime configuration has not been directly observed. The acceptance is subject to the read-only configuration checks of step 1 and R2 (§Web relay pin and Trigger credentials). |
| **C-1** (recovery point) | **ACCEPTED WITH CONDITIONS — DEV ONLY** | A Completed Supabase **PHYSICAL** backup **no older than 24 hours** at the migration window. The PO acknowledges that **restoration has never been tested** and that **changes after the backup could be lost**. **If no eligible backup is available: STOP.** This acceptance never authorizes proceeding without a recovery point (§Backups and the recovery point). |
| **X-3** (worker recovery readiness) | **APPROVED for DEV recovery readiness only** | The guarded forward recovery (`trigger:recover`) is the approved DEV worker recovery path. Its live residuals stay listed in §Recovery status. |

**These decisions are not execution authorization.** No authorization is granted by them for:
- managed T-26;
- the ingestion pause;
- migration 0034;
- the worker deployment;
- reconciliation;
- the web deployment.

Each of these needs its own explicit Product Owner authorization (W3–W13).

**What the approvals keep required, unchanged:**
- **The backup:** its freshness is verified **immediately before the migration** (W2): Completed, PHYSICAL, at most 24 hours old.
- **Vercel:** its configuration is verified again, read-only, by name (step 1, and before any R2 attestation).
- **The web/worker pairing:** the historical pairing is confirmed from deployment evidence (§What a recovery PLAN ONLY shows).
- **The workers:** the active workers and the provider deployment status are re-checked (step 1, W9).
- **Supabase:** billing is confirmed paid, and the service is confirmed healthy (W1).
- **Authorization:** every mutating release step is independently authorized.

**The approvals do not weaken any STOP condition.** Every abort and STOP in this runbook applies as written.

## What changes

- **Migration `0034_workflow_core.sql`** (forward-only, additive):
  - creates `workflow.work_items` and `workflow.workflow_events`;
  - backfills one OPEN work item per existing conversation;
  - widens the audit vocabulary.
- **The new worker** projects activity in the same transaction as every interaction write, creates work items, and performs the objective auto-reopen.
- **The new web** reads the work-item queue for:
  - the **classic Inbox list of every workspace**, not only Comments: `inboxListCommand` → `tx.workflow.reads.queue`;
  - the Comments views.

  It also offers Mark done / Reopen, but only on the allowlisted Comments route.

**Inbox-wide impact.** The Comments allowlist (`COMMENTS_REDESIGN_WORKSPACES`) gates only the Comments route and the Mark done / Reopen action. It does **not** protect the rollout as a whole.
- Once the new web is live, **every workspace's Inbox** lists exactly the conversations that have a work item.
- A conversation without one is not listed until it is repaired.
- This is why reconciliation completes **before** the web goes live (steps 5–7).

### Why reconciliation is required

Between the migration (step 3) and the new worker (step 4), the previous worker ingests without the workflow:
- **a conversation created in that window has no work item**: the new web would not list it, in any workspace;
- an activity can be stale.

The new worker repairs a conversation on its next activity. Reconciliation repairs the rest, and it never changes a state.

With the order below (worker before web), no Done can be recorded while the previous worker still runs: the previous web has no Mark done. So no reopen can be missed. Reconciliation still **reports** that case (`review`) in case the order is ever broken.

## Verified baseline (DEV-RELEASE-PREP-01, 2026-11-23; re-verify in step 1)

| Component | State |
|---|---|
| GitHub | Code baseline `24dcacc` (CI green). The release commit is the verified `origin/main` at the window: `24dcacc` or its documentation-only successor (§Release commit). No branch protection or required checks (CI runs after a push, it does not gate it) |
| Vercel (Hobby) | Production = `dpl_HT6ETxMo…` @ `97dcaee` (since 2026-11-16). **No Git integration: a push deploys nothing.** 14 environment variable names, all production. Absent: `COMMENTS_REDESIGN_WORKSPACES` (Comments offered to nobody), `TRIGGER_EXTERNAL_DEPLOYMENT_ID` and `TRIGGER_SECRET_KEY` (§Web relay pin and Trigger credentials). |
| Trigger.dev | INTEGRATION / INTELLIGENCE / MAIN deployed 2026-11-13T00:02–00:03Z = release `20261113.1` @ `ff5269c` (all three planes; 10 / 1 / 11 tasks); the ALIGNED record is v2, without content fingerprints (§Legacy v2 release evidence) |
| dev-v2 | PostgreSQL 17.11; 33 migrations applied (checksums match); pending = `0034_workflow_core.sql` only; non-OPEN conversations 0 (DB-METADATA-01) |
| Supabase plan and backups | Pro (seen by the PO in the dashboard, 2026-11-23); daily **PHYSICAL** backups listed. **Restoration has never been tested.** PITR not reported. (§Backups and the recovery point) |
| CI dependency audit | `PASS` with **no exception** (DEPS-01: GHSA-g3hv-75wg-m249 remediated; the temporary exception was removed, not renewed). Any reported advisory fails CI. **Never bypassed.** |

## Steps

| Step | Action | Approval | Abort when |
|---|---|---|---|
| **1. Preflight and database metadata** | Read-only. A **read-only preflight**: it re-verifies the baseline and the existing evidence, and writes nothing.<br>**Re-verify the baseline above.**<br>`npm run db:migrate -- --target development` (plan only): 33 applied, only 0034 pending.<br>The aggregate metadata gate (DB-METADATA-01, one READ ONLY transaction, aggregates only):<br>• sizes of `audit.audit_events`, `conversations.conversations` and `interactions.interactions`;<br>• **`count(*) where workflow_state <> 'OPEN'` = 0** (0034 refuses with 55000 otherwise);<br>• no long-running transaction.<br>Record the in-service web (deployment id **and commit SHA**) and Trigger versions as rollback targets, and the **ALIGNED release evidence file** of the in-service worker release (`.wrenkind-local/evidence/trigger-release-pair/…`, today `ff5269c` / `20261113.1`): it is the only acceptable worker recovery source.<br>Billing and provider health verified (W1). Vercel configuration re-read by name (G3). The historical web/worker pairing confirmed from deployment evidence. The active workers and the provider deployment status re-checked. The Comments allowlist is empty.<br>Step 1 does **not** run or authorize managed T-26: **a completed preflight is not permission to write synthetic fixtures.** The pre-migration managed T-26 and introspection are **W3**, a managed write under its own authorization, after step 2 and before step 3, and must be green before step 3 (§Managed T-26). | PO | any mismatch |
| **2. Backups and verified recovery** | The **recovery point** meets §Backups and the recovery point: Supabase Pro; a visible **Completed PHYSICAL backup** whose timestamp is verified **immediately before the migration** (W2) and is no older than the **PO-approved maximum backup age**; the PO has acknowledged that **restoration has never been tested** and that changes after the recovery point can be lost.<br>**The worker recovery path is rehearsed and approved** (`trigger:recover`, end to end in `RECOVERY-REHEARSAL-03C`), and X-3 is approved (§Recovery status), including the DEV-only acceptances of the legacy fingerprint (G2) and the relay pin (G3).<br>A **recovery plan** (`npm run trigger:recover`, PLAN ONLY) for the recorded known-good release has been run and reviewed per §What a recovery PLAN ONLY shows. Before step 4 it **legitimately reports "nothing to recover"** and the expected blockers; it is never an authorization to recover.<br>The web rollback target is confirmed to be the immediately previous production deployment (Hobby Instant Rollback reaches only that one). | PO | no recovery point within the approved age, no PO acknowledgment of the untested restore, or no approved worker recovery |
| **3. Migration 0034** | In a quiet window, after W4 (ingestion paused for every platform and read back) and W5 (no unintended local or remote writer). Check first that no session holds or awaits a lock on `audit.audit_events`.<br>`npm run db:migrate -- --target development --apply --lock-timeout-ms <n>` (default 5000), with the migration role, never from a runtime. **Its own authorization.**<br>Verify: work items = conversations; then the **post-migration managed T-26 and introspection** are green (W7: source `24dcacc`, targeted entrypoints only, introspection reports 0 problems) **before step 4**. | PO | 0034 refuses (55000), a lock wait times out (see below), the counts differ, or the post-migration T-26 fails or leaves residue |
| **4. Coordinated worker release** | `npm run trigger:release` (all three planes, one commit), **from the clean release worktree** (below), at the pushed, CI-green commit.<br>Keep the window between 3 and 4 short. **The web is NOT released in this step.**<br>Then W9: the new versions are current on all three planes, a **new recovery PLAN ONLY** is run with the current provider versions and queues, and the runs of the previous versions are drained. | PO | any plane fails → STOP; worker forward recovery (§Rollback) only by a separate PO decision. Old-version runs not drained, or a deployment not terminal → STOP |
| **5. Reconcile every workspace** | While the **previous** web is still live (it ignores `workflow`, so this is safe), for every workspace that has conversations:<br>(1) dry run: `npm run ops:workflow-reconcile -- --target development --database-url-env DATABASE_WORKER_URL --workspace <id>`, then read the counts;<br>(2) apply: the same plus `--apply --confirm-dev-reconcile reconcile-workflow-work-items-in-dev-v2` (resume an interrupted run with `--after <next> --run <runCorrelationId>`). | PO | `failed > 0` (inspect `failedIds`; a rerun is safe) |
| **6. Reconciliation verification and exceptions** | Per workspace, a second dry run must report `created 0 · repaired 0 · failed 0`. Conversations without a work item = 0. Work items = conversations.<br>**F'. Items flagged for review:** `review > 0` lists Done conversations with an audience comment first observed after the Done. Expected 0 with this order. A person opens each one and decides to Reopen or leave it Done; reconciliation never reopens. | PO / workspace owner | a second dry run that is not clean |
| **7. Web deployment from the clean release worktree** | **Only after step 6 is clean for every workspace.**<br>Production deploy of the same commit from the clean release worktree (benchmark evidence excluded by `.vercelignore` and by the worktree itself).<br>Smoke: health 200, unauthenticated Inbox redirects, every Inbox lists the same conversations as before.<br>Then a final dry run per workspace (clean). | PO | deploy fails or smoke fails → web Instant Rollback |
| **8. Authenticated DEV acceptance** | The acceptance matrix of DEV-PREFLIGHT-01 §8, with synthetic fixtures (§W12 acceptance: `npm run db:workflow-acceptance`, the test users U1 and U2, the isolated acceptance deployment). Allowlist changes only as authorized in step 9.<br>Then W13: ingestion is resumed per platform under its own authorization, read back and monitored. | PO | any failure (ingestion stays paused until the PO decides) |
| **9. Comments allowlist** | **Explicit, separate authorization** before `COMMENTS_REDESIGN_WORKSPACES` changes in any deployment. For acceptance: exactly the synthetic test workspaces A and M, and **only** on the isolated acceptance deployment (`--prod --skip-domain`, never aliased, removed afterwards; §W12 acceptance); the production aliases keep it absent. A pilot workspace only after steps 5–8. The change needs a new web deployment, which is its own gate. | PO | — |

### Release window sequence (W1–W13)

The order in which steps 1–8 are executed in the DEV release window (RUNBOOK-ALIGN-01).

- **It is not a script and not one authorization.** Each mutating W step needs its **own authorization**, and none authorizes the next.
- The first unexpected result stops the window ("Abort", above), and every recovery action needs its own PO approval.
- The Comments allowlist (step 9) is **outside** the window for the production aliases: `COMMENTS_REDESIGN_WORKSPACES` stays absent on every production-aliased deployment through W13. The only exception is W12's **isolated acceptance deployment** (§W12 acceptance): exactly the synthetic workspaces A and M, never aliased, removed after the matrix.

| W | Step | Preconditions | Operation | Authorization | Evidence | STOP when | Recovery (separate approval) |
|---|---|---|---|---|---|---|---|
| **W1. Billing and provider health** | 1 | The PO decisions are recorded (§Product Owner decisions: G2, G3, C-1, X-3); this step is authorized | PO: Organization → Billing shows the Pro invoice paid and the project unrestricted; dashboard notices read. Operator: the Supabase, Vercel and Trigger.dev status pages | read-only | notes with UTC time | unpaid invoice, restricted project, or a **provider health problem** affecting the database, pooler, Vercel or Trigger.dev | postpone the window |
| **W2. Backup freshness and DEV identity** | 1–2 | W1 | PO: Database → Backups, the latest **Completed PHYSICAL backup** and its timestamp, read **immediately before W6** (read again if the window is delayed). Operator: `npm run db:migrate -- --target development` (plan only) and the DB-METADATA-01 read-only check | read-only | backup timestamp **at most 24 hours** old (C-1); ledger 33/33, only 0034 pending; non-OPEN 0; no long transaction or lock on the four relations | **stale backup** (older than 24 hours, not Completed, not PHYSICAL, or none: no eligible backup); any identity or ledger mismatch; non-OPEN > 0 | postpone; or a separately authorized full logical backup |
| **W3. Pre-migration managed T-26** | between 2 and 3 | W2. Not part of step 1's read-only preflight. | §Managed T-26, source **`97dcaee`** | **own authorization** (managed write) | both entrypoints pass; `t26_fixture` presence recorded before; 0 residue after; worktree removed | any failure or refusal; **incomplete fixture cleanup** (residue) | stop; residue removal only under its own authorization |
| **W4. Ingestion pause** | 3 | W3 | For `facebook`, `instagram` and `tiktok`: `npm run ops:switch -- set --target development --key ingestion.provider_pause --qualifier <platform> --scope global --value '{"paused":true}' --operator <id> --reason release`, first without `--apply`, then with it; then `npm run ops:switch -- show --target development --key ingestion.provider_pause --qualifier <platform>` | **own authorization** | each write verified by the tool; `show` = paused for every platform | any platform not paused or not read back | `npm run ops:switch -- clear --target development --key ingestion.provider_pause --qualifier <platform> --scope global --operator <id> --reason rollback` per platform (reverts this step's pause) |
| **W5. No unintended writers** | 3 | W4 | The local `next dev` (a dev-v2 client) stopped or idle; no local `trigger dev`, `ops:*`, `db:*` or test process; a read-only activity snapshot shows only the deployed runtimes' own clients | PO decision for local processes | process list; activity snapshot | an unknown local or remote writer | wait, or the PO stops it |
| **W6. Migration 0034** | 3 | W1–W5; the W2 recovery point still within the approved age | step 3 command | **own authorization** | 0034 applied; ledger 34; work items = conversations | 55000; lock timeout; count mismatch | lock timeout → rerun later (nothing applied). Applied but wrong → no schema rollback; the previous runtimes stay. Restore only for data corruption (§Backups and the recovery point). |
| **W7. Post-migration managed T-26** | 3 | W6 | §Managed T-26, source **`24dcacc`** | **own authorization** (managed write) | both entrypoints pass, `workflow` tables included; 0 residue | any failure; **incomplete fixture cleanup** | do not release the worker; the previous runtimes stay (they are compatible with 0034) |
| **W8. Coordinated three-plane worker release** | 4 | W7; clean release worktree at the release commit (below) | `npm run trigger:release -- --cli <pinned CLI> --integration-project-ref … --intelligence-project-ref … --main-project-ref …` (dry run), then `--execute --confirm-paired-release` | **own authorization** | ALIGNED record with fingerprints (v3); a new version on every plane; 10 / 1 / 11 tasks | **a failed worker release** (any plane) | worker forward recovery (§Rollback, R1–R7) by a separate PO decision |
| **W9. New workers and old runs** | 4 | W8 | Read-only: current worker and deployments of each plane (none in progress); a **new recovery PLAN ONLY** with the current provider versions and queues (§What a recovery PLAN ONLY shows); runs on the previous version (`EXECUTING / QUEUED / DELAYED / WAITING`) watched until none | read-only; cancelling a run needs an explicit decision | the new versions current; the new plan; the previous versions hold no runs | a deployment not terminal; **undrained incompatible jobs** of the previous version | cancel only a specific harmful run, by explicit decision (R6) |
| **W10. Reconciliation** | 5–6 | W9 | Steps 5 and 6 for **every workspace that has conversations** | **own authorization** (apply) | second dry run `created 0 · repaired 0 · failed 0`; work items = conversations; `review` handled | **unsuccessful reconciliation**: `failed > 0` or a second dry run that is not clean | rerun (safe); inspect `failedIds` |
| **W11. Web release** | 7 | W10 clean everywhere; Vercel names re-read (no new name; `COMMENTS_REDESIGN_WORKSPACES` still absent) | step 7 | **own authorization** | READY at the release commit; smoke passes | deploy or smoke fails | Instant Rollback to the recorded previous deployment |
| **W12. Functional validation** | 8 | W11 | step 8 with synthetic fixtures (§W12 acceptance): the allowlist stays absent **on the production aliases**; exactly the synthetic workspaces A and M on the isolated, non-aliased acceptance deployment, removed afterwards | PO; W12-FIX, W12-ACT, W12-EXEC and W12-DEACT each **own authorization** | the acceptance matrix A-01…A-17 and the negative checks N1–N6 pass | any failure | remove the acceptance deployment; web rollback and/or worker recovery, each a separate decision; ingestion stays paused |
| **W13. Controlled ingestion resumption and monitoring** | 8 | W12 | Per platform: `npm run ops:switch -- clear --target development --key ingestion.provider_pause --qualifier <platform> --scope global --operator <id> --reason release`, first without `--apply`, then with it; `show` read-back; §Monitoring | **own authorization** | every platform unpaused and read back; ingestion and outbox error rates at baseline; the daily dry run clean | elevated error rates; a dry run that is not clean | pause again; investigate |

**Release commit (W7, W8, W11).**
- `trigger:release` releases only `HEAD == origin/main`. The code baseline verified for this release is `24dcacc`.
- **The release commit must equal the current verified `origin/main` at the window.** A documentation-only successor of `24dcacc` (such as the RUNBOOK-CLOSE-01 commit) may be that commit only after both of these are verified:
  - its diff from `24dcacc` touches nothing outside the approved documentation (`design/`, `docs/`) and architecture-test files (`tests/architecture/`);
  - its CI is green.

  A successor that changes database migrations, product code, worker code, release operators, dependencies or environment configuration is **not** a documentation-only successor. It needs its own review and preflight.
- The release operators are never changed to accommodate a successor.
- The worker (W8) and the web (W11) always release from the same verified commit.
- The post-migration T-26 (W7) additionally requires that the diff touch none of its database and test contracts (§Managed T-26).

**While ingestion is paused (W4–W13):**
- Signals are deferred, not dropped, and coverage reports the gap honestly. Raw provider receipts are kept 7 days, so the window stays well under that.
- No conversation is created without a work item between W6 and W8.

### W12 acceptance (W12-PREP-01)

DEV-PREFLIGHT-01 §8's matrix needs the Comments route and real Workflow writes on synthetic workspaces. That never touches the production aliases.

**Two web deployments, never confused:**

| | Primary DEV web | Isolated acceptance deployment |
|---|---|---|
| Deployment | the production-aliased one (`-blond`, `-social-intelligence`) | one deployment of the **exact release source** from the clean release worktree: `vercel --prod --skip-domain --env COMMENTS_REDESIGN_WORKSPACES=<A>,<M> --yes` (the CLI's default command is deploy) |
| Aliases | unchanged | **none**: reached only by its own deployment URL |
| Comments allowlist | **absent** (fail-closed) | exactly the synthetic workspaces **A and M**; B, every existing workspace and every other workspace stay excluded |
| Access | public alias; sign-in | Vercel SSO (team members only), then sign-in |
| Ingestion | paused (W4–W13) | the same database and workers: **provider** ingestion paused. The only exception is the operator's synthetic conversations and C2 replies: `ingestInteractionFact` is called directly with simulator data, not through the provider signal path the pause governs. |
| Lifetime | in service | **removed** after the matrix (W12-DEACT) |

**Unverified until the acceptance deployment exists (STOP if either is false):**
- **U-1:** a deployment-scoped `--env` value supplements the project's Production variables. A health 200 proves the database configuration; A offered and B not offered proves the allowlist.
- **U-2:** a deployment never aliased to production does not displace the recorded Instant Rollback target. Read the project's rollback information right after creation; `vercel promote <recorded target>` stays available.

**Sub-gates, each with its own authorization:**
1. **W12-FIX** — fixture and memberships (managed, **permanent** writes).
2. **W12-ACT** — the acceptance deployment.
3. **W12-EXEC** — the matrix.
4. **W12-DEACT** — removal of the acceptance deployment.

**Tooling.** `npm run db:workflow-acceptance -- <command>`:
- **Fence:** dev-v2 only (the `db:dev-fixture` fence: pinned digest, sa-east-1, managed endpoints). The vitest setup re-proves it, and refuses pending migrations and an invalid worker login.
- **Mode:** PLAN by default. APPLY needs `--apply --confirm <phrase of that command>`.
- **No delete, reset or repair path exists.**

| Command | Writes (APPLY) | Notes |
|---|---|---|
| `fixture` | organization "W12 Workflow Acceptance — SYNTHETIC"; workspaces A (STANDARD), B (STANDARD), M (`MONITOR_ONLY`); per workspace an inert `simulator` connection without credential, its asset and account; then 7 audience-rooted conversations (A: C1…C5, B: 1, M: 1) through `ingestInteractionFact` in worker scope | fixed ids in the `12acce00-` namespace; resumable; identity conflicts stop with nothing written |
| `members --u1 <uuid> --u2 <uuid>` | organization MEMBER for both; U1 OWNER of A and M; U2 RESPONDER of A, MANAGER of B; grants empty. **Attaching writes no audit row**: no audit action exists for a direct attach, and the application path is `invitation.accepted`. The operator output and the W12-FIX evidence are the record. | both users must already exist in `auth.users` with a confirmed email, created by the PO through the app's own sign-up; a user with **any** membership outside the synthetic organization is refused |
| `role --u2 <uuid> --from <R> --to <R>` | one compare-and-set change of U2 in A, **only** RESPONDER → ANALYST_VIEWER → CLIENT_GUEST, with its `workspace_membership.role_changed` audit event (actor `system`) | the commands that would do this run in no runtime |
| `reply --kind audience\|account` | one synthetic reply into C2 through the same ingestion path | requires C2 **DONE**; audience must reopen (version + 1, `system_auto_reopen`, exactly one audit row with the reply's correlation id); account must change nothing. **One shot:** the reply is permanent, so nobody touches A in the web between the U1 Done and the operator's reply. A failed postcondition is a STOP, never a retry. |
| `verify --u1 <uuid> --u2 <uuid>` | none (read-only) | identity, memberships, negative access, containment |

**Permanent footprint** (dev-v2; `workflow.*`, audit and source facts have no DELETE):
- **Stage 1:**
  - 1 organization, 3 workspaces, 3 connections, 3 assets, 3 accounts;
  - 3 content items, 7 authors, 7 interactions, 7 source text versions, 7 state observations;
  - 7 conversations, 7 ingestion events, 7 `interactions.observed` outbox rows;
  - 7 work items (OPEN, v1) and 7 `created` events.
- **Memberships:** 2 organization and 4 workspace memberships.
- **The A-10 replies:** 2 interactions with their chains, plus 1 `state_changed` event and 1 system audit row.
- **The acceptance session:** its `state_changed` events and `work_item.state_changed` audit rows, and 2 role-change audit rows.
- **The deployed `interactions.observed` consumer:** deterministic classification rows (requests, signals). AI dispatch is denied by the compiled route policy.
- **Identification:** everything is identified by the organization id and the `w12-acceptance.*` correlation ids.

**Roles:**
- **U1** — OWNER of A and M; it performs A-01, A-04…A-13 and the U1 half of A-02.
- **U2** — performs the U2 half of A-02 (acting in B) and A-03.
- **U2** — MANAGER of B and RESPONDER of A; A-03 moves it to ANALYST_VIEWER, then CLIENT_GUEST.

Both are test users only, created and owned by the PO and used in separate browser profiles. The PO's own account is never attached.

**W12-EXEC sequence** (acceptance deployment unless stated; the operator correlates every step read-only):

| Order | Check | How |
|---|---|---|
| 1 | **A-01** | Signed out → sign-in. U1 reaches `/comments` of A and M. U2, a member of B, gets "not found" on B's `/comments`. |
| 2 | **A-02** | **U1:** B's conversation id under A's address → not found. **U2, acting as MANAGER of B, while still a legitimate RESPONDER of A:** B's queue lists only B, and an A conversation id under B's address → not found. Membership in A never leaks into B's bound context. U2 opening A itself is legitimate and is **not** part of A-02. |
| 3 | **A-13** | Open / Done / All and the classic Inbox equal the database definition for A. |
| 4 | **A-04, A-05, A-06, A-07, A-08, A-09** | As U1: **A-04** Mark done with a resolution on C1; **A-05** Undo → Mark done → Undo on C1; **A-06** Reopen from the Done view (C3); **A-07** keyboard focus after each save; **A-08** double click / same-tick submit on C4; **A-09** two tabs on C5. |
| 5 | **A-10** | U1 marks C2 done → `reply --kind audience` → C2 Open; a Done from the stale page → conflict. U1 marks C2 done again → `reply --kind account` → nothing changes. |
| 6 | **A-11** | Audit read. |
| 7 | **A-12** | U1 in M: Mark done and Reopen work; 0 mutation intents. |
| 8 | **A-03** | U2 as RESPONDER sees the control → `role` RESPONDER → ANALYST_VIEWER → the stale RESPONDER page is refused, a reload shows no control → `role` ANALYST_VIEWER → CLIENT_GUEST → closed state. |
| 9 | **A-14, A-15, A-16, A-17** | A-16 is a dry run per workspace with conversations, A, B and M included. |
| 10 | **N1–N6** | As the PO's own user, on the **production alias** and on the acceptance URL (W12-EXEC-01 §10): own `/comments` → not found; a foreign workspace's Inbox and conversations → not found; a foreign conversation id under the own workspace → not found; a foreign `/comments` → the Inbox's own answer. |

**Read-only verification:** before and after every sub-gate:
- `verify`;
- the existing work items' and events' digests;
- the switches;
- the worker versions;
- `vercel ls` and the project snapshot (aliases, rollback target, environment names).

**STOP (no retry, no automatic rollback):**
- any change to the existing DEV data (outside digest), the production aliases, the rollback target, the switches or the environment names;
- a fixture identity conflict;
- an outbox topic other than `interactions.observed`;
- an AI request;
- a credential, mutation intent or outbound reply in a fixture workspace;
- the allowlist not effective (A or M not offered) or over-effective (B or any existing workspace offered);
- any matrix row failing.

**Removal (W12-DEACT):**
- `vercel remove <acceptance deployment id> --safe --confirm-name <the same id>`. Use that id only, **never the project name**, which deletes every deployment of the project. `--safe` skips anything holding an alias;
- then `vercel ls` and the project snapshot: aliases and rollback target unchanged;
- the anonymous smoke on the production alias unchanged.

The synthetic data stays (permanent).

### Managed T-26 (W3 and W7)

**What runs:**
- **ONLY** these two entrypoints: `tests/db/managed/t26.test.ts` and `tests/db/managed/introspection.test.ts`.
- **Exact command:** `npx vitest run --config vitest.db-managed.config.ts tests/db/managed/t26.test.ts tests/db/managed/introspection.test.ts`.
- **Never execute the full `test:db:managed` suite as part of this release window.** `npm run test:db:managed`, or that config without file selection, runs every file under `tests/db/managed/`. That includes suites for connections, credentials, Meta fixtures, moves and T-27, which this release does not authorize.

**Source version, and why:**
- **Before migration 0034 (W3): clean source `97dcaee`.** Its 33 migrations equal the applied ledger.
  - The managed global setup refuses while any repository migration is pending ("managed suite refused: migrations pending").
  - So `24dcacc`, which contains 0034, cannot run it before the migration.
- **After migration 0034 (W7): clean source `24dcacc`, or a verified code-identical successor.** A successor qualifies only if its diff from `24dcacc` touches nothing under `db/`, `platform/`, `tools/db/`, `tests/db/` or `vitest.db-managed.config.ts`, verified before the run.
  - Its classification registry adds the `workflow` schema.
  - T-26 case 23 and the introspection suite then verify forced RLS, exact grants and exact policies on the new tables.

**Clean source procedure:**
1. `git worktree add --detach ../wrenkind-t26-<sha8> <sha>` (W3), or the working checkout at `24dcacc` with no tracked change (W7).
2. `npm ci`.
3. **Copy nothing into the worktree.**
4. Give the six variables to **that one test process only**: `DATABASE_MIGRATION_URL`, `SUPABASE_PROJECT_REF`, `DATABASE_SSL_ROOT_CERT` (an absolute path), `DATABASE_WEB_URL`, `DATABASE_WORKER_URL`, `DATABASE_SYSTEM_URL`. Never write them into a file in the worktree, and never print them.
5. Afterwards: `git worktree remove ../wrenkind-t26-<sha8>`.

**Identity:** the global setup proves the target before writing anything:
- the pinned dev-v2 project reference digest, region sa-east-1, the migration role, the runtime logins through the transaction pooler and a CA;
- the frozen validation project is refused;
- migrations are fully applied;
- the runtime logins are validated.

Roles are never created, dropped or recreated on the managed project (R8).

**T-26 writes synthetic fixtures to the managed DEV database and requires separate authorization:**
- the `t26_fixture` schema and its three tables, **only if absent** (long-lived by design, R8, classified);
- a synthetic world with fresh random ids: 2 organizations named "Organization A" and "Organization B", 3 workspaces, 15 memberships and 21 fixture rows;
- one audit event in that world;
- writes the policies must deny;
- session-level settings planted on pooled worker backends (case 26, fail-closed by design);
- a probe transaction that is always rolled back (case 30).

**What it never does:**
- it calls no provider, Trigger.dev, AI or KMS, and enqueues no job;
- it updates or deletes no existing row.

**Before execution** (read-only, same fence):
- **verify whether `t26_fixture` already exists**, and record it (if absent, the run creates it);
- verify that no residue of an earlier run exists.

**Cleanup and residual artifacts:**
- After the tests, even failed ones, the suite deletes this run's audit events, outbox rows and organizations (the cascade removes workspaces, memberships and fixture rows).
- A read-only residue check after the run must find 0.
- A killed run leaves bounded, synthetic residue that no real member can reach. **Incomplete fixture cleanup is a STOP condition.** The residue is removed only under its own authorization, and the window does not continue (W3, W7).

**Concurrency:**
- never during 0034 (case 29 writes `audit.audit_events`), nor during reconciliation;
- safe beside live ingestion otherwise.

**Not covered on managed:** the Workflow adversarial suite (`tests/db/suites/workflow-security.ts`) runs on local clusters only (CI).

### Backups and the recovery point (W2)

**Required, all of them, before migration 0034:**
1. A Supabase **Pro** entitlement, seen in the dashboard.
2. A visible **Completed PHYSICAL backup**.
3. Its actual timestamp, **verified immediately before the migration** and recorded in the window log.
4. A **PO-approved maximum backup age**: **24 hours** (C-1, RUNBOOK-CLOSE-01). An older backup is a **stale backup**: STOP. **If no eligible backup is available, STOP**; the acceptance never authorizes proceeding without a recovery point.
5. The PO's explicit acknowledgment that **restoration has never been tested**.
6. The PO's explicit acknowledgment that **changes after the recovery point can be lost**: ingestion, audit, switch changes and Workflow states recorded after it.

**The existence of a backup is never evidence of a successful restoration.** Only an executed restore test is, and none has been executed.

**What a restore does** (Supabase documentation, BACKUP-VERIFY-01):
- An in-place restore replaces the **whole** project, Auth included, and causes downtime. Storage objects are not included.
- Custom role passwords must be reset afterwards: the runtime logins and the operator login. That means runtime configuration changes in Vercel and Trigger.dev, each its own gate.
- It is a last resort for data corruption. It is **never** the rollback of a release: the schema stays, the web uses Instant Rollback, and the worker uses forward recovery.

**What is not a recovery point:**
- A partial logical dump, for example of three tables. It cannot be restored consistently.
- A full logical backup (every Wrenkind schema, `app_migrations` and roles) can be one, but needs its own authorization.

### Web relay pin and Trigger credentials (G3)

- **`TRIGGER_EXTERNAL_DEPLOYMENT_ID` is absent by configuration**, in every Vercel scope. It is re-read by name in step 1 and before any R2 attestation.
- **`TRIGGER_SECRET_KEY` is also absent.** Without it the web builds no job runtime (`server/jobs/outbox-notifier.ts`), never reads the pin and never nudges MAIN.
- **The effective runtime configuration of the in-service deployment has not been directly inspected.** R2 is attested **by configuration**, DEV only: **G3 ACCEPTED — DEV ONLY** (RUNBOOK-CLOSE-01), subject to the read-only configuration checks of step 1 and before any R2 attestation.
- **The current Comments operations were assessed as not requiring the secret for their essential paths:**
  - the views and Mark done / Reopen are synchronous database operations;
  - outbox delivery and webhook routing fall back to MAIN's per-minute schedules, which only adds latency.
- **This does not prove that every future web feature works without Trigger credentials.** A feature that needs them, or adding `TRIGGER_SECRET_KEY`, requires its own review and an explicit relay-pin policy (R2) before deployment.

### Migration lock wait (step 3)

The runner sets a transaction-local `lock_timeout` right after its advisory lock and before any statement of the migration. Default 5000 ms; `--lock-timeout-ms` accepts 100–600000.

- **If a lock cannot be obtained in time:** the migration's transaction rolls back (nothing of it is applied, no ledger row) and the run stops with `FAILED (lock_timeout)`, naming what to inspect (`pg_stat_activity`, `pg_locks`). Re-running resumes at that migration.
- **`lock_timeout` limits only the WAIT for a lock.** Once 0034 has its ACCESS EXCLUSIVE lock on `audit.audit_events`, it holds it until its transaction ends: both constraint validations and the backfill. Every audit write, from web and worker, queues behind it for that whole time.
- The holding time depends on the table sizes from step 1. Those sizes, not the timeout, decide the window.

### Clean release worktree (steps 4 and 7)

The working checkout holds untracked local evidence (`tools/perf/`, WF-1 … WF-2E and the preflights). It must never be moved, deleted or released.
- `trigger:release` refuses any untracked file (`git status --porcelain` must be empty).
- The Vercel CLI uploads everything not in `.vercelignore`.

Release from a **dedicated, disposable worktree of the same repository**:

1. **Preconditions:** the approved commit is pushed and CI-green, and `origin/main` = that commit (the release tool re-checks it).
2. **Create the worktree:** `git worktree add --detach ../wrenkind-release-<sha8> <sha>`.
   - It is a sibling directory, the same object store and the exact approved commit (no second source of truth).
   - It is detached: never commit from it.
3. **In the worktree:**
   - `npm ci` (from the lockfile; never copy `node_modules`);
   - `node tools/trigger/fetch-aws-signing-helper.ts` (the git-ignored `vendor/` builds, downloaded and verified against their pinned SHA-256; never copied from another directory).
4. **Copy nothing else, except Vercel's link:** `.vercel/project.json` holds the non-secret project and team ids. Never copy `.env*`, credentials, `.next/`, `tools/perf/` or any generated artifact.
   - The Trigger release reads no `.env` file.
   - The Vercel production build uses Vercel's own environment.
   - Database steps (1, 3, 5, 6) run from the working checkout at the same commit, not from the worktree. The exception is the pre-migration T-26 (W3), which runs from its own `97dcaee` worktree (§Managed T-26).
5. **Check:** `git status --porcelain` is empty and `git rev-parse HEAD` = the approved commit.
6. **Run** step 4 (`trigger:release`, dry run first) and, after step 6, step 7 (the web deploy) from it.
7. **Remove it afterwards:** `git worktree remove ../wrenkind-release-<sha8>`. The original working directory is untouched throughout.

### Reconciliation target (steps 5 and 6)

`--target development` is the only remote target. It is selected explicitly, never inferred from the URL. The URL is proven before anything connects:
- the Supavisor **transaction pooler** (port 6543) in **sa-east-1**;
- the **`worker_login`** runtime login;
- database `postgres`;
- a project reference whose SHA-256 is the **pinned social-intelligence-dev-v2** digest;
- any declared database identity must be the development one.

A CA must be configured, and TLS is verified (`rejectUnauthorized`). Writing needs `--apply` **and** the exact confirmation phrase.

**Credentials.** The CLI reads no `.env` file. The operator exports only `DATABASE_WORKER_URL` and `DATABASE_SSL_ROOT_CERT` (or `_PEM`) for that shell, never the migration credential.

**Refused:** production, unknown projects, other logins, other endpoints, a missing CA, and any ambiguity.

Without `--target`, the CLI still accepts only a loopback cluster.

## Rollback

| Component | Mechanism | Status |
|---|---|---|
| Web | Vercel Instant Rollback to the immediately previous production deployment (Hobby plan), or `vercel promote <id>`. After a rollback, auto-assignment of production domains is off until a promote. | Documented provider capability; the target (the previous deployment) is recorded in step 1 |
| Worker | **Forward recovery:** `npm run trigger:recover` redeploys the source of the recorded known-good ALIGNED release to INTEGRATION, INTELLIGENCE and MAIN as **new** versions under one new **recovery id** (below). `trigger.dev promote <version>` of an **older** version is refused by the server (`TRIGGER-ROLLBACK-REHEARSAL-01`). **Do not assume it works.** Never use it. **Never** use force push or any history rewrite as a rollback, and never the CLI's deploy force flag (`--force`). | Rehearsed end to end on three isolated synthetic projects only (`RECOVERY-REHEARSAL-03C`: PASS); its finding G1 corrected in `RECOVERY-TOOLING-03` (unit-tested only). **Operational DEV recovery has not been executed.** → X-3 **APPROVED for DEV recovery readiness only** (§Recovery status). Deployment still needs each step's own authorization. |
| Schema | **Never rolled back.** 0034 stays: it is additive, and the previous code neither reads nor writes `workflow`. | — |

### Worker forward recovery (`trigger:recover`)

**Why forward.** An older version cannot be promoted. Redeploying known-good code as a new version is proven: the new version became current, ran the known-good behaviour, and carried the identical content fingerprint, while a failed deploy left the previous version current (`TRIGGER-RECOVERY-REHEARSAL-02`).

**Approved source and destinations — never free text.**
- The known-good commit must be the `releaseSha` of an **ALIGNED** release-tool record (step 1 names it), and an ancestor of `origin/main`.
- The three destination projects must be exactly that record's projects. Any other commit or project is refused, including the spare `social-intelligence-dev`.

**Worktree model.** The tool runs from the working checkout and deploys from a separate worktree; it never creates, moves or removes one. The original checkout, its untracked evidence and the Git history are never touched.
1. `git worktree add --detach ../wrenkind-recovery-<sha8> <known-good sha>` (detached; never commit from it).
2. In it: `npm ci`, then `node tools/trigger/fetch-aws-signing-helper.ts`. Copy nothing into it (no `.env*`, `node_modules`, `.next/`, `tools/perf/`).
3. The tool refuses the worktree if:
   - it is not at the known-good commit, is on a branch, is dirty, or belongs to another repository;
   - it holds an env file, or its dependencies or signing-helper builds are missing;
   - the trigger CLI is not the known-good commit's `@trigger.dev/sdk` version.
4. Remove it afterwards: `git worktree remove ../wrenkind-recovery-<sha8>`.

**Source SHA versus recovery id** (`RECOVERY-TOOLING-02`).
- **Source:** the known-good commit SHA. It is immutable: the ALIGNED record, `origin/main` ancestry and the detached worktree are all checked against it, and it never changes.
- **Deployment identity:** a **recovery id** `recovery-<sha12>-<UTC yyyymmddThhmmssZ>`, the one `--external-id` of all three recovered deployments.
  - It is **never** the known-good SHA. Every plane already holds the known-good release's own deployment under that SHA, and Trigger.dev never rebuilds an external id it holds: the CLI answers `Version … was already deployed for --external-id … — nothing to build`, exits 0 and changes nothing (`RECOVERY-REHEARSAL-03B`). `--force` is never used.
  - A fresh **plan proposes** a new id. The **apply needs it back** (`--recovery-id`).
  - No local release or recovery record may already use it. An id used by a completed recovery is spent; an id of an unfinished attempt is only continued.
  - The provider's external ids are not readable with the read-only tooling. A deploy the provider answers with "already deployed … nothing to build" is therefore classified as `RECOVERY_ID_IN_USE`: nothing was built, the plane is unchanged, and the attempt ends (a new attempt needs a new id).
  - A zero exit that created nothing is **never** a recovery.

**Order: INTEGRATION → INTELLIGENCE → MAIN** (the release order), from the job dependencies:
- **How pins resolve.** A running worker pins every trigger into another plane to **its own** deployment's external id (`ctx.deployment.externalId` → `crossPlanePin`), never to a plane's current version.
  - MAIN triggers INTEGRATION and INTELLIGENCE.
  - INTEGRATION wakes MAIN's relay.
  - INTELLIGENCE triggers nothing.
  - Schedules exist only in MAIN.
  - The web nudges only MAIN: unpinned, or pinned by `TRIGGER_EXTERNAL_DEPLOYMENT_ID`. It can nudge only when `TRIGGER_SECRET_KEY` is configured; today neither is (§Web relay pin and Trigger credentials).
- **While INTEGRATION and INTELLIGENCE are recovered first,** they receive no work under the recovery id: MAIN still runs the release being recovered from, and its triggers stay pinned to that release, which still exists in every plane. **A partial recovery therefore changes no behaviour.**
- **When MAIN is recovered last,** its pins name the recovery id, which already exists in both other planes. Nothing waits for a missing deployment, and from then on all new MAIN-originated work (schedules, relay, sweepers) runs known-good code in every plane.
- **Runs pinned to the release recovered from** keep executing it while they drain: runs already executing there, their retries, and their cross-plane triggers. This is why R6 watches them.
- **Runs pinned to the known-good SHA** reach the original known-good deployments (the same source and fingerprint); the tool checks they are still `DEPLOYED`. This is safe.

**Remote deployments in progress** (`RECOVERY-TOOLING-03`, after `RECOVERY-REHEARSAL-03C` finding G1).
- Interrupting the local CLI does **not** cancel its deployment: in 03C the provider kept the interrupted INTELLIGENCE build `BUILDING` for about 15 minutes, then `TIMED_OUT`, while every current worker looked healthy and unchanged.
- Recovery must not continue while the provider reports a deployment that is not terminal. The tool reads every deployment of all three approved projects (`list_deploys`, read-only): `PENDING`, `INSTALLING`, `BUILDING` and `DEPLOYING` are in progress; `DEPLOYED`, `FAILED`, `CANCELED` and `TIMED_OUT` are terminal. An unknown status, an unreadable list or a truncated list (more pages) counts as "not established" and blocks too. A healthy current worker never proves that no build is running, and a build is never judged unrelated because it is not the current worker (the read-only interface does not reliably show external ids).
- PLAN ONLY names the plane, project, deployment, version and status, and never says every prerequisite is met while one is unresolved. The apply re-reads all three projects **before every plane**: a deployment that appears after the plan, or between planes, stops the run before the next deploy (a partial record, continued later under the same id).
- The operator action: inspect the deployment and **wait for a terminal outcome**, then plan again with fresh metadata. The tool never cancels, forces or retries a provider build, and there is no override. A `FAILED`, `CANCELED` or `TIMED_OUT` deployment is shown as terminal and never a worker: it is never taken for a recovery (03C: the timed-out build's id was then rebuilt normally as a new version).
- A run stopped before a plane keeps that plane's continued evidence (recovered, or a deploy without a seen outcome), so the next continuation neither redeploys a recovered plane nor loses the adoption evidence.

**Web before worker when they are incompatible.** A Workflow web (it lists only conversations with a work item, in **every** workspace's Inbox) beside a pre-Workflow worker hides every newly ingested conversation. The tool refuses that pairing (`workflow-0034`) whatever is attested: **roll the web back first** (Vercel Instant Rollback), then recover the worker.
- A newer web whose worker-contract paths differ (migrations, `jobs/`, outbox) needs a web rollback too, or `--proven-web-pairing <web sha>:<known-good sha>` when that exact pairing was in service before.
- **The flag only records an attestation; it proves nothing.** Pass it only when **historical deployment evidence** shows that exact pairing in service, re-read in step 1, and only after the PO attests it.
- For web `97dcaee` beside worker `ff5269c`, the evidence is:
  - production deployment `dpl_HT6ETxMo…` @ `97dcaee`, in service since 2026-11-16T23:06Z (Vercel deployment list);
  - beside Trigger.dev `20261113.1` @ `ff5269c` on all three planes since 2026-11-13 (the provider deployment lists and the ALIGNED record).

**What a recovery PLAN ONLY shows** (DEV-RELEASE-PREP-01, run live on 2026-11-23).
- **PLAN ONLY deploys nothing and writes no record. PLAN ONLY is not an authorization to recover.** An apply needs its own PO decision (R1–R7), the confirmation phrase and both attestations.
- **An exit code of 0 does not mean the plan is ready for APPLY.** Read the blocker line.
  - "Every apply prerequisite is met" appears only when nothing blocks.
  - Even then, only the PO authorizes an apply.
- **Before the worker release (step 4),** while every plane runs the known-good release, an initial plan **legitimately reports "nothing to recover"** ("every plane already runs the known-good release's own deployment; there is nothing to recover"). It also shows the expected blockers:
  - the missing apply inputs: `--recovery-id` and `--expect-<plane>-version`;
  - the fingerprint acceptance: "the approved release recorded no content fingerprint", cleared by `--accept-unrecorded-fingerprint` only under the PO's G2 acceptance;
  - the web/worker pairing: "web rollback required first", cleared by `--proven-web-pairing` only for a pairing proven as above.

  Otherwise it must show:
  - the source, record, worktree and CLI accepted;
  - `none in progress` for all three projects;
  - the known-good `DEPLOYED` on every plane.

  Any other blocker is a finding. This plan checks structure; it does not invalidate the 03C rehearsal.
- **After the worker release (W9),** a **new** PLAN ONLY is required, with the current provider versions and queues:
  - the new versions active and the known-good still `DEPLOYED`;
  - none in progress;
  - the run counts per plane;
  - a new proposed recovery id;
  - once the Workflow web is live, `REQUIRES_WEB_ROLLBACK` (`workflow-0034`).

  An earlier plan is never reused for an apply.

**Operator checkpoints (each a PO approval):**

| # | Checkpoint | Command / evidence |
|---|---|---|
| R1 | Contain | Pause ingestion for every platform and read it back: `npm run ops:switch -- set --target development --key ingestion.provider_pause --qualifier <platform> --scope global --value '{"paused":true}' --operator <id> --reason incident --apply`. The reason is `incident`: R1 contains a faulty release while it is recovered; the switch change itself reverts nothing (the recovery is R3–R5) |
| R2 | Web first when required | Vercel Instant Rollback; record the web commit now in service. Confirm that web's relay-nudge pin `TRIGGER_EXTERNAL_DEPLOYMENT_ID` is absent (it then reaches the current MAIN, recovered last), the known-good SHA (the original known-good MAIN, same source) or the recovery id — **never** the release being recovered from: such a web keeps waking that release's MAIN relay, whose triggers stay pinned to it in every plane, so new work would silently keep running the faulty code. Today the pin is absent **by configuration** only; the effective runtime configuration is not directly inspected (§Web relay pin and Trigger credentials) |
| R3 | Plan | `npm run trigger:recover -- --cli <pinned CLI> --known-good <sha> --release-evidence <file> --worktree <abs path> --main-project-ref … --intelligence-project-ref … --integration-project-ref … --web-release <web sha>`: **PLAN ONLY**, deploys nothing; proposes a new recovery id and prints every plane's active version, run counts, remote deployments (any not terminal blocks), the order, what the recovery id means on each plane, the compatibility verdicts and what an apply still needs |
| R4 | Apply | The same, plus `--recovery-id <the id the plan proposed>` `--expect-integration-version <v> --expect-intelligence-version <v> --expect-main-version <v>` (copied from the plan) `--attest-ingestion-paused --attest-web-relay-pin --apply --confirm-recovery recover-trigger-planes-to-<sha12>` (and `--accept-unrecorded-fingerprint` when the approved record predates fingerprints: the final state then says `RECOVERED_FINGERPRINT_UNVERIFIED`) |
| R5 | Verify | Per plane, before the next: exit 0, a **new** version, the known-good task count; the provider's current worker is that version, with every task in the plane's own directory; the content fingerprint equals the recorded one. Evidence: `.wrenkind-local/evidence/trigger-recovery/<timestamp>-<sha12>.json` (with the recovery id) |
| R6 | Drain | Runs started on the previous versions finish there (with their retries and their cross-plane triggers, pinned to the release recovered from). Queued and delayed runs were observed executing on the version active **when they started** (03C), so those that start after the switch run the recovered versions. Runs explicitly pinned to an earlier deployment keep using it even after the recovery (03C: a pin to the faulty release still ran it). The faulty release's remaining runs and cross-plane triggers are watched (`EXECUTING / QUEUED / DELAYED / WAITING`) until the previous versions hold none, and handled under this approved procedure: cancel only a specific harmful run, by explicit decision |
| R7 | Resume | Clear `ingestion.provider_pause` per platform; watch the ingestion and outbox error rates |

**Partial failure.**
- The first unexpected result stops the run: a failed deploy, an unknown outcome, another active version, a wrong inventory or fingerprint, worktree drift, a remote deployment that is not terminal (or unreadable deployment metadata), or an interrupt.
- There is no automatic retry, reorder or restore.
  - Planes recovered before the stop stay recovered.
  - The failed plane keeps its previous version (verified provider behaviour).
  - The record lists recovered and unrecovered planes. A partial recovery is **never** reported as successful.
- Continue only after a fresh plan, with `--continue <that record>`. A continuation never mints a new id: it uses the **same recovery id** (`--recovery-id` must repeat it), and only the attempt's latest record can be continued.
  - Recorded-recovered planes are re-verified, not redeployed.
  - A plane that changed since is refused (investigate).
  - Every other plane needs a fresh `--expect-…-version`.
  - After an interrupted or timed-out deploy, first **wait until the provider shows no deployment in progress** on any plane (the plan blocks until then).
  - A plane whose earlier deploy has **no known outcome** (interrupted, timed out, failed) is shown as **UNCERTAIN**, and as **AMBIGUOUS** when its active version changed since. Its deploy under the same id either builds normally, or the provider answers that the **current** deployment already holds the id. That deployment is then adopted (never rebuilt) only when the current worker, the inventory and the fingerprint seen in the interrupted build log all match; any other answer stops.
- **These states end the attempt** (investigate, then a new attempt with a new id):
  - `RECOVERY_ID_IN_USE`;
  - `VERIFICATION_FAILED`;
  - a v1 record (RECOVERY-TOOLING-01, deployed under the known-good SHA).

**Legacy v2 release evidence.** (G2)
- **The known-good release:** the current operational known-good worker source is `ff5269c`, and the current operational version is `20261113.1` on all three planes.
- **Its record:** a v2 ALIGNED record that holds **no contentHash** (no content fingerprints).
- **What a recovery to it verifies:**
  - the source (worktree at the SHA, `origin/main` ancestry, the record and the exact projects);
  - the versions;
  - the task inventory (10 / 1 / 11, each in its plane's directory).

  The fingerprint is recorded but not compared: `--accept-unrecorded-fingerprint`, final state `RECOVERED_FINGERPRINT_UNVERIFIED`.
- **What stays unattested:** that the rebuilt worker equals the one that ran.
- v3 fingerprints are recorded under `--depot-build` (`RECOVERY-REHEARSAL-03B`).
- **No new worker baseline may be deployed before migration 0034 merely to obtain a fingerprint.**
  - The `24dcacc` worker writes the Workflow projection in every ingestion transaction and needs 0034.
  - `trigger:release` releases only `origin/main`.
  - `trigger:recover` reports nothing to recover while the planes run `ff5269c`.
- The old operational release `ff5269c` still lacks a recorded worker content fingerprint. **This limitation requires explicit DEV-only risk acceptance** by the PO (inventory-only verification) before an operational recovery to it. **G2 ACCEPTED — DEV ONLY** (RUNBOOK-CLOSE-01, 2026-11-23).
  - The acceptance ends when the step-4 release is recorded as ALIGNED with fingerprints (v3), the first fingerprinted known-good.
  - It never extends to production.

### Recovery status

Three different things, never presented as equivalent:
1. **Verified synthetic recovery** — `RECOVERY-REHEARSAL-03C`: **PASS**, on three isolated synthetic projects only. One recovery id; INTEGRATION → INTELLIGENCE → MAIN; fingerprints and inventories matched; a controlled interruption, then a continuation under the same id (INTEGRATION not redeployed); the operational projects were unchanged.
2. **Operational recovery readiness** — X-3 is **APPROVED for DEV recovery readiness only** (RUNBOOK-CLOSE-01, 2026-11-23); it was CONDITIONAL until then. It rests on these DEV-only decisions (§Product Owner decisions):
   - G2 ACCEPTED — DEV ONLY: a recovery to `ff5269c` ends in `RECOVERED_FINGERPRINT_UNVERIFIED` (§Legacy v2 release evidence).
   - G3 ACCEPTED — DEV ONLY: the relay pin and the Trigger secret are absent by configuration; the effective runtime configuration has not been directly observed (§Web relay pin and Trigger credentials).
   - C-1 ACCEPTED WITH CONDITIONS — DEV ONLY: a Completed PHYSICAL backup at most 24 hours old; restore never tested; possible loss after it (§Backups and the recovery point).

   Residuals that stay true after the approval:
   - `RECOVERY-TOOLING-03` (G1): CI-verified. Its read path ran live in a PLAN ONLY on 2026-11-23 (no deployment in progress on any plane), but its blocking path has not run live.
   - Cross-project pinning: proven in code and by the deploy order, but not observed live (the synthetic tasks cannot trigger across projects).

   **Operational DEV recovery has not been executed.**
3. **Authorization to deploy DEV** — a separate Product Owner gate (steps 3 onward). Neither of the above grants it. **It has not been granted**: each mutating step (W3–W13) needs its own authorization.

**After a recovery (Workflow):**
- conversations ingested by the pre-Workflow worker get no work item;
- an activity can be stale;
- a Done item misses its automatic reopen (reconciliation reports `review`).

The previous web, which is in service again, ignores `workflow`.

**After a rollback (web or worker):**
- Done states recorded in the meantime are invisible to the previous list, which shows every conversation OPEN.
- Conversations ingested by a previous worker get no work item.

**Re-forward:** steps 4 → 5 → 6 → 7 again, never the web before reconciliation.

## Reconciliation guarantees (what makes steps 5 and 6 safe to repeat)

- **Scope and atomicity:**
  - per workspace, in the worker's existing scope and RLS (the `worker_login` runtime login; no privileged credential);
  - bounded batches, each its own transaction and resumable;
  - each item in its own savepoint.
- **What it changes:** it creates a missing work item once, OPEN v1, with one `created` event carrying the run id. It recomputes a stale activity, locking before recomputing (safe beside live ingestion).
- **What it never changes:** state, resolution, attribution or version. It writes no audit event and deletes nothing.
- **Dry run:** a READ ONLY transaction; the database refuses writes.
- **Report:** `inspected · created · repaired · unchanged · failed · review`, with ids only.

## Monitoring (during the pilot)

- **Daily:** a dry run per workspace (`--target development`), expecting `created 0 · repaired 0 · failed 0 · review 0`. The synthetic acceptance workspaces A, B and M are included like any other.
- **Never** add A, B or M to a real (production-aliased) allowlist: they exist for the acceptance deployment only.
- **Gap check:** conversations without a work item = 0.
- **Error rates:** `inbox.conversations.list`, `workflow.conversation.mark_done` / `.reopen` and ingestion (redacted logs).

## Kept for the rollback review

- The previous list read (`listConversationActivity`) and `conversations.workflow_state` are unchanged.
- The previous builds are the rollback targets (step 1).
- No runtime switch between the lists exists. For DEV the reconcile-before-web order and the web Instant Rollback replace one; adding a switch for production is a PO decision.
