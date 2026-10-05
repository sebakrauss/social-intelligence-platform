/**
 * Provider READ port (TA §15.1): connection discovery, ingestion, reconciliation and capability probing.
 * Adapters implement operations; they never decide whether an operation is offered (TA §15.3, §16).
 *
 * There is NO operation to list or read private messages, and there never will be one in the MVP (S9;
 * ADR-14). A static test fails the build if a DM-like operation or type appears in this contract.
 *
 * Every call carries its credential (and account) explicitly: adapters hold no per-tenant state, and a
 * provider call is always made with the credential of the workspace whose job is running (TA §9.2).
 */
import type { ProviderCredential } from "./credential";
import type {
  AccountDescriptionDto,
  ContentDto,
  CredentialRefreshResult,
  InteractionDto,
  PaidContextItem,
  ProviderAccess,
  SocialAssetDto,
  StateObservationDto,
  StateTarget,
  SubscriptionResultDto,
} from "./dto";
import type { ProviderName, ProviderObjectRef } from "./identity";
import type { Page, PageCursor, ProviderResult, TimeWindow } from "./pagination";
import type { WebhookParseResult, WebhookRequest } from "./webhooks";

/** Interactions of one content item, or of the whole account (where the provider offers it). */
export type InteractionScope =
  | { readonly kind: "content"; readonly content: ProviderObjectRef<"content"> }
  | { readonly kind: "account" };

export interface ProviderReadPort {
  readonly provider: ProviderName;

  /** Social Assets the credential exposes (pages, profiles, business accounts, ad accounts). */
  discoverAssets(credential: ProviderCredential): Promise<ProviderResult<readonly SocialAssetDto[]>>;

  /** Facts about the account for capability evaluation (Step 5). */
  describeAccount(access: ProviderAccess): Promise<ProviderResult<AccountDescriptionDto>>;

  /** Content published in `window`, paginated. */
  listContent(access: ProviderAccess, window: TimeWindow, cursor: PageCursor | null): Promise<ProviderResult<Page<ContentDto>>>;

  /** Comments and replies created in `window`, paginated. */
  listInteractions(
    access: ProviderAccess,
    scope: InteractionScope,
    window: TimeWindow,
    cursor: PageCursor | null,
  ): Promise<ProviderResult<Page<InteractionDto>>>;

  /** Authoritative re-fetch (webhooks, reconciliation). Absence throws TargetNotFound; it is not deletion. */
  getInteraction(access: ProviderAccess, ref: ProviderObjectRef<"interaction">): Promise<ProviderResult<InteractionDto>>;

  getContent(access: ProviderAccess, ref: ProviderObjectRef<"content">): Promise<ProviderResult<ContentDto>>;

  /** Existence and visibility as observable now (authors: blocked state in the access account's context). */
  getCurrentState(access: ProviderAccess, target: StateTarget): Promise<ProviderResult<StateObservationDto>>;

  /** Campaigns, ad groups and ads of the ad account in `access`, with ad → content links. */
  retrievePaidContext(access: ProviderAccess, window: TimeWindow, cursor: PageCursor | null): Promise<ProviderResult<Page<PaidContextItem>>>;

  /** Verify and parse a webhook delivery into event hints. Fails closed with WebhookRejectedError. */
  parseWebhook(request: WebhookRequest): Promise<WebhookParseResult>;

  subscribe(access: ProviderAccess): Promise<ProviderResult<SubscriptionResultDto>>;

  unsubscribe(access: ProviderAccess): Promise<ProviderResult<SubscriptionResultDto>>;

  refreshCredential(credential: ProviderCredential): Promise<ProviderResult<CredentialRefreshResult>>;
}
