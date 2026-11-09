import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { PLATFORM_DISPLAY_NAMES } from "@/domain/platforms";
import { textStyle } from "@/ui/foundations/typography";
import { Button, DataTag, Disclosure, Notice, OriginMark, StatePill, TextLink } from "@/ui/primitives";
import { AppShell } from "@/ui/shell/app-shell";
import styles from "./page.module.css";

/**
 * App shell reference (UI-3) — DEVELOPMENT ONLY, synthetic data. The shell around a synthetic workspace screen so it
 * can be reviewed in both themes and at every width without a session or a database: no read, no action (the account
 * menu holds an inert button). A 404 in every build that is not `next dev` (NODE_ENV is inlined at build time).
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "UI reference · shell", robots: { index: false, follow: false } };

const IS_DEVELOPMENT = process.env.NODE_ENV === "development";
const WS = "/dev/ui-reference/shell";

const ROWS = [
  { platform: "instagram" as const, paid: true, author: "@caro.m", content: "Cold brew launch", text: "Pedí el 2 de octubre y todavía no llega. ¿Alguien me puede responder?", read: "2 read", when: "08 OCT 23:14", kind: "Comment" },
  { platform: "facebook" as const, paid: false, author: "Marta P.", content: "Weekend hours", text: "¿Abren el domingo por la mañana? Quiero pasar con mi familia.", read: "1 read", when: "08 OCT 21:02", kind: "Comment" },
  { platform: "instagram" as const, paid: false, author: "Your account", content: "Cold brew launch", text: "Gracias por avisar, te escribimos por privado para revisar el pedido.", read: "3 read", when: "08 OCT 19:40", kind: "Reply" },
];

export default function ShellReferencePage() {
  if (!IS_DEVELOPMENT) notFound();
  return (
    <AppShell
      texts={{ brand: "wrenkind", skipToContent: "Skip to content", navigation: "Main navigation", workspace: "Workspace", workspaceUnavailable: "This workspace isn't available to you.", switchWorkspace: "Switch workspace", monitorOnly: "Monitor-only", account: "Account" }}
      workspace={{ name: "Lumen Coffee", organizationName: "Lumen Group", monitorOnly: false }}
      switcher={[
        { id: "a", name: "Lumen Coffee · Brasil", organizationName: "Lumen Group", href: WS },
        { id: "b", name: "Northwind Outdoor Supply Company", organizationName: "Northwind Agency", href: WS },
      ]}
      nav={[
        { key: "inbox", label: "Inbox", href: WS, icon: "nav-inbox", current: true },
        { key: "settings", label: "Settings", href: WS, icon: "nav-settings", current: false },
      ]}
      sidebar={{ heading: "Inbox", items: [{ label: "Conversations", href: WS, current: true }] }}
      account={
        <Button type="button" variant="secondary" size="sm">
          Sign out
        </Button>
      }
    >
      <main className={styles["screen"]}>
        <header className={styles["screenHeader"]}>
          <h1 className={textStyle("heading-2")}>Inbox</h1>
          <p className={`${textStyle("ui-body-s")} ${styles["muted"] ?? ""}`}>Newest activity first · synthetic data for the shell reference</p>
        </header>

        <Disclosure summary="What has been read" meta="as of 08 OCT 23:14">
          <div className={styles["coverage"]}>
            <div className={styles["coverageRow"]}>
              <OriginMark platform="instagram" name={PLATFORM_DISPLAY_NAMES.instagram} showName />
              <StatePill tone="success" icon="decision-approve">
                Comments complete
              </StatePill>
              <StatePill icon="estado-lock">Replies not available</StatePill>
            </div>
            <div className={styles["coverageRow"]}>
              <OriginMark platform="facebook" name={PLATFORM_DISPLAY_NAMES.facebook} showName />
              <StatePill tone="success" icon="decision-approve">
                Comments complete
              </StatePill>
              <StatePill tone="success" icon="decision-approve">
                Replies complete
              </StatePill>
            </div>
          </div>
        </Disclosure>

        <Notice tone="info" title="Not yet understood" toneLabel="Information">
          Labels and priority arrive with the next step. What you see here are observed facts.
        </Notice>

        <ol className={styles["list"]}>
          {ROWS.map((row, index) => (
            <li key={index} className={styles["row"]}>
              <div className={styles["rowMeta"]}>
                <OriginMark platform={row.platform} name={PLATFORM_DISPLAY_NAMES[row.platform]} paid={row.paid} paidLabel="Ad" />
                <DataTag>{row.paid ? "Paid" : "Organic"}</DataTag>
                <DataTag icon={row.kind === "Reply" ? "conv-reply" : "conv-comment"}>{row.kind}</DataTag>
                <StatePill>Open</StatePill>
              </div>
              <p className={textStyle("ui-body")}>{row.text}</p>
              <p className={`${textStyle("ui-body-s")} ${styles["muted"] ?? ""}`}>
                {row.author} · {row.content}
              </p>
              <div className={styles["rowMeta"]}>
                <DataTag mono>{row.read}</DataTag>
                <DataTag mono>{row.when}</DataTag>
                <TextLink href={WS}>Open conversation</TextLink>
              </div>
            </li>
          ))}
        </ol>
      </main>
    </AppShell>
  );
}
