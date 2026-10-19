/**
 * Workspace Settings › Connections, Managed accounts (Step 7G-H5), rendered on the server with the read model replaced
 * in-process. Proves what the operator sees: the provider connection's status apart from "N of M selected", the persisted
 * managed state as the checked boxes (nothing preselected otherwise), the four empty/partial/full states, outcome
 * messages that never read as success on a refusal, display names rendered as text, and a Save button that is disabled
 * while its submission is in flight.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionSettingsState } from "@/server/connections/settings";
import { t } from "@/server/i18n";

const WS = "3b241101-e2bb-4255-8caf-4136c566a962";
const CONNECTION = "6f1c2e0a-8b3d-4c5e-9f70-112233445566";
const FACEBOOK = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const INSTAGRAM = "1b2c3d4e-5f6a-4b7c-9d8e-9fa0b1c2d3e4";

const env = vi.hoisted((): { state: unknown; pending: boolean } => ({ state: undefined, pending: false }));

vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("@/server/connections/settings-runtime", () => ({
  currentConnectionSettings: () => Promise.resolve(env.state),
  connectionSettingsPipeline: () => undefined,
}));
vi.mock("react-dom", async (original) => ({ ...(await original<Record<string, unknown>>()), useFormStatus: () => ({ pending: env.pending }) }));

const { default: Page } = await import("@/app/workspaces/[workspaceId]/settings/connections/page");
const { PendingSubmitButton } = await import("@/ui/connections/pending-submit-button");

type Ready = Extract<ConnectionSettingsState, { kind: "ready" }>;
const ready = (managed: { facebook?: boolean; instagram?: boolean } | null, status = "ACTIVE" as Ready["connections"][number]["status"]): Ready => ({
  kind: "ready",
  workspaceId: WS as never,
  connections: [{ id: CONNECTION, provider: "meta", status } as Ready["connections"][number]],
  metaConnect: "existing_connection",
  manageableAssets:
    managed === null
      ? []
      : [
          { connectionId: CONNECTION, discoveredAssetId: FACEBOOK, platform: "facebook", displayName: "Synthetic Page", managed: managed.facebook ?? false },
          { connectionId: CONNECTION, discoveredAssetId: INSTAGRAM, platform: "instagram", displayName: "synthetic.ig", managed: managed.instagram ?? false },
        ],
});

async function render(state: ConnectionSettingsState, status?: string): Promise<string> {
  env.state = state;
  const element = await Page({ params: Promise.resolve({ workspaceId: WS }), searchParams: Promise.resolve(status === undefined ? {} : { status }) });
  return renderToStaticMarkup(element);
}
/** A catalog message as React renders text: apostrophes and quotes escaped. */
const text = (message: string): string => message.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;");
const checkbox = (html: string, id: string): string | undefined => html.match(new RegExp(`<input[^>]*value="${id}"[^>]*>`))?.[0];
const forms = (html: string): number => [...html.matchAll(/<form\b/g)].length;

beforeEach(() => {
  env.pending = false;
});

describe("Managed accounts on the Connections page", () => {
  it("A — first use: both discovered accounts render unchecked, 0 of 2 selected, the provider connection shown apart", async () => {
    const html = await render(ready({}));
    expect(html).toContain(text(t("connections.connection.provider_status", { status: t("connections.connection.status.active") })));
    expect(html).toContain(text(t("connections.accounts.heading")));
    expect(html).toContain(text(t("connections.accounts.explainer")));
    expect(html).toContain(text(t("connections.accounts.summary", { selected: "0", available: "2" })));
    expect(html).toContain(text(t("connections.accounts.none_selected")));
    expect(html).toContain(`Synthetic Page · ${text(t("connections.accounts.platform.facebook"))}`);
    expect(html).toContain(`synthetic.ig · ${text(t("connections.accounts.platform.instagram"))}`);
    expect(checkbox(html, FACEBOOK)).not.toMatch(/checked/);
    expect(checkbox(html, INSTAGRAM)).not.toMatch(/checked/);
    expect(checkbox(html, FACEBOOK)).toMatch(/name="discoveredAssetId"/);
    expect(html).toContain(`name="connectionId" value="${CONNECTION}"`);
    expect(forms(html)).toBe(2); // Remove + Managed accounts (Connect Meta is closed by the existing connection)
    expect(html).not.toContain(text(t("connections.status.accounts_saved")));
  });

  it("B — some managed: the persisted state is what is checked; C — all managed", async () => {
    const some = await render(ready({ facebook: true }));
    expect(some).toContain(text(t("connections.accounts.summary", { selected: "1", available: "2" })));
    expect(checkbox(some, FACEBOOK)).toMatch(/checked=""/);
    expect(checkbox(some, INSTAGRAM)).not.toMatch(/checked/);
    expect(some).not.toContain(text(t("connections.accounts.none_selected")));
    expect(some).not.toContain(text(t("connections.accounts.all_selected")));
    const all = await render(ready({ facebook: true, instagram: true }));
    expect(all).toContain(text(t("connections.accounts.summary", { selected: "2", available: "2" })));
    expect(all).toContain(text(t("connections.accounts.all_selected")));
  });

  it("D — nothing to manage: a plain, non-error empty state and no save form", async () => {
    const html = await render(ready(null));
    expect(html).toContain(text(t("connections.accounts.empty")));
    expect(html).not.toContain(text(t("connections.accounts.save")));
    expect(html).not.toContain(text(t("connections.settings.unavailable")));
    expect(forms(html)).toBe(1); // Remove only
  });

  it("only an ACTIVE Meta connection offers Managed accounts", async () => {
    for (const status of ["CONNECTING", "DEGRADED", "FAILED", "DISCONNECTED", "REMOVED"] as const) {
      const html = await render(ready({ facebook: true }, status));
      expect(html, status).not.toContain(text(t("connections.accounts.heading")));
      expect(html, status).not.toContain('name="discoveredAssetId"');
    }
  });

  it("outcome messages: saved reads as saved; every refusal reads as nothing saved, never as success", async () => {
    expect(await render(ready({ facebook: true }), "accounts_saved")).toContain(text(t("connections.status.accounts_saved")));
    for (const status of ["accounts_not_found", "accounts_conflict", "connection_not_ready", "not_allowed", "unavailable"]) {
      const html = await render(ready({}), status);
      expect(html, status).not.toContain(text(t("connections.status.accounts_saved")));
    }
    for (const key of ["connections.status.accounts_not_found", "connections.status.accounts_conflict", "connections.status.connection_not_ready"] as const) {
      expect(t(key)).toMatch(/^Nothing was saved/);
    }
    // An unknown status value shows no outcome at all.
    expect(await render(ready({}), "<script>alert(1)</script>")).not.toMatch(/role="status"|alert\(1\)/);
  });

  it("display names are text, never markup", async () => {
    const state = ready({});
    const hostile: Ready = { ...state, manageableAssets: state.manageableAssets.map((asset) => ({ ...asset, displayName: '<img src=x onerror="alert(1)">' })) };
    const html = await render(hostile);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("the Save button is enabled at rest and disabled, saying so, while the submission is in flight", () => {
    const props = { label: t("connections.accounts.save"), pendingLabel: t("connections.accounts.saving") };
    expect(renderToStaticMarkup(createElement(PendingSubmitButton, props))).toBe(`<button type="submit" aria-disabled="false">${t("connections.accounts.save")}</button>`);
    env.pending = true;
    expect(renderToStaticMarkup(createElement(PendingSubmitButton, props))).toBe(`<button type="submit" disabled="" aria-disabled="true">${t("connections.accounts.saving")}</button>`);
  });
});
