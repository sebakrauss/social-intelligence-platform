# TA-Q-07b — Managed AWS KMS validation (disposable spike)

**Not production code.** This spike validates the operational security boundary of the selected credential
key-management mechanism (AWS KMS, TA-Q-07) in the dedicated development account. It isn't imported by the
application, and its dependencies are local to this folder.

- Region `sa-east-1`. All resources use the `social-intelligence-platform-dev-` prefix and the
  `Validation=TA-Q-07b` tag.
- Operator access goes through the IAM Identity Center device flow. Short-lived credentials live in memory
  only: no AWS CLI, no credential files, no long-lived keys.
- Data is synthetic only (random UUIDs and a random 32-byte secret). DEKs and plaintext are zeroed after use.
  Envelopes never leave memory.
- Console output and evidence pass through `lib/guard.mjs`. It redacts the account ID and operator, refuses
  secrets, credential shapes, long opaque values and binary values.

```sh
npm ci
npm run selftest                 # offline
npm run validate                 # provisions the approved resources and runs the matrix (needs .env.local)
node scripts/run.mjs audit --run <runId>   # re-run an incomplete CloudTrail audit
```

`.env.local` (git-ignored) holds only the access-portal URL and the expected account ID (see `.env.example`).

Raw per-run evidence (`evidence/<runId>/`, `reconcile-*`, `cleanup-*`) contains AWS-generated identifiers. It
stays local and is git-ignored. The committed record is the sanitized
`evidence/ta-q-07b-validation-summary.md`.

Closeout: TA-Q-07 PASS (Technical Architecture v1.2). The cleanup was applied and verified 35/35
(`npm run cleanup:verify`, read-only). One development KEK and the web-encrypt and integration-worker roles
remain.
