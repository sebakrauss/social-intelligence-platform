/**
 * Interaction persistence port (Step H6-B): canonical interactions, privacy-minimal authors, append-only text versions
 * and state observations. Implemented by ./persistence; composed by server/persistence/ingestion.ts.
 */
/** A canonical interaction row as persisted (observed, or a minimal placeholder whose observed fields are NULL). */
export interface InteractionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly platform: string;
  readonly providerInteractionId: string;
  readonly connectedAccountId: string;
  readonly providerAssetId: string;
  readonly contentItemId: string;
  readonly providerContentId: string;
  readonly observed: boolean;
  readonly parentInteractionId: string | null;
  readonly kind: string | null;
  readonly authorId: string | null;
  readonly authorRole: string | null;
  readonly conversationId: string | null;
  readonly currentSourceTextVersionId: string | null;
  readonly textObservedAt: Date | null;
  readonly currentVisibility: string | null;
  readonly currentAvailability: string | null;
  readonly currentRemovalBasis: string | null;
  readonly providerCreatedAt: Date | null;
  readonly providerEditedAt: Date | null;
  readonly stateObservedAt: Date | null;
  readonly firstObservedAt: Date | null;
  readonly latestObservedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewAuthor {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly platform: string;
  readonly providerAuthorId: string;
  readonly role: string;
  readonly label: string | null;
  readonly now: Date;
}

export interface NewInteractionRow {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly platform: string;
  readonly providerInteractionId: string;
  readonly connectedAccountId: string;
  readonly providerAssetId: string;
  readonly contentItemId: string;
  readonly providerContentId: string;
  readonly now: Date;
}

export interface ObservedFields {
  readonly parentInteractionId: string | null;
  readonly kind: string;
  readonly authorId: string | null;
  readonly authorRole: string;
  readonly visibility: string;
  readonly availability: string;
  readonly removalBasis: string | null;
  readonly providerCreatedAt: Date;
  readonly providerEditedAt: Date | null;
  readonly observedAt: Date;
}

export interface CurrentStateUpdate {
  /** Set together with the observed time that established the pointer (the CHECK pairs them). */
  readonly currentSourceTextVersionId?: string;
  readonly textObservedAt?: Date;
  readonly providerEditedAt?: Date | null;
  readonly visibility?: string;
  readonly availability?: string;
  readonly removalBasis?: string | null;
  readonly stateObservedAt?: Date;
  readonly latestObservedAt?: Date;
}

export interface TextVersionPointerRow {
  readonly id: string;
  readonly textHash: string;
  readonly providerEditedAt: Date | null;
  readonly observedAt: Date;
}

export interface NewTextVersion {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly interactionId: string;
  readonly textHash: string;
  readonly sourceText: string;
  readonly providerEditedAt: Date | null;
  readonly observedAt: Date;
}

export interface NewStateObservation {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly interactionId: string;
  readonly visibility: string;
  readonly availability: string;
  readonly removalBasis: string | null;
  readonly observedAt: Date;
  readonly mechanism: string;
  readonly operation: string;
  readonly provenance: string;
}

export interface SubtreeSnapshot {
  readonly members: readonly { readonly id: string; readonly conversationId: string | null; readonly depth: number }[];
  readonly depthExceeded: boolean;
}

export interface InteractionStore {
  /** The author row for (platform, provider author id), created if absent; the label follows the latest observation. */
  ensureAuthor(author: NewAuthor): Promise<string>;
  findByKey(platform: string, providerInteractionId: string): Promise<InteractionRecord | undefined>;
  findById(id: string): Promise<InteractionRecord | undefined>;
  insertPlaceholder(row: NewInteractionRow): Promise<void>;
  insertObserved(row: NewInteractionRow, fields: ObservedFields): Promise<void>;
  /** A placeholder becomes the observed interaction (once; the scope guard forbids the reverse). */
  completePlaceholder(id: string, fields: ObservedFields): Promise<void>;
  updateCurrent(id: string, update: CurrentStateUpdate, now: Date): Promise<void>;
  /**
   * The node and every canonical descendant (parent links, same workspace) down to ANCESTRY_MAX_DEPTH, locked FOR UPDATE,
   * with their conversations. `depthExceeded` when a member lies deeper (a deeper chain, or a cycle): nothing is assumed.
   */
  subtree(rootId: string): Promise<SubtreeSnapshot>;
  /**
   * Gives `conversationId` to the node and every descendant down to ANCESTRY_MAX_DEPTH that has NO conversation (null →
   * value only; a member already assigned is left untouched). Returns how many rows changed. The caller has checked
   * the snapshot first (decideSubtreeAttachment, depth).
   */
  attachSubtree(rootId: string, conversationId: string, now: Date): Promise<number>;
  textVersion(id: string): Promise<TextVersionPointerRow | undefined>;
  textVersionByHash(interactionId: string, textHash: string): Promise<TextVersionPointerRow | undefined>;
  appendTextVersion(version: NewTextVersion): Promise<void>;
  appendStateObservation(observation: NewStateObservation): Promise<void>;
}
