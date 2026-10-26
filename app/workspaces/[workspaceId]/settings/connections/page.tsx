import { redirect } from "next/navigation";
import { reconnectMetaConnectionAction, removeMetaConnectionAction, requestCapabilityRecheckAction, saveManagedAccountsAction, startMetaConnectionAction } from "@/server/connections/actions";
import {
  ASSET_PLATFORM_MESSAGES,
  CAPABILITY_RECHECK_OFFER_MESSAGES,
  CONNECTION_PROVIDER_MESSAGES,
  CONNECTION_STATUS_MESSAGES,
  CONNECT_STATUS_MESSAGES,
  REMOVE_ACKNOWLEDGEMENT,
  parseConnectStatus,
  type ManageableAssetView,
} from "@/server/connections/settings";
import { currentConnectionSettings } from "@/server/connections/settings-runtime";
import { t } from "@/server/i18n";
import { PendingSubmitButton } from "@/ui/connections/pending-submit-button";

/** Connection state is per request: never prerender it. */
export const dynamic = "force-dynamic";

/**
 * Workspace Settings › Connections (Step 7G-F4; IA §18: Owner/Admin). Rendering only reads (connections.settings.view);
 * Connect Meta is one form posting the workspace id to a server action. Whether that button shows is UX only — the
 * atomic start decides. A Meta connection that isn't REMOVED (including a FAILED or DISCONNECTED one) blocks a fresh
 * connect; each has an inline Remove form (Step 7G-F4C) with a visible acknowledgement — a LOCAL removal that does not
 * revoke anything inside Meta. REMOVED ones show their status only. Minimal and utilitarian.
 *
 * Reconnect Meta (Step 7G-H5.5-P12-C0-R2): each Meta connection that isn't REMOVED also has ONE Reconnect form posting
 * the workspace and connection ids, which re-authorizes that same connection with Meta. The page names nothing else:
 * no credential, evaluation or refresh — what follows a successful re-authorization is the backend's decision.
 *
 * Managed accounts (Step 7G-H5): an ACTIVE Meta connection lists its persisted discovered Facebook Pages and Instagram
 * professional accounts (never a live Meta read) with what this workspace manages now, kept visibly apart from the
 * provider connection's own status: authorizing Meta manages nothing by itself. Nothing is preselected beyond what is
 * already managed, and nothing changes until Save posts the whole checked set.
 *
 * Capability re-check (Step 7G-H5.5-P2-B2): a managed account whose capabilities aren't evaluated, are out of date or
 * rest on facts that couldn't be read is offered ONE "Re-check capabilities" form posting the workspace and account
 * ids. The offer comes from the server read model and is UX only — the command decides again. A recent request shows
 * as a note without a button; current, newer-than-this-code or unmanaged accounts show nothing. Requested ≠ done.
 */
