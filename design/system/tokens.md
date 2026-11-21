# Tokens

All tokens live on `:root` in `public/next/base.css`, section 1. Colours use
`light-dark(<light>, <dark>)`. `color-scheme: light dark` follows the system;
`html[data-theme="light"]` and `html[data-theme="dark"]` (set by `public/next/theme.js`) force one
scheme. Page stylesheets use these tokens and add no colour tokens of their own (two exceptions
are listed under "Known inconsistencies").

## Colour

Values are OKLCH (lightness, chroma, hue).

### Surfaces and fills

| Token              | Light                    | Dark                     | Use                                                                                            | Do not use for                                                    |
| ------------------ | ------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `--chrome`         | `oklch(96.5% 0.004 255)` | `oklch(16% 0.006 255)`   | Page background around the main panel, phone top bar, palette footer, `kbd`                    | Content areas. Content sits on `--surface`.                       |
| `--surface`        | `oklch(100% 0 0)`        | `oklch(20.5% 0.006 255)` | The main panel (`.frame`), the detail panel, rows, inputs, secondary buttons                   | Popovers and dialogs (use `--surface-raised`).                    |
| `--surface-raised` | `oklch(100% 0 0)`        | `oklch(25% 0.007 255)`   | Menus, dialogs, the palette, the save bar (`.detail-foot`), the skip link                      | Hover. A hovered row must never read as a popover.                |
| `--fill-hover`     | `oklch(96% 0.004 255)`   | `oklch(23.5% 0.007 255)` | Hover of rows, menu items, secondary buttons, map cells                                        | Selection. In dark it sits between surface and raised on purpose. |
| `--fill-selected`  | `oklch(94% 0.02 258)`    | `oklch(30% 0.04 258)`    | The selected row (`aria-current="true"`), the selected palette option, a pressed header action | Hover.                                                            |

`html` and `body` both carry `--chrome`. `CHROME_COLORS` in `src/pages/next/shell.tsx`
(`#f2f4f6`, `#0c0d10`) repeats `--chrome` as sRGB for `theme-color` and the manifest;
`test/app-shell.test.ts` compares them. If you change `--chrome`, change both.

### Lines

| Token            | Light                  | Dark                   | Use                                                                                                                       | Do not use for                                                  |
| ---------------- | ---------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `--line`         | `oklch(91% 0.004 255)` | `oklch(28% 0.006 255)` | Hairlines: row separators, section separators, panel edges, header bottom, menu border                                    | The only edge of a control. It reaches about 1.3:1.             |
| `--line-strong`  | `oklch(84% 0.006 255)` | `oklch(36% 0.008 255)` | Edge of a button with a label (`.btn-secondary`, `.btn-danger`), `.choice`, dialog border, idle dot ring, scrollbar thumb | The only edge of an empty input or an off switch (about 1.6:1). |
| `--control-line` | `oklch(63% 0.008 255)` | `oklch(58% 0.008 255)` | Edge of inputs and selects, off switch track, the edge of the selected segment, "no colour" swatch                        | Decorative hairlines. It is meant to be seen at 3:1.            |

The rule: a hairline separates content and uses `--line`. An edge that is the only thing that shows
where a control is must reach 3:1 (WCAG 1.4.11) and uses `--control-line`.

### Text

| Token      | Light                 | Dark                   | Use                                                                                            | Do not use for                                |
| ---------- | --------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `--text`   | `oklch(22% 0.01 255)` | `oklch(94% 0.004 255)` | Titles, row titles, values, selected segment text                                              |                                               |
| `--text-2` | `oklch(45% 0.01 255)` | `oklch(72% 0.008 255)` | Labels (`.prop-label`), nav items, ghost buttons, group heads, counts, secondary sentences     |                                               |
| `--text-3` | `oklch(52% 0.01 255)` | `oklch(68% 0.008 255)` | Meta text: row meta, hints, the state line, placeholders, icons in the nav, the provider glyph | Text on a fill darker than `--fill-selected`. |

`--text-3` was lowered in light and raised in dark from the first draft (58% in both themes). The
draft value reached only 4.28:1 on white and 3.19:1 on the dark selected fill (computed, see
below). The shipped values keep 4.5:1 on surface, hover and selected fills.

### Accent and states

