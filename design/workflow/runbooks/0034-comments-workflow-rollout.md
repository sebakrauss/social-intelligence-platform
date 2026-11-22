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
> the provider), corrected in `RECOVERY-TOOLING-03` (unit-tested only). The block stays until
> **X-3 is approved by the Product Owner** (§Recovery status). Until then, no step from 3 (migration) onward may start.

Sources:
- WORKFLOW-WF-2C, whose transition window was simulated end to end on disposable local clusters (`tests/db/local/workflow-transition-window.test.ts`);
- DEV-PREFLIGHT-01 and DEV-PREFLIGHT-02 (read-only release reviews);
- RELEASE-TOOLING-01 (reconcile-before-web order, development reconciliation target, bounded migration lock wait, clean release worktree);
- RECOVERY-TOOLING-01 (worker forward recovery with `npm run trigger:recover`, §Rollback);
- RECOVERY-REHEARSAL-03B and RECOVERY-TOOLING-02 (the recovery id, the INTEGRATION → INTELLIGENCE → MAIN order, continuation under the same id);
- RECOVERY-REHEARSAL-03C and RECOVERY-TOOLING-03 (this revision: what the isolated rehearsal observed, and the block on remote deployments in progress).

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
| CI dependency audit | `PASS` with **no exception** (DEPS-01: GHSA-g3hv-75wg-m249 remediated; the temporary exception was removed, not renewed). Any reported advisory fails CI. **Never bypassed.** |

## Steps

| Step | Action | Approval | Abort when |
|---|---|---|---|
| **1. Preflight and database metadata** | Read-only.<br>**Re-verify the baseline above.**<br>`npm run db:migrate -- --target development` (plan only): 33 applied, only 0034 pending.<br>The aggregate metadata gate (DB-METADATA-01, one READ ONLY transaction, aggregates only):<br>• sizes of `audit.audit_events`, `conversations.conversations` and `interactions.interactions`;<br>• **`count(*) where workflow_state <> 'OPEN'` = 0** (0034 refuses with 55000 otherwise);<br>• no long-running transaction.<br>Record the in-service web (deployment id **and commit SHA**) and Trigger versions as rollback targets, and the **ALIGNED release evidence file** of the in-service worker release (`.wrenkind-local/evidence/trigger-release-pair/…`, today `ff5269c` / `20261113.1`): it is the only acceptable worker recovery source. Managed T-26 is green. The Comments allowlist is empty. | PO | any mismatch |
| **2. Backups and verified recovery** | Record a restorable point (PITR position, or a logical dump of `conversations`, `interactions`, `audit`) with its timestamp.<br>**The worker recovery path is rehearsed and approved** (`trigger:recover`, end to end in `RECOVERY-REHEARSAL-03C`), and X-3 is approved (§Recovery status).<br>A **recovery plan** (`npm run trigger:recover`, PLAN ONLY) for the recorded known-good release has been run and reviewed: no structural refusal; the remaining apply prerequisites are the expected ones.<br>The web rollback target is confirmed to be the immediately previous production deployment (Hobby Instant Rollback reaches only that one). | PO | no confirmed restorable point, or no approved worker recovery |
| **3. Migration 0034** | In a quiet window. Check first that no session holds or awaits a lock on `audit.audit_events`.<br>`npm run db:migrate -- --target development --apply --lock-timeout-ms <n>` (default 5000), with the migration role, never from a runtime.<br>Verify: introspection reports 0 problems; work items = conversations. | PO | 0034 refuses (55000), a lock wait times out (see below), or the counts differ |
| **4. Coordinated worker release** | `npm run trigger:release` (all three planes, one commit), **from the clean release worktree** (below), at the pushed, CI-green commit.<br>Keep the window between 3 and 4 short. **The web is NOT released in this step.** | PO | any plane fails → STOP; worker forward recovery (§Rollback) only by a separate PO decision |
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
| Worker | **Forward recovery:** `npm run trigger:recover` redeploys the source of the recorded known-good ALIGNED release to INTEGRATION, INTELLIGENCE and MAIN as **new** versions under one new **recovery id** (below). `trigger.dev promote <version>` of an **older** version is refused by the server (`TRIGGER-ROLLBACK-REHEARSAL-01`). **Do not assume it works.** Never use it. **Never** use force push or any history rewrite as a rollback, and never the CLI's deploy force flag (`--force`). | Rehearsed end to end on three isolated synthetic projects only (`RECOVERY-REHEARSAL-03C`: PASS); its finding G1 corrected in `RECOVERY-TOOLING-03` (unit-tested only). **Operational DEV recovery has not been executed.** → deployment stays blocked until X-3 is approved (§Recovery status) |
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
  - The web nudges only MAIN: unpinned, or pinned by `TRIGGER_EXTERNAL_DEPLOYMENT_ID`.
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
- Today's web `97dcaee` beside worker `ff5269c` is such a proven pairing (DEV-PREFLIGHT-02).

