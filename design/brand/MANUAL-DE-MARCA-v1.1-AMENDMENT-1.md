# Manual de Marca v1.1 — Amendment 1: Direction C "Refined Brand"

**Status:** APPROVED by the Product Owner, 2026-11-17 (Step 7B-17V-VISUAL-DIRECTION-C, implemented in 7B-17V-VISUAL-IMPLEMENT).
**Amends:** Manual de Marca v1.1 (brand kit `wrenkind-brand-kit-v1.1.zip`, approved 2026-10-09), as recorded in the product by
`ui/foundations/tokens.ts` / `tokens.css`.
**Scope:** four decisions (A–D below). Every rule not named here is unchanged.
**Visual reference:** the Direction C review (local, outside the repository): `~/Downloads/wrenkind-7b17v-direction-c/index.html`.

The master manual and kit live outside this repository (brand hand-off). They are **not** edited by this amendment. The
brand owner should fold it into the next kit version (v1.2), after which `tokens.ts` cites that kit instead of this file.

## Traceability — what changes

| Manual v1.1 rule (section) | Amended rule |
|---|---|
| "Dónde aparece el azul": the logo's dot; where a person decides; links and keyboard focus — "nunca en botones, fondos grandes ni íconos decorativos" | **Decision A.** Also: **active navigation** (the active rail section and sidebar view) and **the selected conversation** (a soft blue surface with a 3 px Electric Blue indicator). **Decision B.** Also: a **2 px accent on the brand's own replies** and their Persona mark. Still never: buttons (the primary action stays ink), large backgrounds, decorative icons, status colors, labels. |
| "Cada color con su nombre…" (§3 semantic tokens): canvas, surface, raised, hover | **Decision C.** New surface roles, all existing palette values: `bg.app` (the canvas behind navigation and work), `bg.content` (where items are listed), `bg.reading` (where one conversation is read), `bg.elevated-hover` (hover and soft fills on an elevated surface: content, reading, raised). Existing tokens keep their values. |
| "Reglas que no se negocian": 3:1 for "íconos y bordes que comunican algo" | **Decision D.** A text field's boundary is `border.input`, measured ≥ 3:1 against every surface a field can sit on or be filled with (WCAG 2.2 SC 1.4.11). `border.strong` (1.40:1 Light, 1.82:1 Dark against the canvas) is no longer used for field boundaries. |
| Depth: a surface step and a 1 px divider, never a shadow | Unchanged. Direction C adds surface steps, not shadows or gradients. |

## New semantic roles (Light · Dark)

| Token | Light | Dark | Role |
|---|---|---|---|
| `bg.app` | Neutral 50 `#F4F4F4` | Neutral 900 `#141414` | Application canvas; navigation sits on it |
| `bg.content` | Neutral 0 `#FFFFFF` | Neutral 850 `#1A1A1A` | Content sheet: lists, main content, cards on the reading surface |
| `bg.reading` | Neutral 25 `#FAFAFA` | `#1F1F1F` (the approved `bg.hover` value) | Reading surface of an open conversation or detail panel |
| `bg.elevated-hover` | Neutral 50 `#F4F4F4` | Neutral 950 `#0A0A0A` | Hover and soft fills on an elevated surface (content, reading, raised). Dark goes *down* to the canvas black: no lighter palette step keeps `text.tertiary` at 4.5:1 (`#262626` gives 4.38:1) |
| `border.input` | Neutral 500 `#7A7A7A` | Neutral 500 `#7A7A7A` | Text-field boundary |
| `selection.bg` | Blue 50 `#EEF3FF` | `#141C33` (the approved `human.bg` value) | Selected conversation, active sidebar view |
| `selection.fg` | Blue 700 `#2446B0` | Blue 200 `#B9CCFF` | Text and icon of the active navigation item |
| `selection.indicator` | Blue 500 `#4C7DFF` | Blue 400 `#6E95FF` | The 3 px indicator of the selected conversation |
| `accent.brand-reply` | Blue 500 `#4C7DFF` | Blue 400 `#6E95FF` | The 2 px accent and Persona mark of the brand's own replies |

No value outside the approved neutral and blue scales and the existing semantic values is introduced
(`tests/unit/ui/tokens.test.ts`, block "Amendment 1").

### Measured contrast (WCAG 2.x)

Measured with `contrastRatio` from `ui/foundations/tokens.ts`.

