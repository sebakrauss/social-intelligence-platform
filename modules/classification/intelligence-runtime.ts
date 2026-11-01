/**
 * The INTELLIGENCE plane's entry into the classification module (Step H7-D1d): the understanding task runner and the
 * gateway pieces only the INTELLIGENCE composition (jobs/intelligence.ts) needs. Separate from the module index so the
 * MAIN plane's import graph (dispatch, recovery) never reaches the gateway task, the prompt or the runner.
 */
export { runUnderstanding, RUN_SKIP_REASONS, type IntelligenceRunScope, type UnderstandingModelBinding, type UnderstandingRunDependencies, type UnderstandingRunOutcome, type RunSkipReason } from "./application/ai/run-understanding";
export { understandAiRouteTable } from "./application/ai/understand-ai-contract";
export { UNDERSTANDING_TASK_ID } from "./application/ai/understanding-task";