**Operator checkpoints (each a PO approval):**

| # | Checkpoint | Command / evidence |
|---|---|---|
| R1 | Contain | Pause ingestion for every platform and read it back: `npm run ops:switch -- set --target development --key ingestion.provider_pause --qualifier <platform> --scope global --value '{"paused":true}' --operator <id> --reason worker-recovery --apply` |
| R2 | Web first when required | Vercel Instant Rollback; record the web commit now in service. Confirm that web's relay-nudge pin `TRIGGER_EXTERNAL_DEPLOYMENT_ID` is absent (it then reaches the current MAIN, recovered last), the known-good SHA (the original known-good MAIN, same source) or the recovery id — **never** the release being recovered from: such a web keeps waking that release's MAIN relay, whose triggers stay pinned to it in every plane, so new work would silently keep running the faulty code |
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

**Legacy v2 release evidence.**
- The operational known-good `ff5269c` has a v2 record without content fingerprints.
- **What a recovery to it verifies:** version, inventory and source (worktree at the SHA). The fingerprint is recorded but not compared: `--accept-unrecorded-fingerprint`, final state `RECOVERED_FINGERPRINT_UNVERIFIED`.
- **What stays unattested:** that the rebuilt worker equals the one that ran.
- v3 fingerprints are recorded under `--depot-build` (`RECOVERY-REHEARSAL-03B`).
- The old operational release `ff5269c` still lacks a recorded worker content fingerprint: an operational recovery to it needs the PO's explicit acceptance of inventory-only verification, or a new fingerprinted (v3) baseline release under its own gate.

### Recovery status

Three different things, never presented as equivalent:
1. **Verified synthetic recovery** — `RECOVERY-REHEARSAL-03C`: **PASS**, on three isolated synthetic projects only. One recovery id; INTEGRATION → INTELLIGENCE → MAIN; fingerprints and inventories matched; a controlled interruption, then a continuation under the same id (INTEGRATION not redeployed); the operational projects were unchanged.
2. **Operational recovery readiness** — X-3 is **CONDITIONAL**, not approved. Open:
   - the review of `RECOVERY-TOOLING-03` (G1), which has not run live;
   - the v2 fingerprint decision for `ff5269c` (above);
   - the in-service web's `TRIGGER_EXTERNAL_DEPLOYMENT_ID` (R2), which is not yet known;
   - cross-project pinning, proven in code and by the deploy order but not observed live (the synthetic tasks cannot trigger across projects).

   **Operational DEV recovery has not been executed.**
3. **Authorization to deploy DEV** — a separate Product Owner gate (steps 3 onward). Neither of the above grants it.

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

- **Daily:** a dry run per workspace (`--target development`), expecting `created 0 · repaired 0 · failed 0 · review 0`.
- **Gap check:** conversations without a work item = 0.
- **Error rates:** `inbox.conversations.list`, `workflow.conversation.mark_done` / `.reopen` and ingestion (redacted logs).

## Kept for the rollback review

- The previous list read (`listConversationActivity`) and `conversations.workflow_state` are unchanged.
- The previous builds are the rollback targets (step 1).
- No runtime switch between the lists exists. For DEV the reconcile-before-web order and the web Instant Rollback replace one; adding a switch for production is a PO decision.
