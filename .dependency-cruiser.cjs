/**
 * Architectural dependency boundaries (CLAUDE.md §4; TA §6.3, §6.4, §7.2).
 *
 * Rules are written against the TA §6.2 layout. Most directories don't exist yet: their rules
 * become active as soon as code appears in them. Path conventions encoded here (to be kept
 * when those steps begin):
 *   - `mutations/request/`                         public request API of the executor (TA §6.3)
 *   - `integrations/providers/contract/mutation-port*`  provider mutation port (TA §15.1)
 *   - `modules/<name>/{domain,application,persistence}/`, public API at `modules/<name>/index.ts`
 *
 * Enforced by `npm run boundaries` (CI, blocking) and proven by tests/architecture/boundaries.test.ts.
 */

const PRODUCTION = "^(app|ui|server|domain|modules|platform|integrations|ai|mutations|jobs|db)/";
const NPM = ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-bundled", "npm-no-pkg", "npm-unknown"];

/**
 * TA §7.2 layers, as defense in depth: a module never depends on a higher layer or on another module
 * of its own layer (same-layer modules communicate through domain events). Fractional ranks encode only
 * the sub-layer arrows TA §7.2 names explicitly.
 */
const MODULE_RANK = {
  tenancy: 0, audit: 0, // L0
  capability: 0.1, coverage: 0.1, // L0 arrow: tenancy · audit · flags → capability · coverage
  connections: 0.2, // L0 arrow: capability · coverage → connections
  content: 1, conversations: 1, interactions: 1, // L1
  ingestion: 1.1, // L1 arrow: content · conversations · interactions → ingestion
  classification: 2, topics: 2, // L2
  workflow: 3, "brand-context": 3, "saved-replies": 3, // L3
  moderation: 4, automation: 4, replies: 4, // L4 (mutations/ is L3½, outside modules/)
  aggregation: 5, // L5
  insights: 6, // L6
  recommendations: 6.1, // L6 arrow: recommendations → insights
  reports: 7, alerts: 7, attention: 7, // L7
};

/**
 * TA §7.2 "From / May depend on" table: authoritative for the modules it lists, and stricter than the
 * layer rule. Only module-to-module edges are listed here; the AI gateway and the executor request API
 * are governed by their own rules below.
 */
const MODULE_ALLOWLIST = {
  ingestion: ["tenancy", "connections", "capability", "coverage", "content", "conversations", "interactions"],
  classification: ["interactions", "conversations", "content", "tenancy"],
  workflow: ["conversations", "interactions", "classification", "tenancy", "audit"],
  automation: ["classification", "interactions", "capability", "connections", "tenancy", "coverage", "audit"],
  moderation: ["interactions", "classification", "capability", "tenancy", "audit"],
  replies: ["interactions", "conversations", "brand-context", "saved-replies", "classification"],
  aggregation: ["interactions", "classification", "topics", "content", "coverage", "workflow"],
  insights: ["aggregation", "coverage", "interactions", "content"],
  recommendations: ["insights", "aggregation", "coverage", "tenancy"],
  reports: ["insights", "recommendations", "aggregation", "coverage"],
  attention: ["workflow", "classification", "connections", "tenancy"],
};

/** Modules TA §7.2 allows to use the AI gateway (never ai/providers directly). */
const AI_GATEWAY_MODULES = ["classification", "replies", "insights"];

/** Modules that request platform mutations (TA §7.2 L4) — through mutations/request only. */
const MUTATION_REQUESTERS = ["moderation", "automation", "replies"];

/** Modules the executor may depend on (TA §7.2 table). */
const EXECUTOR_DEPENDENCIES = ["tenancy", "capability", "connections", "classification", "audit"];

/** Deterministic modules that must not call AI (TA §7.2 table). */
const AI_FREE_MODULES = ["automation", "moderation", "aggregation"];

/** Vendor SDK packages and where they may be imported. Extend when an SDK is adopted. */
const PROVIDER_SDKS = { meta: ["facebook-nodejs-business-sdk"] };
const AI_SDKS = ["@anthropic-ai/sdk", "openai"];
const DB_DRIVERS = ["pg", "postgres", "drizzle-orm"];

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const anyOf = (names) => names.map(escape).join("|");
const npmPackage = (names) => `(^|/)node_modules/(${anyOf(names)})/`;

