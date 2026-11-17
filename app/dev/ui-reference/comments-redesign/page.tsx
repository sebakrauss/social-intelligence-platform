import { notFound } from "next/navigation";
import type { Metadata } from "next";

/**
 * Comments experience redesign (Step 7B-17V) — DEVELOPMENT ONLY. The proposed Comments interaction model as one
 * interactive prototype over synthetic fixtures: Focus opened and closed from the whole row header, Reply · Labels ·
 * More at each comment, exact times on demand, the connected account named by its verified name, manual labels created
 * and assigned from a comment, and the label filter in the sidebar. Every change lives in the browser tab's React
 * state: nothing is read from or written to a server, a database, storage or a platform, and the reply composer is a
 * preview that cannot publish. A 404 in every build that is not `next dev`, whose bundles do not contain the prototype. Design notes:
 * design/phase-7b/comments-redesign/COMMENTS-EXPERIENCE-REDESIGN.md.
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "UI reference · comments redesign", robots: { index: false, follow: false } };

export default async function CommentsRedesignPage() {
  // The condition is written inline so the build folds it: outside `next dev` the import below is dead code, the
  // prototype's client code is not bundled, and the page is a 404.
  if (process.env.NODE_ENV === "development") {
    const { CommentsRedesign } = await import("./prototype");
    return <CommentsRedesign />;
  }
  notFound();
}
