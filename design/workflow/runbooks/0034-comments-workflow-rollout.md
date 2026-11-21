# Runbook: migration 0034 and the Comments Workflow rollout (DEV)

DEV only. **NOT executed.** Every step is a separate, explicitly authorized Product Owner gate.

Source: WORKFLOW-WF-2C, whose transition window was simulated end to end on disposable local clusters (`tests/db/local/workflow-transition-window.test.ts`).

"Abort" means: stop, keep the current state, report. Nothing is undone automatically.

## What changes

- **Migration `0034_workflow_core.sql`** (forward-only, additive):
  - creates `workflow.work_items` and `workflow.workflow_events`;
  - backfills one OPEN work item per existing conversation.
- **The new worker** projects activity, creates work items and performs the objective auto-reopen.
- **The new web** lists Comments from the work items and offers Mark done / Reopen.

### Why reconciliation is required

Between the migration and the new worker, the previous worker ingests without the workflow:
- **a conversation created in that window has no work item and is not listed;**
- an activity can be stale;
- **a Done recorded in that window can miss its reopen.**

Reconciliation repairs the first two and **reports** the third. It never changes a state.

## Steps

| Step | Action | Approval | Abort when |
|---|---|---|---|
| **A. Tooling** | `ops:workflow-reconcile` accepts only a loopback database today. Widening its fence to the DEV project (the identity fence of `tools/db/environment.ts`: project reference, region, CA) is its own reviewed change, tested against a disposable local cluster first. | PO | the fence admits any other target |
| **B. Preconditions** | Read-only checks: the DEV ledger is at 0033 with **only** 0034 pending; **no conversation with `workflow_state <> 'OPEN'`** (0034 refuses with 55000 otherwise); the web and Trigger versions in service are recorded as rollback targets; the T-26 baseline is green. **The Comments pilot allowlist (`COMMENTS_REDESIGN_WORKSPACES`) is empty, and it stays empty until step F.** | PO | any mismatch |
| **C. Backup** | Record a restorable point (PITR position or logical dump of `conversations`, `interactions`, `audit`) with its timestamp. | PO | no confirmed restorable point |
| **D. Migration** | Apply 0034 with the migration role (`db:migrate`, DEV target), never from a runtime. Verify: introspection reports 0 problems; work items = conversations. | PO | 0034 refuses, or the counts differ |
| **E. Paired release** | Deploy the Trigger worker and the web **from the same commit** (`trigger:release` pair, then the web), keeping the window between D and E short. | PO | either release fails → rollback (G) |
| **F. Reconcile EVERY workspace** | For each workspace that has conversations: (1) **dry run** `npm run ops:workflow-reconcile -- --database-url-env <VAR> --workspace <id>` and read the counts; (2) **apply** the same with `--apply` (resume an interrupted run with `--after <next> --run <runCorrelationId>`); (3) **verify** with a second dry run, which must report `created 0 · repaired 0 · failed 0`. Then check, per workspace: work items = conversations, and the Open / Done / All lists equal the list definition. | PO | `failed > 0` (inspect `failedIds`; rerun is safe), or a second dry run that is not clean |
| **F'. Items flagged for review** | `review > 0` lists Done conversations with an audience comment Wrenkind first observed after the Done (only possible if a Done happened during the window). A person opens each one and decides: Reopen, or leave it Done. Reconciliation never reopens. | PO / workspace owner | — |
| **F''. Pilot** | Only after F (and F') is complete for every workspace: the allowlist may be set for a pilot workspace, as a **separate** decision. | PO | — |
| **G. Rollback** | Redeploy the previous web and Trigger builds (recorded in B). 0034 stays: it is additive, and the previous code neither reads nor writes `workflow`. Done states recorded in the meantime are invisible to the previous list (it shows every conversation OPEN), and conversations ingested by the previous worker get no work item. | PO | — |
| **H. Re-forward** | After a rollback: E, then F for every workspace, again. | PO | as in E and F |

## Reconciliation guarantees (what makes F safe to repeat)

- **Scope and atomicity:**
  - per workspace, in the worker's existing scope and RLS;
  - bounded batches, each its own transaction and resumable;
  - each item in its own savepoint.
- **What it changes:** it creates a missing work item once, OPEN v1, with one `created` event carrying the run id, and it recomputes a stale activity, locking before recomputing (safe beside live ingestion).
- **What it never changes:** state, resolution, attribution or version. It writes no audit event and deletes nothing.
- **Dry run:** a READ ONLY transaction; the database refuses writes.
- **Report:** `inspected · created · repaired · unchanged · failed · review`, with ids only.

## Monitoring (during the pilot)

- **Daily:** a dry run per workspace, expecting `created 0 · repaired 0 · failed 0 · review 0`.
- **Gap check:** conversations without a work item = 0.
- **Error rates:** `inbox.conversations.list`, `workflow.conversation.mark_done` / `.reopen` and ingestion (redacted logs).

## Kept for the rollback review

- The previous list read (`listConversationActivity`) and `conversations.workflow_state` are unchanged.
- The previous builds are the rollback target.
- No runtime switch between the lists exists; adding one is a PO decision.
