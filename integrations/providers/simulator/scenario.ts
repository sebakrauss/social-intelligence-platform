/**
 * Simulator scenarios: the synthetic, human-readable world a simulator instance starts from (TA §52, §53).
 * Scenarios live as JSON fixtures under `fixtures/providers/simulator/` and are validated strictly here, so a
 * fixture mistake fails loudly instead of producing a subtly wrong world.
 *
 * A scenario describes what OUR ARCHITECTURE CAN REPRESENT, not what any real platform supports. Simulated
 * permissions, restrictions, webhook support and rate budgets are synthetic test conditions; none is evidence
 * about Facebook, Instagram or TikTok (PD OQ-18, OQ-19 remain VALIDATE).
 */
import { PLATFORM_KEYS, type PlatformKey } from "../../../domain/platforms";
import {
  ASSET_CLASSES,
  CONTENT_AVAILABILITY,
  CONTENT_KINDS,
  CONTENT_SOURCES,
  PAID_STATUSES,
  type AssetClass,
  type ContentAvailability,
  type ContentKind,
  type ContentSource,
  type InteractionVisibility,
  type PaidStatus,
} from "../contract/dto";
import { parseIsoInstant, parseProviderObjectId, type IsoInstant } from "../contract/identity";
import { parseFaultRule, type FaultRule } from "./faults";

/** Mutations a scenario can mark as refused for a specific target (a SIMULATED restriction). */
export const SIMULATED_RESTRICTIONS = ["reply_public", "reply_private", "hide", "unhide", "delete", "block"] as const;
export type SimulatedRestriction = (typeof SIMULATED_RESTRICTIONS)[number];

export interface ScenarioCredential {
  readonly id: string;
  readonly secret: string;
  readonly status: "active" | "revoked" | "expired";
  readonly expiresAt: IsoInstant | null;
  readonly refresh: "supported" | "not_supported";
  readonly assets: readonly string[];
}

export interface ScenarioAsset {
  readonly id: string;
  readonly platform: PlatformKey;
  readonly assetClass: AssetClass;
  readonly displayName: string;
  readonly identity: string | null;
  readonly permissions: readonly string[];
  readonly linkedAdAccounts: readonly string[];
  readonly webhooks: "supported" | "not_supported";
  readonly subscribed: boolean;
}

export interface ScenarioAuthor {
  readonly id: string;
  readonly platform: PlatformKey;
  readonly role: "account_identity" | "user";
  readonly displayName: string;
  readonly handle: string;
}

export interface ScenarioContent {
  readonly id: string;
  readonly account: string;
  readonly kind: ContentKind;
  readonly reportedSource: ContentSource;
  readonly caption: string | null;
  readonly publishedAt: IsoInstant;
  readonly availability: ContentAvailability;
}

export interface ScenarioInteraction {
  readonly id: string;
  readonly content: string;
  readonly parent: string | null;
  readonly author: string;
  readonly text: string;
  readonly createdAt: IsoInstant;
  readonly editedAt: IsoInstant | null;
  readonly revision: string | null;
  readonly visibility: Exclude<InteractionVisibility, "unknown">;
  readonly presence: "present" | "removed_signaled" | "vanished";
  readonly restrictions: readonly SimulatedRestriction[];
}

export interface ScenarioPaidObject {
  readonly id: string;
  readonly adAccount: string;
  readonly name: string;
  readonly status: PaidStatus;
  readonly createdAt: IsoInstant;
}

export interface ScenarioAdGroup extends ScenarioPaidObject {
  readonly campaign: string | null;
}

export interface ScenarioAd extends ScenarioPaidObject {
  readonly adGroup: string | null;
  readonly campaign: string | null;
  readonly content: string | null;
}

export type ScenarioRateBudget =
  | { readonly mode: "not_reported" }
  | { readonly mode: "reported"; readonly limit: number; readonly windowSeconds: number };

export interface SimulatorScenario {
  readonly scenarioId: string;
  readonly description: string;
  /** Always a simulator marker ("simulator-v1"), never a real provider API version. */
  readonly apiVersion: string;
  readonly clockStart: IsoInstant;
  readonly pageSize: number;
  readonly rateBudget: ScenarioRateBudget;
  readonly webhookToleranceSeconds: number;
  readonly credentials: readonly ScenarioCredential[];
  readonly assets: readonly ScenarioAsset[];
  readonly authors: readonly ScenarioAuthor[];
  readonly contents: readonly ScenarioContent[];
  readonly interactions: readonly ScenarioInteraction[];
  readonly campaigns: readonly ScenarioPaidObject[];
  readonly adGroups: readonly ScenarioAdGroup[];
  readonly ads: readonly ScenarioAd[];
  readonly faultPresets: Readonly<Record<string, readonly FaultRule[]>>;
}

