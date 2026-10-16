/**
 * Step 5K (K2/K3): the job runtime's provider composition. The synthetic staging stub runs ONLY with the explicit
 * deployment tier preview|staging (whatever NODE_ENV says); production and ambiguous configurations fail closed; the
 * existing simulator rules are unchanged; the stub grants nothing and performs no I/O.
 */
import http from "node:http";
import https from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermanentRejectedError, WebhookRejectedError, providerObjectRef, READ_OPERATIONS, type ProviderReadPort } from "@/integrations/providers/contract";
import { STAGING_STUB_API_VERSION, createStagingStubReadPort } from "@/integrations/providers/staging-stub";
import { ProviderModeError, providerComposition } from "@/server/connections/provider-mode";
import { composeJobProviders, createStagingStubCredentialAccess } from "@/jobs/connections";
import type * as SimulatorModule from "@/server/connections/simulator";

// Step 7F-B: count local-simulator constructions (the original still runs, and still refuses outside development/test).
const simulatorCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/server/connections/simulator", async (importOriginal) => {
  const original = await importOriginal<typeof SimulatorModule>();
  return { ...original, localSimulator: (...args: Parameters<typeof original.localSimulator>) => { simulatorCalls.count += 1; return original.localSimulator(...args); } };
});

const PROD = { NODE_ENV: "production" } as const;
const stub = (tier: string | undefined, extra: Record<string, string> = {}) => ({
  ...PROD,
  CAPABILITY_PROVIDER_MODE: "staging_stub",
  ...(tier === undefined ? {} : { APP_DEPLOYMENT_ENV: tier }),
  ...extra,
});
const WORKSPACE = "0b5d5f4e-8f43-4c55-9a51-6a3c0f2a7e10" as never;
const account = providerObjectRef("facebook", "asset", "synthetic_page_1");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("A/B · staging_stub is permitted with NODE_ENV=production and the explicit preview or staging tier", () => {
  it.each(["preview", "staging"] as const)("tier %s", async (tier) => {
    expect(providerComposition(stub(tier))).toEqual({ kind: "staging_stub", tier });
    const composed = composeJobProviders(stub(tier));
    for (const provider of ["meta", "tiktok", "simulator"] as const) {
      const port = composed.providers.read(provider) as (ProviderReadPort & { synthetic?: boolean }) | undefined;
      expect(port?.synthetic).toBe(true);
      expect(port?.provider).toBe(provider);
    }
    // The lent credential is synthetic and the stored envelope is never opened (junk bytes are fine).
    const lent = await composed.access.withCredential({ workspaceId: WORKSPACE, credentialId: "c1", envelope: new Uint8Array([1, 2, 3]) }, (credential) => Promise.resolve(credential.id));
    expect(lent).toBe("staging-stub");
  });
});

describe("C/D · staging_stub can't silently enter production (fail closed, nothing composed)", () => {
  it.each([
    ["the production tier", stub("production")],
    ["a missing tier under a production runtime", stub(undefined)],
    ["an empty tier", stub("")],
    ["an unknown tier", stub("qa")],
    ["a differently cased tier", stub("Preview")],
    ["a tier with whitespace", stub(" preview")],
    ["a missing tier even in development", { NODE_ENV: "development", CAPABILITY_PROVIDER_MODE: "staging_stub" }],
  ])("rejects %s", (_label, environment) => {
    expect(() => providerComposition(environment)).toThrow(ProviderModeError);
    expect(() => composeJobProviders(environment)).toThrow(ProviderModeError);
  });

  it("rejects unknown provider modes and unknown tiers, naming variables but never values", () => {
    for (const environment of [{ ...PROD, CAPABILITY_PROVIDER_MODE: "stub", APP_DEPLOYMENT_ENV: "preview" }, { ...PROD, CAPABILITY_PROVIDER_MODE: "Staging_Stub", APP_DEPLOYMENT_ENV: "preview" }, { ...PROD, APP_DEPLOYMENT_ENV: "prod-ish" }]) {
      let message = "";
      try {
        providerComposition(environment);
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderModeError);
        message = (error as Error).message;
      }
      expect(message).toMatch(/CAPABILITY_PROVIDER_MODE|APP_DEPLOYMENT_ENV/);
      expect(message).not.toMatch(/stub"|Staging_Stub|prod-ish/);
    }
  });

  it("the local-keyring guard still runs first in staging_stub mode (LOCAL_KEYRING_KEY outside development/test aborts)", () => {
    expect(() => composeJobProviders(stub("preview", { LOCAL_KEYRING_KEY: "A".repeat(43) }))).toThrow(/local_keyring_forbidden/);
  });
});

