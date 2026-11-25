# Icons and logo

## Interface icons

There is no icon library and no sprite. Each icon is an inline SVG next to the JSX that uses it:

| Where                                   | Icons                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `NavIcon` in `src/pages/next/shell.tsx` | Overview, Mirroring, Calendars, Activity, API tokens, Admin              |
| `src/pages/next/components.tsx`         | Back chevron, close cross, "Saved" check, save bar warning, notice icons |
| `src/pages/next/palette.tsx`            | Search                                                                   |
| Page files                              | Page-specific marks (for example the lock in the mirroring preview)      |

Drawing rules from the code:

- Stroke icons on a 24-unit viewBox, `fill="none"`, `stroke="currentColor"`, round caps and joins.
- Shown at 16 px (nav, panel head, notices, save bar) or 14 px ("Saved").
- Stroke width 1.7 (nav), 1.8 (panel head, notices, save bar) or 2.2 ("Saved" check at 14 px).
- Colour comes from the text colour of the parent: `--text-3` in the nav, `--text` for the current
  page, the tone for a notice, `--ok` for the "Saved" check, `--warn` for the save bar warning.
- Decorative icons carry `aria-hidden="true"`; the label next to them carries the meaning. An
  icon-only button gets `aria-label` (`.btn-icon`).
- No coloured tile behind an icon.

To add an icon: draw it on the 24-unit grid with the same stroke settings, place it next to the
component that uses it, and give it `aria-hidden="true"` and a visible or accessible label.

## Level mark

File: `src/pages/next/identity.tsx`, `LevelMark`. A 16 px SVG on a 16-unit grid:

- Strokes are 1 px on half-pixel coordinates, so each straight edge covers exactly one pixel row or
  column at 1x and two at 2x. The frame spans pixels 1 to 14 across and 2 to 13 down
  (`x="1.5" y="2.5" width="13" height="11" rx="2"`, `shape-rendering="crispEdges"`).
- "Not copied" is a dashed outline drawn as solid rounded corners plus 2 px dashes on whole pixels,
  symmetric per side. A dash pattern on the rounded rect would land between pixels and turn grey.
- The hatch is three 45-degree lines through pixel centres, 4 px apart, centred on the block, with
  1 px of air to the frame. Stroke 1.1, or 1.25 when tinted.
- Text lines sit on rows 5, 8 and 11 (one line for Title, three for Everything; the last is shorter).
- The lock is a 1 px outline at the lower right (body pixels 10 to 15 across, 10 to 14 down,
  shackle up to row 7), filled with `--glyph-ring` and knocked out of the block by a 1 px ring in
  it. A solid lock was a blob that drowned the hatch.
- A tint colours only the content (hatch or lines) in the lifted calendar colour; the frame stays
  `currentColor`.

## Provider glyphs

File: `identity.tsx`, `ProviderGlyph`. The Microsoft mark (four 6 px squares with a 1 px gap,
snapped to the grid) and the Google "G", 14 px, in one neutral colour (`currentColor`, meant for
`--text-3`).

Rule: monochrome only, never tinted. Microsoft and Google allow their marks only in their own
colours or in neutral monochrome, and a tinted mark reads as another brand's logo. Show a glyph only
where the provider matters (the address line of a calendar, the connect menu, sign-in buttons). A
calendar's identity is its colour swatch, never the provider mark.

## Brand mark in the app

`BrandMark` in `shell.tsx` draws direction A, "Eyes, refined" (`design/logo-next/eyes/`), inline:
two calendars as eyes, the original event as a solid pupil, its copy in the colour of the original.

- Below 24 px (the 20 px sidebar, the 22 px public layout) it draws `mark-20.svg`: the copy is a flat
  tint, because a hatch breaks into dots at 1x. From 24 px it draws `mark.svg` with the copy
  hatched at 45 degrees, clipped by a `clipPath` with one id per size.
- Colours are tokens in `base.css`: `--brand-ink` (`--text`, the outlines), `--brand-eye`
  (`--accent`, the original and the hatch) and `--brand-copy` (the accent at 50% over what lies
  behind, the flat copy). The logo files use the same values as hex: `#1069da` and `#609efa` are
  the accent, `#88b4ec` is it at 50% on white.
- The size comes from the `size` prop; CSS sets no size.
- The eyes appear only in the logo, nowhere else in the UI.

## App icons

`design/app-icons/make.sh [mark.svg]` renders the icons of the web manifest from one logo mark SVG
(viewBox `0 0 64 64`) with `rsvg-convert`. The current icons come from
`design/logo-next/eyes/mark.svg`, the script's default. Output in
`public/app-icons/`:

| File                    | Size   | Purpose                                   |
| ----------------------- | ------ | ----------------------------------------- |
| `icon-192.png`          | 192 px | `any`                                     |
| `icon-512.png`          | 512 px | `any`                                     |
| `icon-maskable-512.png` | 512 px | `maskable`, mark inside the 80% safe zone |
| `apple-touch-icon.png`  | 180 px | iOS, opaque (iOS rounds the corners)      |

`public/manifest.webmanifest` and `shell.tsx` (`apple-touch-icon`) reference these names; keep
them. The background is the light chrome colour `#f2f4f6`. A manifest has one icon per size and no
dark variant, so the icons use the light mark on the light background.

## Logo

Direction A, "Eyes, refined" (`design/logo-next/eyes/`), is chosen for the app (2026-11-18).
`public/favicon.svg` is `eyes/favicon.svg` (the 16 px drawing, light and dark in one file), and the
app icons come from `design/app-icons/make.sh design/logo-next/eyes/mark.svg`. The website, the
README and the social preview still use the old mark in `design/logo/`.