export class ScenarioError extends Error {
  override readonly name = "ScenarioError";
}

type Json = Readonly<Record<string, unknown>>;

function fail(path: string): never {
  throw new ScenarioError(`invalid scenario at ${path}`);
}

function record(value: unknown, path: string, keys: readonly string[]): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path);
  const json = value as Json;
  for (const key of Object.keys(json)) if (!keys.includes(key)) fail(`${path}.${key}`);
  return json;
}

function str(value: unknown, path: string, options: { readonly max?: number; readonly nullable?: false } = {}): string {
  if (typeof value !== "string" || value.length === 0 || value.length > (options.max ?? 2000)) fail(path);
  return value;
}

function nullableStr(value: unknown, path: string): string | null {
  return value === null ? null : str(value, path);
}

function id(value: unknown, path: string): string {
  return parseProviderObjectId(value) ?? fail(path);
}

function nullableId(value: unknown, path: string): string | null {
  return value === null ? null : id(value, path);
}

function instant(value: unknown, path: string): IsoInstant {
  return parseIsoInstant(value) ?? fail(path);
}

function nullableInstant(value: unknown, path: string): IsoInstant | null {
  return value === null ? null : instant(value, path);
}

function oneOf<T extends string>(values: readonly T[], value: unknown, path: string): T {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : fail(path);
}

function array<T>(value: unknown, path: string, item: (entry: unknown, path: string) => T): readonly T[] {
  if (!Array.isArray(value)) fail(path);
  return value.map((entry: unknown, index) => item(entry, `${path}[${String(index)}]`));
}

function positiveInt(value: unknown, path: string): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fail(path);
}

function bool(value: unknown, path: string): boolean {
  return typeof value === "boolean" ? value : fail(path);
}

function unique(ids: readonly string[], path: string): void {
  if (new Set(ids).size !== ids.length) fail(path);
}

