/**
 * Operational switches (TA §66.2): the typed registry of database-backed flags and kill switches. These are
 * OPERATIONAL controls changed by the team through an audited tool — not product settings. The workspace
 * "Pause all automation" is a product feature stored with policies (TA §25.8) and is deliberately not here.
 *
 * Every switch declares:
 *   - where overrides are allowed (TA §66.2 "Scope" column); anything else is refused by the database too
 *   - its qualifier vocabulary (closed where the vocabulary exists; identifier-shaped where it doesn't yet)
 *   - a closed value shape; any other shape is INVALID
 *   - a default (no rows) and a fail-safe value for invalid configuration or an unreadable store
 *   - its resolution rule: `any_restrictive` (one applicable restrictive row wins: kill/pause/disable) or
 *     `most_specific` (workspace > organization > global, then exact qualifier > "*")
 *
 * Consumers (automation evaluator, executor, availability resolver, AI gateway, integration workers) arrive
 * in later steps and read these contracts; Step 3 builds only the foundation.
 */

export const SWITCH_SCOPES = ["global", "organization", "workspace"] as const;
export type SwitchScope = (typeof SWITCH_SCOPES)[number];

export const PLATFORMS = ["facebook", "instagram", "tiktok"] as const;
export const POLICY_TYPES = ["obvious_spam", "obvious_bots", "malicious_links", "configured_patterns"] as const;
export const MUTATION_ACTIONS = ["public_reply", "private_reply", "hide", "unhide", "delete", "block"] as const;

const IDENTIFIER = /^[a-z][a-z0-9_]{0,40}$/;
const includes = (list: readonly string[], value: string): boolean => list.includes(value);

type Qualifier = (value: string) => boolean;

/** "*" (all) or a value from the vocabulary. */
const qualifiers = {
  none: (value: string) => value === "*",
  platformPolicy: (value: string) => {
    if (value === "*") return true;
    const [platform, policy, extra] = value.split(":");
    return extra === undefined && platform !== undefined && policy !== undefined && includes(PLATFORMS, platform) && includes(POLICY_TYPES, policy);
  },
  platformAction: (value: string) => {
    if (value === "*") return true;
    const [platform, action, extra] = value.split(":");
    return extra === undefined && platform !== undefined && action !== undefined && includes(PLATFORMS, platform) && includes(MUTATION_ACTIONS, action);
  },
  platformOrCapability: (value: string) => {
    if (value === "*") return true;
    const [platform, capability, extra] = value.split(":");
    return extra === undefined && platform !== undefined && includes(PLATFORMS, platform) && (capability === undefined || IDENTIFIER.test(capability));
  },
  platform: (value: string) => value === "*" || includes(PLATFORMS, value),
  /** AI task names aren't catalogued until the AI gateway step; identifier-shaped until then. */
  aiTask: (value: string) => value === "*" || IDENTIFIER.test(value),
} satisfies Record<string, Qualifier>;

function plain(value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

const booleanShape = <K extends string>(key: K) => (value: unknown): Readonly<Record<K, boolean>> | undefined =>
  plain(value, [key]) && typeof value[key] === "boolean" ? (Object.freeze({ [key]: value[key] }) as Readonly<Record<K, boolean>>) : undefined;

export interface AiRoute {
  readonly route: string;
  readonly percentage: number;
}

const aiRoute = (value: unknown): AiRoute | undefined => {
  if (!plain(value, ["route", "percentage"])) return undefined;
  const { route, percentage } = value;
  return typeof route === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(route) && typeof percentage === "number" && Number.isInteger(percentage) && percentage >= 0 && percentage <= 100
    ? Object.freeze({ route, percentage })
    : undefined;
};

export interface SwitchDefinition<V> {
  readonly key: string;
  readonly scopes: readonly SwitchScope[];
  readonly qualifier: Qualifier;
  readonly parse: (value: unknown) => V | undefined;
  readonly defaultValue: V;
  /** Applied when any applicable row is invalid, or the store can't be read. */
  readonly failSafe: V;
  readonly resolution: "any_restrictive" | "most_specific";
  /** For `any_restrictive`: whether a value is the restrictive state. */
  readonly isRestrictive?: (value: V) => boolean;
}

const define = <V>(definition: SwitchDefinition<V>): SwitchDefinition<V> => Object.freeze(definition);

export const SWITCHES = {
  /** Mandatory global automation kill switch: when active, no automation-originated intents. */
  "automation.global_kill": define({
    key: "automation.global_kill",
    scopes: ["global"],
    qualifier: qualifiers.none,
    parse: booleanShape("active"),
    defaultValue: { active: false },
    failSafe: { active: true },
    resolution: "any_restrictive",
    isRestrictive: (value) => value.active,
  }),
  /** Automation release gate per platform × policy type: closed until explicitly opened (PD OQ-28). */
  "automation.release_gate": define({
    key: "automation.release_gate",
    scopes: ["global"],
    qualifier: qualifiers.platformPolicy,
    parse: booleanShape("open"),
    defaultValue: { open: false },
    failSafe: { open: false },
    resolution: "most_specific",
  }),
  /** Platform mutation switch per provider × action (incident control; surfaced as temporarily unavailable). */
  "mutation.provider_action": define({
    key: "mutation.provider_action",
    scopes: ["global"],
    qualifier: qualifiers.platformAction,
    parse: booleanShape("enabled"),
    defaultValue: { enabled: true },
    failSafe: { enabled: false },
    resolution: "any_restrictive",
    isRestrictive: (value) => !value.enabled,
  }),
  /** Provider rollout: enable a platform or capability for selected organizations. Off unless enabled. */
  "provider.rollout": define({
    key: "provider.rollout",
    scopes: ["global", "organization"],
    qualifier: qualifiers.platformOrCapability,
    parse: booleanShape("enabled"),
    defaultValue: { enabled: false },
    failSafe: { enabled: false },
    resolution: "most_specific",
  }),
  /** AI task routing / model rollout (route + percentage), global or per workspace. */
  "ai.task_routing": define({
    key: "ai.task_routing",
    scopes: ["global", "workspace"],
    qualifier: qualifiers.aiTask,
    parse: aiRoute,
    defaultValue: { route: "default", percentage: 100 },
    failSafe: { route: "default", percentage: 100 },
    resolution: "most_specific",
  }),
  /** AI task kill switch (global or per task): when active, the gateway returns AI_UNAVAILABLE. */
  "ai.task_kill": define({
    key: "ai.task_kill",
    scopes: ["global"],
    qualifier: qualifiers.aiTask,
    parse: booleanShape("active"),
    defaultValue: { active: false },
    failSafe: { active: true },
    resolution: "any_restrictive",
    isRestrictive: (value) => value.active,
  }),
  /** Ingestion pause per provider (incident): workers stop and coverage marks the gap honestly. */
  "ingestion.provider_pause": define({
    key: "ingestion.provider_pause",
    scopes: ["global"],
    qualifier: qualifiers.platform,
    parse: booleanShape("paused"),
    defaultValue: { paused: false },
    failSafe: { paused: true },
    resolution: "any_restrictive",
    isRestrictive: (value) => value.paused,
  }),
} as const;

export type SwitchKey = keyof typeof SWITCHES;
export type SwitchValue<K extends SwitchKey> = (typeof SWITCHES)[K] extends SwitchDefinition<infer V> ? V : never;
export const SWITCH_KEYS = Object.keys(SWITCHES) as SwitchKey[];