const layeringRules = Object.keys(MODULE_RANK).flatMap((from) => {
  const forbidden = Object.keys(MODULE_RANK).filter((to) => to !== from && MODULE_RANK[to] >= MODULE_RANK[from]);
  return forbidden.length === 0
    ? []
    : [
        {
          name: `module-layering-${from}`,
          severity: "error",
          comment: `TA §7.2: '${from}' may depend only on lower layers (same-layer modules use domain events).`,
          from: { path: `^modules/${escape(from)}/` },
          to: { path: `^modules/(${anyOf(forbidden)})/` },
        },
      ];
});

const allowlistRules = Object.entries(MODULE_ALLOWLIST).map(([from, allowed]) => ({
  name: `module-allowlist-${from}`,
  severity: "error",
  comment: `TA §7.2 table: '${from}' may depend only on ${allowed.join(", ")}.`,
  from: { path: `^modules/${escape(from)}/` },
  to: { path: "^modules/", pathNot: `^modules/(${anyOf([from, ...allowed])})/` },
}));

const providerSdkRules = Object.entries(PROVIDER_SDKS)
  .filter(([, packages]) => packages.length > 0)
  .map(([platform, packages]) => ({
    name: `provider-sdk-only-in-${platform}-adapter`,
    severity: "error",
    comment: `TA §6.3 rule 2: ${platform} SDK types stay inside integrations/providers/${platform}.`,
    from: { pathNot: `^integrations/providers/${platform}/` },
    to: { path: npmPackage(packages) },
  }));

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ── Shared kernel and module domains are pure (TA §6.3 rule 1) ──────────────────────────
    {
      name: "shared-kernel-pure",
      severity: "error",
      comment: "domain/ is the pure shared kernel: no application, infrastructure, integration, AI, mutation or job code.",
      from: { path: "^domain/" },
      to: { path: "^(app|ui|server|modules|platform|integrations|ai|mutations|jobs|db|tests|tools)/" },
    },
    {
      name: "module-domain-pure",
      severity: "error",
      comment: "modules/<m>/domain may depend only on domain/ and its own domain.",
      from: { path: "^modules/([^/]+)/domain/" },
      to: {
        path: "^(app|ui|server|modules|platform|integrations|ai|mutations|jobs|db|tests|tools)/",
        pathNot: "^modules/$1/domain/",
      },
    },
    {
      name: "domain-no-packages",
      severity: "error",
      comment: "Pure domain code imports no packages or Node built-ins (no Next.js, database clients, SDKs, I/O).",
      from: { path: "^(domain|modules/[^/]+/domain)/" },
      to: { dependencyTypes: [...NPM, "core"] },
    },

    // ── UI layers (TA §6.3 rule 5) ───────────────────────────────────────────────────────────
    {
      name: "app-ui-no-infrastructure",
      severity: "error",
      comment: "app/ and ui/ must not import platform/db, integrations, ai/providers or mutations.",
      from: { path: "^(app|ui)/" },
      to: { path: "^(platform/db|integrations|ai/providers|mutations)/" },
    },

    // ── Authentication boundary (TA §10.1–§10.2) ─────────────────────────────────────────────
    {
      name: "supabase-sdk-only-in-platform-auth",
      severity: "error",
      comment: "The Supabase SDK is imported only by the auth adapter in platform/auth; nothing else sees its types.",
      from: { pathNot: "^platform/auth/" },
      to: { path: "(^|/)node_modules/@supabase/" },
    },
    {
      name: "app-ui-no-auth-adapter",
      severity: "error",
      comment: "app/ and ui/ reach authentication only through server/ (server/auth), never platform/auth.",
      from: { path: "^(app|ui)/" },
      to: { path: "^platform/auth/" },
    },
    {
      name: "modules-no-auth-adapter",
      severity: "error",
      comment: "Domain and application code receive identities from the pipeline, never from the auth adapter.",
      from: { path: "^modules/" },
      to: { path: "^platform/auth/" },
    },
    {
      name: "resolved-context-minted-by-pipeline-only",
      severity: "error",
      comment: "Tenant/user contexts are created only by server/pipeline (live resolution); others may import their types.",
      from: { pathNot: "^(server/pipeline|tests)/" },
      to: { path: "^server/pipeline/context\\.ts$", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "modules-not-to-upper-layers",
      severity: "error",
      comment: "Modules sit below the application layer: they never import server/, app/, ui/ or jobs/ (TA §6.3).",
      from: { path: "^modules/" },
      to: { path: "^(server|app|ui|jobs)/" },
    },

    // ── AI boundary (TA §6.3 rule 4; §7.2) ───────────────────────────────────────────────────
    {
      name: "ai-no-mutations-integrations-or-writers",
      severity: "error",
      comment: "ai/ returns data to its caller: no mutations, provider integrations or persistence that writes facts/decisions.",
      from: { path: "^ai/" },
      to: { path: "^(mutations|integrations|db|platform/db)/|^modules/[^/]+/persistence/" },
    },
    {
      name: "modules-no-ai-providers",
      severity: "error",
      comment: "Modules never import AI provider adapters; approved modules use the gateway port only.",
      from: { path: "^modules/" },
      to: { path: "^ai/providers/" },
    },
    {
      name: "ai-gateway-only-for-approved-modules",
      severity: "error",
      comment: `Only ${AI_GATEWAY_MODULES.join(", ")} may depend on the AI gateway (TA §7.2).`,
      from: { path: "^modules/", pathNot: `^modules/(${anyOf(AI_GATEWAY_MODULES)})/` },
      to: { path: "^ai/" },
    },
    {
      name: "deterministic-modules-no-ai",
      severity: "error",
      comment: "automation, moderation and aggregation are deterministic and never call AI (TA §7.2).",
      from: { path: `^modules/(${anyOf(AI_FREE_MODULES)})/` },
      to: { path: "^ai/" },
    },
    {
      name: "ai-sdk-only-in-ai-providers",
      severity: "error",
      comment: "AI provider SDK types stay inside ai/providers (TA §22).",
      from: { pathNot: "^ai/providers/" },
      to: { path: npmPackage(AI_SDKS) },
    },

    // ── Platform Mutation Executor (TA §6.3 rule 3; §26) ─────────────────────────────────────
    {
      name: "mutation-port-executor-only",
      severity: "error",
      comment: "Only mutations/ may obtain the provider mutation port (adapters implement it; jobs/ composes it).",
      from: { pathNot: "^(mutations|jobs|integrations/providers|tests)/" },
      to: { path: "^integrations/providers/contract/mutation-port" },
    },
    {
      name: "mutation-execution-jobs-only",
      severity: "error",
      comment: "Executor internals are bundled only into the job runtime; others use mutations/request.",
      from: { pathNot: "^(mutations|jobs|tests)/" },
      to: { path: "^mutations/", pathNot: "^mutations/request/" },
    },
    {
      name: "mutation-request-callers",
      severity: "error",
      comment: "Only server/, jobs/ and the L4 modules (moderation, automation, replies) may request mutations.",
      from: { pathNot: `^(server|jobs|mutations|tests|modules/(${anyOf(MUTATION_REQUESTERS)}))/` },
      to: { path: "^mutations/request/" },
    },
    {
      name: "executor-dependencies",
      severity: "error",
      comment: "The executor depends only on tenancy, capability, connections, classification, audit and its ports.",
      from: { path: "^mutations/" },
      to: {
        path: "^(app|ui|server|ai|modules)/",
        pathNot: `^modules/(${anyOf(EXECUTOR_DEPENDENCIES)})/`,
      },
    },

    // ── Provider adapters (TA §6.3 rule 2; §15) ──────────────────────────────────────────────
    {
      name: "provider-adapter-isolated",
      severity: "error",
      comment: "Adapters implement contract ports; they don't decide product behavior or import other adapters.",
      from: { path: "^integrations/providers/(?!contract/)([^/]+)/" },
      to: {
        path: "^(app|ui|server|modules|mutations|ai|jobs|db|platform/db|integrations)/",
        pathNot: "^integrations/providers/(contract|$1)/",
      },
    },
    {
      name: "provider-contract-has-no-implementations",
      severity: "error",
      comment: "integrations/providers/contract defines ports and normalized DTOs only.",
      from: { path: "^integrations/providers/contract/" },
      to: { path: "^(app|ui|server|modules|mutations|ai|jobs|db|platform)/|^integrations/providers/(?!contract/)" },
    },
    {
      name: "provider-implementations-composed-only",
      severity: "error",
      comment: "Concrete adapters are wired only at composition roots (jobs/, server/ for OAuth token exchange).",
      from: { pathNot: "^(jobs|server|integrations/providers|tests)/" },
      to: { path: "^integrations/providers/(?!contract/)[^/]+/" },
    },
    ...providerSdkRules,

    // ── Modules (TA §6.3 rule 6; §7.2) ───────────────────────────────────────────────────────
    {
      name: "module-public-api-only",
      severity: "error",
      comment: "Modules use other modules only through their public API (modules/<m>/index.ts).",
      from: { path: "^modules/([^/]+)/" },
      to: { path: "^modules/[^/]+/", pathNot: "^modules/($1/|[^/]+/index\\.ts$)" },
    },
    {
      name: "modules-request-mutations-only-from-l4",
      severity: "error",
      comment: "Below L4, modules never touch the executor; insights/recommendations/reports never request mutations.",
      from: { path: "^modules/", pathNot: `^modules/(${anyOf(MUTATION_REQUESTERS)})/` },
      to: { path: "^mutations/" },
    },
    ...allowlistRules,
    ...layeringRules,
    {
      name: "module-core-no-database",
      severity: "error",
      comment: "Module domain/application code works through ports; only module persistence uses database infrastructure.",
      from: { path: "^modules/[^/]+/(domain|application)/" },
      to: { path: "^(platform/db|db)/" },
    },
    {
      name: "db-drivers-only-in-persistence",
      severity: "error",
      comment: "Database clients only in platform/db, db/ and module persistence.",
      from: { pathNot: "^(platform/db|db|modules/[^/]+/persistence)/" },
      to: { path: npmPackage(DB_DRIVERS) },
    },
    {
      name: "platform-is-infrastructure",
      severity: "error",
      comment: "platform/ is cross-cutting infrastructure: it implements ports and never depends on product code.",
      from: { path: "^platform/" },
      to: { path: "^(app|ui|server|modules|mutations|ai|jobs|integrations)/" },
    },

    // ── Jobs are thin entry points (TA §6.3 rule 7) ──────────────────────────────────────────
    {
      name: "jobs-are-entry-points",
      severity: "error",
      comment: "Nothing imports jobs/.",
      from: { pathNot: "^(jobs|tests)/" },
      to: { path: "^jobs/" },
    },
    {
      name: "jobs-no-business-logic",
      severity: "error",
      comment: "jobs/ resolve tenant context and call application services; no domain rules or persistence.",
      from: { path: "^jobs/" },
      to: { path: "^(db|modules/[^/]+/(domain|persistence))/" },
    },

    // ── Hygiene ──────────────────────────────────────────────────────────────────────────────
    {
      name: "production-not-to-tests-or-tools",
      severity: "error",
      comment: "Runtime code never imports tests, test fixtures or repository tooling.",
      from: { path: PRODUCTION },
      to: { path: "^(tests|tools)/" },
    },
    {
      name: "not-to-dev-dependency",
      severity: "error",
      comment: "Runtime code must not depend on devDependencies.",
      from: { path: PRODUCTION },
      to: { dependencyTypes: ["npm-dev"], dependencyTypesNot: ["type-only"] },
    },
    {
      name: "no-undeclared-package",
      severity: "error",
      comment: "Every imported package must be declared in package.json.",
      from: {},
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "(^|/)node_modules/" },
    exclude: { path: "^(spikes|docs|coverage|out|\\.next|tests/architecture/fixtures)/" },
    includeOnly: "^(app|ui|server|domain|modules|platform|integrations|ai|mutations|jobs|db|tests|tools)/|(^|/)node_modules/",
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    combinedDependencies: false,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".d.ts", ".js", ".mjs", ".cjs", ".json"],
      mainFields: ["module", "main", "types", "typings"],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
