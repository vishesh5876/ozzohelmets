# Design system: warm cream, coffee ink, one orange

The UI follows a Zapier-style system: a warm-cream canvas, deep coffee-ink text and a single
saturated orange for conversion. Every neutral carries warmth; there is no cool grey and no pure
black or white. Tokens live in `packages/ui/src/styles/theme.css` (Tailwind v4 `@theme`) and are
shared by the admin console and the customer portal; the standalone emergency page mirrors them
in `apps/portal/src/emergency/emergency.css`.

## Key characteristics

- **One accent.** `primary` `#ff4f00` is reserved for primary CTAs and active indicators
  (selected nav row, focus ring, selection).
- **Warm canvas.** `canvas` `#fffefb`, never `#ffffff`. The temperature is the brand voice.
- **Coffee ink.** `ink` `#201515`, never `#000000`. Dark bands, the footer and dark cards use ink.
- **Middle radius.** 12 px (`rounded-md`) for buttons and cards; 6 px (`rounded-sm`) for inputs;
  pill only for badges, status chips, progress bars and toggles.
- **Two faces.** Display headlines at weight 500 (Degular Display in the brand spec; Inter 500
  is the substitute we ship); Inter for everything else.

## Colour tokens

| Token               | Value                 | Use                                               |
| ------------------- | --------------------- | ------------------------------------------------- |
| `primary`           | `#ff4f00`             | Primary CTA fill, active indicator, focus ring    |
| `primary-hover`     | `#e64700`             | Primary CTA hover                                 |
| `on-primary`        | `#fffefb`             | Text on orange / on dark                          |
| `canvas`            | `#fffefb`             | Page background                                   |
| `canvas-soft`       | `#f8f4f0`             | Soft cards, inset regions, subtle buttons, badges |
| `canvas-softer`     | `#fbf8f4`             | Muted badges, hover on outline buttons            |
| `surface-pressed`   | `#efe9e2`             | Pressed / hover fill for soft controls            |
| `hairline`          | `#e6e0d6`             | Card borders, table rules                         |
| `ink`               | `#201515`             | Headings, primary text, dark bands, dark buttons  |
| `ink-soft`          | `#2f2a26`             | Dark button hover, elevated dark surfaces         |
| `ink-mid`           | `#36342e`             | Mid-emphasis text                                 |
| `body`              | `#605d52`             | Default secondary text                            |
| `body-mid`          | `#939084`             | Metadata, placeholders                            |
| `mute`              | `#c5c0b1`             | Lowest-priority text, disabled states             |
| `danger` / `-soft`  | `#b42318` / `#fdecea` | Safety states only (see below)                    |
| `success` / `-soft` | `#0e7a3e` / `#e7f5ec` | Safety states only                                |

**Deliberate exception.** The brand spec has no semantic palette. This is a safety product: lost /
stolen helmets, failed activations and destructive confirmations must read as errors at a
glance, so `danger` and `success` stay. They are never used decoratively.

## Typography

| Tailwind class     | Size / line height | Weight | Use                             |
| ------------------ | ------------------ | ------ | ------------------------------- |
| `text-display-xxl` | 56 / 56            | 500    | Hero headline                   |
| `text-display-xl`  | 48 / 48            | 500    | Sub-hero                        |
| `text-display-lg`  | 32 / 36            | 500    | Page titles, section displays   |
| `text-display-md`  | 24 / 30            | 600    | Card titles, mobile page titles |
| `text-display-sm`  | 20 / 25            | 600    | Card titles (`CardTitle`)       |
| `eyebrow` utility  | 14 / 14, +1 px     | 500    | UPPERCASE section eyebrow       |

Body uses Tailwind's text sizes (admin tables stay compact at 14–16 px; the marketing spec's
18 px body applies to portal landing copy). Headlines are sentence case. The customer portal and
emergency page use the system font stack on purpose: no web-font request on the emergency path.

## Components (`packages/ui`)

- **Button** (`rounded-md`, 48 px tall at `md`, semibold):
  `primary` orange · `dark` ink · `secondary` outline (1 px ink border on canvas) ·
  `subtle` cream fill · `ghost` · `danger` · `onDark` (cream on ink bands).
- **Card**: canvas fill, 1 px warm hairline, `rounded-md`, 24 px padding. Dark bands/cards use
  `bg-ink text-on-dark`.
- **Input / Select / Textarea**: canvas fill, 1 px ink border, `rounded-sm`, orange focus border
  and ring.
- **Badge**: `rounded-pill`, cream fill by default.
- **Navigation**: admin sidebar rows are `rounded-md` with a 3 px orange left indicator on the
  active row; portal tabs are ink with an orange underline when active.

## Do / don't

- Do keep orange for the one primary action on a screen; use `dark` or `secondary` for the rest.
- Do keep canvas cream and text coffee; don't introduce pure white, pure black or cool greys.
- Don't round CTAs into pills; don't add a second chromatic accent.
- Don't put orange text on cream for body copy (contrast); use ink.

## Accessibility note

Cream text on `#ff4f00` measures about 3.3 : 1. That passes WCAG AA for large/bold text (our
buttons are 16–18 px semibold) but not for small body text, so orange is a fill for buttons and
indicators only, never a text colour on cream. The emergency page keeps its call buttons ink on
cream (≈ 17 : 1) for first responders.

## Not affected

The printed Safety ID sticker (print engine, Print Designs) has its own physical colour rules
(`docs/SAFETY-ID-PRINT.md`, `docs/PRINT-DESIGNS.md`) and is unchanged by this UI theme.
