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
  "auth.sign_in.heading": "Sign in",
  "auth.sign_in.submit": "Sign in",
  "auth.sign_in.link": "Sign in",
  "auth.sign_in_link.heading": "Email me a sign-in link",
  "auth.sign_in_link.submit": "Send link",
  "auth.sign_out.submit": "Sign out",
  "auth.field.email": "Email",
  "auth.field.password": "Password",
  "auth.status.signed_in": "You're signed in.",
  "auth.status.signed_out": "You're signed out.",
  "auth.status.invalid_credentials": "That email and password don't match.",
  "auth.status.verification_required": "Verify your email address to continue. Check your inbox for the verification email.",
  "auth.status.link_sent": "If an account exists for that address, a sign-in link is on its way.",
  "auth.status.invalid_link": "This sign-in link is invalid or has expired.",
  "auth.status.rate_limited": "Too many attempts. Wait a moment and try again.",
  "auth.status.invalid_input": "Check the email address and password, then try again.",
  "auth.status.unavailable": "Sign-in isn't available right now.",
  "auth.sign_up.heading": "Create an account",
  "auth.sign_up.submit": "Create account",
  "auth.sign_up.link": "Create an account",
  "auth.status.sign_up_check_email": "Check your email to verify your address, then sign in.",
  "auth.status.weak_password": "Choose a stronger password.",
};
