# Manual de Marca v1.1 — Amendment 2: Label markers

**Status:** APPROVED by the Product Owner, 2026-11-18 (Step COMMENTS UX-06-LABEL-PALETTE; implemented in UX-06-IMPLEMENT).
**Amends:** Manual de Marca v1.1 (brand kit `wrenkind-brand-kit-v1.1.zip`, approved 2026-10-09), as already amended by
[Amendment 1](MANUAL-DE-MARCA-v1.1-AMENDMENT-1.md). Recorded in the product by `ui/foundations/tokens.ts` / `tokens.css`.
**Scope:** one addition: an organizational color family for the manual-label marker. Every rule not named here is unchanged.
**Visual reference:** the palette review (local, outside the repository): `~/Downloads/wrenkind-comments-ux06-label-palette/index.html`.

The master manual and kit live outside this repository (brand hand-off). They are **not** edited by this amendment. The
brand owner should fold it into the next kit version (v1.2), together with Amendment 1.

## Traceability — what changes

| Manual v1.1 rule (section) | Amended rule |
|---|---|
| §2 "Una escala de grises, un azul y tres estados" | A fifth family is added: **label markers**, an organizational palette used **only** to fill the manual-label marker. Neutrals, the blue and the three states are unchanged. |
| §7 "Redondo es estado, cuadrado es dato" | Unchanged. A manual label stays a neutral square chip (4 px radius) with its name; only the small solid tag inside it carries the label's color. |
| Amendment 1 "Manual labels are a person's own tags: neutral square chips, never blue" | Unchanged and still true: the chip is neutral and never blue. The marker inside it may now carry one of the colors below. |

## The marker

One compact **solid tag** (14 × 10 px, the "Gmail-style" label shape), the same everywhere a manual label appears:
the Comments sidebar, conversation rows, comment chips, the assign-label picker, label creation and Settings › Labels.
Never a round dot (round is state).

## The palette (Light · Dark)

| Token | Name | Light | Dark |
|---|---|---|---|
| `label.gray` | Gray — **the default** | Neutral 500 `#7A7A7A` | Neutral 500 `#7A7A7A` |
| `label.teal` | Teal | `#0F7A7A` | `#3DB3B0` |
| `label.plum` | Plum | `#9A3FA8` | `#CF8ADB` |
| `label.magenta` | Magenta | `#B53A6E` | `#E8799F` |
| `label.olive` | Olive | `#5F6E1E` | `#A9B65C` |

Gray uses one value in both themes. Each color has its own Light and Dark value: one value for both themes would fall
under 3:1 in one of them. **Brown** (proposed in UX-03) is **rejected**: it was the only candidate under 15 ΔE00 from a
status color (13.8 from Light `warning`), the closest to the gray default at marker size, and nearly merged with olive
under deuteranopia.

## Usage rules

- **Organizational only.** A label's color helps people recognize a label. It never means status, attention, urgency,
  sentiment, priority, an AI classification (Intelligence), selection or who wrote a reply.
- **Only the marker.** The color fills the tag and nothing else: never a chip background, text, border, row, icon or
  status. The chip stays neutral (`bg.app` fill, `text.primary` name).
- **Never alone.** The label's name is always written beside the marker; color is never the only way to tell labels apart.
- **Workspace labels own it.** A color belongs to a workspace label, not to a comment: changing it changes every
  appearance at once; resetting returns it to gray. Products store the palette **identifier**, never a color value, and
  draw it through the theme token.
- **Who chooses.** Whoever manages labels (the proposed `labels.manage`: Owner, Admin, Manager). Everyone who sees
  labels sees their colors.
- **No other color.** Only these five. No custom colors, no hex input.

## Measured contrast (WCAG 2.x; a non-text mark: minimum 3:1, SC 1.4.11)

Measured with `contrastRatio` from `ui/foundations/tokens.ts`. Surfaces are those a marker is drawn on: sidebar and chip
(`bg.app`), rows and Settings (`bg.content`), the reading pane (`bg.reading`), the picker (`bg.raised` — same values as
`bg.content`), a selected row (`selection.bg`), a hovered row (`bg.elevated-hover`).

| Marker | Light: app / content / reading / selection / hover | Dark: app / content / reading / selection / hover |
|---|---|---|
| Gray | 3.90 / 4.29 / 4.11 / 3.86 / 3.90 | 4.29 / 4.05 / 3.84 / 3.93 / 4.61 |
| Teal | 4.67 / 5.14 / 4.93 / 4.63 / 4.67 | 7.26 / 6.86 / 6.49 / 6.65 / 7.80 |
| Plum | 5.23 / 5.75 / 5.51 / 5.18 / 5.23 | 7.29 / 6.89 / 6.52 / 6.68 / 7.84 |
| Magenta | 5.03 / 5.53 / 5.30 / 4.98 / 5.03 | 6.73 / 6.35 / 6.02 / 6.16 / 7.23 |
| Olive | 5.11 / 5.62 / 5.39 / 5.06 / 5.11 | 8.36 / 7.90 / 7.48 / 7.67 / 8.99 |

Every pair is enforced by `CONTRAST_REQUIREMENTS` in `ui/foundations/tokens.ts`.

Distinctness (CIEDE2000): the closest pair is plum · magenta (15.8 Light, 15.3 Dark); the closest to a status color is
magenta · `danger` in Dark (18.1). Under simulated color-vision deficiencies some pairs come close (gray · teal under
protanopia, gray · magenta under deuteranopia, Light); the always-written name is the answer, not more colors.

## Enforcement

- `ui/foundations/tokens.ts` / `tokens.css`: the five tokens (`--wk-label-gray`, `--wk-label-teal`, `--wk-label-plum`,
  `--wk-label-magenta`, `--wk-label-olive`), declared only there, in the light block and both dark blocks.
- `tests/unit/ui/tokens.test.ts` ("Amendment 2"): exact values, gray = Neutral 500, no brown, 3:1 on every marker
  surface, no reuse of a blue, status, selection, link or text value.
- `tests/architecture/brand-guards.test.ts` ("Manual v1.1 Amendment 2"): the label tokens are referenced only by the
  token file and the marker's stylesheet; only `.marker[data-marker="…"]` rules use them, each as `color:` for its own
  identifier, filling the tag through `currentColor`; no chip, row label, picker or sidebar rule uses them.

## Unchanged

Every other color, the blue's roles, status colors, surfaces, type, radii, spacing, depth, the label chip's shape, and
the rule that no hex appears outside the token files.