/** Validates a scenario fixture (structure, enums, identities and every cross-reference). */
export function parseScenario(input: unknown): SimulatorScenario {
  const root = record(input, "$", [
    "scenarioId", "description", "simulated", "apiVersion", "clockStart", "pageSize", "rateBudget", "webhookToleranceSeconds",
    "credentials", "assets", "authors", "contents", "interactions", "campaigns", "adGroups", "ads", "faultPresets",
  ]);
  if (root["simulated"] !== true) fail("$.simulated");
  const apiVersion = str(root["apiVersion"], "$.apiVersion", { max: 32 });
  if (!apiVersion.startsWith("simulator-")) fail("$.apiVersion");

  const budget = record(root["rateBudget"], "$.rateBudget", ["mode", "limit", "windowSeconds"]);
  const rateBudget: ScenarioRateBudget =
    oneOf(["reported", "not_reported"], budget["mode"], "$.rateBudget.mode") === "reported"
      ? { mode: "reported", limit: positiveInt(budget["limit"], "$.rateBudget.limit"), windowSeconds: positiveInt(budget["windowSeconds"], "$.rateBudget.windowSeconds") }
      : { mode: "not_reported" };

  const assets = array(root["assets"], "$.assets", (value, path) => {
    const a = record(value, path, ["id", "platform", "assetClass", "displayName", "identity", "permissions", "linkedAdAccounts", "webhooks", "subscribed"]);
    return {
      id: id(a["id"], `${path}.id`),
      platform: oneOf(PLATFORM_KEYS, a["platform"], `${path}.platform`),
      assetClass: oneOf(ASSET_CLASSES, a["assetClass"], `${path}.assetClass`),
      displayName: str(a["displayName"], `${path}.displayName`, { max: 200 }),
      identity: nullableId(a["identity"], `${path}.identity`),
      permissions: array(a["permissions"], `${path}.permissions`, (p, pp) => str(p, pp, { max: 64 })),
      linkedAdAccounts: array(a["linkedAdAccounts"], `${path}.linkedAdAccounts`, id),
      webhooks: oneOf(["supported", "not_supported"], a["webhooks"], `${path}.webhooks`),
      subscribed: bool(a["subscribed"], `${path}.subscribed`),
    } satisfies ScenarioAsset;
  });

  const credentials = array(root["credentials"], "$.credentials", (value, path) => {
    const c = record(value, path, ["id", "secret", "status", "expiresAt", "refresh", "assets"]);
    return {
      id: id(c["id"], `${path}.id`),
      secret: str(c["secret"], `${path}.secret`, { max: 128 }),
      status: oneOf(["active", "revoked", "expired"], c["status"], `${path}.status`),
      expiresAt: nullableInstant(c["expiresAt"], `${path}.expiresAt`),
      refresh: oneOf(["supported", "not_supported"], c["refresh"], `${path}.refresh`),
      assets: array(c["assets"], `${path}.assets`, id),
    } satisfies ScenarioCredential;
  });

  const authors = array(root["authors"], "$.authors", (value, path) => {
    const a = record(value, path, ["id", "platform", "role", "displayName", "handle"]);
    return {
      id: id(a["id"], `${path}.id`),
      platform: oneOf(PLATFORM_KEYS, a["platform"], `${path}.platform`),
      role: oneOf(["account_identity", "user"], a["role"], `${path}.role`),
      displayName: str(a["displayName"], `${path}.displayName`, { max: 200 }),
      handle: str(a["handle"], `${path}.handle`, { max: 100 }),
    } satisfies ScenarioAuthor;
  });

  const contents = array(root["contents"], "$.contents", (value, path) => {
    const c = record(value, path, ["id", "account", "kind", "reportedSource", "caption", "publishedAt", "availability"]);
    return {
      id: id(c["id"], `${path}.id`),
      account: id(c["account"], `${path}.account`),
      kind: oneOf(CONTENT_KINDS, c["kind"], `${path}.kind`),
      reportedSource: oneOf(CONTENT_SOURCES, c["reportedSource"], `${path}.reportedSource`),
      caption: nullableStr(c["caption"], `${path}.caption`),
      publishedAt: instant(c["publishedAt"], `${path}.publishedAt`),
      availability: oneOf(CONTENT_AVAILABILITY, c["availability"], `${path}.availability`),
    } satisfies ScenarioContent;
  });

  const interactions = array(root["interactions"], "$.interactions", (value, path) => {
    const i = record(value, path, ["id", "content", "parent", "author", "text", "createdAt", "editedAt", "revision", "visibility", "presence", "restrictions"]);
    return {
      id: id(i["id"], `${path}.id`),
      content: id(i["content"], `${path}.content`),
      parent: nullableId(i["parent"], `${path}.parent`),
      author: id(i["author"], `${path}.author`),
      text: str(i["text"], `${path}.text`),
      createdAt: instant(i["createdAt"], `${path}.createdAt`),
      editedAt: nullableInstant(i["editedAt"], `${path}.editedAt`),
      revision: i["revision"] === null ? null : str(i["revision"], `${path}.revision`, { max: 32 }),
      visibility: oneOf(["visible", "hidden"], i["visibility"], `${path}.visibility`),
      presence: oneOf(["present", "removed_signaled", "vanished"], i["presence"], `${path}.presence`),
      restrictions: array(i["restrictions"], `${path}.restrictions`, (r, rp) => oneOf(SIMULATED_RESTRICTIONS, r, rp)),
    } satisfies ScenarioInteraction;
  });

  const paid = (value: unknown, path: string, extra: readonly string[]) => {
    const p = record(value, path, ["id", "adAccount", "name", "status", "createdAt", ...extra]);
    return {
      json: p,
      base: {
        id: id(p["id"], `${path}.id`),
        adAccount: id(p["adAccount"], `${path}.adAccount`),
        name: str(p["name"], `${path}.name`, { max: 200 }),
        status: oneOf(PAID_STATUSES, p["status"], `${path}.status`),
        createdAt: instant(p["createdAt"], `${path}.createdAt`),
      },
    };
  };
  const campaigns = array(root["campaigns"], "$.campaigns", (value, path) => paid(value, path, []).base);
  const adGroups = array(root["adGroups"], "$.adGroups", (value, path) => {
    const { json, base } = paid(value, path, ["campaign"]);
    return { ...base, campaign: nullableId(json["campaign"], `${path}.campaign`) } satisfies ScenarioAdGroup;
  });
  const ads = array(root["ads"], "$.ads", (value, path) => {
    const { json, base } = paid(value, path, ["adGroup", "campaign", "content"]);
    return {
      ...base,
      adGroup: nullableId(json["adGroup"], `${path}.adGroup`),
      campaign: nullableId(json["campaign"], `${path}.campaign`),
      content: nullableId(json["content"], `${path}.content`),
    } satisfies ScenarioAd;
  });

  const presetsRaw = root["faultPresets"];
  if (typeof presetsRaw !== "object" || presetsRaw === null || Array.isArray(presetsRaw)) fail("$.faultPresets");
  const presetsJson = presetsRaw as Json;
  const faultPresets: Record<string, readonly FaultRule[]> = {};
  for (const [name, rules] of Object.entries(presetsJson)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) fail(`$.faultPresets.${name}`);
    faultPresets[name] = array(rules, `$.faultPresets.${name}`, (rule, path) => parseFaultRule(rule) ?? fail(path));
  }

  const scenario: SimulatorScenario = {
    scenarioId: id(root["scenarioId"], "$.scenarioId"),
    description: str(root["description"], "$.description"),
    apiVersion,
    clockStart: instant(root["clockStart"], "$.clockStart"),
    pageSize: positiveInt(root["pageSize"], "$.pageSize"),
    rateBudget,
    webhookToleranceSeconds: positiveInt(root["webhookToleranceSeconds"], "$.webhookToleranceSeconds"),
    credentials,
    assets,
    authors,
    contents,
    interactions,
    campaigns,
    adGroups,
    ads,
    faultPresets,
  };
  checkReferences(scenario);
  return scenario;
}

