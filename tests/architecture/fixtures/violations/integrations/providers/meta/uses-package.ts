/** Violation: the Meta adapter never imports an npm package (no SDK, HTTP client or framework). */
import next from "next/dist/server/next.js";
export const leaked = next;
