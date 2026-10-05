/**
 * Simulator implementation of the provider MUTATION port. Like the contract's mutation port, this file may be
 * imported only by the executor (`mutations/`), its composition root (`jobs/`) and tests: a dependency rule
 * rejects every other importer, and the simulator's public index does not re-export it.
 *
 * Simulated platform semantics (explicit, not evidence about any real platform):
 *   - public reply: creates a brand-authored reply interaction and returns its identity;
 *   - private reply: records a one-shot receipt only; NO interaction, thread or inbound channel is created;
 *   - hide / unhide: change the simulated visibility; `changed: false` when already in that state;
 *   - delete: the interaction is removed at source (with a removal signal); a second delete is TargetNotFound;
 *   - block: the author is blocked in the access account's context;
 *   - provider idempotency hints are accepted and ignored (domain idempotency stays authoritative, R6);
 *   - an injected `outcome_unknown` applies the change and then loses the response (OutcomeUnknownError).
 * No product guard (mode, protection, roles) lives here: that is the executor's job (Step 9).
 */
import type { ProviderAccess } from "../contract/dto";
import { PermanentRejectedError, TargetNotEligibleError, TargetNotFoundError, type MutationOperation } from "../contract/errors";
import { providerObjectRef, type ProviderObjectRef } from "../contract/identity";
import type { ProviderResult } from "../contract/pagination";
import type {
  BlockReceipt,
  PrivateReplyReceipt,
  ProviderMutationPort,
  PublicReplyReceipt,
  StateChangeReceipt,
} from "../contract/mutation-port";
import { interactionRef, simRaw } from "./normalize";
import type { SimulatedRestriction } from "./scenario";
import { asPromise, type InteractionState, type SimulatorWorld } from "./world";

export function createSimulatorMutationPort(world: SimulatorWorld): ProviderMutationPort {
  const auth = (access: ProviderAccess) => ({ credential: access.credential, account: access.account.id });

  const target = (operation: MutationOperation, access: ProviderAccess, ref: ProviderObjectRef<"interaction">, restriction: SimulatedRestriction): InteractionState => {
    const state = world.interaction(ref.id);
    const owned = state !== undefined && world.content(state.content)?.account === access.account.id;
    if (state === undefined || !owned || state.presence !== "present") throw new TargetNotFoundError(operation);
    if (state.restrictions.includes(restriction)) throw new TargetNotEligibleError(operation, "unsupported_for_target");
    return state;
  };

  const requireText = (operation: MutationOperation, text: string): void => {
    if (text.trim().length === 0) throw new PermanentRejectedError(operation, "invalid_request");
  };

  const stateChange = (
    operation: "hide" | "unhide" | "delete",
    access: ProviderAccess,
    ref: ProviderObjectRef<"interaction">,
  ): Promise<ProviderResult<StateChangeReceipt>> =>
    asPromise(() =>
      world.execute(operation, auth(access), [ref.id], (): StateChangeReceipt => {
        const state = target(operation, access, ref, operation);
        const changed =
          operation === "delete"
            ? (world.removeAtSource(state.id, { signaled: true }), true)
            : world.setVisibility(state.id, operation === "hide" ? "hidden" : "visible");
        return { kind: operation, target: interactionRef(world, state), changed, confirmedAt: world.now(), rawReference: simRaw(world, "interaction", state.id, state.revision) };
      }),
    );

  return {
    provider: "simulator",

    replyPublicly(access, ref, text) {
      return asPromise(() =>
        world.execute("replyPublicly", auth(access), [ref.id], (): PublicReplyReceipt => {
          requireText("replyPublicly", text);
          const parent = target("replyPublicly", access, ref, "reply_public");
          const createdId = world.createBrandReply(parent.id, text);
          const created = world.interaction(createdId);
          if (created === undefined) throw new TypeError("simulated reply missing");
          return {
            kind: "public_reply",
            target: interactionRef(world, parent),
            createdInteraction: interactionRef(world, created),
            confirmedAt: world.now(),
            rawReference: simRaw(world, "interaction", created.id, created.revision),
          };
        }),
      );
    },

    replyPrivately(access, ref, text) {
      return asPromise(() =>
        world.execute("replyPrivately", auth(access), [ref.id], (): PrivateReplyReceipt => {
          requireText("replyPrivately", text);
          const parent = target("replyPrivately", access, ref, "reply_private");
          const record = world.recordPrivateReply(access.account.id, parent.id, text.length);
          return {
            kind: "private_reply",
            target: interactionRef(world, parent),
            providerReceiptId: record.receiptId,
            confirmedAt: record.at,
            rawReference: simRaw(world, "private_reply", record.receiptId),
          };
        }),
      );
    },

    hide(access, ref) {
      return stateChange("hide", access, ref);
    },

    unhide(access, ref) {
      return stateChange("unhide", access, ref);
    },

    delete(access, ref) {
      return stateChange("delete", access, ref);
    },

    block(access, author) {
      return asPromise(() =>
        world.execute("block", auth(access), [author.id], (): BlockReceipt => {
          const known = world.author(author.id);
          if (known?.platform !== access.account.platform) throw new TargetNotFoundError("block");
          if (known.role === "account_identity") throw new TargetNotEligibleError("block", "wrong_target_kind");
          const changed = world.setBlocked(access.account.id, known.id);
          return {
            kind: "block",
            author: providerObjectRef(known.platform, "author", known.id),
            account: access.account,
            changed,
            confirmedAt: world.now(),
            rawReference: simRaw(world, "block", `${access.account.id}.${known.id}`),
          };
        }),
      );
    },
  };
}