| Token         | Light                 | Dark                  | Use                                                                                          | Do not use for                                                                          |
| ------------- | --------------------- | --------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `--accent`    | `oklch(54% 0.19 258)` | `oklch(70% 0.15 258)` | Primary button, focus ring, `.link`, switch on, changed-property dot, busy line, brand pupil | Status. Blue is not "ok".                                                               |
| `--on-accent` | `white`               | `oklch(18% 0.02 258)` | Text and knob on `--accent`                                                                  |                                                                                         |
| `--ok`        | `oklch(60% 0.14 155)` | `oklch(72% 0.15 155)` | `.dot-ok`, the check in "Saved"                                                              | Text. It reaches 3.7:1 on white.                                                        |
| `--warn`      | `oklch(62% 0.14 70)`  | `oklch(78% 0.14 75)`  | `.dot-warn`, the warning icon in the save bar, notice tone                                   | Text in light mode (3.75:1 on white). Warn words use `--text-2` (`.run-words.is-warn`). |
| `--danger`    | `oklch(56% 0.2 25)`   | `oklch(70% 0.17 25)`  | `.dot-danger`, nav attention dot, danger buttons, danger words (`.run-words.is-danger`)      | Danger text on `--fill-selected` without the mix below.                                 |

On a selected row the danger words use `color-mix(in oklab, var(--danger) 85%, var(--text))`,
because plain `--danger` on `--fill-selected` reaches only 4.33:1 in light.

### Controls

| Token                | Light                                  | Dark                            | Use                                                                                                           |
| -------------------- | -------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `--control-track`    | `oklch(96% 0.004 255)`                 | `oklch(16% 0.006 255)`          | The sunken track of `.seg`                                                                                    |
| `--control-selected` | `oklch(100% 0 0)`                      | `oklch(30% 0.007 255)`          | The raised selected item of `.seg` and `.choice`. In dark it is lighter than its track, as a raised thing is. |
| `--control-shadow`   | `0 1px 1px oklch(20% 0.02 255 / 0.08)` | `0 1px 1px oklch(0% 0 0 / 0.3)` | Under the selected segment                                                                                    |
| `--swatch-outline`   | `oklch(0% 0 0 / 0.14)`                 | `oklch(100% 0 0 / 0.22)`        | Inset outline of `.swatch-dot`, so a light colour keeps its edge                                              |

### Derived

| Token            | Value                                                                                       | Use                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--accent-hover` | `color-mix(in oklab, var(--accent), light-dark(black, white) 12%)`                          | Primary button hover and touch press                                                                           |
| `--fill-wash`    | `var(--text)` at 5% over transparent, in oklab                                              | Hover of a control without a surface: nav item, user button, ghost button                                      |
| `--fill-press`   | `var(--text)` at 8% over transparent, in oklab                                              | The current nav item, touch press, `.tag`                                                                      |
| `--fill-strong`  | `var(--text)` at 12% over transparent, in oklab                                             | The avatar disc                                                                                                |
| `--shadow-pop`   | `0 4px 16px` with `oklch(20% 0.02 255 / 0.12)` light, `oklch(0% 0 0 / 0.45)` dark           | Menus, dialogs, palette, skip link                                                                             |
| `--glyph-ring`   | `var(--surface)`; `.list-row` sets it to its `--row-bg`, `.ov-cell-link` to its `--cell-bg` | The knock-out ring around the lock of the level mark. Set it wherever a level mark sits on another background. |

### Calendar colours

A calendar colour arrives as `--c` in an inline style (`chipStyle()` in
`src/pages/next/identity.tsx`). It is never a token on `:root`. Uses:

- Identity swatch and tinted level mark: `color-mix(in oklab, var(--c), light-dark(var(--c), white) 38%)`
  (`LIFTED`), so the colour is lifted towards white in dark mode.
- Google event colours in the colour pickers (`.swatch-dot.is-event`): toned down in dark with
  `color-mix(in oklab, var(--c), light-dark(var(--c), oklch(55% 0 0)) 20%)`.
- The preview event (`.mx-ev` in `mirroring.css`): 13% fill, 42% border, both mixed with the
  surface or line in oklab; a busy copy gets 5% fill plus the hatch at 30% (light) or 45% (dark).

### Mixing: oklab, not oklch

Mix a colour with a neutral in oklab. The neutrals of this palette are near greys with a blue hue
(255). An oklch mix interpolates the hue, so a mix of amber or a calendar colour with `--line` walks
through green (dark) or pink (light) on its way to blue. oklab mixes in a straight line and has no
hue to walk. This reason is written in `identity.tsx` (`LIFTED`), in `overview.css` (map cell
borders) and in `mirroring.css` (`.mx-ev`).

A mix of a neutral with `transparent` has no hue problem, but new code uses oklab for all mixes, so
that nobody has to judge the case. The code has no oklch mix; `test/next-css-consistency.node.test.ts` fails on `in oklch`.

## Type

| Property | Value                                                                                                                                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Family   | `--font-ui`: `"Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`. Self-hosted `/next/fonts/inter-4.001.woff2`, weights 100 to 900, `font-display: swap`, preloaded by the shell. |
| Mono     | `--font-mono`: `ui-monospace, "SF Mono", Menlo, monospace`. Codes, secrets, `code`.                                                                                                                              |
| Base     | `body { font: 450 13px/20px var(--font-ui) }`                                                                                                                                                                    |
| Features | `font-feature-settings: "cv11", "ss03"` on `body`; antialiased; `text-rendering: optimizeLegibility`                                                                                                             |
| Numbers  | `.num` sets `font-variant-numeric: tabular-nums`. Use it on every count, time and date that can sit in a column (`ListRow` puts it on `.row-count`; `ShortTime` on `<time>`).                                    |