describe("E · the existing simulator rules are unchanged", () => {
  it("no provider mode → the local simulator composition, development/test only", () => {
    expect(providerComposition({ NODE_ENV: "test" })).toEqual({ kind: "local_simulator" });
    expect(providerComposition({ NODE_ENV: "production" })).toEqual({ kind: "local_simulator" });
    // …which is never built under a production runtime (Step 7F-B), whatever the tier: without the KMS keyring
    // configuration the deployed composition refuses at the credential opener instead (no local fallback).
    simulatorCalls.count = 0;
    expect(() => composeJobProviders({ NODE_ENV: "production" })).toThrow(/credential_crypto_keyring_misconfigured/);
    expect(() => composeJobProviders({ NODE_ENV: "production", APP_DEPLOYMENT_ENV: "preview" })).toThrow(/credential_crypto_keyring_misconfigured/);
    expect(() => composeJobProviders({ NODE_ENV: "production", APP_DEPLOYMENT_ENV: "staging" })).toThrow(/credential_crypto_keyring_misconfigured/);
    expect(simulatorCalls.count).toBe(0);
  });

  it("the staging stub is never the simulator: the simulator connection key gets the synthetic stub in staging_stub mode", () => {
    const port = composeJobProviders(stub("staging")).providers.read("simulator") as ProviderReadPort & { synthetic?: boolean };
    expect(port.synthetic).toBe(true);
  });
});

describe("G · Step 7F-B: managed composition never builds the simulator and composes no provider adapter", () => {
  const KEY = "arn:aws:kms:sa-east-1:000000000000:key/00000000-0000-4000-8000-0000000000aa";
  const managed = { NODE_ENV: "production", APP_DEPLOYMENT_ENV: "staging", CREDENTIAL_CONTEXT_ENV: "dev", CREDENTIAL_KMS_KEY_ARN: KEY, CREDENTIAL_KMS_ALLOWED_KEY_ARNS: KEY };

  it("managed (KMS configured): the real credential opener is composed; no simulator is built; every provider read port is absent", () => {
    simulatorCalls.count = 0;
    const composed = composeJobProviders(managed);
    expect(simulatorCalls.count).toBe(0);
    expect(typeof composed.access.withCredential).toBe("function");
    for (const provider of ["meta", "tiktok", "simulator"] as const) expect(composed.providers.read(provider), provider).toBeUndefined();
  });

  it("no simulator fallback in managed mode, whatever the tier", () => {
    simulatorCalls.count = 0;
    for (const tier of [undefined, "preview", "staging", "production"]) {
      const environment = tier === undefined ? { ...managed, APP_DEPLOYMENT_ENV: undefined } : { ...managed, APP_DEPLOYMENT_ENV: tier };
      expect(composeJobProviders(environment).providers.read("simulator"), String(tier)).toBeUndefined();
    }
    expect(simulatorCalls.count).toBe(0);
  });

  it("local/test runtime still composes the simulator where its own rule allows it", () => {
    simulatorCalls.count = 0;
    const composed = composeJobProviders({ NODE_ENV: "test", LOCAL_KEYRING_KEY: Buffer.alloc(32, 7).toString("base64url") });
    expect(simulatorCalls.count).toBe(1);
    expect(composed.providers.read("simulator")).toBeDefined();
    expect(composed.providers.read("meta")).toBeUndefined();
  });

  it("staging_stub is unchanged: synthetic port, synthetic lent credential, no simulator built", async () => {
    simulatorCalls.count = 0;
    const composed = composeJobProviders(stub("staging"));
    expect(simulatorCalls.count).toBe(0);
    const lent = await composed.access.withCredential({ workspaceId: WORKSPACE, credentialId: "00000000-0000-4000-8000-000000000001", envelope: new Uint8Array([1, 2, 3]) }, (credential) => Promise.resolve(credential.id));
    expect(lent).toBe("staging-stub");
  });
});

describe("F · the staging stub performs no I/O and grants nothing", () => {
  it("describeAccount is deterministic, synthetic and grants nothing; no network client is touched", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const httpSpy = vi.spyOn(http, "request").mockImplementation(() => {
      throw new Error("network forbidden");
    });
    const httpsSpy = vi.spyOn(https, "request").mockImplementation(() => {
      throw new Error("network forbidden");
    });
    const at = new Date("2026-10-07T12:00:00.000Z");
    const port = createStagingStubReadPort("meta", () => at);
    const credential = await createStagingStubCredentialAccess().withCredential({ workspaceId: WORKSPACE, credentialId: "c1", envelope: new Uint8Array(0) }, (lent) => Promise.resolve(lent));
    const first = await port.describeAccount({ credential, account });
    const second = await port.describeAccount({ credential, account });
    expect(first).toEqual(second);
    expect(first.data).toEqual({
      asset: account,
      assetClass: "content_bearing",
      displayName: "Staging stub (synthetic)",
      accountIdentity: null,
      grantedPermissions: [],
      linkedAdAccounts: [],
      describedAt: "2026-10-07T12:00:00.000Z",
      rawReference: { provider: "meta", apiVersion: STAGING_STUB_API_VERSION, ref: "synthetic" },
    });
    expect(first.budget).toEqual({ kind: "not_reported" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(httpSpy).not.toHaveBeenCalled();
    expect(httpsSpy).not.toHaveBeenCalled();
  });

  it("every other read operation is refused (no data is ever produced)", async () => {
    const port = createStagingStubReadPort("tiktok", () => new Date());
    const unknown = port as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const operation of READ_OPERATIONS.filter((op) => op !== "describeAccount")) {
      const call = unknown[operation];
      if (call === undefined) throw new Error(`missing ${operation}`);
      await expect(call(), operation).rejects.toBeInstanceOf(operation === "parseWebhook" ? WebhookRejectedError : PermanentRejectedError);
    }
  });
});
