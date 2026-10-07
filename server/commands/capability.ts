/**
 * Step 5E capability query (TA §16.5–§16.6). Returns the capability side of availability for one Connected Account,
 * capability and target scope: the stored base profile row overlaid with the current connection health. It does not
 * decide role or workspace mode (the pipeline's permission check and the future full availability resolver do that,
 * once): this is input for the resolver and for view models, never a UI-side evaluation.
 */
import type { ConnectionStatus } from "@/domain/connections";
import { AppError } from "@/domain/errors";
import { isUuid } from "@/domain/ids";
import { object, oneOf, optional, parsed } from "@/domain/validation";
import { ANY, CAPABILITY_CONTENT_KINDS, CAPABILITY_KEYS, CAPABILITY_SOURCES, capabilityAvailability, type CapabilityAvailability, type CapabilityKey } from "@/modules/capability";
import type { WorkspaceCommand } from "@/server/pipeline";

const uuid = parsed((value) => (isUuid(value) ? value : undefined));

export function createCapabilityQueries() {
  const availability: WorkspaceCommand<
    {
      readonly connectedAccountId: string;
      readonly capability: CapabilityKey;
      readonly contentKind: (typeof CAPABILITY_CONTENT_KINDS)[number] | undefined;
      readonly source: (typeof CAPABILITY_SOURCES)[number] | undefined;
    },
    CapabilityAvailability,
    CapabilityAvailability
  > = {
    scope: "workspace",
    name: "capability.availability.get",
    permission: "workspace.read_operational",
    requiresStandardMode: false,
    validate: object({
      connectedAccountId: uuid,
      capability: oneOf(CAPABILITY_KEYS),
      contentKind: optional(oneOf(CAPABILITY_CONTENT_KINDS)),
      source: optional(oneOf(CAPABILITY_SOURCES)),
    }),
    async execute(_context, input, tx) {
      const account = await tx.connections.connectedAccounts.get(input.connectedAccountId);
      if (account === undefined) throw new AppError("NOT_FOUND", {});
      const connection = await tx.connections.connections.get(account.connectionId);
      // A deactivated account or a missing connection is treated like a removed one: never available.
      const health: ConnectionStatus = connection === undefined || account.status !== "ACTIVE" ? "REMOVED" : connection.status;
      return capabilityAvailability(tx.capability, {
        connectedAccountId: account.id,
        capability: input.capability,
        contentKind: input.contentKind ?? ANY,
        source: input.source ?? ANY,
        connection: health,
      });
    },
    audit: () => undefined,
    respond: (result) => result,
  };
  return { availability };
}
