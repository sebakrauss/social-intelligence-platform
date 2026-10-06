# TA-Q-07b — Managed AWS KMS validation: sanitized evidence summary

Durable, sanitized record of the TA-Q-07b managed validation, which closed TA-Q-07 (credential key management).
It contains no AWS-generated identifiers: no account, key, organization, identity-store or Identity Center
instance IDs, no generated role suffixes, no portal URLs, user or session identifiers, local paths,
credentials or plaintext. The raw per-run evidence directories that the harness produced stay local and are
excluded from Git (`spikes/ta-q-07-kms/.gitignore`). Every figure below was derived from them.

## Purpose and decision

- **Question (TA-Q-07):** which key-management mechanism protects provider credentials (envelope encryption,
  key outside the database, decryption only inside the integration boundary; TA §39, TA-26, ADR-38)?
- **Selected mechanism:** AWS KMS, with a customer-managed symmetric key-encryption key (KEK) outside the
  database. The rest of the design:
  - a per-record data key (DEK) with AES-256-GCM applied locally;
  - a mandatory non-secret encryption context binding `workspace_id` + `credential_id`, with no organization
    ID and no sensitive values;
  - key-policy separation: the web principal can only seal, the integration principal can decrypt, and
    re-wrapping goes through a controlled `ReEncrypt` path;
  - runtime key administration denied.
- **What TA-Q-07b validated:** the operational security boundary, not KMS cryptography.
- **Environment:** a dedicated development AWS account in region `sa-east-1`. The region was chosen for
  development validation only; the production region stays open under TA-Q-05.
- **Operator access:** an IAM Identity Center operator session (permission set with a 1-hour session and MFA),
  short-lived credentials held in memory only. **No long-lived AWS credential was created.**
- **Data:** synthetic only (random UUIDs and a random 32-byte synthetic secret). DEKs and plaintext were zeroed
  after use, envelopes never left process memory, and no customer or provider credential was used.

## Run history

| Run | Result | Notes |
|---|---|---|
| `20261006T171741Z-1aa8` | Stopped before any AWS call | Harness bug: a frozen credentials object was incompatible with SDK credential attribution. Fixed; no AWS mutation. |
| `20261006T172454Z-f40c` | Stopped after provisioning | The output guard refused a long, fixed policy statement ID. Fixed with an exact, alphabetic-only allowlist; the guard was not weakened. The resources it created were later reused and verified. |
| reconcile (read-only) | **26 / 26 PASS** | The live resources matched the approved plan before the run of record. |
| **`20261006T174405Z-e0a2`** (run of record) | **86 PASS / 0 FAIL / 5 measured / 91 total** | Provisioning reused and verified the existing resources (no duplicates). |
| cleanup dry-run (read-only) | **11 / 11 preconditions PASS** | Approved plan; nothing changed. |
| cleanup apply | **8 / 8 steps done** | Executed after explicit Product Owner authorization. |
| cleanup verify (read-only) | **35 / 35 PASS** | The final retained state matches the approved target. |

## Run of record — matrix

| Group | PASS | FAIL | Measured | Covers |
|---|---|---|---|---|
| P (preflight and inventory) | 26 | 0 | 0 | Short-lived session; region; exact roles, keys and aliases; reviewed key policies, trust policies and deny-only guards; rotation; tags; no IAM users or access keys (root included); no grants |
| W (web, encrypt-only) | 16 | 0 | 0 | `GenerateDataKey` only with a valid context on the approved key. Missing, extra, non-UUID or wrong-environment context → denied. `Decrypt`, `ReEncrypt`, `Encrypt`, `GenerateDataKeyWithoutPlaintext`, other keys and every administrative action → denied |
| K (integration worker) | 17 | 0 | 0 | Decrypts only with the exact context and only on approved keys. Wrong workspace or credential → cryptographic failure; invalid context → policy denial. Data keys on other keys, `ReEncrypt`, `Encrypt` and administration → denied. Refresh path works |
| E (envelope) | 8 | 0 | 0 | AES-256-GCM round-trip with the DEK zeroed. One flipped bit in ciphertext, tag, IV or AAD → rejected. Corrupted or swapped wrapped DEK → rejected |
| T (tenant binding) | 5 | 0 | 0 | Fresh envelope: correct context decrypts; another workspace or credential fails; a tampered envelope fails |
| R (re-wrap) | 14 | 0 | 5 | Cross-key `ReEncrypt` returns no plaintext; the same DEK opens the original ciphertext unchanged; the old context and the wrong key fail; the rotation principal can't decrypt, generate or administer; the decoy key is undecryptable by the worker |

