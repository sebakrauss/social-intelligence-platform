/**
 * Parents-first order for one collected batch (Step H6-B). Providers list newest first, so a reply precedes its parent
 * in a listing; ingesting a batch in that order would make a nested reply anchor its thread on a placeholder that is
 * itself a reply. Within the batch every fact therefore follows its parent (when the parent is in the batch), and the
 * listing order is otherwise kept — deterministic, no reordering by content or text. A parent outside the batch keeps
 * the reply-before-parent rule (placeholder). A cycle is left in listing order; the service refuses it.
 */
import type { InteractionSourceFact } from "@/modules/interactions";

export function orderParentsFirst(facts: readonly InteractionSourceFact[]): readonly InteractionSourceFact[] {
  // Every sighting is kept (a repeated id is ingested again, and the service classifies any contradiction).
  const byId = new Map<string, InteractionSourceFact[]>();
  for (const fact of facts) {
    const sightings = byId.get(fact.identity.interactionId);
    if (sightings === undefined) byId.set(fact.identity.interactionId, [fact]);
    else sightings.push(fact);
  }
  const visited = new Set<string>();
  const out: InteractionSourceFact[] = [];
  const visit = (id: string): void => {
    const sightings = byId.get(id);
    if (sightings === undefined || visited.has(id)) return;
    visited.add(id);
    for (const fact of sightings) if (fact.identity.parentId !== null) visit(fact.identity.parentId);
    out.push(...sightings);
  };
  for (const fact of facts) visit(fact.identity.interactionId);
  return out;
}
