import { redirect } from "next/navigation";
import { removeMetaConnectionAction, startMetaConnectionAction } from "@/server/connections/actions";
import {
  CONNECTION_PROVIDER_MESSAGES,
  CONNECTION_STATUS_MESSAGES,
  CONNECT_STATUS_MESSAGES,
  REMOVE_ACKNOWLEDGEMENT,
  parseConnectStatus,
} from "@/server/connections/settings";
import { currentConnectionSettings } from "@/server/connections/settings-runtime";
import { t } from "@/server/i18n";

/** Connection state is per request: never prerender it. */
export const dynamic = "force-dynamic";

/**
 * Workspace Settings › Connections (Step 7G-F4; IA §18: Owner/Admin). Rendering only reads (connections.settings.view);
 * Connect Meta is one form posting the workspace id to a server action. Whether that button shows is UX only — the
 * atomic start decides. A Meta connection that isn't REMOVED (including a FAILED or DISCONNECTED one) blocks a fresh
 * connect; each has an inline Remove form (Step 7G-F4C) with a visible acknowledgement — a LOCAL removal that does not
 * revoke anything inside Meta. REMOVED ones show their status only. No reconnect here. Minimal and utilitarian.
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
                {t(CONNECTION_PROVIDER_MESSAGES[connection.provider])} · {t(CONNECTION_STATUS_MESSAGES[connection.status])}
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
