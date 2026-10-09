# Runbook — bootstrap access-key rotation (normal, zero downtime)

DEV/non-prod. Applies to the bootstrap IAM user `<DEV_BOOTSTRAP_USER_NAME>` (C1_STRICT). For a suspected leak, use
`bootstrap-compromise.md` instead.

## Lifecycle policy

| State | Rule |
|---|---|
| Normal | Exactly **one** active access key |
| Rotation | Temporarily **two** active keys, for at most **24 hours** of overlap (alert H12 otherwise) |
| Old key inactive | Observed for up to **7 days**, then deleted |
| Maximum key age | **30 days** (alert C1), plus immediate rotation after any security event |

- The 30-day maximum is **our internal DEV/non-prod control**, stricter than common baselines. It is not an AWS
  universal requirement.
- IAM allows at most two access keys per user. Never keep a second, dormant key "just in case".

## Secret-handling rules

- Never paste, print or store the secret value in chat, logs, shell history, files, source or Vercel.
- The new key goes **directly** into the INTEGRATION Trigger.dev project's environment secrets.
- The transfer commands are **not defined here**. They belong to 7E.6/7E.7, once the secure transfer mechanism is
  selected.

## Sequence

1. Verify the starting state: exactly one active key (`<BOOTSTRAP_KEY_A_ID>`), no open incident, trail logging.
2. Create key B (`<BOOTSTRAP_KEY_B_ID>`).
3. Provision key B directly into the INTEGRATION Trigger.dev secret, through the mechanism approved in 7E.6/7E.7. Never
   route it through Vercel, chat, logs, source or shell history.
4. Run a controlled worker validation (procedure defined in 7F).
5. Confirm in CloudTrail an `AssumeRole` by the bootstrap user with access-key ID `<BOOTSTRAP_KEY_B_ID>`.
6. Verify key A is no longer used: no `AssumeRole` with `<BOOTSTRAP_KEY_A_ID>` after the switch (CloudTrail is the
   primary evidence; IAM last-used data is not real-time).
7. Deactivate key A (do not delete yet). This ends the two-active-keys window (≤ 24 h).
8. Observe: no failures and no attempts with key A (alert H4 / H1).
9. Delete key A, at the latest 7 days after deactivation.
10. Confirm the end state: exactly one active key (B).

## Open item: atomic update of ID and secret

Whether Trigger.dev can update the access-key ID and the secret **atomically** is not yet known (validate in
7E.6/7F). If it cannot, a run may briefly read a mismatched pair. That must **fail closed**: STS rejects the signature,
the worker identity reports an identity failure, and no other credential is ever tried. Rotate in a quiet window.

## No rollback to key A

Key A's secret exists only in the Trigger.dev secret that key B replaced. If key B is broken, fix forward: delete B,
create C, repeat.
