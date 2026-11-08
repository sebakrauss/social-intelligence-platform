# AWS security alerting (DEV) — deployed state and H7-AWS-ALERT-ATTRIBUTION closeout

Status of gate **H7-AWS-ALERT-ATTRIBUTION: CLOSED_WITH_RESERVATIONS** (2026-11-08).

Scope: the attribution and verification of the CloudWatch security alarms of the **DEV / Management AWS account**
(region `sa-east-1`) that feed the SNS topic `social-intelligence-platform-dev-security-alerts`. Closing this gate
means that, for the detectors H7 examined — **F1, F4, N2S and BG** — every alarm transition in the analysis windows
was attributed to a logged, identified and (where human) confirmed cause. The three worker-related alarms (F2, F3, F5)
were counted in the inventory only; their transitions were not examined by H7. It does **not** mean that AWS security
is finished: production has no alerting, the Break Glass detection is untested against the real identity, and the
reservations below stay open.

The alert *design* is `../phase-7e/aws-authorization/cloudtrail-alerting.md` (conditions H1–H12, A1–A5, C1–C2; the
"H7" there is an alert id, not this gate). This file records what was implemented and verified, with evidence classes
kept apart and never promoted:

| Class | Meaning |
|---|---|
| **VERIFIED** | Read from AWS by read-only tooling (`sts`, `cloudtrail`, `logs`, `cloudwatch`, `sns` read operations only) and reproduced offline from the saved evidence. |
| **HUMAN ATTESTATION** | Stated by the technical lead. Not an additional independent verification. |
| **OPERATOR-REPORTED** | Stated by the operator who applied the change, from console or CLI output; not re-read by the tooling. |
| **PROVISIONAL DECISION** | Decided for DEV now, with a review date. |
| **PENDING** | Not implemented, not tested or not decided. |

Repository convention: no account ID, ARN, access-key ID, session name, IP address or raw CloudTrail record appears in
this document. The sensitive evidence (`raw/`, `req/`) stays in the operator's CloudShell home and is never shared or
committed.

## 1. Deployed inventory (DEV) — seven metric filters, seven alarms, one topic

Source: CloudTrail → CloudWatch Logs log group → metric filters → metric alarms → SNS topic
`social-intelligence-platform-dev-security-alerts` (email subscription). Namespace `SocialIntelligencePlatform/Dev/Security`.
Alarm configuration verified by H7 for **N2S and BG only**: Sum, 300-second period, threshold ≥ 1, 1 of 1 datapoint,
`notBreaching`, ALARM and OK actions to the topic. The parameters of the other five alarms were not re-read by H7 and
are not stated here. The topic policy restricts CloudWatch publishing (`sns:Publish` by the CloudWatch service
principal) to the seven authorized alarm ARNs (`aws:SourceArn`) and carries explicit administrative exceptions for
non-service principals; it does not block every non-service principal.