export default async function WorkspaceConnectionsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}) {
  const { workspaceId } = await params;
  const status = parseConnectStatus((await searchParams)["status"]);
  const state = await currentConnectionSettings(workspaceId);
  if (state.kind === "signed_out") redirect("/sign-in");

  return (
    <main>
      <h1>{t("connections.settings.heading")}</h1>

      {state.kind === "verification_required" ? <p role="status">{t("auth.status.verification_required")}</p> : null}
      {state.kind === "workspace_not_found" ? <p role="status">{t("connections.settings.workspace_not_found")}</p> : null}
      {state.kind === "not_allowed" ? <p role="status">{t("connections.settings.not_allowed")}</p> : null}
      {state.kind === "unavailable" ? <p role="status">{t("connections.settings.unavailable")}</p> : null}

      {state.kind === "ready" ? (
        <section>
          {status === undefined ? null : <p role="status">{t(CONNECT_STATUS_MESSAGES[status])}</p>}
          {state.connections.length === 0 ? <p>{t("connections.settings.empty")}</p> : null}
          <ul>
            {state.connections.map((connection) => (
              <li key={connection.id}>
                {t(CONNECTION_PROVIDER_MESSAGES[connection.provider])} · {t("connections.connection.provider_status", { status: t(CONNECTION_STATUS_MESSAGES[connection.status]) })}
                {connection.provider === "meta" && connection.status === "ACTIVE" ? (
                  <ManagedAccounts
                    workspaceId={state.workspaceId}
                    connectionId={connection.id}
                    assets={state.manageableAssets.filter((asset) => asset.connectionId === connection.id)}
                  />
                ) : null}
                {connection.provider === "meta" && connection.status !== "REMOVED" ? (
                  <form action={reconnectMetaConnectionAction}>
                    <input name="workspaceId" type="hidden" value={state.workspaceId} />
                    <input name="connectionId" type="hidden" value={connection.id} />
                    <p>{t("connections.reconnect.explainer")}</p>
                    <button type="submit">{t("connections.reconnect.submit")}</button>
                  </form>
                ) : null}
                {connection.provider === "meta" && connection.status !== "REMOVED" ? (
                  <form action={removeMetaConnectionAction}>
                    <input name="workspaceId" type="hidden" value={state.workspaceId} />
                    <input name="connectionId" type="hidden" value={connection.id} />
                    <label>
                      <input name="acknowledgement" type="checkbox" value={REMOVE_ACKNOWLEDGEMENT} required />
                      {t("connections.remove.acknowledge")}
                    </label>
                    <button type="submit">{t("connections.remove.submit")}</button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
          {state.metaConnect === "available" ? (
            <form action={startMetaConnectionAction}>
              <input name="workspaceId" type="hidden" value={state.workspaceId} />
              <button type="submit">{t("connections.meta.connect")}</button>
            </form>
          ) : (
            <p>{t("connections.meta.existing")}</p>
          )}
        </section>
      ) : null}
    </main>
  );
}

/** One ACTIVE Meta connection's managed accounts: the persisted state, and one form that saves the whole checked set. */
function ManagedAccounts({ workspaceId, connectionId, assets }: { readonly workspaceId: string; readonly connectionId: string; readonly assets: readonly ManageableAssetView[] }) {
  const selected = assets.filter((asset) => asset.managed).length;
  return (
    <section>
      <h2>{t("connections.accounts.heading")}</h2>
      {assets.length === 0 ? (
        <p>{t("connections.accounts.empty")}</p>
      ) : (
        <>
          <p>{t("connections.accounts.explainer")}</p>
          <p>{t("connections.accounts.summary", { selected: String(selected), available: String(assets.length) })}</p>
          {selected === 0 ? <p>{t("connections.accounts.none_selected")}</p> : null}
          {selected === assets.length ? <p>{t("connections.accounts.all_selected")}</p> : null}
          <form action={saveManagedAccountsAction}>
            <input name="workspaceId" type="hidden" value={workspaceId} />
            <input name="connectionId" type="hidden" value={connectionId} />
            <ul>
              {assets.map((asset) => (
                <li key={asset.discoveredAssetId}>
                  <label>
                    <input name="discoveredAssetId" type="checkbox" value={asset.discoveredAssetId} defaultChecked={asset.managed} />
                    {asset.displayName} · {t(ASSET_PLATFORM_MESSAGES[asset.platform])}
                  </label>
                </li>
              ))}
            </ul>
            <PendingSubmitButton label={t("connections.accounts.save")} pendingLabel={t("connections.accounts.saving")} />
          </form>
          <CapabilityRecheck workspaceId={workspaceId} assets={assets} />
        </>
      )}
    </section>
  );
}

/**
 * The managed accounts the read model offers a capability re-check for (or that were re-checked recently). One form
 * per offered account, outside the Save form; the button is disabled while its request is in flight.
 */
function CapabilityRecheck({ workspaceId, assets }: { readonly workspaceId: string; readonly assets: readonly ManageableAssetView[] }) {
  const rows = assets.filter((asset) => asset.connectedAccountId !== null && (asset.capabilityReevaluation?.allowed === true || asset.capabilityReevaluation?.reason === "REEVALUATION_TOO_SOON"));
  if (rows.length === 0) return null;
  return (
    <section>
      <h3>{t("connections.recheck.heading")}</h3>
      <p>{t("connections.recheck.explainer")}</p>
      <ul>
        {rows.map((asset) => {
          const offer = asset.capabilityReevaluation;
          if (offer === null || asset.connectedAccountId === null) return null;
          return (
            <li key={asset.connectedAccountId}>
              {asset.displayName} · {t(ASSET_PLATFORM_MESSAGES[asset.platform])}: {offer.allowed ? t(CAPABILITY_RECHECK_OFFER_MESSAGES[offer.reason]) : t(CAPABILITY_RECHECK_OFFER_MESSAGES.REEVALUATION_TOO_SOON)}
              {offer.allowed ? (
                <form action={requestCapabilityRecheckAction}>
                  <input name="workspaceId" type="hidden" value={workspaceId} />
                  <input name="connectedAccountId" type="hidden" value={asset.connectedAccountId} />
                  <PendingSubmitButton label={t("connections.recheck.submit")} pendingLabel={t("connections.recheck.submitting")} />
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
