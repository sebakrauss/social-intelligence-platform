/**
 * interactions module public API (TA §7.1, L1; H6-A1 pure domain contracts; H6-B persistence port).
 * `issueStoredInteractionAuthority` is deliberately NOT exported: only the module's persistence layer may issue a
 * stored authority (architecture guard).
 */
export {
  AUTHOR_LABEL_MAX_LENGTH,
  AUTHOR_ROLES,
  INTERACTION_AVAILABILITY,
  INTERACTION_KINDS,
  INTERACTION_VISIBILITY,
  REMOVAL_BASES,
  SOURCE_FACT_MECHANISMS,
  SOURCE_FACT_OPERATIONS,
  SOURCE_FACT_PROVENANCE,
  SOURCE_TEXT_MAX_LENGTH,
  isAdmissibleAuthority,
  type AuthorRole,
  type InteractionAvailability,
  type InteractionKind,
  type InteractionVisibility,
  type RemovalBasis,
  type SourceFactMechanism,
  type SourceFactOperation,
  type SourceFactProvenance,
} from "./domain/vocabulary";
export { asUntrustedSocialText, type UntrustedSocialText } from "./domain/untrusted-text";
export {
  parseInteractionSourceFact,
  parseTextHash,
  type AuthorFact,
  type InteractionEvaluationContext,
  type InteractionProvenanceFact,
  type InteractionSourceFact,
  type InteractionSourceIdentity,
  type InteractionSourceScope,
  type InteractionStateFact,
  type InteractionTextFact,
  type InteractionTimeFact,
  type SourceFactParse,
  type SourceFactViolation,
  type TextHash,
} from "./domain/source-fact";
export {
  AUTHORITY_CONFLICTS,
  canonicalInteractionKey,
  canonicalKeyString,
  classifyAuthorityConflicts,
  decideCanonicalAdmission,
  sameCanonicalKey,
  type AuthorityConflict,
  type CanonicalAdmission,
  type CanonicalInteractionKey,
  type KnownInteractionScope,
} from "./domain/identity";
export { decideTextVersion, isStaleAgainst, type IncomingText, type TextVersionDecision, type TextVersionPointer } from "./domain/text-version";
export { classifyListingAbsence, decideStateObservation, removalBasisFrom, type InteractionStateObservation, type RemovalEvidence, type StateChange, type StateDecision } from "./domain/state";
export { admitInteractionKind, decideRelation, type KindAdmission, type ParentPlaceholder, type RelationDecision } from "./domain/relation";
export {
  STORED_REREAD_MISMATCHES,
  isStoredInteractionAuthority,
  verifyStoredReread,
  type CanonicalInteractionRecord,
  type StoredInteractionAuthority,
  type StoredRereadContext,
  type StoredRereadMismatch,
  type StoredRereadObservation,
} from "./domain/stored-authority";
export type {
  CurrentStateUpdate,
  InteractionRecord,
  InteractionStore,
  NewAuthor,
  NewInteractionRow,
  NewStateObservation,
  NewTextVersion,
  ObservedFields,
  TextVersionPointerRow,
} from "./application/ports";