function checkReferences(s: SimulatorScenario): void {
  unique(s.credentials.map((c) => c.id), "$.credentials[].id");
  unique(s.assets.map((a) => a.id), "$.assets[].id");
  unique(s.authors.map((a) => a.id), "$.authors[].id");
  unique(s.contents.map((c) => c.id), "$.contents[].id");
  unique(s.interactions.map((i) => i.id), "$.interactions[].id");
  unique([...s.campaigns, ...s.adGroups, ...s.ads].map((p) => p.id), "$.paid[].id");

  const assets = new Map(s.assets.map((a) => [a.id, a]));
  const authors = new Map(s.authors.map((a) => [a.id, a]));
  const contents = new Map(s.contents.map((c) => [c.id, c]));
  const interactions = new Map(s.interactions.map((i) => [i.id, i]));
  const adAccount = (assetId: string, path: string): void => {
    if (assets.get(assetId)?.assetClass !== "ad_account") fail(path);
  };

  for (const c of s.credentials) for (const a of c.assets) if (!assets.has(a)) fail(`$.credentials.${c.id}.assets`);
  for (const a of s.assets) {
    if (a.identity !== null && authors.get(a.identity)?.role !== "account_identity") fail(`$.assets.${a.id}.identity`);
    for (const linked of a.linkedAdAccounts) adAccount(linked, `$.assets.${a.id}.linkedAdAccounts`);
  }
  for (const c of s.contents) {
    if (assets.get(c.account)?.assetClass !== "content_bearing") fail(`$.contents.${c.id}.account`);
  }
  for (const i of s.interactions) {
    const content = contents.get(i.content);
    const author = authors.get(i.author);
    if (content === undefined || author === undefined) fail(`$.interactions.${i.id}`);
    if (author.platform !== assets.get(content.account)?.platform) fail(`$.interactions.${i.id}.author`);
    if (i.parent !== null && interactions.get(i.parent)?.content !== i.content) fail(`$.interactions.${i.id}.parent`);
  }
  const campaignIds = new Set(s.campaigns.map((c) => c.id));
  const adGroupIds = new Set(s.adGroups.map((g) => g.id));
  for (const p of [...s.campaigns, ...s.adGroups, ...s.ads]) adAccount(p.adAccount, `$.paid.${p.id}.adAccount`);
  for (const g of s.adGroups) if (g.campaign !== null && !campaignIds.has(g.campaign)) fail(`$.adGroups.${g.id}.campaign`);
  for (const ad of s.ads) {
    if (ad.campaign !== null && !campaignIds.has(ad.campaign)) fail(`$.ads.${ad.id}.campaign`);
    if (ad.adGroup !== null && !adGroupIds.has(ad.adGroup)) fail(`$.ads.${ad.id}.adGroup`);
    if (ad.content !== null && !contents.has(ad.content)) fail(`$.ads.${ad.id}.content`);
  }
}
