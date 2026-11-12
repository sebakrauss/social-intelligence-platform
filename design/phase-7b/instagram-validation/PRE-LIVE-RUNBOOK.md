# First LIVE Instagram reply validation — PRE-LIVE runbook (Step 7B-14I3H)

**Status: DOCUMENTATION ONLY.** This runbook does not authorize anything. Every step that touches a real system
(migrating, provisioning a login, deploying, running a task, issuing an authorization, calling Meta) needs its own
explicit authorization from the TL, in its own gate. Nothing here closes a PRE-LIVE risk by being written down.

Scope: ONE public reply, on ONE audience comment, of the ONE Instagram account in `social-intelligence-dev-v2`. It runs
through the normal product path: the Inbox request, the executor, and the 0028/0029/0030 authorization. There is no
second attempt on the same comment, ever.

## 0. Preconditions (each verified read-only, each recorded)

| # | Check | Expected |
|---|---|---|
| P1 | Git | `HEAD = origin/main` and the commits that carry 0030 and 0031 are pushed, with CI green |
| P2 | DEV ledger | 0029, 0030 **and** 0031 applied in ONE controlled window, **before** any `validation_operator_*` login exists (0030 refuses to apply otherwise). After it: every application function pins `search_path = pg_catalog, pg_temp` (TA §11 R4a; introspection 0 problems) |
| P3 | DEV server version | PostgreSQL ≥ 16. The identity check reads `pg_auth_members.inherit_option` / `set_option`; on an older server it errors, which fails closed |
| P4 | Runtimes | Web and Trigger (all three planes) are deployed **at the same commit**: the web sends the request, and the INTEGRATION plane runs the executor and the PREFLIGHT, with H1 |
| P5 | Controls | `mutation.provider_action`: 18/18 DENY (no grant). Catalog r5: `reply_public` UNKNOWN_NOT_VALIDATED. The workspace is STANDARD. 0 open authorizations. 0 intents for the target |
| P6 | Operator login | Exactly ONE `validation_operator_<handle>` login, provisioned in its own gate after P2 (NOINHERIT; ONE membership in `app_validation_operator` WITH SET, without INHERIT or ADMIN; CONNECT only; no settings, objects or grants). `npm run ops:validation-authorization -- status …` passes the session precheck |
| P7 | Operator URL | `DATABASE_VALIDATION_OPERATOR_URL` names the pinned project's **session pooler** (sa-east-1) or its **direct host**. Never localhost, a tunnel, an IP literal or an alias: the fence refuses them, and the CLI re-checks TLS (verify-full) after connecting |
| P8 | Target | An **audience** top-level comment (not by the managed account), visible and available, that has **never** been replied to by anyone, manually or through the product, and has never been the target of any authorization |

## 1. PREFLIGHT (read-only on Meta: GET only)

1. Run the INTEGRATION task `integration.instagram_reply_preflight` in `preflight` mode for the exact
   workspace / account / comment (in its own authorized gate). Its output gives `{ kind: "recorded", preflightId,
   recordedAt, passed }`.
2. **Check the exact run in Trigger (read-only: MCP `get_run_details` / dashboard):**
   - task `integration.instagram_reply_preflight`, project INTEGRATION, environment prod, status COMPLETED;
   - its worker version is the deployed version from P4;
   - its output's `preflightId` is the one you will issue from, and `passed` is `true`;
   - record the run id (`run_…`).
3. **Compare it with the persisted evidence.** Any mismatch → STOP. The read-only DB snapshot is taken by the migration
   role, never by the operator login. Check that:
   - `mutations.validation_preflights.run_reference` equals that run id;
   - `recorded_at` equals the output's `recordedAt` (to the millisecond) and is ≤ 30 minutes old;
   - `passed = true`, `status = VERIFIED`, `checks_verified = 10`, and `replies_by_managed_account = 0 = replies_unattributed`;
   - `connected_account_id`, `target_interaction_id`, `connection_id` and `credential_id` are the account, comment,
     connection and **current active credential** you expect;
   - `authorization_id` is NULL (unused).
4. **No change since the PREFLIGHT:** the connection is ACTIVE, `active_credential_id` is unchanged, the account is ACTIVE,
   and the comment is still visible and available, with no new replies. If anything changed, run a NEW PREFLIGHT.
   0029 refuses the issuance if anything changed, and H1 refuses at execution if the credential changes later.

## 2. Token type NOT_VERIFIED — explicit human acceptance

The INTEGRATION plane cannot observe whether the stored token is the token type the reply POST requires. The evidence
records `token_type = NOT_VERIFIED`.

