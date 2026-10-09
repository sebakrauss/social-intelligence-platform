# CloudTrail and alerting design (DEV / non-prod)

**Design only. This step creates no trail, bucket, log group, metric filter or alarm.**

- **Historical evidence:** the TA-Q-07b evidence captured on 2026-10-06 found no CloudTrail trail; that validation used
  Event History only.
- **Current live state:** CloudTrail state is **UNVERIFIED UNTIL READ-ONLY RECAPTURE**. It stays unverified until the
  mandatory read-only recapture before 7E.6 (`live-recapture-checklist.md`; LIVE_POLICY_DIFF_PENDING_READ_ONLY_CAPTURE).
- **Requirement:** a durable trail meeting this specification must exist **before the first bootstrap access key is
  issued**.

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

- **STS AssumeRole (bootstrap user):** userIdentity ARN and access-key ID, source IP, user agent, `roleArn`,
  `roleSessionName`, `errorCode`.
- **KMS Decrypt (worker role sessions):** session issuer = worker role, key ARN, encryption context (when successful),
  source IP, user agent, `errorCode`.

## Alerts

### HIGH SIGNAL

| Id | Condition |
|---|---|
| H1 | The bootstrap user performs any event other than `AssumeRole` |
| H2 | `GetCallerIdentity` by the bootstrap user. Unblockable by policy; our application never calls it |
| H3 | `GetSessionToken` by the bootstrap user. Unblockable by policy; our application never calls it |
| H4 | Burst of failed `AssumeRole` by the bootstrap user |
| H5 | `AssumeRole` targeting any role other than `<DEV_WORKER_ROLE_ARN>` |
| H6 | `AssumeRole` with a `roleSessionName` other than `integration-worker` |
| H7 | Worker role session performs anything other than `Decrypt` (including `GetCallerIdentity`) |
| H8 | `Decrypt` against any key other than `<DEV_KMS_KEY_ARN>` |
| H9 | `Decrypt` denied for the worker role. Legitimate code always sends the exact context. `InvalidCiphertextException` (well-formed but wrong context, or corrupt data) is investigated as MEDIUM |
| H10 | Change to the worker trust, the worker inline guard, the bootstrap identity policy, the boundary policy (new version or default version), the user's policies, groups or credentials, the KMS key policy, KMS grants, key state or alias, or the trail itself (`StopLogging`, `DeleteTrail`, `UpdateTrail`, `PutEventSelectors`) |
| H11 | Any event by the bootstrap user signed with temporary (`ASIA…`) credentials |
| H12 | Two **active** bootstrap access keys for more than 24 hours |

### ANOMALY / BASELINE

| Id | Condition |
|---|---|
| A1 | Source IP outside the observed Trigger.dev baseline |
| A2 | ASN outside the observed baseline |
| A3 | User agent outside the observed baseline (attacker-controlled; weak signal) |
| A4 | Worker `Decrypt` volume above `<DECRYPT_HOURLY_CEILING>`. Unresolved threshold, calibrated in 7F |

Source IP is **detection only**. A Trigger.dev static IP is never part of authorization correctness.

### COMPLIANCE

| Id | Condition |
|---|---|
| C1 | Bootstrap access key older than 30 days (our DEV/non-prod control; see `runbooks/bootstrap-key-rotation.md`) |

The detection mechanism (CloudWatch Logs metric filters, scheduled checks or another approved mechanism), recipients
and the budget impact are decided in 7E.6.
