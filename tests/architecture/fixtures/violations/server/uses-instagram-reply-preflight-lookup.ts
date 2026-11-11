/** Violation (Step 7B-14C1): only the diagnostic module reaches its read-only lookup. */
import { instagramReplyPreflightLookup } from "./persistence/instagram-reply-preflight";
export const reached = instagramReplyPreflightLookup;
