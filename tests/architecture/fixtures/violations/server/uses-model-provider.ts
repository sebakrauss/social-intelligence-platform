/** Violation (Step H7-D1d): the web never composes a model-provider adapter (it holds no model credential). */
import { vendor } from "../ai/providers/vendor";
export const leaked: unknown = vendor;
