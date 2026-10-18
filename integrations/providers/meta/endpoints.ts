/**
 * Meta's fixed endpoints for the first provider slice (Step 7G-D; design/phase-7g/meta-provider/README.md, D1).
 *
 * One Graph API version for everything this adapter calls: the Facebook Login for Business dialog, the
 * authorization-code exchange and, from Step 7G-E, the Graph reads. Meta documents no required version (an
 * unversioned call follows the app dashboard setting); the version is pinned so behavior never changes silently,
 * and moving off it is a deliberate, reviewed change. Never configuration.
 */
export const META_GRAPH_VERSION = "v25.0";

/** The Facebook Login manual-flow dialog, which Facebook Login for Business invokes with a configuration ID. */
export const META_DIALOG_URL = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`;

export const META_GRAPH_ORIGIN = "https://graph.facebook.com";

/** The manual-flow authorization-code exchange (GET). */
export const META_TOKEN_URL = `${META_GRAPH_ORIGIN}/${META_GRAPH_VERSION}/oauth/access_token`;
