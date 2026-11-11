/** Violation (Step 7B-14C1): the executor never reaches the read-only Instagram reply preflight reader. */
import { createInstagramReplyPreflight } from "../integrations/providers/meta/instagram-reply-preflight";
export const reached = createInstagramReplyPreflight;
