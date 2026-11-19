import { notFound } from "next/navigation";
import type { Metadata } from "next";

/**
 * COMMENTS-UX-07A — DEVELOPMENT ONLY. An interactive comparison of three scroll models for the Comments workspace
 * (A independent panels, B full page, C hybrid), drawn over the SAME synthetic conversations, density and Direction C
 * tokens, plus a reference sheet of the proposed Labels placement, navigation icons and action wording. For the Product
 * Owner's evaluation; not a product decision. Every change lives in the browser tab's React state: nothing is read from
 * or written to a server, a database, storage or a platform, and there is no composer. A 404 in every build that is not
 * `next dev`, whose bundles do not contain the comparison. The approved prototype (../comments-redesign) is unchanged.
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "UI reference · comments scroll comparison", robots: { index: false, follow: false } };

export default async function CommentsScrollComparisonPage() {
  // The condition is written inline so the build folds it: outside `next dev` the import below is dead code, the
  // comparison's client code is not bundled, and the page is a 404.
  if (process.env.NODE_ENV === "development") {
    const { ScrollComparison } = await import("./comparison");
    return <ScrollComparison />;
  }
  notFound();
}
