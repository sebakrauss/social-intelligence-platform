/**
 * Meta describeAccount (Step 7G-H5.5; README contract H55), offline. Two documented reads per description — the asset
 * itself (echoed id checked) and me/permissions — mapped into the contract's facts DTO, then through the REAL capability
 * evaluator: with the platform catalog holding no validated entry, every capability stays UNKNOWN_NOT_VALIDATED, never
 * SUPPORTED, whatever Meta granted. `fetch` is an in-process double: no request leaves the process. Synthetic ids,
 * names and tokens only.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ProviderError, isoInstant, providerCredential, providerObjectRef, type AccountDescriptionDto } from "@/integrations/providers/contract";
import { META_PERMISSIONS_MAX_ENTRIES, createMetaGraphTransport, type MetaGraphFetch } from "@/integrations/providers/meta/graph-transport";
import { createMetaReadPort } from "@/integrations/providers/meta/read-port";
import { CAPABILITY_KEYS, PLATFORM_CATALOG, evaluateProfile, factsFromDescription, inputDigest, selectCatalog } from "@/modules/capability";
import { expectRaw, expectRef } from "../contract/assertions";

const TOKEN_MARKER = "synthetic-meta-user-token-marker";
const PAGE_TOKEN_MARKER = "synthetic-meta-page-token-marker";
const BODY_MARKER = "synthetic-meta-graph-body-marker";
const CREDENTIAL = providerCredential("5eed0000-d1a9-4000-8000-00000000e002", TOKEN_MARKER);
const NOW = new Date("2026-10-19T12:00:00.000Z");
const PAGE = "1001";
const IG = "17840001";

const json = (status: number, body: unknown): Promise<Response> => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const graphError = (fields: Record<string, unknown>) => ({ error: { message: BODY_MARKER, error_user_msg: BODY_MARKER, fbtrace_id: "synthetic-trace", ...fields } });
const rendered = (value: unknown): string => [JSON.stringify(value), String(value), inspect(value, { depth: 10, showHidden: true }), value instanceof Error ? `${value.message} ${value.stack ?? ""}` : ""].join(" ");

const PERMISSIONS = {
  data: [
    { permission: "pages_show_list", status: "granted" },
    { permission: "instagram_basic", status: "granted" },
    { permission: "pages_read_engagement", status: "granted" },
    { permission: "business_management", status: "declined" },
    { permission: "ads_read", status: "expired" },
    { permission: "pages_show_list", status: "granted" },
  ],
};

type Reply = (url: URL) => Promise<Response>;
const META_WORLD: Reply = (url) => {
  if (url.pathname === "/v25.0/me/permissions") return json(200, PERMISSIONS);
  const id = decodeURIComponent(url.pathname.split("/")[2] ?? "");
  const fields = url.searchParams.get("fields");
  if (id === PAGE && fields === "id,name") return json(200, { id: PAGE, name: "Synthetic Page", access_token: PAGE_TOKEN_MARKER });
  if (id === IG && fields === "id,username") return json(200, { id: IG, username: "synthetic_brand" });
  return json(400, graphError({ code: 100 }));
};

function portWith(reply: Reply) {
  const calls: string[] = [];
  const fetch: MetaGraphFetch = (url) => {
    calls.push(url);
    return reply(new URL(url));
  };
  const port = createMetaReadPort({ transport: createMetaGraphTransport({ fetch }), clock: () => NOW });
  const paths = () => calls.map((url) => { const parsed = new URL(url); return `${parsed.pathname}?${parsed.searchParams.get("fields") ?? ""}`; });
  return { port, calls, paths, describeAccount: (platform: "facebook" | "instagram" | "tiktok", id: string) => port.describeAccount({ credential: CREDENTIAL, account: providerObjectRef(platform, "asset", id) }) };
}

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
  throw new Error("expected describeAccount to fail");
}

describe("Meta describeAccount · facts", () => {
  it("a Facebook Page: the Page read (echo checked) then me/permissions; granted permissions only, sorted, distinct", async () => {
    const { describeAccount, paths, calls } = portWith(META_WORLD);
    const { data, budget } = await describeAccount("facebook", PAGE);
    expect(paths()).toEqual([`/v25.0/${PAGE}?id,name`, "/v25.0/me/permissions?permission,status"]);
    for (const url of calls) expect(new URL(url).origin).toBe("https://graph.facebook.com");
    expect(data).toEqual({
      asset: providerObjectRef("facebook", "asset", PAGE),
      assetClass: "content_bearing",
      displayName: "Synthetic Page",
      accountIdentity: providerObjectRef("facebook", "author", PAGE),
      grantedPermissions: ["instagram_basic", "pages_read_engagement", "pages_show_list"],
      linkedAdAccounts: [],
      describedAt: isoInstant(NOW),
      rawReference: { provider: "meta", apiVersion: "v25.0", ref: `facebook:page:${PAGE}` },
    } satisfies AccountDescriptionDto);
    expectRef(data.asset, "asset");
    expectRaw(data.rawReference, "meta");
    expect(budget).toBeDefined();
    expect(Object.isFrozen(data)).toBe(true);
  });

  it("an Instagram professional account: E1's documented id,username read, then me/permissions", async () => {
    const { describeAccount, paths } = portWith(META_WORLD);
    const { data } = await describeAccount("instagram", IG);
    expect(paths()).toEqual([`/v25.0/${IG}?id,username`, "/v25.0/me/permissions?permission,status"]);
    expect(data).toMatchObject({
      asset: providerObjectRef("instagram", "asset", IG),
      assetClass: "content_bearing",
      displayName: "synthetic_brand",
      accountIdentity: providerObjectRef("instagram", "author", IG),
      linkedAdAccounts: [],
      rawReference: { provider: "meta", apiVersion: "v25.0", ref: `instagram:account:${IG}` },
    });
  });

  it("missing optional facts: no name/username → empty display name; no granted permission → an empty grant set", async () => {
    const { describeAccount } = portWith((url) =>
      url.pathname === "/v25.0/me/permissions" ? json(200, { data: [{ permission: "pages_show_list", status: "declined" }] }) : json(200, { id: decodeURIComponent(url.pathname.split("/")[2] ?? "") }),
    );
    expect((await describeAccount("facebook", PAGE)).data).toMatchObject({ displayName: "", grantedPermissions: [] });
    expect((await describeAccount("instagram", IG)).data).toMatchObject({ displayName: "", grantedPermissions: [] });
  });

  it("the stray Page access token (and every other extra field) never reaches the facts", async () => {
    const { describeAccount } = portWith(META_WORLD);
    const { data } = await describeAccount("facebook", PAGE);
    expect(rendered(data)).not.toContain(PAGE_TOKEN_MARKER);
    expect(rendered(data)).not.toContain(TOKEN_MARKER);
    const facts = factsFromDescription(data, NOW);
    expect(rendered(facts)).not.toMatch(new RegExp(`${PAGE_TOKEN_MARKER}|${TOKEN_MARKER}|access_token`));
  });
});

describe("Meta describeAccount · refusals (fail closed; no partial description)", () => {
  it("another platform is refused before any request", async () => {
    const { describeAccount, calls } = portWith(META_WORLD);
    const error = await failure(describeAccount("tiktok", "tt-1"));
    expect(error.toJSON()).toEqual({ kind: "permanent_rejected", operation: "describeAccount", retry: "never", details: { reasonCode: "invalid_request" } });
    expect(calls).toEqual([]);
  });

  const malformed: readonly (readonly [string, Reply])[] = [
    ["the Page echoes another id", (url) => (url.pathname.endsWith("/permissions") ? json(200, PERMISSIONS) : json(200, { id: "9999", name: "Other" }))],
    ["a permission entry with an unknown status", (url) => (url.pathname.endsWith("/permissions") ? json(200, { data: [{ permission: "pages_show_list", status: "maybe" }] }) : META_WORLD(url))],
    ["a permission name that is not an identifier", (url) => (url.pathname.endsWith("/permissions") ? json(200, { data: [{ permission: "pages show list", status: "granted" }] }) : META_WORLD(url))],
    ["a permissions page that reports a next page (never a silently truncated grant set)", (url) => (url.pathname.endsWith("/permissions") ? json(200, { ...PERMISSIONS, paging: { next: "https://attacker.example.test/p" } }) : META_WORLD(url))],
    ["an oversized permission list", (url) => (url.pathname.endsWith("/permissions") ? json(200, { data: Array.from({ length: META_PERMISSIONS_MAX_ENTRIES + 1 }, (_, i) => ({ permission: `p${String(i)}`, status: "granted" })) }) : META_WORLD(url))],
    ["no data array", (url) => (url.pathname.endsWith("/permissions") ? json(200, { permissions: [] }) : META_WORLD(url))],
  ];

  it.each(malformed)("%s → permanent (unknown)", async (_label, reply) => {
    const error = await failure(portWith(reply).describeAccount("facebook", PAGE));
    expect(error.toJSON()).toMatchObject({ kind: "permanent_rejected", operation: "describeAccount", details: { reasonCode: "unknown" } });
  });

  it("documented Graph errors keep their normalized meaning (read_account), leaking nothing", async () => {
    const invalid = await failure(portWith(() => json(400, graphError({ code: 190, type: "OAuthException", error_subcode: 463 }))).describeAccount("instagram", IG));
    expect(invalid.toJSON()).toMatchObject({ kind: "credential_invalid", operation: "describeAccount" });
    const permission = await failure(portWith(() => json(403, graphError({ code: 10 }))).describeAccount("facebook", PAGE));
    expect(permission.toJSON()).toMatchObject({ kind: "permission_missing", operation: "describeAccount", details: { capability: "read_account" } });
    const network = await failure(portWith(() => Promise.reject(new TypeError(`fetch failed access_token=${TOKEN_MARKER}`))).describeAccount("facebook", PAGE));
    expect(network.toJSON()).toMatchObject({ kind: "transient", operation: "describeAccount" });
    for (const error of [invalid, permission, network]) {
      expect(rendered(error)).not.toMatch(new RegExp(`${TOKEN_MARKER}|${BODY_MARKER}|graph\\.facebook\\.com|access_token`));
    }
  });

  it("a failing permissions read fails the whole description, after the asset read", async () => {
    const { describeAccount, paths } = portWith((url) => (url.pathname.endsWith("/permissions") ? json(500, {}) : META_WORLD(url)));
    expect((await failure(describeAccount("facebook", PAGE))).kind).toBe("transient");
    expect(paths()).toEqual([`/v25.0/${PAGE}?id,name`, "/v25.0/me/permissions?permission,status"]);
  });
});

describe("Meta facts through the real capability evaluator (platform catalog r3: one validated entry)", () => {
  it("only read_content post/unknown is SUPPORTED (both permissions granted); every any/any row stays UNKNOWN_NOT_VALIDATED; deterministic; revision recorded", async () => {
    const { describeAccount } = portWith(META_WORLD);
    const { data } = await describeAccount("facebook", PAGE);
    const catalog = selectCatalog("meta", { NODE_ENV: "production" });
    expect(catalog).toBe(PLATFORM_CATALOG);
    const input = { catalog, platform: "facebook" as const, assetClass: "content_bearing" as const, facts: factsFromDescription(data, NOW), observations: [], evaluatedAt: NOW };
    const profile = evaluateProfile(input);
    expect(profile).toMatchObject({ catalogId: "platform", catalogRevision: 3 });
    const generic = profile.entries.filter((entry) => entry.contentKind === "any" && entry.source === "any");
    expect(generic.map((entry) => entry.capability).sort()).toEqual([...CAPABILITY_KEYS].sort());
    for (const entry of generic) expect(entry).toMatchObject({ state: "UNKNOWN_NOT_VALIDATED", reasons: ["CATALOG_NOT_VALIDATED"], catalogValidation: "not_validated", evidence: null });
    expect(profile.entries.filter((entry) => !generic.includes(entry))).toEqual([
      { capability: "read_content", contentKind: "post", source: "unknown", state: "SUPPORTED", reasons: ["CATALOG_SUPPORTED"], limitation: null, catalogValidation: "validated", evidence: "api-validation:meta.facebook.read_content.20261023-01", observationRefs: [] },
    ]);
    expect(evaluateProfile(input)).toEqual(profile);
    expect(inputDigest(input)).toBe(inputDigest({ ...input, evaluatedAt: new Date(NOW.getTime() + 60_000) }));
  });
});
