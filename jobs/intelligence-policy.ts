/**
 * The understanding route policy both planes apply (Step H7-D1d): MAIN before a dispatch and at recovery, INTELLIGENCE
 * again at execution. The deny-by-default policy (DEFAULT_UNDERSTAND_AI_ROUTE_POLICY: route disabled, sampling 0, kill
 * switch active, no model / timeout, budget deny-all, no real data, no backfill) stays the domain default and the
 * restore target.
 *
 * Step H7-D1f-prep — TEMPORARY bounded synthetic live-test route (TL-authorized, removed by a source revert after
 * H7-D1f): exactly ONE dedicated synthetic workspace is a fixture workspace; real data stays ineligible
 * (`realDataEligible: false`), so every other workspace is skipped `real_data_not_eligible` before anything is read or
 * written — in MAIN dispatch, MAIN recovery and the INTELLIGENCE run alike. Backfill is excluded. The daily cap is one
 * run (a run reserves 2 calls: the initial call plus the gateway's one re-ask) and the input-character cap is exactly
 * that run's reservation for the declared fixture text. The model reference is the qualified one (a test pins it to
 * ai/providers/anthropic/qualified.ts, which MAIN must not import). Not a production model selection; acceptance SHADOW.
 */
import { DEFAULT_UNDERSTAND_AI_ROUTE_POLICY, type UnderstandAiRoutePolicy } from "@/modules/classification";

/** The ONE synthetic workspace of the H7-D1f live test: new, unused by any repository fixture or dev-v2 row (D1f-prep). */
export const D1F_SYNTHETIC_WORKSPACE_ID = "d1f5e000-0000-4000-8000-000000000001" as const;

/** The declared H7-D1f fixture text (synthetic: a Spanish price objection; never customer text). */
export const D1F_SYNTHETIC_FIXTURE_TEXT = "Me interesa, pero encuentro el precio demasiado caro. ¿Tienen una opción más económica?" as const;

/**
 * One run's input-character reservation for the declared fixture as a top-level comment, at its worst platform / source:
 * 2 × 4 365 (prompt v2 system + A1 data block; a test recomputes it). A longer input is AI_BUDGET, never a call.
 */
export const D1F_MAX_INPUT_CHARS_PER_DAY = 8_730;

export const D1F_SYNTHETIC_ROUTE_POLICY: UnderstandAiRoutePolicy = Object.freeze({
  ...DEFAULT_UNDERSTAND_AI_ROUTE_POLICY,
  enabled: true,
  samplingPercentage: 100,
  killSwitch: "inactive",
  model: Object.freeze({ providerKey: "anthropic", modelKey: "claude-sonnet-5-5" }),
  timeoutMs: 30_000,
  budget: Object.freeze({ kind: "caps" as const, maxCallsPerDay: 2, maxInputCharsPerDay: D1F_MAX_INPUT_CHARS_PER_DAY }),
  realDataEligible: false,
  fixtureWorkspaceIds: Object.freeze([D1F_SYNTHETIC_WORKSPACE_ID]),
  includeBackfill: false,
});

export const INTELLIGENCE_ROUTE_POLICY: UnderstandAiRoutePolicy = D1F_SYNTHETIC_ROUTE_POLICY;
