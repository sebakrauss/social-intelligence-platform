/** Provider OAuth callback (Step 5D). Thin: the server layer verifies, exchanges and persists. */
import { handleOAuthCallback } from "@/server/connections/route";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { provider } = await context.params;
  return handleOAuthCallback(request, provider);
}
