# CloudTrail and alerting design (DEV / non-prod)

**Design only. This step creates no trail, bucket, log group, metric filter or alarm.**

- **Historical evidence:** the TA-Q-07b evidence captured on 2026-10-06 found no CloudTrail trail; that validation used
  Event History only.
- **Current live state:** CloudTrail state is **UNVERIFIED UNTIL READ-ONLY RECAPTURE**. It stays unverified until the
  mandatory read-only recapture before 7E.6 (`live-recapture-checklist.md`; LIVE_POLICY_DIFF_PENDING_READ_ONLY_CAPTURE).
- **Requirement:** a durable trail meeting this specification must exist **before the first bootstrap access key is
  issued** (historical requirement, met for 7E.6/7E.7) and **before the first Roles Anywhere session** of the workload
  certificate (Step 7G-H5.6B).

## Required trail

- One **multi-Region** trail. IAM events and global-endpoint STS events land in us-east-1, and a caller can use any
  Region's STS or KMS endpoint.
- Management events: **Read and Write**.
- **Do not exclude `kms.amazonaws.com`.** `Encrypt`, `Decrypt` and `GenerateDataKey` are management **Read** events.
  A write-only trail, or one that excludes KMS events, loses all Decrypt visibility.
- Log file integrity validation enabled.
- Restricted S3 destination: access limited to CloudTrail delivery and the operator. Encrypted with a logging key
  **distinct from** the provider-credential KMS key.
- Durable DEV retention target: **≥ 365 days**, implemented by the S3 lifecycle configuration (our internal target).
- Optional, if approved: CloudWatch Logs integration for metric filters and alarms.

**Event History alone is insufficient.** It covers 90 days, cannot be filtered or alerted on durably, and is not a
retention mechanism.

## Sensitive content — handle CloudTrail as security-sensitive

> AssumeRole events include the full `responseElements` **except** `SecretAccessKey`:
> the temporary **AccessKeyId**, the **SessionToken**, the **expiration** and the **assumed role identity**.
> Treat Roles Anywhere `CreateSession` events (which wrap AssumeRole) the same way until live acceptance shows exactly
> which response fields they record.

- Storage and read access to the trail are restricted accordingly.
- Alert pipelines must **never** forward complete raw `responseElements` (or whole raw events) to Slack, chat,
  webhooks, email or generic logs. Alerts carry only the minimum identifiers: event name, time, principal ARN, role
  ARN, session name, error code, source IP and user agent.

What CloudTrail records:

- KMS Decrypt events record the caller, the key and the encryption context. The context holds identifiers and fixed
  constants only.
- Denied KMS calls are logged **without** request parameters (key and context absent; TA-Q-07b finding).

What must never appear in any log we produce: provider tokens, data keys (DEKs), AWS secret access keys, session
tokens outside the restricted trail, or plaintext credentials.

## What to observe

- **Roles Anywhere `CreateSession`** (event source `rolesanywhere.amazonaws.com`): trust anchor, profile and role
  requested, `errorCode`, source IP, user agent, and `additionalEventData` (`missingSignedHeaders`, `postEmptyBody`,
  `algorithmMismatch` — present only on successfully authenticated requests; a conforming client shows an empty list
  and two `false` values). AWS documents that the resulting role session name is the **hex-encoded serial number** of
  the authenticating certificate, and that the session's **source identity** is derived from the certificate subject
  CN (`CN=social-intelligence-platform-integration-dev`).
- **KMS Decrypt (worker role sessions):** session issuer = worker role, session name = a workload certificate serial,
  key ARN, encryption context (when successful), source IP, user agent, `errorCode`.
- To be **observed, not assumed**, in live acceptance: whether and how the AssumeRole that `CreateSession` performs
  appears as its own event, and where the source identity appears on the downstream Decrypt event.
- **Retired bootstrap user:** any event at all is now an alert (H1).

## Alerts

### HIGH SIGNAL

| Id | Condition |
|---|---|
| H1 | Any event by the retired bootstrap user (it has no access key and no use) |
| H2 | `GetCallerIdentity` by the retired bootstrap user, or by a worker role session. Our application never calls it |
| H3 | `GetSessionToken` by the retired bootstrap user. Unblockable by policy; our application never calls it |
| H4 | Burst of failed `CreateSession` calls against the DEV trust anchor or profile |
| H5 | `CreateSession` for any role other than `<DEV_WORKER_ROLE_ARN>`, or through any trust anchor or profile other than the DEV ones |
| H6 | A worker role session whose session name is not the serial of a currently issued workload certificate, or whose source identity is not `CN=social-intelligence-platform-integration-dev` |
| H7 | Worker role session performs anything other than `Decrypt` (including `GetCallerIdentity`) |
| H8 | `Decrypt` against any key other than `<DEV_KMS_KEY_ARN>` |
| H9 | `Decrypt` denied for the worker role. Legitimate code always sends the exact context. `InvalidCiphertextException` (well-formed but wrong context, or corrupt data) is investigated as MEDIUM |
| H10 | Change to the worker trust, the worker inline guard, the Roles Anywhere trust anchor, profile or CRLs (create, update, enable, disable, delete), the KMS key policy, KMS grants, key state or alias, the retired bootstrap user's policies, groups or credentials, or the trail itself (`StopLogging`, `DeleteTrail`, `UpdateTrail`, `PutEventSelectors`) |
| H11 | A successful `CreateSession` whose `additionalEventData` is not conforming (a non-empty `missingSignedHeaders`, `postEmptyBody` or `algorithmMismatch` true) |
| H12 | A worker role session created other than through Roles Anywhere (an `AssumeRole` by any IAM principal) |

### ANOMALY / BASELINE

| Id | Condition |
|---|---|
| A1 | Source IP of `CreateSession` or `Decrypt` outside the observed Trigger.dev baseline |
| A2 | ASN outside the observed baseline |
| A3 | User agent outside the observed baseline (attacker-controlled; weak signal) |
| A4 | Worker `Decrypt` volume above `<DECRYPT_HOURLY_CEILING>`. Unresolved threshold, calibrated in live acceptance |
| A5 | `CreateSession` volume far above the expected cadence (one per ~13 minutes per active worker process) |

Source IP is **detection only**. A Trigger.dev static IP is never part of authorization correctness.

### COMPLIANCE

| Id | Condition |
|---|---|
| C1 | Workload certificate within 30 days of expiry, or older than 60 days (our DEV/non-prod control; see `runbooks/workload-certificate-rotation.md`) |
| C2 | The retired bootstrap user still exists after the retirement gate (`runbooks/bootstrap-retirement.md`) |

The detection mechanism (CloudWatch Logs metric filters, scheduled checks or another approved mechanism), recipients
and the budget impact are decided by the operator gates (7E.6 established them for the bootstrap design; the Roles
Anywhere alerts above replace H1–H12 and C1 when the trust is rewritten).
