# Runbook — workload certificate rotation (normal, zero downtime)

DEV/non-prod. Applies to the INTEGRATION worker's Roles Anywhere workload certificate (Step 7G-H5.6B). For a suspected
leak of the leaf key or the CA key, use `workload-identity-compromise.md` instead.

## Lifecycle policy

| State | Rule |
|---|---|
| Normal | Exactly **one** issued, unexpired leaf certificate in use |
| Validity | about **90 days** per leaf |
| Rotation | start around **day 60**; never later than **30 days** before expiry (alert C1) |
| Overlap | the old leaf stays valid until it expires on its own; it is no longer configured anywhere after the switch |

- These numbers are **our internal DEV/non-prod control**. They are not an AWS requirement.
- The CA key stays offline throughout. It is used only to sign the new leaf.

## Secret-handling rules

- Never paste, print or store the private key in chat, logs, shell history, files in the repository, source or Vercel.
- The new key goes **directly** into the INTEGRATION Trigger.dev project as a **Secret** variable (one line with
  literal `\n` sequences). The certificate goes into its own variable.
- Generate leaf keys as ECDSA P-256 with a **named curve** (OpenSSL: `ec_param_enc:named_curve`). The credential helper
  rejects explicit curve parameters, and the worker refuses such a certificate before any request.

## Sequence

1. Verify the starting state: one leaf in use (`<WORKLOAD_CERTIFICATE_A_SERIAL>`), no open incident, trail logging.
2. Generate a new leaf key pair offline; issue leaf B (`<WORKLOAD_CERTIFICATE_B_SERIAL>`) from the offline CA with the
   contract in `README.md` (subject CN, `CA:false`, `digitalSignature`, ~90 days).
3. Replace the INTEGRATION certificate and private-key variables together (the worker re-reads both on every
   resolution; no redeploy is needed). Destroy the local copy of key B afterwards.
4. Run the controlled worker validation (the `integration.kms_worker_auth_diagnostic` task).
5. Confirm in CloudTrail a `CreateSession` and a worker `Decrypt` whose session name is B's hex serial.
6. Confirm A is no longer used: no session named A's serial after the switch.
7. Let A expire. Nothing else is required; disable nothing.
