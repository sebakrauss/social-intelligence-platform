/**
 * InteractionSourceFact (Step H6-A1; TA §12 category A, §14.1 step 6; Model §11): ONE authoritative provider fact about
 * one interaction, as ingestion is about to persist it. It is the ingestion boundary: everything a canonical row and
 * its append-only history need, nothing of the transport.
 *
 * Never in a fact (the parser refuses any key it doesn't know): tokens, credentials, cursors, raw provider responses,
 * webhook bodies, headers, URLs to fetch, provider SDK or Graph types. The adapter's DTO keeps a raw reference POINTER;
 * the fact doesn't need even that.
 *
 *   scope       workspace · connected account · platform · provider asset (the managed account's provider id)
 *   identity    provider interaction id · provider content id · parent id (null = top-level) · kind
 *   author      opaque provider author ref (or null) · role · provider-visible label (or null) — TL decision 2
 *   text        the exact untrusted text (or null) · its hash (null exactly when the text is)
 *   state       visibility · availability · removal basis (only for removed_at_source)
 *   time        provider created · provider edited (only when the provider states it) · observed (our clock)
 *   provenance  mechanism · provider operation · provenance kind (a closed, coherent table: vocabulary.ts)
 *   evaluation  the platform catalog revision and the capability profile revision the gate relied on (audit)
 *
 * Coherence (fail closed): kind = reply exactly when a parent exists; an interaction is never its own parent; text and
 * hash are null together; removed_at_source carries a removal basis and no text, available carries no basis; an edit
 * never precedes creation; the mechanism admits the operation and provenance.
 */
import { isUuid, parseWorkspaceId, type WorkspaceId } from "@/domain/ids";
import { compareInstants, parseInstant, type Instant } from "@/domain/instant";
import { isPlatformKey, type PlatformKey } from "@/domain/platforms";
import { parseProviderId, type ProviderId } from "@/domain/provider-identity";
import { asUntrustedSocialText, type UntrustedSocialText } from "./untrusted-text";
import {
  AUTHOR_LABEL_MAX_LENGTH,
  TEXT_HASH,
  isAdmissibleAuthority,
  isAuthorRole,
  isInteractionAvailability,
  isInteractionKind,
  isInteractionVisibility,
  isRemovalBasis,
  isSourceFactMechanism,
  isSourceFactOperation,
  isSourceFactProvenance,
  type AuthorRole,
  type InteractionAvailability,
  type InteractionKind,
  type InteractionVisibility,
  type RemovalBasis,
  type SourceFactMechanism,
  type SourceFactOperation,
  type SourceFactProvenance,
} from "./vocabulary";

declare const textHashBrand: unique symbol;
export type TextHash = string & { readonly [textHashBrand]: true };
export const parseTextHash = (value: unknown): TextHash | undefined => (typeof value === "string" && TEXT_HASH.test(value) ? (value as TextHash) : undefined);

export interface InteractionSourceScope {
  readonly workspaceId: WorkspaceId;
  /** The Connected Account (internal UUID) the fact was read for. */
  readonly connectedAccountId: string;
  readonly platform: PlatformKey;
  /** The managed account's provider id (the Social Asset). */
  readonly providerAssetId: ProviderId;
}

export interface InteractionSourceIdentity {
  readonly interactionId: ProviderId;
  readonly contentId: ProviderId;
  /** null for a top-level comment. */
  readonly parentId: ProviderId | null;
  readonly kind: InteractionKind;
}

/** TL decision 2: the minimum the product needs — no profile, contact data, enrichment or cross-scope identity. */
export interface AuthorFact {
  /** Opaque provider author reference, when the provider gives one. */
  readonly ref: ProviderId | null;
  readonly role: AuthorRole;
  /** Facebook display name / Instagram username where available; personal data (class P, TA §38.11). */
  readonly label: string | null;
}

export interface InteractionTextFact {
  readonly sourceText: UntrustedSocialText | null;
  readonly textHash: TextHash | null;
}

export interface InteractionStateFact {
  readonly visibility: InteractionVisibility;
  readonly availability: InteractionAvailability;
  readonly removalBasis: RemovalBasis | null;
}