- Before issuing, the TL records in writing (in the gate's report) that they **accept** the NOT_VERIFIED token type for
  this ONE validation, and what they accept: the POST may fail with a permission or token error (FAILED,
  PERMISSION_MISSING / CREDENTIAL_INVALID). That outcome consumes the authorization **and** the comment, for ever.
- Only then does the operator pass `--accept-token-type-not-verified`. The flag is recorded in the operator log
  (`token_type_not_verified_accepted = true`).

## 3. Issue (one authorization, ≤ 60 minutes)

1. Dry run first, then the real issue:
   `npm run ops:validation-authorization -- issue --target development --workspace <ws> --preflight <preflightId> --initiator <member> --reason live_validation --lifetime-minutes 30 --accept-token-type-not-verified`.
   Run it once without `--apply`, then once with `--apply`.
2. Record the `authorization_id` and `expires_at`, and check `status`: ISSUED, `preflight_id` = the evidence,
   `operator_events = 1`.

## 4. The ONE request (human presses Send)

- **Unique text.** The reply text must be unique and recognizable: a fixed prefix plus the authorization id's first 8
  characters, for example `Gracias por tu comentario (validación a1b2c3d4).` It must never be reused, and nobody may
  reply manually to that comment from Instagram or Meta Business Suite.
  - Why: reconciliation attributes a reply by account identity, parent, exact text and time. A unique text is what
    makes a single match meaningful. This does **not** close "attribution by unique text" (PRE-LIVE): a human can
    still post the same text.
- The initiator opens the comment in the Inbox, in validation mode, and presses Send **once**.

## 5. Outcomes — what to do (never a second POST)

| Intent status | Meaning | Action |
|---|---|---|
| CONFIRMED (with provider reply id) | The reply exists | Verify it on Instagram (read only), then record the result. The authorization is CONSUMED; the comment can never be validated again |
| BLOCKED from PENDING | A guard refused before anything was spent (e.g. H1: credential ≠ examined; evidence missing) | Nothing was sent, and the authorization is **not** consumed. Diagnose, then revoke it (`--reason superseded`). A new attempt needs a NEW PREFLIGHT (and, if the comment is still eligible, a new authorization) |
| BLOCKED after EXECUTING | A final gate refused (control, credential or evidence changed) | Nothing was sent. The authorization **is** consumed: that comment is spent. A new validation uses ANOTHER comment |
| FAILED | Meta refused definitively | Spent. Record the code, and never retry on that comment |
| EXECUTING (no outcome) | The run died, or the last gate's read failed after the KMS opened the credential | **Do not resend.** Only the operator reconciliation task (`integration.mutation_reconcile`, read-only GET) may look. It first records OUTCOME_UNKNOWN (RUN_INTERRUPTED) |
| OUTCOME_UNKNOWN | The request may have left | **Never resend.** Run the reconciliation task (read-only). `found` (exactly one unique match) → CONFIRMED. `not_found` / `ambiguous` / `incomplete` → it stays unknown, and a human checks on Instagram |

**Prohibited without exception:** a second POST, a manual reply on that comment, re-issuing on that comment, changing
`provider_action`, or enabling `reply_public` in the catalog to "retry".

## 6. Emergency stop and its limits

- **Before consumption** (ISSUED / BOUND, intent PENDING), any of these stops the attempt:
  - revoke: `ops:validation-authorization -- revoke … --reason incident --apply`;
  - the `mutation.provider_action` `*` emergency block (`ops:switch`, `paused`), which every gate honors;
  - Monitor-only mode on the workspace.
- **After consumption** (EXECUTING): revocation is refused by design (0028: a consumed authorization is never recalled).
  The switch, the mode and a credential rotation still stop the attempt at the **second gate**, if they commit before
  its reads. What they **cannot** stop: a request that already left, or one leaving in the residual window between the
  second gate's commit and the POST (PRE-LIVE, open). Recovery after that is reconciliation, never a resend.
- Freeze controls during the window. From issuance to the outcome, nobody rotates credentials, changes the connection,
  changes switches (except an emergency stop) or edits the comment's account.

## 7. Afterwards

Take a read-only snapshot and record:
- the authorization: CONSUMED;
- the operator log (issued [, revoked]) and the audit rows;
- the intent history;
- the outbound reply (provider id, `confirmed_at`);
- still 18/18 DENY, catalog r5, 0 other intents.

Nothing in this run validates `reply_public` in the catalog: that is a separate decision.
