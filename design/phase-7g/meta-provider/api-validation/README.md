# API-validation evidence contract (Step 7G-H5.5-P4-B)

The schema and process for the evidence behind a **future** real-platform capability catalog entry. No record exists
yet and none may be fabricated: the platform catalog stays `platform` revision 2 with **zero entries**. The enforcing
code is `modules/capability/domain/catalog-contract.ts` (development/test-time only; guard-tested by
`tests/unit/modules/capability-catalog-contract.test.ts` and
`tests/architecture/capability-catalog-contract-guards.test.ts`).

## Blocker in force

`FIRST_VALIDATED_PLATFORM_ENTRY_BLOCKED_UNTIL_AUTHORIZATION_SEMANTICS_RESOLVED = YES`
(`AUTHORIZATION_SEMANTICS_OPEN_BEFORE_FIRST_VALIDATED_ENTRY`). Until a later gate resolves the authorization semantics
(see the Meta README › Capability catalog contract), the contract refuses **every** platform entry, whatever its
evidence.

## What an entry needs (fail closed)

| Entry state | Requires |
|---|---|
| SUPPORTED / AVAILABLE_WITH_LIMITATION | `validation: "validated"`; `evidence` = the id of an **accepted, positive** record for the exact (provider, platform, asset class, capability, content kind, source); a **non-empty** `requiredPermissions` set, each permission explicitly named, equal to the record's; an explicit `IMPLEMENTED_PLATFORM_OPERATIONS` registration of the Wrenkind provider operation for that (platform, capability) resting on the same record; a named platform (never `any`); a limitation exactly when the state is AVAILABLE_WITH_LIMITATION |
| UNSUPPORTED | `validation: "validated"`; `evidence` = the id of an **accepted, authoritative-negative** record of the exact scope, whose basis is `provider_documentation` or `provider_non_eligibility_observation`; **no** required permissions; no limitation |
| UNKNOWN_NOT_VALIDATED | never an entry: it is the catalog default |

Not evidence, ever: an adapter exposing a method; a documented provider feature by itself; a granted or missing
permission; a permission Wrenkind never requested; an unimplemented operation; unavailable facts; a failed provider read;
the catalog lacking a rule; account infrastructure reads (`discoverAssets`, `describeAccount`).

## Record schema

One JSON file per record, `records/<provider>/<platform>/<capability>/<YYYYMMDD>-<NN>.json` under this directory (the
directory is created by the first validation gate). Id: `api-validation:{provider}/{platform}/{capability}/{YYYYMMDD}-{NN}`.

| Field | Content |
|---|---|
| `id` | the id above; its segments equal the fields below |
| `provider` | `meta` (facebook, instagram) or `tiktok` |
| `platform` | `facebook` / `instagram` / `tiktok` |
| `assetClass` | `content_bearing` / `ad_account` |
| `accountKind` | the account TYPE validated, e.g. `facebook_page`, `instagram_professional_account` — never an account |
| `capability` | one of the ten capability keys |
| `contentKind`, `source` | the exact scope (`any` allowed) |
| `operation` | the Wrenkind provider contract operation exercised (`READ_OPERATIONS` / `MUTATION_OPERATIONS`) |
| `validatedOn` | `YYYY-MM-DD`, equal to the id's date |
| `sourceRevision` | the 40-hex commit of the code that ran |
| `requiredPermissions` | sorted, distinct, explicitly named permissions/scopes the operation needed |
| `scenario` | the controlled test performed (asset kind, action), in prose |
| `observedResult` | what was observed, in closed terms (status classes, counts) |
| `polarity` | `positive` or `authoritative_negative` |
| `negativeBasis` | `provider_documentation` / `provider_non_eligibility_observation` for a negative; `null` for a positive |
| `reviewer` | a ROLE (e.g. `TL`), never a person's name |
| `status` | `draft` / `accepted` / `rejected`; only `accepted` can back an entry |

Never in a record: access tokens or any credential; Meta (or any provider) ids of pages, accounts, users, businesses or
apps; workspace, connection, account or credential ids; AWS ids, ARNs, session or request ids; secrets; raw provider
responses or any user data; URLs (they embed ids). The contract refuses free text with long digit runs or links, and the
guard runs the shared secret scan over every record.

## Process

1. A gate authorizes ONE controlled validation of one (provider, platform, capability, operation, scope), after the
   operation is implemented in the Wrenkind provider adapter (and, for mutations, behind the Platform Mutation Executor).
2. The record is written as `draft`, reviewed by the TL, and set to `accepted` (or `rejected`) in a commit.
3. Only then may a later gate register the implementation evidence and add the catalog entry — which still requires the
   authorization semantics to be resolved and a deliberate catalog revision decision (Meta README › Catalog version).