### Scale

| Size  | Line height    | Weight | Use                                                                                                                          |
| ----- | -------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 15 px | 20 px          | 600    | Panel title (`.detail-title`), dialog titles (`.guard-title`, `.sheet-title`), empty title, palette input, public page title |
| 13 px | 20 px          | 450    | Body, row titles (500), labels, buttons (500), segment labels (500), section titles, page title, brand, Overview heads (600) |
| 12 px | 20 px or 16 px | 450    | Meta, hints (16 px line), counts, status phrases, group heads (600), tags, the save bar count                                |
| 11 px | 18 px          | 500    | `kbd` key hints, the save key hint, the "Default" mark, avatar initials                                                      |
| 16 px | -              | -      | Inputs on a coarse pointer and on phones (stops the iOS zoom)                                                                |

Weights in use: 450 (body), 500 (emphasis, controls), 600 (titles). No 400 and no 700.

## Spacing and size

All spacing sits on a 4 px grid. Hairlines are inset box shadows, not borders, so that a 40 px row
keeps 40 px of content and nothing lands on half pixels.

| Token           | Value                      | Phone (< 720 px)  | Coarse pointer | Use                                                                              |
| --------------- | -------------------------- | ----------------- | -------------- | -------------------------------------------------------------------------------- |
| `--sidebar-w`   | 232 px                     | top bar instead   | -              | Sidebar width                                                                    |
| `--panel-w`     | 400 px                     | full width        | -              | Detail panel width                                                               |
| `--head-h`      | 44 px                      | min height        | -              | Page header and panel header                                                     |
| `--row-h`       | 40 px                      | rows 48 px min    | rows 48 px min | List row minimum height                                                          |
| `--control-h`   | 28 px                      | 40 px             | 44 px          | Buttons, inputs, selects, segmented track                                        |
| `--gutter`      | 24 px                      | 16 px             | -              | Left and right padding of header, content and rows                               |
| `--content-max` | 1120 px                    | -                 | -              | Content column with gutters. `.frame.is-narrow` 848 px, `.frame.is-wide` 1408 px |
| `--topbar-h`    | 92 px                      | `92px + safe-top` | -              | Phone top bar: two 44 px rows plus 4 px                                          |
| `--label-w`     | 120 px (on `.detail-body`) | -                 | -              | Label column of the property grid                                                |

Other fixed sizes from the code: segment item 24 px (40 px phone, 44 px coarse), segmented track
`--control-h` (46 px phone, 48 px coarse), switch 28 x 16 px, swatch dot 20 px (hit area 40 px phone,
44 px coarse), status dot 8 px, nav attention dot 6 px, changed-property dot 6 px, tag 20 px, nav
item 28 px (44 px phone and coarse), user button 32 px, menu item 28 px, palette option 32 px
(44 px touch), menu min width 232 px, guard dialog 380 px, palette 640 px, shortcut sheet 440 px,
empty state max 440 px.

