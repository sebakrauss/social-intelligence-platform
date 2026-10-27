/**
 * Canonical interaction ingestion (Step H6-B; TA §14.1 steps 4–9; H6-A1 contracts). One InteractionSourceFact in, at
 * most one canonical change set out, inside the CALLER's workspace-scoped job transaction:
 *
 *   1. admit the fact's kind against the coverage the capability allows (Instagram replies refused under
 *      REPLIES_NOT_READ — nothing is written);
 *   2. read everything that could contradict it — content, the interaction, its parent — and FAIL CLOSED on any
 *      authority conflict BEFORE the first write (IngestionAuthorityConflict; the caller's transaction rolls back);
 *   3. create the content and the privacy-minimal author if needed;
 *   4. create the interaction (or complete its placeholder), or apply the text-version and state rules to it;
 *   5. a reply before its parent creates a minimal placeholder parent (identity + content only);
 *   6. conversations (H6-C1, deferred): a top-level AUDIENCE comment anchors its Conversation, OPEN, and the thread
 *      it roots — descendants that arrived before it — is attached to it at once (null → conversation only); a reply
 *      joins its parent's conversation, or stays without one while its ancestry is unresolved or brand-rooted; a
 *      placeholder never anchors a conversation and none is ever re-anchored. Completing a placeholder checks its
 *      ancestry first: a parent inside its own subtree is ANCESTRY_CYCLE, a subtree deeper than ANCESTRY_MAX_DEPTH (or
 *      looping) is ANCESTRY_DEPTH_EXCEEDED, a member already in another conversation is
 *      DESCENDANT_CONVERSATION_CONFLICT — each refused before any write;
 *   7. one append-only ingestion event per canonical change (created · text_changed · state_changed ·
 *      removed_at_source) and its IDs-only `interactions.observed` outbox row.
 * No semantic change → no row, no event: `unchanged`. Attaching existing descendants to a late root's conversation is
 * structural, not a source change: it emits no event of its own (the root's `created` event names the conversation;
 * a later `conversation_attached` event is for the workflow/intelligence steps to introduce if they need one).
 *
 * Text is untrusted data: it is stored, hashed and pointed at — never read for meaning, routing or tools.
 */
import type { CorrelationId } from "@/domain/correlation";
import { isPlatformKey } from "@/domain/platforms";
import { parseProviderId, type ProviderId } from "@/domain/provider-identity";
import { decideSubtreeAttachment, planConversation } from "@/modules/conversations";
import { coveredInteractionKinds, type AvailabilityInput } from "@/modules/coverage";
import {
  admitInteractionKind,
  classifyAuthorityConflicts,
  decideRelation,
  decideStateObservation,
  decideTextVersion,
  INTERACTION_KINDS,
  parseTextHash,
  type AuthorityConflict,
  type InteractionRecord,
  type InteractionSourceFact,
  type KnownInteractionScope,
} from "@/modules/interactions";
import { parseInstant, type Instant } from "@/domain/instant";
import type { ObservedArrival, ObservedChange } from "../domain/events";
import type { IngestionClock, IngestionStores } from "./ports";

export interface IngestInteractionInput {
  readonly fact: InteractionSourceFact;
  /** The content the fact's interaction was listed under, as the provider described it. */
  readonly content: { readonly contentKind: string; readonly reportedSource: string };
  /** The availability the caller gated this read on, for the fact's exact capability scope. */
  readonly availability: AvailabilityInput;
  readonly arrival: ObservedArrival;
  readonly correlationId: CorrelationId;
}

export type IngestOutcome =
  | { readonly kind: "rejected"; readonly reason: "KIND_NOT_COVERED" }
  | { readonly kind: "unchanged"; readonly interactionId: string }
  | { readonly kind: "applied"; readonly interactionId: string; readonly conversationId: string | null; readonly changes: readonly ObservedChange[] };

export type IngestionConflict =
  | AuthorityConflict
  | "CONTENT_SCOPE_CONFLICT"
  | "PLACEHOLDER_SCOPE_CONFLICT"
  | "PARENT_SCOPE_CONFLICT"
  | "ANCESTRY_CYCLE"
  | "ANCESTRY_DEPTH_EXCEEDED"
  | "DESCENDANT_CONVERSATION_CONFLICT";

