/** Step H6-F3 — the web-only Meta webhook configuration: complete or unavailable; errors name variables, never values. */
import { describe, expect, it } from "vitest";
import { MetaWebhookConfigError, PROVIDER_META_WEBHOOK_VERIFY_TOKEN, readMetaWebhookConfig } from "@/server/webhooks/meta-config";

const APP = { PROVIDER_META_CLIENT_ID: "100000000000001", PROVIDER_META_CONFIG_ID: "200000000000001", PROVIDER_META_CLIENT_SECRET: "synthetic-app-secret-value-0001" };
const TOKEN = "synthetic-verify-token-0001";

describe("readMetaWebhookConfig", () => {
  it("is unavailable without the Meta app configuration or without the verify token (fail closed, no bypass)", () => {
    expect(readMetaWebhookConfig({})).toBeUndefined();
    expect(readMetaWebhookConfig({ [PROVIDER_META_WEBHOOK_VERIFY_TOKEN]: TOKEN })).toBeUndefined();
    expect(readMetaWebhookConfig(APP)).toBeUndefined();
    expect(readMetaWebhookConfig({ ...APP, [PROVIDER_META_WEBHOOK_VERIFY_TOKEN]: "" })).toBeUndefined();
  });
  it("reuses the App Secret of the Meta app configuration and wraps both as secrets", () => {
    const config = readMetaWebhookConfig({ ...APP, [PROVIDER_META_WEBHOOK_VERIFY_TOKEN]: TOKEN });
    expect(config?.appSecret.expose()).toBe(APP.PROVIDER_META_CLIENT_SECRET);
    expect(config?.verifyToken.expose()).toBe(TOKEN);
    expect(JSON.stringify(config)).not.toContain(TOKEN);
    expect(JSON.stringify(config)).not.toContain(APP.PROVIDER_META_CLIENT_SECRET);
  });
  it("refuses a short or whitespace-carrying token, naming the variable only", () => {
    for (const token of ["short", "has a space in it 000", "x".repeat(257)]) {
      const attempt = () => readMetaWebhookConfig({ ...APP, [PROVIDER_META_WEBHOOK_VERIFY_TOKEN]: token });
      expect(attempt).toThrow(MetaWebhookConfigError);
      expect(attempt).toThrow(/PROVIDER_META_WEBHOOK_VERIFY_TOKEN/);
      try { attempt(); } catch (error) { expect((error as Error).message).not.toContain(token); }
    }
  });
});
