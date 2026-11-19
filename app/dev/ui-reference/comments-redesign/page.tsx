import { notFound } from "next/navigation";
import type { Metadata } from "next";

/**
 * Comments experience redesign (Steps 7B-17V … UX-04) — DEVELOPMENT ONLY. The proposed Comments workspace as one
 * interactive prototype over synthetic fixtures: two panels, Open / Needs attention / Assigned to me / Escalated / Done,
 * search and filters, conversation management (assign, Urgent, escalate, Done with a resolution, Reopen), manual labels
 * (assigned at a comment, managed in Settings), simulated Facebook and Instagram comment actions with confirmations, and
 * Details as an overlay drawer. Every change lives in the browser tab's React state: nothing is read from or written to
 * a server, a database, storage or a platform, and the reply composer is a preview that cannot publish. A 404 in every
 * build that is not `next dev`, whose bundles do not contain the prototype. Design notes:
 * design/phase-7b/comments-redesign/ (UX04-DECISION-REGISTER.md lists the hypotheses awaiting Product Owner approval).
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
