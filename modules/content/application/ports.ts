/**
 * Content persistence port (Step H6-B): what canonical ingestion needs from content items. Implemented by
 * ./persistence; composed by server/persistence/ingestion.ts.
 */
export interface ContentItemRecord {
  readonly id: string;
  readonly platform: string;
  readonly connectedAccountId: string;
  readonly providerAssetId: string;
  readonly providerContentId: string;
  readonly contentKind: string;
  readonly reportedSource: string;
  readonly latestObservedAt: Date;
}

export interface NewContentItem {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly platform: string;
  readonly connectedAccountId: string;
  readonly providerAssetId: string;
  readonly providerContentId: string;
  readonly contentKind: string;
  readonly reportedSource: string;
  readonly observedAt: Date;
}

export interface ContentItemStore {
  findByProviderId(platform: string, providerContentId: string): Promise<ContentItemRecord | undefined>;
  /** By canonical id (Step H6-C3: a reconciliation slice names its content row). */
  findById(id: string): Promise<ContentItemRecord | undefined>;
  insert(item: NewContentItem): Promise<void>;
  /** Bookkeeping only: the latest time the content was seen (never moves backwards). */
  noteObserved(id: string, observedAt: Date): Promise<void>;
}
