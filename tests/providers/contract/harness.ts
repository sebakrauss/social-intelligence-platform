/**
 * What an adapter must provide to run the provider contract suite. Everything is expressed through the public
 * ports plus adapter-supplied cases, so the SAME suite runs against the simulator now and against real Meta /
 * TikTok adapters later (driven by recorded, sanitized fixtures; TA §53). Nothing here may assume simulator
 * internals.
 */
import type { ProviderAccess, ProviderCredential, ProviderErrorKind, ProviderName, ProviderObjectRef, ProviderReadPort, TimeWindow, WebhookRequest } from "@/integrations/providers/contract";
import type { ProviderMutationPort } from "@/integrations/providers/contract/mutation-port";

export interface ContractErrorCase {
  readonly name: string;
  readonly kind: ProviderErrorKind;
  /** Performs one port call that the adapter's fixtures make fail with `kind`. */
  invoke(): Promise<unknown>;
}

export interface WebhookCases {
  readonly valid: () => WebhookRequest;
  /** Same body, signature that doesn't match. */
  readonly tampered: () => WebhookRequest;
  readonly unsigned: () => WebhookRequest;
  /** Correctly signed, but outside the replay tolerance. */
  readonly stale: () => WebhookRequest;
  /** Correctly signed, but not a valid envelope. */
  readonly malformed: () => WebhookRequest;
  /** Correctly signed; contains an event type the adapter doesn't handle (plus at least one it does). */
  readonly withUnknownEvent: () => WebhookRequest;
  /** Two deliveries about the same object; the first returned was sent later (provider time). */
  readonly outOfOrder: () => readonly [WebhookRequest, WebhookRequest];
}

export interface ProviderContractHarness {
  readonly name: string;
  readonly provider: ProviderName;
  readonly read: ProviderReadPort;
  readonly mutation: ProviderMutationPort;
  /** Restores a known state before each test. */
  reset(): void | Promise<void>;
  readonly discoveryCredential: ProviderCredential;
  /** A content-bearing account with content and interactions inside `window`. */
  readonly contentAccess: ProviderAccess;
  /** An ad account with paid context inside `window`. */
  readonly adAccess: ProviderAccess;
  readonly window: TimeWindow;
  /** Content of `contentAccess` whose interactions span at least three pages. */
  readonly paginatedContent: ProviderObjectRef<"content">;
  /** Content of `contentAccess` with no interactions. */
  readonly emptyContent: ProviderObjectRef<"content">;
  /** Content distributed by at least two ads of `adAccess`. */
  readonly sharedContent: ProviderObjectRef<"content">;
  /** A visible audience comment of `contentAccess` that the fixtures allow to be mutated. */
  readonly mutationTarget: ProviderObjectRef<"interaction">;
  /** An audience author on `contentAccess`'s platform. */
  readonly blockableAuthor: ProviderObjectRef<"author">;
  /** An account whose webhook subscription can be managed. */
  readonly subscribable: ProviderAccess;
  readonly refreshable: ProviderCredential;
  readonly webhooks: WebhookCases;
  /** Must cover every normalized error kind. */
  readonly errorCases: readonly ContractErrorCase[];
  /** Secret values that must never appear in errors, results or serialized output. */
  readonly secrets: readonly string[];
}
