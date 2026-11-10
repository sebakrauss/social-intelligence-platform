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

/**
 * One immutable source text version WITH its interaction (Step H7-B: the analysis target of classification). Read by
 * (interaction, version) — never through the interaction's mutable current-text pointer.
 */
export interface AnalysisTextRecord {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly interactionId: string;
  readonly sourceTextVersionId: string;
  readonly observed: boolean;
  readonly kind: string | null;
  readonly authorRole: string | null;
  readonly sourceText: string;
}

/** A context item of an analysis target (its parent, or its thread root): its CURRENT text, if observed, and author role. */
export interface ContextItemRecord {
  readonly sourceText: string | null;
  readonly authorRole: string | null;
}

/**
 * The analysis target WITH the canonical context the understanding input contract admits (Step H7-D1d; H7-A0 §13):
 * the interaction's platform, content and current-text pointer (to tell a superseded version), its parent and — when it
 * differs from the parent — its thread root, each with its current text and author role. Never an author name, handle,
 * profile or provider id.
 */
export interface UnderstandingContextRecord extends AnalysisTextRecord {
  readonly platform: string;
  readonly contentItemId: string | null;
  readonly currentSourceTextVersionId: string | null;
  readonly parent: ContextItemRecord | null;
  readonly root: ContextItemRecord | null;
}

/** Read-only access to analysis targets for downstream modules (classification). No write path. */
export interface InteractionTextReader {
  analysisText(interactionId: string, sourceTextVersionId: string): Promise<AnalysisTextRecord | undefined>;
  understandingContext(interactionId: string, sourceTextVersionId: string): Promise<UnderstandingContextRecord | undefined>;
}

export interface InteractionStore {
  /** The author row for (platform, provider author id), created if absent; the label follows the latest observation. */
  ensureAuthor(author: NewAuthor): Promise<string>;
  findByKey(platform: string, providerInteractionId: string): Promise<InteractionRecord | undefined>;
  findById(id: string): Promise<InteractionRecord | undefined>;
  /** Whether a canonical row with this id exists in the bound workspace (identifier only; Step H6-C3 consumer). */
  exists(id: string): Promise<boolean>;
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

/**
 * Step 7A (Inbox read side): one conversation's recent activity as the interactions table alone establishes it (the
 * conversation column is this module's). Identifiers, counts and timings only.
 */
export interface ConversationActivityRow {
  readonly conversationId: string;
  /**
   * The latest provider time (or first observation, for a placeholder) among the conversation's members, at millisecond
   * precision — the precision a keyset position carries, so that ordering and positions agree exactly.
   */
  readonly latestActivityAt: Date;
  /** Members observed with their content (never a count of comments at the platform: coverage decides that). */
  readonly observedCount: number;
  readonly placeholderCount: number;
  readonly anyHidden: boolean;
  readonly anyRemovedAtSource: boolean;
}

/** Keyset position in the activity listing (newest first): strictly before (latestActivityAt, conversationId). */
export interface ConversationActivityCursor {
  readonly latestActivityAt: Date;
  readonly conversationId: string;
}

/** One interaction as the Inbox reads it: the canonical row with its author label and CURRENT text (if observed). */
export interface InteractionSummaryRow {
  readonly id: string;
  /** The provider's identity of the row (Step 7B-3: an outbound reply confirmed with this id is the same message). */
  readonly providerInteractionId: string;
  readonly conversationId: string | null;
  readonly contentItemId: string;
  readonly connectedAccountId: string;
  readonly platform: string;
  readonly observed: boolean;
  readonly kind: string | null;
  readonly parentInteractionId: string | null;
  readonly authorRole: string | null;
  /** The provider-visible author label (display name or username), as last observed; null when unknown. */
  readonly authorLabel: string | null;
  readonly currentSourceTextVersionId: string | null;
  readonly currentText: string | null;
  readonly currentVisibility: string | null;
  readonly currentAvailability: string | null;
  readonly providerCreatedAt: Date | null;
  readonly providerEditedAt: Date | null;
  readonly textObservedAt: Date | null;
  readonly firstObservedAt: Date | null;
  readonly latestObservedAt: Date | null;
}

/** One retained source text version (append-only history; Model §13, M-09 open). */
export interface TextVersionRow {
  readonly id: string;
  readonly interactionId: string;
  readonly sourceText: string;
  readonly providerEditedAt: Date | null;
  readonly observedAt: Date;
}

/**
 * Read-only Inbox access to this module's tables (Step 7A). Runs in the caller's USER-scoped transaction: RLS admits
 * the bound workspace's non-guest members only (0017 member_read); nothing here filters by role or workspace itself.
 * Every list is bounded by its caller. No write path.
 */
export interface InteractionReadStore {
  /** Conversations ordered by latest activity, newest first, keyset-paginated; at most `limit` rows. */
  listConversationActivity(input: { readonly limit: number; readonly before: ConversationActivityCursor | null }): Promise<readonly ConversationActivityRow[]>;
  /** The summaries of the given canonical rows (unknown or foreign ids are simply absent). */
  summaries(interactionIds: readonly string[]): Promise<readonly InteractionSummaryRow[]>;
  /** Every member of one conversation, oldest first (provider time, then id); at most `limit` rows. */
  thread(conversationId: string, limit: number): Promise<readonly InteractionSummaryRow[]>;
  /**
   * The `newestPerInteraction` most recently observed retained text versions of EACH given interaction (the bound is
   * per interaction: one much-edited comment never starves another's history), returned oldest first. A caller that
   * asks for one more than it shows can tell that older versions exist without ever reading them all.
   */
  textVersions(interactionIds: readonly string[], newestPerInteraction: number): Promise<readonly TextVersionRow[]>;
}
