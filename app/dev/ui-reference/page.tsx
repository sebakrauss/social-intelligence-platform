import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { PLATFORM_DISPLAY_NAMES } from "@/domain/platforms";
import { Logo } from "@/ui/brand/logo";
import { textStyle } from "@/ui/foundations/typography";
import { SEMANTIC_TOKENS, cssVariable } from "@/ui/foundations/tokens";
import { ICON_NAMES, Icon } from "@/ui/icons/icon";
import { Button, DataTag, Disclosure, Field, Notice, OriginMark, StatePill, TextLink } from "@/ui/primitives";
import styles from "./page.module.css";

/**
 * UI reference sheet (UI-2) — DEVELOPMENT ONLY. Renders the brand foundations and the product primitives with
 * synthetic labels so they can be reviewed in both themes (the theme follows the system preference: switch the OS
 * appearance, or emulate prefers-color-scheme in the browser). In any build that is not `next dev` the page is a
 * 404: NODE_ENV is inlined at build time, so the production bundle contains only the notFound() path. No data is
 * read, no action exists, nothing here is a product surface, and the texts are deliberately not in the message
 * catalog (they are not product copy).
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "UI reference", robots: { index: false, follow: false } };

const IS_DEVELOPMENT = process.env.NODE_ENV === "development";

export default function UiReferencePage() {
  if (!IS_DEVELOPMENT) notFound();
  return (
    <main className={styles["page"]}>
      <header className={styles["header"]}>
        <span className={styles["logo"]}>
          <Logo variant="lockup" title="wrenkind" />
        </span>
        <h1 className={textStyle("heading-2")}>UI reference</h1>
        <p className={`${textStyle("ui-body")} ${styles["lead"] ?? ""}`}>
          Development-only sheet of the UI-1 foundations and the UI-2 primitives with synthetic labels. Black as the base, white to read, blue only where a person decides, for links and for focus.
        </p>
      </header>

      <Section title="Type scale">
        <div className={styles["stack"]}>
          <p className={textStyle("display-l")}>Every conversation counts.</p>
          <p className={textStyle("heading-1")}>The human side of intelligence.</p>
          <p className={textStyle("heading-2")}>Inbox · Lumen Coffee</p>
          <p className={textStyle("heading-3")}>Drivers of negative feedback</p>
          <p className={textStyle("body-l")}>One place to manage, understand and learn from conversations. Tu equipo decide. Seu time decide.</p>
          <p className={textStyle("ui-body")}>Pedí el 2 de octubre y todavía no llega. ¿Alguien me puede responder?</p>
          <p className={textStyle("ui-body-s")}>O preço subiu de novo? Achei caro demais · Complaint · Price</p>
          <p className={textStyle("ui-label")}>Approve reply · Assign · Needs review</p>
          <p className={textStyle("ui-caption")}>Suggested by AI · edit before sending</p>
          <p className={textStyle("mono")}>P1 · SLA 2h 10m · 41% · #A-20931</p>
          <p className={textStyle("mono-s")}>P2 · 12 MIN · 08 OCT 23:14</p>
        </div>
      </Section>

      <Section title="Semantic tokens" caption="Each swatch is painted by its CSS variable; the value follows the current theme.">
        <div className={styles["swatches"]}>
          {SEMANTIC_TOKENS.map((token) => (
            <div key={token} className={styles["swatch"]}>
              <div className={styles["swatchColor"]} style={{ background: `var(${cssVariable(token)})` }} />
              <span className={`${textStyle("mono-s")} ${styles["swatchName"] ?? ""}`}>{token}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Icons" caption="42 kit icons at 20px; only Persona carries the blue dot.">
        <div className={styles["row"]}>
          {ICON_NAMES.map((name) => (
            <Icon key={name} name={name} size={20} label={name} />
          ))}
        </div>
      </Section>

      <Section title="Button" caption="Primary is neutral (never blue). Hover, focus and active are live: use the mouse and Tab.">
        <div className={styles["grid"]}>
          <Card title="Variants">
            <div className={styles["row"]}>
              <Button variant="primary">Save changes</Button>
              <Button variant="secondary">Cancel</Button>
              <Button variant="ghost">More</Button>
            </div>
          </Card>
          <Card title="With icon · small">
            <div className={styles["row"]}>
              <Button variant="primary" icon="util-plus">
                Add account
              </Button>
              <Button variant="secondary" icon="util-filter" size="sm">
                Filter
              </Button>
              <Button variant="ghost" icon="util-search" size="sm">
                Search
              </Button>
            </div>
          </Card>
          <Card title="Disabled · pending">
            <div className={styles["row"]}>
              <Button variant="primary" disabled>
                Save changes
              </Button>
              <Button variant="secondary" disabled>
                Cancel
              </Button>
              <Button variant="primary" pending pendingLabel="Saving…">
                Save changes
              </Button>
            </div>
          </Card>
        </div>
      </Section>

      <Section title="Text link">
        <div className={styles["grid"]}>
          <Card title="Inline">
            <p className={textStyle("ui-body")}>
              Coverage is explained in <TextLink href="#type-scale">the connections page</TextLink>, and the full thread opens in{" "}
              <TextLink href="#type-scale" quiet>
                the conversation
              </TextLink>
              .
            </p>
          </Card>
          <Card title="External">
            <p className={textStyle("ui-body")}>
              <TextLink href="https://example.test/post/1" external externalLabel="opens in a new tab">
                Open on the platform
              </TextLink>
            </p>
          </Card>
        </div>
      </Section>

      <Section title="Field">
        <div className={styles["grid"]}>
          <Card title="Default · help">
            <Field id="ref-email" name="email" label="Email" type="email" help="We only use it to sign you in." autoComplete="email" placeholder="you@company.com" />
          </Card>
          <Card title="Required · error">
            <Field id="ref-name" name="name" label="Workspace name" required defaultValue="Lumen" error="Choose a name that is not already in use." />
          </Card>
          <Card title="Disabled · multiline">
            <div className={styles["stack"]}>
              <Field id="ref-disabled" name="disabled" label="Connected account" defaultValue="Lumen Coffee (Instagram)" disabled />
              <Field id="ref-note" name="note" label="Internal note" multiline rows={3} help="Visible to your workspace only." />
            </div>
          </Card>
        </div>
      </Section>

      <Section title="Notice" caption="Each tone has its own icon; information uses the surface and grey.">
        <div className={styles["stack"]}>
          <Notice tone="info" title="Not yet understood" toneLabel="Information">
            Labels and priority arrive with the next step. What you see here are observed facts.
          </Notice>
          <Notice tone="success" title="Replied" toneLabel="Success">
            Your reply was published on Instagram.
          </Notice>
          <Notice tone="warning" title="Review spam" toneLabel="Warning">
            This looks like spam. A person decides whether to hide it.
          </Notice>
          <Notice tone="danger" title="Couldn't sync" toneLabel="Error" live="assertive">
            The Facebook connection needs attention. Nothing new was read since 08 Oct 23:14.
          </Notice>
        </div>
      </Section>

      <Section title="Disclosure" caption="Native details/summary: keyboard-operable, no JavaScript.">
        <div className={styles["stack"]}>
          <Disclosure summary="Earlier versions of this text" meta="3">
            <p className={textStyle("ui-body")}>Three earlier versions were kept. The most recent is shown first.</p>
          </Disclosure>
          <Disclosure summary="What has been read" open>
            <p className={textStyle("ui-body")}>Comments: complete up to 08 Oct 23:14. Replies: not available for this account.</p>
          </Disclosure>
        </div>
      </Section>

      <Section title="State pill" caption="Round is state. Human is the only blue; the dot or icon always accompanies the text.">
        <div className={styles["row"]}>
          <StatePill>Open</StatePill>
          <StatePill tone="neutral" icon="decision-approve">
            Done
          </StatePill>
          <StatePill tone="human">Needs review</StatePill>
          <StatePill tone="human" icon="decision-human">
            Assigned to you
          </StatePill>
          <StatePill tone="success" icon="decision-approve">
            Replied
          </StatePill>
          <StatePill tone="warning" icon="estado-spam">
            Review spam
          </StatePill>
          <StatePill tone="danger" icon="estado-sync">
            Couldn&apos;t sync
          </StatePill>
        </div>
      </Section>

      <Section title="Data tag" caption="Square is data: border only. Positive and negative are the manual's sentiment tones (not used by any surface yet).">
        <div className={styles["row"]}>
          <DataTag>Organic</DataTag>
          <DataTag>Paid</DataTag>
          <DataTag icon="conv-post">Post</DataTag>
          <DataTag icon="conv-reply">Reply</DataTag>
          <DataTag icon="estado-lock">Hidden</DataTag>
          <DataTag mono>12 read</DataTag>
          <DataTag mono>08 OCT 23:14</DataTag>
          <DataTag tone="positive" icon="sentimiento-pos">
            Positive
          </DataTag>
          <DataTag tone="negative" icon="sentimiento-neg">
            Negative
          </DataTag>
        </div>
      </Section>

      <Section title="Origin mark" caption="Own monograms, no third-party logos. AD marks paid content by shape and fill.">
        <div className={styles["grid"]}>
          <Card title="Monogram only (name for screen readers)">
            <div className={styles["row"]}>
              <OriginMark platform="instagram" name={PLATFORM_DISPLAY_NAMES.instagram} />
              <OriginMark platform="facebook" name={PLATFORM_DISPLAY_NAMES.facebook} />
              <OriginMark platform="tiktok" name={PLATFORM_DISPLAY_NAMES.tiktok} />
              <OriginMark platform="unknown" name="Unknown platform" />
            </div>
          </Card>
          <Card title="With name · paid">
            <div className={styles["stack"]}>
              <OriginMark platform="instagram" name={PLATFORM_DISPLAY_NAMES.instagram} showName />
              <OriginMark platform="facebook" name={PLATFORM_DISPLAY_NAMES.facebook} showName paid paidLabel="Ad" />
              <OriginMark platform="instagram" name={PLATFORM_DISPLAY_NAMES.instagram} paid paidLabel="Ad" />
            </div>
          </Card>
        </div>
      </Section>

      <Section title="In context" caption="One synthetic inbox row built only from the primitives above (not the Inbox design).">
        <div className={styles["card"]}>
          <div className={styles["row"]}>
            <OriginMark platform="instagram" name={PLATFORM_DISPLAY_NAMES.instagram} paid paidLabel="Ad" />
            <DataTag>Paid</DataTag>
            <DataTag icon="conv-comment">Comment</DataTag>
            <StatePill>Open</StatePill>
          </div>
          <p className={textStyle("ui-body")}>Pedí el 2 de octubre y todavía no llega. ¿Alguien me puede responder?</p>
          <p className={`${textStyle("ui-body-s")} ${styles["caption"] ?? ""}`}>@caro.m · Cold brew launch</p>
          <div className={styles["row"]}>
            <DataTag mono>2 read</DataTag>
            <DataTag mono>08 OCT 23:14</DataTag>
            <TextLink href="#type-scale">Open conversation</TextLink>
          </div>
        </div>
      </Section>
    </main>
  );
}

function Section({ title, caption, children }: { readonly title: string; readonly caption?: string; readonly children: React.ReactNode }) {
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    <section className={styles["section"]} aria-labelledby={id}>
      <h2 id={id} className={textStyle("heading-3")}>
        {title}
      </h2>
      {caption === undefined ? null : <p className={`${textStyle("ui-body-s")} ${styles["caption"] ?? ""}`}>{caption}</p>}
      {children}
    </section>
  );
}

function Card({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <div className={styles["card"]}>
      <p className={textStyle("ui-label")}>{title}</p>
      {children}
    </div>
  );
}
