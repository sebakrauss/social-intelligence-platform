/**
 * App shell (UI-3; IA §4 shell elements, manual §5 product grid). Presentational and server-rendered: it draws the
 * rail, the sidebar and the content area around the current screen from data the composition gives it. It decides
 * nothing: every destination it shows was already authorized upstream, every text arrives translated, the account
 * menu's content (the sign-out form) is passed in. Native elements only — links, lists, <details> for the two menus —
 * so the shell works without JavaScript and announces itself: a skip link, named navigation landmarks, aria-current
 * on the active destination.
 *
 * What is deliberately absent: a logo in the rail (the manual keeps the Loop for favicon, app and avatar; the product
 * sidebar carries the wordmark), decorative items, and any destination that does not exist yet. The account menu uses
 * the kit's neutral "more" glyph: the blue dot of Persona stays for where a person decides. On phones the sidebar is
 * one compact row (wordmark · workspace · switcher) and a contextual list whose only entry is the current section is
 * not repeated under the page title.
 */
import type { ReactNode } from "react";
import { Logo } from "@/ui/brand/logo";
import { Icon, type IconName } from "@/ui/icons/icon";
import { StatePill } from "@/ui/primitives/state-pill";
import styles from "./app-shell.module.css";

export interface ShellNavItem {
  readonly key: string;
  readonly label: string;
  readonly href: string;
  readonly icon: IconName;
  readonly current: boolean;
}

export interface ShellSidebarItem {
  readonly label: string;
  readonly href: string;
  readonly current: boolean;
}

export interface ShellWorkspaceView {
  readonly name: string;
  readonly organizationName: string;
  readonly monitorOnly: boolean;
}

/** Another workspace of the caller; `href` is absent when no built destination exists for their role there. */
export interface ShellSwitcherItem {
  readonly id: string;
  readonly name: string;
  readonly organizationName: string;
  readonly href: string | undefined;
}

export interface ShellTexts {
  readonly brand: string;
  readonly skipToContent: string;
  readonly navigation: string;
  readonly workspace: string;
  readonly workspaceUnavailable: string;
  readonly switchWorkspace: string;
  readonly monitorOnly: string;
  readonly account: string;
}

export interface AppShellProps {
  readonly texts: ShellTexts;
  readonly workspace: ShellWorkspaceView | undefined;
  readonly switcher: readonly ShellSwitcherItem[];
  readonly nav: readonly ShellNavItem[];
  readonly sidebar: { readonly heading: string; readonly items: readonly ShellSidebarItem[] } | undefined;
  /** The account menu's content (already composed: the sign-out form). */
  readonly account: ReactNode;
  /** Reserved 360px detail panel; nothing renders it yet. */
  readonly panel?: ReactNode;
  readonly children: ReactNode;
}

const CONTENT_ID = "content";

export function AppShell({ texts, workspace, switcher, nav, sidebar, account, panel, children }: AppShellProps) {
  const hasPanel = panel !== undefined && panel !== null;
  return (
    <div className={hasPanel ? `${styles["shell"] ?? ""} ${styles["withPanel"] ?? ""}` : styles["shell"]}>
      <a href={`#${CONTENT_ID}`} className={styles["skip"]}>
        {texts.skipToContent}
      </a>

      <header className={styles["rail"]}>
        {nav.length === 0 ? null : (
          <nav className={styles["railNav"]} aria-label={texts.navigation}>
            <ul className={styles["railList"]}>
              {nav.map((item) => (
                <li key={item.key}>
                  <a href={item.href} className={styles["railItem"]} {...(item.current ? { "aria-current": "page" } : {})}>
                    <Icon name={item.icon} size={20} />
                    <span>{item.label}</span>
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div className={styles["railBottom"]}>
          <details className={styles["account"]}>
            <summary className={styles["accountSummary"]}>
              <Icon name="util-more" size={20} />
              <span>{texts.account}</span>
            </summary>
            <div className={styles["accountMenu"]}>
              <p className={styles["accountMenuLabel"]}>{texts.account}</p>
              {account}
            </div>
          </details>
        </div>
      </header>

      <aside className={styles["sidebar"]} aria-label={texts.workspace}>
        <div className={styles["brand"]}>
          <Logo variant="wordmark" title={texts.brand} />
        </div>

        <div className={styles["workspace"]}>
          <p className={styles["workspaceLabel"]}>{texts.workspace}</p>
          {workspace === undefined ? (
            <p className={styles["workspaceOrganization"]}>{texts.workspaceUnavailable}</p>
          ) : (
            <>
              <p className={styles["workspaceName"]}>{workspace.name}</p>
              <p className={styles["workspaceOrganization"]}>{workspace.organizationName}</p>
              {workspace.monitorOnly ? (
                <div className={styles["workspaceMode"]}>
                  <StatePill icon="estado-lock">{texts.monitorOnly}</StatePill>
                </div>
              ) : null}
            </>
          )}
          {switcher.length === 0 ? null : (
            <details className={styles["switcher"]}>
              <summary className={styles["switcherSummary"]}>
                <Icon name="nav-workspaces" size={16} />
                <span className={styles["switcherText"]}>{texts.switchWorkspace}</span>
              </summary>
              <ul className={styles["switcherList"]}>
                {switcher.map((item) => (
                  <li key={item.id}>
                    {item.href === undefined ? (
                      <span className={styles["switcherItem"]}>
                        {item.name}
                        <span className={styles["switcherItemOrganization"]}>{item.organizationName}</span>
                      </span>
                    ) : (
                      <a href={item.href} className={styles["switcherItem"]}>
                        {item.name}
                        <span className={styles["switcherItemOrganization"]}>{item.organizationName}</span>
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>

        {sidebar === undefined || sidebar.items.length === 0 ? null : (
          <nav
            className={sidebar.items.length === 1 && sidebar.items[0]?.current === true ? `${styles["sideNav"] ?? ""} ${styles["sideNavCurrentOnly"] ?? ""}` : styles["sideNav"]}
            aria-label={sidebar.heading}
          >
            <p className={styles["sideHeading"]}>{sidebar.heading}</p>
            <ul className={styles["sideList"]}>
              {sidebar.items.map((item) => (
                <li key={item.href}>
                  <a href={item.href} className={styles["sideItem"]} {...(item.current ? { "aria-current": "page" } : {})}>
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </aside>

      <div id={CONTENT_ID} className={styles["main"]} tabIndex={-1}>
        {children}
      </div>

      {hasPanel ? <aside className={styles["panel"]}>{panel}</aside> : null}
    </div>
  );
}