| Pair | Light | Dark | Minimum |
|---|---|---|---|
| `text.primary` on `bg.app` / `bg.content` / `bg.reading` / `selection.bg` | 18.00 / 19.80 / 18.97 / 17.82 | 17.65 / 16.67 / 15.79 / 16.18 | 4.5 |
| `text.secondary` on the same four | 6.08 / 6.69 / 6.41 / 6.02 | 7.30 / 6.90 / 6.53 / 6.69 | 4.5 |
| `text.tertiary` on the same four | 4.64 / 5.10 / 4.89 / 4.59 | 5.34 / 5.04 / 4.77 / 4.89 | 4.5 |
| `text.tertiary` on `bg.elevated-hover` | 4.64 | 5.73 | 4.5 |
| `selection.fg` on `selection.bg` / `bg.content` | 7.33 / 8.15 | 10.57 / 10.89 | 4.5 |
| `selection.indicator` on `selection.bg` / `bg.content` | 3.32 / 3.69 | 5.96 / 6.14 | 3 |
| `accent.brand-reply` on `bg.content` / `bg.reading` | 3.69 / 3.54 | 6.14 / 5.81 | 3 |
| `border.input` on canvas / app / content / reading / raised / surface | 4.29 / 3.90 / 4.29 / 4.11 / 4.29 / 4.11 | 4.61 / 4.29 / 4.05 / 3.84 / 4.05 / 4.29 | 3 |
| `interactive.focus` on `bg.reading` / `selection.bg` / `bg.app` | 5.53 / 5.19 / 5.25 | 5.81 / 5.96 / 6.50 | 3 |
| `interactive.link` on `bg.reading` / `bg.app` | 5.53 / 5.25 | 7.29 / 8.15 | 4.5 |
| `danger.fg` / `warning.fg` / `success.fg` on `bg.reading` | 5.32 / 5.68 / 5.20 | 5.90 / 8.08 / 7.88 | 4.5 |
| Old field boundary `border.strong` on the canvas (replaced) | 1.40 | 1.82 | 3 |

Every pair is enforced by `CONTRAST_REQUIREMENTS` in `ui/foundations/tokens.ts`.

### Hover on elevated surfaces (Fix 1, 7B-17V-VISUAL-FIX)

`bg.hover` was tuned for the old black canvas. On the Dark elevated surfaces it is barely perceptible
(ΔL* 2.5 on `#1A1A1A`) or identical (`#1F1F1F` reading surface). Rule: an elevated surface's **root selector**
re-points `--wk-bg-hover` to `bg.elevated-hover`, so every hover inside it (rows, ghost buttons, disclosures, menus)
is perceptible: Dark ΔL* 6.5 on content, 9.0 on reading, 3.6 on `bg.surface` controls (the old Dark hover on the black
canvas was 9.0). A secondary button, itself a raised surface, always hovers with `bg.elevated-hover`. Navigation on
`bg.app` hovers with `bg.content` and is never re-pointed. This is the only token re-declaration allowed outside
`tokens.css`, and only at the roots listed in `tests/architecture/brand-guards.test.ts`. Hover fills are not held to
WCAG 1.4.11 (not required to identify a control); their perceptibility is tested as a CIE L* difference.

Light keeps its long-standing hover (`#F4F4F4`): ΔL* 3.8 on white; 2.1 on the `#FAFAFA` reading surface, where no
darker palette step keeps `text.tertiary` at 4.5:1 (`#EBEBEB` gives 4.28:1).

### Active navigation shape (Fix 1)

The active rail item is a content tile in the selection color **and** a 3 px `selection.indicator` bar (left edge;
top edge where the rail is a bottom bar on phones), so it is distinguishable from a hovered item without relying on
color alone. The active sidebar item is the selection surface in heavier type.

## Meaning — selection is not labels, classification or urgency

- **Selection** (`selection.*`) says *where you are*: the active section, view or conversation. It never means urgency,
  priority, an AI classification or a moderation outcome.
- **Manual labels** are a person's own tags: neutral square chips, never blue.
- **AI classification** (when it exists) and **priority** keep their own manual forms: square data boxes, priority with
  P1/P2 text and signal bars; never the selection blue.
- **Status** keeps green / amber / red with icon and text; status never uses blue (unchanged).
- The **brand-reply accent** marks who wrote a reply (the brand's own account), not whether it worked; its state stays a
  status pill.

`tests/architecture/brand-guards.test.ts` ("Manual v1.1 Amendment 1") pins where these tokens may appear, that no label,
assessment, priority, status or tag rule uses them, and that field boundaries use `border.input`.

## Unchanged

Palette values; typefaces (Outfit, Inter, JetBrains Mono); the primary action in ink (white in Dark); links and focus
ring in blue; the logo's dot; radii and spacing; no shadows or gradients; status colors; label and data-box shapes.