export interface InteractionTimeFact {
  readonly providerCreatedAt: Instant;
  /** Only when the provider states an edit time; never inferred. */
  readonly providerEditedAt: Instant | null;
  /** When Wrenkind obtained this fact (local clock). */
  readonly observedAt: Instant;
}

export interface InteractionProvenanceFact {
  readonly mechanism: SourceFactMechanism;
  readonly operation: SourceFactOperation;
  readonly provenance: SourceFactProvenance;
}

export interface InteractionEvaluationContext {
  readonly catalogRevision: number;
  readonly profileRevision: number;
}

export interface InteractionSourceFact {
  readonly scope: InteractionSourceScope;
  readonly identity: InteractionSourceIdentity;
  readonly author: AuthorFact;
  readonly text: InteractionTextFact;
  readonly state: InteractionStateFact;
  readonly time: InteractionTimeFact;
  readonly provenance: InteractionProvenanceFact;
  readonly evaluation: InteractionEvaluationContext;
}

export type SourceFactViolation =
  | "NOT_AN_OBJECT"
  | "UNKNOWN_FIELD"
  | "SCOPE_INVALID"
  | "IDENTITY_INVALID"
  | "KIND_PARENT_INCOHERENT"
  | "SELF_PARENT"
  | "AUTHOR_INVALID"
  | "TEXT_INVALID"
  | "TEXT_HASH_INCOHERENT"
  | "STATE_INVALID"
  | "REMOVAL_INCOHERENT"
  | "TIME_INVALID"
  | "EDIT_BEFORE_CREATION"
  | "PROVENANCE_INVALID"
  | "EVALUATION_INVALID";

export type SourceFactParse =
  | { readonly ok: true; readonly fact: InteractionSourceFact }
  | { readonly ok: false; readonly violations: readonly SourceFactViolation[] };

