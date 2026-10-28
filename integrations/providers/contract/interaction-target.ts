/**
 * What `getInteraction` re-reads (Step 7G-H5.5-P12-C9; design P12-C8): never a bare id. An interaction id alone proves
 * nothing about the content it belongs to — LIVE Meta returned Facebook comment nodes without `object` (P12-C7) — so a
 * re-read needs a PROVENANCE the adapter itself established. The target is a closed union of such provenances:
 *
 *   listed   the exact DTO instance this same port returned from `listInteractions`. The port recorded, at that moment,
 *            the account it listed for, the content scope the provider returned it under, its identity, parent and kind.
 *            A copy, a reconstruction, a deserialized value, another port instance's DTO or a hand-built object is NOT a
 *            `listed` target: it is refused as invalid_request before any request is made.
 *   stored   (Step H6-E) a CANONICAL interaction Wrenkind listed earlier and persisted through its trusted ingestion: the
 *            same five facts (account, content, identity, parent, kind), read back from canonical persistence by the
 *            ingestion module's confirmation operation — never from a caller, a browser or a payload. The port checks
 *            them for coherence (one platform, the access's own account, reply ⇔ parent) and then re-reads the node
 *            against them exactly as against a listed provenance.
 *
 * Future provenances (e.g. a verified webhook event) are new kinds added here deliberately — never a bare-id fallback.
 *
 * The registry is the adapter's only state: weak and identity-keyed (an entry lives exactly as long as the caller holds
 * the DTO), per port instance, never persisted, never shared, and it holds no credential.
 */
import type { InteractionDto, InteractionKind, ProviderAccess } from "./dto";
import { PermanentRejectedError } from "./errors";
import { sameProviderObject, type ProviderObjectRef } from "./identity";
import type { Page } from "./pagination";

export type InteractionTarget =
  | { readonly kind: "listed"; readonly listed: InteractionDto }
  | { readonly kind: "stored"; readonly stored: StoredInteractionProvenance };

/** What the port recorded when it listed an interaction: the authority a later re-read is checked against. */
export interface ListedInteractionProvenance {
  /** The account the listing was made for (the access's managed account). */
  readonly account: ProviderObjectRef<"asset">;
  /** The content the provider returned it under (the scoped edge's content). */
  readonly content: ProviderObjectRef<"content">;
  readonly ref: ProviderObjectRef<"interaction">;
  readonly parent: ProviderObjectRef<"interaction"> | null;
  readonly interactionKind: InteractionKind;
}

/** A persisted canonical interaction's provenance (Step H6-E): the same facts a listing recorded, read from canonical rows. */
export type StoredInteractionProvenance = ListedInteractionProvenance;

export interface ListedInteractionRegistry {
  /** Records every item of a page this port is about to return, for `access`; returns the page unchanged. */
  record(access: ProviderAccess, page: Page<InteractionDto>): Page<InteractionDto>;
  /**
   * The recorded provenance of `target`, or a refusal (invalid_request, before any request): not a `listed` target, not
   * an instance this port recorded, or recorded for another account.
   */
  resolve(access: ProviderAccess, target: InteractionTarget): ListedInteractionProvenance;
}

export function createListedInteractionRegistry(): ListedInteractionRegistry {
  // Identity-keyed: equal data is not the same provenance, and an entry never outlives the caller's DTO.
  const issued = new WeakMap<InteractionDto, ListedInteractionProvenance>();
  return Object.freeze({
    record(access: ProviderAccess, page: Page<InteractionDto>): Page<InteractionDto> {
      for (const item of page.items) {
        issued.set(item, Object.freeze({ account: access.account, content: item.content, ref: item.ref, parent: item.parent, interactionKind: item.interactionKind }));
      }
      return page;
    },
    resolve(access: ProviderAccess, target: InteractionTarget): ListedInteractionProvenance {
      // Runtime checks: a caller's value is data, whatever its static type says.
      const value = target as { readonly kind?: unknown; readonly listed?: unknown } | null;
      const listed = value?.kind === "listed" ? value.listed : undefined;
      const provenance = typeof listed === "object" && listed !== null ? issued.get(listed as InteractionDto) : undefined;
      if (provenance === undefined || !sameProviderObject(provenance.account, access.account)) throw new PermanentRejectedError("getInteraction", "invalid_request");
      return provenance;
    },
  });
}

/**
 * The provenance a re-read is checked against: a `listed` target through this port's registry, a `stored` one after a
 * coherence check (Step H6-E). Anything else — including a stored provenance for another account, mixing platforms or
 * contradicting its own kind — is invalid_request, before any request.
 */
export function resolveInteractionTarget(registry: ListedInteractionRegistry, access: ProviderAccess, target: InteractionTarget): ListedInteractionProvenance {
  // Runtime checks: a caller's value is data, whatever its static type says.
  const value = target as { readonly kind?: unknown; readonly stored?: unknown } | null;
  if (value?.kind !== "stored") return registry.resolve(access, target);
  type LooseRef = { readonly platform?: unknown; readonly kind?: unknown; readonly id?: unknown } | null | undefined;
  const stored = (typeof value.stored === "object" ? value.stored : null) as { readonly account?: LooseRef; readonly content?: LooseRef; readonly ref?: LooseRef; readonly parent?: LooseRef; readonly interactionKind?: unknown } | null;
  const isRef = (ref: LooseRef, kind: string): boolean => typeof ref === "object" && ref !== null && ref.platform === access.account.platform && ref.kind === kind && typeof ref.id === "string";
  const parentCoherent = stored?.interactionKind === "comment" ? stored.parent === null : stored?.interactionKind === "reply" && isRef(stored.parent, "interaction");
  if (stored === null || !isRef(stored.account, "asset") || !isRef(stored.content, "content") || !isRef(stored.ref, "interaction") || !parentCoherent) {
    throw new PermanentRejectedError("getInteraction", "invalid_request");
  }
  const provenance = stored as unknown as ListedInteractionProvenance;
  if (!sameProviderObject(provenance.account, access.account)) throw new PermanentRejectedError("getInteraction", "invalid_request");
  return Object.freeze({ account: provenance.account, content: provenance.content, ref: provenance.ref, parent: provenance.parent, interactionKind: provenance.interactionKind });
}
