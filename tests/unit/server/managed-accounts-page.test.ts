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
type Offer = Ready["manageableAssets"][number]["capabilityReevaluation"];
const FACEBOOK_ACCOUNT = "2c3d4e5f-6a7b-4c8d-9e0f-a0b1c2d3e4f5";
const INSTAGRAM_ACCOUNT = "3d4e5f6a-7b8c-4d9e-8f0a-b1c2d3e4f5a6";
/** A managed asset's account and re-check offer (default: a current, usable profile — nothing offered). */
const managedFields = (managed: boolean | undefined, account: string, offer: Offer = { allowed: false, reason: "PROFILE_CURRENT" }) =>
  managed === true ? { managed: true, connectedAccountId: account, capabilityReevaluation: offer } : { managed: false, connectedAccountId: null, capabilityReevaluation: null };
const ready = (
  managed: { facebook?: boolean; instagram?: boolean } | null,
  status = "ACTIVE" as Ready["connections"][number]["status"],
  offers: { facebook?: Offer; instagram?: Offer } = {},
): Ready => ({
  kind: "ready",
  workspaceId: WS as never,
  connections: [{ id: CONNECTION, provider: "meta", status } as Ready["connections"][number]],
  metaConnect: "existing_connection",
  manageableAssets:
    managed === null
      ? []
      : [
          { connectionId: CONNECTION, discoveredAssetId: FACEBOOK, platform: "facebook", displayName: "Synthetic Page", ...managedFields(managed.facebook, FACEBOOK_ACCOUNT, offers.facebook) },
          { connectionId: CONNECTION, discoveredAssetId: INSTAGRAM, platform: "instagram", displayName: "synthetic.ig", ...managedFields(managed.instagram, INSTAGRAM_ACCOUNT, offers.instagram) },
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
    expect(forms(html)).toBe(3); // Reconnect + Remove + Managed accounts (Connect Meta is closed by the existing connection)
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
    expect(forms(html)).toBe(2); // Reconnect + Remove only
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

describe("Capability re-check on the Connections page (Step 7G-H5.5-P2-B2)", () => {
  const recheckForms = (html: string): string[] => [...html.matchAll(/<form[^>]*>(?:(?!<\/form>)[\s\S])*name="connectedAccountId"(?:(?!<\/form>)[\s\S])*<\/form>/g)].map((match) => match[0]);
  const button = `>${text(t("connections.recheck.submit"))}</button>`;

  it.each([
    ["PROFILE_NOT_EVALUATED", "connections.recheck.reason.not_evaluated"],
    ["PROFILE_STALE", "connections.recheck.reason.stale"],
    ["ACCOUNT_FACTS_UNAVAILABLE", "connections.recheck.reason.facts_unavailable"],
  ] as const)("%s: the managed account is offered ONE re-check form with only the workspace and account ids", async (reason, message) => {
    const html = await render(ready({ facebook: true, instagram: true }, "ACTIVE", { facebook: { allowed: true, reason } }));
    expect(html).toContain(text(t("connections.recheck.heading")));
    expect(html).toContain(text(t("connections.recheck.explainer")));
    expect(html).toContain(text(t(message)));
    const forms = recheckForms(html);
    expect(forms).toHaveLength(1);
    const [form] = forms;
    expect(form).toContain(`name="connectedAccountId" value="${FACEBOOK_ACCOUNT}"`);
    expect(form).toContain(`name="workspaceId" value="${WS}"`);
    expect([...(form ?? "").matchAll(/<input[^>]*name="([^"]+)"/g)].map((match) => match[1])).toEqual(["workspaceId", "connectedAccountId"]);
    expect(form).toContain(button);
    expect(html).not.toContain(INSTAGRAM_ACCOUNT); // current profile: nothing offered
  });

  it.each([
    ["usable current profile", { allowed: false, reason: "PROFILE_CURRENT" }],
    ["profile newer than this code", { allowed: false, reason: "PROFILE_NEWER_THAN_CODE" }],
    ["inactive account", { allowed: false, reason: "ACCOUNT_INACTIVE" }],
    ["connection not active", { allowed: false, reason: "CONNECTION_NOT_ACTIVE" }],
  ] as const)("%s: no re-check section, no button", async (_label, offer) => {
    const html = await render(ready({ facebook: true }, "ACTIVE", { facebook: offer }));
    expect(html).not.toContain(button);
    expect(html).not.toContain(text(t("connections.recheck.heading")));
    expect(recheckForms(html)).toEqual([]);
  });

  it("an unmanaged asset (no account) and an empty connection offer nothing", async () => {
    expect(await render(ready({}))).not.toContain(button);
    expect(await render(ready(null))).not.toContain(button);
  });

  it("re-checked recently: a note, no button (the command would refuse REEVALUATION_TOO_SOON anyway)", async () => {
    const html = await render(ready({ facebook: true }, "ACTIVE", { facebook: { allowed: false, reason: "REEVALUATION_TOO_SOON" } }));
    expect(html).toContain(text(t("connections.recheck.reason.too_soon")));
    expect(html).not.toContain(button);
    expect(recheckForms(html)).toEqual([]);
  });

  it("the cooldown note is true whatever started it (activation, move-in or re-check): it names an EVALUATION request, never a past re-check", () => {
    // One view reason (REEVALUATION_TOO_SOON) covers LINKED, MOVED_IN and REEVALUATION_REQUESTED, so one copy must fit all three.
    const note = t("connections.recheck.reason.too_soon");
    expect(note).toBe("A capability evaluation was requested recently. You can request a re-check 30 minutes after the last evaluation request.");
    expect(note).not.toMatch(/re-check was requested|re-checked/i);
    expect(note).toMatch(/30 minutes/);
    // The refusal shown after a stale-tab click keeps its own (already accurate) wording.
    expect(t("connections.status.capability_recheck_too_soon")).toMatch(/re-checked or activated less than 30 minutes ago/);
  });

  it("not allowed / not found / unavailable states render no Managed accounts and no re-check at all", async () => {
    for (const state of [{ kind: "not_allowed" }, { kind: "workspace_not_found" }, { kind: "unavailable" }, { kind: "verification_required" }] as const) {
      const html = await render(state);
      expect(html, state.kind).not.toContain(button);
      expect(html, state.kind).not.toContain('name="connectedAccountId"');
    }
  });

  it("success says REQUESTED (not completed, not enabled); every refusal says nothing was requested, without internals", async () => {
    const requested = t("connections.status.capability_recheck_requested");
    expect(requested).toMatch(/requested/i);
    expect(requested).not.toMatch(/\b(completed|finished|enabled|fixed|authori[sz]ed|available now)\b/i);
    expect(requested).toMatch(/doesn't mean any capability is available/);
    expect(t("connections.recheck.explainer")).toMatch(/doesn't enable anything, fix the connection or change the provider's authorization/);
    expect(await render(ready({ facebook: true }), "capability_recheck_requested")).toContain(text(requested));
    for (const status of [
      "capability_recheck_too_soon",
      "capability_recheck_not_needed",
      "capability_recheck_newer_version",
      "capability_recheck_account_inactive",
      "capability_recheck_connection_not_active",
      "capability_recheck_not_found",
    ] as const) {
      const message = t(`connections.status.${status}`);
      expect(message, status).toMatch(/^No (new )?re-check was requested/);
      expect(message, status).not.toMatch(/REEVALUATION|PROFILE_|dispatch|outbox|trigger|meta|run_|\bSQL\b|error code/i);
      const html = await render(ready({ facebook: true }), status);
      expect(html, status).toContain(text(message));
      expect(html, status).not.toContain(text(requested));
    }
  });

  it("the re-check button is disabled, saying so, while its request is in flight (no double submit)", () => {
    const props = { label: t("connections.recheck.submit"), pendingLabel: t("connections.recheck.submitting") };
    expect(renderToStaticMarkup(createElement(PendingSubmitButton, props))).toBe(`<button type="submit" aria-disabled="false">${t("connections.recheck.submit")}</button>`);
    env.pending = true;
    expect(renderToStaticMarkup(createElement(PendingSubmitButton, props))).toBe(`<button type="submit" disabled="" aria-disabled="true">${t("connections.recheck.submitting")}</button>`);
  });

  it("display names in the re-check list are text, never markup", async () => {
    const state = ready({ facebook: true }, "ACTIVE", { facebook: { allowed: true, reason: "PROFILE_STALE" } });
    const hostile: Ready = { ...state, manageableAssets: state.manageableAssets.map((asset) => ({ ...asset, displayName: "<b onclick=x>n</b>" })) };
    const html = await render(hostile);
    expect(html).not.toContain("<b onclick");
    expect(html).toContain("&lt;b onclick=x&gt;n&lt;/b&gt;");
  });
});

describe("Reconnect Meta on the Connections page (Step 7G-H5.5-P12-C0-R2)", () => {
  /** The rendered Reconnect form (the one whose button says Reconnect), or undefined. */
  const reconnectForm = (html: string): string | undefined =>
    [...html.matchAll(/<form\b[\s\S]*?<\/form>/g)].map((match) => match[0]).find((form) => form.includes(text(t("connections.reconnect.submit"))));

  it("every Meta connection that isn't REMOVED offers ONE Reconnect, posting only the workspace and that connection's ids", async () => {
    for (const status of ["CONNECTING", "ACTIVE", "DEGRADED", "FAILED", "DISCONNECTED"] as const) {
      const html = await render(ready(null, status));
      const form = reconnectForm(html);
      expect(form, status).toBeDefined();
      expect([...(form ?? "").matchAll(/<input\b[^>]*>/g)].map((match) => match[0])).toEqual([
        `<input type="hidden" name="workspaceId" value="${WS}"/>`,
        `<input type="hidden" name="connectionId" value="${CONNECTION}"/>`,
      ]);
      expect(form).toContain(text(t("connections.reconnect.explainer")));
      expect([...html.matchAll(new RegExp(text(t("connections.reconnect.submit")), "g"))]).toHaveLength(1);
    }
  });

  it("a REMOVED connection, and the not-allowed / not-found / unavailable states, offer no Reconnect", async () => {
    expect(reconnectForm(await render(ready(null, "REMOVED")))).toBeUndefined();
    for (const kind of ["not_allowed", "workspace_not_found", "unavailable"] as const) expect(reconnectForm(await render({ kind }))).toBeUndefined();
  });

  it("the page names no credential, refresh marker or evaluation authority anywhere", async () => {
    const html = await render(ready({ facebook: true, instagram: true }));
    expect(html).not.toMatch(/credential_id|credentialId|capability_refresh|capabilityRefresh|evaluate_account|reauthorized/);
  });
});
