# Runbook — suspected bootstrap credential compromise (U1 → U2)

DEV/non-prod. U1 is the compromised bootstrap user; U2 is its replacement. **U1 is never restored.**

## Threat model

Three credential layers must be contained (`threat-model.md`):

- **A.** The long-lived U1 access key.
- **B.** GetSessionToken-derived U1 credentials. **AWS_DOCUMENTATION_CONFLICT — ASSUME_WORST_CASE**: assumed able to
  attempt `AssumeRole`. They live up to 36 hours.
- **C.** Already-issued worker role sessions. Up to 3600 seconds each: an attacker can request the role maximum,
  regardless of our 900-second request.

Containment does not rely on deactivating the access key alone. Derived credentials and role sessions outlive it.

## Sequence

Operator: `<DEV_OPERATOR_ROLE_ARN>`.

1. **T1 — deny U1.** Attach `artifacts/emergency-deny-all.json` to U1 as an inline policy. It is evaluated on every
   request, so it contains layers A and B, including existing GetSessionToken sessions. Allow a few minutes for IAM
   propagation.
2. **T2 — deactivate U1's access key** (`UpdateAccessKey` to Inactive; do not delete). No new GetSessionToken
   credentials can be minted from it after T2.
3. **Revoke old worker role sessions** (layer C). Attach `artifacts/revoke-older-sessions.json` to the worker role,
   inline, named `AWSRevokeOlderSessions`.
   - Set `<REVOCATION_CUTOFF_UTC>` to the current time plus about 30 seconds.
   - The operator needs `iam:PutRolePolicy` on the worker role.
   - It denies every session issued before the cutoff. Because the role is dedicated, that blast radius is acceptable.
   - Do this **after** step 1, so no new session can be minted after the cutoff.
4. **Investigate in CloudTrail:**
   - every event by U1, including temporary `ASIA…` credentials, since the key's creation;
   - confirm no successful `AssumeRole` after T1 plus propagation;
   - list the worker Decrypt events and their encryption contexts.
   If the database or the Trigger.dev project were also exposed, treat the provider credentials behind those contexts
   as compromised and re-authorize them.
5. **Create a NEW user U2.** Use a new name with the `social-intelligence-platform-dev-` prefix. Same-name reuse is
   impossible while U1 exists.
6. **Apply to U2** the approved `artifacts/bootstrap-identity-policy.json` (inline) and
   `artifacts/bootstrap-permissions-boundary.json` (permissions boundary).
7. **Intentionally rewrite the worker trust** (`artifacts/worker-trust-policy.json`) to U2's ARN. U1 now has no trust
   grant, independently of its Deny.
8. **Create U2's access key.**
9. **Provision it directly** into the INTEGRATION Trigger.dev secret (mechanism from 7E.6/7E.7; never via Vercel,
   chat, logs, source or shell history).
10. **Validate** the worker path (7F procedure) and confirm `AssumeRole` by U2 in CloudTrail.
11. **Keep U1 denied permanently.** Never remove `EmergencyDenyAll` while U1 exists.
12. **Delete U1** only after evidence preservation **and** T2 + 36 hours + a safety margin, so every derived credential
    has expired.

While contained, integration jobs fail without automatic retry (`credential_keyring_access_denied` or an identity
failure). They are surfaced for diagnosis (R7) and never blindly re-dispatched. After revocation, a worker's cached
pre-cutoff session keeps failing until it reaches its refresh window. Any session issued after the cutoff works.

## Final U1 deletion (CLI/API)

Programmatic `DeleteUser` does **not** remove subordinate items. It fails with `DeleteConflict` while any remain. The
console may automate some of this cleanup; this runbook must be safe for CLI/API automation. Only in this final,
destructive sequence, after the containment and evidence windows, remove in order:

1. Access keys: `DeleteAccessKey` for each (already inactive).
2. Inline policies: `DeleteUserPolicy` for each, **including `EmergencyDenyAll`**. Allowed only here, as part of
   deleting U1.
3. Attached managed policies, if any: `DetachUserPolicy`.
4. Group memberships, if an invariant violation created one: `RemoveUserFromGroup`.
5. Other subordinate credentials, if any:
   - `DeleteLoginProfile`;
   - `DeleteSigningCertificate`;
   - `DeleteSSHPublicKey`;
   - `DeleteServiceSpecificCredential`;
   - `DeactivateMFADevice` / `DeleteVirtualMFADevice`.
6. Permissions boundary: `DeleteUserPermissionsBoundary`. This is defensive: AWS does not list it as required for
   deletion.
7. `DeleteUser`.

Steps 1–7 run back to back.