With the panel open, list plus panel stay one unit: `max-width: calc(var(--content-max) + var(--panel-w))`
(1520 px by default). The workspace is anchored left (`margin-inline: 0 auto`), so the header and the
list keep their x when the panel opens.

### Property sheet rhythm

From the comment in `base.css` section 6: the state line sits 16 px under the panel head; sections
are 24 px, hairline, 24 px; properties are 12 px apart, each a 28 px control band with 2 px of air,
so controls of neighbouring rows sit 16 px apart; a hint sits 4 px under its control. The first
section starts 20 px under the head, or 16 px under the state line.

## Breakpoints and media rules

| Rule                                                                        | What changes                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `max-width: 959.98px`                                                       | The panel covers the list (`.frame.has-panel .pane { display: none }`), takes the full width, and the back link replaces the close button. The sidebar stays. Reason: below 960 px the list would be under 320 px beside the sidebar and the panel.                                                                                                                                                           |
| `max-width: 719.98px`                                                       | Phone. The sidebar becomes a sticky top bar (row 1: brand, palette icon, lower group as icons, account; row 2: the four pages as equal tabs with labels, no icons). The page scrolls, not the pane. The panel head and save bar become sticky. `--gutter` 16 px, `--control-h` 40 px. Rows 48 px and wrap; `.row-tags` hide. "Automatic" in a swatch group takes its own line. Guard buttons share the width. |
| `max-width: 359.98px`                                                       | Nav tab labels go to 12 px with 2 px padding; `--seg-pad` 6 px, so four German segments fit 288 px.                                                                                                                                                                                                                                                                                                           |
| `min-width: 1280px` (overview.css)                                          | The Overview puts its 340 px side column next to the map.                                                                                                                                                                                                                                                                                                                                                     |
| `@container list (width < 640px)`                                           | Rows take two lines on fixed tracks: name, count, status; the meta under the name. Tags hide. Below 480 px the count hides too (see components.md, List).                                                                                                                                                                                                                                                     |
| `min-width: 1920px` (base.css, overview.css)                                | `.frame.is-wide` has no cap; the Overview map's cells grow to 320 px at most and keep 200 px, from the number of calendars (`--n`).                                                                                                                                                                                                                                                                           |
| `@container (min-width: 200px)` on `.ov-cell-link`                          | The second line of a map cell indents under the label.                                                                                                                                                                                                                                                                                                                                                        |
| `pointer: coarse`                                                           | Every control 44 px high, segments 44 px wide minimum, swatches 44 px, list rows 48 px, inputs 16 px, link hit areas grow without moving text. Comes after the phone block and replaces its 40 px.                                                                                                                                                                                                            |
| `hover: none`                                                               | No tap highlight; a press shows on the control (`:active` fills).                                                                                                                                                                                                                                                                                                                                             |
| `hover: none` or `pointer: coarse`                                          | No keyboard hints: the save key hint, `.po-keys`, `.palette-foot` and the trigger's `kbd` hide.                                                                                                                                                                                                                                                                                                               |
| `prefers-reduced-motion: reduce`                                            | All transitions, animations and view transitions off. The busy line stands still.                                                                                                                                                                                                                                                                                                                             |
| `forced-colors: active`                                                     | States that live in fills or shadows get outlines or borders in system colours (`Highlight`, `ButtonBorder`, `ButtonText`, `GrayText`). Dots and swatches keep their colour (`forced-color-adjust: none`).                                                                                                                                                                                                    |
| `print`                                                                     | Shell becomes one flowing document; sidebar, actions, close, back and save bar hide; the panel starts a new page.                                                                                                                                                                                                                                                                                             |
| `display-mode: standalone` or `window-controls-overlay`, `html[data-shell]` | App feel: no overscroll, no text selection on chrome, see "Desktop shell".                                                                                                                                                                                                                                                                                                                                    |

## Radius

| Token              | Value | Use                                                                              |
| ------------------ | ----- | -------------------------------------------------------------------------------- |
| `--radius-panel`   | 10 px | Main panel, dialogs, palette, public panel                                       |
| `--radius-control` | 6 px  | Buttons, inputs, segmented track, notices, nav items, map cells, palette options |
| `--radius-tag`     | 4 px  | Tags, avatar, menu items, `kbd`, filter chips                                    |
| `--radius-item`    | 4 px  | Segment items and `.choice`, the colour swatch                                   |
| `--radius-menu`    | 8 px  | Menus (`.menu`). The switch track is a full radius on 16 px and has no token.    |
| 50%                | -     | Status dots, attention dot, changed dot, swatches, switch knob                   |
| 3 px (SVG `rx`)    | -     | Calendar swatch                                                                  |

