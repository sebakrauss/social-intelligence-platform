/**
 * DEVELOPMENT REFERENCE CATALOG — not a launch-scope decision.
 *
 * Exists so code, tests and the error taxonomy can resolve message keys during development.
 * Its locale is a development reference only: the MVP interface-language set is still OPEN
 * (PD OQ-20), and final user-facing copy is a content-design deliverable (IA §21.2).
 * Wording follows the outcome language of TA §44.1 / UX §25–§26 (no implementation terms).
 */
import type { Catalog } from "../catalog";

export const DEVELOPMENT_REFERENCE_LOCALE = "en";

export const developmentReferenceCatalog: Catalog = {
  "error.permission_denied": "You don't have access to this. Ask a workspace admin.",
  "error.not_found": "This item isn't available.",
  "error.mode_blocked": "This workspace is Monitor-only.",
  "error.capability_unsupported": "{platform} doesn't allow this here.",
  "error.capability_unknown": "This isn't available yet for {platform}.",
  "error.connection_problem": "The {platform} connection needs attention.",
  "error.provider_rate_limited": "Delayed by {platform}. We'll retry.",
  "error.provider_transient": "{platform} isn't responding. We'll retry.",
  "error.provider_permanent": "{platform} couldn't complete this.",
  "error.outcome_unknown": "We couldn't confirm this with {platform}. Checking…",
  "error.invalid_input": "Check this value and try again.",
  "error.conflict": "This was just updated by someone else.",
  "error.stale_state": "This changed since you opened it.",
  "error.protection_veto": "{excludedCount} items were excluded and need individual review.",
  "error.ai_invalid_output": "This couldn't be processed automatically. It needs a human look.",
  "error.ai_unavailable": "This is temporarily unavailable.",
  "error.ai_refused": "Couldn't produce a suitable result for this item.",
  "error.ai_budget_exceeded": "This is temporarily unavailable.",
  "error.job_failed": "This couldn't be completed. You can retry.",
};
