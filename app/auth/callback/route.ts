import { NextResponse, type NextRequest } from "next/server";
import { completeEmailLink } from "@/server/auth/callback";

/** Email-link landing (sign-in link, email verification). Redirects only to fixed internal paths. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const destination = await completeEmailLink(request.nextUrl);
  return NextResponse.redirect(new URL(destination, request.nextUrl.origin));
}
