/**
 * STAGING STUB provider adapter — SYNTHETIC, NON-PRODUCTION (Step 5K, K2). It exists so a deployed Preview/Staging
 * worker can run the REAL capability refresh path (`capability.evaluate_account`) with no provider at all:
 *
 *   - it makes ZERO network or provider calls: it imports nothing but the provider contract (no Node built-in, no
 *     package — enforced by the `staging-stub-no-io` boundary rule) and only builds values in memory;
 *   - it needs no Meta/Instagram/TikTok credential and never looks at the credential it is lent;
 *   - `describeAccount` answers with a fixed, deterministic description that grants NOTHING (no permissions, no
 *     identity, no linked ad accounts) and is marked synthetic (raw reference api version `staging-stub`). It does
 *     not read provider data and does not validate real permissions: with the real platform catalog (no entries)
 *     every capability stays UNKNOWN_NOT_VALIDATED;
 *   - every other read operation is refused as a permanent rejection, so nothing downstream can mistake it for data.
 *
 * Composed only by the job runtime, only in CAPABILITY_PROVIDER_MODE=staging_stub with APP_DEPLOYMENT_ENV
 * preview|staging (server/connections/provider-mode.ts). Never evidence about any real platform.
 */
import {
  BUDGET_NOT_REPORTED,
  PermanentRejectedError,
  WebhookRejectedError,
  isoInstant,
  rawReference,
  type AccountDescriptionDto,
  type ProviderName,
  type ProviderReadPort,
  type ReadOperation,
} from "../contract";

/** The api-version label every synthetic raw reference carries. */
export const STAGING_STUB_API_VERSION = "staging-stub";

/** A read port that is unmistakably the synthetic staging stub (checked by composition and tests). */
export interface StagingStubReadPort extends ProviderReadPort {
  readonly synthetic: true;
}

export function createStagingStubReadPort(provider: ProviderName, clock: () => Date): StagingStubReadPort {
  const refuse = (operation: Exclude<ReadOperation, "describeAccount" | "parseWebhook">) => Promise.reject(new PermanentRejectedError(operation, "invalid_request"));
  return Object.freeze({
    provider,
    synthetic: true as const,
    describeAccount(access) {
      const data: AccountDescriptionDto = {
        asset: access.account,
        assetClass: "content_bearing",
        displayName: "Staging stub (synthetic)",
        accountIdentity: null,
        grantedPermissions: [],
        linkedAdAccounts: [],
        describedAt: isoInstant(clock()),
        rawReference: rawReference(provider, STAGING_STUB_API_VERSION, "synthetic"),
      };
      return Promise.resolve({ data, budget: BUDGET_NOT_REPORTED });
    },
    discoverAssets: () => refuse("discoverAssets"),
    listContent: () => refuse("listContent"),
    listInteractions: () => refuse("listInteractions"),
    getInteraction: () => refuse("getInteraction"),
    getContent: () => refuse("getContent"),
    getCurrentState: () => refuse("getCurrentState"),
    retrievePaidContext: () => refuse("retrievePaidContext"),
    parseWebhook: () => Promise.reject(new WebhookRejectedError("invalid_signature")),
    subscribe: () => refuse("subscribe"),
    unsubscribe: () => refuse("unsubscribe"),
    refreshCredential: () => refuse("refreshCredential"),
  } satisfies StagingStubReadPort);
}
