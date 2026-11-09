/**
 * The read-only reply lookup reconciliation uses (../ports ReplyLookup) over a provider READ port. It lists the
 * interactions of the parent's content and looks for OUR reply with every discriminator the contract exposes:
 * authored by the account identity, replying to exactly the parent, the exact text we sent, and created at or after
 * the attempt (a small clock skew is tolerated; nothing older counts). The listing must be read to its END within a
 * bounded number of pages; otherwise the lookup throws and the caller keeps the outcome unknown. More than one
 * candidate is `ambiguous`; zero is `none` — and `none` is NOT proof that the reply was never published.
 */
import type { InteractionDto, Page, ProviderAccess, ProviderReadPort } from "@/integrations/providers/contract";
import { isoInstant, type PageCursor } from "@/integrations/providers/contract";
import type { ReplyLookup, ReplyLookupResult } from "../ports";

/** Provider clocks drift: a reply timestamped up to this long BEFORE the attempt still counts; older ones never. */
export const LOOKUP_SKEW_MS = 60_000;
/** The listing starts this far before the attempt (window slack) and is read for at most this many pages. */
export const LOOKUP_WINDOW_SLACK_MS = 5 * 60_000;
export const LOOKUP_MAX_PAGES = 10;

export class ReplyLookupIncomplete extends Error {
  override readonly name = "ReplyLookupIncomplete";
  constructor(reason: "no_read_port" | "listing_bound_exceeded") {
    super(`mutation reconciliation: ${reason}`);
  }
}

export function createReadPortReplyLookup(reads: { readonly read: (provider: string) => ProviderReadPort | undefined }, provider: string, now: () => Date): ReplyLookup {
  return {
    async findOwnReply(access: ProviderAccess, target, text, since): Promise<ReplyLookupResult> {
      const port = reads.read(provider);
      if (port === undefined) throw new ReplyLookupIncomplete("no_read_port");
      const earliest = since.getTime() - LOOKUP_SKEW_MS;
      const window = { from: isoInstant(new Date(since.getTime() - LOOKUP_WINDOW_SLACK_MS)), to: isoInstant(now()) };
      const candidates: string[] = [];
      let cursor: PageCursor | null = null;
      for (let page = 0; page < LOOKUP_MAX_PAGES; page += 1) {
        const listed: Page<InteractionDto> = (await port.listInteractions(access, { kind: "content", content: target.content }, window, cursor)).data;
        for (const item of listed.items) {
          const createdAt = item.timestamps.createdAt === null ? null : Date.parse(item.timestamps.createdAt);
          const ownReply = item.parent?.id === target.parent.id && item.author.role === "account_identity" && item.text === text && item.availability !== "removed_at_source";
          if (ownReply && createdAt !== null && createdAt >= earliest) candidates.push(item.ref.id);
        }
        if (listed.next.kind === "end") {
          const [single, ...rest] = candidates;
          if (single === undefined) return { kind: "none" };
          return rest.length === 0 ? { kind: "found", providerReplyId: single } : { kind: "ambiguous" };
        }
        cursor = listed.next.cursor;
      }
      throw new ReplyLookupIncomplete("listing_bound_exceeded");
    },
  };
}
