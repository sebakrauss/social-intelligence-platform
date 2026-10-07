/** Hosted web health (TA-11A). Thin: the server layer probes the web database and answers generically. */
import { webHealthResponse } from "@/server/http/health";

export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return webHealthResponse();
}
