# Runbook — retirement of the Step 7E.4C bootstrap IAM user

DEV/non-prod. **Run only after the Roles Anywhere live acceptance has passed** (one `CreateSession` and one worker
`Decrypt` attributed to the workload certificate, and no event by the bootstrap user since the trust rewrite). It is a
separate, explicitly authorized AWS mutation gate.

## What becomes removable

| Resource | Artifact |
|---|---|
| IAM user `<DEV_BOOTSTRAP_USER_NAME>` (`<DEV_BOOTSTRAP_USER_ARN>`) — currently **0 access keys** | — |
| Its inline identity policy | `artifacts/retired/bootstrap-identity-policy.json` |
| Its customer-managed permissions boundary `<DEV_BOOTSTRAP_BOUNDARY_POLICY_ARN>` | `artifacts/retired/bootstrap-permissions-boundary.json` |
| The bootstrap incident template | `artifacts/retired/emergency-deny-all.json` |
| Bootstrap-specific alerts of the old design | replaced by the Roles Anywhere alerts in `cloudtrail-alerting.md` |

The worker role is **kept**: only its trust changes (already done before this runbook runs).

## Preconditions

1. The worker trust is the Roles Anywhere trust (`artifacts/worker-trust-policy.json`): it names no IAM principal.
2. The user has no access key, no login profile and no other credential (read-only check).
3. The trail shows no event by the user since the trust rewrite.

## Deletion (CLI/API)

Programmatic `DeleteUser` does **not** remove subordinate items; it fails with `DeleteConflict` while any remain.
Remove in order, back to back:

1. Access keys, if any: `DeleteAccessKey`.
2. Inline policies: `DeleteUserPolicy`.
3. Attached managed policies, if any: `DetachUserPolicy`.
4. Group memberships, if any: `RemoveUserFromGroup`.
5. Other credentials, if any: `DeleteLoginProfile`, `DeleteSigningCertificate`, `DeleteSSHPublicKey`,
   `DeleteServiceSpecificCredential`, `DeactivateMFADevice` / `DeleteVirtualMFADevice`.
6. Permissions boundary: `DeleteUserPermissionsBoundary`.
7. `DeleteUser`.
8. Delete the customer-managed boundary policy (all versions).

Afterwards, delete the `artifacts/retired/` files and their tests in a source change, and remove the retired variable
names from the refusal lists once no environment can still carry them.
