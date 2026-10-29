/**
 * Independent versions of every pure policy and contract of the classification domain (Step H7-A1; TA §57; H7-A0 §10,
 * §11). Pure. Each changes on its own: a new matcher doesn't re-version the taxonomy, a new protection policy doesn't
 * re-version the output schema. Records name the versions they depend on; a future pipeline version (the
 * understanding-request identity, assessment.ts) is chosen by the runtime, not composed here.
 */
import { CONFIDENCE_CONTRACT_VERSION } from "./confidence";
import { LANGUAGE_POLICY_VERSION } from "./language";
import { NEEDS_REVIEW_POLICY_VERSION } from "./needs-review";
import { PRECEDENCE_VERSION } from "./precedence";
import { PROTECTION_POLICY_VERSION } from "./protection";
import { SIGNALS_VERSION } from "./signals";
import { TAXONOMY_VERSION } from "./taxonomy";
import { UNDERSTANDING_INPUT_CONTRACT_VERSION } from "./understanding-input";
import { UNDERSTANDING_OUTPUT_SCHEMA_VERSION } from "./understanding-output";
import { VALUE_INPUTS_VERSION } from "./value-inputs";
import { WATCH_TERM_MATCHER_VERSION } from "./watch-terms";

export const CLASSIFICATION_DOMAIN_VERSIONS = Object.freeze({
  taxonomy: TAXONOMY_VERSION,
  confidence: CONFIDENCE_CONTRACT_VERSION,
  languagePolicy: LANGUAGE_POLICY_VERSION,
  precedence: PRECEDENCE_VERSION,
  protection: PROTECTION_POLICY_VERSION,
  needsReview: NEEDS_REVIEW_POLICY_VERSION,
  signals: SIGNALS_VERSION,
  watchTermMatcher: WATCH_TERM_MATCHER_VERSION,
  understandingInput: UNDERSTANDING_INPUT_CONTRACT_VERSION,
  understandingOutput: UNDERSTANDING_OUTPUT_SCHEMA_VERSION,
  valueInputs: VALUE_INPUTS_VERSION,
});
