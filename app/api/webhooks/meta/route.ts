/** Meta webhook receiver (Step H6-F3). Thin: the server layer verifies, records and acknowledges (no session involved). */
import { handleMetaWebhookGet, handleMetaWebhookPost } from "@/server/webhooks/meta-receiver";
import { metaReceiverRuntime } from "@/server/webhooks/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request): Response {
  return handleMetaWebhookGet(request, metaReceiverRuntime());
}

export function POST(request: Request): Promise<Response> {
  return handleMetaWebhookPost(request, metaReceiverRuntime());
}