| # | Detector | Metric | Alarm | Added | Class |
|---|---|---|---|---|---|
| F1 | Privileged / root / retired-bootstrap activity (H1–H3 family) | `PrivilegedBootstrapAnomalyCount` | `sip-dev-security-privileged-bootstrap-anomaly` | 2026-10-11 (7E.6E-ALERT) | VERIFIED |
| F2 | Worker runtime anomaly (H7, H12 family) | worker-runtime metric | `sip-dev-security-worker-runtime-anomaly` | 2026-10-11 | OPERATOR-REPORTED (name); VERIFIED (count) |
| F3 | Worker assume-role / `CreateSession` failures (H4–H6) | worker-assume-role metric | `sip-dev-security-worker-assume-role-failure` | 2026-10-11 | OPERATOR-REPORTED (name); VERIFIED (count) |
| F4 | Security configuration mutation (H10: IAM `social-intelligence-platform-dev-*`, KMS key/grant/alias, CloudTrail, audit bucket, the log group's filters, `*Alarm*`) | `SecurityConfigurationMutationCount` | `sip-dev-security-configuration-mutation` | 2026-10-11 | VERIFIED |
| F5 | Worker `Decrypt` volume (A4) | worker-decrypt metric | `sip-dev-security-worker-decrypt-volume` | 2026-10-11 | OPERATOR-REPORTED (name); VERIFIED (count) |
| N2S | Organizations writes and writes to the security topic itself | `OrganizationsMutationCount` | `sip-mgmt-security-organizations-mutation` | 2026-11-05 | VERIFIED |
| BG | Any activity by, or write targeting, the future Break Glass IAM user and its policy / MFA device | `BreakGlassActivityCount` | `sip-mgmt-security-breakglass-activity` | 2026-11-05 | VERIFIED (pattern = design `N1 v2`); detection PENDING (§3C) |

Verified on 2026-11-06 (read-only) and reproduced offline on 2026-11-08: exactly seven filters on the log group,
exactly seven alarms acting on the topic, one alarm per metric for F1/F4/N2S/BG, N2S and BG patterns byte-equal to their design hashes,
topic policy with seven `SourceArn` entries, trail multi-Region with global events, logging on, no delivery error,
retention covering the window.

## 2. Gate record

| Gate / step | Date | Result | Class |
|---|---|---|---|
| 7E.6E-ALERT | 2026-10-11 | Five filters, five alarms, topic policy (AL1A + AL1B + AL2; 8 mutations). | OPERATOR-REPORTED |
| N2S (Organizations mutation) | 2026-11-05 | Filter + alarm live; first real ALARM (`OK→ALARM` 19:33:23Z, `ALARM→OK` 19:38:23Z) attributed to the operator's `SetTopicAttributes` activity on the security topic within the datapoint window (the N2S pattern matches every write to the topic: Policy writes and the logged `KmsMasterKeyId` changes alike; no causal claim beyond the pattern match); ALARM email received. | VERIFIED (attribution), OPERATOR-REPORTED (email) |
| BG (Break Glass alerting, N1 v2 + M1/M4) | 2026-11-05 | Filter + alarm live; `INSUFFICIENT_DATA→OK` transition with a successful SNS action (seventh ARN path); OK email received. No ALARM caused by the real identity (none exists yet). | VERIFIED (OK path), PENDING (real detection) |
| H7 Break Glass technical closure audit | 2026-11-06 | `CLOSED_WITH_RESERVATIONS`: real ALARM untested; F1 flaps and Organizations events not yet attributed → this gate. | — |
| H7-AWS-ALERT-ATTRIBUTION, original run (`check-v2`) | 2026-11-06 | Read-only collection of all evidence (inventory, alarm history, metric statistics, every matching CloudTrail event, 24 `TestMetricFilter` batches). Its own verdict was not usable: the live `TestMetricFilter` responses number `eventNumber` from 1 (875/875 matches), while the AWS API reference examples number from 0, so v2 rejected every batch as UNVERIFIED and emitted F4 scope warnings that were artifacts of that rejection. | VERIFIED (collection); defect in the tool, not in AWS |
| H7-AWS-ALERT-ATTRIBUTION, REPLAY (`replay-v3`, offline) | 2026-11-08 | 0 AWS calls; original evidence byte-preserved (sha256 inventory before = after); 24/24 batches rebuilt byte-identical from the saved events and re-evaluated with `eventMessage` identity and per-batch numbering proof. Counts: PASS 29, FAIL 0, DIVERGENCE 0, UNVERIFIED 0, INCIDENT 0, WARN 4, ATTEST 3. Verdict `ATTRIBUTED_PENDING_TL_ATTESTATION`, exit 0. | VERIFIED |
| Root-session attestation | 2026-11-08 | The three root console sessions matched by F1 — R1 2026-10-22 23:58Z–2026-10-23 00:58Z, R2 2026-11-04 15:38Z–23:58Z, R3 2026-11-05 13:25Z–16:44Z — each with MFA confirmed in the evidence, were confirmed by the technical lead as their own and authorized. This completes the attribution. | HUMAN ATTESTATION |

Tooling (outside the repository, delivered to the operator with SHA-256; never run from CI): `h7-alert-attribution-check-v3.sh`
(`f05536d1…dfe248`, read-only, 11 allowlisted read operations) and `h7-alert-attribution-replay-v3.sh`
(`efbd8a93…57f2ec9`, offline). Both were tested against a synthetic AWS before use (71 scenarios, 40 unit cases, 15 replay
cases). `check-v1` and `check-v2` are superseded and must not be run.

## 3. Findings and reservations (kept open; none is cleared by this closeout)

| Id | Finding | Classification | Decision / owner | Class |
|---|---|---|---|---|
| A | SNS action of `sip-mgmt-security-organizations-mutation` **failed at 2026-11-05 19:22:23Z**, before the topic policy was corrected. A later logged Policy write added the alarm's ARN; the replay found four later SNS actions of this alarm, all successful. | `HISTORICAL_PRE_FIX`: not a current operational failure. The full root cause is **not** claimed as known (temporal sequence only). Evidence and date kept. | No action. Re-classify if any later SNS action of a security alarm fails. | VERIFIED |
| B | The security topic has **no SSE-KMS** (`KmsMasterKeyId` absent in a later read-only query). Two `KmsMasterKeyId` changes on the topic were logged on 2026-11-05; their causal relation to finding A is **not demonstrated**. | Known state, not a defect of the gate. | **PROVISIONAL DECISION:** keep SSE-KMS disabled in DEV to preserve functional delivery of the notifications; implementation not discarded. **Review before enabling PROD or by 2026-11-30, whichever comes first.** No KMS or SNS change is part of this closeout. Owner: TL. | VERIFIED (state); PROVISIONAL DECISION |
| C | `sip-mgmt-security-breakglass-activity`: synthetic validations satisfactory; OK path and SNS delivery verified. **The real ALARM caused by the Break Glass identity has never been exercised** — the identity does not exist yet. | Real detection **PENDING**. Must not be described as proven. | Gate **M3** (Break Glass identity creation and controlled test), when the user exists. | PENDING |
| D1 | Dependency-audit exception **SEC-MINIMATCH** (GHSA-g3hv-75wg-m249), expires **2026-11-30**. | Unchanged by H7. | `AUDIT-EXCEPTIONS.md`; renewal needs an explicit TL decision. | — |
| D2 | **No alert-response runbook** exists: the only runbooks (`../phase-7e/aws-authorization/runbooks/`) cover workload-identity compromise, certificate rotation and bootstrap retirement. Which alarm maps to which containment step, who is paged and what is attested after a root session is undocumented. | **PENDING**, operational. | Owner and gate not assigned. Not made a blocking gate by this closeout. | PENDING |
| D3 | **Production** has no trail, log group, filter, alarm or topic (`../phase-7e/aws-authorization/production/README.md`: DESIGNED, NOT APPLIED). H7 verifies DEV only. | Out of scope. | Production gates 2–4. | PENDING |
| D4 | The replay's four WARN items: finding A, two `KmsMasterKeyId` change rows (finding B) and the SNS-attribute note they generate. No WARN concerns detection or attribution. | Informational. | — | VERIFIED |

## 4. What a future run must respect

- Every check is read-only; the analyzer refuses any operation outside its allowlist and any output with a pagination
  token (truncation is UNVERIFIED, never PASS).
- A missing alarm history, a missing `eventMessage`, a numbering that is mixed, ambiguous or contradictory, or a batch
  that does not rebuild byte-identically from the saved events is UNVERIFIED, never PASS.
- Absence of MFA information is `MFA_UNKNOWN` (attestation required); an explicit `MFAUsed=No` or
  `mfaAuthenticated=false` root session is an INCIDENT.
- Root sessions are attributed only by a human attestation, recorded here with the dates of the sessions.
- Shareable outputs are `summary.txt`, `results.tsv` and `replay-provenance.txt` only.