## Shadow and elevation

There are three levels: flat (everything on `--surface`), the save bar
(`inset 0 1px var(--line)` plus a soft upward shadow), and pop-ups (`--shadow-pop`: menus, dialogs,
palette). The main panel has a hairline border and no shadow. Dialog backdrops are
`oklch(0% 0 0 / 0.35)`.

## Motion

| Token or rule      | Value                                                                               |
| ------------------ | ----------------------------------------------------------------------------------- |
| `--fast`           | 120 ms. Hover, colour and border transitions, switch knob, menu fade                |
| `--ease`           | `cubic-bezier(0.2, 0, 0, 1)`. Movement (knob, panel slide, menu rise, chevron)      |
| Colour transitions | `var(--fast) ease-out`                                                              |
| Page crossfade     | 100 ms ease-out (`::view-transition-old/new(root)`)                                 |
| Panel open         | 160 ms, `detail-in`: fade plus 8 px slide from the right, `--ease`                  |
| Panel close        | 90 ms fade, `detail-out`                                                            |
| "Saved"            | Shows for 3.7 s, then fades in 300 ms (`saved-fade`); the script hides it after 4 s |
| Busy line          | 2 px accent line at the top, after 150 ms of waiting; grows from 8% to 90% in 2 s   |
| Menu               | Fades in and rises 4 px (`@starting-style`)                                         |

View transitions: a normal page load uses `@view-transition { navigation: auto }` without types.
`enhance.js` starts a typed transition only for `page`, `panel-open` and `panel-close`. A row
switch, a save, a filter and back or forward get none. The sidebar has no animation of its own; rows
have `view-transition-name: none`. `--vt-scale` (default 1) multiplies every duration, for review.
`html[data-vt="off"]` and reduced motion skip transitions in the script.

## Z-order

No z-index tokens exist. The values in use:

| Value | Element                                                    |
| ----- | ---------------------------------------------------------- |
| 1000  | Busy line (`html[aria-busy="true"]::before`)               |
| 100   | Skip link                                                  |
| 20    | Phone top bar (`.sidebar` below 720 px)                    |
| 10    | Sticky panel head on a phone                               |
| 1     | `.row-action` above the stretched row link (calendars.css) |

Menus, the palette and dialogs use the browser's top layer (`popover`, `showModal()`), not z-index.

## Safe areas and the desktop shell

| Token                                                        | Value                                                                                                                                           | Use                                                                                                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--safe-top`, `--safe-right`, `--safe-bottom`, `--safe-left` | `env(safe-area-inset-*, 0px)`                                                                                                                   | Padding of `.app`, the phone top bar, sticky save bar, dialogs, the user menu. Zero in a browser tab. Needs `viewport-fit=cover` (set in `AppHead`). |
| `--wco-right`                                                | `max(0px, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw)))`                                                           | Room that window controls take at the right edge of the header (Windows, window controls overlay)                                                    |
| `--shell-top`                                                | 40 px on `html[data-shell="desktop"][data-platform="mac"]` and in window-controls-overlay on mac; unset elsewhere (sidebar falls back to 12 px) | Room above the first sidebar item for the macOS window buttons                                                                                       |
| `--shell-left`                                               | 78 px in the same cases                                                                                                                         | Width of the macOS window buttons, for a control at the left edge (the phone brand)                                                                  |
| `--app-feel`                                                 | `none` in a standalone window or `html[data-shell]`, unset in a tab                                                                             | Turns off overscroll, text selection and the long-press menu on the chrome                                                                           |

In the desktop shell and in window-controls-overlay, `.sidebar` and `.page-head` drag the window
(`app-region: drag`); every interactive element inside them is `no-drag`. `app-region` takes no
`var()`, so the values are literal and repeat for both contexts.

## Contrast, computed

Method: each OKLCH value was converted to OKLab (a = C cos h, b = C sin h), then to linear sRGB with
the OKLab matrices (cube of the LMS values), clamped to 0 to 1. Relative luminance is
`0.2126 R + 0.7152 G + 0.0722 B` on the linear values; the ratio is `(L1 + 0.05) / (L2 + 0.05)`.
The same converter gives `#f2f4f6` and `#0c0d10` for `--chrome`, which matches `CHROME_COLORS`.

