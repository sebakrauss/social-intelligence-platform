# Runbook: migration 0034 and the Comments Workflow rollout (DEV)

DEV only. **NOT executed.** Every step is a separate, explicitly authorized Product Owner gate.

> **DEPLOYMENT IS BLOCKED** until a supported, executable worker recovery path has been verified and approved
> (`TRIGGER-ROLLBACK-REHEARSAL-01`, §Rollback). Until then, no step from 3 (migration) onward may start.

Sources:
- WORKFLOW-WF-2C, whose transition window was simulated end to end on disposable local clusters (`tests/db/local/workflow-transition-window.test.ts`);
- DEV-PREFLIGHT-01 and DEV-PREFLIGHT-02 (read-only release reviews);
- RELEASE-TOOLING-01 (this revision: reconcile-before-web order, development reconciliation target, bounded migration lock wait, clean release worktree).

"Abort" means: stop, keep the current state, report. Nothing is undone automatically.

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

## Verified baseline (DEV-PREFLIGHT-02, 2026-11-21; re-verify in step 1)

| Component | State |
|---|---|
| GitHub | `main` = `97dcaee`; no branch protection or required checks (CI runs after a push, it does not gate it) |
| Vercel (Hobby) | Production = `dpl_HT6ETxMo…` @ `97dcaee`. **No Git integration: a push deploys nothing.** `COMMENTS_REDESIGN_WORKSPACES` absent (Comments offered to nobody). |
| Trigger.dev | INTEGRATION / INTELLIGENCE / MAIN deployed 2026-11-13T00:02–00:03Z = release `20261113.1` @ `ff5269c` (all three planes) |
| dev-v2 | PostgreSQL 17.11; 33 migrations applied (checksums match); pending = `0034_workflow_core.sql` only |
| CI dependency audit | `PASS_WITH_TEMPORARY_EXCEPTION`; the minimatch exception (GHSA-g3hv-75wg-m249) **expires 2026-11-30 (inclusive)**. CI fails from 2026-12-01 UTC unless the advisory leaves the audit or the TL renews the exception in its own gate. **Never bypassed.** |

## Steps

| Step | Action | Approval | Abort when |
|---|---|---|---|
| **1. Preflight and database metadata** | Read-only.<br>**Re-verify the baseline above.**<br>`npm run db:migrate -- --target development` (plan only): 33 applied, only 0034 pending.<br>The aggregate metadata gate (DB-METADATA-01, one READ ONLY transaction, aggregates only):<br>• sizes of `audit.audit_events`, `conversations.conversations` and `interactions.interactions`;<br>• **`count(*) where workflow_state <> 'OPEN'` = 0** (0034 refuses with 55000 otherwise);<br>• no long-running transaction.<br>Record the in-service web and Trigger versions as rollback targets. Managed T-26 is green. The Comments allowlist is empty. | PO | any mismatch |
| **2. Backups and verified recovery** | Record a restorable point (PITR position, or a logical dump of `conversations`, `interactions`, `audit`) with its timestamp.<br>**The worker recovery path is rehearsed and approved** (`TRIGGER-ROLLBACK-REHEARSAL-01`).<br>The web rollback target is confirmed to be the immediately previous production deployment (Hobby Instant Rollback reaches only that one). | PO | no confirmed restorable point, or no approved worker recovery |
| **3. Migration 0034** | In a quiet window. Check first that no session holds or awaits a lock on `audit.audit_events`.<br>`npm run db:migrate -- --target development --apply --lock-timeout-ms <n>` (default 5000), with the migration role, never from a runtime.<br>Verify: introspection reports 0 problems; work items = conversations. | PO | 0034 refuses (55000), a lock wait times out (see below), or the counts differ |
| **4. Coordinated worker release** | `npm run trigger:release` (all three planes, one commit), **from the clean release worktree** (below), at the pushed, CI-green commit.<br>Keep the window between 3 and 4 short. **The web is NOT released in this step.** | PO | any plane fails → worker recovery (Rollback) |
| **5. Reconcile every workspace** | While the **previous** web is still live (it ignores `workflow`, so this is safe), for every workspace that has conversations:<br>(1) dry run: `npm run ops:workflow-reconcile -- --target development --database-url-env DATABASE_WORKER_URL --workspace <id>`, then read the counts;<br>(2) apply: the same plus `--apply --confirm-dev-reconcile reconcile-workflow-work-items-in-dev-v2` (resume an interrupted run with `--after <next> --run <runCorrelationId>`). | PO | `failed > 0` (inspect `failedIds`; a rerun is safe) |
| **6. Reconciliation verification and exceptions** | Per workspace, a second dry run must report `created 0 · repaired 0 · failed 0`. Conversations without a work item = 0. Work items = conversations.<br>**F'. Items flagged for review:** `review > 0` lists Done conversations with an audience comment first observed after the Done. Expected 0 with this order. A person opens each one and decides to Reopen or leave it Done; reconciliation never reopens. | PO / workspace owner | a second dry run that is not clean |
| **7. Web deployment from the clean release worktree** | **Only after step 6 is clean for every workspace.**<br>Production deploy of the same commit from the clean release worktree (benchmark evidence excluded by `.vercelignore` and by the worktree itself).<br>Smoke: health 200, unauthenticated Inbox redirects, every Inbox lists the same conversations as before.<br>Then a final dry run per workspace (clean). | PO | deploy fails or smoke fails → web Instant Rollback |
| **8. Authenticated DEV acceptance** | The acceptance matrix of DEV-PREFLIGHT-01 §8, with synthetic fixtures. Allowlist changes only as authorized in step 9. | PO | any failure |
| **9. Comments allowlist** | **Explicit, separate authorization** before `COMMENTS_REDESIGN_WORKSPACES` changes in any deployment. For acceptance: exactly the synthetic test workspaces. A pilot workspace only after steps 5–8. The change needs a new web deployment, which is its own gate. | PO | — |

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
   - Database steps (1, 3, 5, 6) run from the working checkout at the same commit, not from the worktree.
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
| Worker | **BLOCKED.** `trigger:release` deploys only HEAD == `origin/main`, so it cannot re-release an older commit. `trigger.dev promote <version>` exists, but promoting an **older** version is **not** documented as a rollback and is **not** proven for these projects. **Do not assume it works.** **Never** use force push or any history rewrite as a rollback. Until `TRIGGER-ROLLBACK-REHEARSAL-01` proves and documents a three-plane procedure (on the spare, never-deployed project first), the only executable recovery is a reviewed forward revert commit → push → CI → paired release. | **Deployment blocked** until an executable path is verified and approved |
| Schema | 0034 stays: it is additive, and the previous code neither reads nor writes `workflow`. | — |

**After a rollback:**
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

- **Daily:** a dry run per workspace (`--target development`), expecting `created 0 · repaired 0 · failed 0 · review 0`.
- **Gap check:** conversations without a work item = 0.
- **Error rates:** `inbox.conversations.list`, `workflow.conversation.mark_done` / `.reopen` and ingestion (redacted logs).

## Kept for the rollback review

- The previous list read (`listConversationActivity`) and `conversations.workflow_state` are unchanged.
- The previous builds are the rollback targets (step 1).
- No runtime switch between the lists exists. For DEV the reconcile-before-web order and the web Instant Rollback replace one; adding a switch for production is a PO decision.
