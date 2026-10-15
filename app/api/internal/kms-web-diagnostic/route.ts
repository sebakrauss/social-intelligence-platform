/**
 * TEMPORARY operator invocation of the hosted web KMS identity diagnostic (Step 7E.10-C0). Removed by a cleanup
 * commit right after the one live proof. Thin: POST only (no other method is exported); the server layer authenticates
 * the ephemeral operator key and the acknowledgement, then runs the diagnostic once.
 */
import { webKmsIdentityDiagnostic } from "@/server/connections/runtime";
import { handleWebKmsDiagnosticRequest } from "@/server/connections/web-kms-diagnostic-route";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleWebKmsDiagnosticRequest(request, process.env, webKmsIdentityDiagnostic);
}