### Text (needs 4.5:1)

| Pair                                                      | Light | Dark  |
| --------------------------------------------------------- | ----- | ----- |
| `--text` on `--surface`                                   | 17.31 | 15.02 |
| `--text` on `--fill-selected`                             | 14.52 | 11.44 |
| `--text-2` on `--surface`                                 | 7.43  | 7.22  |
| `--text-2` on `--chrome`                                  | 6.72  | 7.83  |
| `--text-2` on `--fill-selected`                           | 6.24  | 5.50  |
| `--text-3` on `--surface`                                 | 5.50  | 6.22  |
| `--text-3` on `--fill-hover`                              | 4.90  | 5.79  |
| `--text-3` on `--fill-selected`                           | 4.62  | 4.74  |
| `--text-3` on `--chrome`                                  | 4.97  | 6.74  |
| `--text-3` on `--surface-raised`                          | 5.50  | 5.55  |
| `--accent` on `--surface` (links)                         | 5.19  | 6.66  |
| `--accent` on `--fill-selected`                           | 4.36  | 5.07  |
| `--on-accent` on `--accent`                               | 5.19  | 6.99  |
| `--danger` on `--surface`                                 | 5.15  | 6.22  |
| `--danger` on `--fill-selected`                           | 4.33  | 4.73  |
| danger mix (85% oklab with `--text`) on `--fill-selected` | 5.29  | 5.48  |
| `--warn` on `--surface`                                   | 3.75  | 8.78  |
| `--ok` on `--surface`                                     | 3.70  | 7.69  |
| `--ov-warn-text` on `--surface`                           | 6.19  | 9.43  |
| `--ov-danger-text` on `--surface`                         | 6.08  | 7.29  |

`--warn` and `--ok` fail as text in light mode; they are not used as text. `--accent` on
`--fill-selected` fails in light (4.36); no link sits on a selected fill today. Keep it so.

### Non-text (needs 3:1 where the edge is the only cue)

| Pair                                        | Light | Dark |
| ------------------------------------------- | ----- | ---- |
| `--line` on `--surface`                     | 1.31  | 1.23 |
| `--line-strong` on `--surface`              | 1.63  | 1.65 |
| `--control-line` on `--surface`             | 3.50  | 4.18 |
| `--control-line` on `--chrome`              | 3.16  | 4.53 |
| `--control-line` on `--control-track`       | 3.11  | 4.53 |
| `--control-line` on `--surface-raised`      | 3.50  | 3.74 |
| `--accent` (focus ring) on `--surface`      | 5.19  | 6.66 |
| `--accent` (focus ring) on `--chrome`       | 4.69  | 7.21 |
| switch knob on off track (`--control-line`) | 3.50  | 3.59 |
| `--ok` dot on `--surface`                   | 3.70  | 7.69 |
| `--warn` dot on `--surface`                 | 3.75  | 8.78 |
| `--danger` dot on `--surface`               | 5.15  | 6.22 |

The claims in the code comments hold: `--line-strong` is "about 1.6:1"; `--control-line` reaches 3:1
on surface, chrome and track; `--text-3` keeps 4.5:1 on surface, hover and selected; danger on the
selected fill is 4.3:1 and the mix 5.3:1. One comment is loose: `overview.css` says `--warn` as text
on white reaches "about 3:1"; the computed value is 3.75:1 (still below 4.5:1, so the conclusion
holds). The idle dot (`.dot-idle`, a 1.5 px `--line-strong` ring) reaches only 1.63:1; it always has
words next to it ("No run yet").

## Known inconsistencies

None in this file. The consistency pass of 2026-11-18 removed the oklch mixes (a test fails on `in
oklch`), put neutral fills on `--fill-wash`, `--fill-press` and `--fill-strong`, deleted
`--ov-warn-text`, `--ov-danger-text` and `--prop-h`, and added `--radius-item`, `--radius-menu`,
`--prose-size` and `--prose-line`. Line heights of 18, 22 and 24 px are gone.
