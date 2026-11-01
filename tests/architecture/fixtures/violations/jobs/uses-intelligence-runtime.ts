/** Violation (Step H7-D1d): only the INTELLIGENCE composition reaches the classification module's intelligence entry. */
import { runUnderstanding } from "../modules/classification/intelligence-runtime";
export const leaked: unknown = runUnderstanding;