/** Thrown before any write; the caller's transaction must roll back (no canonical mutation, no event). */
export class IngestionAuthorityConflict extends Error {
  override readonly name = "IngestionAuthorityConflict";
  readonly conflicts: readonly IngestionConflict[];
  constructor(conflicts: readonly IngestionConflict[]) {
    super("ingestion_authority_conflict");
    this.conflicts = conflicts;
  }
}

const instantOf = (date: Date): Instant => {
  const parsed = parseInstant(date.toISOString());
  if (parsed === undefined) throw new Error("ingestion_instant_invalid");
  return parsed;
};

/** The persisted scope of an OBSERVED row, in the domain's terms (fails on a corrupt row). */
function knownScope(row: InteractionRecord, parentProviderId: string | null): KnownInteractionScope {
  const interactionId = parseProviderId(row.providerInteractionId);
  const assetId = parseProviderId(row.providerAssetId);
  const contentId = parseProviderId(row.providerContentId);
  const parentId = parentProviderId === null ? null : parseProviderId(parentProviderId);
  const kind = INTERACTION_KINDS.find((known) => known === row.kind);
  if (!isPlatformKey(row.platform) || interactionId === undefined || assetId === undefined || contentId === undefined || parentId === undefined || kind === undefined) {
    throw new Error("ingestion_canonical_row_incoherent");
  }
  return { workspaceId: row.workspaceId as KnownInteractionScope["workspaceId"], platform: row.platform, interactionId, connectedAccountId: row.connectedAccountId, providerAssetId: assetId, contentId, parentId, kind };
}