## Security assertions (run of record)

| Assertion | Result |
|---|---|
| Plaintext credential persisted / logged | **NO / NO** |
| Plaintext DEK persisted / logged | **NO / NO** |
| Web principal can decrypt / re-encrypt | **NO / NO** |
| Worker can cross workspace / credential context | **NO / NO** |
| Rotation principal can decrypt | **NO** |
| Runtime principals can administer KMS | **NO** |
| Tampered envelope accepted | **NO** |
| Wrong encryption context accepted | **NO** |

## R6 — ReEncrypt context semantics (measured)

All five measurement cases were denied by policy (`AccessDeniedException`):
- a destination context with an extra key;
- a destination context with a non-UUID workspace;
- a destination context missing `credential_id`;
- no destination context at all;
- a source context with an extra key.

Each source or destination case ran with the other side valid, and a union of the two contexts would have
satisfied the policy. So KMS evaluates the context conditions **independently on the source and the
destination** of `ReEncrypt`: a re-wrap can't emit a context outside the approved shape. This supports the
approved design, and no policy change was needed.

## CloudTrail

- **Coverage:** complete. 66 events for 66 calls: all 18 successful calls and all 40 denied calls appear.
- **Context:** clean. 30 logged encryption contexts, all with exactly the six approved keys; values were either
  fixed constants or the run's synthetic UUIDs.
- **Plaintext:** 0 plaintext fields logged.
- **Observation:** denied KMS calls are logged without request parameters (no key or context). Denied attempts
  are therefore attributable to a principal, an operation and a time, but not to a specific record.
- **Conclusion:** sufficient for TA-Q-07. Every successful decryption is attributable to a principal, a key and
  a workspace/credential context.

## Final retained state (verified 35/35)

- **Retained:** one development KEK (customer-managed, symmetric, automatic rotation every 365 days) with alias
  `alias/social-intelligence-platform-dev-provider-credentials`. Its post-validation key policy grants
  `ReEncrypt` to no principal and denies `kms:ReEncrypt*` to everyone, and it has no grants.
- **Retained roles:** `social-intelligence-platform-dev-web-encrypt` and
  `social-intelligence-platform-dev-integration-worker`. Trust admits the operator only; each has a deny-only
  guard, and the worker's guard is scoped to the retained key only.
- **Retired:** the two temporary validation keys (aliases removed, scheduled for deletion with the 7-day minimum
  window, no grants) and the `social-intelligence-platform-dev-kms-rotation-test` role.
- **No IAM users and no IAM access keys exist** in the development account (root included).

## Open items (not part of this result)

- **Deployed-worker authentication to KMS:** the hosted job runners offered no OIDC federation, so a long-lived,
  decrypt-scoped credential would be required. This is recorded, not accepted (TA-Q-31).
- **Production:** region and data residency (TA-Q-05); account/key topology; KEK rotation and compromise
  runbooks (TA §65).
- **Web hosting and OIDC federation** for the web principal (TA-11).
- **Trigger.dev production sizing** (TA-Q-32).
- **Multi-workspace ad accounts** stay VALIDATE (TA-Q-02).

## Decision

**TA-Q-07 = PASS / LOCKED for Step 5 implementation** (Tech Lead and Product Owner, 2026-10-06; recorded in
Technical Architecture v1.2).
