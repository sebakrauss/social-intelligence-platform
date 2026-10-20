# Runbook — workload identity compromise (leaf key or CA key)

DEV/non-prod. Applies when the INTEGRATION workload private key, or the offline CA key, may have leaked.

## Contain (immediately, in this order)

1. **Disable the Roles Anywhere profile** (`<DEV_ROLES_ANYWHERE_PROFILE_NAME>`): no new session through it.
2. For a suspected **CA key** compromise, also **disable the trust anchor** (`<DEV_ROLES_ANYWHERE_TRUST_ANCHOR_NAME>`).
3. **Revoke existing sessions** of the worker role: attach `artifacts/revoke-older-sessions.json` with
   `<REVOCATION_CUTOFF_UTC>` set to now. Sessions last at most 900 seconds anyway; this ends them at once.
4. Remove the certificate and private-key variables from the INTEGRATION Trigger.dev project.

While contained, integration jobs fail closed (`credential_keyring_access_denied` or an identity failure). They are
surfaced for diagnosis (R7) and never blindly re-dispatched.

## Recover

- **Leaf compromise:** issue a new leaf from the existing CA (`workload-certificate-rotation.md`, steps 2–5) and
  re-enable the profile. The leaked leaf expires on its own; for an urgent cut-off before expiry, import a CRL that
  lists its serial (optional Roles Anywhere feature, API/CLI only).
- **CA compromise:** create a new offline CA, a new trust anchor for it, rewrite the trust's `aws:SourceArn` and
  issuer CN to the new anchor and CA, issue a new leaf, then delete the old trust anchor.
- Validate with the diagnostic and confirm the new serial in CloudTrail.
- Keep the revocation policy attached until every session issued before the cutoff has expired, then remove it.

Never weaken the trust's three conditions to restore service.