export async function ingestInteractionFact(stores: IngestionStores, clock: IngestionClock, input: IngestInteractionInput): Promise<IngestOutcome> {
  const { fact } = input;
  if (!admitInteractionKind(fact.identity.kind, coveredInteractionKinds(input.availability)).admitted) return { kind: "rejected", reason: "KIND_NOT_COVERED" };

  const platform = fact.scope.platform;
  const observedAt = new Date(fact.time.observedAt);

  // ── 2. read and validate everything first (no write before every conflict check passed) ─────────────────
  const content = await stores.content.findByProviderId(platform, fact.identity.contentId);
  if (content !== undefined && (content.connectedAccountId !== fact.scope.connectedAccountId || content.providerAssetId !== fact.scope.providerAssetId)) {
    throw new IngestionAuthorityConflict(["CONTENT_SCOPE_CONFLICT"]);
  }
  const existing = await stores.interactions.findByKey(platform, fact.identity.interactionId);
  if (existing !== undefined) {
    if (existing.observed) {
      const parentProviderId = existing.parentInteractionId === null ? null : (await stores.interactions.findById(existing.parentInteractionId))?.providerInteractionId ?? null;
      const conflicts = classifyAuthorityConflicts(knownScope(existing, parentProviderId), fact);
      if (conflicts.length > 0) throw new IngestionAuthorityConflict(conflicts);
    } else if (existing.connectedAccountId !== fact.scope.connectedAccountId || existing.providerAssetId !== fact.scope.providerAssetId || existing.providerContentId !== fact.identity.contentId) {
      throw new IngestionAuthorityConflict(["PLACEHOLDER_SCOPE_CONFLICT"]);
    }
  }
  const creating = existing === undefined || !existing.observed;
  let parent: InteractionRecord | undefined;
  if (creating && fact.identity.parentId !== null) {
    parent = await stores.interactions.findByKey(platform, fact.identity.parentId);
    if (parent !== undefined) {
      if (parent.observed) {
        const grandparent = parent.parentInteractionId === null ? null : (await stores.interactions.findById(parent.parentInteractionId))?.providerInteractionId ?? null;
        const relation = decideRelation(fact, knownScope(parent, grandparent));
        if (relation.kind === "reply_scope_conflict") throw new IngestionAuthorityConflict(["PARENT_SCOPE_CONFLICT"]);
      } else if (parent.connectedAccountId !== fact.scope.connectedAccountId || parent.providerContentId !== fact.identity.contentId) {
        throw new IngestionAuthorityConflict(["PARENT_SCOPE_CONFLICT"]);
      }
    }
  }
  // Completing a placeholder resolves the ancestry of everything that arrived beneath it: check it all now.
  if (existing !== undefined && !existing.observed) {
    const subtree = await stores.interactions.subtree(existing.id);
    if (subtree.depthExceeded) throw new IngestionAuthorityConflict(["ANCESTRY_DEPTH_EXCEEDED"]);
    if (parent !== undefined && subtree.members.some((member) => member.id === parent?.id)) throw new IngestionAuthorityConflict(["ANCESTRY_CYCLE"]);
    // The subtree's resolved conversation: the parent's for a reply, none yet for a root (a new one, or none for a brand
    // root). Any member already elsewhere contradicts that resolution.
    const target = fact.identity.parentId === null ? null : (parent?.conversationId ?? null);
    if (decideSubtreeAttachment({ target, memberConversations: subtree.members.map((member) => member.conversationId) }) !== "attach") {
      throw new IngestionAuthorityConflict(["DESCENDANT_CONVERSATION_CONFLICT"]);
    }
  }

  // ── 3. content and author ──────────────────────────────────────────────────────────────────────────────
  const organizationId = await stores.organizationId();
  const workspaceId = fact.scope.workspaceId;
  let contentItemId: string;
  if (content === undefined) {
    contentItemId = clock.newId();
    await stores.content.insert({ id: contentItemId, organizationId, workspaceId, platform, connectedAccountId: fact.scope.connectedAccountId, providerAssetId: fact.scope.providerAssetId,
      providerContentId: fact.identity.contentId, contentKind: input.content.contentKind, reportedSource: input.content.reportedSource, observedAt });
  } else {
    contentItemId = content.id;
    await stores.content.noteObserved(content.id, observedAt);
  }
  const authorId = fact.author.ref === null ? null : await stores.interactions.ensureAuthor({ id: clock.newId(), organizationId, workspaceId, platform, providerAuthorId: fact.author.ref, role: fact.author.role, label: fact.author.label, now: observedAt });
  const row = (providerInteractionId: ProviderId, id: string) => ({ id, organizationId, workspaceId, platform, providerInteractionId, connectedAccountId: fact.scope.connectedAccountId,
    providerAssetId: fact.scope.providerAssetId, contentItemId, providerContentId: fact.identity.contentId, now: observedAt });
  const changes: ObservedChange[] = [];
  const now = clock.now();

  // ── 4–6. create / complete, or update ──────────────────────────────────────────────────────────────────
  let interactionId: string;
  let conversationId: string | null;
  let textVersionId: string | null = null;
  if (creating) {
    if (fact.identity.parentId !== null && parent === undefined) {
      const placeholderId = clock.newId();
      await stores.interactions.insertPlaceholder(row(fact.identity.parentId, placeholderId));
      parent = await stores.interactions.findById(placeholderId);
    }
    const fields = {
      parentInteractionId: parent?.id ?? null,
      kind: fact.identity.kind,
      authorId,
      authorRole: fact.author.role,
      visibility: fact.state.visibility,
      availability: fact.state.availability,
      removalBasis: fact.state.removalBasis,
      providerCreatedAt: new Date(fact.time.providerCreatedAt),
      providerEditedAt: fact.time.providerEditedAt === null ? null : new Date(fact.time.providerEditedAt),
      observedAt,
    };
    if (existing === undefined) {
      interactionId = clock.newId();
      await stores.interactions.insertObserved(row(fact.identity.interactionId, interactionId), fields);
    } else {
      interactionId = existing.id;
      await stores.interactions.completePlaceholder(existing.id, fields);
    }
    const plan = planConversation({
      interactionId: fact.identity.interactionId,
      parentId: fact.identity.parentId,
      authorRole: fact.author.role,
      parentConversation: parent?.conversationId === null || parent?.conversationId === undefined ? null : { conversationId: parent.conversationId },
    });
    conversationId = null;
    if (plan.kind === "create") {
      conversationId = (await stores.conversations.ensureForAnchor({ id: clock.newId(), organizationId, workspaceId, anchorInteractionId: interactionId, initialization: plan.initialization, now })).id;
    } else if (plan.kind === "join") {
      conversationId = plan.conversationId;
    }
    // The node and its already-known descendants (a completed placeholder's subtree) take the conversation together.
    if (conversationId !== null) await stores.interactions.attachSubtree(interactionId, conversationId, now);
    if (fact.text.sourceText !== null && fact.text.textHash !== null) {
      textVersionId = clock.newId();
      await stores.interactions.appendTextVersion({ id: textVersionId, organizationId, workspaceId, interactionId, textHash: fact.text.textHash, sourceText: fact.text.sourceText,
        providerEditedAt: fields.providerEditedAt, observedAt });
      await stores.interactions.updateCurrent(interactionId, { currentSourceTextVersionId: textVersionId, textObservedAt: observedAt }, now);
    }
    await stores.interactions.appendStateObservation({ id: clock.newId(), organizationId, workspaceId, interactionId, visibility: fact.state.visibility, availability: fact.state.availability,
      removalBasis: fact.state.removalBasis, observedAt, mechanism: fact.provenance.mechanism, operation: fact.provenance.operation, provenance: fact.provenance.provenance });
    changes.push("created");
  } else {
    // `existing` is an observed canonical row here (creating is false).
    const current = existing;
    interactionId = current.id;
    conversationId = current.conversationId;
    // Text: append-only versions (one per distinct text), the pointer advances only to an accepted newer text. The
    // pointer is ordered by the time IT was established — not by its version's first observation (a text may return).
    const pointer = current.currentSourceTextVersionId === null ? undefined : await stores.interactions.textVersion(current.currentSourceTextVersionId);
    const currentHash = pointer === undefined ? undefined : parseTextHash(pointer.textHash);
    if (pointer !== undefined && (currentHash === undefined || current.textObservedAt === null)) throw new Error("ingestion_canonical_row_incoherent");
    const decision = decideTextVersion(
      pointer === undefined || currentHash === undefined || current.textObservedAt === null ? null
        : { textHash: currentHash, providerEditedAt: current.providerEditedAt === null ? null : instantOf(current.providerEditedAt), observedAt: instantOf(current.textObservedAt) },
      { textHash: fact.text.textHash, providerEditedAt: fact.time.providerEditedAt, observedAt: fact.time.observedAt },
    );
    if (decision === "append" && fact.text.sourceText !== null && fact.text.textHash !== null) {
      const known = await stores.interactions.textVersionByHash(interactionId, fact.text.textHash);
      textVersionId = known?.id ?? clock.newId();
      if (known === undefined) {
        await stores.interactions.appendTextVersion({ id: textVersionId, organizationId, workspaceId, interactionId, textHash: fact.text.textHash, sourceText: fact.text.sourceText,
          providerEditedAt: fact.time.providerEditedAt === null ? null : new Date(fact.time.providerEditedAt), observedAt });
      }
      await stores.interactions.updateCurrent(interactionId, { currentSourceTextVersionId: textVersionId, textObservedAt: observedAt, ...(fact.time.providerEditedAt === null ? {} : { providerEditedAt: new Date(fact.time.providerEditedAt) }) }, now);
      changes.push("text_changed");
    }
    // State: append-only observations, the current state moves only forward in observed time.
    const state = decideStateObservation(
      current.currentVisibility === null || current.currentAvailability === null || current.stateObservedAt === null ? null
        : { visibility: current.currentVisibility as InteractionSourceFact["state"]["visibility"], availability: current.currentAvailability as InteractionSourceFact["state"]["availability"], observedAt: instantOf(current.stateObservedAt) },
      { visibility: fact.state.visibility, availability: fact.state.availability, observedAt: fact.time.observedAt },
    );
    if (state.record) {
      await stores.interactions.appendStateObservation({ id: clock.newId(), organizationId, workspaceId, interactionId, visibility: fact.state.visibility, availability: fact.state.availability,
        removalBasis: fact.state.removalBasis, observedAt, mechanism: fact.provenance.mechanism, operation: fact.provenance.operation, provenance: fact.provenance.provenance });
    }
    if (state.advanceCurrent) {
      await stores.interactions.updateCurrent(interactionId, { visibility: fact.state.visibility, availability: fact.state.availability, removalBasis: fact.state.removalBasis, stateObservedAt: observedAt }, now);
      changes.push(state.change === "removed_at_source" ? "removed_at_source" : "state_changed");
    }
    if (current.latestObservedAt === null || current.latestObservedAt < observedAt) await stores.interactions.updateCurrent(interactionId, { latestObservedAt: observedAt }, now);
    if (changes.length === 0) return { kind: "unchanged", interactionId };
  }

  // ── 7. one event + IDs-only outbox row per canonical change ─────────────────────────────────────────────
  for (const change of changes) {
    await stores.events.emit(
      {
        eventId: clock.newId(),
        workspaceId,
        interactionId,
        conversationId,
        sourceTextVersionId: change === "created" || change === "text_changed" ? textVersionId : null,
        change,
        arrival: input.arrival,
        observedAt: fact.time.observedAt,
        correlationId: input.correlationId,
        initiator: "system",
      },
      organizationId,
      now,
      clock.newId(),
    );
  }
  return { kind: "applied", interactionId, conversationId, changes };
}
