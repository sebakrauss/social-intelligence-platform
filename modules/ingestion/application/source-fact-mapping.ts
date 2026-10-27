/**
 * The trusted adapter boundary (Step H6-B): a provider contract InteractionDto, read with an authority the caller states
 * (mechanism · operation · provenance), becomes an InteractionSourceFact — or fails closed. Only normalized contract
 * fields cross: no raw reference, cursor, token or payload. Text is kept exactly as the DTO carries it and hashed here
 * (SHA-256 over its UTF-8 bytes). A DTO marked removed_at_source carries an explicit provider signal by contract, so its
 * removal basis is `explicit_provider_signal`. A provider label longer than the contract bound is dropped (the label is
 * a display aid, never evidence); the interaction is still ingested.
 */
import { createHash } from "node:crypto";
import type { WorkspaceId } from "@/domain/ids";
import type { Instant } from "@/domain/instant";
import type { InteractionDto } from "@/integrations/providers/contract";
import { AUTHOR_LABEL_MAX_LENGTH, parseInteractionSourceFact, type InteractionSourceFact, type SourceFactMechanism, type SourceFactOperation, type SourceFactProvenance } from "@/modules/interactions";

export interface SourceFactContext {
  readonly workspaceId: WorkspaceId;
  readonly connectedAccountId: string;
  /** The managed account's provider id (the read's access account). */
  readonly providerAssetId: string;
  readonly mechanism: SourceFactMechanism;
  readonly operation: SourceFactOperation;
  readonly provenance: SourceFactProvenance;
  readonly observedAt: Instant;
  readonly catalogRevision: number;
  readonly profileRevision: number;
}

export class SourceFactRejectedError extends Error {
  override readonly name = "SourceFactRejectedError";
  readonly violations: readonly string[];
  constructor(violations: readonly string[]) {
    super("ingestion_source_fact_rejected");
    this.violations = violations;
  }
}

export const textHashOf = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export function interactionSourceFactFromDto(dto: InteractionDto, context: SourceFactContext): InteractionSourceFact {
  const label = dto.author.displayName ?? dto.author.handle;
  const removed = dto.availability === "removed_at_source";
  const text = removed ? null : dto.text;
  const parsed = parseInteractionSourceFact({
    scope: { workspaceId: context.workspaceId, connectedAccountId: context.connectedAccountId, platform: dto.ref.platform, providerAssetId: context.providerAssetId },
    identity: { interactionId: dto.ref.id, contentId: dto.content.id, parentId: dto.parent?.id ?? null, kind: dto.interactionKind },
    author: { ref: dto.author.ref.id, role: dto.author.role, label: label !== null && label.length > 0 && label.length <= AUTHOR_LABEL_MAX_LENGTH ? label : null },
    text: { sourceText: text, textHash: text === null ? null : textHashOf(text) },
    state: { visibility: dto.visibility, availability: dto.availability, removalBasis: removed ? "explicit_provider_signal" : null },
    time: { providerCreatedAt: dto.timestamps.createdAt, providerEditedAt: dto.editedAt, observedAt: context.observedAt },
    provenance: { mechanism: context.mechanism, operation: context.operation, provenance: context.provenance },
    evaluation: { catalogRevision: context.catalogRevision, profileRevision: context.profileRevision },
  });
  if (!parsed.ok) throw new SourceFactRejectedError(parsed.violations);
  // The DTO's own scope must match the read's: the interaction is on the platform of the account it was read for.
  if (dto.content.platform !== dto.ref.platform) throw new SourceFactRejectedError(["SCOPE_INVALID"]);
  return parsed.fact;
}
