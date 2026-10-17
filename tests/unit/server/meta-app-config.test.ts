/**
 * The hosted web's Meta app configuration contract (Step 7G-C; D5, D13, D14): the exact closed variable set and its
 * classification, all-or-none parsing at adapter-composition time, opaque validation, and that the App Secret can never
 * be rendered — not by inspection, serialization, string conversion or an error. Synthetic values only.
 */
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { SecretValue } from "@/integrations/providers/contract";
import {
  META_APP_CONFIG_VARIABLES,
  MetaAppConfigError,
  PROVIDER_META_CLIENT_ID,
  PROVIDER_META_CLIENT_SECRET,
  PROVIDER_META_CONFIG_ID,
  readMetaAppConfig,
} from "@/server/connections/meta-app-config";
import { codeOf } from "../../support/source-scan";

const SECRET_MARKER = "synthetic-meta-app-secret-marker";
const COMPLETE = {
  PROVIDER_META_CLIENT_ID: "synthetic-client-id",
  PROVIDER_META_CONFIG_ID: "synthetic-config-id",
  PROVIDER_META_CLIENT_SECRET: SECRET_MARKER,
} as const;

const rendered = (value: unknown): string => `${inspect(value, { depth: 5 })} ${JSON.stringify(value)} ${String(value)}`;

function configError(environment: Readonly<Record<string, string | undefined>>): MetaAppConfigError {
  try {
    readMetaAppConfig(environment);
  } catch (error) {
    if (error instanceof MetaAppConfigError) return error;
    throw error;
  }
  throw new Error("expected a MetaAppConfigError");
}

describe("Meta app configuration contract (Step 7G-C)", () => {
  it("is exactly three variables: App ID and login configuration ID non-secret, App Secret secret", () => {
    expect([PROVIDER_META_CLIENT_ID, PROVIDER_META_CONFIG_ID, PROVIDER_META_CLIENT_SECRET]).toEqual(["PROVIDER_META_CLIENT_ID", "PROVIDER_META_CONFIG_ID", "PROVIDER_META_CLIENT_SECRET"]);
    expect(META_APP_CONFIG_VARIABLES).toEqual({ PROVIDER_META_CLIENT_ID: "non_secret", PROVIDER_META_CONFIG_ID: "non_secret", PROVIDER_META_CLIENT_SECRET: "secret" });
    expect(Object.isFrozen(META_APP_CONFIG_VARIABLES)).toBe(true);
  });

  it("has no Client Token: the Meta Client Token is outside the architecture", () => {
    expect(Object.keys(META_APP_CONFIG_VARIABLES).filter((name) => /TOKEN/.test(name))).toEqual([]);
    expect(codeOf("server/connections/meta-app-config.ts")).not.toMatch(/CLIENT_TOKEN|client_token|clientToken/);
  });

  it("none set: Meta is unavailable (undefined), not an error — an unprovisioned hosted web keeps booting", () => {
    expect(readMetaAppConfig({})).toBeUndefined();
    expect(readMetaAppConfig({ NODE_ENV: "production" })).toBeUndefined();
    // The .env convention: an empty value counts as unset.
    expect(readMetaAppConfig({ PROVIDER_META_CLIENT_ID: "", PROVIDER_META_CONFIG_ID: "", PROVIDER_META_CLIENT_SECRET: "" })).toBeUndefined();
  });

  it("all set and valid: opaque values, the secret wrapped as a SecretValue", () => {
    const config = readMetaAppConfig({ NODE_ENV: "production", ...COMPLETE });
    expect(config?.clientId).toBe("synthetic-client-id");
    expect(config?.configId).toBe("synthetic-config-id");
    expect(config?.clientSecret).toBeInstanceOf(SecretValue);
    expect(config?.clientSecret.expose()).toBe(SECRET_MARKER);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("identifiers are opaque: no numeric or other provider format is assumed", () => {
    for (const id of ["0", "1234567890123456", "abc-DEF_123.x:y", "x".repeat(256)]) {
      expect(readMetaAppConfig({ ...COMPLETE, PROVIDER_META_CLIENT_ID: id, PROVIDER_META_CONFIG_ID: id })?.configId, id).toBe(id);
    }
  });

  it("some set: incomplete, refused, naming exactly the missing variables", () => {
    expect(configError({ PROVIDER_META_CLIENT_ID: "synthetic-client-id" })).toMatchObject({ reason: "incomplete", variables: ["PROVIDER_META_CONFIG_ID", "PROVIDER_META_CLIENT_SECRET"] });
    expect(configError({ PROVIDER_META_CLIENT_SECRET: SECRET_MARKER })).toMatchObject({ reason: "incomplete", variables: ["PROVIDER_META_CLIENT_ID", "PROVIDER_META_CONFIG_ID"] });
    expect(configError({ ...COMPLETE, PROVIDER_META_CONFIG_ID: "" })).toMatchObject({ reason: "incomplete", variables: ["PROVIDER_META_CONFIG_ID"] });
  });

  it("invalid values (padding, whitespace, control characters, oversize): refused, naming the variable only", () => {
    const cases: readonly (readonly [string, string])[] = [
      [PROVIDER_META_CLIENT_ID, " synthetic-client-id"],
      [PROVIDER_META_CONFIG_ID, "synthetic-config-id\n"],
      [PROVIDER_META_CONFIG_ID, "synthetic config"],
      [PROVIDER_META_CLIENT_ID, "x".repeat(257)],
      [PROVIDER_META_CLIENT_SECRET, `${SECRET_MARKER}\n`],
      [PROVIDER_META_CLIENT_SECRET, `${SECRET_MARKER}\u0000`],
      [PROVIDER_META_CLIENT_SECRET, `${SECRET_MARKER}-ñ`],
    ];
    for (const [name, value] of cases) {
      const error = configError({ ...COMPLETE, [name]: value });
      expect(error.reason, name).toBe("invalid");
      expect(error.variables, name).toEqual([name]);
    }
  });

  it("errors name variables, never values (the App Secret included)", () => {
    const incomplete = configError({ PROVIDER_META_CLIENT_SECRET: SECRET_MARKER, PROVIDER_META_CLIENT_ID: "synthetic-client-id" });
    const invalid = configError({ ...COMPLETE, PROVIDER_META_CLIENT_SECRET: `${SECRET_MARKER} ` });
    for (const error of [incomplete, invalid]) {
      expect(error.message).toMatch(/^meta app configuration (incomplete|invalid): PROVIDER_META_[A-Z_]+/);
      expect(`${rendered(error)} ${error.stack ?? ""}`).not.toMatch(/synthetic-meta-app-secret|synthetic-client-id/);
    }
  });

  it("the parsed configuration never renders the App Secret", () => {
    const config = readMetaAppConfig(COMPLETE);
    expect(rendered(config)).not.toContain(SECRET_MARKER);
    expect(rendered(config?.clientSecret)).not.toContain(SECRET_MARKER);
    expect(String(config?.clientSecret)).toBe("[redacted]");
  });

  it("reads only the environment its composition root passes: never process.env, no I/O", () => {
    const code = codeOf("server/connections/meta-app-config.ts");
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toMatch(/\bfetch\(|node:http|node:https|undici|from "http"/);
    expect([...code.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1])).toEqual(["@/integrations/providers/contract"]);
  });
});