const FIELDS: Readonly<Record<keyof InteractionSourceFact, readonly string[]>> = Object.freeze({
  scope: ["workspaceId", "connectedAccountId", "platform", "providerAssetId"],
  identity: ["interactionId", "contentId", "parentId", "kind"],
  author: ["ref", "role", "label"],
  text: ["sourceText", "textHash"],
  state: ["visibility", "availability", "removalBasis"],
  time: ["providerCreatedAt", "providerEditedAt", "observedAt"],
  provenance: ["mechanism", "operation", "provenance"],
  evaluation: ["catalogRevision", "profileRevision"],
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** Exactly these own keys: a missing one or an extra one (a raw payload, a cursor, a token…) is refused. */
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
};
const nullable = <T>(value: unknown, parse: (v: unknown) => T | undefined): T | null | undefined => (value === null ? null : parse(value));
const revision = (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= 1;

/** Validates an untyped value into a fact, fail closed; every violation is reported, nothing is repaired. */
export function parseInteractionSourceFact(value: unknown): SourceFactParse {
  if (!isRecord(value)) return { ok: false, violations: ["NOT_AN_OBJECT"] };
  const out = new Set<SourceFactViolation>();
  if (!exactKeys(value, Object.keys(FIELDS))) out.add("UNKNOWN_FIELD");
  const part = (name: keyof InteractionSourceFact): Record<string, unknown> | undefined => {
    const section = value[name];
    if (!isRecord(section)) return undefined;
    if (!exactKeys(section, FIELDS[name])) out.add("UNKNOWN_FIELD");
    return section;
  };

  const scope = part("scope");
  const workspaceId = parseWorkspaceId(scope?.["workspaceId"]);
  const connectedAccountId = scope?.["connectedAccountId"];
  const platform = scope?.["platform"];
  const providerAssetId = parseProviderId(scope?.["providerAssetId"]);
  if (workspaceId === undefined || !isUuid(connectedAccountId) || !isPlatformKey(platform) || providerAssetId === undefined) out.add("SCOPE_INVALID");

  const identity = part("identity");
  const interactionId = parseProviderId(identity?.["interactionId"]);
  const contentId = parseProviderId(identity?.["contentId"]);
  const parentId = nullable(identity?.["parentId"], parseProviderId);
  const kind = identity?.["kind"];
  if (interactionId === undefined || contentId === undefined || parentId === undefined || !isInteractionKind(kind)) out.add("IDENTITY_INVALID");
  else {
    if ((kind === "reply") !== (parentId !== null)) out.add("KIND_PARENT_INCOHERENT");
    if (parentId === interactionId) out.add("SELF_PARENT");
  }

  const author = part("author");
  const authorRef = nullable(author?.["ref"], parseProviderId);
  const authorRole = author?.["role"];
  const label = nullable(author?.["label"], (v) => (typeof v === "string" && v.length > 0 && v.length <= AUTHOR_LABEL_MAX_LENGTH ? v : undefined));
  if (authorRef === undefined || !isAuthorRole(authorRole) || label === undefined) out.add("AUTHOR_INVALID");

  const text = part("text");
  const sourceText = nullable(text?.["sourceText"], asUntrustedSocialText);
  const textHash = nullable(text?.["textHash"], parseTextHash);
  if (sourceText === undefined || textHash === undefined) out.add("TEXT_INVALID");
  else if ((sourceText === null) !== (textHash === null)) out.add("TEXT_HASH_INCOHERENT");

  const state = part("state");
  const visibility = state?.["visibility"];
  const availability = state?.["availability"];
  const removalBasis = nullable(state?.["removalBasis"], (v) => (isRemovalBasis(v) ? v : undefined));
  if (!isInteractionVisibility(visibility) || !isInteractionAvailability(availability) || removalBasis === undefined) out.add("STATE_INVALID");
  else if (availability === "removed_at_source" ? removalBasis === null || sourceText !== null : removalBasis !== null) out.add("REMOVAL_INCOHERENT");

  const time = part("time");
  const providerCreatedAt = parseInstant(time?.["providerCreatedAt"]);
  const providerEditedAt = nullable(time?.["providerEditedAt"], parseInstant);
  const observedAt = parseInstant(time?.["observedAt"]);
  if (providerCreatedAt === undefined || providerEditedAt === undefined || observedAt === undefined) out.add("TIME_INVALID");
  else if (providerEditedAt !== null && compareInstants(providerEditedAt, providerCreatedAt) < 0) out.add("EDIT_BEFORE_CREATION");

  const provenance = part("provenance");
  const mechanism = provenance?.["mechanism"];
  const operation = provenance?.["operation"];
  const provenanceKind = provenance?.["provenance"];
  if (!isSourceFactMechanism(mechanism) || !isSourceFactOperation(operation) || !isSourceFactProvenance(provenanceKind) || !isAdmissibleAuthority(mechanism, operation, provenanceKind)) out.add("PROVENANCE_INVALID");

  const evaluation = part("evaluation");
  if (!revision(evaluation?.["catalogRevision"]) || !revision(evaluation?.["profileRevision"])) out.add("EVALUATION_INVALID");

  for (const name of Object.keys(FIELDS) as (keyof InteractionSourceFact)[]) if (!isRecord(value[name])) out.add("UNKNOWN_FIELD");
  if (out.size > 0) return { ok: false, violations: [...out].sort() };
  // Every field was validated above; the casts only restate what the checks proved.
  return {
    ok: true,
    fact: Object.freeze({
      scope: Object.freeze({ workspaceId: workspaceId as WorkspaceId, connectedAccountId: connectedAccountId as string, platform: platform as PlatformKey, providerAssetId: providerAssetId as ProviderId }),
      identity: Object.freeze({ interactionId: interactionId as ProviderId, contentId: contentId as ProviderId, parentId: parentId as ProviderId | null, kind: kind as InteractionKind }),
      author: Object.freeze({ ref: authorRef as ProviderId | null, role: authorRole as AuthorRole, label: label as string | null }),
      text: Object.freeze({ sourceText: sourceText as UntrustedSocialText | null, textHash: textHash as TextHash | null }),
      state: Object.freeze({ visibility: visibility as InteractionVisibility, availability: availability as InteractionAvailability, removalBasis: removalBasis as RemovalBasis | null }),
      time: Object.freeze({ providerCreatedAt: providerCreatedAt as Instant, providerEditedAt: providerEditedAt as Instant | null, observedAt: observedAt as Instant }),
      provenance: Object.freeze({ mechanism: mechanism as SourceFactMechanism, operation: operation as SourceFactOperation, provenance: provenanceKind as SourceFactProvenance }),
      evaluation: Object.freeze({ catalogRevision: evaluation?.["catalogRevision"] as number, profileRevision: evaluation?.["profileRevision"] as number }),
    }),
  };
}
