/**
 * The understanding route policy both planes apply (Step H7-D1d): MAIN before a dispatch and at recovery, INTELLIGENCE
 * again at execution. Deny-by-default and unchanged in source: route disabled, sampling 0, kill switch active, no
 * model / timeout, budget deny-all, no real data, no backfill. Enabling any of it is a later, TL-authorized gate
 * (H7-D1e), never a code default.
 */
import { DEFAULT_UNDERSTAND_AI_ROUTE_POLICY, type UnderstandAiRoutePolicy } from "@/modules/classification";

export const INTELLIGENCE_ROUTE_POLICY: UnderstandAiRoutePolicy = DEFAULT_UNDERSTAND_AI_ROUTE_POLICY;
